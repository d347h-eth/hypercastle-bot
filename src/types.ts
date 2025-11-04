export interface RawSale {
    // Adjust these according to your feed
    id?: string; // if absent, we'll hash payload
    createdAt?: string | number; // timestamp
    title?: string;
    price?: number | string;
    currency?: string;
    url?: string;
    [k: string]: unknown;
}

export interface SaleRecord {
    saleId: string;
    createdAt: number; // unix seconds
    title?: string;
    price?: string;
    currency?: string;
    url?: string;
    payload: RawSale;
}

