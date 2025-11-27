import { describe, it, expect, vi } from "vitest";
import { BotService } from "../src/application/botService.js";
import { Sale } from "../src/domain/models.js";
import { SalesFeedPort } from "../src/domain/ports/salesFeed.js";
import {
    SaleRepository,
    QueuedSale,
} from "../src/domain/ports/saleRepository.js";
import { SocialPublisher } from "../src/domain/ports/socialPublisher.js";
import { RateLimitExceededError } from "../src/domain/errors.js";

const baseConfig = {
    pollIntervalMs: 10_000,
    tweetTemplate:
        "#{tokenId} | {name} | {price} {symbol} (take-{orderSide})\\n{Mode} {Chroma}{Antenna}\\n{Zone} B{Biome}",
    stalePostingSeconds: 120,
    pruneDays: 30,
    pruneIntervalHours: 6,
};

function makeSale(id: string, price = 1.23): Sale {
    return {
        id,
        tokenId: "123",
        name: "Test NFT",
        timestamp: 1_700_000_000,
        price: { amount: price, symbol: "ETH" },
        orderSide: "ask",
        payload: { id },
    };
}

class MemoryFeed implements SalesFeedPort {
    constructor(private sales: Sale[]) {}
    async fetchRecent(): Promise<Sale[]> {
        return this.sales;
    }
}

type Status =
    | "seen"
    | "queued"
    | "posting"
    | "posted"
    | "failed"
    | "fetching_html"
    | "capturing_frames"
    | "rendering_video"
    | "uploading_media";

interface Stored {
    sale: Sale;
    status: Status;
    nextAttemptAt: number | null;
    attemptCount: number;
    postingAt: number | null;
    postedAt: number | null;
    tweetText?: string | null;
}

class MemoryRepo implements SaleRepository {
    private initialized = false;
    private store = new Map<string, Stored>();
    private lastPrune = 0;

    isInitialized(): boolean {
        return this.initialized;
    }
    markInitialized(): void {
        this.initialized = true;
    }

    seedSeen(sales: Sale[], seenAt: number): void {
        for (const sale of sales) {
            if (!this.store.has(sale.id)) {
                this.store.set(sale.id, {
                    sale,
                    status: "seen",
                    nextAttemptAt: null,
                    attemptCount: 0,
                    postingAt: null,
                    postedAt: null,
                });
            }
        }
    }

    enqueueNew(sales: Sale[], seenAt: number): number {
        let added = 0;
        for (const sale of sales) {
            if (!this.store.has(sale.id)) {
                this.store.set(sale.id, {
                    sale,
                    status: "queued",
                    nextAttemptAt: 0,
                    attemptCount: 0,
                    postingAt: null,
                    postedAt: null,
                });
                added += 1;
            }
        }
        return added;
    }

    claimNextReady(now: number): QueuedSale | null {
        const candidates = Array.from(this.store.values())
            .filter(
                (s) =>
                    (s.status === "queued" || s.status === "posting") &&
                    (!s.nextAttemptAt || s.nextAttemptAt <= now),
            )
            .sort((a, b) => a.sale.timestamp - b.sale.timestamp);
        const item = candidates[0];
        if (!item) return null;
        item.status = "posting";
        item.postingAt = now;
        return {
            sale: item.sale,
            attemptCount: item.attemptCount,
            tweetText: item.tweetText,
        };
    }

    markPosted(
        saleId: string,
        tweetId: string | null,
        tweetText: string,
        postedAt: number,
    ): void {
        const item = this.store.get(saleId);
        if (!item) return;
        item.status = "posted";
        item.postedAt = postedAt;
        item.tweetText = tweetText;
    }

    requeueAfterRateLimit(saleId: string, next?: number): void {
        const item = this.store.get(saleId);
        if (!item) return;
        item.status = "queued";
        item.postingAt = null;
        item.nextAttemptAt = next ?? null;
        item.attemptCount += 1;
    }

    scheduleRetry(saleId: string, nextAttemptAt: number): void {
        const item = this.store.get(saleId);
        if (!item) return;
        item.status = "queued";
        item.postingAt = null;
        item.nextAttemptAt = nextAttemptAt;
        item.attemptCount += 1;
    }

    updateStatus(saleId: string, status: string): void {
        const item = this.store.get(saleId);
        if (!item) return;
        item.status = status as Status;
    }
    setHtmlPath(): void {}
    setFramesDir(): void {}
    setVideoPath(): void {}
    setMediaId(_: string, __: string, ___: number): void {}
    clearMediaUpload(_: string): void {}
    setMetadataJson(): void {}
    setCaptureFps(): void {}

