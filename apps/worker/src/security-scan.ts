import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCAN_TIMEOUT_MS = 120_000;
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

interface TrivyResult {
  Results?: Array<{
    Vulnerabilities?: Array<{ Severity: (typeof SEVERITIES)[number] }>;
  }>;
}

export interface ScanSummary {
  counts: Record<(typeof SEVERITIES)[number], number>;
  total: number;
}

function summarize(result: TrivyResult): ScanSummary {
  const counts: ScanSummary['counts'] = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const target of result.Results ?? []) {
    for (const vuln of target.Vulnerabilities ?? []) {
      counts[vuln.Severity] = (counts[vuln.Severity] ?? 0) + 1;
    }
  }
  const total = SEVERITIES.reduce((sum, sev) => sum + counts[sev], 0);
  return { counts, total };
}

export function formatSummary(summary: ScanSummary): string {
  if (summary.total === 0) return 'Security scan: no known vulnerabilities found.';
  const parts = SEVERITIES.filter((sev) => summary.counts[sev] > 0).map(
    (sev) => `${summary.counts[sev]} ${sev}`,
  );
  return `Security scan: ${parts.join(', ')} (${summary.total} total).`;
}

/**
 * Scans a built image with Trivy and returns a severity breakdown. Never
 * throws — a scan failure (DB download hiccup, trivy missing, timeout) is
 * logged and treated as "couldn't scan," not a reason to fail the deploy.
 * This is reporting, not a gate: nothing here blocks a deployment from
 * going live, however many vulnerabilities it finds.
 */
export async function scanImage(imageTag: string): Promise<ScanSummary | null> {
  try {
    const { stdout } = await execFileAsync(
      'trivy',
      [
        'image',
        '--format',
        'json',
        '--severity',
        SEVERITIES.join(','),
        '--exit-code',
        '0',
        '--quiet',
        imageTag,
      ],
      { timeout: SCAN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as TrivyResult;
    return summarize(parsed);
  } catch (err) {
    console.error(`[worker] trivy scan failed for ${imageTag}`, err);
    return null;
  }
}
