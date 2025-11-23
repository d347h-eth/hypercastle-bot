export type OrderSide = "ask" | "bid" | string;

export interface Price {
    amount: number; // decimal amount in currency units
    symbol: string;
}

export interface Sale {
    id: string; // saleId
    tokenId: string;
    name?: string;
    timestamp: number; // unix seconds
    price: Price;
    orderSide: OrderSide;
    payload: unknown; // raw API payload for persistence/recovery
}

export interface Tweet {
    id: string;
    text: string;
}

