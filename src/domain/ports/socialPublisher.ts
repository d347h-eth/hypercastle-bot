import { Tweet } from "../models.js";

export interface SocialPublisher {
    post(text: string, mediaIds?: string[]): Promise<Tweet>;
    uploadMedia(videoPath: string, mediaType?: string): Promise<string>;
    fetchRecent(limit: number): Promise<Tweet[]>;
    checkRateLimit(): Promise<RateLimitInfo | null>;
}

export interface RateLimitInfo {
    limit?: number;
    remaining?: number;
    reset?: number; // unix seconds
}
