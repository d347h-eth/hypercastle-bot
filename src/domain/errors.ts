export class RateLimitExceededError extends Error {
    resetAt?: number; // unix seconds when retry is allowed
    remaining?: number;
    limit?: number;
    constructor(
        message = "Rate limit exceeded",
        resetAt?: number,
        remaining?: number,
        limit?: number,
    ) {
        super(message);
        this.name = "RateLimitExceededError";
        this.resetAt = resetAt;
        this.remaining = remaining;
        this.limit = limit;
    }
}
