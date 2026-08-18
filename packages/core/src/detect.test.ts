import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectNodeEntrypoint, detectProjectType } from './detect.js';

describe('detectProjectType', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'portside-detect-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects DOCKER when a Dockerfile is present, even alongside package.json', () => {
    writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(detectProjectType(dir).type).toBe('DOCKER');
  });

  it('detects NODE when package.json has a start script', () => {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { start: 'node index.js' } }),
    );
    expect(detectProjectType(dir).type).toBe('NODE');
  });

  it('detects NODE when package.json has no scripts at all', () => {
    writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(detectProjectType(dir).type).toBe('NODE');
  });

  it('detects STATIC_BUILT when there is a build script, no start script, and a dist/ dir', () => {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'vite build' } }),
    );
    mkdirSync(path.join(dir, 'dist'));
    expect(detectProjectType(dir).type).toBe('STATIC_BUILT');
  });

  it('falls back to NODE when there is a build script but no matching output dir', () => {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'vite build' } }),
    );
    expect(detectProjectType(dir).type).toBe('NODE');
  });

  it('detects STATIC when there is a bare index.html and no package.json', () => {
    writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    expect(detectProjectType(dir).type).toBe('STATIC');
  });

  it('throws when nothing recognizable is present', () => {
    expect(() => detectProjectType(dir)).toThrow(/Could not detect project type/);
  });

  it('prefers Dockerfile over a bare index.html', () => {
    writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    expect(detectProjectType(dir).type).toBe('DOCKER');
  });
});

describe('detectNodeEntrypoint', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'portside-entrypoint-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns package.json "main" when set', () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'server.js' }));
    expect(detectNodeEntrypoint(dir)).toBe('server.js');
  });

  it('defaults to index.js when "main" is not set', () => {
    writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(detectNodeEntrypoint(dir)).toBe('index.js');
  });

  it('defaults to index.js when there is no package.json at all', () => {
    expect(detectNodeEntrypoint(dir)).toBe('index.js');
  });
});
