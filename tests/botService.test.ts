import { describe, it, expect, vi } from "vitest";
import { BotService, BotConfig } from "../src/application/botService.js";
import { Sale } from "../src/domain/models.js";
import { SalesFeedPort } from "../src/domain/ports/salesFeed.js";
import {
    SaleRepository,
    QueuedSale,
} from "../src/domain/ports/saleRepository.js";
import { SocialPublisher } from "../src/domain/ports/socialPublisher.js";
import { PostingWorkflow } from "../src/application/workflow.js";
import { RateLimitExceededError } from "../src/domain/errors.js";

const config: BotConfig = {
    pollIntervalMs: 10_000,
    stalePostingSeconds: 120,
    pruneDays: 30,
    pruneIntervalHours: 6,
};

function makeSale(id: string): Sale {
    return {
        id,
        tokenId: "1",
        name: "Test",
        timestamp: 1_700_000_000,
        price: { amount: 1, symbol: "ETH" },
        orderSide: "ask",
        payload: { id },
    };
}

const makeDeps = () => {
    const feed = { fetchRecent: vi.fn() } as unknown as SalesFeedPort;
    const repo = {
        isInitialized: vi.fn(),
        markInitialized: vi.fn(),
        seedSeen: vi.fn(),
        enqueueNew: vi.fn(),
        claimNextReady: vi.fn(),
        requeueAfterRateLimit: vi.fn(),
        scheduleRetry: vi.fn(),
        pruneOld: vi.fn(),
        listStalePosting: vi.fn(),
    } as unknown as SaleRepository;
    const publisher = {
        checkRateLimit: vi.fn(),
    } as unknown as SocialPublisher;
    // Mock the workflow class itself or its instance?
    // BotService takes an optional workflow instance. We'll pass a mock object.
    const workflow = {
        process: vi.fn(),
    } as unknown as PostingWorkflow;

    return { feed, repo, publisher, workflow };
};

