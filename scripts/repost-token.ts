import dotenv from "dotenv";
import { createMigrationRunner } from "../src/migrations.js";
import { db } from "../src/db.js";
import { config } from "../src/config.js";
import { Sale } from "../src/domain/models.js";
import { QueuedSale } from "../src/domain/ports/saleRepository.js";
import { SqliteSaleRepository } from "../src/infra/sqlite/saleRepository.js";
import { FakeSocialPublisher } from "../src/infra/social/fakePublisher.js";
import { TwitterPublisher } from "../src/infra/twitter/twitterPublisher.js";
import { PostingWorkflow } from "../src/application/workflow.js";
import { logger } from "../src/logger.js";

dotenv.config();

interface Options {
    tokenId: string;
    saleId?: string;
    fake: boolean;
}

interface SourceSaleRow {
    sale_id: string;
    status: string;
    payload: string;
    token_id?: string | null;
    created_at: number;
    seen_at: number;
    posted_at?: number | null;
    tweet_id?: string | null;
}

async function main(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    validateConfigForRun(opts);

    const runner = createMigrationRunner();
    await runner.runMigrations();

    const source = findSourceSale(opts);
    if (!source) {
        throw new Error(
            opts.saleId
                ? `No sale found for sale_id=${opts.saleId}`
                : `No posted sale found for token_id=${opts.tokenId}`,
        );
    }

    const sourceSale = deserializeSale(source.payload);
    if (sourceSale.tokenId !== opts.tokenId) {
        throw new Error(
            `Selected sale token_id mismatch: requested ${opts.tokenId}, found ${sourceSale.tokenId}`,
        );
    }

    const now = unix();
    const manualSale: Sale = {
        ...sourceSale,
        id: `manual-repost-${source.sale_id}-${Date.now()}`,
        payload: {
            manualRepost: true,
            sourceSaleId: source.sale_id,
            sourceTweetId: source.tweet_id ?? null,
            requestedAt: now,
            sourcePayload: sourceSale.payload,
        },
    };

    const repo = new SqliteSaleRepository();
    const publisher =
        opts.fake || config.useFakePublisher
            ? new FakeSocialPublisher()
            : new TwitterPublisher();

    const rate = await publisher.checkRateLimit();
    if (rate?.remaining !== undefined && rate.remaining <= 1) {
        throw new Error(
            `X post rate limit has remaining=${rate.remaining}; aborting before render`,
        );
    }

    insertManualSale(manualSale, now);

    const workflow = new PostingWorkflow(
        { repo, publisher },
        { artifactsRoot: config.artifactsDir },
    );
    const queued: QueuedSale = { sale: manualSale, attemptCount: 0 };

    logger.info("Manual repost started", {
        component: "RepostTokenScript",
        action: "main",
        tokenId: opts.tokenId,
        sourceSaleId: source.sale_id,
        sourceTweetId: source.tweet_id,
        manualSaleId: manualSale.id,
        fake: opts.fake || config.useFakePublisher,
    });

    try {
        await workflow.process(queued);
    } catch (e) {
        markManualSaleFailed(manualSale.id);
        throw e;
    }

    logger.info("Manual repost complete", {
        component: "RepostTokenScript",
        action: "main",
        tokenId: opts.tokenId,
        sourceSaleId: source.sale_id,
        manualSaleId: manualSale.id,
    });
}

