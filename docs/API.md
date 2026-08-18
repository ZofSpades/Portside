# API reference

Base URL (local dev): `http://api.localhost`

Filled in as endpoints ship.

## Implemented

### `GET /health`

Checks Postgres, Redis, and Docker daemon reachability (via `docker-socket-proxy`).

```json
{
  "ok": true,
  "checks": {
    "database": { "ok": true, "latencyMs": 4 },
    "redis": { "ok": true, "latencyMs": 1 },
    "docker": { "ok": true, "latencyMs": 6 }
  }
}
```

Returns `200` when every check passes, `503` otherwise.

## Planned

- `GET /auth/github` / `GET /auth/github/callback` — OAuth login
- `POST /api/projects` — create a project (git repo or zip upload)
- `GET /api/projects` / `GET /api/projects/:id` — list / fetch
- `POST /api/projects/:id/deploy` — enqueue a deploy, returns `202` with the deployment id
- `POST /api/deployments/:id/cancel`
- `POST /api/projects/:id/rollback` — body: `{ toDeploymentId }`
- `GET /api/projects/:id/env` / `PUT /api/projects/:id/env` — encrypted env var management
- `GET /api/deployments/:id/logs/stream` — SSE, supports `Last-Event-ID` for gap-free resume
