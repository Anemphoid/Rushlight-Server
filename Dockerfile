# syntax=docker/dockerfile:1
# The Rushlight server as a container image. Built by GitHub on every version tag (.github/workflows/docker.yml) for ordinary
# computers (amd64) and Raspberry Pi (arm64), and published to ghcr.io/anemphoid/rushlight-server.
#
# It holds only the server. LiveKit (voice), Tailscale and Caddy are separate containers, pinned by the Compose stack.
# Everything that must survive an update lives on ONE volume, /data: the database, the backups and the backup key file.
# No secret is in the image. JWT_SECRET and the LiveKit settings are given when it starts.

# ---- build the dependencies (the build tools stay in this stage) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- the image people run ----
FROM node:22-bookworm-slim
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Rushlight server" \
      org.opencontainers.image.description="Voice and text chat server for your own community" \
      org.opencontainers.image.source="https://github.com/Anemphoid/Rushlight-Server" \
      org.opencontainers.image.licenses="BUSL-1.1" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# ffmpeg is for Jellybox (it decodes the songs). tini is the first process, so the container stops promptly when told to.
# Debian's ffmpeg is GPL-licensed software; its licence texts are in /usr/share/doc/ffmpeg inside the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /data \
 && chown node:node /data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY src ./src
COPY docs ./docs

ENV NODE_ENV=production \
    PORT=4000 \
    DB_PATH=/data/rushlight.db \
    RUSHLIGHT_VERSION=${VERSION}
VOLUME /data
EXPOSE 4000
USER node

# "Healthy" means the server answers. The Compose stack and `rushlight check` wait for this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
