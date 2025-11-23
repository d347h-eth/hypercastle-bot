import { config, validateConfig } from "./config.js";
import { logger } from "./logger.js";
import { db } from "./db.js";
import { createMigrationRunner } from "./migrations.js";
import { fetchSalesFeed } from "./services/salesFeed.js";
import { enqueueNewSales, recoverInFlightIfNeeded, tryPostNextQueued } from "./services/poster.js";
import { getRateUsage } from "./services/rateLimiter.js";

async function runMigrations() {
    const runner = createMigrationRunner();
    await runner.runMigrations();
}

function getMeta(key: string): string | null {
    const row = db
        .prepare<[string]>("SELECT value FROM meta WHERE key=?")
        .get(key) as any;
    return row ? String(row.value) : null;
}

function setMeta(key: string, value: string): void {
    db.prepare("REPLACE INTO meta(key,value) VALUES(?,?)").run(key, value);
}

async function firstRunBootstrap(): Promise<void> {
    const initialized = getMeta("initialized") === "1";
    if (initialized) return;
    logger.info("First boot: seeding snapshot without posting...");
    try {
        const feed = await fetchSalesFeed();
        // Mark them as seen (but not queued) so we wait for next new sale
        const now = Math.floor(Date.now() / 1000);
        const insert = db.prepare<[
            string,
            number,
            number,
            number | null,
            number,
            string,
            string,
        ]>(
            `INSERT OR IGNORE INTO sales (sale_id, created_at, seen_at, next_attempt_at, attempt_count, status, payload)
             VALUES (?,?,?,?,?,?,?)`
        );
        db.exec("BEGIN");
        try {
            for (const r of feed.records) {
                insert.run(
                    r.saleId,
                    r.createdAt,
                    now,
                    null,
                    0,
                    "seen",
                    JSON.stringify(r.payload),
                );
            }
            db.exec("COMMIT");
        } catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
        setMeta("initialized", "1");
        logger.info("First boot snapshot complete", {
            seeded: feed.records.length,
        });
    } catch (e) {
        logger.error("First boot snapshot failed", { error: String(e) });
        throw e;
    }
}

let pollInProgress = false;

async function pollOnce(): Promise<void> {
    if (pollInProgress) return;
    pollInProgress = true;
    try {
        // 1) Fetch feed
        const feed = await fetchSalesFeed();
        // 2) Enqueue unseen sales
        const newCount = enqueueNewSales(feed.records);
        if (newCount > 0) {
            logger.info("New sales enqueued", { count: newCount });
        }
        // 3) Try posting within allowance
        const { used, limit } = getRateUsage();
        let remaining = Math.max(0, limit - used);
        if (remaining <= 0) return;
        for (;;) {
            const res = await tryPostNextQueued();
            if (res === "posted") {
                remaining -= 1;
                if (remaining <= 0) break;
                continue;
            }
            if (res === "empty") break;
            if (res === "deferred") break;
        }
    } finally {
        pollInProgress = false;
    }
}

function maybePruneOldData(): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const last = db
        .prepare<[string]>("SELECT value FROM meta WHERE key=?")
        .get("last_prune_at") as any;
    const lastSec = last && last.value ? Number(last.value) || 0 : 0;
    // Run at most every 6 hours
    if (nowSec - lastSec < 6 * 3600) return;
    const cutoff = nowSec - 30 * 24 * 3600; // 30 days
    db.exec("BEGIN");
    try {
        db.prepare(
            `DELETE FROM sales WHERE (status='posted' OR status='failed' OR status='seen')
             AND COALESCE(posted_at, seen_at, created_at) < ?`
        ).run(cutoff);
        db.prepare("REPLACE INTO meta(key,value) VALUES(?,?)").run(
            "last_prune_at",
            String(nowSec),
        );
        db.exec("COMMIT");
    } catch (e) {
        db.exec("ROLLBACK");
        logger.warn("Prune failed", { error: String(e) });
    }
}

async function main() {
    try {
        validateConfig();
    } catch (e) {
        logger.error("Invalid configuration", { error: String(e) });
        process.exit(1);
    }

    await runMigrations();
    await firstRunBootstrap();

    // One-time crash recovery pass (timeline check) if there were in-flight items
    await recoverInFlightIfNeeded();

    logger.info("Bot started", {
        pollMs: config.pollIntervalMs,
    });

    // Initial tick
    try {
        await pollOnce();
    } catch (e) {
        logger.warn("Initial poll failed", { error: String(e) });
    }

    // Loop
    setInterval(async () => {
        try {
            await pollOnce();
            maybePruneOldData();
        } catch (e) {
            logger.warn("Poll failed", { error: String(e) });
        }
    }, config.pollIntervalMs);
}

main().catch((e) => {
    logger.error("Fatal", { error: String(e) });
    process.exit(1);
});
