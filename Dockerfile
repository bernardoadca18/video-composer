FROM node:20-bookworm-slim AS build

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json eslint.config.mjs .prettierrc.json ./
COPY src ./src
RUN npm run build && npx remotion browser ensure && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates tini gosu \
    libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY package.json package-lock.json ./
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh && \
    mkdir -p /data && chown -R node:node /data /app

EXPOSE 8013
# Run as root initially so entrypoint can prepare directories,
# then drop privileges to node user
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]
