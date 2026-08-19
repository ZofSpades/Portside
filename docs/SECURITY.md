# Security

## Isolation model

Every build and every running app gets its own container with resource limits:

```
Memory: 512MB   NanoCpus: 0.5   PidsLimit: 256   ulimit nofile 1024
CapDrop: ALL    SecurityOpt: no-new-privileges   User: non-root
NetworkMode: portside-apps (only)                No Docker socket
RestartPolicy: on-failure, max 3
Labels: portside.managed=true
```

`portside.managed=true` is a hard rule for the garbage collector: it never removes a container
or image lacking this label, so Portside can never touch Docker resources it didn't create.

Traefik never gets raw Docker socket access — it talks to `docker-socket-proxy`
(`tecnativa/docker-socket-proxy`), restricted to read-only container/network/event endpoints
(`POST=0`). A compromised Traefik container cannot create, exec into, or delete anything.

Traefik's request actually passes through one more hop first: `docker-api-shim`, a small nginx
config that rewrites the Docker Engine API version prefix. Traefik's bundled Docker client
hardcodes its initial version-negotiation call to API version 1.24; this host's Docker Engine
enforces `MinAPIVersion: 1.40` and rejects anything older outright instead of the traditional
graceful downgrade, so negotiation never completed and the Docker provider found no containers
without it. This is a client/engine version workaround, not a security boundary — it sits inside
`portside-internal` and doesn't change what Traefik can reach or do.

## Secrets

- Env vars and GitHub OAuth tokens: AES-256-GCM, random IV per record, ciphertext/iv/authTag in
  separate columns. Key comes from `PORTSIDE_ENCRYPTION_KEY`.
- The GitHub webhook signing secret (`Project.webhookSecret`) is stored in plaintext, unlike the
  above — it's an HMAC key the webhook route compares against an inbound signature, not something
  ever decrypted for use elsewhere, and it's never read by the worker or written to a deploy log.
  Rotate it by clearing and regenerating, same as any webhook secret.
- Secrets are injected into containers at **runtime**, never as build args — build args are
  baked permanently into image history.
- Log lines are scanned and redacted against known secret values at the emit boundary
  (`packages/core/redact.ts`), before they reach Redis, storage, or the UI.
- Git clones never put the token in the remote URL (git prints URLs on error). A `0600` temp
  credential-helper file is used and deleted immediately after clone.

## Zip uploads

Zip-slip-safe extraction (reject entries resolving outside the target directory) plus caps on
uncompressed size, file count, and compression ratio to defeat zip bombs.

## Known v1 gaps — deliberate, not oversights

1. **Untrusted build scripts run in ordinary containers on a shared daemon.** No
   gVisor/Kata/Firecracker, no rootless Docker. A container escape means host compromise. This is
   the single biggest gap.
2. **The worker holds full read-write Docker socket access**, necessarily — it has to create and
   run containers. Compromising the worker means owning the host. Traefik is mitigated via the
   socket proxy; the worker cannot be.
3. **No egress filtering.** User containers can't reach platform services, but they can reach the
   public internet freely (crypto miners, SSRF). Would need iptables/Cilium to fix properly.
4. **No build-time resource limits beyond the 10-minute timeout.** BuildKit's own limits are
   weak; a pathological build can still stress the daemon during that window.
5. **No per-tenant disk quota** on build workspaces beyond periodic janitor cleanup.
6. ~~No image vulnerability scanning~~ Trivy now scans every built image and logs a
   CRITICAL/HIGH/MEDIUM/LOW summary. Still **reporting only** — findings never block a deploy,
   there's no severity threshold config, and a scan failure (timeout, cold DB download) is
   swallowed and treated as "couldn't scan" rather than surfaced as a warning anywhere but the
   build log itself.
7. **Encryption key lives in an env var**, not a KMS/Vault — no key rotation story.
8. **Single-node, single-trust-domain.** Container boundaries are the only tenant isolation;
   there's no further blast-radius containment if the host itself is compromised.

Basic rate limiting on deploy creation is in scope for v1 (prevents trivial build-queue DoS).