    listStalePosting(cutoff: number): QueuedSale[] {
        return Array.from(this.store.values())
            .filter(
                (s) => s.status === "posting" && (s.postingAt ?? 0) < cutoff,
            )
            .map((s) => ({
                sale: s.sale,
                attemptCount: s.attemptCount,
                tweetText: s.tweetText,
            }));
    }

    requeueStale(saleId: string, nextAttemptAt: number): void {
        const item = this.store.get(saleId);
        if (!item) return;
        item.status = "queued";
        item.nextAttemptAt = nextAttemptAt;
        item.postingAt = null;
    }

    pruneOld(cutoff: number, now: number, minInterval: number): void {
        if (now - this.lastPrune < minInterval) return;
        for (const [id, item] of this.store.entries()) {
            const ts = item.postedAt ?? item.sale.timestamp;
            if (
                (item.status === "posted" ||
                    item.status === "failed" ||
                    item.status === "seen") &&
                ts < cutoff
            ) {
                this.store.delete(id);
            }
        }
        this.lastPrune = now;
    }

    // Helpers for assertions
    getStatus(id: string): Status | undefined {
        return this.store.get(id)?.status;
    }
    getAttemptCount(id: string): number | undefined {
        return this.store.get(id)?.attemptCount;
    }
}

class MemoryPublisher implements SocialPublisher {
    public posted: string[] = [];
    constructor(private readonly failWith429 = false) {}
    async post(text: string) {
        if (this.failWith429) {
            throw new RateLimitExceededError();
        }
        this.posted.push(text);
        return { id: `t${this.posted.length}`, text };
    }
    async uploadMedia(): Promise<string> {
        return "media123";
    }
    async fetchRecent(limit: number) {
        return this.posted
            .slice(0, limit)
            .map((text, i) => ({ id: `t${i + 1}`, text }));
    }
    async checkRateLimit() {
        return { limit: 10, remaining: 10, reset: Math.floor(Date.now() / 1000) + 60 };
    }
}

class StubWorkflow {
    constructor(
        private repo: MemoryRepo,
        private behavior: "ok" | "ratelimit" | "error" = "ok",
    ) {}

    async process(queued: QueuedSale): Promise<"posted" | "deferred"> {
        if (this.behavior === "ratelimit") {
            throw new RateLimitExceededError();
        }
        if (this.behavior === "error") {
            throw new Error("boom");
        }
        this.repo.markPosted(queued.sale.id, "tw", "text", Date.now() / 1000);
        return "posted";
    }
}

describe("BotService", () => {
    it("seeds on first bootstrap", async () => {
        const repo = new MemoryRepo();
        const feed = new MemoryFeed([makeSale("s1")]);
        const bot = new BotService(
            {
                feed,
                repo,
                publisher: new MemoryPublisher(),
                config: baseConfig,
            },
            new StubWorkflow(repo),
        );

        await bot.bootstrapIfNeeded();

        expect(repo.isInitialized()).toBe(true);
        expect(repo.getStatus("s1")).toBe("seen");
    });

    it("posts queued sales within rate limit", async () => {
        const repo = new MemoryRepo();
        repo.markInitialized();
        const feed = new MemoryFeed([makeSale("s2", 0.5)]);
        const publisher = new MemoryPublisher();
        const bot = new BotService(
            {
                feed,
                repo,
                publisher,
                config: baseConfig,
            },
            new StubWorkflow(repo),
        );

        await bot.pollOnce();

        expect(repo.getStatus("s2")).toBe("posted");
    });

    it("defers on rate limit error and exhausts allowance", async () => {
        const repo = new MemoryRepo();
        repo.markInitialized();
        const feed = new MemoryFeed([makeSale("s3", 0.9)]);
        const publisher = new MemoryPublisher(true);
        const bot = new BotService(
            {
                feed,
                repo,
                publisher,
                config: baseConfig,
            },
            new StubWorkflow(repo, "ratelimit"),
        );

        await bot.pollOnce();

        expect(repo.getStatus("s3")).toBe("queued");
    });

    it("schedules retry on non-rate error", async () => {
        const repo = new MemoryRepo();
        repo.markInitialized();
        const feed = new MemoryFeed([makeSale("s4", 1.1)]);
        const publisher: SocialPublisher = {
            post: vi.fn().mockRejectedValue(new Error("boom")),
            uploadMedia: vi.fn(),
            fetchRecent: vi.fn().mockResolvedValue([]),
            checkRateLimit: vi.fn().mockResolvedValue({
                limit: 10,
                remaining: 10,
                reset: Math.floor(Date.now() / 1000) + 60,
            }),
        };
        const bot = new BotService(
            {
                feed,
                repo,
                publisher,
                config: baseConfig,
            },
            new StubWorkflow(repo, "error"),
        );

        await bot.pollOnce();

        expect(repo.getStatus("s4")).toBe("queued");
        expect(repo.getAttemptCount("s4")).toBe(1);
    });
});
