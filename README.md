# Terraforms Bot

Small resilient bot that polls a private sales feed API and posts new sales to X (Twitter). It persists state in SQLite to ensure crash recovery and rate-limit aware posting.

Highlights:

-   TypeScript + Node.js (ESM, Yarn 4 PnP)
-   SQLite via better-sqlite3 with simple SQL migrations
-   Daily rate-limit window with queue buffering
-   First-run bootstrap: ingests current feed without posting
-   Optional timeline verification (1 req / 15min) for crash recovery
-   Media pipeline: on-chain HTML fetch → screencast frame capture (Puppeteer) → video render (ffmpeg) → token metadata enrichment → X media upload + post; artifacts persisted per sale for recovery and cleaned after posting

## Quick Start

1. Copy `.env.example` to `.env` and fill values.

2. Build + run with Docker:

```sh
docker build -t terraforms-bot .
docker run -d \
  --name terraforms-bot \
  -v $(pwd)/data:/data \
  --env-file .env \
  -e DATA_DIR=/data \
  terraforms-bot
```

The bot will use `/data` for:

-   Database: `/data/bot.sqlite.db`
-   Artifacts: `/data/artifacts/`

The bot will create `/data/bot.sqlite.db` and start polling.

## Docker Script Commands

The Docker image is also the preferred environment for manual scripts because it contains the same pinned Node/Yarn toolchain, Puppeteer setup, Google Chrome, fonts, ffmpeg, migrations, and `scripts/` files used by production.

Build the image first:

```sh
docker build -t terraforms-bot .
```

If the bot container is already running, execute package scripts inside it. Paths passed to scripts must exist inside the container, so prefer `/data/...` for generated artifacts because the normal run command mounts host `./data` there.

### Parcel Fetching

`fetch:parcel` is the in-repo replacement for the old `scripts/getparcel` helper. It supports the same core controls: `--method tokenHTML|tokenSVG`, `--version`, `--seed`, `--decay`, `--status`, `--canvas`, `--output`, `--dry-run`, `--show-canvas`, and `--rpc-url`.

```sh
# Resolve current on-chain inputs without rendering.
docker exec -it terraforms-bot yarn fetch:parcel <tokenId> --dry-run

# Fetch a specific renderer/status/canvas to a mounted artifact path.
docker exec -it terraforms-bot yarn fetch:parcel <tokenId> \
  --version 2 \
  --status terraformed \
  --canvas "<decimal-canvas>" \
  --output /data/artifacts/manual/token-<tokenId>.html

# Fetch SVG instead of HTML.
docker exec -it terraforms-bot yarn fetch:parcel <tokenId> \
  --method tokenSVG \
  --output /data/artifacts/manual/token-<tokenId>.svg
```

### HTML Capture

`capture:html` is the in-repo replacement for the old `scripts/video_capture` helper. It captures a local container-visible HTML/SVG file to MP4 and supports `--mode streaming|buffered`, `--fps`, `--duration`, `--width`, `--height`, `--image-type png|jpeg`, and `--jpeg-quality`.

```sh
docker exec -it terraforms-bot yarn capture:html /data/artifacts/manual/token-<tokenId>.html \
  --fps 40 \
  --duration 15 \
  --output-dir /data/artifacts/manual/capture-<tokenId>
```

### HTML Dissection

`dissect:html` splits a generated Terraforms HTML/SVG artwork into persisted artifacts and writes a runtime report explaining token constants, grid state, charset selection, `uni` / `String.fromCharCode()` ranges, embedded font coverage, and the active animation branch.

```sh
docker exec -it terraforms-bot yarn dissect:html /data/artifacts/manual/token-<tokenId>.html \
  --output-dir /data/artifacts/manual/token-<tokenId>-dissect
```

The output directory includes:

-   `report.md` — human-readable dissection report
-   `summary.json` — extraction summary
-   `runtime-charsets.json` — structured charset and animation derivation
-   `uni-fromcharcode-map.tsv` — each `uni` entry mapped to the actual `fromCharCode()` output range
-   `font-coverage.tsv` — runtime character to embedded-font/fallback mapping
-   `script-*.decoded.js` and `script-*.decoded.readable-no-font.js` — entity-decoded JS
-   `style-*.css`, extracted fonts, and initial grid dumps

### Token Video Render

`render:token` combines parcel fetch + frame capture + ffmpeg render without posting to X. Defaults mirror the bot media path: renderer `--version 2` and calculated terrain canvas for Daydream statuses. Use `--live-version` and `--no-force-terrain-for-daydream` if you want raw `getparcel`-style behavior instead.

```sh
docker exec -it terraforms-bot yarn render:token <tokenId>

docker exec -it terraforms-bot yarn render:token <tokenId> \
  --status daydream \
  --fps 90 \
  --duration 60 \
  --output-dir /data/artifacts/manual-render-<tokenId> \
  --overwrite
```

### Host-Owned Manual Artifacts

Manual scripts write into the host `./data` bind mount through `/data`. By default the container runs as root, so generated files may be root-owned on the host. For manual artifact commands, run the command as your host UID/GID and set `HOME=/tmp` so Yarn/Puppeteer do not try to write under `/root`.

```sh
mkdir -p ./data/artifacts/manual/capture-<tokenId>

docker exec -it \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  terraforms-bot \
  yarn capture:html /data/artifacts/manual/token-<tokenId>.html \
    --fps 40 \
    --duration 15 \
    --output-dir /data/artifacts/manual/capture-<tokenId>
```

The same ownership pattern works for one-off containers:

