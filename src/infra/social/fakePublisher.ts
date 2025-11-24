import { SocialPublisher } from "../../domain/ports/socialPublisher.js";
import { Tweet } from "../../domain/models.js";
import { logger } from "../../logger.js";

let counter = 0;

export class FakeSocialPublisher implements SocialPublisher {
    private timeline: Tweet[] = [];

    async post(text: string, mediaIds?: string[]): Promise<Tweet> {
        const id = `fake-${Date.now()}-${++counter}`;
        const tweet = { id, text };
        this.timeline.unshift(tweet);
        logger.info("[FAKE] Tweet posted", { id, text, mediaIds });
        return tweet;
    }

    async uploadMedia(videoPath: string): Promise<string> {
        const mediaId = `fake-media-${Date.now()}`;
        logger.info("[FAKE] Media uploaded", { videoPath, mediaId });
        return mediaId;
    }

    async fetchRecent(limit: number): Promise<Tweet[]> {
        const max = Math.max(1, Math.min(100, limit));
        return this.timeline.slice(0, max);
    }
}
