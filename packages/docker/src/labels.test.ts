import { describe, expect, it } from 'vitest';
import { buildTraefikLabels } from './labels.js';

const base = { projectSlug: 'my-app', deploymentId: 'dep-1', port: 8080 };

describe('buildTraefikLabels', () => {
  it('generates a full, well-formed label set', () => {
    const result = buildTraefikLabels(base);

    expect(result.labels['traefik.enable']).toBe('true');
    expect(result.labels['portside.managed']).toBe('true');
    expect(result.labels['portside.project-slug']).toBe('my-app');
    expect(result.labels['portside.deployment-id']).toBe('dep-1');
    expect(result.labels[`traefik.http.routers.${result.routerName}.rule`]).toBe(
      `Host(\`${result.hostname}\`)`,
    );
    expect(result.labels[`traefik.http.routers.${result.routerName}.entrypoints`]).toBe('web');
    expect(
      result.labels[`traefik.http.services.${result.serviceName}.loadbalancer.server.port`],
    ).toBe('8080');
  });

  it('derives a deterministic hostname from the slug alone', () => {
    const a = buildTraefikLabels(base);
    const b = buildTraefikLabels(base);
    expect(a.hostname).toBe(b.hostname);
    expect(a.hostname).toBe('my-app.localhost');
  });

  it('keeps the hostname stable across different deploymentIds of the same project', () => {
    // This is what makes redeploys and rollbacks keep serving the same URL,
    // and what a blue/green swap needs: both the outgoing and incoming
    // deployment's routers match the exact same Host() rule.
    const a = buildTraefikLabels({ ...base, deploymentId: 'dep-1' });
    const b = buildTraefikLabels({ ...base, deploymentId: 'dep-2' });
    expect(a.hostname).toBe(b.hostname);
  });

  it('still namespaces router/service names per deployment, so two can coexist', () => {
    const a = buildTraefikLabels({ ...base, deploymentId: 'dep-1' });
    const b = buildTraefikLabels({ ...base, deploymentId: 'dep-2' });
    expect(a.routerName).not.toBe(b.routerName);
    expect(a.serviceName).not.toBe(b.serviceName);
  });

  it('sanitizes slugs with uppercase, spaces, and unsafe characters', () => {
    const result = buildTraefikLabels({ ...base, projectSlug: 'My Cool App!!' });
    expect(result.hostname).toBe('my-cool-app.localhost');
  });

  it('collapses repeated separators and trims leading/trailing hyphens', () => {
    const result = buildTraefikLabels({ ...base, projectSlug: '--Foo___Bar--' });
    expect(result.hostname).toBe('foo-bar.localhost');
  });

  it('rejects a slug with no usable characters', () => {
    expect(() => buildTraefikLabels({ ...base, projectSlug: '!!!' })).toThrow(/no usable/);
  });

  it('rejects reserved slugs', () => {
    for (const reserved of ['api', 'app', 'traefik', 'www', 'admin', 'localhost']) {
      expect(() => buildTraefikLabels({ ...base, projectSlug: reserved })).toThrow(/reserved/);
    }
  });

  it('rejects an empty deploymentId', () => {
    expect(() => buildTraefikLabels({ ...base, deploymentId: '  ' })).toThrow(/deploymentId/);
  });

  it.each([0, -1, 1.5, 65536, NaN])('rejects an invalid port: %s', (port) => {
    expect(() => buildTraefikLabels({ ...base, port })).toThrow(/port must be/);
  });

  it('accepts the valid port boundaries', () => {
    expect(() => buildTraefikLabels({ ...base, port: 1 })).not.toThrow();
    expect(() => buildTraefikLabels({ ...base, port: 65535 })).not.toThrow();
  });

  it('defaults to priority 1 and the localhost domain', () => {
    const result = buildTraefikLabels(base);
    expect(result.labels[`traefik.http.routers.${result.routerName}.priority`]).toBe('1');
    expect(result.hostname.endsWith('.localhost')).toBe(true);
  });

  it('honors an explicit priority and domain override', () => {
    const result = buildTraefikLabels({ ...base, priority: 42, domain: 'portside.dev' });
    expect(result.labels[`traefik.http.routers.${result.routerName}.priority`]).toBe('42');
    expect(result.hostname.endsWith('.portside.dev')).toBe(true);
  });

  it('falls back to localhost when domain is blank', () => {
    const result = buildTraefikLabels({ ...base, domain: '   ' });
    expect(result.hostname.endsWith('.localhost')).toBe(true);
  });
});
