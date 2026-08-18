import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { encrypt, sanitizeSlug, safeExtractZip } from '@portside/core';
import { getPrismaClient } from '@portside/db';
import { Queue } from 'bullmq';
import { currentUserId, requireAuth } from './auth.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const WORKSPACES_ROOT = process.env.PORTSIDE_WORKSPACES_ROOT ?? '/var/portside/workspaces';

export const deployQueue = new Queue('deploys', { connection: { url: REDIS_URL } });

function requireEncryptionKey(): string {
  const key = process.env.PORTSIDE_ENCRYPTION_KEY;
  if (!key) throw new Error('PORTSIDE_ENCRYPTION_KEY is not set');
  return key;
}

/** Turns a Buffer into the concrete Uint8Array<ArrayBuffer> shape Prisma's Bytes fields expect. */
function toBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(buffer);
}

async function uniqueSlug(baseName: string): Promise<string> {
  const prisma = getPrismaClient();
  const base = sanitizeSlug(baseName);
  let candidate = base;
  let suffix = 2;
  while (await prisma.project.findUnique({ where: { slug: candidate } })) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function loadProjectOr404(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const prisma = getPrismaClient();
  const project = await prisma.project.findFirst({ where: { id, userId: currentUserId(req) } });
  if (!project) {
    reply.code(404).send({ error: 'Project not found' });
    return null;
  }
  return project;
}

async function enqueueDeploy(projectId: string, trigger: 'MANUAL' | 'REDEPLOY') {
  const prisma = getPrismaClient();
  const deployment = await prisma.deployment.create({
    data: { projectId, status: 'QUEUED', trigger },
  });
  await deployQueue.add('deploy', { deploymentId: deployment.id }, { jobId: deployment.id });
  return deployment;
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });

  app.addHook('preHandler', requireAuth);

  app.post<{ Body: { name: string; repoUrl: string; branch?: string } }>(
    '/api/projects',
    async (req, reply) => {
      const { name, repoUrl, branch } = req.body ?? {};
      if (!name?.trim() || !repoUrl?.trim()) {
        return reply.code(400).send({ error: 'name and repoUrl are required' });
      }

      const prisma = getPrismaClient();
      const project = await prisma.project.create({
        data: {
          userId: currentUserId(req),
          name: name.trim(),
          slug: await uniqueSlug(name),
          sourceType: 'GIT',
          repoUrl: repoUrl.trim(),
          branch: branch?.trim() || 'main',
        },
      });

      reply.code(201).send(project);
    },
  );

  app.post('/api/projects/zip', async (req, reply) => {
    const file = await req.file({ limits: { fileSize: 50 * 1024 * 1024 } });
    if (!file) {
      return reply.code(400).send({ error: 'A zip file upload is required' });
    }
    const name = (file.fields.name as { value?: string } | undefined)?.value?.trim();
    if (!name) {
      return reply.code(400).send({ error: 'A "name" field is required' });
    }

    const tmpZipPath = path.join(os.tmpdir(), `portside-upload-${randomUUID()}.zip`);
    await fsp.writeFile(tmpZipPath, await file.toBuffer());

    const prisma = getPrismaClient();
    const project = await prisma.project.create({
      data: {
        userId: currentUserId(req),
        name,
        slug: await uniqueSlug(name),
        sourceType: 'ZIP',
      },
    });

    try {
      const destDir = path.join(WORKSPACES_ROOT, 'uploads', project.id);
      safeExtractZip(tmpZipPath, destDir);
    } catch (err) {
      await prisma.project.delete({ where: { id: project.id } });
      const message = err instanceof Error ? err.message : 'Zip extraction failed';
      return reply.code(400).send({ error: message });
    } finally {
      await fsp.rm(tmpZipPath, { force: true });
    }

    reply.code(201).send(project);
  });

  app.get('/api/projects', async (req) => {
    const prisma = getPrismaClient();
    return prisma.project.findMany({
      where: { userId: currentUserId(req) },
      orderBy: { createdAt: 'desc' },
    });
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const project = await loadProjectOr404(req, reply);
    return project ?? undefined;
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const project = await loadProjectOr404(req, reply);
    if (!project) return;

    const prisma = getPrismaClient();
    // Collected before the delete, since it cascades the Deployment rows
    // that carry the containerId/imageTag references cleanup needs.
    const deployments = await prisma.deployment.findMany({
      where: { projectId: project.id },
      select: { containerId: true, imageTag: true },
    });
    const containerIds = deployments
      .map((d) => d.containerId)
      .filter((id): id is string => id !== null);
    const imageTags = [
      ...new Set(deployments.map((d) => d.imageTag).filter((t): t is string => t !== null)),
    ];

    await prisma.project.delete({ where: { id: project.id } });

    if (project.sourceType === 'ZIP') {
      await fsp.rm(path.join(WORKSPACES_ROOT, 'uploads', project.id), {
        recursive: true,
        force: true,
      });
    }

    // The API never touches Docker directly (only the worker holds socket
    // access — see docs/SECURITY.md) — container/image teardown is enqueued
    // as a job instead, same as everything else that reaches Docker.
    if (containerIds.length > 0 || imageTags.length > 0) {
      await deployQueue.add('cleanup', { containerIds, imageTags });
    }

    reply.code(204).send();
  });

  app.get('/api/projects/:id/env', async (req, reply) => {
    const project = await loadProjectOr404(req, reply);
    if (!project) return;

    const prisma = getPrismaClient();
    const envVars = await prisma.envVar.findMany({
      where: { projectId: project.id },
      orderBy: { key: 'asc' },
    });
    return envVars.map((e) => ({ key: e.key, updatedAt: e.updatedAt }));
  });

  app.put<{ Body: { key: string; value: string } }>('/api/projects/:id/env', async (req, reply) => {
    const project = await loadProjectOr404(req, reply);
    if (!project) return;

    const { key, value } = req.body ?? {};
    if (!key?.trim() || value === undefined) {
      return reply.code(400).send({ error: 'key and value are required' });
    }

    const { ciphertext, iv, authTag } = encrypt(value, requireEncryptionKey());
    const prisma = getPrismaClient();
    await prisma.envVar.upsert({
      where: { projectId_key: { projectId: project.id, key: key.trim() } },
      create: {
        projectId: project.id,
        key: key.trim(),
        ciphertext: toBytes(ciphertext),
        iv: toBytes(iv),
        authTag: toBytes(authTag),
      },
      update: {
        ciphertext: toBytes(ciphertext),
        iv: toBytes(iv),
        authTag: toBytes(authTag),
      },
    });

    reply.code(204).send();
  });

  app.delete<{ Params: { id: string; key: string } }>(
    '/api/projects/:id/env/:key',
    async (req, reply) => {
      const project = await loadProjectOr404(req, reply);
      if (!project) return;

      const prisma = getPrismaClient();
      await prisma.envVar
        .delete({ where: { projectId_key: { projectId: project.id, key: req.params.key } } })
        .catch(() => undefined);

      reply.code(204).send();
    },
  );

  app.post('/api/projects/:id/deploy', async (req, reply) => {
    const project = await loadProjectOr404(req, reply);
    if (!project) return;

    const trigger = project.currentDeploymentId ? 'REDEPLOY' : 'MANUAL';
    const deployment = await enqueueDeploy(project.id, trigger);
    reply.code(202).send(deployment);
  });

  app.post<{ Body: { toDeploymentId: string } }>(
    '/api/projects/:id/rollback',
    async (req, reply) => {
      const project = await loadProjectOr404(req, reply);
      if (!project) return;

      const { toDeploymentId } = req.body ?? {};
      if (!toDeploymentId) {
        return reply.code(400).send({ error: 'toDeploymentId is required' });
      }

      const prisma = getPrismaClient();
      const target = await prisma.deployment.findFirst({
        where: { id: toDeploymentId, projectId: project.id },
      });
      if (!target) {
        return reply.code(404).send({ error: 'Target deployment not found' });
      }
      if (!target.imageTag) {
        return reply
          .code(409)
          .send({ error: 'Target deployment has no built image to roll back to' });
      }

      // Repoints traffic at a previously-built image — the worker skips
      // clone/detect/build entirely for a ROLLBACK-triggered deployment.
      const deployment = await prisma.deployment.create({
        data: {
          projectId: project.id,
          status: 'QUEUED',
          trigger: 'ROLLBACK',
          rolledBackFromId: target.id,
        },
      });
      await deployQueue.add('deploy', { deploymentId: deployment.id }, { jobId: deployment.id });
      reply.code(202).send(deployment);
    },
  );

  app.get('/api/projects/:id/deployments', async (req, reply) => {
    const project = await loadProjectOr404(req, reply);
    if (!project) return;

    const prisma = getPrismaClient();
    return prisma.deployment.findMany({
      where: { projectId: project.id },
      orderBy: { queuedAt: 'desc' },
    });
  });
}
