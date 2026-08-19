# Build context: repo root (npm workspaces need the full workspace tree).
#
# Debian slim (glibc), not Alpine — @fastify/secure-session's native
# sodium-native dependency has no musl/Alpine prebuild, so it fails at
# runtime on Alpine (see docs/SECURITY.md's session notes / commit history).
# Every stage must share the same libc family, since node_modules built in
# `deps` is copied wholesale into `runtime`.
FROM node:22-slim AS base
WORKDIR /repo
# Prisma's query engine needs OpenSSL and can't detect its version without
# it on Debian slim, silently guessing a version otherwise.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/docker/package.json packages/docker/package.json
RUN npm ci

FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN npm run generate --workspace packages/db
RUN npx tsc -b packages/core packages/db packages/docker apps/api

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r portside && useradd -r -g portside portside
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/packages/core/dist ./packages/core/dist
COPY --from=build /repo/packages/core/package.json ./packages/core/package.json
COPY --from=build /repo/packages/db/dist ./packages/db/dist
COPY --from=build /repo/packages/db/package.json ./packages/db/package.json
COPY --from=build /repo/packages/db/prisma ./packages/db/prisma
COPY --from=build /repo/packages/docker/dist ./packages/docker/dist
COPY --from=build /repo/packages/docker/package.json ./packages/docker/package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
USER portside
EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
