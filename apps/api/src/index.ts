import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { runHealthCheck } from './health.js';

const PORT = Number(process.env.PORT ?? 3001);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DOCKER_SOCKET_PROXY_HOST = process.env.DOCKER_SOCKET_PROXY_HOST ?? 'tcp://localhost:2375';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
});

const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

app.get('/health', async (_req, reply) => {
  const result = await runHealthCheck({
    redis,
    dockerSocketProxyUrl: DOCKER_SOCKET_PROXY_HOST,
  });
  reply.code(result.ok ? 200 : 503).send(result);
});

async function start() {
  try {
    await redis.connect();
  } catch (err) {
    app.log.warn({ err }, 'redis not reachable at startup; /health will report it');
  }

  try {
    await app.listen({ host: '0.0.0.0', port: PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
