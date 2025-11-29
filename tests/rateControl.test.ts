import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RateControl, parseRate } from "../src/infra/twitter/rateControl.js";
import { RateLimitExceededError } from "../src/domain/errors.js";
import { db } from "../src/db.js";

const START_TIME = 1_700_000_000 * 1000; // Fixed start time

function clearRateMeta() {
    db.prepare("DELETE FROM meta WHERE key LIKE 'rate_state_%'").run();
}

describe("RateControl", () => {
    beforeEach(() => {
        clearRateMeta();
        vi.useFakeTimers();
        vi.setSystemTime(START_TIME);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("allows when remaining is above reserve", () => {
        const rc = new RateControl();
        const state = rc.guard("post");
        expect(state.remaining ?? 17).toBeGreaterThan(1);
    });

    it("blocks when remaining would consume reserve and uses provided reset", () => {
        const rc = new RateControl();
        const resetAt = Math.floor(START_TIME / 1000) + 120;
        rc.onSuccess("post", { limit: 17, remaining: 1, reset: resetAt });
        
        try {
            rc.guard("post");
            expect.fail("Should have thrown RateLimitExceededError");
        } catch (e) {
            const err = e as RateLimitExceededError;
            // Should pad reset by 60s
            expect(err.resetAt).toBe(resetAt + 60);
            expect(err.limit).toBe(17);
            expect(err.remaining).toBe(1);
        }
    });

    it("synthesizes reset time when blocked without known reset (fallback logic)", () => {
        const rc = new RateControl();
        // Force state to low remaining without a valid future reset
        // e.g. success call that didn't return headers, decremented to 1
        for (let i = 0; i < 16; i++) {
             rc.onSuccess("post", null); // decrements
        }
        
        // Now remaining is 1. Next guard should block.
        // Since we have no reset info, it should synthesize one: lastSpent + FALLBACK_SLOT_SEC (~84m)
        try {
            rc.guard("post");
            expect.fail("Should have thrown");
        } catch (e) {
            const err = e as RateLimitExceededError;
            const nowSec = Math.floor(START_TIME / 1000);
            const fallbackSlot = Math.ceil(86400 / 17); // 5083
            const expectedReset = nowSec + fallbackSlot + 60; // + buffer
            
            expect(err.resetAt).toBe(expectedReset);
        }
    });

    it("self-heals: allows traffic after synthetic reset passes", () => {
        const rc = new RateControl();
        // Burn allowance
        for (let i = 0; i < 16; i++) rc.onSuccess("post", null);

        // Blocked now
        expect(() => rc.guard("post")).toThrow();

        // Advance time past the synthetic reset window (~1.5h)
        vi.advanceTimersByTime(2 * 60 * 60 * 1000); 

        // Should be allowed now and reset to full limit
        const state = rc.guard("post");
        expect(state.remaining).toBe(17);
    });

    it("refreshes state from DB after reset passes", () => {
        const rc = new RateControl();
        const nowSec = Math.floor(START_TIME / 1000);
        rc.onError("post", { limit: 17, remaining: 0, reset: nowSec + 10 });
        
        vi.advanceTimersByTime(11_000); // 11s later

        const refreshed = rc.guard("post");
        expect(refreshed.remaining).toBe(17);
    });

    it("onError without headers sets remaining to 0 (safe fail)", () => {
        const rc = new RateControl();
        const state = rc.onError("post", null);
        expect(state.remaining).toBe(0);
        
        // Should set a synthetic reset in the future
        const nowSec = Math.floor(START_TIME / 1000);
        expect(state.reset).toBeGreaterThan(nowSec);
    });

    it("onSuccess without headers decrements counter", () => {
        const rc = new RateControl();
        const s1 = rc.onSuccess("post", null);
        expect(s1.remaining).toBe(16);
        
        const s2 = rc.onSuccess("post", null);
        expect(s2.remaining).toBe(15);
    });

    describe("parseRate", () => {
        it("parses x-rate-limit headers from response object", () => {
            const res = {
                headers: {
                    "x-ratelimit-limit": "50",
                    "x-ratelimit-remaining": "49",
                    "x-ratelimit-reset": "1234567890"
                }
            };
            const rate = parseRate(res);
            expect(rate).toEqual({ limit: 50, remaining: 49, reset: 1234567890 });
        });

        it("parses nested rateLimit object", () => {
            const res = { rateLimit: { limit: 100, remaining: 10, reset: 111 } };
            const rate = parseRate(res);
            expect(rate).toEqual({ limit: 100, remaining: 10, reset: 111 });
        });

        it("prefers userDay bucket (legacy)", () => {
            const res = { 
                userDay: { limit: 17, remaining: 5, reset: 222 }, 
                limit: 1000, 
                remaining: 500 
            };
            const rate = parseRate(res);
            expect(rate).toEqual({ limit: 17, remaining: 5, reset: 222 });
        });
        
        it("handles missing/null input", () => {
            expect(parseRate(null)).toBeNull();
            expect(parseRate({})).toBeNull();
        });
    });
});
