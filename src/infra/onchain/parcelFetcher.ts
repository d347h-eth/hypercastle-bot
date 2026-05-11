import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    Address,
    PublicClient,
    concatHex,
    createPublicClient,
    getAddress,
    http,
    keccak256,
    maxUint256,
    padHex,
    toHex,
} from "viem";

const DEFAULT_RPC_URL =
    process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
export const TERRAFORMS_ADDRESS =
    "0x4e1f41613c9084fdb9e34e11fae9412427480e56" as const;
const TOKEN_TO_URI_SLOT = 11128n; // tokenToURIAddressIndex mapping slot on the proxy
const CANVAS_ROW_COUNT = 16;
const DEFAULT_SEED = 10196n;
const DEFAULT_DECAY = 0n;

export type ParcelRenderMethod = "tokenHTML" | "tokenSVG";

export type StatusKey =
    | "terrain"
    | "daydream"
    | "terraformed"
    | "originDaydream"
    | "originTerraformed";

export type ParcelStatusResolution = {
    value: bigint;
    label: string;
    slug: string;
    source: "override" | "live";
};

export type ParcelVersionResolution = {
    value: bigint;
    source: "override" | "live";
};

export type ParcelCanvasSource =
    | "override"
    | "live"
    | "zeroed"
    | "calculated-terrain";

export type ParcelCanvasResolution = {
    rows: bigint[];
    source: ParcelCanvasSource;
};

export interface ParcelRenderInput {
    rpcUrl: string;
    tokenId: bigint;
    method: ParcelRenderMethod;
    version: ParcelVersionResolution;
    rendererAddress: Address;
    placement: bigint;
    status: ParcelStatusResolution;
    canvas: ParcelCanvasResolution;
    seed: bigint;
    decay: bigint;
}

const STATUS_CONFIG: Record<
    StatusKey,
    { value: bigint; slug: string; label: string; aliases: string[] }
> = {
    terrain: {
        value: 0n,
        slug: "terrain",
        label: "Terrain",
        aliases: ["terrain", "t", "default", "0"],
    },
    daydream: {
        value: 1n,
        slug: "daydream",
        label: "Daydream",
        aliases: ["daydream", "dream", "1", "dd"],
    },
    terraformed: {
        value: 2n,
        slug: "terraformed",
        label: "Terraformed",
        aliases: ["terraformed", "tf", "2"],
    },
    originDaydream: {
        value: 3n,
        slug: "od",
        label: "OriginDaydream",
        aliases: ["origindaydream", "od", "origin-daydream", "3"],
    },
    originTerraformed: {
        value: 4n,
        slug: "ot",
        label: "OriginTerraformed",
        aliases: [
            "originterraformed",
            "ot",
            "origin-terraformed",
            "origin-terraform",
            "4",
        ],
    },
};

const STATUS_BY_VALUE: Record<string, StatusKey> = Object.entries(
    STATUS_CONFIG,
).reduce(
    (acc, [key, meta]) => {
        acc[meta.value.toString()] = key as StatusKey;
        return acc;
    },
    {} as Record<string, StatusKey>,
);

const STATUS_ALIAS_LOOKUP: Record<string, StatusKey> = Object.entries(
    STATUS_CONFIG,
).reduce(
    (acc, [key, meta]) => {
        meta.aliases.forEach((alias) => {
            acc[normalizeStatusInput(alias)] = key as StatusKey;
        });
        return acc;
    },
    {} as Record<string, StatusKey>,
);

export const PARCEL_STATUS_KEYS = Object.keys(STATUS_CONFIG) as StatusKey[];

const terraformsAbi = [
    {
        name: "tokenURIAddresses",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "" }],
        outputs: [{ type: "address" }],
    },
    {
        name: "tokenToPlacement",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "" }],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "tokenToStatus",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "" }],
        outputs: [{ type: "uint8" }],
    },
    {
        name: "tokenToCanvasData",
        type: "function",
        stateMutability: "view",
        inputs: [
            { type: "uint256", name: "" },
            { type: "uint256", name: "" },
        ],
        outputs: [{ type: "uint256" }],
    },
] as const;

