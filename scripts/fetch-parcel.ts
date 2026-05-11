import dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    formatCanvasPreview,
    parseParcelStatusKey,
    renderParcelContent,
    resolveParcelRenderInput,
    TERRAFORMS_ADDRESS,
    type ParcelFetchOptions,
    type ParcelRenderMethod,
} from "../src/infra/onchain/parcelFetcher.js";
import {
    getBooleanOption,
    getStringOption,
    parseArgs,
    parseBigIntOption,
    requireSinglePositional,
    type FlagSpec,
} from "./lib/cli.js";

dotenv.config();

const FLAGS: FlagSpec[] = [
    { name: "method", short: "m", value: true },
    { name: "version", short: "v", value: true },
    { name: "seed", short: "e", value: true },
    { name: "decay", short: "d", value: true },
    { name: "status", short: "s", value: true },
    { name: "canvas", short: "c", value: true },
    { name: "output", short: "o", value: true },
    { name: "dry-run", short: "n" },
    { name: "show-canvas" },
    { name: "rpc-url", value: true },
    { name: "force-terrain-for-daydream" },
    { name: "help", short: "h" },
];

const HELP = `Usage: yarn fetch:parcel <tokenId> [options]

Fetch Terraforms parcel HTML/SVG through the same on-chain adapter used by the bot.

Options:
  -m, --method <tokenHTML|tokenSVG>     Renderer selector (default tokenHTML)
  -v, --version <idx>                  Renderer index; defaults to on-chain mapping
  -e, --seed <n>                       Seed (default 10196)
  -d, --decay <n>                      Decay (default 0)
  -s, --status <name>                  terrain | daydream | terraformed | origin-daydream | origin-terraformed
  -c, --canvas <decimals>              Override canvas as decimal digits, no commas/hex
  -o, --output <file>                  Output file; use "-" for stdout
  -n, --dry-run                        Resolve inputs and print them without rendering
      --show-canvas                    With --dry-run, print all 16 canvas rows
      --rpc-url <url>                  JSON-RPC URL; defaults to ETH_RPC_URL or public node
      --force-terrain-for-daydream     Render Daydream/OriginDaydream from calculated terrain canvas
  -h, --help                           Show this help
`;

async function main() {
    const parsed = parseArgs(process.argv.slice(2), FLAGS);
    if (getBooleanOption(parsed, "help")) {
        console.log(HELP);
        return;
    }

    const tokenId = requireSinglePositional(parsed, "tokenId");
    const opts = parseFetchOptions(parsed);
    const input = await resolveParcelRenderInput(tokenId, opts);
    const output =
        getStringOption(parsed, "output") ??
        path.join(
            "tmp",
            `${input.tokenId}-v${input.version.value}-${input.status.slug}.html`,
        );

    if (getBooleanOption(parsed, "dry-run")) {
        printDryRun(input, output, getBooleanOption(parsed, "show-canvas"));
        return;
    }

    const content = await renderParcelContent(input);
    await writeOutput(output, content);
}

function parseFetchOptions(
    parsed: ReturnType<typeof parseArgs>,
): ParcelFetchOptions {
    const method = parseMethod(getStringOption(parsed, "method"));
    const status = getStringOption(parsed, "status");
    return {
        rpcUrl: getStringOption(parsed, "rpc-url"),
        method,
        version: getStringOption(parsed, "version"),
        seed: parseBigIntOption("seed", getStringOption(parsed, "seed")),
        decay: parseBigIntOption("decay", getStringOption(parsed, "decay")),
        statusOverride: status ? parseParcelStatusKey(status) : undefined,
        canvasOverride: getStringOption(parsed, "canvas"),
        forceTerrainForDaydream: getBooleanOption(
            parsed,
            "force-terrain-for-daydream",
        ),
    };
}

function parseMethod(
    value: string | undefined,
): ParcelRenderMethod | undefined {
    if (!value) return undefined;
    if (value === "tokenHTML" || value === "tokenSVG") return value;
    throw new Error("method must be tokenHTML or tokenSVG");
}

function printDryRun(
    input: Awaited<ReturnType<typeof resolveParcelRenderInput>>,
    output: string,
    showCanvas: boolean,
) {
    console.log("getparcel dry-run:");
    console.log(`  token_id        : ${input.tokenId}`);
    console.log(
        `  version         : ${input.version.value} (${input.version.source})`,
    );
    console.log(`  mapping_addr    : ${TERRAFORMS_ADDRESS}`);
    console.log(`  data_addr       : ${input.rendererAddress}`);
    console.log(`  placement       : ${input.placement}`);
    console.log(
        `  status          : ${input.status.slug} (${input.status.value}) (${input.status.source})`,
    );
    console.log(
        `  canvas_len      : ${input.canvas.rows.length} (source: ${input.canvas.source})`,
    );
    if (showCanvas) {
        input.canvas.rows.forEach((row, idx) => {
            console.log(`    [${idx}] ${row}`);
        });
    } else {
        console.log(
            `  canvas preview  : ${formatCanvasPreview(input.canvas.rows)}`,
        );
    }
    console.log(`  selector        : ${input.method}`);
    console.log(`  seed, decay     : ${input.seed}, ${input.decay}`);
    console.log(`  output          : ${output}`);
}

async function writeOutput(output: string, content: string) {
    if (output === "-") {
        process.stdout.write(content);
        return;
    }
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, content, "utf8");
    console.log(`Saved to: ${output}`);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
