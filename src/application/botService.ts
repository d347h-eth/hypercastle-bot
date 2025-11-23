import { SalesFeedPort } from "../domain/ports/salesFeed.js";
import { SaleRepository } from "../domain/ports/saleRepository.js";
import { RateLimiter } from "../domain/ports/rateLimiter.js";
import { SocialPublisher } from "../domain/ports/socialPublisher.js";
import { RateLimitExceededError } from "../domain/errors.js";
import { formatTweet, formatPrice } from "./tweetFormatter.js";
import { computeBackoffSeconds } from "./backoff.js";
import { Sale } from "../domain/models.js";
import { logger } from "../logger.js";

export interface BotConfig {
    pollIntervalMs: number;
    tweetTemplate: string;
    stalePostingSeconds: number;
    pruneDays: number;
    pruneIntervalHours: number;
}

export class BotService {
    private polling = false;

    constructor(
        private readonly deps: {
            feed: SalesFeedPort;
            repo: SaleRepository;
            rateLimiter: RateLimiter;
            publisher: SocialPublisher;
            config: BotConfig;
        },
    ) {}

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
            const expected = formatTweet(this.deps.config.tweetTemplate, sale).trim();
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
                this.deps.repo.markPosted(sale.id, found.id, found.text, unix());
                this.deps.rateLimiter.increment();
                logger.info("Recovered posted sale", { saleId: sale.id, tweetId: found.id });
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
            }

            await this.postAvailable(now);
            this.pruneIfNeeded(now);
        } finally {
            this.polling = false;
        }
    }

    private async postAvailable(now: number): Promise<void> {
        const usage = this.deps.rateLimiter.getUsage();
        let remaining = Math.max(0, usage.limit - usage.used);
        if (remaining <= 0) return;

        while (remaining > 0) {
            const queued = this.deps.repo.claimNextReady(unix());
            if (!queued) break;

            const tweetText = formatTweet(this.deps.config.tweetTemplate, queued.sale);
            try {
                const tweet = await this.deps.publisher.post(tweetText);
                this.deps.repo.markPosted(
                    queued.sale.id,
                    tweet.id,
                    tweetText,
                    unix(),
                );
                this.deps.rateLimiter.increment();
                remaining -= 1;
                logger.info("Posted sale", { saleId: queued.sale.id, tweetId: tweet.id });
            } catch (e) {
                if (e instanceof RateLimitExceededError) {
                    this.deps.repo.requeueAfterRateLimit(queued.sale.id);
                    this.deps.rateLimiter.exhaustUntilReset();
                    logger.warn("Rate limited; deferring until window reset");
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
}

function unix(): number {
    return Math.floor(Date.now() / 1000);
}
