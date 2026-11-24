# Chromium + Puppeteer control service for Cloudflare Containers.
# Cloudflare Containers run linux/amd64 images.
FROM --platform=linux/amd64 node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod --ignore-scripts

FROM --platform=linux/amd64 node:24-bookworm-slim
# Debian's Chromium + a virtual X display (Chromium runs headful, not headless).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium xvfb fonts-liberation fonts-noto-color-emoji ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Non-root user. /data holds the persistent Chromium profile that snapshots capture.
RUN useradd --create-home --uid 10001 app \
 && mkdir -p /data/chrome-profile \
 && chown -R app:app /data
WORKDIR /app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --chown=app:app entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER app
ENV NODE_ENV=production \
    PORT=8080 \
    DISPLAY=:99 \
    CHROMIUM_PATH=/usr/bin/chromium \
    PROFILE_DIR=/data/chrome-profile
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
