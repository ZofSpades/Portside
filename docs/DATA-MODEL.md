# Data model

Postgres via Prisma. Schema source of truth: [packages/db/prisma/schema.prisma](../packages/db/prisma/schema.prisma).

## Entities

- **User** — GitHub identity; OAuth token stored as AES-256-GCM ciphertext (`tokenCiphertext` /
  `tokenIv` / `tokenAuthTag`), never plaintext.
- **Project** — one deployable unit: git repo or zip source, build/start command overrides,
  `currentDeploymentId` pointing at the live deployment.
- **Deployment** — one build/run attempt. Append-only history; rollback creates a **new** row
  with `trigger=ROLLBACK` and `rolledBackFromId` set rather than mutating an old one.
- **EnvVar** — per-project key/value, AES-256-GCM encrypted, unique on `(projectId, key)`.
- **LogArchive** — final flushed build log for a completed deployment, after its Redis Stream
  expires.

## Deployment state machine

Enforced in `packages/core/state-machine.ts` (unit-tested — every legal transition allowed,
every illegal one rejected):

```
QUEUED → CLONING → DETECTING → BUILDING → DEPLOYING → HEALTHCHECK → LIVE
   │        │          │           │           │            │
   └────────┴──────────┴───────────┴───────────┴────────────┴──► FAILED
   └──► CANCELLED                              LIVE ──► SUPERSEDED | STOPPED
```

A new `LIVE` deployment marks the previous one `SUPERSEDED` (its image is retained for
rollback, pruned by the janitor beyond the last 5 per project). Rollback never rebuilds — it
repoints Traefik at a previously-built image.
