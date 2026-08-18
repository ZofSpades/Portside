import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { runJanitor } from './janitor.js';
import { runDeployPipeline } from './pipeline.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const JANITOR_INTERVAL_MS = 15 * 60 * 1000;
const DEPLOY_CONCURRENCY = 2;

async function main() {
  // BullMQ needs its own Redis connection per Worker (managed internally),
  // but the deploy pipeline also needs one directly for locks/cancellation
  // flags, so this one is ours to own and close on shutdown.
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  redis.on('error', (err: Error) => {
    console.error('[worker] redis error', err);
  });

  const worker = new Worker(
    'deploys',
    async (job) => {
      const { deploymentId } = job.data as { deploymentId: string };
      console.log(`[worker] starting deployment ${deploymentId}`);
      await runDeployPipeline(deploymentId, redis);
      console.log(`[worker] deployment ${deploymentId} is live`);
    },
    { connection: { url: REDIS_URL }, concurrency: DEPLOY_CONCURRENCY },
  );

  worker.on('failed', (job, err) => {
    console.error(`[worker] deployment ${job?.data?.deploymentId ?? '?'} failed:`, err.message);
  });

  const janitorTimer = setInterval(() => {
    runJanitor()
      .then(({ containersRemoved, imagesRemoved }) => {
        if (containersRemoved || imagesRemoved) {
          console.log(
            `[janitor] removed ${containersRemoved} container(s), ${imagesRemoved} image(s)`,
          );
        }
      })
      .catch((err) => console.error('[janitor] run failed', err));
  }, JANITOR_INTERVAL_MS);

  console.log('[worker] listening on the "deploys" queue');

  process.on('SIGTERM', async () => {
    clearInterval(janitorTimer);
    await worker.close();
    await redis.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[worker] fatal startup error', err);
  process.exit(1);
});
