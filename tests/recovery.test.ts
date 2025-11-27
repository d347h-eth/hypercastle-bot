import { describe, it, expect } from "vitest";
import { BotService } from "../src/application/botService.js";
import { Sale } from "../src/domain/models.js";
import { SalesFeedPort } from "../src/domain/ports/salesFeed.js";
import {
    SaleRepository,
    QueuedSale,
} from "../src/domain/ports/saleRepository.js";
import { SocialPublisher } from "../src/domain/ports/socialPublisher.js";

const config = {
    pollIntervalMs: 10_000,
    tweetTemplate: "#{tokenId} - {name} - {price} {symbol} (take-{orderSide})",
    stalePostingSeconds: 60,
    pruneDays: 30,
    pruneIntervalHours: 6,
};

function saleFixture(): Sale {
    return {
        id: "s1",
        tokenId: "123",
        name: "Test",
        timestamp: 1_700_000_000,
        price: { amount: 0.25, symbol: "ETH" },
        orderSide: "bid",
        payload: {},
    };
}

class NoopFeed implements SalesFeedPort {
    async fetchRecent(): Promise<Sale[]> {
        return [];
    }
}

class RecoveryRepo implements SaleRepository {
    private stale: QueuedSale[] = [];
    private posted = new Set<string>();
    private requeued = new Set<string>();

    constructor(stale: QueuedSale[]) {
        this.stale = stale;
    }

    isInitialized(): boolean {
        return true;
    }
    markInitialized(): void {}
    seedSeen(): void {}
    enqueueNew(): number {
        return 0;
    }
    claimNextReady(): QueuedSale | null {
        return null;
    }
    markPosted(saleId: string): void {
        this.posted.add(saleId);
    }
    requeueAfterRateLimit(): void {}
    scheduleRetry(): void {}
    listStalePosting(): QueuedSale[] {
        return this.stale;
    }
    requeueStale(saleId: string): void {
        this.requeued.add(saleId);
    }
    pruneOld(): void {}

    // helpers
    wasPosted(id: string): boolean {
        return this.posted.has(id);
    }
    wasRequeued(id: string): boolean {
        return this.requeued.has(id);
    }
}

class RecoveryPublisher implements SocialPublisher {
    constructor(private tweets: { id: string; text: string }[]) {}
    async post() {
        throw new Error("not used");
    }
    async fetchRecent(): Promise<{ id: string; text: string }[]> {
        return this.tweets;
    }
}

describe("BotService recovery", () => {
    it("marks stale posting as posted when matching tweet exists", async () => {
        const sale = saleFixture();
        const repo = new RecoveryRepo([{ sale, attemptCount: 0 }]);
        const publisher = new RecoveryPublisher([
            { id: "t1", text: "#123 - Test - 0.25 ETH (take-bid)" },
        ]);

        const bot = new BotService({
            feed: new NoopFeed(),
            repo,
            publisher,
            config,
        });

        await bot.recoverInFlight();

        expect(repo.wasPosted("s1")).toBe(true);
    });

    it("requeues stale posting when tweet not found", async () => {
        const sale = saleFixture();
        const repo = new RecoveryRepo([{ sale, attemptCount: 0 }]);
        const publisher = new RecoveryPublisher([]);

        const bot = new BotService({
            feed: new NoopFeed(),
            repo,
            publisher,
            config,
        });

        await bot.recoverInFlight();

        expect(repo.wasPosted("s1")).toBe(false);
        expect(repo.wasRequeued("s1")).toBe(true);
    });
});
