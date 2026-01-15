import puppeteer, { type Browser, type Page } from "puppeteer";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../../logger.js";

export type CaptureMode = "streaming" | "buffered";
export type ImageType = "png" | "jpeg";

export interface CaptureConfig {
    framerate: number;
    durationSeconds: number;
    viewport: { width: number; height: number };
    mode: CaptureMode;
    imageType: ImageType;
    jpegQuality?: number;
    navigationTimeoutMs: number;
    startupDelayMs: number;
}

export interface CaptureResult {
    framesDir: string;
    frameCount: number;
    actualFps: number;
}

const DEFAULTS = {
    captureFramerate: 40,
    captureDurationSeconds: 15,
    startupDelayMs: 50,
    navigationTimeoutMs: 20_000,
    viewport: { width: 1200, height: 1732 },
    imageType: "png" as ImageType,
    jpegQuality: 90,
};

const MODE_STREAMING: CaptureMode = "streaming";
const MODE_BUFFERED: CaptureMode = "buffered";
const MAX_STREAM_PENDING_WRITES = 8;
const HEARTBEAT_INTERVAL_MS = 20;

export interface FrameCaptureOptions {
    fps?: number;
    durationSeconds?: number;
    viewport?: { width: number; height: number };
    mode?: CaptureMode;
    imageType?: ImageType;
    jpegQuality?: number;
    navigationTimeoutMs?: number;
    startupDelayMs?: number;
}

export async function captureFrames(
    htmlPath: string,
    outDir: string,
    opts: FrameCaptureOptions = {},
): Promise<CaptureResult> {
    await ensureFile(htmlPath);
    const config: CaptureConfig = {
        framerate: opts.fps ?? DEFAULTS.captureFramerate,
        durationSeconds:
            opts.durationSeconds ?? DEFAULTS.captureDurationSeconds,
        viewport: opts.viewport ?? DEFAULTS.viewport,
        mode: opts.mode ?? MODE_STREAMING,
        imageType: opts.imageType ?? DEFAULTS.imageType,
        jpegQuality: opts.jpegQuality ?? DEFAULTS.jpegQuality,
        navigationTimeoutMs:
            opts.navigationTimeoutMs ??
            Math.max(
                DEFAULTS.navigationTimeoutMs,
                Math.ceil(
                    (opts.durationSeconds ?? DEFAULTS.captureDurationSeconds) *
                        1000,
                ) +
                    (opts.startupDelayMs ?? DEFAULTS.startupDelayMs) +
                    5000,
            ),
        startupDelayMs: opts.startupDelayMs ?? DEFAULTS.startupDelayMs,
    };

    await mkdir(outDir, { recursive: true });
    const framesDir = path.join(outDir, "frames");
    await mkdir(framesDir, { recursive: true });

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--allow-file-access-from-files",
            "--enable-local-file-accesses",
            "--disable-gpu",
            "--disable-accelerated-2d-canvas",
        ],
    });
    try {
        const page = await setupPage(browser, htmlPath, config);
        logger.info("Page loaded; starting capture", {});
        await delay(config.startupDelayMs);

        const start = Date.now();
        const { stored, actualFps, bufferedFrames } = await startScreencast(
            page,
            framesDir,
            config,
        );

        if (config.mode === MODE_BUFFERED && bufferedFrames) {
            await persistFrames(framesDir, bufferedFrames, config.imageType);
        }

        const elapsedMs = Date.now() - start;
        const stats = {
            frames: stored,
            actualFps: Number(actualFps.toFixed(2)),
            elapsedMs,
        };
        logger.info("Frame capture complete", stats);
        maybeCollectGarbage();
        return { framesDir, frameCount: stored, actualFps };
    } finally {
        await browser.close();
    }
}

async function ensureFile(filePath: string): Promise<void> {
    try {
        const stats = await stat(filePath);
        if (!stats.isFile()) {
            throw new Error(`Path is not a file: ${filePath}`);
        }
    } catch (err: any) {
        if (err?.code === "ENOENT")
            throw new Error(`HTML file not found: ${filePath}`);
        throw err;
    }
}

