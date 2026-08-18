# Build context: repo root (npm workspaces need the full workspace tree).
FROM node:22-alpine AS base
WORKDIR /repo
# git is a real runtime dependency here — the worker shells out to it to
# clone GIT-sourced projects (see apps/worker/src/git.ts). Installed in this
# shared base (not just `runtime` below) so the dev target, which stops at
# `deps`, has it too.
RUN apk add --no-cache git

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
COPY apps/worker ./apps/worker
RUN npm run generate --workspace packages/db
RUN npx tsc -b packages/core packages/db packages/docker apps/worker

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
# git is a real runtime dependency here — the worker shells out to it to
# clone GIT-sourced projects (see apps/worker/src/git.ts).
RUN apk add --no-cache git \
    && addgroup -S portside && adduser -S portside -G portside
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/packages/core/dist ./packages/core/dist
COPY --from=build /repo/packages/core/package.json ./packages/core/package.json
COPY --from=build /repo/packages/db/dist ./packages/db/dist
COPY --from=build /repo/packages/db/package.json ./packages/db/package.json
COPY --from=build /repo/packages/db/prisma ./packages/db/prisma
COPY --from=build /repo/packages/docker/dist ./packages/docker/dist
COPY --from=build /repo/packages/docker/package.json ./packages/docker/package.json
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
COPY --from=build /repo/apps/worker/package.json ./apps/worker/package.json
COPY templates ./templates
USER portside
CMD ["node", "apps/worker/dist/index.js"]
