import { db } from "../../db.js";
import { RateLimitExceededError } from "../../domain/errors.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { toIso } from "../../util/time.js";

type Endpoint = "post";

const META_KEYS: Record<Endpoint, string> = {
    post: "rate_state_post",
};

const ENDPOINT_CONFIG: Record<Endpoint, { limit: number; reserve: number }> = {
    post: {
        limit: 17,
        reserve: 1, // never spend the last slot
    },
};

const RESET_BUFFER_SEC = 60;
// Fallback if headers are completely missing (should not happen with X API)
const FALLBACK_SLOT_SEC = Math.ceil(86400 / ENDPOINT_CONFIG.post.limit);

export interface RateState {
    limit?: number;
    remaining?: number;
    reset?: number;
    lastSpentAt?: number;
    storedAt?: number;
}

export class RateControl {
    guard(endpoint: Endpoint): RateState {
        const state = this.loadAndRefresh(endpoint);
        const cfg = ENDPOINT_CONFIG[endpoint];
        const limit = state.limit ?? cfg.limit;
        const remaining = state.remaining ?? limit;

        if (remaining <= cfg.reserve) {
            const now = unix();
            const lastSpent = state.lastSpentAt ?? now;

            // Calculate a safe reset time
            let resetAt = state.reset;
            if (!resetAt || resetAt <= now) {
                // If we don't have a valid future reset, synthetically create one
                // based on the fallback slot duration to allow self-healing.
                resetAt = Math.max(
                    lastSpent + FALLBACK_SLOT_SEC,
                    now + FALLBACK_SLOT_SEC,
                );
            }

            // Add buffer
            const safeReset = resetAt + RESET_BUFFER_SEC;

            // Persist this synthetic/verified state to prevent hammering
            if (!state.reset || state.reset <= now) {
                this.save(endpoint, {
                    ...state,
                    remaining, // keep current remaining (likely 0 or 1)
                    reset: safeReset,
                    lastSpentAt: lastSpent,
                    storedAt: now,
                });
            }

            logger.warn("[Rate] Guard blocked", {
                component: "RateControl",
                action: "guard",
                endpoint,
                remaining,
                limit,
                resetAt: safeReset,
                resetAtIso: toIso(safeReset),
            });

            throw new RateLimitExceededError(
                `${endpoint} rate limited`,
                safeReset,
                remaining,
                limit,
            );
        }

        return state;
    }

    onSuccess(endpoint: Endpoint, response: any): RateState {
        const info = parseRate(response);
        const current = this.loadAndRefresh(endpoint);
        const now = unix();

        const next: RateState = info
            ? {
                  limit: info.limit,
                  remaining: info.remaining,
                  reset: info.reset,
                  lastSpentAt: now,
                  storedAt: now,
              }
            : {
                  ...decrement(current, ENDPOINT_CONFIG[endpoint].limit),
                  lastSpentAt: now,
                  storedAt: now,
              };

        this.save(endpoint, next);

        if (config.debugVerbose) {
            logger.debug("[Rate] Updated from success", {
                component: "RateControl",
                action: "onSuccess",
                endpoint,
                info,
                next: formatStateForLog(next),
            });
        }
        return next;
    }

    onError(endpoint: Endpoint, error: any): RateState {
        const info = parseRate(error);
        const current = this.loadAndRefresh(endpoint);
        const now = unix();

        // If we got headers/rate info, trust them.
        // If not, we assume the worst (exhausted or critical error) and block until recovery.
        // This matches the "safe fail" behavior: unknown error -> 0 remaining.

        const next: RateState = info
            ? {
                  limit: info.limit,
                  remaining: info.remaining,
                  reset: info.reset,
                  lastSpentAt: now,
                  storedAt: now,
              }
            : {
                  ...current,
                  remaining: 0,
                  reset:
                      current.reset && current.reset > now
                          ? current.reset
                          : now + FALLBACK_SLOT_SEC,
                  lastSpentAt: now,
                  storedAt: now,
              };

        this.save(endpoint, next);

        logger.warn("[Rate] Updated from error", {
            component: "RateControl",
            action: "onError",
            endpoint,
            info,
            next: formatStateForLog(next),
            error: String(error),
        });
        return next;
    }

    snapshot(endpoint: Endpoint): RateState {
        return this.loadAndRefresh(endpoint);
    }

    private loadAndRefresh(endpoint: Endpoint): RateState {
        const cfg = ENDPOINT_CONFIG[endpoint];
        const state = this.load(endpoint);
        const now = unix();

        if (state.reset && now >= state.reset) {
            // Reset period has passed, restore limits
            const refreshed: RateState = {
                limit: state.limit ?? cfg.limit,
                remaining: state.limit ?? cfg.limit, // Restore full allowance
                reset: undefined, // Clear reset
                lastSpentAt: state.lastSpentAt,
                storedAt: now,
            };

            // Only save/log if different
            if (state.remaining !== refreshed.remaining) {
                this.save(endpoint, refreshed);
                if (config.debugVerbose) {
                    logger.debug("[Rate] Reset passed; state refreshed", {
                        component: "RateControl",
                        action: "loadAndRefresh",
                        endpoint,
                        previous: formatStateForLog(state),
                        refreshed: formatStateForLog(refreshed),
                    });
                }
            }
            return refreshed;
        }
        return state;
    }

