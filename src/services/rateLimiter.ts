import { config } from "../config.js";
import { db } from "../db.js";

function yyyymmddUtc(date = new Date()): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function currentWindowKey(): string {
    // window defined by UTC date with reset hour offset
    const now = new Date();
    const hour = now.getUTCHours();
    let day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (hour < config.rateResetHourUtc) {
        day = new Date(day.getTime() - 24 * 3600 * 1000);
    }
    return `${yyyymmddUtc(day)}@H${config.rateResetHourUtc}`;
}

export function getRateUsage(): { window: string; used: number; limit: number } {
    const window = currentWindowKey();
    const row = db
        .prepare<[string]>("SELECT value FROM meta WHERE key = ?")
        .get("rate_window_day") as any;
    let used = 0;
    if (!row || row.value !== window) {
        // reset
        db.exec("BEGIN");
        try {
            db.prepare("REPLACE INTO meta(key,value) VALUES(?,?)").run(
                "rate_window_day",
                window,
            );
            db.prepare("REPLACE INTO meta(key,value) VALUES(?,?)").run(
                "rate_used",
                "0",
            );
            db.exec("COMMIT");
            used = 0;
        } catch {
            db.exec("ROLLBACK");
        }
    } else {
        const usedRow = db
            .prepare<[string]>("SELECT value FROM meta WHERE key = ?")
            .get("rate_used") as any;
        used = usedRow ? Number(usedRow.value) || 0 : 0;
    }
    return { window, used, limit: config.rateMaxPerDay };
}

export function setUsageToLimit(): void {
    const { window, limit } = getRateUsage();
    db.exec("BEGIN");
    try {
        db.prepare("REPLACE INTO meta(key,value) VALUES(?,?)").run(
            "rate_used",
            String(limit),
        );
        db.prepare("REPLACE INTO meta(key,value) VALUES(?,?)").run(
            "rate_window_day",
            window,
        );
        db.exec("COMMIT");
    } catch {
        db.exec("ROLLBACK");
        throw new Error("Failed to set usage to limit");
    }
}

export function incrementUsage(): void {
    const { window } = getRateUsage();
    db.exec("BEGIN");
    try {
        const cur = db
            .prepare<[string]>("SELECT value FROM meta WHERE key = ?")
            .get("rate_used") as any;
        const used = cur ? Number(cur.value) || 0 : 0;
        db.prepare("REPLACE INTO meta(key,value) VALUES(?,?)").run(
            "rate_used",
            String(used + 1),
        );
        db.prepare("REPLACE INTO meta(key,value) VALUES(?,?)").run(
            "rate_window_day",
            window,
        );
        db.exec("COMMIT");
    } catch {
        db.exec("ROLLBACK");
        throw new Error("Failed to increment rate usage");
    }
}
