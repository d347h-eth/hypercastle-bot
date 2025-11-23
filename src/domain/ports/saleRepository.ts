import { Sale } from "../models.js";

export interface QueuedSale {
    sale: Sale;
    attemptCount: number;
    tweetText?: string | null;
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
    requeueAfterRateLimit(saleId: string): void;
    scheduleRetry(saleId: string, nextAttemptAt: number): void;

    listStalePosting(cutoff: number): QueuedSale[];
    requeueStale(saleId: string, nextAttemptAt: number): void;

    pruneOld(cutoff: number, now: number, minInterval: number): void;
}
