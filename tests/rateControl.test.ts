import { describe, it, expect, beforeEach } from "vitest";
import { RateControl, parseRate } from "../src/infra/twitter/rateControl.js";
import { RateLimitExceededError } from "../src/domain/errors.js";
import { db } from "../src/db.js";

let NOW = Math.floor(Date.now() / 1000);

function clearRateMeta() {
    db.prepare("DELETE FROM meta WHERE key LIKE 'rate_state_%'").run();
}

describe("RateControl", () => {
    beforeEach(() => {
        clearRateMeta();
        NOW = Math.floor(Date.now() / 1000);
    });

    it("allows when remaining is above reserve", () => {
        const rc = new RateControl();
        const state = rc.guard("post");
        expect(state.remaining ?? 17).toBeGreaterThan(0);
    });

    it("blocks when remaining would consume reserve and pads reset", () => {
        const rc = new RateControl();
        rc.onSuccess("post", { limit: 17, remaining: 1, reset: NOW + 100 });
        expect(() => rc.guard("post")).toThrowError(RateLimitExceededError);
        try {
            rc.guard("post");
        } catch (e) {
            const err = e as RateLimitExceededError;
            expect(err.resetAt ?? 0).toBeGreaterThanOrEqual(NOW + 100);
            // Synthetic reset will default to slot spacing when none is known (~84m).
            expect(err.resetAt ?? 0).toBeLessThanOrEqual(NOW + Math.ceil(86400 / 17) + 10 + 60);
            expect(err.limit).toBe(17);
            expect(err.remaining).toBe(1);
        }
    });

    it("refreshes state after reset passes", () => {
        const rc = new RateControl();
        rc.onError("post", { limit: 17, remaining: 0, reset: NOW - 10 });
        const refreshed = rc.guard("post");
        expect(refreshed.remaining).toBe(17);
    });

    it("onError without headers sets remaining to 0 and adds slot-sized recovery delay", () => {
        const rc = new RateControl();
        const state = rc.onError("post", null);
        expect(state.remaining).toBe(0);
        const delta = (state.reset ?? 0) - Math.floor(Date.now() / 1000);
        expect(delta).toBeGreaterThan(0);
        expect(delta).toBeGreaterThanOrEqual(Math.ceil(86400 / 17) - 2);
    });

    it("tracks endpoints independently", () => {
        const rc = new RateControl();
        rc.onSuccess("post", { limit: 17, remaining: 10, reset: NOW + 50 });
        expect(rc.snapshot("post")?.remaining).toBe(10);
    });

    it("prefers userDay bucket when parsing headers", () => {
        const info = parseRate({ userDay: { limit: 17, remaining: 5, reset: NOW + 10 }, limit: 100, remaining: 50, reset: NOW + 20 });
        expect(info?.limit).toBe(17);
        expect(info?.remaining).toBe(5);
        expect(info?.reset).toBe(NOW + 10);
    });
});
