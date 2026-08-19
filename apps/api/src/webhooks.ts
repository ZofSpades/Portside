import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPrismaClient } from '@portside/db';
import type { FastifyInstance } from 'fastify';
import { deployQueue } from './projects.js';

function verifySignature(secret: string, payload: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const provided = header.slice('sha256='.length);
  // Both sides are fixed-length hex digests of the same HMAC, so a length
  // mismatch here means a malformed header, not a real signature attempt —
  // safe to short-circuit before the constant-time comparison.
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

/**
 * Receives GitHub's push webhook and enqueues a deploy. Unlike every other
 * route in the API, this one is intentionally NOT behind requireAuth —
 * GitHub can't send our session cookie. It authenticates the request
 * itself instead, via the same HMAC-SHA256 scheme GitHub's own webhook
 * delivery uses (see docs/writeups for the mechanics).
 */
export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (instance) => {
    // Scoped to just this route: capture the raw request bytes instead of
    // Fastify's usual auto-parsed JSON. GitHub signs the exact bytes it
    // sent — re-serializing a parsed-then-JSON.stringify'd object isn't
    // guaranteed to produce an identical byte sequence (key order,
    // whitespace), which would break signature verification.
    instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    instance.post<{ Params: { projectId: string } }>(
      '/api/webhooks/github/:projectId',
      async (req, reply) => {
        const prisma = getPrismaClient();
        const project = await prisma.project.findUnique({
          where: { id: req.params.projectId },
        });
        if (!project?.webhookSecret) {
          return reply.code(404).send({ error: 'Webhook not configured for this project' });
        }

        const rawBody = req.body as Buffer;
        const signatureHeader = req.headers['x-hub-signature-256'];
        const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
        if (!verifySignature(project.webhookSecret, rawBody, signature)) {
          return reply.code(401).send({ error: 'Invalid signature' });
        }

        const eventHeader = req.headers['x-github-event'];
        const event = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;
        if (event !== 'push') {
          return reply.code(202).send({ ignored: `event "${event}" is not push` });
        }

        let payload: { ref?: string };
        try {
          payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
          return reply.code(400).send({ error: 'Invalid JSON payload' });
        }

        const expectedRef = `refs/heads/${project.branch}`;
        if (payload.ref !== expectedRef) {
          return reply.code(202).send({ ignored: `push to ${payload.ref}, not ${expectedRef}` });
        }

        const deployment = await prisma.deployment.create({
          data: { projectId: project.id, status: 'QUEUED', trigger: 'WEBHOOK' },
        });
        await deployQueue.add('deploy', { deploymentId: deployment.id }, { jobId: deployment.id });
        reply.code(202).send({ deploymentId: deployment.id });
      },
    );
  });
}
