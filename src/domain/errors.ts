export class RateLimitExceededError extends Error {
    constructor(message = "Rate limit exceeded") {
        super(message);
        this.name = "RateLimitExceededError";
    }
}

