import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DetectedType } from '@portside/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// packages/docker/src -> packages/docker -> packages -> repo root -> templates
const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', '..', 'templates');

const TEMPLATE_FILES: Partial<Record<DetectedType, string>> = {
  STATIC: 'Dockerfile.static.hbs',
  NODE: 'Dockerfile.node.hbs',
};

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return vars[key]!;
  });
}

/**
 * Renders the Dockerfile for a detected project type. DOCKER projects use
 * their own Dockerfile as-is and never reach this function; STATIC_BUILT
 * isn't wired up yet.
 */
export function renderDockerfile(type: DetectedType, vars: Record<string, string>): string {
  const file = TEMPLATE_FILES[type];
  if (!file) {
    throw new Error(`No Dockerfile template for project type "${type}"`);
  }
  const template = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8');
  return renderTemplate(template, vars);
}
