import path from "node:path";
import { rm } from "node:fs/promises";
import { Sale } from "../domain/models.js";
import { QueuedSale, SaleRepository } from "../domain/ports/saleRepository.js";
import { SocialPublisher } from "../domain/ports/socialPublisher.js";
import { RateLimitExceededError } from "../domain/errors.js";
import {
    ParcelFetchOptions,
    fetchParcelHtml,
} from "../infra/onchain/parcelFetcher.js";
import { captureFrames } from "../infra/capture/frameCapture.js";
import { renderVideo } from "../infra/capture/videoRenderer.js";
import {
    fetchTokenAttributes,
    formatEnrichedText,
} from "../infra/http/tokenMetadata.js";
import { formatPrice } from "./tweetFormatter.js";
import { logger } from "../logger.js";
import { toIso } from "../util/time.js";

export interface WorkflowDeps {
    repo: SaleRepository;
    publisher: SocialPublisher;
}

export interface WorkflowConfig {
    artifactsRoot?: string;
}

export class PostingWorkflow {
    constructor(
        private readonly deps: WorkflowDeps,
        private readonly config: WorkflowConfig,
    ) {}

    async process(queued: QueuedSale): Promise<"posted" | "deferred"> {
        const sale = queued.sale;
        const root = this.artifactRoot(sale.id);

        try {
            // 1) HTML
            const htmlPath = await this.ensureHtml(
                sale,
                root,
                queued.artifacts?.htmlPath,
            );
            // 2) Frames
            const frameResult = await this.ensureFrames(
                sale,
                root,
                htmlPath,
                queued.artifacts?.framesDir,
            );
            // 3) Video
            const videoPath = await this.ensureVideo(
                sale,
                root,
                frameResult.framesDir,
                frameResult.actualFps,
                queued.artifacts?.videoPath,
                queued.artifacts?.metadataJson,
                queued.artifacts?.captureFps ?? undefined,
            );
            // 4) Metadata
            const attrsJson = await this.ensureMetadata(
                sale,
                queued.artifacts?.metadataJson,
            );
            const attrs = attrsJson ? JSON.parse(attrsJson) : {};
            const text = formatEnrichedText(
                "", // base is ignored; we build full text here
                attrs,
                sale.tokenId,
                sale.name,
                formatPrice(sale.price.amount),
                sale.price.symbol,
                sale.orderSide,
            );
            // 5) Upload media
            const mediaId = await this.ensureMediaUpload(
                sale,
                videoPath,
                queued.artifacts?.mediaId,
                queued.artifacts?.mediaUploadedAt ?? undefined,
            );
            // 6) Post
            const tweet = await this.deps.publisher.post(text.trim(), [
                mediaId,
            ]);
            this.deps.repo.markPosted(sale.id, tweet.id, tweet.text, now());
            logger.info("Sale posted", {
                component: "PostingWorkflow",
                action: "process",
                saleId: sale.id,
                tweetId: tweet.id,
                mediaId,
            });
            // await this.cleanupArtifacts(root);
            return "posted";
        } catch (e) {
            // Defer rate-limit and transient handling to the caller so we can schedule
            // retries based on response headers/reset windows.
            throw e;
        }
    }

    private artifactRoot(saleId: string): string {
        return path.join("data", "artifacts", saleId);
    }

    private async ensureHtml(
        sale: Sale,
        root: string,
        existing?: string | null,
    ): Promise<string> {
        if (existing) return existing;
        this.deps.repo.updateStatus(sale.id, "fetching_html");
        const { filePath } = await fetchParcelHtml(sale.tokenId, {
            outputDir: root,
            version: 2n,
        } as ParcelFetchOptions);
        this.deps.repo.setHtmlPath(sale.id, filePath);
        return filePath;
    }

    private async ensureFrames(
        sale: Sale,
        root: string,
        htmlPath: string,
        existing?: string | null,
    ): Promise<{ framesDir: string; actualFps: number }> {
        if (existing) return { framesDir: existing, actualFps: 40 };
        this.deps.repo.updateStatus(sale.id, "capturing_frames");
        const { framesDir, actualFps } = await captureFrames(
            htmlPath,
            root,
            {},
        );
        this.deps.repo.setFramesDir(sale.id, framesDir);
        this.deps.repo.setCaptureFps(sale.id, actualFps);
        return { framesDir, actualFps };
    }

    private async ensureVideo(
        sale: Sale,
        root: string,
        framesDir: string,
        fps: number,
        existing?: string | null,
        metadataJson?: string | null,
        storedFps?: number,
    ): Promise<string> {
        if (existing) return existing;
        this.deps.repo.updateStatus(sale.id, "rendering_video");
        const outPath = path.join(root, "video.mp4");
        await renderVideo({
            fps: storedFps ?? fps,
            outputPath: outPath,
            framesDir,
        });
        this.deps.repo.setVideoPath(sale.id, outPath);
        return outPath;
    }

    private async ensureMetadata(
        sale: Sale,
        existingJson?: string | null,
    ): Promise<string> {
        if (existingJson) return existingJson;
        const attrs = await fetchTokenAttributes(sale.tokenId);
        const json = JSON.stringify(attrs);
        this.deps.repo.setMetadataJson(sale.id, json);
        return json;
    }

    private async ensureMediaUpload(
        sale: Sale,
        videoPath: string,
        existing?: string | null,
        uploadedAt?: number | null,
    ): Promise<string> {
        const expiresAt = uploadedAt ? uploadedAt + 24 * 3600 : null;
        if (existing && expiresAt && now() < expiresAt) {
            logger.debug("Reusing fresh media upload", {
                component: "PostingWorkflow",
                action: "ensureMediaUpload",
                saleId: sale.id,
                mediaId: existing,
                uploadedAt,
                uploadedAtIso: toIso(uploadedAt),
                expiresAt,
                expiresAtIso: expiresAt ? toIso(expiresAt) : undefined,
            });
            return existing;
        }
        if (existing) {
            // Expired or missing timestamp; clear to force fresh upload.
            this.deps.repo.clearMediaUpload(sale.id);
            logger.info("Media upload expired; reuploading", {
                component: "PostingWorkflow",
                action: "ensureMediaUpload",
                saleId: sale.id,
                mediaId: existing,
                uploadedAt,
                uploadedAtIso: toIso(uploadedAt ?? undefined),
                expiresAt,
                expiresAtIso: expiresAt ? toIso(expiresAt) : undefined,
            });
        }
        this.deps.repo.updateStatus(sale.id, "uploading_media");
        const mediaId = await this.deps.publisher.uploadMedia(
            videoPath,
            "video/mp4",
        );
        const uploadedAtTs = now();
        this.deps.repo.setMediaId(sale.id, mediaId, uploadedAtTs);
        logger.info("Media uploaded", {
            component: "PostingWorkflow",
            action: "ensureMediaUpload",
            saleId: sale.id,
            mediaId,
            uploadedAt: uploadedAtTs,
            uploadedAtIso: toIso(uploadedAtTs),
        });
        return mediaId;
    }

    private async cleanupArtifacts(root: string): Promise<void> {
        try {
            await rm(root, { recursive: true, force: true });
        } catch (e) {
            logger.warn("Failed to cleanup artifacts", {
                error: String(e),
                root,
            });
        }
    }
}

function now(): number {
    return Math.floor(Date.now() / 1000);
}
