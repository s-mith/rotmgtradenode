# rotmgcommunism: site + embedded bot fleet + embedded accountgen in one process.
# Build: vite client, esbuild server bundles, sprite atlas (sharp).
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 and sharp ship prebuilt binaries for node 22; the toolchain
# is only a fallback if a prebuild is missing for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Vite inlines VITE_* at build time. Railway passes service variables as
# build args, but Docker only exposes the ones declared here.
ARG VITE_DISCORD_URL
ENV VITE_DISCORD_URL=$VITE_DISCORD_URL
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Runtime data the server reads from the repo root.
COPY --from=build /app/realm-items.json /app/realm-enchants.json ./
COPY --from=build /app/content ./content
COPY --from=build /app/data/dismantle-values.json /app/data/soulbound-cache.json /app/data/untiered-tradable-candidates.json ./data/
EXPOSE 3000
CMD ["node", "dist/server/main.js"]
