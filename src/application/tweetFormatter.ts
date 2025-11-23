import { Sale } from "../domain/models.js";

export function formatTweet(template: string, sale: Sale): string {
    const tokens: Record<string, string> = {
        tokenId: sale.tokenId,
        name: sale.name || "",
        price: formatPrice(sale.price.amount),
        symbol: sale.price.symbol,
        orderSide: normalizeSide(sale.orderSide),
    };

    let text = template;
    for (const [k, v] of Object.entries(tokens)) {
        text = text.replaceAll(`{${k}}`, v);
    }
    return text.trim();
}

export function formatPrice(amount: number): string {
    const s = amount.toFixed(4);
    return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function normalizeSide(side: string): string {
    const val = side?.toLowerCase?.() || "ask";
    return val === "bid" || val === "ask" ? val : val || "ask";
}

