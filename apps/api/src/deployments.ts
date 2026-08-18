import type { FastifyInstance } from 'fastify';
import { getPrismaClient } from '@portside/db';
import { Redis } from 'ioredis';
import { currentUserId, requireAuth } from './auth.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(REDIS_URL);

/** The worker polls this key between pipeline stages to honor cancellation. */
export function cancellationKey(deploymentId: string): string {
  return `portside:cancel:${deploymentId}`;
}

export async function registerDeploymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/deployments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const prisma = getPrismaClient();
    const deployment = await prisma.deployment.findFirst({
      where: { id, project: { userId: currentUserId(req) } },
    });
    if (!deployment) {
      return reply.code(404).send({ error: 'Deployment not found' });
    }
    return deployment;
  });

  app.post('/api/deployments/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const prisma = getPrismaClient();
    const deployment = await prisma.deployment.findFirst({
      where: { id, project: { userId: currentUserId(req) } },
    });
    if (!deployment) {
      return reply.code(404).send({ error: 'Deployment not found' });
    }
    if (['LIVE', 'SUPERSEDED', 'STOPPED', 'FAILED', 'CANCELLED'].includes(deployment.status)) {
      return reply
        .code(409)
        .send({ error: `Cannot cancel a deployment in status ${deployment.status}` });
    }

    // Set with a TTL so a stale flag can never linger past a deployment's own
    // 10-minute timeout if the worker somehow never checks it.
    await redis.set(cancellationKey(id), '1', 'EX', 600);
    reply.code(202).send({ cancelling: true });
  });
}
