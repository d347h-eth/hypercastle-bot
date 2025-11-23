import { db } from "../../db.js";
import { RateLimiter, RateUsage } from "../../domain/ports/rateLimiter.js";

export class SqliteRateLimiter implements RateLimiter {
    constructor(
        private readonly resetHourUtc: number,
        private readonly dailyLimit: number,
    ) {}

    getUsage(): RateUsage {
        const window = this.currentWindowKey();
        const row = db
            .prepare("SELECT value FROM meta WHERE key='rate_window_day'")
            .get() as { value?: string } | undefined;
        let used = 0;
        if (!row || row.value !== window) {
            this.resetWindow(window);
        } else {
            const usedRow = db
                .prepare("SELECT value FROM meta WHERE key='rate_used'")
                .get() as { value?: string } | undefined;
            used = usedRow ? Number(usedRow.value) || 0 : 0;
        }
        return { window, used, limit: this.dailyLimit };
    }

    increment(): void {
        const { window } = this.getUsage();
        db.exec("BEGIN");
        try {
            const cur = db
                .prepare("SELECT value FROM meta WHERE key='rate_used'")
                .get() as { value?: string } | undefined;
            const used = cur ? Number(cur.value) || 0 : 0;
            db.prepare(
                "REPLACE INTO meta(key,value) VALUES('rate_used',?)",
            ).run(String(used + 1));
            db.prepare(
                "REPLACE INTO meta(key,value) VALUES('rate_window_day',?)",
            ).run(window);
            db.exec("COMMIT");
        } catch {
            db.exec("ROLLBACK");
            throw new Error("Failed to increment rate usage");
        }
    }

    exhaustUntilReset(): void {
        const { window } = this.getUsage();
        db.exec("BEGIN");
        try {
            db.prepare(
                "REPLACE INTO meta(key,value) VALUES('rate_used',?)",
            ).run(String(this.dailyLimit));
            db.prepare(
                "REPLACE INTO meta(key,value) VALUES('rate_window_day',?)",
            ).run(window);
            db.exec("COMMIT");
        } catch {
            db.exec("ROLLBACK");
            throw new Error("Failed to set rate usage to limit");
        }
    }

    private resetWindow(window: string): void {
        db.exec("BEGIN");
        try {
            db.prepare(
                "REPLACE INTO meta(key,value) VALUES('rate_window_day',?)",
            ).run(window);
            db.prepare(
                "REPLACE INTO meta(key,value) VALUES('rate_used','0')",
            ).run();
            db.exec("COMMIT");
        } catch {
            db.exec("ROLLBACK");
        }
    }

    private currentWindowKey(): string {
        const now = new Date();
        const hour = now.getUTCHours();
        let day = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        if (hour < this.resetHourUtc) {
            day = new Date(day.getTime() - 24 * 3600 * 1000);
        }
        const y = day.getUTCFullYear();
        const m = String(day.getUTCMonth() + 1).padStart(2, "0");
        const d = String(day.getUTCDate()).padStart(2, "0");
        return `${y}-${m}-${d}@H${this.resetHourUtc}`;
    }
}
