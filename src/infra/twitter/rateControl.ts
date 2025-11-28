import { db } from "../../db.js";
import { RateLimitExceededError } from "../../domain/errors.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { shallowDiff } from "../../util/diff.js";
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
const SLOT_SECONDS: Record<Endpoint, number> = {
    post: Math.ceil(86400 / ENDPOINT_CONFIG.post.limit),
};
const FALLBACK_RECOVERY_SEC: Record<Endpoint, number> = {
    post: SLOT_SECONDS.post,
};

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
            const slotDelay = FALLBACK_RECOVERY_SEC[endpoint];
            const fallbackReset =
                (state.reset && state.reset > now
                    ? state.reset
                    : Math.max(lastSpent + slotDelay, now + slotDelay)) +
                RESET_BUFFER_SEC;
            // Persist a synthetic reset so we can self-heal without a future success call.
            if (!state.reset || state.reset <= now) {
                this.save(endpoint, {
                    limit,
                    remaining,
                    reset: fallbackReset,
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
                reserve: cfg.reserve,
                resetAt: fallbackReset,
                resetAtIso: toIso(fallbackReset),
                waitSec: fallbackReset - now,
                syntheticReset: !state.reset || state.reset <= now,
                lastSpentAt: lastSpent,
                lastSpentAtIso: toIso(lastSpent),
            });
            throw new RateLimitExceededError(
                `${endpoint} rate limited`,
                fallbackReset,
                remaining,
                limit,
            );
        }
        if (config.debugVerbose) {
            logger.debug("[Rate] Guard allow", {
                component: "RateControl",
                action: "guard",
                endpoint,
                remaining,
                limit,
                reset: state.reset,
                lastSpentAt: state.lastSpentAt,
                resetIso: toIso(state.reset),
                lastSpentAtIso: toIso(state.lastSpentAt),
            });
        }
        return state;
    }

    onSuccess(endpoint: Endpoint, rawRate?: any): RateState {
        const parsed = parseRate(rawRate);
        const current = this.loadAndRefresh(endpoint);
        const next =
            parsed ??
            {
                ...decrement(current, ENDPOINT_CONFIG[endpoint].limit),
                reset:
                    current.reset ??
                    unix() + FALLBACK_RECOVERY_SEC[endpoint],
                lastSpentAt: unix(),
                storedAt: unix(),
            };
        if (parsed) {
            next.lastSpentAt = unix();
            next.storedAt = unix();
        }
        this.save(endpoint, next);
        if (config.debugVerbose) {
            logger.debug("[Rate] Updated from success", {
                component: "RateControl",
                action: "onSuccess",
                endpoint,
                limit: next.limit ?? ENDPOINT_CONFIG[endpoint].limit,
                remaining: next.remaining,
                reset: next.reset,
                resetIso: toIso(next.reset),
                source: summarizeRate(rawRate),
                lastSpentAt: next.lastSpentAt,
                lastSpentAtIso: toIso(next.lastSpentAt),
                storedAt: next.storedAt,
                storedAtIso: toIso(next.storedAt),
            });
        }
        return next;
    }

    onError(endpoint: Endpoint, rawRate?: any): RateState {
        const parsed = parseRate(rawRate);
        const current = this.loadAndRefresh(endpoint);
        const next =
            parsed ??
            {
                ...current,
                remaining: 0,
                reset:
                    current.reset ??
                    unix() + FALLBACK_RECOVERY_SEC[endpoint],
                lastSpentAt: unix(),
                storedAt: unix(),
            };
        this.save(endpoint, next);
        logger.warn("[Rate] Updated from error", {
            component: "RateControl",
            action: "onError",
            endpoint,
            limit: next.limit ?? ENDPOINT_CONFIG[endpoint].limit,
            remaining: next.remaining,
            reset: next.reset,
            resetIso: toIso(next.reset),
            source: summarizeRate(rawRate),
            lastSpentAt: next.lastSpentAt,
            lastSpentAtIso: toIso(next.lastSpentAt),
            storedAt: next.storedAt,
            storedAtIso: toIso(next.storedAt),
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
            const refreshed = {
                limit: state.limit ?? cfg.limit,
                remaining: state.limit ?? cfg.limit,
                reset: state.reset,
                lastSpentAt: state.lastSpentAt ?? state.reset,
                storedAt: now,
            };
            const diff = shallowDiff(state as any, refreshed as any);
            if (Object.keys(diff).length > 0) {
                this.save(endpoint, refreshed);
                if (config.debugVerbose) {
                    logger.debug("[Rate] Reset passed; state refreshed", {
                        component: "RateControl",
                        action: "loadAndRefresh",
                        endpoint,
                        previous: state,
                        refreshed,
                        diff,
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
        limit,
        remaining,
        reset: state.reset,
        lastSpentAt: state.lastSpentAt,
        storedAt: state.storedAt,
    };
}

export function parseRate(raw: any): RateState | null {
    if (!raw) return null;
    // Prefer userDay bucket if present (daily cap for posting)
    const source =
        raw.userDay && raw.userDay.limit !== undefined ? raw.userDay : raw;
    const limit =
        source.limit !== undefined && Number.isFinite(Number(source.limit))
            ? Number(source.limit)
            : undefined;
    const remaining =
        source.remaining !== undefined &&
        Number.isFinite(Number(source.remaining))
            ? Number(source.remaining)
            : undefined;
    const reset =
        source.reset !== undefined && Number.isFinite(Number(source.reset))
            ? Number(source.reset)
            : source.resetMs !== undefined &&
                Number.isFinite(Number(source.resetMs))
              ? Math.ceil(Number(source.resetMs) / 1000)
              : undefined;
    if (
        limit === undefined &&
        remaining === undefined &&
        reset === undefined
    ) {
        return null;
    }
    const sanitized = sanitize({ limit, remaining, reset });
    if (
        sanitized.limit !== undefined &&
        sanitized.remaining !== undefined &&
        sanitized.limit > 0 &&
        sanitized.remaining > sanitized.limit
    ) {
        sanitized.remaining = sanitized.limit;
    }
    return sanitized;
}

function summarizeRate(raw: any): Record<string, unknown> | undefined {
    if (!raw) return undefined;
    const parsed = parseRate(raw);
    if (parsed) {
        return {
            limit: parsed.limit,
            remaining: parsed.remaining,
            reset: parsed.reset,
        };
    }
    return {
        limit: (raw as any)?.limit,
        remaining: (raw as any)?.remaining,
        reset: (raw as any)?.reset ?? (raw as any)?.resetMs,
    };
}

function unix(): number {
    return Math.floor(Date.now() / 1000);
}
