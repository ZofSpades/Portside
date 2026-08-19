# How build isolation is enforced

Every deploy on Portside means running code nobody has reviewed — a git repo or a zip file
someone uploaded — through a build step and then as a live process, on a single shared Docker
daemon with no per-tenant VM boundary. Nothing here pretends that's as safe as a real sandboxing
layer would be; the honest gaps are listed at the bottom and linked from
[SECURITY.md](../SECURITY.md). What this covers is what *is* enforced, why it's enforced that
way, and one real investigation (build caching) that changed direction mid-flight once the
obvious approach turned out not to work against this daemon.

## Everything through the Engine API, nothing shelled out

The worker never runs `docker build` or `docker run` as a subprocess. Every build and every
container is created through `dockerode` against the Docker Engine API directly —
`docker.buildImage()`, `docker.createContainer()`, `container.start()`. Two reasons this matters
more than it might look:

- **No shell-injection surface.** A project's slug, branch name, or env var keys never get
  interpolated into a shell command string — they're always JSON payload fields in an API
  request. The one place a subprocess *is* used at all is `git clone` itself (`execFile`, not
  `exec` — arguments passed as an array, never concatenated into a string), covered below.
- **Structured, streamable output.** The Engine API's build endpoint returns newline-delimited
  JSON events, not raw terminal output meant for a human. `packages/docker/src/builder.ts`'s
  `parseBuildEvent` turns each event into a single log line and is a pure function — unit-tested
  against real event shapes without needing a live daemon at all:

  ```ts
  export function parseBuildEvent(event: DockerBuildEvent): string | null {
    if (event.error) return `ERROR: ${event.errorDetail?.message ?? event.error}`;
    if (event.stream) return event.stream.replace(/\n+$/, '') || null;
    if (event.status) return event.status;
    return null;
  }
  ```

  The build context itself is tarred in memory (`tar-fs`) and streamed straight into the
  request body — the worker never needs a shared filesystem path between itself and the daemon,
  which matters concretely on this project's Windows dev host, where bind-mounting a Windows
  path into a Linux container is slow and occasionally just wrong. Build workspaces live in named
  Docker volumes instead, both in dev and in the containerized worker.

## What a container can't do

Every container Portside starts — build output, not the build itself, which has no container of
its own beyond the daemon's internal build step — gets the same hardening, defined once and
applied uniformly:

```ts
const HARDENING_HOST_CONFIG = {
  Memory: 512 * 1024 * 1024,
  NanoCpus: 0.5e9,
  PidsLimit: 256,
  CapDrop: ['ALL'],
  SecurityOpt: ['no-new-privileges'],
  RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
} as const;
```

`CapDrop: ['ALL']` found a real bug immediately: stock `nginx:alpine`'s own startup does a
`chown()` on its cache directories as root, which needs `CAP_CHOWN` — a capability this config
drops unconditionally. The fix wasn't to weaken the drop; it was to bake correct ownership into
the image at build time and run nginx as a non-root user from the Dockerfile's `USER` directive,
which also meant moving nginx off port 80 (binding under 1024 as non-root needs
`CAP_NET_BIND_SERVICE`, also dropped) to 8080 internally, with Traefik doing the actual
public-facing port mapping.

**Network isolation is the real tenant boundary**, and it's enforced independently of everything
above: every user container's `NetworkMode` is `portside-apps`, a Docker network that carries
Traefik and nothing else Portside owns. Postgres, Redis, and the API all live on a separate
`portside-internal` network. A deployed app can resolve and reach the public internet freely, but
it has no route to the platform's own data plane at all — not "authenticated and denied," just
absent from that container's network namespace. This is the boundary that actually matters if a
container is doing something malicious, and it doesn't depend on any code inside the container
behaving correctly.

## Secrets: runtime only, never baked in

Two decisions here, both non-negotiable rather than tunable:

**Never as build args.** `docker build --build-arg SECRET=...` bakes the value into the image's
layer history permanently — anyone who can `docker history` or pull the image gets it back, even
after a redeploy changes it. Every secret a deployed app needs (its env vars) is injected only at
`docker.createContainer()` time, as runtime `Env`, never touching the build.

**The GitHub token never goes in a URL.** Git prints the remote URL in its own error output on
failure, which would put a token straight into a build log if it were embedded as
`https://<token>@github.com/...`. Instead, when a token is present, `apps/worker/src/git.ts`
writes it to a `0600` temp file read by git's own credential helper, and deletes the file
immediately after the clone completes — successful or not:

