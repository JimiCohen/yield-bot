# Aerodrome Yield Bot — bot + dashboard in one container.
# The dashboard binds 0.0.0.0 ONLY on the compose-private network
# (DASHBOARD_UNSAFE_BIND); authentication lives in the Caddy proxy.
FROM node:20-bookworm-slim

# better-sqlite3 builds natively
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json config.yaml ./
COPY src ./src
COPY web ./web
COPY docs ./docs

# data + logs live on a volume (see docker-compose.yml)
VOLUME ["/app/data", "/app/logs"]

ENV DASHBOARD_UNSAFE_BIND=behind-my-own-proxy
ENV AUTO_START_PAPER=1
EXPOSE 8787
CMD ["npx", "tsx", "src/server/index.ts"]
