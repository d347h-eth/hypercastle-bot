import { Tweet } from "../models.js";

export interface SocialPublisher {
    post(text: string, mediaIds?: string[]): Promise<Tweet>;
    uploadMedia(videoPath: string, mediaType?: string): Promise<string>;
    fetchRecent(limit: number): Promise<Tweet[]>;
}
