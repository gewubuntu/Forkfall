# Forkfall referee server + web app in one image.
# Build from the repo root:  docker build -f deploy/Dockerfile -t forkfall .
FROM node:26-bookworm-slim AS base
# Node 25+ no longer ships corepack: install the pinned pnpm directly.
RUN npm install -g pnpm@12.8.1 && npm cache clean --force
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# The web app reads these at build time (public values only: an RPC URL and a WalletConnect project id).
ARG VITE_BASE_SEPOLIA_RPC_URL=""
ARG VITE_WALLETCONNECT_PROJECT_ID=""
ARG VITE_ROBINHOOD_TESTNET_RPC_URL=""
RUN pnpm web:build

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    MATCH_ARCHIVE_DIR=/data/matches \
    STATE_DIR=/data/state \
    QUESTS_FILE=/data/quests.json \
    PROFILES_FILE=/data/profiles.json \
    SETTLEMENT_DIR=/data/settlements \
    REWARDS_DIR=/data/rewards \
    LEAGUE_DIR=/data/league
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/v1/config').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# One process (no pnpm/tsx wrapper), so SIGTERM from `docker compose` reaches the server directly:
# it finishes requests in flight, saves the queue and challenges, and exits (running matches are saved as they change).
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
