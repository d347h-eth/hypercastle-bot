import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { setDbPath, db } from "../src/db.js";
import { createMigrationRunner } from "../src/migrations.js";
import { SqliteSaleRepository } from "../src/infra/sqlite/saleRepository.js";
import { Sale } from "../src/domain/models.js";

let tmpDir: string | null = null;

function makeSale(id: string, price = 0.5): Sale {
    return {
        id,
        tokenId: "1",
        name: "Test",
        timestamp: 1_700_000_000,
        price: { amount: price, symbol: "ETH" },
        orderSide: "ask",
        payload: { id },
    };
}

async function setupRepo(): Promise<SqliteSaleRepository> {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "botdb-"));
    const dbPath = path.join(tmpDir, "test.db");
    setDbPath(dbPath);
    const runner = createMigrationRunner();
    await runner.runMigrations();
    const repo = new SqliteSaleRepository();
    repo.markInitialized();
    return repo;
}

afterEach(async () => {
    if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true });
        tmpDir = null;
    }
});

describe("SqliteSaleRepository", () => {
    let repo: SqliteSaleRepository;

    beforeEach(async () => {
        repo = await setupRepo();
    });

    it("enqueues, claims, and marks posted", () => {
        const sale = makeSale("s1");
        const now = 1_700_000_000;
        const inserted = repo.enqueueNew([sale], now);
        expect(inserted).toBe(1);

        const claimed = repo.claimNextReady(now);
        expect(claimed?.sale.id).toBe("s1");
        expect(claimed?.attemptCount).toBe(0);

        repo.markPosted("s1", "tw1", "tweet", now + 10);

        // Verify via raw query to ensure implementation persisted correctly
        const row = db.raw
            .prepare(
                "SELECT status, tweet_id, posted_at FROM sales WHERE sale_id=?",
            )
            .get("s1") as {
            status: string;
            tweet_id: string;
            posted_at: number;
        };
        expect(row.status).toBe("posted");
        expect(row.tweet_id).toBe("tw1");
        expect(row.posted_at).toBe(now + 10);
    });

    it("seeds items as seen without queuing", () => {
        const sale = makeSale("seed1");
        const now = 1_700_000_000;
        repo.seedSeen([sale], now);

        const row = db.raw
            .prepare("SELECT status FROM sales WHERE sale_id=?")
            .get("seed1") as { status: string };
        expect(row.status).toBe("seen");

        const claimed = repo.claimNextReady(now + 100);
        expect(claimed).toBeNull();
    });

    it("lists stale posting items and requeues them", () => {
        const sale = makeSale("stale1");
        const now = 1_700_000_000;
        repo.enqueueNew([sale], now);

        // Manually move to posting to simulate a crash during posting
        db.raw
            .prepare(
                "UPDATE sales SET status='posting', posting_at=? WHERE sale_id=?",
            )
            .run(now, "stale1");

        // Should find it if looking after stale window
        const stale = repo.listStalePosting(now + 120);
        // Note: listStalePosting(cutoff) finds items where posting_at < cutoff
        // So if posting_at is 1000, and we pass cutoff 1100, it matches.

        expect(stale).toHaveLength(1);
        expect(stale[0].sale.id).toBe("stale1");

        // Requeue
        repo.requeueStale("stale1", now + 300);

        const row = db.raw
            .prepare(
                "SELECT status, next_attempt_at FROM sales WHERE sale_id=?",
            )
            .get("stale1") as { status: string; next_attempt_at: number };
        expect(row.status).toBe("queued");
        expect(row.next_attempt_at).toBe(now + 300);
    });

    it("schedules retry and increments attempts", () => {
        const sale = makeSale("s2");
        const now = 1_700_000_100;
        repo.enqueueNew([sale], now);
        repo.scheduleRetry("s2", now + 60);
        const row = db.raw
            .prepare(
                "SELECT status, next_attempt_at, attempt_count FROM sales WHERE sale_id=?",
            )
            .get("s2") as {
            status: string;
            next_attempt_at: number;
            attempt_count: number;
        };
        expect(row.status).toBe("queued");
        expect(row.next_attempt_at).toBe(now + 60);
        expect(row.attempt_count).toBe(1);
    });

    it("requeues after rate limit with specific reset", () => {
        const sale = makeSale("rl1");
        const now = 1_700_000_000;
        repo.enqueueNew([sale], now);

        const resetAt = now + 3600;
        repo.requeueAfterRateLimit("rl1", resetAt);

        const row = db.raw
            .prepare(
                "SELECT status, next_attempt_at FROM sales WHERE sale_id=?",
            )
            .get("rl1") as { status: string; next_attempt_at: number };
        expect(row.status).toBe("queued");
        expect(row.next_attempt_at).toBe(resetAt);
        // Should increment attempt count on rate limit deferral
        const row2 = db.raw
            .prepare("SELECT attempt_count FROM sales WHERE sale_id=?")
            .get("rl1") as { attempt_count: number };
        expect(row2.attempt_count).toBe(1);
    });

    it("prunes old records respecting interval", () => {
        const oldSale = makeSale("old");
        const newSale = makeSale("new");
        const now = 2_000_000_000;
        repo.enqueueNew([oldSale, newSale], now);
        // Mark one as posted long ago, another as recent
        db.raw
            .prepare(
                "UPDATE sales SET status='posted', posted_at=? WHERE sale_id='old'",
            )
            .run(now - 40 * 24 * 3600);
        db.raw
            .prepare(
                "UPDATE sales SET status='posted', posted_at=? WHERE sale_id='new'",
            )
            .run(now - 5 * 24 * 3600);

        const cutoff = now - 30 * 24 * 3600;
        repo.pruneOld(cutoff, now, 1); // run prune
        const countAfterFirst = db.raw
            .prepare("SELECT COUNT(*) as c FROM sales")
            .get().c as number;
        expect(countAfterFirst).toBe(1);

        // Second prune within interval should no-op
        repo.pruneOld(cutoff, now + 10, 10_000);
        const countAfterSecond = db.raw
            .prepare("SELECT COUNT(*) as c FROM sales")
            .get().c as number;
        expect(countAfterSecond).toBe(1);
    });

    it("respects token cooldown by marking recent sales as seen", () => {
        const sale1 = makeSale("s1");
        sale1.tokenId = "100";
        const now = 2_000_000_000;

        // 1. Post a sale for token 100
        repo.enqueueNew([sale1], now);
        repo.markPosted("s1", "tw1", "text", now);

        // 2. New sale for same token 1 hour later
        const sale2 = makeSale("s2");
        sale2.tokenId = "100";
        const later = now + 3600;

        // Enqueue with 24h cooldown
        repo.enqueueNew([sale2], later, 24);

        // Should be 'seen' because token 100 was posted recently
        const row2 = db.raw
            .prepare("SELECT status FROM sales WHERE sale_id='s2'")
            .get() as { status: string };
        expect(row2.status).toBe("seen");

        // 3. New sale for different token
        const sale3 = makeSale("s3");
        sale3.tokenId = "200";
        repo.enqueueNew([sale3], later, 24);

        // Should be 'queued'
        const row3 = db.raw
            .prepare("SELECT status FROM sales WHERE sale_id='s3'")
            .get() as { status: string };
        expect(row3.status).toBe("queued");
    });
});
