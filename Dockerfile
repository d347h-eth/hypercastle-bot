# syntax=docker/dockerfile:1
FROM node:24-alpine AS base

ENV NODE_ENV=production
# Skip downloading chromium in build stage to save time/space
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Enable Corepack (Yarn 4)
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

# Add build deps for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

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

# Runtime image (still alpine)
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

# Install runtime dependencies: ffmpeg, chromium (for puppeteer)
RUN apk add --no-cache \
    ffmpeg \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

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
COPY migrations ./migrations

# Create data dir for SQLite
RUN mkdir -p /data
VOLUME ["/data"]

# Use yarn start to properly load PnP environment
CMD ["yarn", "start"]
