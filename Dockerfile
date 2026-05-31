# nanoclaw — production container for GCP Compute Engine deployment.
#
# Multi-stage:
#   1. builder: install pnpm + native deps, compile TypeScript
#   2. runtime: minimal Debian slim + ffmpeg (for @discordjs/voice) + Node 22
#
# Run: docker run --rm -it --env-file .env nanoclaw:latest
# Build: docker build -t nanoclaw:latest .

ARG NODE_VERSION=22

# ---------- builder ----------
FROM node:${NODE_VERSION}-bookworm AS builder

WORKDIR /app

# pnpm via corepack (matches package.json packageManager pin)
RUN corepack enable

# Native build deps for better-sqlite3
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY container ./container
COPY scripts ./scripts
COPY setup ./setup

RUN pnpm run build

# Prune dev deps for a smaller runtime image
RUN pnpm prune --prod

# ---------- runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# ffmpeg: required by @discordjs/voice for opus encoding/decoding
# ca-certificates: for outbound HTTPS to OpenAI / Discord / GitHub
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Non-root user
RUN groupadd -r nanoclaw && useradd -r -g nanoclaw -m -d /home/nanoclaw nanoclaw

COPY --from=builder --chown=nanoclaw:nanoclaw /app/node_modules ./node_modules
COPY --from=builder --chown=nanoclaw:nanoclaw /app/dist ./dist
COPY --from=builder --chown=nanoclaw:nanoclaw /app/package.json ./package.json
COPY --chown=nanoclaw:nanoclaw container ./container
COPY --chown=nanoclaw:nanoclaw scripts ./scripts

# Mountable data volumes (persisted on the host / GCE persistent disk)
RUN mkdir -p /app/data /app/store /app/logs /app/groups \
  && chown -R nanoclaw:nanoclaw /app/data /app/store /app/logs /app/groups

USER nanoclaw

# tini for proper SIGTERM forwarding (matters for graceful Discord disconnect)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
