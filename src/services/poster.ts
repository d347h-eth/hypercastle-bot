import { db } from "../db.js";
import { SaleRecord } from "../types.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { postTweet, isRateLimitedError, fetchRecentTweets } from "./twitter.js";
import { getRateUsage, incrementUsage } from "./rateLimiter.js";

function formatTweet(sale: SaleRecord): string {
    const tokens: Record<string, string> = {
        saleId: sale.saleId,
        title: sale.title || "Sale",
        price: sale.price || "",
        currency: sale.currency || "",
        url: sale.url || "",
    };
    let text = config.tweetTemplate;
    for (const [k, v] of Object.entries(tokens)) {
        text = text.replaceAll(`{${k}}`, v);
    }
    if (!/sale:/.test(text)) {
        text += `\n\nsale:${sale.saleId}`; // marker to support idempotency/recovery
    }
    return text.trim();
}

export function enqueueNewSales(records: SaleRecord[]) {
    if (!records.length) return 0;
    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare<[
        string,
        number,
        number,
        string,
        string | null,
    ]>(
        `INSERT OR IGNORE INTO sales (sale_id, created_at, seen_at, status, payload)
         VALUES (?,?,?,?,?)`
    );
    let inserted = 0;
    const payloadString = (p: unknown) => JSON.stringify(p);
    for (const r of records) {
        const payload = payloadString(r.payload);
        const res = insert.run(r.saleId, r.createdAt, now, "queued", payload);
        if (res.changes > 0) inserted += 1;
    }
    return inserted;
}

export async function recoverInFlightIfNeeded(): Promise<void> {
    // Optional lightweight recovery: look for 'posting' items older than 2 minutes
    const cutoff = Math.floor(Date.now() / 1000) - 120;
    const rows = db
        .prepare<[number]>(
            `SELECT sale_id, tweet_text FROM sales WHERE status='posting' AND posting_at < ?`
        )
        .all(cutoff) as { sale_id: string; tweet_text?: string }[];
    if (!rows.length) return;
    try {
        const tweets = await fetchRecentTweets(10);
        for (const row of rows) {
            const marker = `sale:${row.sale_id}`;
            const found = tweets.find((t) => t.text.includes(marker));
            if (found) {
                db.prepare(
                    `UPDATE sales SET status='posted', posted_at=strftime('%s','now'), tweet_id=?, tweet_text=? WHERE sale_id=?`
                ).run(found.id, row.tweet_text || found.text, row.sale_id);
                incrementUsage();
                logger.info("Recovered posted sale from timeline", {
                    saleId: row.sale_id,
                    tweetId: found.id,
                });
            } else {
                // Requeue
                db.prepare(
                    `UPDATE sales SET status='queued', posting_at=NULL WHERE sale_id=?`
                ).run(row.sale_id);
                logger.warn("Requeued stale posting sale", { saleId: row.sale_id });
            }
        }
    } catch (e) {
        logger.warn("Timeline check failed; will retry later", { error: String(e) });
    }
}

export async function tryPostNextQueued(): Promise<"posted" | "deferred" | "empty"> {
    const { used, limit } = getRateUsage();
    if (used >= limit) return "deferred";

    // Claim one queued sale atomically
    const row = db
        .prepare(
            `SELECT sale_id, payload FROM sales WHERE status='queued' ORDER BY created_at ASC LIMIT 1`
        )
        .get() as { sale_id: string; payload: string } | undefined;
    if (!row) return "empty";

    const claim = db.prepare<[number, string]>(
        `UPDATE sales SET status='posting', posting_at=? WHERE sale_id=? AND status='queued'`
    );
    const now = Math.floor(Date.now() / 1000);
    const res = claim.run(now, row.sale_id);
    if (res.changes === 0) return "empty";

    const payload = JSON.parse(row.payload);
    const sale: SaleRecord = {
        saleId: row.sale_id,
        createdAt: now,
        payload,
        title: payload.title,
        price: String(payload.price ?? ""),
        currency: payload.currency,
        url: payload.url,
    };
    const text = formatTweet(sale);

    try {
        const out = await postTweet(text);
        const tweetId = out.data?.id;
        db.prepare(
            `UPDATE sales SET status='posted', posted_at=strftime('%s','now'), tweet_id=?, tweet_text=? WHERE sale_id=?`
        ).run(tweetId || null, text, sale.saleId);
        incrementUsage();
        logger.info("Posted sale", { saleId: sale.saleId, tweetId });
        return "posted";
    } catch (e) {
        if (isRateLimitedError(e)) {
            // Requeue and stop further attempts in this loop
            db.prepare(
                `UPDATE sales SET status='queued', posting_at=NULL WHERE sale_id=?`
            ).run(sale.saleId);
            logger.warn("Rate limited; deferring posts", {});
            return "deferred";
        }
        // Mark failed but keep payload for manual/auto retry policy
        db.prepare(
            `UPDATE sales SET status='failed', posting_at=NULL WHERE sale_id=?`
        ).run(sale.saleId);
        logger.error("Tweet failed", { error: String(e), saleId: sale.saleId });
        return "deferred";
    }
}

