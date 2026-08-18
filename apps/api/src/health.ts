import http from 'node:http';
import { URL } from 'node:url';
import { getPrismaClient } from '@portside/db';
import { type Redis } from 'ioredis';

export interface HealthCheckResult {
  ok: boolean;
  checks: {
    database: CheckStatus;
    redis: CheckStatus;
    docker: CheckStatus;
  };
}

interface CheckStatus {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

async function timed(fn: () => Promise<void>): Promise<CheckStatus> {
  const start = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkDatabase(): Promise<CheckStatus> {
  return timed(async () => {
    const prisma = getPrismaClient();
    await prisma.$queryRaw`SELECT 1`;
  });
}

async function checkRedis(redis: Redis): Promise<CheckStatus> {
  return timed(async () => {
    const pong = await redis.ping();
    if (pong !== 'PONG') throw new Error(`unexpected ping response: ${pong}`);
  });
}

function checkDocker(socketProxyUrl: string): Promise<CheckStatus> {
  return timed(
    () =>
      new Promise<void>((resolve, reject) => {
        const target = new URL('/_ping', socketProxyUrl.replace(/^tcp:/, 'http:'));
        const req = http.get(target, { timeout: 3000 }, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`docker daemon ping returned ${res.statusCode}`));
        });
        req.on('timeout', () => req.destroy(new Error('docker daemon ping timed out')));
        req.on('error', reject);
      }),
  );
}

export async function runHealthCheck(deps: {
  redis: Redis;
  dockerSocketProxyUrl: string;
}): Promise<HealthCheckResult> {
  const [database, redis, docker] = await Promise.all([
    checkDatabase(),
    checkRedis(deps.redis),
    checkDocker(deps.dockerSocketProxyUrl),
  ]);

  return {
    ok: database.ok && redis.ok && docker.ok,
    checks: { database, redis, docker },
  };
}
