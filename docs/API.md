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

### `PUT /api/projects/:id/domain`

Body: `{ "domain": string | null }`. Sets or clears the project's custom domain. `domain` is
validated against a conservative hostname pattern (rejects anything that could break out of a
Traefik `Host()` rule); a domain already claimed by another project returns `409`.

### `POST /api/webhooks/github/:projectId`

Not session-gated — GitHub can't send our cookie, so this route authenticates itself via the
`X-Hub-Signature-256` HMAC header against the project's `webhookSecret`, the same way GitHub's
own webhook delivery does. `404` if the project has no webhook secret, `401` on a bad signature,
`202` (ignored) for any event other than `push` or a push to a branch other than the project's
configured one, `202` with `{ deploymentId }` on a valid push to the right branch.

## Planned

- `GET /auth/github` / `GET /auth/github/callback` — OAuth login
- `POST /api/projects` — create a project (git repo or zip upload)
- `GET /api/projects` / `GET /api/projects/:id` — list / fetch
- `POST /api/projects/:id/deploy` — enqueue a deploy, returns `202` with the deployment id
- `POST /api/deployments/:id/cancel`
- `POST /api/projects/:id/rollback` — body: `{ toDeploymentId }`
- `GET /api/projects/:id/env` / `PUT /api/projects/:id/env` — encrypted env var management
- `GET /api/deployments/:id/logs/stream` — SSE, supports `Last-Event-ID` for gap-free resume
