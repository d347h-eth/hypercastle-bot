import { fetchParcelHtml, ParcelFetchOptions } from "../src/infra/onchain/parcelFetcher.js";
import { captureFrames } from "../src/infra/capture/frameCapture.js";
import { renderVideo } from "../src/infra/capture/videoRenderer.js";
import dotenv from "dotenv";
import path from "path";
import { rm } from "node:fs/promises";

dotenv.config();

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error("Usage: yarn tsx scripts/test-render.ts <tokenId>");
        process.exit(1);
    }

    const tokenId = args[0];
    const dataDir = process.env.DATA_DIR || "./data";
    const artifactsRoot = process.env.ARTIFACTS_DIR || path.join(dataDir, "artifacts");
    const outDir = path.join(artifactsRoot, `test-render-${tokenId}`);

    console.log(`Starting render test for Token ID: ${tokenId}`);
    console.log(`Output directory: ${outDir}`);

    try {
        // Cleanup previous run if exists
        await rm(outDir, { recursive: true, force: true });

        const startTotal = Date.now();

        // 1. Fetch HTML
        console.log("\n1. Fetching HTML...");
        const startHtml = Date.now();
        // Enable forceTerrainForDaydream to mirror production behavior
        const { filePath: htmlPath } = await fetchParcelHtml(tokenId, {
            outputDir: outDir,
            version: 2n,
            forceTerrainForDaydream: true,
        } as ParcelFetchOptions);
        console.log(`   HTML saved to: ${htmlPath}`);
        console.log(`   Time: ${Date.now() - startHtml}ms`);

        // 2. Capture Frames
        console.log("\n2. Capturing Frames (Puppeteer)...");
        const startCapture = Date.now();
        const { framesDir, actualFps, frameCount } = await captureFrames(htmlPath, outDir, {
            // Use defaults or tweak here if needed
        });
        console.log(`   Frames captured: ${frameCount}`);
        console.log(`   Actual FPS: ${actualFps}`);
        console.log(`   Frames dir: ${framesDir}`);
        console.log(`   Time: ${Date.now() - startCapture}ms`);

        // 3. Render Video
        console.log("\n3. Rendering Video (FFmpeg)...");
        const startRender = Date.now();
        const videoOutputPath = path.join(outDir, "video.mp4");
        await renderVideo({
            fps: actualFps,
            outputPath: videoOutputPath,
            framesDir: framesDir,
        });
        console.log(`   Video saved to: ${videoOutputPath}`);
        console.log(`   Time: ${Date.now() - startRender}ms`);

        console.log("\n---------------------------------------------------");
        console.log("✅ Render Test Complete!");
        console.log(`⏱️  Total Duration: ${Date.now() - startTotal}ms`);
        console.log(`📹 Final FPS: ${actualFps}`);
        console.log("---------------------------------------------------");

    } catch (error) {
        console.error("\n❌ Render Test Failed:");
        console.error(error);
        process.exit(1);
    }
}

main();
