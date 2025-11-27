import { TwitterApi, ApiResponseError } from "twitter-api-v2";
import { config } from "../../config.js";
import { RateLimitExceededError } from "../../domain/errors.js";
import {
    SocialPublisher,
    RateLimitInfo,
} from "../../domain/ports/socialPublisher.js";
import { Tweet } from "../../domain/models.js";
import { logger } from "../../logger.js";
import { RateControl, parseRate } from "./rateControl.js";

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
            const rateInfo = extractRateInfoFromResponse(res);
            this.rates.onSuccess("post", rateInfo);
            logRateDebug("post", "success", rateInfo, res?.response?.headers);
            logger.info("[X] Tweet posted", {
                tweetId: res.data.id,
                rateLimit: rateInfo,
            });
            return { id: res.data.id, text: text };
        } catch (e) {
            const info = this.rates.onError(
                "post",
                extractRateInfoFromError(e),
            );
            logRateDebug(
                "post",
                "error",
                info,
                (e as any)?.response?.headers,
            );
            const resetAt = info?.reset;
            if (isRateLimitedError(e)) {
                logger.warn("[X] Tweet rate limited", {
                    endpoint: "post",
                    error: String(e),
                    resetAt,
                    remaining: info?.remaining,
                    limit: info?.limit,
                });
                throw new RateLimitExceededError(
                    "Tweet rate limited",
                    resetAt,
                    info?.remaining,
                    info?.limit,
                );
            }
            logger.error("[X] Tweet failed", { error: String(e), resetAt });
            throw e;
        }
    }

    async uploadMedia(
        videoPath: string,
        mediaType = "video/mp4",
    ): Promise<string> {
        logger.info("[X] Uploading media", { videoPath });
        try {
            this.rates.guard("post");
            const mediaId = await (this.client.v1 as any).uploadMedia(
                videoPath,
                {
                    type: "video",
                    mimeType: mediaType,
                },
            );
            const rateInfo = extractRateInfoFromResponse(mediaId);
            this.rates.onSuccess("post", rateInfo);
            logRateDebug(
                "post",
                "success_upload",
                rateInfo,
                (mediaId as any)?.response?.headers,
            );
            logger.info("[X] Media uploaded", { mediaId, rateLimit: rateInfo });
            return mediaId;
        } catch (e) {
            const info = this.rates.onError(
                "post",
                extractRateInfoFromError(e),
            );
            logRateDebug(
                "post",
                "error_upload",
                info,
                (e as any)?.response?.headers,
            );
            const resetAt = info?.reset;
            if (isRateLimitedError(e)) {
                logger.warn("[X] Media upload rate limited", {
                    endpoint: "post",
                    error: String(e),
                    resetAt,
                    remaining: info?.remaining,
                    limit: info?.limit,
                });
                throw new RateLimitExceededError(
                    "Media upload rate limited",
                    resetAt,
                    info?.remaining,
                    info?.limit,
                );
            }
            logger.error("[X] Media upload failed", { error: String(e), resetAt });
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
        if (
            snapshot.limit === undefined &&
            snapshot.remaining === undefined &&
            snapshot.reset === undefined
        ) {
            return null;
        }
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

function extractRateInfoFromError(e: unknown): RateLimitInfo | null {
    if (e && typeof e === "object") {
        const err = e as ApiResponseError;
        const rl: any = (err as any).rateLimit || (err as any).rateLimits;
        const info = parseRate(rl) || extractRateInfoFromResponse(rl);
        if (info) return info;
        const headers = (err as any)?.response?.headers;
        if (headers) {
            return parseRate({
                limit: headers["x-ratelimit-limit"],
                remaining: headers["x-ratelimit-remaining"],
                reset: headers["x-ratelimit-reset"],
            });
        }
    }
    return null;
}

function extractRateInfoFromResponse(res: any): RateLimitInfo | null {
    if (!res) return null;
    const rate = (res as any).rateLimit || (res as any).rateLimits;
    const parsed = parseRate(rate);
    if (parsed) return parsed;
    const headers = (res as any)?.response?.headers || (res as any)?.headers;
    if (headers) {
        return parseRate({
            limit: headers["x-ratelimit-limit"],
            remaining: headers["x-ratelimit-remaining"],
            reset: headers["x-ratelimit-reset"],
        });
    }
    return null;
}

function logRateDebug(
    endpoint: "post",
    stage: string,
    rate: RateLimitInfo | null,
    headers?: any,
): void {
    if (!config.debugVerbose) return;
    const snapshot = headersSnapshot(headers);
    logger.debug("[X] Rate headers", {
        endpoint,
        stage,
        rate,
        headers: snapshot,
    });
}

function headersSnapshot(headers: any): Record<string, unknown> | undefined {
    if (!headers) return undefined;
    const get = (key: string) =>
        headers[key] ??
        headers[key.toLowerCase()] ??
        headers.get?.(key) ??
        headers.get?.(key.toLowerCase());
    const limit = get("x-ratelimit-limit");
    const remaining = get("x-ratelimit-remaining");
    const reset = get("x-ratelimit-reset");
    if (
        limit === undefined &&
        remaining === undefined &&
        reset === undefined
    ) {
        return undefined;
    }
    return { limit, remaining, reset };
}
