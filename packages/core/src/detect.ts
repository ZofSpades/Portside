import fs from 'node:fs';
import path from 'node:path';

export type DetectedType = 'STATIC' | 'STATIC_BUILT' | 'NODE' | 'DOCKER';

export interface DetectionResult {
  type: DetectedType;
  reason: string;
}

const STATIC_OUTPUT_DIRS = ['dist', 'build', 'out'];

interface PackageJsonShape {
  scripts?: Record<string, string>;
  main?: string;
}

function readPackageJson(rootDir: string): PackageJsonShape | undefined {
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return undefined;
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJsonShape;
}

/**
 * Detects a project's type from its root directory, in priority order:
 * a Dockerfile always wins, then package.json (split into a built-static
 * vs. a running Node service based on its scripts), then a bare index.html.
 */
export function detectProjectType(rootDir: string): DetectionResult {
  if (fs.existsSync(path.join(rootDir, 'Dockerfile'))) {
    return { type: 'DOCKER', reason: 'Dockerfile found at project root' };
  }

  const pkg = readPackageJson(rootDir);
  if (pkg) {
    const scripts = pkg.scripts ?? {};
    if (scripts.build && !scripts.start) {
      const outDir = STATIC_OUTPUT_DIRS.find((dir) => fs.existsSync(path.join(rootDir, dir)));
      if (outDir) {
        return {
          type: 'STATIC_BUILT',
          reason: `package.json has a build script and no start script; static output found in ${outDir}/`,
        };
      }
    }
    return { type: 'NODE', reason: 'package.json found' };
  }

  if (fs.existsSync(path.join(rootDir, 'index.html'))) {
    return { type: 'STATIC', reason: 'index.html found at project root, no package.json' };
  }

  throw new Error(
    'Could not detect project type: no Dockerfile, package.json, or index.html found at project root',
  );
}

/** The entrypoint script for a NODE project: package.json's "main", or index.js by default. */
export function detectNodeEntrypoint(rootDir: string): string {
  const pkg = readPackageJson(rootDir);
  return pkg?.main ?? 'index.js';
}
