import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { registerAuthRoutes } from './auth.js';
import { registerDeploymentRoutes } from './deployments.js';
import { runHealthCheck } from './health.js';
import { registerLogRoutes } from './logs.js';
import { registerProjectRoutes } from './projects.js';
import { registerSession } from './session.js';

const PORT = Number(process.env.PORT ?? 3001);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DOCKER_SOCKET_PROXY_HOST = process.env.DOCKER_SOCKET_PROXY_HOST ?? 'tcp://localhost:2375';

function webAppOrigin(): string {
  const protocol = process.env.PORTSIDE_APP_PROTOCOL ?? 'http';
  const domain = process.env.PORTSIDE_BASE_DOMAIN ?? 'localhost';
  return `${protocol}://app.${domain}`;
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // Never log request/response bodies — env var values and OAuth tokens
    // can appear in them.
    redact: ['req.body', 'res.body'],
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

  // The dashboard (app.localhost) and API (api.localhost) are different
  // origins; the session cookie needs credentialed cross-origin requests to
  // reach the API at all, for the log stream's EventSource above all.
  await app.register(cors, { origin: webAppOrigin(), credentials: true });
  await registerSession(app);
  await app.register(multipart);
  // Each of these is registered as a Fastify plugin (not called directly) so
  // its own preHandler hooks — notably requireAuth — stay scoped to routes
  // registered inside it, instead of leaking onto sibling routes or /health.
  await app.register(registerAuthRoutes);
  await app.register(registerProjectRoutes);
  await app.register(registerDeploymentRoutes);
  await app.register(registerLogRoutes);

  try {
    await app.listen({ host: '0.0.0.0', port: PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
