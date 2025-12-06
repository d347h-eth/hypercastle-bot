import { config, validateConfig } from "./config.js";
import { logger } from "./logger.js";
import { createMigrationRunner } from "./migrations.js";
import { BotService } from "./application/botService.js";
import { ReservoirSalesFeed } from "./infra/http/reservoirSalesFeed.js";
import { SqliteSaleRepository } from "./infra/sqlite/saleRepository.js";
import { FakeSocialPublisher } from "./infra/social/fakePublisher.js";
import { TwitterPublisher } from "./infra/twitter/twitterPublisher.js";

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
        publisher: config.useFakePublisher
            ? new FakeSocialPublisher()
            : new TwitterPublisher(),
        config: {
            pollIntervalMs: config.pollIntervalMs,
            stalePostingSeconds: 120,
            pruneDays: 30,
            pruneIntervalHours: 6,
            tokenCooldownHours: config.tokenCooldownHours,
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
