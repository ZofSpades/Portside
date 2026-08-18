# Architecture

## Runtime topology

```
Browser ──► Traefik :80 ──┬─► portside-web  (Next.js dashboard)   app.localhost
                          ├─► portside-api  (Fastify REST + SSE)  api.localhost
                          └─► user app containers                 <slug>-<hash>.localhost
                                (routed by labels, discovered automatically)

portside-api ──► Postgres, Redis            [network: portside-internal]
portside-worker ──► Postgres, Redis         [network: portside-internal]
                └─► /var/run/docker.sock    (builds + runs user containers)

user app containers ──► [network: portside-apps ONLY]
                         cannot reach Postgres/Redis/API
```

Two Docker networks are the core tenant-isolation boundary. `portside-internal` holds the
platform's own services (Postgres, Redis, the socket proxy, api, worker). `portside-apps` holds
Traefik and every container Portside deploys on a user's behalf. User containers are attached to
`portside-apps` only, so a deployed app can never reach the database, Redis, or the API — even
though it shares a host with them.

Traefik reaches the Docker daemon through two chained components on `portside-internal`:
`docker-api-shim` (nginx, rewrites the Docker Engine API version prefix — see
[SECURITY.md](SECURITY.md) for why) in front of `docker-socket-proxy` (the read-only ACL proxy),
which itself is the only component with a mount of the real Docker socket in Traefik's path.

## Repo layout

```
apps/api        Fastify: REST, GitHub OAuth, SSE log relay
apps/worker     BullMQ worker: clone → detect → build → run → route
apps/web        Next.js 15 + Tailwind dashboard
packages/db     Prisma schema, client, migrations
packages/core   types, detection, state machine, crypto, log protocol, redaction
packages/docker dockerode wrapper: builder, runner, Traefik label generation, GC
templates       Dockerfile templates (static, node)
infra           docker-compose, Traefik static config
examples        fixture repos used by integration tests + the demo
```

`packages/docker` and `packages/core` hold the two riskiest pieces — build orchestration and
proxy label generation — and are deliberately pure-ish packages so they're unit-testable without
a live daemon.

## Deploy lifecycle

1. API enqueues `{ deploymentId }` on the `deploys` BullMQ queue and returns `202` immediately.
2. Worker picks up the job, re-reads all state from Postgres (never trusts job payload beyond
   the id), and acquires a per-project Redis lock so two deploys of the same project can't race.
3. Worker clones the repo (or extracts the zip) into an ephemeral workspace, detects the project
   type, renders a Dockerfile from a template, and builds the image via the Docker Engine API
   (`dockerode`), streaming build output to a Redis Stream as it goes.
4. On a successful build, the worker starts the new container with resource limits and Traefik
   labels, health-checks it, then stops the previous container for that project. This is a
   brief stop-then-start swap for now; zero-downtime blue/green cutover is a planned upgrade.
5. Traefik picks up the new container's labels via the Docker provider automatically — no proxy
   restart, no config file rewrite. See [writeups/dynamic-proxy-routing.md](writeups/dynamic-proxy-routing.md).
6. The deployment row is marked `LIVE`; the previous one is marked `SUPERSEDED` and its image is
   retained for rollback.

## Two hard parts

**Dynamic proxy routing** — a pure function (`packages/docker/labels.ts`) generates the Traefik
label map for a deployment (router rule, entrypoint, priority, service port, GC-safety labels).
Being pure makes it exhaustively unit-testable independent of a running daemon.

**Build orchestration** — everything goes through the Docker Engine API via `dockerode`, never
`docker build` shelled out. The worker tars the build context in memory and streams it to
`docker.buildImage`, parsing newline-delimited JSON build output into log events as they arrive.
Build workspaces live in named Docker volumes, not Windows bind mounts, so builds don't depend on
host filesystem path translation.

See [DATA-MODEL.md](DATA-MODEL.md) for the deployment state machine and
[SECURITY.md](SECURITY.md) for container hardening and the isolation threat model.
