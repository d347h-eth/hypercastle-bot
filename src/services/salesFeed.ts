import { config } from "../config.js";
import { SaleRecord, RawSale } from "../types.js";
import { stableIdFor } from "../util/hash.js";

// Very small fetch wrapper without external deps
async function getJson(url: string, headers: Record<string, string>) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Sales API ${res.status}: ${text}`);
    }
    return res.json();
}

function parseTimestamp(v: unknown): number {
    if (typeof v === "number") return Math.floor(v);
    if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n)) return Math.floor(n);
        const d = Date.parse(v);
        if (Number.isFinite(d)) return Math.floor(d / 1000);
    }
    return Math.floor(Date.now() / 1000);
}

export interface SalesFeedResult {
    records: SaleRecord[];
}

export async function fetchSalesFeed(): Promise<SalesFeedResult> {
    const url = config.salesApiUrl;
    const json = await getJson(url, { "x-api-key": config.salesApiKey });

    // Expecting an array of sales; adjust mapping to your feed shape
    const arr: RawSale[] = Array.isArray(json)
        ? json
        : Array.isArray(json?.items)
        ? (json.items as RawSale[])
        : [];

    const records: SaleRecord[] = arr.map((raw) => {
        const saleId = raw.id || stableIdFor(raw);
        const createdAt = parseTimestamp(raw.createdAt ?? Date.now());
        const price =
            raw.price === undefined
                ? undefined
                : typeof raw.price === "number"
                ? String(raw.price)
                : String(raw.price);
        return {
            saleId,
            createdAt,
            title: String(raw.title ?? "Sale"),
            price,
            currency: raw.currency ? String(raw.currency) : undefined,
            url: raw.url ? String(raw.url) : undefined,
            payload: raw,
        };
    });

    return { records };
}

