# Build context: repo root (npm workspaces need the full workspace tree).
FROM node:22-alpine AS base
WORKDIR /repo

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
COPY apps/web ./apps/web
WORKDIR /repo/apps/web
RUN npm run build --workspace apps/web

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo/apps/web
RUN addgroup -S portside && adduser -S portside -G portside
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER portside
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