const rendererAbi = [
    {
        name: "tokenHTML",
        type: "function",
        stateMutability: "view",
        inputs: [
            { type: "uint256", name: "status" },
            { type: "uint256", name: "placement" },
            { type: "uint256", name: "seed" },
            { type: "uint256", name: "decay" },
            { type: "uint256[]", name: "canvas" },
        ],
        outputs: [{ type: "string" }],
    },
    {
        name: "tokenSVG",
        type: "function",
        stateMutability: "view",
        inputs: [
            { type: "uint256", name: "status" },
            { type: "uint256", name: "placement" },
            { type: "uint256", name: "seed" },
            { type: "uint256", name: "decay" },
            { type: "uint256[]", name: "canvas" },
        ],
        outputs: [{ type: "string" }],
    },
    {
        name: "tokenHeightmapIndices",
        type: "function",
        stateMutability: "view",
        inputs: [
            { type: "uint256", name: "status" },
            { type: "uint256", name: "placement" },
            { type: "uint256", name: "seed" },
            { type: "uint256", name: "decay" },
            { type: "uint256[]", name: "canvas" },
        ],
        outputs: [{ type: "uint256[32][32]", name: "result" }],
    },
] as const;

export interface ParcelFetchOptions {
    rpcUrl?: string;
    method?: ParcelRenderMethod;
    version?: bigint | number | string;
    seed?: bigint;
    decay?: bigint;
    statusOverride?: StatusKey;
    canvasOverride?: bigint[] | string;
    outputDir?: string;
    outputPath?: string;
    forceTerrainForDaydream?: boolean;
}

export async function fetchParcelHtml(
    tokenId: number | string,
    opts: ParcelFetchOptions = {},
): Promise<{ html: string; filePath: string; input: ParcelRenderInput }> {
    const input = await resolveParcelRenderInput(tokenId, opts);
    const html = await renderParcelContent(input);

    const outPath =
        opts.outputPath ??
        path.join(
            opts.outputDir ?? path.join("data", "artifacts", String(tokenId)),
            `token-${tokenId}.${input.method === "tokenSVG" ? "svg" : "html"}`,
        );
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, html, "utf8");
    return { html, filePath: outPath, input };
}

export async function resolveParcelRenderInput(
    tokenId: number | string | bigint,
    opts: ParcelFetchOptions = {},
): Promise<ParcelRenderInput> {
    const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
    const client = createPublicClient({ transport: http(rpcUrl) });
    const tid = BigInt(tokenId);
    const method = opts.method ?? "tokenHTML";

    const version = await resolveVersion(client, tid, opts.version);
    const rendererAddress = await resolveDataAddress(client, version.value);
    const placement = await resolvePlacement(client, tid);
    let status = await resolveStatus(client, tid, opts.statusOverride);

    let canvas: ParcelCanvasResolution;

    // Special handling for Daydream/OriginDaydream without explicit canvas override
    const isDaydream =
        status.value === STATUS_CONFIG.daydream.value ||
        status.value === STATUS_CONFIG.originDaydream.value;
    if (isDaydream && !opts.canvasOverride && opts.forceTerrainForDaydream) {
        canvas = await resolveCalculatedTerrainCanvas(
            client,
            rendererAddress,
            tid,
            placement,
            opts.seed ?? DEFAULT_SEED,
            opts.decay ?? DEFAULT_DECAY,
        );

        // For renderParcel, we must use the "Terraformed" equivalent status
        // to ensure it renders the calculated canvas correctly.
        // Daydream -> Terraformed (2)
        // OriginDaydream -> OriginTerraformed (4)
        const targetStatus =
            status.value === STATUS_CONFIG.daydream.value
                ? STATUS_CONFIG.terraformed.value
                : STATUS_CONFIG.originTerraformed.value;

        // Mutate status object to force the render call to use the new status
        status = { ...status, value: targetStatus };
    } else {
        canvas = await resolveCanvas(client, tid, status, opts.canvasOverride);
    }

    return {
        rpcUrl,
        tokenId: tid,
        method,
        version,
        rendererAddress,
        placement,
        status,
        canvas,
        seed: opts.seed ?? DEFAULT_SEED,
        decay: opts.decay ?? DEFAULT_DECAY,
    };
}

export async function renderParcelContent(
    input: ParcelRenderInput,
): Promise<string> {
    const client = createPublicClient({ transport: http(input.rpcUrl) });
    return renderParcel(client, input.rendererAddress, input.method, {
        status: input.status.value,
        placement: input.placement,
        seed: input.seed,
        decay: input.decay,
        canvas: input.canvas.rows,
    });
}

export function parseParcelStatusKey(input: string): StatusKey {
    const key = STATUS_ALIAS_LOOKUP[normalizeStatusInput(input)];
    if (!key) {
        throw new Error(
            `Unknown status "${input}". Use one of: ${PARCEL_STATUS_KEYS.join(", ")}`,
        );
    }
    return key;
}

