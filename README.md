# Terraforms Bot

Small resilient bot that polls a private sales feed API and posts new sales to X (Twitter). It persists state in SQLite to ensure crash recovery and rate-limit aware posting.

Highlights:
- TypeScript + Node.js (ESM, Yarn 4 PnP)
- SQLite via better-sqlite3 with simple SQL migrations
- Daily rate-limit window with queue buffering
- First-run bootstrap: ingests current feed without posting
- Optional timeline verification (1 req / 15min) for crash recovery

## Quick Start

1) Copy `.env.example` to `.env` and fill values.

2) Build + run with Docker:

```sh
docker build -t terraforms-bot .
docker run --rm -it \
  --name terraforms-bot \
  -v $(pwd)/data:/data \
  --env-file .env \
  terraforms-bot
```

The bot will create `/data/bot.sqlite.db` and start polling.

## Configuration

Environment variables are documented in `.env.example`.

Notes:
- OAuth 1.0a user tokens (X_APP_KEY/SECRET + X_ACCESS_TOKEN/SECRET) are the simplest for posting.
- `RATE_LIMIT_MAX_PER_DAY` is enforced locally; set to your X free-tier daily allowance.
- `RATE_LIMIT_RESET_HOUR_UTC` controls when the daily window resets (default 00:00 UTC).
- For timeline verification, provide either `X_USER_ID` or `X_USERNAME`.

## Development

```sh
yarn
yarn dev
```

## Project Layout

- `src/` — application code
- `migrations/` — SQLite schema migrations (auto-run on startup)
- `data/` — local SQLite DB (gitignored; mounted as volume in Docker)

## Notes

- The sales feed adapter in `src/services/salesFeed.ts` is intentionally simple. Update the mapping to match your feed (unique sale ID, timestamps, fields for templating).
- By default, the tweet text includes the sale ID marker (e.g., `sale:abc123`) to support idempotency checks during crash recovery.

