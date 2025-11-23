import { config } from "../config.js";
import { SaleRecord, RawSale } from "../types.js";

// Very small fetch wrapper without external deps
async function getJson(url: string, headers: Record<string, string>) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Sales API ${res.status}: ${text}`);
    }
    return res.json();
}

export interface SalesFeedResult {
    records: SaleRecord[];
}

export async function fetchSalesFeed(): Promise<SalesFeedResult> {
    const base = config.salesApiBaseUrl.replace(/\/?$/, "");
    const params = new URLSearchParams({
        collection: config.salesCollectionAddress,
        sortBy: "time",
        sortDirection: "desc",
        offset: "0",
        limit: "100",
    });
    const url = `${base}/sales/v6?${params.toString()}`;
    const json = await getJson(url, { "x-api-key": config.salesApiKey });

    const arr: RawSale[] = Array.isArray(json?.sales) ? (json.sales as RawSale[]) : [];

    const records: SaleRecord[] = arr
        .filter((raw) => (raw.washTradingScore ?? 0) === 0)
        .map((raw) => {
            const saleId = String(raw.saleId);
            const createdAt = Math.floor(Number(raw.timestamp) || 0);
            const amount = Number(raw.price?.amount?.decimal ?? 0);
            const symbol = raw.price?.currency?.symbol || "";
            const orderSide = String(raw.orderSide || "").toLowerCase() || "ask";
            return {
                saleId,
                createdAt,
                tokenId: String(raw.token?.tokenId ?? ""),
                name: raw.token?.name ?? undefined,
                price: amount,
                symbol,
                orderSide,
                payload: raw,
            };
        });

    return { records };
}
