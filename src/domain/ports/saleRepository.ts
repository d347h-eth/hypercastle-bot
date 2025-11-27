import { Sale } from "../models.js";

export interface QueuedSale {
    sale: Sale;
    attemptCount: number;
    tweetText?: string | null;
    artifacts?: {
        htmlPath?: string | null;
        framesDir?: string | null;
        videoPath?: string | null;
        mediaId?: string | null;
        mediaUploadedAt?: number | null;
        metadataJson?: string | null;
        captureFps?: number | null;
    };
}

export interface SaleRepository {
    isInitialized(): boolean;
    markInitialized(): void;

    seedSeen(sales: Sale[], seenAt: number): void;
    enqueueNew(sales: Sale[], seenAt: number): number;

    claimNextReady(now: number): QueuedSale | null;
    markPosted(
        saleId: string,
        tweetId: string | null,
        tweetText: string,
        postedAt: number,
    ): void;
    requeueAfterRateLimit(saleId: string, nextAttemptAt?: number): void;
    scheduleRetry(saleId: string, nextAttemptAt: number): void;

    updateStatus(saleId: string, status: string): void;
    setHtmlPath(saleId: string, path: string): void;
    setFramesDir(saleId: string, dir: string): void;
    setVideoPath(saleId: string, path: string): void;
    setMediaId(saleId: string, mediaId: string, uploadedAt: number): void;
    clearMediaUpload(saleId: string): void;
    setMetadataJson(saleId: string, metadataJson: string): void;
    setCaptureFps(saleId: string, fps: number): void;

    listStalePosting(cutoff: number): QueuedSale[];
    requeueStale(saleId: string, nextAttemptAt: number): void;

    pruneOld(cutoff: number, now: number, minInterval: number): void;
}
