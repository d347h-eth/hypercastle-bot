import { config } from "../../config.js";

export type AttributeKey = "Mode" | "Chroma" | "Zone" | "Biome" | "Antenna";

export interface TokenAttributes {
    Mode?: string;
    Chroma?: string;
    Zone?: string;
    Biome?: string;
    Antenna?: string;
}

export async function fetchTokenAttributes(
    tokenId: string,
): Promise<TokenAttributes> {
    const tokenRef = `${config.salesCollectionAddress}:${tokenId}`;
    const base = config.salesApiBaseUrl.replace(/\/?$/, "");
    const url = `${base}/tokens/v7?tokens=${encodeURIComponent(tokenRef)}&includeAttributes=true`;
    const res = await fetch(url, {
        headers: { "x-api-key": config.salesApiKey },
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Token metadata ${res.status}: ${txt}`);
    }
    const json = (await res.json()) as any;
    const attrs: TokenAttributes = {};
    const list: any[] = json?.tokens?.[0]?.token?.attributes ?? [];
    for (const entry of list) {
        const key = entry?.key as AttributeKey;
        const value = entry?.value;
        if (!key || value === undefined || value === null) continue;
        if (
            key === "Mode" ||
            key === "Chroma" ||
            key === "Zone" ||
            key === "Biome" ||
            key === "Antenna"
        ) {
            (attrs as any)[key] = String(value);
        }
    }
    return attrs;
}

export function formatEnrichedText(
    baseText: string,
    attrs: TokenAttributes,
    tokenId: string,
    name: string | undefined,
    price: string,
    symbol: string,
    orderSide: string,
): string {
    const antenna = attrs.Antenna === "On" ? " [A]" : "";
    const line1 = `#${tokenId} | ${name ?? ""} | ${price} ${symbol} (take-${orderSide})`;
    const line2 = `${attrs.Mode ?? ""} ${attrs.Chroma ?? ""}${antenna}`.trim();
    const line3 =
        `${attrs.Zone ?? ""} ${attrs.Biome ? `B${attrs.Biome}` : ""}`.trim();
    return [line1, line2, line3].filter(Boolean).join("\n");
}
