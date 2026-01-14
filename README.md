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
docker run --rm -it \
  --name terraforms-bot \
  -v $(pwd)/data:/data \
  --env-file .env \
  -e DB_PATH=/data/bot.sqlite.db \
  terraforms-bot
```

The bot will create `/data/bot.sqlite.db` and start polling.

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
