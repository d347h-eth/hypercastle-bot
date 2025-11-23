import { Tweet } from "../models.js";

export interface SocialPublisher {
    post(text: string): Promise<Tweet>;
    fetchRecent(limit: number): Promise<Tweet[]>;
}

