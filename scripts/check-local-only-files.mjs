#!/usr/bin/env node
// Fails if any local-only tooling/config file is staged or tracked in git.
// Mirrors the patterns in .gitignore — this is the enforcement backstop for
// cases where someone force-adds a file past the ignore rules.
import { execSync } from 'node:child_process';

const FORBIDDEN_PATTERNS = [
  /(^|\/)CLAUDE\.md$/i,
  /(^|\/)\.claude\//i,
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)\.cursor\//i,
  /(^|\/)\.cursorrules$/i,
  /(^|\/)\.windsurfrules$/i,
  /(^|\/)\.aider/i,
  /(^|\/)\.github\/copilot-instructions\.md$/i,
  /\.prompt\.md$/i,
  /(^|\/)prompts\//i,
  /(^|\/)notes\//i,
  /(^|\/)\.plan\//i,
  /(^|\/)PROMPT.*\.md$/i,
  /(^|\/)BRIEF.*\.md$/i,
  /(^|\/)plan\.md$/i,
  /(^|\/)docs\/CHANGELOG\.md$/i,
  /(^|\/)docs\/DECISIONS\.md$/i,
  /(^|\/)docs\/ROADMAP\.md$/i,
];

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listFiles() {
  const staged = run('git diff --cached --name-only --diff-filter=ACMR');
  const tracked = run('git ls-files');
  return [...new Set([...staged, ...tracked])];
}

const files = listFiles();
const offenders = files.filter((f) => FORBIDDEN_PATTERNS.some((re) => re.test(f)));

if (offenders.length > 0) {
  console.error('✗ Local-only file(s) staged or tracked — these must stay out of the repo:');
  for (const f of offenders) console.error(`  - ${f}`);
  console.error('\nRemove them (git rm --cached <file>) or add an explicit .gitignore rule.');
  process.exit(1);
}

console.log('✓ Clean — no local-only files tracked.');
