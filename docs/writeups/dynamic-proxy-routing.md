# How the dynamic reverse proxy routing works

Portside deploys arbitrary user projects to their own subdomains, on demand, with no fixed set
of routes known ahead of time. A route has to exist the moment a container starts and disappear
the moment it stops — with no config file to edit and no proxy to restart. This is the piece of
the system a request actually flows through on every single hit, so it had to be right, and it's
also where the two least obvious bugs in the whole project showed up.

## The constraint: no config file, no restart

The naive reverse-proxy design is a config file mapping hostnames to upstreams, reloaded (or the
proxy restarted) whenever it changes. That doesn't work here: deployments happen continuously,
from a background worker, and a proxy restart would drop every in-flight connection to every
*other* project every time any one project redeployed. Nginx's usual answer is `nginx -s reload`
plus a templating layer generating `server` blocks — workable, but it means the worker's deploy
pipeline now owns a second responsibility (safely regenerating and validating proxy config) on
top of building and running containers.

Traefik's Docker provider removes that responsibility entirely: it watches the Docker daemon's
event stream directly and reads routing rules from container labels. A container that starts
with the right labels *is* a route, immediately, with no separate registration step for the
worker to get wrong. This is [ADR-002](../DECISIONS.md#adr-002-traefik-with-the-docker-provider-over-nginx)
— the decision was made early, before any of the harder mechanics below were understood.

## Labels as a pure function

`packages/docker/src/labels.ts` exports one function, `buildTraefikLabels`, that takes a
project slug, deployment id, container port, and a couple of optional fields, and returns a
plain label map — no Docker client, no network call, no side effect:

```ts
buildTraefikLabels({ projectSlug, deploymentId, port, domain, priority, customDomain })
// → { labels: {...}, hostname, customDomain, routerName, serviceName }
```

Keeping it pure is what makes it possible to exhaustively unit-test the one piece of the system
where a bug is genuinely dangerous — a malformed rule either breaks routing for a project or,
worse, lets one project's input affect another's route. The test suite (23 cases) covers slug
sanitization, the reserved-name list (`api`, `app`, `traefik`, `www`, `admin`, `localhost` — a
project can't claim a hostname the platform itself needs), port bounds, and the custom-domain
injection cases below. None of it needs a running daemon.

## The hostname had to lose its hash

Every deployment gets a unique image tag and container name, so the obvious first design gave
every deployment a unique *hostname* too: `<slug>-<hash>.<domain>`, where the hash came from the
deployment id. This is wrong in a way that doesn't show up until you try to build zero-downtime
redeploys. If every deployment has its own URL, a redeploy has nothing to *replace* — the old and
new containers were never competing for the same traffic, so "cutting over" is meaningless. The
dashboard's "live URL" would silently change on every redeploy, and rollback would mean handing
the user a different link than the one they'd been sharing.

The fix was to make the hostname just `<slug>.<domain>` — the slug is already globally unique at
the database layer, so it needs no extra disambiguation. Router and service *names* still carry
the deployment hash (`portside-<slug>-<hash>`), so two deployments' containers can coexist under
Traefik at once, each with its own router matching the identical `Host()` rule. That coexistence
is exactly what makes a swap possible, and exactly what makes it need a tiebreaker.

## Priority is the tiebreaker, and it's a timestamp

When a redeploy's new container starts, Traefik's Docker provider will, on its own polling
schedule, discover a second router matching the same hostname as the one already serving traffic.
Docker labels are immutable after a container is created — there's no way to flip a label once
health has been confirmed — so the deploy pipeline has to decide the outcome *before* it knows
whether the new container is actually healthy. The label it sets is
`traefik.http.routers.<name>.priority`, and the value is `Date.now()`:

```ts
const { labels, hostname } = buildTraefikLabels({
  projectSlug: project.slug,
  deploymentId,
  port: CONTAINER_PORT,
  priority: Date.now(),
  customDomain: project.customDomain ?? undefined,
});
```

A timestamp needs no coordination between deploys — no counter to read and increment, no risk of
two concurrent deploys racing on the same value — and it's trivially always higher than whatever
it's replacing. The honest tradeoff, [written up in full as ADR-006](../DECISIONS.md#adr-006-bluegreen-cutover-via-a-stable-hostname--timestamp-priority),
is that there's a narrow window — bounded by Traefik's own Docker-provider poll interval — where
a *broken* new container can briefly outrank the old one before the pipeline's own health check
has run. Closing that window completely would mean Traefik gating traffic on an active health
check against the service itself, which was deliberately not done: the obvious default check
path (`GET /`) would mark plenty of legitimate apps — anything with no root route — as unhealthy,
and there's no per-project health-check-path configuration yet to make that safe.

What actually bounds the damage is the pipeline's own failure handling, covered below, plus a 5s
SIGTERM grace period (`stopAndRemoveContainer`) on the *old* container once the new one is
confirmed live — connection draining for whatever was already in flight, not an abrupt cut.

## The bug that made this real: a health check that could be fooled

The first version of the health check was a single snapshot: wait two seconds, then check
`container.inspect().State.Running`. This looked reasonable in isolation and passed every test
that deployed something that actually worked. It failed the first time a *broken* deployment was
tested on purpose — a container whose entrypoint was `exit 1` went **live** instead of failing,
and the previously-good container was torn down right after. Total outage, which is exactly the
failure mode blue/green was supposed to prevent.

The cause: every container runs with `RestartPolicy: on-failure, max 3`. A container that
crash-loops — exit, restart, exit, restart — can be sitting in the `Running` state at the *exact
instant* a single point-in-time check happens to sample it, purely by timing luck. The fix
samples several times instead of trusting one snapshot, and checks a field the naive version
ignored entirely:

```ts
const HEALTHCHECK_SAMPLES = 4;
const HEALTHCHECK_INTERVAL_MS = 500;

async function waitForHealthy(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  for (let i = 0; i < HEALTHCHECK_SAMPLES; i++) {
    await new Promise((resolve) => setTimeout(resolve, HEALTHCHECK_INTERVAL_MS));
    const info = await container.inspect();
    if (!info.State.Running) throw new Error(/* ... */);
    if (info.RestartCount > 0) throw new Error(/* ... it's crash-looping */);
  }
}
```

`RestartCount > 0` is the real signal: a container that has needed even one automatic restart
during the sampling window is not something a swap should ever cut traffic over to, regardless
of what state it happens to be in when observed. After this fix, the same broken-container test
failed cleanly — `FAILED` status, clear error message, previous deployment kept serving traffic
throughout — and the pipeline's failure path (below) tore the broken container down immediately
instead of leaving it sitting at the highest priority.

## Failure cleanup bounds the blast radius

Once a new container has started, its id is held in a local variable for the rest of the deploy.
If anything throws after that point — the health check above, or any later step — the pipeline's
catch block tears that specific container down before marking the deployment `FAILED`:

```ts
if (newContainerId) {
  await stopAndRemoveContainer(docker, newContainerId).catch((cleanupErr) =>
    console.error(`[worker] failed to remove broken container for ${deploymentId}`, cleanupErr),
  );
}
```

Removing the container removes its router from Traefik's discovery on the very next poll, which
reverts live traffic to the still-running previous deployment — the one that was never touched
because the old container is only ever stopped *after* the new one is confirmed healthy. A bad
deploy is self-healing within roughly one Traefik poll interval, not blast-radius-free, but never
left serving traffic indefinitely.

## Verifying "zero-downtime" instead of asserting it

Claiming a swap is seamless and actually measuring it are different things, and `fetch()` makes
the measurement harder than it should be: it treats `Host` as a forbidden header per the WHATWG
spec, so a request built with `fetch('http://traefik/', { headers: { Host: hostHeader } })`
silently drops the header and hits whatever Traefik's default backend is — every response comes
back 404, and it looks like the proxy is broken when the test is. The fix is Node's raw
`http.request()`, which honors the header:

```ts
http.request({ host: 'traefik', port: 80, path: '/', headers: { Host: hostHeader } }, ...)
```

With that working, a throwaway script deployed a project, then polled its stable hostname every
100ms through an entire second deployment of the same project — 58 requests, 58 successes, zero
gap. A companion test deployed a good build, then redeployed a container that exits on startup,
and confirmed the bad deployment failed cleanly while the good one kept answering every request
the entire time.

## Custom domains: an additive rule, not a separate router

A project's custom domain doesn't get its own router — it extends the existing one with a second
`Host()` match, so the platform-assigned hostname and the custom one both resolve to the same
container under the same priority:

```ts
const rule = customDomain
  ? `Host(\`${hostname}\`) || Host(\`${customDomain}\`)`
  : `Host(\`${hostname}\`)`;
```

`customDomain` is user-supplied and gets embedded directly into that backtick-quoted string, which
makes it a rule-injection vector if left unvalidated — a value containing a backtick, a
parenthesis, or its own `||` could alter the rule's structure rather than just its content. It's
checked against a conservative hostname pattern (letters, digits, hyphens, at least one dot) both
at the API boundary (`PUT /api/projects/:id/domain`, so a bad domain is rejected immediately
with a 400 instead of only failing at deploy time) and again inside `buildTraefikLabels` itself,
so the guarantee holds regardless of caller. The unit tests include the injection attempts
directly — `evil.com\`) || PathPrefix(\`/`, `(evil)`, `evil.com; rm -rf /` — asserting each one
is rejected rather than merely trusting the regex by inspection.

## Two more pieces that had to be right before any of this worked

**The network split.** `portside-internal` carries Postgres, Redis, the socket proxy, and the
platform's own services. `portside-apps` carries Traefik and every container Portside deploys on
a user's behalf. User containers are attached to `portside-apps` only — this is the actual
tenant-isolation boundary, not a routing detail, but it's enforced at exactly the same layer
(Docker networking) as the labels above.

**Talking to the Docker daemon at all.** Traefik never gets the raw Docker socket — it goes
through `docker-socket-proxy` (`tecnativa/docker-socket-proxy`), restricted to read-only
container/network/event endpoints. A compromised Traefik container can discover routes; it can't
create, exec into, or delete anything. Getting from there to a working setup needed one more
piece that had nothing to do with security: this Docker Engine enforces `MinAPIVersion: 1.40` and
rejects anything older outright, while Traefik's bundled Docker client hardcodes its initial
version-negotiation call to API version 1.24. Negotiation never completed, and the Docker
provider silently discovered zero containers — no error, just an empty router table. The fix,
`docker-api-shim`, is a small nginx config sitting in front of the socket proxy that rewrites the
version prefix on the way through. It's a client/engine compatibility workaround, not a security
boundary, and it's worth naming explicitly as the kind of bug that doesn't look like a routing
problem at all until you've ruled out everything else.