export function formatCanvasPreview(rows: bigint[], limit = 4): string {
    return rows
        .slice(0, limit)
        .map((row) => row.toString())
        .join(", ");
}

async function resolveCalculatedTerrainCanvas(
    client: PublicClient,
    rendererAddress: Address,
    tokenId: bigint,
    placement: bigint,
    seed: bigint,
    decay: bigint,
): Promise<ParcelCanvasResolution> {
    // 1. Get zeroed canvas (simulate terrain status)
    const zeroCanvas = await resolveCanvas(client, tokenId, {
        value: STATUS_CONFIG.terrain.value,
    });

    // 2. Call contract to calculate terrain heightmap
    // We use status=0 (Terrain) to force the calculation
    const indices = (await client.readContract({
        address: rendererAddress,
        abi: rendererAbi,
        functionName: "tokenHeightmapIndices",
        args: [
            STATUS_CONFIG.terrain.value,
            placement,
            seed,
            decay,
            zeroCanvas.rows,
        ],
    })) as unknown as readonly (readonly bigint[])[];

    // 3. Pack the 32x32 result into compressed canvas rows
    const packedRows = packHeightmapIndices(indices);

    // console.log("DEBUG: Packed Canvas (Decimal String):");
    // console.log(packedRows.map((r) => r.toString()).join());

    return {
        rows: normalizeCanvas(packedRows),
        source: "calculated-terrain",
    };
}

async function resolveVersion(
    client: PublicClient,
    tokenId: bigint,
    override?: bigint | number | string,
): Promise<ParcelVersionResolution> {
    if (override !== undefined) {
        const v = typeof override === "bigint" ? override : BigInt(override);
        return { value: v, source: "override" };
    }
    const slot = keccak256(
        concatHex([
            padHex(toHex(tokenId), { size: 32 }),
            padHex(toHex(TOKEN_TO_URI_SLOT), { size: 32 }),
        ]),
    );
    const stored = await client.getStorageAt({
        address: TERRAFORMS_ADDRESS,
        slot,
    });
    const value = stored ? BigInt(stored) : 0n;
    return { value, source: "live" };
}

async function resolveDataAddress(
    client: PublicClient,
    versionIndex: bigint,
): Promise<Address> {
    const address = await client.readContract({
        address: TERRAFORMS_ADDRESS,
        abi: terraformsAbi,
        functionName: "tokenURIAddresses",
        args: [versionIndex],
    });
    return getAddress(address as Address);
}

async function resolvePlacement(
    client: PublicClient,
    tokenId: bigint,
): Promise<bigint> {
    const placement = await client.readContract({
        address: TERRAFORMS_ADDRESS,
        abi: terraformsAbi,
        functionName: "tokenToPlacement",
        args: [tokenId],
    });
    return placement as bigint;
}

async function resolveStatus(
    client: PublicClient,
    tokenId: bigint,
    override?: StatusKey,
): Promise<ParcelStatusResolution> {
    if (override) {
        const meta = STATUS_CONFIG[override];
        return {
            value: meta.value,
            label: meta.label,
            slug: meta.slug,
            source: "override",
        };
    }
    const value = await client.readContract({
        address: TERRAFORMS_ADDRESS,
        abi: terraformsAbi,
        functionName: "tokenToStatus",
        args: [tokenId],
    });
    return statusFromChain(BigInt(value));
}

async function resolveCanvas(
    client: PublicClient,
    tokenId: bigint,
    status: { value: bigint },
    override?: bigint[] | string,
): Promise<ParcelCanvasResolution> {
    if (override) {
        const rows = Array.isArray(override)
            ? override
            : canvasFromDecimalString(String(override));
        return { rows: normalizeCanvas(rows), source: "override" };
    }
    if (status.value === STATUS_CONFIG.terrain.value) {
        return {
            rows: Array.from({ length: CANVAS_ROW_COUNT }, () => 0n),
            source: "zeroed",
        };
    }
    const rows = await Promise.all(
        Array.from({ length: CANVAS_ROW_COUNT }, (_, row) =>
            client
                .readContract({
                    address: TERRAFORMS_ADDRESS,
                    abi: terraformsAbi,
                    functionName: "tokenToCanvasData",
                    args: [tokenId, BigInt(row)],
                })
                .then((value) => value as bigint)
                .catch(() => 0n),
        ),
    );
    return { rows: normalizeCanvas(rows), source: "live" };
}

