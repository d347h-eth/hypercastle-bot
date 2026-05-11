import dotenv from "dotenv";
import path from "node:path";
import {
    captureFrames,
    type FrameCaptureOptions,
} from "../src/infra/capture/frameCapture.js";
import { renderVideo } from "../src/infra/capture/videoRenderer.js";
import {
    getStringOption,
    parseArgs,
    parsePositiveIntegerOption,
    requireSinglePositional,
    type FlagSpec,
} from "./lib/cli.js";

dotenv.config();

const FLAGS: FlagSpec[] = [
    { name: "mode", short: "m", value: true },
    { name: "fps", value: true },
    { name: "duration", value: true },
    { name: "width", value: true },
    { name: "height", value: true },
    { name: "image-type", value: true },
    { name: "jpeg-quality", value: true },
    { name: "output-dir", short: "o", value: true },
    { name: "output", value: true },
    { name: "help", short: "h" },
];

const HELP = `Usage: yarn capture:html <htmlPath> [options]

Capture a standalone local HTML/SVG file into an MP4 using Puppeteer screencast + ffmpeg.

Options:
  -m, --mode <streaming|buffered>  Capture mode (default streaming)
      --fps <n>                    Capture framerate (default 40)
      --duration <seconds>         Capture duration in seconds (default 15)
      --width <px>                 Viewport width (default 1200)
      --height <px>                Viewport height (default 1732)
      --image-type <png|jpeg>      Screencast image format (default png)
      --jpeg-quality <1-100>       JPEG quality when --image-type=jpeg (default 90)
  -o, --output-dir <dir>           Run directory (default tmp/capture_<timestamp>)
      --output <file>              MP4 output path (default <output-dir>/capture.mp4)
  -h, --help                       Show this help
`;

async function main() {
    const parsed = parseArgs(process.argv.slice(2), FLAGS);
    if (parsed.options.help) {
        console.log(HELP);
        return;
    }

    const htmlPath = requireSinglePositional(parsed, "htmlPath");
    const outDir =
        getStringOption(parsed, "output-dir") ??
        path.join("tmp", `capture_${Date.now()}`);
    const imageType = parseImageType(getStringOption(parsed, "image-type"));
    const captureOptions = parseCaptureOptions(parsed);
    const outputPath =
        getStringOption(parsed, "output") ?? path.join(outDir, "capture.mp4");

    const start = Date.now();
    const { framesDir, actualFps, frameCount } = await captureFrames(
        htmlPath,
        outDir,
        captureOptions,
    );
    await renderVideo({
        fps: actualFps,
        outputPath,
        framesDir,
        imageType,
    });

    console.log(`Frames captured: ${frameCount}`);
    console.log(`Actual FPS: ${actualFps}`);
    console.log(`Frames dir: ${framesDir}`);
    console.log(`MP4 file: ${outputPath}`);
    console.log(`Duration: ${Date.now() - start}ms`);
}

function parseCaptureOptions(
    parsed: ReturnType<typeof parseArgs>,
): FrameCaptureOptions {
    const imageType = parseImageType(getStringOption(parsed, "image-type"));
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
        imageType,
        jpegQuality,
    };
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

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
