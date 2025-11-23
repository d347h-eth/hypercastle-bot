export interface RawSale {
    saleId: string;
    timestamp: number; // unix seconds
    price: {
        currency: {
            contract: string;
            name?: string;
            symbol?: string;
            decimals?: number;
        };
        amount: {
            raw: string;
            decimal: number;
            usd?: number | null;
            native?: number;
        };
    };
    orderSide: "ask" | "bid" | string;
    washTradingScore?: number;
    token: {
        contract: string;
        tokenId: string; // numeric as string
        name?: string | null;
        image?: string | null;
        collection?: { id: string; name?: string | null } | null;
    };
    [k: string]: unknown;
}

export interface SaleRecord {
    saleId: string;
    createdAt: number; // unix seconds
    tokenId: string;
    name?: string;
    price: number; // decimal units of currency
    symbol: string;
    orderSide: string;
    payload: RawSale;
}
