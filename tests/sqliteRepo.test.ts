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

        repo.markPosted("s1", "tw1", "tweet", now + 10);
        const row = db.raw
            .prepare("SELECT status, tweet_id, posted_at FROM sales WHERE sale_id=?")
            .get("s1") as { status: string; tweet_id: string; posted_at: number };
        expect(row.status).toBe("posted");
        expect(row.tweet_id).toBe("tw1");
        expect(row.posted_at).toBe(now + 10);
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
            .get("s2") as { status: string; next_attempt_at: number; attempt_count: number };
        expect(row.status).toBe("queued");
        expect(row.next_attempt_at).toBe(now + 60);
        expect(row.attempt_count).toBe(1);
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
        const countAfterFirst = db.raw.prepare("SELECT COUNT(*) as c FROM sales").get()
            .c as number;
        expect(countAfterFirst).toBe(1);

        // Second prune within interval should no-op
        repo.pruneOld(cutoff, now + 10, 10_000);
        const countAfterSecond = db.raw.prepare("SELECT COUNT(*) as c FROM sales").get()
            .c as number;
        expect(countAfterSecond).toBe(1);
    });
});

