import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { logger } from "../../logger.js";

export interface RenderOptions {
    fps: number;
    outputPath: string;
    framesDir: string;
    imageType?: "png" | "jpeg";
}

export async function renderVideo(
    opts: RenderOptions,
): Promise<{ videoPath: string }>;
export async function renderVideo(
    opts: RenderOptions,
): Promise<{ videoPath: string }> {
    const imageType = opts.imageType ?? "png";
    const pattern = path.join(opts.framesDir, `frame_%04d.${imageType}`);
    const outPath = path.resolve(opts.outputPath);
    await mkdir(path.dirname(outPath), { recursive: true });

    const args = [
        "-framerate",
        String(opts.fps),
        "-i",
        pattern,
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "slow",
        "-crf",
        "18",
        "-b:v",
        "5000k",
        "-maxrate",
        "5000k",
        "-bufsize",
        "10000k",
        "-r",
        String(opts.fps),
        "-an",
        "-movflags",
        "+faststart",
        "-y",
        outPath,
    ];

    await runFfmpeg(args);
    return { videoPath: outPath };
}

async function runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn("ffmpeg", args, {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("close", (code) => {
            if (code === 0) {
                logger.info("ffmpeg finished", {});
                return resolve();
            }
            reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        });
        child.on("error", (err) => reject(err));
    });
}
