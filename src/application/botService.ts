import { SalesFeedPort } from "../domain/ports/salesFeed.js";
import { SaleRepository } from "../domain/ports/saleRepository.js";
import { SocialPublisher, RateLimitInfo } from "../domain/ports/socialPublisher.js";
import { RateLimitExceededError } from "../domain/errors.js";
import { formatPrice } from "./tweetFormatter.js";
import { computeBackoffSeconds } from "./backoff.js";
import { logger } from "../logger.js";
import { PostingWorkflow } from "./workflow.js";
import { formatEnrichedText } from "../infra/http/tokenMetadata.js";

export interface BotConfig {
    pollIntervalMs: number;
    tweetTemplate: string;
    stalePostingSeconds: number;
    pruneDays: number;
    pruneIntervalHours: number;
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
            const newCount = this.deps.repo.enqueueNew(feed, now);
            if (newCount > 0) {
                logger.info("New sales enqueued", { count: newCount });
            } else {
                logger.info("No new sales", { fetched: feed.length });
            }

            await this.syncRemoteRateLimit();
            await this.postAvailable(now);
            this.pruneIfNeeded(now);
        } finally {
            this.polling = false;
        }
    }

    private async postAvailable(now: number): Promise<void> {
        while (true) {
            const queued = this.deps.repo.claimNextReady(unix());
            if (!queued) break;
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
                    saleId: queued.sale.id,
                    endpoint: "post",
                    limit: rateInfo.limit,
                    remaining: rateInfo.remaining,
                    resetAt: rateInfo.reset,
                    nextAttemptAt: next,
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
                        endpoint: "post",
                        limit: info.limit,
                        remaining: info.remaining,
                        resetAt: info.reset,
                        nextAttemptAt: next,
                        attemptCount: queued.attemptCount + 1,
                        waitSec: next - unix(),
                    });
                    break;
                }
                const delaySec = computeBackoffSeconds(queued.attemptCount);
                const next = unix() + delaySec;
                this.deps.repo.scheduleRetry(queued.sale.id, next);
                logger.warn("Tweet failed; scheduled retry", {
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

    private async syncRemoteRateLimit(): Promise<void> {
        const info = await this.deps.publisher.checkRateLimit();
        if (!info) return;
        if (info.remaining !== undefined && info.remaining <= 1) {
            const next = computeRateReset(
                info,
                this.deps.config.pollIntervalMs,
                0,
            );
            logger.warn("Remote rate limit active on startup; deferring posts", {
                endpoint: "post",
                limit: info.limit,
                remaining: info.remaining,
                resetAt: next,
                nextAttemptAt: next,
                waitSec: next - unix(),
            });
        } else {
            logger.info("Remote rate check on startup", {
                endpoint: "post",
                remaining: info.remaining,
                limit: info.limit,
                resetAt: info.reset,
            });
        }
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
