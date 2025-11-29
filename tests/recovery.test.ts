import { describe, it, expect, vi } from "vitest";
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
    stalePostingSeconds: 60,
    pruneDays: 30,
    pruneIntervalHours: 6,
};

function saleFixture(id = "s1", tokenId = "123", price = 0.25): Sale {
    return {
        id,
        tokenId,
        name: "Test",
        timestamp: 1_700_000_000,
        price: { amount: price, symbol: "ETH" },
        orderSide: "bid",
        payload: {},
    };
}

// Minimal stubs using vi.fn() for verification
const makeRepo = (stale: QueuedSale[]) =>
    ({
        isInitialized: vi.fn(() => true),
        markInitialized: vi.fn(),
        seedSeen: vi.fn(),
        enqueueNew: vi.fn(),
        claimNextReady: vi.fn(),
        markPosted: vi.fn(),
        requeueAfterRateLimit: vi.fn(),
        scheduleRetry: vi.fn(),
        listStalePosting: vi.fn(() => stale),
        requeueStale: vi.fn(),
        pruneOld: vi.fn(),
        peekBacklog: vi.fn(() => []),
    }) as unknown as SaleRepository;

const makePublisher = (tweets: { id: string; text: string }[]) =>
    ({
        post: vi.fn(),
        uploadMedia: vi.fn(),
        fetchRecent: vi.fn(async () => tweets),
        checkRateLimit: vi.fn(),
    }) as unknown as SocialPublisher;

const makeFeed = () =>
    ({
        fetchRecent: vi.fn(async () => []),
    }) as unknown as SalesFeedPort;

describe("BotService recovery", () => {
    it("marks stale posting as posted when matching tweet exists", async () => {
        const sale = saleFixture();
        // Matching formatEnrichedText with no attributes. formatPrice strips trailing zeros (0.2500 -> 0.25)
        const expectedText = `#123 | Test\n0.25 ETH (take-bid)`;

        const repo = makeRepo([{ sale, attemptCount: 0 }]);
        const publisher = makePublisher([{ id: "t1", text: expectedText }]);

        const bot = new BotService({
            feed: makeFeed(),
            repo,
            publisher,
            config,
        });

        await bot.recoverInFlight();

        expect(repo.markPosted).toHaveBeenCalledWith(
            "s1",
            "t1",
            expectedText,
            expect.any(Number),
        );
        expect(repo.requeueStale).not.toHaveBeenCalled();
    });

    it("requeues stale posting when tweet not found", async () => {
        const sale = saleFixture();
        const repo = makeRepo([{ sale, attemptCount: 0 }]);
        const publisher = makePublisher([]); // No recent tweets

        const bot = new BotService({
            feed: makeFeed(),
            repo,
            publisher,
            config,
        });

        await bot.recoverInFlight();

        expect(repo.markPosted).not.toHaveBeenCalled();
        expect(repo.requeueStale).toHaveBeenCalledWith(
            "s1",
            expect.any(Number),
        );
    });

    it("handles multiple items: recovers found ones and requeues missing ones", async () => {
        const s1 = saleFixture("s1", "100", 1.0);
        const s2 = saleFixture("s2", "200", 2.0);

        // Price 1.0 -> "1"
        const s1Text = `#100 | Test\n1 ETH (take-bid)`;
        // s2 text is not in the timeline

        const repo = makeRepo([
            { sale: s1, attemptCount: 0 },
            { sale: s2, attemptCount: 0 },
        ]);
        const publisher = makePublisher([{ id: "t1", text: s1Text }]);

        const bot = new BotService({
            feed: makeFeed(),
            repo,
            publisher,
            config,
        });

        await bot.recoverInFlight();

        expect(repo.markPosted).toHaveBeenCalledWith(
            "s1",
            "t1",
            s1Text,
            expect.any(Number),
        );
        expect(repo.requeueStale).toHaveBeenCalledWith(
            "s2",
            expect.any(Number),
        );
        expect(repo.markPosted).toHaveBeenCalledTimes(1);
        expect(repo.requeueStale).toHaveBeenCalledTimes(1);
    });

    it("aborts recovery if publisher fails to fetch timeline", async () => {
        const sale = saleFixture();
        const repo = makeRepo([{ sale, attemptCount: 0 }]);
        const publisher = makePublisher([]);
        publisher.fetchRecent = vi
            .fn()
            .mockRejectedValue(new Error("API Error"));

        const bot = new BotService({
            feed: makeFeed(),
            repo,
            publisher,
            config,
        });

        await expect(bot.recoverInFlight()).rejects.toThrow("API Error");

        // Should NOT assume anything about the sale state if we couldn't check
        expect(repo.markPosted).not.toHaveBeenCalled();
        expect(repo.requeueStale).not.toHaveBeenCalled();
    });
});
