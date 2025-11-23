export interface RateUsage {
    window: string;
    used: number;
    limit: number;
}

export interface RateLimiter {
    getUsage(): RateUsage;
    increment(): void;
    exhaustUntilReset(): void;
}
