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
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN npm run generate --workspace packages/db
RUN npx tsc -b packages/core packages/db apps/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
RUN addgroup -S portside && adduser -S portside -G portside
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/packages/core/dist ./packages/core/dist
COPY --from=build /repo/packages/core/package.json ./packages/core/package.json
COPY --from=build /repo/packages/db/dist ./packages/db/dist
COPY --from=build /repo/packages/db/package.json ./packages/db/package.json
COPY --from=build /repo/packages/db/prisma ./packages/db/prisma
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
USER portside
EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
