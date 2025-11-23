import { config } from "../../config.js";
import { Sale } from "../../domain/models.js";
import { SalesFeedPort } from "../../domain/ports/salesFeed.js";

interface RawSale {
    saleId: string;
    timestamp: number;
    washTradingScore?: number;
    isDeleted?: boolean;
    orderSide?: string;
    price?: {
        currency?: {
            symbol?: string;
        };
        amount?: {
            decimal?: number;
        };
    };
    token?: {
        tokenId?: string;
        name?: string | null;
    };
    [k: string]: unknown;
}

export class ReservoirSalesFeed implements SalesFeedPort {
    async fetchRecent(): Promise<Sale[]> {
        const base = config.salesApiBaseUrl.replace(/\/?$/, "");
        const params = new URLSearchParams({
            collection: config.salesCollectionAddress,
            sortBy: "time",
            sortDirection: "desc",
            includeTokenMetadata: "true",
        });
        const url = `${base}/sales/v6?${params.toString()}`;
        const json = await this.getJson(url, {
            "x-api-key": config.salesApiKey,
        });
        const arr: RawSale[] = Array.isArray(json?.sales)
            ? (json.sales as RawSale[])
            : [];

        return arr
            .filter(
                (raw) =>
                    (raw.washTradingScore ?? 0) === 0 && raw.isDeleted !== true,
            )
            .map((raw) => this.toSale(raw));
    }

    private async getJson(url: string, headers: Record<string, string>) {
        const res = await fetch(url, { headers });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Sales API ${res.status}: ${text}`);
        }
        return res.json();
    }

    private toSale(raw: RawSale): Sale {
        const amount = Number(raw.price?.amount?.decimal ?? 0);
        const symbol = raw.price?.currency?.symbol || "";
        const ts = Number(raw.timestamp) || Math.floor(Date.now() / 1000);
        const side = (raw.orderSide || "ask").toLowerCase();
        return {
            id: String(raw.saleId),
            tokenId: String(raw.token?.tokenId ?? ""),
            name: raw.token?.name ?? undefined,
            timestamp: ts,
            price: { amount, symbol },
            orderSide: side,
            payload: raw,
        };
    }
}