function parseArgs(args: string[]): Options {
    const tokenId = args[0];
    if (!tokenId || tokenId === "--help" || tokenId === "-h") {
        printUsage();
        process.exit(tokenId ? 0 : 1);
    }

    let saleId: string | undefined;
    let fake = false;
    for (let i = 1; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--fake") {
            fake = true;
            continue;
        }
        if (arg === "--sale-id") {
            const value = args[i + 1];
            if (!value) throw new Error("--sale-id requires a value");
            saleId = value;
            i += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return { tokenId, saleId, fake };
}

function printUsage(): void {
    console.error(
        [
            "Usage: yarn tsx scripts/repost-token.ts <tokenId> [--sale-id <saleId>] [--fake]",
            "",
            "Re-renders and reposts a previously persisted sale.",
            "If --sale-id is omitted, the latest posted sale for the token is selected.",
            "When --sale-id is provided, tokenId is still checked against the selected sale.",
            "The old X post is not deleted; remove it manually if needed.",
        ].join("\n"),
    );
}

function validateConfigForRun(opts: Options): void {
    const missing: string[] = [];
    if (!config.salesApiBaseUrl) missing.push("SALES_API_BASE_URL");
    if (!config.salesApiKey) missing.push("SALES_API_KEY");
    if (!config.salesCollectionAddress) {
        missing.push("SALES_COLLECTION_ADDRESS");
    }
    const fake = opts.fake || config.useFakePublisher;
    if (!fake) {
        if (!config.x.appKey) missing.push("X_APP_KEY");
        if (!config.x.appSecret) missing.push("X_APP_SECRET");
        if (!config.x.accessToken) missing.push("X_ACCESS_TOKEN");
        if (!config.x.accessSecret) missing.push("X_ACCESS_SECRET");
    }
    if (missing.length) {
        throw new Error(`Missing required env: ${missing.join(",")}`);
    }
}

function findSourceSale(opts: Options): SourceSaleRow | null {
    if (opts.saleId) {
        const row = db
            .prepare<[string]>(
                `SELECT sale_id, status, payload, token_id, created_at, seen_at, posted_at, tweet_id
                 FROM sales
                 WHERE sale_id = ?
                 LIMIT 1`,
            )
            .get(opts.saleId) as SourceSaleRow | undefined;
        return row ?? null;
    }

    const row = db
        .prepare<[string, string, string]>(
            `SELECT sale_id, status, payload, token_id, created_at, seen_at, posted_at, tweet_id
             FROM sales
             WHERE status = 'posted'
               AND (
                   token_id = ?
                   OR json_extract(payload, '$.tokenId') = ?
                   OR json_extract(payload, '$.token.tokenId') = ?
               )
             ORDER BY posted_at DESC, seen_at DESC, created_at DESC
             LIMIT 1`,
        )
        .get(opts.tokenId, opts.tokenId, opts.tokenId) as
        | SourceSaleRow
        | undefined;
    return row ?? null;
}

function insertManualSale(sale: Sale, now: number): void {
    const scriptOnlyNextAttemptAt = now + 365 * 24 * 3600;
    db.prepare<
        [string, number, number, number, number, string, string, string]
    >(
        `INSERT INTO sales (sale_id, created_at, seen_at, enqueued_at, next_attempt_at, status, payload, token_id)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
        sale.id,
        now,
        now,
        now,
        scriptOnlyNextAttemptAt,
        "queued",
        JSON.stringify(sale),
        sale.tokenId,
    );
}

function markManualSaleFailed(saleId: string): void {
    db.prepare(
        `UPDATE sales
         SET status='failed', posting_at=NULL, next_attempt_at=NULL
         WHERE sale_id=? AND status <> 'posted'`,
    ).run(saleId);
}

function deserializeSale(payload: string): Sale {
    const parsed = JSON.parse(payload) as any;
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

    return {
        id: String(parsed?.saleId ?? ""),
        tokenId: String(parsed?.token?.tokenId ?? ""),
        name: parsed?.token?.name ?? undefined,
        timestamp: Number(parsed?.timestamp) || unix(),
        price: {
            amount: Number(parsed?.price?.amount?.decimal ?? 0),
            symbol: parsed?.price?.currency?.symbol || "",
        },
        orderSide: (parsed?.orderSide || "ask").toLowerCase(),
        payload: parsed,
    };
}

function unix(): number {
    return Math.floor(Date.now() / 1000);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
