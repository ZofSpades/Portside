import { createHash } from 'node:crypto';
import { sanitizeSlug } from '@portside/core';

export interface TraefikLabelInput {
  /** The project's own slug, e.g. "my-app" — also the stable hostname, so must be unique. */
  projectSlug: string;
  /** Unique per deployment — namespaces the router/service names, not the hostname. */
  deploymentId: string;
  /** The container's internal port Traefik should forward to. */
  port: number;
  /** Base domain to route under. Defaults to "localhost" for local dev. */
  domain?: string;
  /**
   * Router priority — when a redeploy's container is still starting up
   * alongside the outgoing one, both match the same Host() rule and Traefik
   * picks whichever router has the higher priority. Callers doing a
   * blue/green swap should pass a monotonically increasing value (e.g.
   * Date.now()) so each new deployment always outranks the one it's
   * replacing. Defaults to 1.
   */
  priority?: number;
  /**
   * An additional domain that should also route to this deployment,
   * alongside the platform-assigned `<slug>.<domain>` hostname — e.g. a
   * user's own "myapp.com". Adds a second Host() match to the same router
   * rather than a separate router, so both hostnames share one priority.
   */
  customDomain?: string;
}

export interface TraefikLabelResult {
  labels: Record<string, string>;
  hostname: string;
  customDomain?: string;
  routerName: string;
  serviceName: string;
}

const RESERVED_SLUGS = new Set(['api', 'app', 'traefik', 'www', 'admin', 'localhost']);
const MIN_PORT = 1;
const MAX_PORT = 65535;
// Deliberately conservative (letters/digits/hyphens/dots, must contain a
// dot): customDomain is user-supplied and gets embedded directly inside a
// backtick-quoted Traefik rule string, so anything permitting a backtick,
// parenthesis, or `||` would be a rule-injection vector into the router
// config, not just a formatting concern.
const DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Same check `buildTraefikLabels` applies to `customDomain`, exported so
 * the API can reject a malformed domain immediately (400) instead of the
 * user only finding out when a deployment fails on it later.
 */
export function isValidCustomDomain(domain: string): boolean {
  return DOMAIN_PATTERN.test(domain);
}

function shortHash(deploymentId: string): string {
  return createHash('sha256').update(deploymentId).digest('hex').slice(0, 8);
}

/**
 * Generates the full Traefik label set for one deployment's container, as a
 * pure function of its inputs — no Docker daemon or network access needed.
 *
 * The hostname is stable across every deployment of a project (just the
 * slug — already globally unique, enforced at the DB layer — needs no
 * extra hash), so redeploys and rollbacks keep serving the same URL. Router
 * and service *names* stay namespaced per-deployment, so two deployments'
 * containers can coexist under Traefik at once, each with their own router
 * matching the same Host() rule — see `priority` for how that's resolved.
 */
export function buildTraefikLabels(input: TraefikLabelInput): TraefikLabelResult {
  const slug = sanitizeSlug(input.projectSlug);
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`"${slug}" is a reserved project slug and cannot be used for routing`);
  }
  if (!input.deploymentId.trim()) {
    throw new Error('deploymentId must not be empty');
  }
  if (!Number.isInteger(input.port) || input.port < MIN_PORT || input.port > MAX_PORT) {
    throw new Error(
      `port must be an integer between ${MIN_PORT} and ${MAX_PORT}, got ${input.port}`,
    );
  }
  const customDomain = input.customDomain?.trim() || undefined;
  if (customDomain && !DOMAIN_PATTERN.test(customDomain)) {
    throw new Error(`customDomain "${customDomain}" is not a valid hostname`);
  }

  const domain = input.domain?.trim() || 'localhost';
  const priority = input.priority ?? 1;
  const hash = shortHash(input.deploymentId);
  const hostname = `${slug}.${domain}`;
  const name = `portside-${slug}-${hash}`;
  const rule = customDomain
    ? `Host(\`${hostname}\`) || Host(\`${customDomain}\`)`
    : `Host(\`${hostname}\`)`;

  const labels: Record<string, string> = {
    'traefik.enable': 'true',
    [`traefik.http.routers.${name}.rule`]: rule,
    [`traefik.http.routers.${name}.entrypoints`]: 'web',
    [`traefik.http.routers.${name}.priority`]: String(priority),
    [`traefik.http.services.${name}.loadbalancer.server.port`]: String(input.port),
    'portside.managed': 'true',
    'portside.project-slug': slug,
    'portside.deployment-id': input.deploymentId,
  };

  return { labels, hostname, customDomain, routerName: name, serviceName: name };
}
