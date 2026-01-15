# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base

ENV NODE_ENV=production
ENV PUPPETEER_CACHE_DIR=/app/.cache

# Enable Corepack (Yarn 4)
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

# Add build deps for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only package manifests and Yarn config first for better caching
COPY package.json yarn.lock tsconfig.json tsconfig.build.json .yarnrc.yml ./

# Install deps (PnP)
# Disable global cache so packages are stored locally in .yarn/cache and copied to runtime
ENV YARN_ENABLE_GLOBAL_CACHE=false
RUN yarn install --immutable

# Copy source and migrations
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations

# Build TypeScript
RUN yarn build

# Runtime image
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PUPPETEER_CACHE_DIR=/app/.cache

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

# Install runtime dependencies: ffmpeg + Puppeteer/Chrome deps
# See: https://pptr.dev/troubleshooting#chrome-doesnt-launch-on-linux
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only the necessary runtime files
COPY --from=base /app/.yarnrc.yml ./
COPY --from=base /app/.pnp.cjs /app/.pnp.cjs
COPY --from=base /app/.pnp.loader.mjs /app/.pnp.loader.mjs
COPY --from=base /app/.yarn /app/.yarn
COPY --from=base /app/package.json ./package.json
COPY --from=base /app/yarn.lock ./yarn.lock
COPY --from=base /app/dist ./dist
COPY --from=base /app/src ./src
COPY --from=base /app/scripts ./scripts
COPY --from=base /app/.cache ./.cache
COPY migrations ./migrations

# Create data dir for SQLite
RUN mkdir -p /data
VOLUME ["/data"]

# Use yarn start to properly load PnP environment
CMD ["yarn", "start"]
