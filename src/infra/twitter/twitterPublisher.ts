import { TwitterApi, ApiResponseError } from "twitter-api-v2";
import { config } from "../../config.js";
import { RateLimitExceededError } from "../../domain/errors.js";
import {
    SocialPublisher,
    RateLimitInfo,
} from "../../domain/ports/socialPublisher.js";
import { Tweet } from "../../domain/models.js";
import { logger } from "../../logger.js";
import { RateControl } from "./rateControl.js";
import { toIso } from "../../util/time.js";

export class TwitterPublisher implements SocialPublisher {
    private client: TwitterApi;
    private userId: string | null = null;
    private rates = new RateControl();

    constructor() {
        this.client = new TwitterApi({
            appKey: config.x.appKey,
            appSecret: config.x.appSecret,
            accessToken: config.x.accessToken,
            accessSecret: config.x.accessSecret,
        });
    }

    async post(text: string, mediaIds?: string[]): Promise<Tweet> {
        logger.info("[X] Posting tweet", {
            component: "TwitterPublisher",
            action: "post",
            hasMedia: !!(mediaIds && mediaIds.length),
            mediaIds,
        });
        try {
            this.rates.guard("post");
            const mediaTuple =
                mediaIds && mediaIds.length
                    ? (mediaIds.slice(0, 4) as
                          | [string]
                          | [string, string]
                          | [string, string, string]
                          | [string, string, string, string])
                    : undefined;
            const res: any = await (this.client.v2 as any).tweet(
                {
                    text,
                    media: mediaTuple ? { media_ids: mediaTuple } : undefined,
                },
                { fullResponse: true },
            );

            this.logRawResponse("success", res);

            const rateInfo = this.rates.onSuccess("post", res);

            logger.info("[X] Tweet posted", {
                component: "TwitterPublisher",
                action: "post",
                tweetId: res.data.id,
                remaining: rateInfo.remaining,
                reset: rateInfo.reset,
            });
            return { id: res.data.id, text: text };
        } catch (e) {
            this.logRawResponse("error", e);

            const info = this.rates.onError("post", e);
            const resetAt = info.reset;

            if (isRateLimitedError(e)) {
                logger.warn("[X] Tweet rate limited", {
                    component: "TwitterPublisher",
                    action: "post",
                    endpoint: "post",
                    error: String(e),
                    resetAt,
                    resetAtIso: toIso(resetAt),
                    remaining: info.remaining,
                    limit: info.limit,
                });
                throw new RateLimitExceededError(
                    "Tweet rate limited",
                    resetAt,
                    info.remaining,
                    info.limit,
                );
            }
            logger.error("[X] Tweet failed", {
                component: "TwitterPublisher",
                action: "post",
                error: String(e),
                resetAt,
            });
            throw e;
        }
    }

    private logRawResponse(stage: string, obj: any) {
        if (!config.debugVerbose) return;
        try {
            const headers = obj?.response?.headers || obj?.headers;
            const data = obj?.data || obj?.errors || (obj as any)?.error;
            const code =
                obj?.code || obj?.response?.statusCode || obj?.response?.status;
            logger.debug("[X] Raw API Dump", {
                component: "TwitterPublisher",
                action: "logRawResponse",
                stage,
                code,
                headers,
                data,
            });
        } catch (err) {
            logger.warn("Failed to log raw response", { error: String(err) });
        }
    }

    async uploadMedia(
        videoPath: string,
        mediaType = "video/mp4",
    ): Promise<string> {
        logger.info("[X] Uploading media", {
            component: "TwitterPublisher",
            action: "uploadMedia",
            videoPath,
        });
        try {
            const mediaId = await (this.client.v1 as any).uploadMedia(
                videoPath,
                {
                    type: "video",
                    mimeType: mediaType,
                },
            );
            logger.info("[X] Media uploaded", {
                component: "TwitterPublisher",
                action: "uploadMedia",
                mediaId,
            });
            return mediaId;
        } catch (e) {
            logger.error("[X] Media upload failed", {
                component: "TwitterPublisher",
                action: "uploadMedia",
                error: String(e),
            });
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

    async checkRateLimit(): Promise<RateLimitInfo | null> {
        const snapshot = this.rates.snapshot("post");
        logger.info("[X] Rate snapshot (cached)", {
            component: "TwitterPublisher",
            action: "checkRateLimit",
            rate: snapshot,
        });
        return snapshot;
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
