import dotenv from "dotenv";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    captureFrames,
    type FrameCaptureOptions,
} from "../src/infra/capture/frameCapture.js";
import { renderVideo } from "../src/infra/capture/videoRenderer.js";
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
    parsePositiveIntegerOption,
    requireSinglePositional,
    type FlagSpec,
} from "./lib/cli.js";

dotenv.config();

const FLAGS: FlagSpec[] = [
    { name: "method", short: "m", value: true },
    { name: "version", short: "v", value: true },
    { name: "live-version" },
    { name: "seed", short: "e", value: true },
    { name: "decay", short: "d", value: true },
    { name: "status", short: "s", value: true },
    { name: "canvas", short: "c", value: true },
    { name: "rpc-url", value: true },
    { name: "force-terrain-for-daydream" },
    { name: "no-force-terrain-for-daydream" },
    { name: "mode", value: true },
    { name: "fps", value: true },
    { name: "duration", value: true },
    { name: "width", value: true },
    { name: "height", value: true },
    { name: "image-type", value: true },
    { name: "jpeg-quality", value: true },
    { name: "output-dir", short: "o", value: true },
    { name: "output", value: true },
    { name: "overwrite" },
    { name: "dry-run", short: "n" },
    { name: "show-canvas" },
    { name: "help", short: "h" },
];

const HELP = `Usage: yarn render:token <tokenId> [options]

Fetch parcel markup, capture frames, and render an MP4 without posting to X.
Defaults mirror the bot media path: renderer version 2 and terrain-for-daydream enabled.

Fetch options:
  -m, --method <tokenHTML|tokenSVG>     Renderer selector (default tokenHTML)
  -v, --version <idx>                  Renderer index (default 2)
      --live-version                   Resolve renderer index from on-chain token mapping instead
  -e, --seed <n>                       Seed (default 10196)
  -d, --decay <n>                      Decay (default 0)
  -s, --status <name>                  terrain | daydream | terraformed | origin-daydream | origin-terraformed
  -c, --canvas <decimals>              Override canvas as decimal digits, no commas/hex
      --rpc-url <url>                  JSON-RPC URL; defaults to ETH_RPC_URL or public node
      --force-terrain-for-daydream     Enable calculated terrain canvas for Daydream statuses
      --no-force-terrain-for-daydream  Disable the bot's Daydream terrain behavior

Capture options:
      --mode <streaming|buffered>      Capture mode (default streaming)
      --fps <n>                        Capture framerate (default 40)
      --duration <seconds>             Capture duration in seconds (default 15)
      --width <px>                     Viewport width (default 1200)
      --height <px>                    Viewport height (default 1732)
      --image-type <png|jpeg>          Screencast image format (default png)
      --jpeg-quality <1-100>           JPEG quality when --image-type=jpeg (default 90)

Output options:
  -o, --output-dir <dir>               Run directory (default ARTIFACTS_DIR/manual-render-<tokenId>-<timestamp>)
      --output <file>                  MP4 output path (default <output-dir>/video.mp4)
      --overwrite                      Delete an existing output-dir before writing
  -n, --dry-run                        Resolve inputs and print them without rendering
      --show-canvas                    With --dry-run, print all 16 canvas rows
  -h, --help                           Show this help
`;

async function main() {
    const parsed = parseArgs(process.argv.slice(2), FLAGS);
    if (getBooleanOption(parsed, "help")) {
        console.log(HELP);
        return;
    }

    const tokenId = requireSinglePositional(parsed, "tokenId");
    const fetchOptions = parseFetchOptions(parsed);
    const captureOptions = parseCaptureOptions(parsed);
    const imageType = parseImageType(getStringOption(parsed, "image-type"));
    const outDir = resolveOutputDir(
        tokenId,
        getStringOption(parsed, "output-dir"),
    );
    const videoOutput =
        getStringOption(parsed, "output") ?? path.join(outDir, "video.mp4");
    const input = await resolveParcelRenderInput(tokenId, fetchOptions);

    if (getBooleanOption(parsed, "dry-run")) {
        printDryRun(
            input,
            outDir,
            videoOutput,
            getBooleanOption(parsed, "show-canvas"),
        );
        return;
    }

    await prepareOutputDir(outDir, getBooleanOption(parsed, "overwrite"));

    const startTotal = Date.now();
    console.log(`Output directory: ${outDir}`);

    const markup = await renderParcelContent(input);
    const htmlPath = path.join(
        outDir,
        `token-${tokenId}.${input.method === "tokenSVG" ? "svg" : "html"}`,
    );
    await writeFile(htmlPath, markup, "utf8");
    console.log(`Markup saved to: ${htmlPath}`);

    const { framesDir, actualFps, frameCount } = await captureFrames(
        htmlPath,
        outDir,
        captureOptions,
    );
    console.log(`Frames captured: ${frameCount}`);
    console.log(`Actual FPS: ${actualFps}`);
    console.log(`Frames dir: ${framesDir}`);

    await renderVideo({
        fps: actualFps,
        outputPath: videoOutput,
        framesDir,
        imageType,
    });

    console.log(`Video saved to: ${videoOutput}`);
    console.log(`Total duration: ${Date.now() - startTotal}ms`);
}

