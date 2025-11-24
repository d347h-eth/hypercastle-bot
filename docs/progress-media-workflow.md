# Media Posting Workflow — Progress Log

Goal: Enrich posting pipeline with video generation and metadata enrichment, with fault-tolerant state transitions per sale. This log tracks decisions, steps, and status as we build it.

## Checklist / Tasks

-   [x] Align DB schema with new states and persisted artifacts (files, media_id, capture_fps).
-   [x] Port HTML fetcher (getparcel) from terraforms/main (force version 2, keep full options) as adapter (src/infra/onchain/parcelFetcher.ts).
-   [x] Port frame capture (puppeteer) and video render (ffmpeg) from video_capture, split into reusable services (src/infra/capture/frameCapture.ts, src/infra/capture/videoRenderer.ts).
-   [x] Add Reservoir token metadata fetch (attributes: Mode, Chroma, Zone, Biome, Antenna) (src/infra/http/tokenMetadata.ts).
-   [x] Implement stateful workflow steps with recovery per sale:
    -   fetch_html -> capture_frames -> render_video -> fetch_metadata -> upload_media -> post_tweet
-   [x] Persist file paths + media_id + capture_fps + metadata_json per sale for recovery; rerun idempotent steps when missing artifacts.
-   [x] Wire SocialPublisher to include media_ids when present (real X) while keeping Fake publisher behavior sane.
-   [x] Update docs/diagrams and tests for new workflow.

## Notes / Decisions

-   Use hexagonal approach: domain workflow orchestrates adapters for HTML fetch, capture, render, metadata, upload, post.
-   File storage: namespace by sale_id under `data/artifacts/<sale_id>/` with subpaths for html, frames, video.
-   Recovery rules:
    -   If artifact exists, skip to next step; if missing/corrupted, re-run step.
    -   media upload step is considered successful only after media_id persisted to DB.
-   Default to FakeSocialPublisher for local QA; keep code paths ready for TwitterPublisher.
