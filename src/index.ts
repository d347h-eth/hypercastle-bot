import { config, validateConfig } from "./config.js";
import { logger } from "./logger.js";
import { createMigrationRunner } from "./migrations.js";
import { BotService } from "./application/botService.js";
import { ReservoirSalesFeed } from "./infra/http/reservoirSalesFeed.js";
import { SqliteSaleRepository } from "./infra/sqlite/saleRepository.js";
import { SqliteRateLimiter } from "./infra/sqlite/rateLimiter.js";
import { FakeSocialPublisher } from "./infra/social/fakePublisher.js";

async function runMigrations() {
    const runner = createMigrationRunner();
    await runner.runMigrations();
}

async function main() {
    try {
        validateConfig();
    } catch (e) {
        logger.error("Invalid configuration", { error: String(e) });
        process.exit(1);
    }

    await runMigrations();

    const bot = new BotService({
        feed: new ReservoirSalesFeed(),
        repo: new SqliteSaleRepository(),
        rateLimiter: new SqliteRateLimiter(
            config.rateResetHourUtc,
            config.rateMaxPerDay,
        ),
        // Use the fake publisher for local QA; swap to TwitterPublisher for production.
        publisher: new FakeSocialPublisher(),
        config: {
            pollIntervalMs: config.pollIntervalMs,
            tweetTemplate: config.tweetTemplate,
            stalePostingSeconds: 120,
            pruneDays: 30,
            pruneIntervalHours: 6,
        },
    });

    await bot.bootstrapIfNeeded();
    await bot.recoverInFlight();

    logger.info("Bot started", { pollMs: config.pollIntervalMs });

    try {
        await bot.pollOnce();
    } catch (e) {
        logger.warn("Initial poll failed", { error: String(e) });
    }

    setInterval(async () => {
        try {
            await bot.pollOnce();
        } catch (e) {
            logger.warn("Poll failed", { error: String(e) });
        }
    }, config.pollIntervalMs);
}

main().catch((e) => {
    logger.error("Fatal", { error: String(e) });
    process.exit(1);
});
