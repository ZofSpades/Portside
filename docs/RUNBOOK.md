# Runbook

## Local setup

Requirements: Docker Desktop (Linux containers), Node.js 22+, npm.

```bash
cp .env.example .env
# generate an encryption key:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# paste it into PORTSIDE_ENCRYPTION_KEY in .env, and set SESSION_SECRET to any long random string

npm install
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up --build
```

- Dashboard: http://app.localhost
- API health: http://api.localhost/health
- Traefik dashboard: http://localhost:8080

`*.localhost` hostnames resolve to `127.0.0.1` automatically in modern browsers and OSes — no
hosts-file edits needed.

## Common commands

```bash
npm run typecheck              # tsc -b across all workspace packages
npm run lint
npm test                       # unit tests, no Docker required
npm run test:integration       # requires a live Docker daemon
npm run prisma:migrate         # create/apply a Prisma migration (packages/db)
npm run check-clean-tree       # guard against local-only/dev files entering git
```

## Troubleshooting

- **`api.localhost/health` returns 503 on `docker`** — check `docker-socket-proxy` is running
  (`docker compose ps`) and that Docker Desktop's Linux engine is up.
- **Traefik shows no routers** — labels must include `traefik.enable=true`; the Docker provider
  has `exposedByDefault: false` by design (see `infra/traefik/traefik.yml`).
- **Windows bind-mount slowness** — build workspaces intentionally use named Docker volumes, not
  `D:\` bind mounts, for exactly this reason. If you add a new bind mount, keep it out of the
  build hot path.
- **Prisma migrate can't reach Postgres** — the compose Postgres only listens on
  `portside-internal`; run `prisma migrate dev` from inside the `api` or `worker` container, or
  temporarily publish `5432` in a local override file (don't commit it).

## VPS deployment

Everything above runs against `*.localhost`, which only resolves on the machine running it. Going
from that to a real internet-facing instance is mostly configuration, plus two things that need
actual changes: TLS and the Traefik dashboard's dev-mode auth bypass.

### 1. DNS

Point a wildcard record at the VPS's IP, alongside the bare domain — every deployed project gets
`<slug>.<your-domain>`, and the platform's own dashboard/API live at `app.<your-domain>` /
`api.<your-domain>`, so both need to resolve without per-project DNS entries:

```
A     your-domain.com         → <VPS IP>
A     *.your-domain.com       → <VPS IP>
```

### 2. Environment

Set these for real, rather than the local dev defaults in `.env.example`:

```bash
PORTSIDE_BASE_DOMAIN=your-domain.com
PORTSIDE_APP_PROTOCOL=https
GITHUB_CALLBACK_URL=https://api.your-domain.com/auth/github/callback
POSTGRES_PASSWORD=<real random password>
SESSION_SECRET=<real long random string>
PORTSIDE_ENCRYPTION_KEY=<real 32 random bytes, base64>
```

The GitHub OAuth App itself also needs its callback URL updated to match, in GitHub's own app
settings — Portside can't do that side of it for you.

### 3. TLS

Traefik's static config (`infra/traefik/traefik.yml`) only defines a plain `web` (`:80`)
entrypoint today — there's no `websecure` entrypoint or ACME certificate resolver configured,
since local dev has no real domain to issue a certificate for. Getting real HTTPS means adding
both:

```yaml
entryPoints:
  web:
    address: ':80'
    http:
      redirections:
        entryPoint: { to: websecure, scheme: https }
  websecure:
    address: ':443'

certificatesResolvers:
  letsencrypt:
    acme:
      email: you@your-domain.com
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web
```

Every router Portside creates would then need a `tls.certResolver=letsencrypt` label alongside
the existing ones in `packages/docker/src/labels.ts`, and the compose file needs a persistent
volume mounted at `/letsencrypt` so certificates survive a restart. This is the one piece of the
VPS path that's a real code change, not just configuration — budget time for it rather than
expecting to flip a flag.

### 4. Lock down what's public

- **The Traefik dashboard is insecure by default.** `infra/traefik/traefik.yml` sets
  `api.insecure: true` deliberately for local dev — anyone who can reach it gets full visibility
  into every router, with no auth. Before exposing anything publicly, set it to `false` and put
  the dashboard behind either Traefik's own basic-auth middleware or a VPN/SSH tunnel — don't
  publish `TRAEFIK_DASHBOARD_PORT` (8080) to the internet-facing interface at all.
- **Only `80`/`443` should be reachable from outside.** Postgres, Redis, and
  `docker-socket-proxy` already have no host port mappings in `infra/docker-compose.yml` — keep
  it that way. If you add a debugging port mapping, remove it before deploying.
- **The worker's Docker socket access doesn't change.** It needs full read-write access to build
  and run containers on this same host, same as in local dev — see
  [SECURITY.md](SECURITY.md) and [writeups/build-isolation.md](writeups/build-isolation.md) for
  what that does and doesn't mean for the threat model. Nothing about a VPS deployment reduces
  that exposure; it just raises the stakes of it, since the daemon is now reachable from a host
  with a public IP instead of a laptop behind NAT.
- Standard VPS hardening applies on top of all of the above and isn't Portside-specific: SSH key
  auth only, a firewall (`ufw`/`iptables`) default-denying inbound except `22`/`80`/`443`, and
  keeping the host OS and Docker Engine patched.
