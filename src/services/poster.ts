import { db } from "../db.js";
import { SaleRecord } from "../types.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { postTweet, isRateLimitedError, fetchRecentTweets } from "./twitter.js";
import { getRateUsage, incrementUsage, setUsageToLimit } from "./rateLimiter.js";

function formatTweet(sale: SaleRecord): string {
    const tokens: Record<string, string> = {
        tokenId: sale.tokenId,
        name: sale.name || "",
        price: formatPrice(sale.price),
        symbol: sale.symbol,
        orderSide: sale.orderSide,
    };
    let text = config.tweetTemplate;
    for (const [k, v] of Object.entries(tokens)) {
        text = text.replaceAll(`{${k}}`, v);
    }
    return text.trim();
}

function formatPrice(v: number): string {
    // Keep up to 2 decimals, trim trailing zeros
    const s = v.toFixed(2);
    return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function enqueueNewSales(records: SaleRecord[]) {
    if (!records.length) return 0;
    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare<[
        string,
        number,
        number,
        number | null,
        number,
        string,
        string | null,
    ]>(
        `INSERT OR IGNORE INTO sales (sale_id, created_at, seen_at, next_attempt_at, attempt_count, status, payload)
         VALUES (?,?,?,?,?,?,?)`
    );
    let inserted = 0;
    const payloadString = (p: unknown) => JSON.stringify(p);
    for (const r of records) {
        const payload = payloadString(r.payload);
        const res = insert.run(
            r.saleId,
            r.createdAt,
            now,
            0,
            0,
            "queued",
            payload,
        );
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
            // Reconstruct expected text to match by equality
            const payloadRow = db
                .prepare<[string]>(
                    `SELECT payload FROM sales WHERE sale_id=? LIMIT 1`
                )
                .get(row.sale_id) as { payload: string } | undefined;
            const payload = payloadRow ? JSON.parse(payloadRow.payload) : undefined;
            if (!payload) continue;
            const sale: SaleRecord = {
                saleId: row.sale_id,
                createdAt: 0,
                tokenId: String(payload?.token?.tokenId ?? ""),
                name: payload?.token?.name ?? undefined,
                price: Number(payload?.price?.amount?.decimal ?? 0),
                symbol: payload?.price?.currency?.symbol || "",
                orderSide: String(payload?.orderSide || "").toLowerCase() || "ask",
                payload: payload,
            };
            const expectedText = formatTweet(sale).trim();
            const priceStr = `${formatPrice(sale.price)} ${sale.symbol}`;
            const tokenTag = `#${sale.tokenId}`;
            const sideStr = `(take-${sale.orderSide})`;
            const found = tweets.find((t) => {
                const text = t.text.trim();
                if (text === expectedText) return true;
                return (
                    text.includes(tokenTag) &&
                    text.includes(priceStr) &&
                    text.includes(sideStr)
                );
            });
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
                const now = Math.floor(Date.now() / 1000);
                db.prepare(
                    `UPDATE sales SET status='queued', posting_at=NULL, next_attempt_at=? WHERE sale_id=?`
                ).run(now + 60, row.sale_id);
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
            `SELECT sale_id, payload FROM sales WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%s','now'))
             ORDER BY created_at ASC LIMIT 1`
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
        tokenId: String(payload?.token?.tokenId ?? ""),
        name: payload?.token?.name ?? undefined,
        price: Number(payload?.price?.amount?.decimal ?? 0),
        symbol: payload?.price?.currency?.symbol || "",
        orderSide: String(payload?.orderSide || "").toLowerCase() || "ask",
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
            // Lock posting until window reset by consuming allowance to limit
            setUsageToLimit();
            logger.warn("Rate limited; deferring posts", {});
            return "deferred";
        }
        // Mark failed but keep payload for manual/auto retry policy
        // Backoff exponentially up to 30 minutes
        const state = db
            .prepare<[string]>(
                `SELECT attempt_count FROM sales WHERE sale_id=? LIMIT 1`
            )
            .get(sale.saleId) as { attempt_count?: number } | undefined;
        const attempts = state?.attempt_count ? Number(state.attempt_count) : 0;
        const delaySec = Math.min(30 * 60, Math.pow(2, attempts) * 60); // 1m,2m,4m,...30m
        const next = Math.floor(Date.now() / 1000) + delaySec;
        db.prepare(
            `UPDATE sales SET status='queued', posting_at=NULL, next_attempt_at=?, attempt_count=COALESCE(attempt_count,0)+1 WHERE sale_id=?`
        ).run(next, sale.saleId);
        logger.warn("Tweet failed; scheduled retry", {
            error: String(e),
            saleId: sale.saleId,
            inSec: delaySec,
        });
        return "deferred";
    }
}
