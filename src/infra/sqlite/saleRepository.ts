import { db } from "../../db.js";
import { Sale } from "../../domain/models.js";
import {
    QueuedSale,
    SaleRepository,
} from "../../domain/ports/saleRepository.js";

function serializeSale(sale: Sale): string {
    return JSON.stringify(sale);
}

function deserializeSale(payload: string): Sale {
    const parsed = JSON.parse(payload) as any;
    // Support both domain-shaped payloads and raw API payloads
    if (parsed && parsed.id !== undefined) {
        return {
            id: String(parsed.id),
            tokenId: String(parsed.tokenId),
            name: parsed.name,
            timestamp: Number(parsed.timestamp),
            price: {
                amount: Number(parsed.price?.amount ?? 0),
                symbol: parsed.price?.symbol ? String(parsed.price.symbol) : "",
            },
            orderSide: parsed.orderSide || "ask",
            payload: parsed.payload,
        };
    }

    // Fallback for raw Reservoir payload
    const amount = Number(parsed?.price?.amount?.decimal ?? 0);
    const symbol = parsed?.price?.currency?.symbol || "";
    const ts = Number(parsed?.timestamp) || Math.floor(Date.now() / 1000);
    const side = (parsed?.orderSide || "ask").toLowerCase();
    return {
        id: String(parsed?.saleId ?? ""),
        tokenId: String(parsed?.token?.tokenId ?? ""),
        name: parsed?.token?.name ?? undefined,
        timestamp: ts,
        price: { amount, symbol },
        orderSide: side,
        payload: parsed,
    };
}

export class SqliteSaleRepository implements SaleRepository {
    isInitialized(): boolean {
        const row = db
            .prepare("SELECT value FROM meta WHERE key='initialized'")
            .get() as { value?: string } | undefined;
        return row?.value === "1";
    }

    markInitialized(): void {
        db.prepare(
            "REPLACE INTO meta(key,value) VALUES('initialized','1')",
        ).run();
    }

    seedSeen(sales: Sale[], seenAt: number): void {
        if (!sales.length) return;
        const insert = db.prepare<[string, number, number, string]>(
            `INSERT OR IGNORE INTO sales (sale_id, created_at, seen_at, status, payload)
             VALUES (?,?,?,?,?)`,
        );
        db.exec("BEGIN");
        try {
            for (const sale of sales) {
                insert.run(
                    sale.id,
                    sale.timestamp,
                    seenAt,
                    "seen",
                    serializeSale(sale),
                );
            }
            db.exec("COMMIT");
        } catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
    }

    enqueueNew(sales: Sale[], seenAt: number): number {
        if (!sales.length) return 0;
        const insert = db.prepare<
            [string, number, number, number, number, string, string]
        >(
            `INSERT OR IGNORE INTO sales (sale_id, created_at, seen_at, enqueued_at, next_attempt_at, status, payload)
             VALUES (?,?,?,?,?,?,?)`,
        );
        let inserted = 0;
        db.exec("BEGIN");
        try {
            for (const sale of sales) {
                const res = insert.run(
                    sale.id,
                    sale.timestamp,
                    seenAt,
                    seenAt,
                    0,
                    "queued",
                    serializeSale(sale),
                );
                if (res.changes > 0) inserted += 1;
            }
            db.exec("COMMIT");
        } catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
        return inserted;
    }