async function setupPage(
    browser: Browser,
    htmlPath: string,
    config: CaptureConfig,
): Promise<Page> {
    const page = await browser.newPage();
    page.on("console", (msg) => {
        logger.debug(`[page:${msg.type()}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => {
        logger.warn("[page-error]", { error: String(err) });
    });

    await page.setViewport(config.viewport);
    await page.goto(pathToFileUrl(htmlPath), {
        waitUntil: "load",
        timeout: config.navigationTimeoutMs,
    });
    await page.addStyleTag({
        content:
            "html,body,svg{width:100%;height:100%;margin:0;padding:0;overflow:hidden;}",
    });
    await page.evaluate(() => {
        const svg = document.querySelector("svg");
        if (svg) {
            svg.setAttribute("preserveAspectRatio", "xMidYMin meet");
        }
    });
    await page.evaluate((heartbeatInterval) => {
        const root = document.documentElement;
        if (!root) return;
        const w = window as any;
        if (w.__captureHeartbeatInterval) return;
        let flag = false;
        w.__captureHeartbeatInterval = window.setInterval(() => {
            flag = !flag;
            root.style.transform = flag
                ? "translateZ(0)"
                : "translateZ(0.0001px)";
        }, heartbeatInterval);
    }, HEARTBEAT_INTERVAL_MS);
    await delay(config.startupDelayMs);
    return page;
}

function pathToFileUrl(p: string): string {
    const resolved = path.resolve(p);
    const parts = resolved.split(path.sep);
    const prefix = process.platform === "win32" ? "file:///" : "file://";
    return prefix + parts.map(encodeURIComponent).join("/");
}

async function startScreencast(
    page: Page,
    framesDir: string,
    config: CaptureConfig,
): Promise<{
    stored: number;
    actualFps: number;
    bufferedFrames: Buffer[] | null;
}> {
    const client = await page.target().createCDPSession();
    const bufferFrames = config.mode === MODE_BUFFERED;
    const frameBuffers: Buffer[] | null = bufferFrames ? [] : null;
    let framesCaptured = 0;
    let framesStored = 0;
    let skippedInvalidFrames = 0;
    const frameDurations: number[] = [];

    const captureStart = Date.now();
    let lastFrameTimestamp = captureStart;
    const desiredFrameInterval = 1000 / config.framerate;
    let writeQueue = Promise.resolve();
    let pendingWrites = 0;
    const targetFrameCount = Math.round(
        config.framerate * config.durationSeconds,
    );

    await client.send("Emulation.setDeviceMetricsOverride", {
        width: config.viewport.width,
        height: config.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: config.viewport.width,
        screenHeight: config.viewport.height,
    });
    await client.send("Emulation.setVisibleSize", {
        width: config.viewport.width,
        height: config.viewport.height,
    });

    await client.send("Page.startScreencast", {
        format: config.imageType === "png" ? "png" : "jpeg",
        quality:
            config.imageType === "png"
                ? undefined
                : (config.jpegQuality ?? DEFAULTS.jpegQuality),
        everyNthFrame: 1,
        maxWidth: config.viewport.width,
        maxHeight: config.viewport.height,
    });

    const saveFrame = async (idx: number, buffer: Buffer) => {
        const name = `frame_${idx.toString().padStart(4, "0")}.${config.imageType}`;
        const targetPath = path.join(framesDir, name);
        pendingWrites += 1;
        writeQueue = writeQueue.then(async () => {
            try {
                await writeFile(targetPath, buffer);
            } finally {
                pendingWrites -= 1;
            }
        });
        if (pendingWrites >= MAX_STREAM_PENDING_WRITES) {
            await writeQueue;
        }
    };

    const frameHandler = async (event: { data: string; sessionId: number }) => {
        const now = Date.now();
        frameDurations.push(now - lastFrameTimestamp);
        lastFrameTimestamp = now;

        const elapsed = now - captureStart;
        const expectedStoredFrames = Math.floor(elapsed / desiredFrameInterval);

        if (
            framesStored < targetFrameCount &&
            expectedStoredFrames > framesStored
        ) {
            const buffer = Buffer.from(event.data, "base64");
            if (!frameMatchesViewport(buffer, config)) {
                skippedInvalidFrames += 1;
            } else if (bufferFrames && frameBuffers) {
                frameBuffers.push(buffer);
                framesStored += 1;
            } else {
                await saveFrame(framesStored, buffer);
                framesStored += 1;
            }
        }

        framesCaptured += 1;
        await client.send("Page.screencastFrameAck", {
            sessionId: event.sessionId,
        });
    };

    const listener = (ev: { data: string; sessionId: number }) => {
        frameHandler(ev).catch((err) =>
            logger.warn("capture frame error", { error: String(err) }),
        );
    };
    client.on("Page.screencastFrame", listener);

    while (framesStored < targetFrameCount) {
        await delay(5);
    }

    await client.send("Page.stopScreencast");
    client.off("Page.screencastFrame", listener);
    if (!bufferFrames) {
        await writeQueue;
    }

    const elapsedMs = Date.now() - captureStart;
    const actualFps = framesStored / (elapsedMs / 1000);
    logCaptureStats(
        framesStored,
        framesCaptured,
        skippedInvalidFrames,
        frameDurations,
        elapsedMs,
    );

    return { stored: framesStored, actualFps, bufferedFrames: frameBuffers };
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistFrames(
    runDir: string,
    frameBuffers: Buffer[],
    imageType: ImageType,
): Promise<void> {
    for (let i = 0; i < frameBuffers.length; i += 1) {
        const fileName = `frame_${i.toString().padStart(4, "0")}.${imageType}`;
        const filePath = path.join(runDir, fileName);
        await writeFile(filePath, frameBuffers[i]);
        frameBuffers[i] = Buffer.alloc(0);
    }
    frameBuffers.length = 0;
}

function logCaptureStats(
    framesStored: number,
    framesCaptured: number,
    skippedInvalidFrames: number,
    frameDurations: number[],
    elapsedMs: number,
): void {
    const actualFps = framesStored / (elapsedMs / 1000);
    const sorted = [...frameDurations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const max = Math.max(...frameDurations, 0);
    const min = Math.min(...frameDurations, 0);
    logger.info("Screencast stats", {
        framesStored,
        framesCaptured,
        skippedInvalidFrames,
        elapsedMs,
        actualFps: Number(actualFps.toFixed(2)),
        frameIntervals: { min, median, max },
    });
}

let gcWarned = false;
function maybeCollectGarbage() {
    if (typeof global.gc === "function") {
        global.gc();
    } else if (!gcWarned) {
        gcWarned = true;
    }
}

function frameMatchesViewport(buffer: Buffer, config: CaptureConfig): boolean {
    if (config.imageType === "png") {
        if (buffer.length < 24) return false;
        const signature = buffer.readUInt32BE(0);
        if (signature !== 0x89504e47) return false;
        const chunkType = buffer.toString("ascii", 12, 16);
        if (chunkType !== "IHDR") return false;
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        return (
            width === config.viewport.width && height === config.viewport.height
        );
    }
    return true;
}
