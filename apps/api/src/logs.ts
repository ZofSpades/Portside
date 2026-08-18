import { logStreamKey } from '@portside/core';
import { getPrismaClient } from '@portside/db';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { currentUserId, requireAuth } from './auth.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const BLOCK_MS = 5000;
const TERMINAL_STATUSES = new Set(['LIVE', 'SUPERSEDED', 'STOPPED', 'FAILED', 'CANCELLED']);

type StreamEntry = [id: string, fields: string[]];

function lineFromFields(fields: string[]): string {
  const idx = fields.indexOf('line');
  return idx >= 0 ? (fields[idx + 1] ?? '') : '';
}

/**
 * SSE build/deploy log stream, backed by a Redis Stream the worker writes
 * to. Resumes from `Last-Event-ID` (sent automatically by EventSource on
 * reconnect) so a mid-build refresh replays the full log with no gaps
 * instead of picking up wherever the new connection happens to start.
 */
export async function registerLogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
    '/api/deployments/:id/logs/stream',
    async (req, reply) => {
      const { id } = req.params;
      const prisma = getPrismaClient();
      const deployment = await prisma.deployment.findFirst({
        where: { id, project: { userId: currentUserId(req) } },
      });
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      // reply.hijack() skips Fastify's own response pipeline entirely — that
      // includes headers other plugins (notably @fastify/cors) already
      // computed via reply.header() in an onRequest hook before this handler
      // ran. Carry those over explicitly or the browser's cross-origin
      // EventSource gets a response with no CORS headers at all.
      const corsHeaders = reply.getHeaders();
      reply.hijack();
      const res = reply.raw;
      for (const [key, value] of Object.entries(corsHeaders)) {
        if (value !== undefined) res.setHeader(key, value);
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Disable any intermediary buffering (nginx-style proxies) that
        // would otherwise hold the stream back until it closes.
        'X-Accel-Buffering': 'no',
      });

      const key = logStreamKey(id);
      // A dedicated connection, since XREAD BLOCK holds it for the whole
      // life of this request — it must never share a pool with ordinary
      // request/response commands elsewhere in the app.
      const redis = new Redis(REDIS_URL);

      let closed = false;
      req.raw.on('close', () => {
        closed = true;
        redis.disconnect();
      });

      const headerLastId = req.headers['last-event-id'];
      const fromHeader = Array.isArray(headerLastId) ? headerLastId[0] : headerLastId;
      let lastId = fromHeader ?? req.query.lastEventId ?? '0';

      function send(entryId: string, line: string): void {
        res.write(`id: ${entryId}\ndata: ${line}\n\n`);
      }

      async function drain(): Promise<void> {
        const start = lastId === '0' ? '-' : `(${lastId}`;
        const entries = (await redis.xrange(key, start, '+')) as StreamEntry[];
        for (const [entryId, fields] of entries) {
          send(entryId, lineFromFields(fields));
          lastId = entryId;
        }
      }

      try {
        await drain();

        while (!closed) {
          const current = await prisma.deployment.findUnique({ where: { id } });
          if (!current || TERMINAL_STATUSES.has(current.status)) {
            await drain(); // catch anything written between the last read and now
            res.write(`event: done\ndata: ${current?.status ?? 'UNKNOWN'}\n\n`);
            break;
          }

          const result = (await redis.xread('BLOCK', BLOCK_MS, 'STREAMS', key, lastId)) as
            [string, StreamEntry[]][] | null;
          if (!result) {
            if (!closed) res.write(': heartbeat\n\n');
            continue;
          }
          const [, entries] = result[0]!;
          for (const [entryId, fields] of entries) {
            send(entryId, lineFromFields(fields));
            lastId = entryId;
          }
        }
      } catch (err) {
        req.log.error({ err }, 'log stream error');
      } finally {
        redis.disconnect();
        res.end();
      }
    },
  );
}
