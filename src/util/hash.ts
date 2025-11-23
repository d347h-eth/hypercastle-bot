import crypto from "node:crypto";

export function stableIdFor(obj: unknown): string {
    const json = JSON.stringify(obj);
    const h = crypto.createHash("sha256").update(json).digest("hex");
    return h.slice(0, 16); // short but collision-resistant enough for this scope
}
