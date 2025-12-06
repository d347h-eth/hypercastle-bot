import { SalesFeedPort } from "../domain/ports/salesFeed.js";
import { SaleRepository } from "../domain/ports/saleRepository.js";
import {
    SocialPublisher,
    RateLimitInfo,
} from "../domain/ports/socialPublisher.js";
import { RateLimitExceededError } from "../domain/errors.js";
import { formatPrice } from "./tweetFormatter.js";
import { computeBackoffSeconds } from "./backoff.js";
import { logger } from "../logger.js";
import { PostingWorkflow } from "./workflow.js";
import { formatEnrichedText } from "../infra/http/tokenMetadata.js";
import { toIso } from "../util/time.js";

export interface BotConfig {
    pollIntervalMs: number;
    stalePostingSeconds: number;
    pruneDays: number;
    pruneIntervalHours: number;
    tokenCooldownHours: number;
}

export class BotService {
    private polling = false;
    private workflow: PostingWorkflow;

    constructor(
        private readonly deps: {
            feed: SalesFeedPort;
            repo: SaleRepository;
            publisher: SocialPublisher;
            config: BotConfig;
        },
        workflow?: PostingWorkflow,
    ) {
        this.workflow =
            workflow ||
            new PostingWorkflow(
                { repo: deps.repo, publisher: deps.publisher },
                { artifactsRoot: "data/artifacts" },
            );
    }

    async bootstrapIfNeeded(): Promise<void> {
        if (this.deps.repo.isInitialized()) return;
        logger.info("First boot detected; seeding current feed as seen");
        const feed = await this.deps.feed.fetchRecent();
        const now = unix();
        this.deps.repo.seedSeen(feed, now);
        this.deps.repo.markInitialized();
        logger.info("Seed complete", { seeded: feed.length });
    }

    async recoverInFlight(): Promise<void> {
        const cutoff = unix() - this.deps.config.stalePostingSeconds;
        const stale = this.deps.repo.listStalePosting(cutoff);
        if (!stale.length) return;
        const tweets = await this.deps.publisher.fetchRecent(20);

        for (const item of stale) {
            const sale = item.sale;
            let attrs: any = {};
            try {
                if (item.artifacts?.metadataJson) {
                    attrs = JSON.parse(item.artifacts.metadataJson);
                }
            } catch {}
            const expected = formatEnrichedText(
                "",
                attrs,
                sale.tokenId,
                sale.name,
                formatPrice(sale.price.amount),
                sale.price.symbol,
                sale.orderSide,
            ).trim();
            const priceStr = `${formatPrice(sale.price.amount)} ${sale.price.symbol}`;
            const tokenTag = `#${sale.tokenId}`;
            const sideStr = `(take-${sale.orderSide})`;
            const found = tweets.find((t) => {
                const text = t.text.trim();
                if (text === expected) return true;
                return (
                    text.includes(tokenTag) &&
                    text.includes(priceStr) &&
                    text.includes(sideStr)
                );
            });

            if (found) {
                this.deps.repo.markPosted(
                    sale.id,
                    found.id,
                    found.text,
                    unix(),
                );
                logger.info("Recovered posted sale", {
                    saleId: sale.id,
                    tweetId: found.id,
                });
            } else {
                const next = unix() + 60;
                this.deps.repo.requeueStale(sale.id, next);
                logger.warn("Requeued stale posting sale", { saleId: sale.id });
            }
        }
    }

    async pollOnce(): Promise<void> {
        if (this.polling) return;
        this.polling = true;
        try {
            const feed = await this.deps.feed.fetchRecent();
            const now = unix();
            const newCount = this.deps.repo.enqueueNew(
                feed,
                now,
                this.deps.config.tokenCooldownHours,
            );
            if (newCount > 0) {
                logger.info("Fetched recent sales (Reservoir)", {
                    component: "BotService",
                    action: "pollOnce",
                    fetched: feed.length,
                    enqueued: newCount,
                });
            } else {
                logger.info("Fetched recent sales (Reservoir)", {
                    component: "BotService",
                    action: "pollOnce",
                    fetched: feed.length,
                    enqueued: 0,
                });
            }

            await this.postAvailable(now);
            this.pruneIfNeeded(now);
        } finally {
            this.polling = false;
        }
    }