describe("BotService", () => {
    it("seeds on first bootstrap", async () => {
        const { feed, repo, publisher, workflow } = makeDeps();
        vi.mocked(repo.isInitialized).mockReturnValue(false);
        const sales = [makeSale("s1")];
        vi.mocked(feed.fetchRecent).mockResolvedValue(sales);

        const bot = new BotService({ feed, repo, publisher, config }, workflow);
        await bot.bootstrapIfNeeded();

        expect(feed.fetchRecent).toHaveBeenCalled();
        expect(repo.seedSeen).toHaveBeenCalledWith(sales, expect.any(Number));
        expect(repo.markInitialized).toHaveBeenCalled();
    });

    it("skips bootstrap if initialized", async () => {
        const { feed, repo, publisher, workflow } = makeDeps();
        vi.mocked(repo.isInitialized).mockReturnValue(true);

        const bot = new BotService({ feed, repo, publisher, config }, workflow);
        await bot.bootstrapIfNeeded();

        expect(feed.fetchRecent).not.toHaveBeenCalled();
    });

    it("posts queued sales on poll", async () => {
        const { feed, repo, publisher, workflow } = makeDeps();
        vi.mocked(feed.fetchRecent).mockResolvedValue([]);
        vi.mocked(repo.enqueueNew).mockReturnValue(0);
        
        // Setup queue: returns s1, then null
        const s1 = makeSale("s1");
        vi.mocked(repo.claimNextReady)
            .mockReturnValueOnce({ sale: s1, attemptCount: 0 })
            .mockReturnValueOnce(null);
            
        vi.mocked(publisher.checkRateLimit).mockResolvedValue({ limit: 17, remaining: 10 });
        vi.mocked(workflow.process).mockResolvedValue("posted");

        const bot = new BotService({ feed, repo, publisher, config }, workflow);
        await bot.pollOnce();

        expect(repo.claimNextReady).toHaveBeenCalledTimes(2);
        expect(workflow.process).toHaveBeenCalledWith({ sale: s1, attemptCount: 0 });
        expect(repo.pruneOld).toHaveBeenCalled();
    });

    it("defers on remote rate limit (low remaining)", async () => {
        const { feed, repo, publisher, workflow } = makeDeps();
        vi.mocked(feed.fetchRecent).mockResolvedValue([]);
        const s1 = makeSale("s1");
        vi.mocked(repo.claimNextReady).mockReturnValue({ sale: s1, attemptCount: 0 });
        
        // Return low remaining to trigger deferral
        vi.mocked(publisher.checkRateLimit).mockResolvedValue({ limit: 17, remaining: 1, reset: 1234567890 });

        const bot = new BotService({ feed, repo, publisher, config }, workflow);
        await bot.pollOnce();

        expect(workflow.process).not.toHaveBeenCalled();
        expect(repo.requeueAfterRateLimit).toHaveBeenCalledWith("s1", expect.any(Number));
    });

    it("handles workflow rate limit error", async () => {
        const { feed, repo, publisher, workflow } = makeDeps();
        vi.mocked(feed.fetchRecent).mockResolvedValue([]);
        const s1 = makeSale("s1");
        vi.mocked(repo.claimNextReady).mockReturnValue({ sale: s1, attemptCount: 0 });
        vi.mocked(publisher.checkRateLimit).mockResolvedValue({ limit: 17, remaining: 10 });
        
        vi.mocked(workflow.process).mockRejectedValue(new RateLimitExceededError("limit", 12345, 0, 17));

        const bot = new BotService({ feed, repo, publisher, config }, workflow);
        await bot.pollOnce();

        expect(repo.requeueAfterRateLimit).toHaveBeenCalledWith("s1", expect.any(Number));
    });

    it("handles workflow generic error (retry)", async () => {
        const { feed, repo, publisher, workflow } = makeDeps();
        vi.mocked(feed.fetchRecent).mockResolvedValue([]);
        const s1 = makeSale("s1");
        vi.mocked(repo.claimNextReady).mockReturnValue({ sale: s1, attemptCount: 0 });
        vi.mocked(publisher.checkRateLimit).mockResolvedValue({ limit: 17, remaining: 10 });
        
        vi.mocked(workflow.process).mockRejectedValue(new Error("boom"));

        const bot = new BotService({ feed, repo, publisher, config }, workflow);
        await bot.pollOnce();

        expect(repo.scheduleRetry).toHaveBeenCalledWith("s1", expect.any(Number));
    });

    it("does nothing on empty feed and empty queue", async () => {
        const { feed, repo, publisher, workflow } = makeDeps();
        vi.mocked(feed.fetchRecent).mockResolvedValue([]);
        vi.mocked(repo.claimNextReady).mockReturnValue(null);

        const bot = new BotService({ feed, repo, publisher, config }, workflow);
        await bot.pollOnce();

        expect(feed.fetchRecent).toHaveBeenCalled();
        expect(repo.claimNextReady).toHaveBeenCalled();
        expect(workflow.process).not.toHaveBeenCalled();
    });

    it("stops processing queue after one error", async () => {
         const { feed, repo, publisher, workflow } = makeDeps();
        vi.mocked(feed.fetchRecent).mockResolvedValue([]);
        
        const s1 = makeSale("s1");
        const s2 = makeSale("s2");
        
        // s1 fails, s2 should not be processed in this loop (consecutive processing loop breaks on error)
        vi.mocked(repo.claimNextReady)
            .mockReturnValueOnce({ sale: s1, attemptCount: 0 })
            .mockReturnValueOnce({ sale: s2, attemptCount: 0 }); // Should not be called if s1 breaks loop? 
            // Wait, implementation is: while(queued=claim) { try { process } catch { break } }
            // So if s1 fails, we break the loop and s2 is left for next poll.
            
        vi.mocked(publisher.checkRateLimit).mockResolvedValue({ limit: 17, remaining: 10 });
        vi.mocked(workflow.process).mockRejectedValue(new Error("boom"));

        const bot = new BotService({ feed, repo, publisher, config }, workflow);
        await bot.pollOnce();

        expect(workflow.process).toHaveBeenCalledTimes(1);
        expect(repo.scheduleRetry).toHaveBeenCalledWith("s1", expect.any(Number));
        // Verify s2 was not processed
        // In the mock setup, claimNextReady returns s2 on second call, but loop breaks so it shouldn't be called twice?
        // Actually, if loop breaks, claimNextReady won't be called again.
        expect(repo.claimNextReady).toHaveBeenCalledTimes(1); 
    });
});
