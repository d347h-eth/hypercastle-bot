# syntax=docker/dockerfile:1
FROM node:24-alpine AS base

ENV NODE_ENV=production

# Enable Corepack (Yarn 4)
RUN corepack enable && corepack prepare yarn@4.9.4 --activate

# Add build deps for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy only package manifests and Yarn config first for better caching
COPY package.json tsconfig.json tsconfig.build.json .yarnrc.yml ./

# Install deps (PnP)
RUN yarn install --immutable

# Copy source and migrations
COPY src ./src
COPY migrations ./migrations
COPY .env ./.env

# Build TypeScript
RUN yarn build

# Runtime image (still alpine)
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
RUN corepack enable && corepack prepare yarn@4.9.4 --activate
WORKDIR /app

# Copy only the necessary runtime files
COPY --from=base /app/.yarnrc.yml ./
COPY --from=base /app/.pnp.cjs /app/.pnp.cjs
COPY --from=base /app/.pnp.loader.mjs /app/.pnp.loader.mjs
COPY --from=base /app/.yarn /app/.yarn
COPY --from=base /app/package.json ./package.json
COPY --from=base /app/dist ./dist
COPY migrations ./migrations

# Create data dir for SQLite
RUN mkdir -p /data
VOLUME ["/data"]

# Default envs
ENV DB_PATH=/data/bot.sqlite.db

CMD ["node", "dist/index.js"]

