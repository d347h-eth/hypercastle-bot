import { fetchParcelHtml } from "../src/infra/onchain/parcelFetcher.js";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error(
            "Usage: npx tsx scripts/test-fetch.ts <tokenId> [statusOverride]",
        );
        console.error("Example: npx tsx scripts/test-fetch.ts 1 daydream");
        process.exit(1);
    }

    const tokenId = args[0];
    const statusOverride = args[1] as any; // "daydream" | "terrain" | etc.

    console.log(`Fetching parcel for Token ID: ${tokenId}`);
    if (statusOverride) {
        console.log(`Override Status: ${statusOverride}`);
    }

    try {
        const start = Date.now();
        const result = await fetchParcelHtml(tokenId, {
            statusOverride: statusOverride,
            // You can also test canvasOverride if needed, but we want to test the logic where it's missing
        });
        const duration = Date.now() - start;

        console.log("---------------------------------------------------");
        console.log("✅ Success!");
        console.log(`⏱️  Duration: ${duration}ms`);
        console.log(`📄 HTML Path: ${result.filePath}`);
        console.log("---------------------------------------------------");
    } catch (error) {
        console.error("❌ Failed to fetch parcel:");
        console.error(error);
        process.exit(1);
    }
}

main();
