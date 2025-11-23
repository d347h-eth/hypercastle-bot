import { TwitterApi, ApiResponseError } from "twitter-api-v2";
import { config } from "../config.js";
import { logger } from "../logger.js";

let v2Client: TwitterApi | null = null;
let cachedUserId: string | null = null;

export function getTwitterClient(): TwitterApi {
    if (!v2Client) {
        v2Client = new TwitterApi({
            appKey: config.x.appKey,
            appSecret: config.x.appSecret,
            accessToken: config.x.accessToken,
            accessSecret: config.x.accessSecret,
        });
    }
    return v2Client;
}

export async function ensureUserId(): Promise<string | null> {
    if (cachedUserId) return cachedUserId;
    const client = getTwitterClient();
    if (config.x.userId) {
        cachedUserId = config.x.userId;
        return cachedUserId;
    }
    if (config.x.username) {
        try {
            const user = await client.v2.userByUsername(config.x.username);
            cachedUserId = user.data?.id || null;
        } catch (e) {
            logger.warn("Failed to resolve username to user id", {
                error: String(e),
            });
            cachedUserId = null;
        }
        return cachedUserId;
    }
    return null;
}

export async function postTweet(text: string) {
    const client = getTwitterClient();
    return client.v2.tweet(text);
}

export function isRateLimitedError(e: unknown): boolean {
    if (e && typeof e === "object" && "code" in e) {
        const err = e as ApiResponseError;
        return (err.code as any) === 429 || err.rateLimitError === true;
    }
    const msg = String(e);
    return /429/.test(msg);
}

export async function fetchRecentTweets(
    limit = 5,
): Promise<{ id: string; text: string }[]> {
    const userId = await ensureUserId();
    if (!userId) return [];
    const client = getTwitterClient();
    const res = await client.v2.userTimeline(userId, {
        max_results: Math.max(5, Math.min(100, limit)),
        exclude: ["retweets", "replies"],
    });
    const out: { id: string; text: string }[] = [];
    for await (const tweet of res) {
        out.push({ id: tweet.id, text: tweet.text || "" });
        if (out.length >= limit) break;
    }
    return out;
}
