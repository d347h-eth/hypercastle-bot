import dotenv from "dotenv";
import { TwitterApi } from "twitter-api-v2";
import { config } from "../src/config.js";

dotenv.config();

async function main(): Promise<void> {
    const tweetId = parseTweetId(process.argv.slice(2));
    validateConfigForRun();

    const client = new TwitterApi({
        appKey: config.x.appKey,
        appSecret: config.x.appSecret,
        accessToken: config.x.accessToken,
        accessSecret: config.x.accessSecret,
    });

    const res = await client.v2.deleteTweet(tweetId);
    console.log(
        JSON.stringify({
            ok: true,
            tweetId,
            deleted: res.data?.deleted ?? null,
        }),
    );
}

function parseTweetId(args: string[]): string {
    const tweetId = args[0];
    if (!tweetId || tweetId === "--help" || tweetId === "-h") {
        printUsage();
        process.exit(tweetId ? 0 : 1);
    }
    if (!/^\d+$/.test(tweetId)) {
        throw new Error(`Invalid tweet ID: ${tweetId}`);
    }
    return tweetId;
}

function printUsage(): void {
    console.error(
        [
            "Usage: yarn tsx scripts/delete-tweet.ts <tweetId>",
            "",
            "Deletes a tweet owned by the authenticated X user.",
            "This only removes the X post; it does not modify local SQLite rows.",
        ].join("\n"),
    );
}

function validateConfigForRun(): void {
    const missing: string[] = [];
    if (!config.x.appKey) missing.push("X_APP_KEY");
    if (!config.x.appSecret) missing.push("X_APP_SECRET");
    if (!config.x.accessToken) missing.push("X_ACCESS_TOKEN");
    if (!config.x.accessSecret) missing.push("X_ACCESS_SECRET");
    if (missing.length) {
        throw new Error(`Missing required env: ${missing.join(",")}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
