import { createHash } from 'node:crypto';

export interface TraefikLabelInput {
  /** The project's own slug, e.g. "my-app". Gets sanitized and combined with a hash. */
  projectSlug: string;
  /** Unique per deployment — used to derive both the hostname hash and resource names. */
  deploymentId: string;
  /** The container's internal port Traefik should forward to. */
  port: number;
  /** Base domain to route under. Defaults to "localhost" for local dev. */
  domain?: string;
  /** Router priority — higher wins when multiple routers could match the same host. Defaults to 1. */
  priority?: number;
}

export interface TraefikLabelResult {
  labels: Record<string, string>;
  hostname: string;
  routerName: string;
  serviceName: string;
}

const RESERVED_SLUGS = new Set(['api', 'app', 'traefik', 'www', 'admin', 'localhost']);
const MIN_PORT = 1;
const MAX_PORT = 65535;

function sanitizeSlug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!cleaned) {
    throw new Error(`projectSlug "${input}" contains no usable alphanumeric characters`);
  }
  return cleaned;
}

function shortHash(deploymentId: string): string {
  return createHash('sha256').update(deploymentId).digest('hex').slice(0, 8);
}

/**
 * Generates the full Traefik label set for one deployment's container, as a
 * pure function of its inputs — no Docker daemon or network access needed.
 * Router/service names are namespaced per-deployment so a redeploy's labels
 * never collide with the container it's replacing.
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

  const domain = input.domain?.trim() || 'localhost';
  const priority = input.priority ?? 1;
  const hash = shortHash(input.deploymentId);
  const hostname = `${slug}-${hash}.${domain}`;
  const name = `portside-${slug}-${hash}`;

  const labels: Record<string, string> = {
    'traefik.enable': 'true',
    [`traefik.http.routers.${name}.rule`]: `Host(\`${hostname}\`)`,
    [`traefik.http.routers.${name}.entrypoints`]: 'web',
    [`traefik.http.routers.${name}.priority`]: String(priority),
    [`traefik.http.services.${name}.loadbalancer.server.port`]: String(input.port),
    'portside.managed': 'true',
    'portside.project-slug': slug,
    'portside.deployment-id': input.deploymentId,
  };

  return { labels, hostname, routerName: name, serviceName: name };
}
