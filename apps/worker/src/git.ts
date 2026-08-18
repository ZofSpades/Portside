import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CloneResult {
  /** Temp credential file written for this clone, if any — caller must delete it. */
  credentialHelperFile?: string;
}

/**
 * Clones a single branch at depth 1. When a GitHub token is supplied, it's
 * written to a 0600 temp file read by git's credential.helper rather than
 * embedded in the repo URL — the URL ends up in git's own error output on
 * failure, which would otherwise leak the token into build logs.
 */
export async function cloneRepo(
  repoUrl: string,
  branch: string,
  destDir: string,
  githubToken?: string,
): Promise<CloneResult> {
  const args: string[] = [];
  let credentialHelperFile: string | undefined;

  if (githubToken) {
    credentialHelperFile = path.join(os.tmpdir(), `portside-git-cred-${randomUUID()}`);
    await fsp.writeFile(
      credentialHelperFile,
      `https://x-access-token:${githubToken}@github.com\n`,
      { mode: 0o600 },
    );
    args.push('-c', `credential.helper=store --file=${credentialHelperFile}`);
  }

  args.push('clone', '--depth', '1', '--single-branch', '--branch', branch, repoUrl, destDir);

  try {
    await execFileAsync('git', args);
  } catch (err) {
    throw new Error(`git clone failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { credentialHelperFile };
}
