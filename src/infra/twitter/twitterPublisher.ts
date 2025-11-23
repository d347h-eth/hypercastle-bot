import { TwitterApi, ApiResponseError } from "twitter-api-v2";
import { config } from "../../config.js";
import { RateLimitExceededError } from "../../domain/errors.js";
import { SocialPublisher } from "../../domain/ports/socialPublisher.js";
import { Tweet } from "../../domain/models.js";
import { logger } from "../../logger.js";

export class TwitterPublisher implements SocialPublisher {
    private client: TwitterApi;
    private userId: string | null = null;

    constructor() {
        this.client = new TwitterApi({
            appKey: config.x.appKey,
            appSecret: config.x.appSecret,
            accessToken: config.x.accessToken,
            accessSecret: config.x.accessSecret,
        });
    }

    async post(text: string): Promise<Tweet> {
        try {
            const res = await this.client.v2.tweet(text);
            return { id: res.data.id, text: text };
        } catch (e) {
            if (isRateLimitedError(e)) {
                throw new RateLimitExceededError();
            }
            throw e;
        }
    }

    async fetchRecent(limit: number): Promise<Tweet[]> {
        const userId = await this.ensureUserId();
        if (!userId) return [];
        try {
            const res = await this.client.v2.userTimeline(userId, {
                max_results: Math.max(5, Math.min(100, limit)),
                exclude: ["retweets", "replies"],
            });
            const out: Tweet[] = [];
            for await (const tweet of res) {
                out.push({ id: tweet.id, text: tweet.text || "" });
                if (out.length >= limit) break;
            }
            return out;
        } catch (e) {
            if (isRateLimitedError(e)) {
                logger.warn("Timeline rate limited", { error: String(e) });
                return [];
            }
            logger.warn("Timeline fetch failed", { error: String(e) });
            return [];
        }
    }

    private async ensureUserId(): Promise<string | null> {
        if (this.userId) return this.userId;
        if (config.x.userId) {
            this.userId = config.x.userId;
            return this.userId;
        }
        if (!config.x.username) return null;
        try {
            const user = await this.client.v2.userByUsername(config.x.username);
            this.userId = user.data?.id || null;
        } catch (e) {
            logger.warn("Failed to resolve username", { error: String(e) });
            this.userId = null;
        }
        return this.userId;
    }
}

function isRateLimitedError(e: unknown): boolean {
    if (e && typeof e === "object" && "code" in e) {
        const err = e as ApiResponseError;
        return (err.code as any) === 429 || err.rateLimitError === true;
    }
    const msg = String(e);
    return /429/.test(msg);
}
