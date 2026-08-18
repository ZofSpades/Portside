import { describe, expect, it } from 'vitest';
import { renderDockerfile, renderTemplate } from './templates.js';

describe('renderTemplate', () => {
  it('substitutes all placeholders', () => {
    expect(renderTemplate('{{A}}-{{B}}', { A: 'x', B: 'y' })).toBe('x-y');
  });

  it('substitutes repeated placeholders', () => {
    expect(renderTemplate('{{A}} {{A}}', { A: 'x' })).toBe('x x');
  });

  it('throws on a missing variable', () => {
    expect(() => renderTemplate('{{MISSING}}', {})).toThrow(/Missing template variable: MISSING/);
  });

  it('leaves templates with no placeholders untouched', () => {
    expect(renderTemplate('FROM nginx:1.27-alpine', {})).toBe('FROM nginx:1.27-alpine');
  });
});

describe('renderDockerfile', () => {
  it('renders the static template with no variables required', () => {
    const rendered = renderDockerfile('STATIC', {});
    expect(rendered).toContain('FROM nginx');
    expect(rendered).toContain('COPY . /usr/share/nginx/html');
  });

  it('renders the node template with PORT and ENTRYPOINT filled in', () => {
    const rendered = renderDockerfile('NODE', { PORT: '8080', ENTRYPOINT: 'index.js' });
    expect(rendered).toContain('ENV PORT=8080');
    expect(rendered).toContain('EXPOSE 8080');
    expect(rendered).toContain('CMD ["node", "index.js"]');
  });

  it('throws when the node template is rendered without its required variables', () => {
    expect(() => renderDockerfile('NODE', {})).toThrow(/Missing template variable/);
  });

  it('throws for a project type with no template (DOCKER)', () => {
    expect(() => renderDockerfile('DOCKER', {})).toThrow(/No Dockerfile template/);
  });

  it('throws for a project type with no template (STATIC_BUILT)', () => {
    expect(() => renderDockerfile('STATIC_BUILT', {})).toThrow(/No Dockerfile template/);
  });
});