function parseFetchOptions(
    parsed: ReturnType<typeof parseArgs>,
): ParcelFetchOptions {
    if (
        getStringOption(parsed, "version") !== undefined &&
        getBooleanOption(parsed, "live-version")
    ) {
        throw new Error("Use either --version or --live-version, not both");
    }

    const status = getStringOption(parsed, "status");
    return {
        rpcUrl: getStringOption(parsed, "rpc-url"),
        method: parseMethod(getStringOption(parsed, "method")),
        version: getBooleanOption(parsed, "live-version")
            ? undefined
            : (getStringOption(parsed, "version") ?? "2"),
        seed: parseBigIntOption("seed", getStringOption(parsed, "seed")),
        decay: parseBigIntOption("decay", getStringOption(parsed, "decay")),
        statusOverride: status ? parseParcelStatusKey(status) : undefined,
        canvasOverride: getStringOption(parsed, "canvas"),
        forceTerrainForDaydream: getBooleanOption(
            parsed,
            "no-force-terrain-for-daydream",
        )
            ? false
            : true,
    };
}

function parseCaptureOptions(
    parsed: ReturnType<typeof parseArgs>,
): FrameCaptureOptions {
    const jpegQuality = parsePositiveIntegerOption(
        "jpeg-quality",
        getStringOption(parsed, "jpeg-quality"),
    );
    if (jpegQuality !== undefined && (jpegQuality < 1 || jpegQuality > 100)) {
        throw new Error("jpeg-quality must be between 1 and 100");
    }

    const width = parsePositiveIntegerOption(
        "width",
        getStringOption(parsed, "width"),
    );
    const height = parsePositiveIntegerOption(
        "height",
        getStringOption(parsed, "height"),
    );

    return {
        mode: parseMode(getStringOption(parsed, "mode")),
        fps: parsePositiveIntegerOption("fps", getStringOption(parsed, "fps")),
        durationSeconds: parsePositiveIntegerOption(
            "duration",
            getStringOption(parsed, "duration"),
        ),
        viewport:
            width !== undefined || height !== undefined
                ? { width: width ?? 1200, height: height ?? 1732 }
                : undefined,
        imageType: parseImageType(getStringOption(parsed, "image-type")),
        jpegQuality,
    };
}

function parseMethod(
    value: string | undefined,
): ParcelRenderMethod | undefined {
    if (!value) return undefined;
    if (value === "tokenHTML" || value === "tokenSVG") return value;
    throw new Error("method must be tokenHTML or tokenSVG");
}

function parseMode(value: string | undefined): FrameCaptureOptions["mode"] {
    if (!value) return undefined;
    const normalized = value.toLowerCase();
    if (normalized === "streaming" || normalized === "buffered") {
        return normalized;
    }
    throw new Error("mode must be streaming or buffered");
}

function parseImageType(value: string | undefined): "png" | "jpeg" | undefined {
    if (!value) return undefined;
    const normalized = value.toLowerCase();
    if (normalized === "png" || normalized === "jpeg") {
        return normalized;
    }
    throw new Error("image-type must be png or jpeg");
}

function resolveOutputDir(tokenId: string, explicit?: string): string {
    if (explicit) return explicit;
    const dataDir = process.env.DATA_DIR || "./data";
    const artifactsRoot =
        process.env.ARTIFACTS_DIR || path.join(dataDir, "artifacts");
    return path.join(artifactsRoot, `manual-render-${tokenId}-${Date.now()}`);
}

async function prepareOutputDir(outDir: string, overwrite: boolean) {
    try {
        const existing = await stat(outDir);
        if (!existing.isDirectory()) {
            throw new Error(
                `Output path exists and is not a directory: ${outDir}`,
            );
        }
        if (!overwrite) {
            throw new Error(
                `Output directory already exists: ${outDir}. Use --overwrite to replace it.`,
            );
        }
        await rm(outDir, { recursive: true, force: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
        }
    }
    await mkdir(outDir, { recursive: true });
}

function printDryRun(
    input: Awaited<ReturnType<typeof resolveParcelRenderInput>>,
    outDir: string,
    videoOutput: string,
    showCanvas: boolean,
) {
    console.log("render:token dry-run:");
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
    console.log(`  output_dir      : ${outDir}`);
    console.log(`  video_output    : ${videoOutput}`);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