    claimNextReady(now: number): QueuedSale | null {
        const row = db
            .prepare(
                `SELECT sale_id, payload, attempt_count, tweet_text, html_path, frames_dir, video_path, media_id, metadata_json, capture_fps, status
                 FROM sales
                 WHERE status IN ('queued','fetching_html','capturing_frames','rendering_video','uploading_media','posting')
                   AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                 ORDER BY created_at ASC
                 LIMIT 1`,
            )
            .get(now) as
            | {
                  sale_id: string;
                  payload: string;
                  attempt_count?: number;
                  tweet_text?: string;
                  html_path?: string | null;
                  frames_dir?: string | null;
                  video_path?: string | null;
                  media_id?: string | null;
                  metadata_json?: string | null;
                  status?: string;
                  capture_fps?: number | null;
              }
            | undefined;
        if (!row) return null;

        const updated = db
            .prepare(
                `UPDATE sales
                 SET posting_at=?
                 WHERE sale_id=?
                   AND status IN ('queued','fetching_html','capturing_frames','rendering_video','uploading_media','posting')
                   AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
            )
            .run(now, row.sale_id, now);
        if (updated.changes === 0) return null;

        const sale = deserializeSale(row.payload);
        return {
            sale,
            attemptCount: row.attempt_count ? Number(row.attempt_count) : 0,
            tweetText: row.tweet_text,
            artifacts: {
                htmlPath: row.html_path,
                framesDir: row.frames_dir,
                videoPath: row.video_path,
                mediaId: row.media_id,
                metadataJson: row.metadata_json,
                captureFps: row.capture_fps,
            },
        };
    }

    markPosted(
        saleId: string,
        tweetId: string | null,
        tweetText: string,
        postedAt: number,
    ): void {
        db.prepare(
            `UPDATE sales
             SET status='posted', posted_at=?, tweet_id=?, tweet_text=?, posting_at=NULL, next_attempt_at=NULL
             WHERE sale_id=?`,
        ).run(postedAt, tweetId, tweetText, saleId);
    }

    requeueAfterRateLimit(saleId: string): void {
        db.prepare(
            `UPDATE sales SET posting_at=NULL, next_attempt_at=NULL WHERE sale_id=?`,
        ).run(saleId);
    }

    scheduleRetry(saleId: string, nextAttemptAt: number): void {
        db.prepare(
            `UPDATE sales SET posting_at=NULL, next_attempt_at=?, attempt_count=COALESCE(attempt_count,0)+1 WHERE sale_id=?`,
        ).run(nextAttemptAt, saleId);
    }

    updateStatus(saleId: string, status: string): void {
        db.prepare(`UPDATE sales SET status=? WHERE sale_id=?`).run(
            status,
            saleId,
        );
    }

    setHtmlPath(saleId: string, pathStr: string): void {
        db.prepare(`UPDATE sales SET html_path=? WHERE sale_id=?`).run(
            pathStr,
            saleId,
        );
    }

    setFramesDir(saleId: string, dir: string): void {
        db.prepare(`UPDATE sales SET frames_dir=? WHERE sale_id=?`).run(
            dir,
            saleId,
        );
    }

    setVideoPath(saleId: string, pathStr: string): void {
        db.prepare(`UPDATE sales SET video_path=? WHERE sale_id=?`).run(
            pathStr,
            saleId,
        );
    }

    setMediaId(saleId: string, mediaId: string): void {
        db.prepare(`UPDATE sales SET media_id=? WHERE sale_id=?`).run(
            mediaId,
            saleId,
        );
    }

    setMetadataJson(saleId: string, metadataJson: string): void {
        db.prepare(`UPDATE sales SET metadata_json=? WHERE sale_id=?`).run(
            metadataJson,
            saleId,
        );
    }

    setCaptureFps(saleId: string, fps: number): void {
        db.prepare(`UPDATE sales SET capture_fps=? WHERE sale_id=?`).run(
            fps,
            saleId,
        );
    }

    listStalePosting(cutoff: number): QueuedSale[] {
        const rows = db
            .prepare(
                `SELECT sale_id, payload, attempt_count, tweet_text, metadata_json FROM sales WHERE status='posting' AND posting_at < ?`,
            )
            .all(cutoff) as
            | {
                  sale_id: string;
                  payload: string;
                  attempt_count?: number;
                  tweet_text?: string;
                  metadata_json?: string | null;
              }[]
            | [];
        return rows.map((row) => ({
            sale: deserializeSale(row.payload),
            attemptCount: row.attempt_count ? Number(row.attempt_count) : 0,
            tweetText: row.tweet_text,
            artifacts: { metadataJson: row.metadata_json },
        }));
    }

    requeueStale(saleId: string, nextAttemptAt: number): void {
        db.prepare(
            `UPDATE sales SET status='queued', posting_at=NULL, next_attempt_at=? WHERE sale_id=?`,
        ).run(nextAttemptAt, saleId);
    }

    pruneOld(cutoff: number, now: number, minInterval: number): void {
        const last = this.getMetaNumber("last_prune_at");
        if (last && now - last < minInterval) return;
        db.exec("BEGIN");
        try {
            db.prepare(
                `DELETE FROM sales WHERE (status='posted' OR status='failed' OR status='seen')
                 AND COALESCE(posted_at, seen_at, created_at) < ?`,
            ).run(cutoff);
            this.setMetaNumber("last_prune_at", now);
            db.exec("COMMIT");
        } catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
    }

    private getMetaNumber(key: string): number {
        const row = db
            .prepare("SELECT value FROM meta WHERE key=?")
            .get(key) as { value?: string } | undefined;
        if (!row || row.value === undefined) return 0;
        const n = Number(row.value);
        return Number.isFinite(n) ? n : 0;
    }

    private setMetaNumber(key: string, value: number): void {
        db.prepare("REPLACE INTO meta(key,value) VALUES(?,?)").run(
            key,
            String(value),
        );
    }
}