async function renderParcel(
    client: PublicClient,
    rendererAddress: Address,
    method: ParcelRenderMethod,
    args: {
        status: bigint;
        placement: bigint;
        seed: bigint;
        decay: bigint;
        canvas: bigint[];
    },
): Promise<string> {
    const result = await client.readContract({
        address: rendererAddress,
        abi: rendererAbi,
        functionName: method,
        args: [args.status, args.placement, args.seed, args.decay, args.canvas],
    });
    if (typeof result !== "string") {
        throw new Error("Unexpected render response (expected string)");
    }
    return result;
}

function statusFromChain(value: bigint): {
    value: bigint;
    label: string;
    slug: string;
    source: "live";
} {
    const key = STATUS_BY_VALUE[value.toString()];
    if (!key) {
        return {
            value,
            label: `Unknown(${value})`,
            slug: `unknown-${value}`,
            source: "live",
        };
    }
    const meta = STATUS_CONFIG[key];
    return { value, label: meta.label, slug: meta.slug, source: "live" };
}

function normalizeStatusInput(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, "");
}

function normalizeCanvas(rows: bigint[]): bigint[] {
    if (rows.length !== CANVAS_ROW_COUNT) {
        const padded = [...rows];
        while (padded.length < CANVAS_ROW_COUNT) padded.push(0n);
        return padded.slice(0, CANVAS_ROW_COUNT);
    }
    for (const row of rows) {
        if (row < 0 || row > maxUint256) {
            throw new Error("Canvas row exceeds uint256 range");
        }
    }
    return rows;
}

function canvasFromDecimalString(input: string): bigint[] {
    const cleaned = input.replace(/\s+/g, "");
    if (!cleaned) {
        throw new Error("Canvas override cannot be empty");
    }
    if (!/^\d+$/.test(cleaned)) {
        throw new Error(
            "Canvas override must be a string of decimal digits (no commas or hex)",
        );
    }

    const rows: bigint[] = [];
    let remaining = cleaned;
    while (remaining.length > 0 && rows.length < CANVAS_ROW_COUNT) {
        const chunk = remaining.slice(0, 64);
        remaining = remaining.slice(64);
        const value = BigInt(chunk);
        if (!isWithinUint256(value)) {
            throw new Error(
                `Canvas chunk exceeds uint256 at row ${rows.length}`,
            );
        }
        rows.push(value);
    }
    if (remaining.length > 0) {
        throw new Error(
            `Canvas override is too long (expected up to ${CANVAS_ROW_COUNT * 64} digits)`,
        );
    }
    while (rows.length < CANVAS_ROW_COUNT) {
        rows.push(0n);
    }
    return rows;
}

function packHeightmapIndices(
    indices: readonly (readonly bigint[])[],
): bigint[] {
    const rows: bigint[] = [];
    const numRows = indices.length;

    // We need to pack 32x32 indices into 16 uint256s.
    // Each uint256 holds 2 rows of the grid (64 values) as DECIMAL DIGITS.
    // The contract reverses the uint256 and reads digits from right to left (LSB).
    // So we need to pack them such that the first value (0,0) is the most significant digit (leftmost)
    // of the packed number (before reversal).
    // packed = v0 * 10^63 + v1 * 10^62 ... + v63.

    for (let r = 0; r < CANVAS_ROW_COUNT; r++) {
        // Each loop iteration produces ONE uint256 (one element of the canvas array)
        // This corresponds to 2 rows from the indices array: 2*r and 2*r+1
        const rowIdxA = r * 2;
        const rowIdxB = r * 2 + 1;

        const rowA = rowIdxA < numRows ? indices[rowIdxA] : [];
        const rowB = rowIdxB < numRows ? indices[rowIdxB] : [];

        let packed = 0n;

        // Process Row A (First 32 digits)
        for (let c = 0; c < 32; c++) {
            const val = c < rowA.length ? rowA[c] : 0n;
            // Append digit: shift existing left by one decimal place, add new value
            packed = packed * 10n + val;
        }

        // Process Row B (Next 32 digits)
        for (let c = 0; c < 32; c++) {
            const val = c < rowB.length ? rowB[c] : 0n;
            packed = packed * 10n + val;
        }

        rows.push(packed);
    }

    return rows;
}

function isWithinUint256(value: bigint) {
    return value >= 0 && value <= maxUint256;
}