```sh
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -v "$(pwd)/data:/data" \
  --env-file .env \
  -e DATA_DIR=/data \
  terraforms-bot \
  yarn capture:html /data/artifacts/manual/token-<tokenId>.html \
    --fps 40 \
    --duration 15 \
    --output-dir /data/artifacts/manual/capture-<tokenId>
```

If a directory already contains root-owned files from earlier runs, fix it once on the host:

```sh
sudo chown -R "$(id -u):$(id -g)" ./data/artifacts/manual/capture-<tokenId>
```

### X Operations

```sh
# Re-render and repost the latest posted sale for a token.
docker exec -it terraforms-bot yarn repost:token <tokenId>

# Re-render and repost a specific sale, while cross-checking tokenId.
docker exec -it terraforms-bot yarn repost:token <tokenId> --sale-id <saleId>

# Dry-run repost through FakeSocialPublisher. This still renders/uploads locally,
# but does not call X to create a post.
docker exec -it terraforms-bot yarn repost:token <tokenId> --fake

# Delete an X post owned by the authenticated account.
# This does not modify local SQLite rows.
docker exec -it terraforms-bot yarn delete:tweet <tweetId>
```

If the bot container is not running, run the same commands as one-off containers. Mount the same `data/` directory so SQLite state and artifacts are shared with normal bot runs:

```sh
docker run --rm -it \
  -v "$(pwd)/data:/data" \
  --env-file .env \
  -e DATA_DIR=/data \
  terraforms-bot \
  yarn repost:token <tokenId>

docker run --rm -it \
  -v "$(pwd)/data:/data" \
  --env-file .env \
  -e DATA_DIR=/data \
  terraforms-bot \
  yarn delete:tweet <tweetId>

docker run --rm -it \
  -v "$(pwd)/data:/data" \
  --env-file .env \
  -e DATA_DIR=/data \
  terraforms-bot \
  yarn render:token <tokenId>

docker run --rm -it \
  -v "$(pwd)/data:/data" \
  --env-file .env \
  -e DATA_DIR=/data \
  terraforms-bot \
  yarn fetch:parcel <tokenId> --dry-run

docker run --rm -it \
  -v "$(pwd)/data:/data" \
  --env-file .env \
  -e DATA_DIR=/data \
  terraforms-bot \
  yarn capture:html /data/artifacts/manual/token-<tokenId>.html

docker run --rm -it \
  -v "$(pwd)/data:/data" \
  --env-file .env \
  -e DATA_DIR=/data \
  terraforms-bot \
  yarn dissect:html /data/artifacts/manual/token-<tokenId>.html \
    --output-dir /data/artifacts/manual/token-<tokenId>-dissect
```

For a bad video repost, delete the old X post first, then run `repost:token`. The repost script inserts a separate `manual-repost-*` row and keeps the original sale record intact.

## Configuration

Environment variables are documented in `.env.example`.

Important:

-   Provide `SALES_API_BASE_URL` (base only; `/sales/v6` is appended) and `SALES_COLLECTION_ADDRESS` (contract address) — used with `/sales/v6?collection=...&sortBy=time&sortDirection=desc`.
-   **Rate limits:** The bot strictly respects `x-rate-limit-*` headers from the X API. It tracks `reset` and `remaining` allowances, enforcing a reserved slot (never uses the 17th request of the free tier) to avoid hard bans. If headers are missing (e.g., transient network issues), it employs a self-healing "dead reckoning" fallback that synthetically spaces out retries (~1.4h) until the limit resets.
-   **Tweet Format:** Tweets are automatically formatted with enriched token metadata (Mode, Chroma, Zone, Biome, Antenna) fetched from Reservoir.
-   Set `USE_FAKE_PUBLISHER=true` to log locally instead of posting to X; default uses the real X publisher (requires creds).
-   For verbose troubleshooting (including raw X rate headers per call), set `DEBUG_VERBOSE=true`

Notes:

-   OAuth 1.0a user tokens (X_APP_KEY/SECRET + X_ACCESS_TOKEN/SECRET) are the simplest for posting.
-   For timeline verification, provide either `X_USER_ID` or `X_USERNAME`.

## Development

Requirements:

-   Node.js 24+
-   Yarn 4+
-   **FFmpeg** (must be in PATH for video rendering)

```sh
yarn
yarn dev
```

### IDE Setup (VSCode)

This project uses Yarn 4 PnP. To ensure VSCode correctly resolves imports and dependencies:

```sh
yarn dlx @yarnpkg/sdks vscode
```

This generates the necessary configuration in `.vscode/` and `.yarn/sdks/`.

## Project Layout

-   `src/` — application code
-   `migrations/` — SQLite schema migrations (auto-run on startup)
-   `data/` — local SQLite DB (gitignored; mounted as volume in Docker)

### Architecture

-   Application: `src/application/*` orchestrates polling/recovery; `src/application/workflow.ts` runs the media pipeline.
-   Domain: `src/domain/*` holds core types and ports (interfaces).
-   Infra (adapters): HTTP feed (`src/infra/http/*`), on-chain fetcher (`src/infra/onchain/*`), capture/render (`src/infra/capture/*`), SQLite repo + rate limiter (`src/infra/sqlite/*`), Twitter (`src/infra/twitter/*`), Fake publisher (`src/infra/social/*`).

## Notes

-   The sales feed adapter in `src/infra/http/reservoirSalesFeed.ts` is intentionally simple. Update the mapping to match your feed if it changes.
-   Recovery matches by `tokenId + price + symbol + take-{orderSide}`.
