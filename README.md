# Portside

A self-hosted, minimal Vercel/Railway: connect a Git repo or upload a zip, Portside detects the
project type, builds it inside an isolated container via the Docker Engine API, deploys it behind
a reverse proxy, and hands back a live URL — with build logs streamed to a dashboard in real time.

This is a portfolio project. It intentionally does one vertical slice well (static sites, Node.js
apps, and Dockerfile-based apps) rather than supporting every framework.

## Architecture

```
Browser ──► Traefik :80 ──┬─► portside-web  (Next.js dashboard)   app.localhost
                          ├─► portside-api  (Fastify REST + SSE)  api.localhost
                          └─► user app containers                 <slug>-<hash>.localhost

portside-api ──► Postgres, Redis            [network: portside-internal]
portside-worker ──► Postgres, Redis         [network: portside-internal]
                └─► /var/run/docker.sock    (builds + runs user containers)

user app containers ──► [network: portside-apps ONLY]
                         cannot reach Postgres/Redis/API
```

Full design detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

- **Frontend:** Next.js 15 + TypeScript + Tailwind, SSE log viewer
- **API:** Fastify (TypeScript)
- **Worker:** BullMQ, dockerode against the Docker Engine API
- **Proxy:** Traefik, dynamic Docker-label routing (no config file rewrites)
- **Data:** PostgreSQL (Prisma), Redis (queue + pub/sub via Streams)

## Getting started

```bash
cp .env.example .env               # fill in PORTSIDE_ENCRYPTION_KEY, SESSION_SECRET, GitHub OAuth
npm install
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up --build
```

- Dashboard: http://app.localhost
- API health: http://api.localhost/health
- Traefik dashboard: http://localhost:8080

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Topology, deploy lifecycle |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Schema + deployment state machine |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, known v1 gaps |
| [docs/API.md](docs/API.md) | REST + SSE reference |
| [docs/writeups/](docs/writeups/) | Deep-dive technical write-ups |

## Status

Early and actively evolving. The base stack (Postgres, Redis, Traefik, and the api/worker/web
services) runs end to end via docker-compose with a passing `/health` check; the deploy
pipeline itself is in progress.
