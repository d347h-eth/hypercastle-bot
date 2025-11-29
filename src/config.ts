import dotenv from "dotenv";

dotenv.config();

function num(name: string, def: number): number {
    const raw = process.env[name];
    if (!raw) return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
}

export type AuthMode = "oauth1";

export interface Config {
    salesApiBaseUrl: string;
    salesApiKey: string;
    salesCollectionAddress: string;
    pollIntervalMs: number;
    debugVerbose: boolean;

    dbPath: string;

    xAuthMode: AuthMode;
    x: {
        appKey: string;
        appSecret: string;
        accessToken: string;
        accessSecret: string;
        userId?: string;
        username?: string;
    };

    useFakePublisher: boolean;
}

export const config: Config = {
    salesApiBaseUrl:
        process.env.SALES_API_BASE_URL || process.env.SALES_API_URL || "",
    salesApiKey: process.env.SALES_API_KEY || "",
    salesCollectionAddress: process.env.SALES_COLLECTION_ADDRESS || "",
    pollIntervalMs: num("POLL_INTERVAL_MS", 30_000),
    debugVerbose: (process.env.DEBUG_VERBOSE || "false")!.toLowerCase() === "true",

    dbPath: process.env.DB_PATH || "./data/bot.sqlite.db",

    xAuthMode: "oauth1",
    x: {
        appKey: process.env.X_APP_KEY || "",
        appSecret: process.env.X_APP_SECRET || "",
        accessToken: process.env.X_ACCESS_TOKEN || "",
        accessSecret: process.env.X_ACCESS_SECRET || "",
        userId: process.env.X_USER_ID || undefined,
        username: process.env.X_USERNAME || undefined,
    },

    useFakePublisher:
        (process.env.USE_FAKE_PUBLISHER || "false").toLowerCase() === "true",
};

export function validateConfig(): void {
    const missing: string[] = [];
    if (!config.salesApiBaseUrl) missing.push("SALES_API_BASE_URL");
    if (!config.salesApiKey) missing.push("SALES_API_KEY");
    if (!config.salesCollectionAddress)
        missing.push("SALES_COLLECTION_ADDRESS");
    if (!config.x.appKey) missing.push("X_APP_KEY");
    if (!config.x.appSecret) missing.push("X_APP_SECRET");
    if (!config.x.accessToken) missing.push("X_ACCESS_TOKEN");
    if (!config.x.accessSecret) missing.push("X_ACCESS_SECRET");
    if (missing.length) {
        throw new Error(`Missing required env: ${missing.join(",")}`);
    }
}