    private load(endpoint: Endpoint): RateState {
        const row = db
            .prepare("SELECT value FROM meta WHERE key=?")
            .get(META_KEYS[endpoint]) as { value?: string } | undefined;
        if (!row?.value) return {};
        try {
            const parsed = JSON.parse(row.value) as RateState;
            return sanitize(parsed);
        } catch {
            return {};
        }
    }

    private save(endpoint: Endpoint, state: RateState): void {
        db.prepare("REPLACE INTO meta(key,value) VALUES(?,?)").run(
            META_KEYS[endpoint],
            JSON.stringify(state),
        );
    }
}

function formatStateForLog(state: RateState) {
    return {
        ...state,
        resetIso: toIso(state.reset),
        lastSpentAtIso: toIso(state.lastSpentAt),
        storedAtIso: toIso(state.storedAt),
    };
}

function sanitize(state: RateState): RateState {
    const limit =
        state.limit !== undefined && Number.isFinite(state.limit)
            ? Number(state.limit)
            : undefined;
    const remaining =
        state.remaining !== undefined && Number.isFinite(state.remaining)
            ? Math.max(0, Number(state.remaining))
            : undefined;
    const reset =
        state.reset !== undefined && Number.isFinite(state.reset)
            ? Number(state.reset)
            : undefined;
    const lastSpentAt =
        state.lastSpentAt !== undefined && Number.isFinite(state.lastSpentAt)
            ? Number(state.lastSpentAt)
            : undefined;
    const storedAt =
        state.storedAt !== undefined && Number.isFinite(state.storedAt)
            ? Number(state.storedAt)
            : undefined;
    return { limit, remaining, reset, lastSpentAt, storedAt };
}

function decrement(state: RateState, fallbackLimit: number): RateState {
    const limit = state.limit ?? fallbackLimit;
    const remaining =
        state.remaining !== undefined
            ? Math.max(0, state.remaining - 1)
            : limit - 1;
    return {
        ...state,
        limit,
        remaining,
    };
}

export function parseRate(obj: any): RateState | null {
    if (!obj) return null;

    // 1. Check for headers (standard X API location)
    const headers =
        obj.response?.headers ||
        obj.headers ||
        (obj.error && obj.error.headers);

    if (headers) {
        const get = (key: string) =>
            headers[key] ??
            headers[key.toLowerCase?.()] ??
            headers.get?.(key) ??
            headers.get?.(key.toLowerCase?.());

        // Helper to extract a set of headers
        const extract = (prefix: string) => {
            const limit = get(`${prefix}-limit`);
            const remaining = get(`${prefix}-remaining`);
            const reset = get(`${prefix}-reset`);
            if (
                limit !== undefined &&
                remaining !== undefined &&
                reset !== undefined
            ) {
                return sanitize({
                    limit: Number(limit),
                    remaining: Number(remaining),
                    reset: Number(reset),
                });
            }
            return null;
        };

        // Priority 1: User 24h limit (most specific for posting)
        const user24 = extract("x-user-limit-24hour");
        if (user24) return user24;

        // Priority 2: App 24h limit
        const app24 = extract("x-app-limit-24hour");
        if (app24) return app24;

        // Priority 3: Standard generic limit
        const standard = extract("x-rate-limit");
        if (standard) return standard;
    }

    // 2. Check structure with nested 'rateLimit' or 'rateLimits'
    const rl = obj.rateLimit || obj.rateLimits;
    if (rl) {
        return parseRate(rl); // Recurse
    }

    // 3. Check for userDay bucket (Legacy/Priority logic)
    if (obj.userDay) {
        return parseRate(obj.userDay); // Recurse
    }

    // 4. Check for direct properties (Test mocks or simple objects)
    // Note: We need to be careful not to pick up garbage, but tests send clean objects.
    const limit = obj.limit;
    const remaining = obj.remaining;
    const reset = obj.reset ?? obj.resetMs; // Support resetMs

    if (limit !== undefined && remaining !== undefined) {
        return sanitize({
            limit: Number(limit),
            remaining: Number(remaining),
            reset:
                reset !== undefined
                    ? obj.resetMs !== undefined
                        ? Math.ceil(Number(reset) / 1000)
                        : Number(reset)
                    : undefined,
        });
    }

    return null;
}

function unix(): number {
    return Math.floor(Date.now() / 1000);
}