    private async postAvailable(now: number): Promise<void> {
        while (true) {
            const queued = this.deps.repo.claimNextReady(unix());
            if (!queued) {
                // Nothing ready right now; check if we have pending backlog for logs
                const backlog = this.deps.repo.peekBacklog(1);
                if (backlog.length > 0) {
                    const next = backlog[0];
                    if (next.nextAttemptAt && next.nextAttemptAt > now) {
                        logger.info("Sales backlog pending", {
                            component: "BotService",
                            action: "postAvailable",
                            nextId: next.sale.id,
                            waitSec: next.nextAttemptAt - now,
                            nextAttemptAtIso: toIso(next.nextAttemptAt),
                        });
                    }
                }
                break;
            }
            try {
                const rateInfo = await this.deps.publisher.checkRateLimit();
                if (
                    rateInfo &&
                    rateInfo.remaining !== undefined &&
                    rateInfo.remaining <= 1
                ) {
                    const next = computeRateReset(
                        rateInfo,
                        this.deps.config.pollIntervalMs,
                        queued.attemptCount,
                    );
                    this.deps.repo.requeueAfterRateLimit(queued.sale.id, next);
                    logger.warn("Remote rate limit reached; deferring sale", {
                        component: "BotService",
                        action: "postAvailable",
                        saleId: queued.sale.id,
                        endpoint: "post",
                        limit: rateInfo.limit,
                        remaining: rateInfo.remaining,
                        resetAt: rateInfo.reset,
                        resetAtIso: toIso(rateInfo.reset),
                        nextAttemptAt: next,
                        nextAttemptAtIso: toIso(next),
                        attemptCount: queued.attemptCount,
                        waitSec: next - unix(),
                    });
                    break;
                }
                const res = await this.workflow.process(queued);
                if (res !== "posted") break;
            } catch (e) {
                if (e instanceof RateLimitExceededError) {
                    const info: RateLimitInfo = {
                        reset: e.resetAt,
                        remaining: e.remaining,
                        limit: e.limit,
                    };
                    const next = computeRateReset(
                        info,
                        this.deps.config.pollIntervalMs,
                        queued.attemptCount,
                    );
                    this.deps.repo.requeueAfterRateLimit(queued.sale.id, next);
                    logger.warn("Rate limited; deferring until window reset", {
                        component: "BotService",
                        action: "postAvailable",
                        endpoint: "post",
                        limit: info.limit,
                        remaining: info.remaining,
                        resetAt: info.reset,
                        resetAtIso: toIso(info.reset),
                        nextAttemptAt: next,
                        nextAttemptAtIso: toIso(next),
                        attemptCount: queued.attemptCount + 1,
                        waitSec: next - unix(),
                    });
                    break;
                }
                const delaySec = computeBackoffSeconds(queued.attemptCount);
                const next = unix() + delaySec;
                this.deps.repo.scheduleRetry(queued.sale.id, next);
                logger.warn("Tweet failed; scheduled retry", {
                    component: "BotService",
                    action: "postAvailable",
                    saleId: queued.sale.id,
                    inSec: delaySec,
                    error: String(e),
                });
                break;
            }
        }
    }

    private pruneIfNeeded(now: number): void {
        const cutoff = now - this.deps.config.pruneDays * 24 * 3600;
        const minInterval = this.deps.config.pruneIntervalHours * 3600;
        this.deps.repo.pruneOld(cutoff, now, minInterval);
    }
}

function unix(): number {
    return Math.floor(Date.now() / 1000);
}

function computeRateReset(
    info: RateLimitInfo,
    fallbackDelayMs: number,
    attempts = 0,
): number {
    const now = unix();
    const buffer = 5; // seconds after reset to re-enter
    const baseDelay = Math.min(Math.max(1, Math.pow(2, attempts)), 7200); // cap ~2h
    if (info.reset && info.reset > now) {
        const target = info.reset + buffer;
        return Math.max(now + baseDelay, target);
    }
    const slot =
        info.limit && info.limit > 0
            ? Math.ceil(86400 / info.limit)
            : Math.ceil(fallbackDelayMs / 1000);
    return now + Math.max(baseDelay, slot);
}
