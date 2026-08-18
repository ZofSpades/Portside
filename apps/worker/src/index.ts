// Deploy-job worker. BullMQ queue processing is still to come — for now this
// proves the service starts, resolves its workspace dependencies, and
// connects to Redis inside docker-compose.
import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function main() {
  const redis = new Redis(REDIS_URL);
  redis.on('error', (err: Error) => {
    console.error('[worker] redis error', err);
  });

  await redis.connect();
  console.log('[worker] connected to redis; queue processing not wired up yet');

  process.on('SIGTERM', async () => {
    await redis.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[worker] fatal startup error', err);
  process.exit(1);
});