```ts
credentialHelperFile = path.join(os.tmpdir(), `portside-git-cred-${randomUUID()}`);
await fsp.writeFile(credentialHelperFile, `https://x-access-token:${githubToken}@github.com\n`, {
  mode: 0o600,
});
args.push('-c', `credential.helper=store --file=${credentialHelperFile}`);
```

**Redaction is the last line, not the first.** Every secret a deployment could touch — the
decrypted GitHub token, every decrypted env var value — is collected into one list *before the
first log line of the deployment is emitted*, including git's own clone output, and passed into
the `LogEmitter` that every subsequent line flows through. A line is scanned and redacted against
every known secret at the point it's about to be written to Redis, not after — so there's no
window where a raw value could reach the stream, the archive, or the dashboard, and no reliance
on remembering to redact at each individual call site later.

## Zip uploads: validated before a single byte is written

A user-supplied zip is a second untrusted-input surface with its own failure modes independent of
what's inside the code. `packages/core/src/zip.ts`'s `safeExtractZip` validates every entry
*before* extracting anything:

- **Zip-slip**: an entry name like `../../etc/cron.d/whatever` resolves outside the destination
  directory. Checked via `path.resolve` plus a prefix check against the resolved destination,
  not a string match against `..` — a string match is exactly the kind of check that looks right
  and misses encoded or platform-specific variants.
- **Zip bombs**: a total uncompressed-size cap (200MB default), a file-count cap (10,000), and a
  per-entry compression-ratio cap (100×) — a tiny file that claims to decompress to gigabytes
  fails on the ratio check without Portside ever having to actually attempt the decompression to
  find out.

Testing the zip-slip defense honestly took more than writing a malicious-looking fixture: the
zip-writing library used to *construct* test zips (`adm-zip`) silently strips `../` from entry
names on write, which means a zip built the normal way can never contain the attack it's supposed
to be testing. The test suite hand-constructs raw zip bytes for that one case instead, to
actually exercise the same code path a real hand-crafted malicious zip would hit.

## Build caching: the investigation that changed direction

Redeploying a project with unchanged dependencies re-running `npm ci` from scratch every time is
wasteful, and the textbook fix is a BuildKit cache mount — a persistent cache directory that
survives across builds even when earlier layers invalidate. Wiring that up (`RUN
--mount=type=cache,target=/root/.npm`) turned out not to be viable here, but only after actually
trying it, not from reading documentation: `dockerode`'s `docker.buildImage(stream, { version:
'2' })` genuinely routes the build through BuildKit (confirmed on the wire — the response stream
carries real `moby.buildkit.trace` protobuf events, not an error), but the build then hangs
indefinitely against this daemon. Not a slow build, not a client-side progress-parsing quirk —
`docker images` afterward shows the target image was never created at all. Given the project's
own constraint of talking only to the Engine API, with no `docker buildx` subprocess to fall back
to, a build path that hangs isn't a viable one no matter how much better it would be on paper.

The classic builder gets most of the same benefit for free, without any new plumbing, once the
Dockerfile template is structured to take advantage of it: `Dockerfile.node.hbs` copies
`package.json`/the lockfile and runs `npm ci` in their own layer *before* copying the rest of the
source. Docker's classic builder caches each instruction by the content hash of its inputs, so a
redeploy where only application source changed — not dependencies — reuses that `npm ci` layer
untouched. This was verified rather than assumed: deploying the same project twice back to back
and diffing the build logs shows the second run's dependency-install step landing on `--->
Using cache` with the identical layer id as the first run, while every layer after the source
copy still rebuilds normally.

## Scanning what actually got built

Every successful build gets scanned with Trivy immediately afterward, and the result is
**reporting only** — a summary line (`Security scan: 1 CRITICAL, 7 HIGH, 8 MEDIUM (16 total).`)
lands in the deploy log, and nothing about the finding count ever blocks the deployment from
going live. That's a deliberate choice, not a missing feature: almost any real base image has
*some* known CVEs, so a hard gate on any finding would make the scanner something everyone
routes around rather than something anyone reads. A scan failure — the vulnerability database's
first download taking a while, a timeout — is caught and logged as "couldn't scan," the same way
a failed optional step should be treated, never surfaced as a reason the deploy itself failed.

## What this doesn't cover

Container boundaries on a shared daemon are the *only* tenant isolation here — there's no
gVisor, Kata, or Firecracker sandboxing, and no rootless Docker. A container escape means host
compromise, full stop; this is the single largest gap in the project's threat model, stated
plainly rather than glossed over. The worker itself necessarily holds full read-write Docker
socket access, since it has to create and run containers — Traefik is isolated from that via the
socket proxy described in [dynamic-proxy-routing.md](dynamic-proxy-routing.md), but the worker
can't be, by the nature of what it does. There's no egress filtering — a deployed container can
reach the public internet freely, which is fine for a legitimate app and not fine for a crypto
miner or an SSRF attempt. The full, numbered list of known gaps — including the ones with no
mitigation at all yet — lives in [SECURITY.md](../SECURITY.md), by design, rather than scattered
across individual write-ups where they'd be easy to lose track of.
