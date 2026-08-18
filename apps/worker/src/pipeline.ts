import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertTransition,
  decrypt,
  detectNodeEntrypoint,
  detectProjectType,
  isTerminal,
  type DeploymentStatus,
} from '@portside/core';
import {
  buildImage,
  buildTraefikLabels,
  renderDockerfile,
  runContainer,
  stopAndRemoveContainer,
} from '@portside/docker';
import { getPrismaClient } from '@portside/db';
import Docker from 'dockerode';
import type { Redis } from 'ioredis';
import { cloneRepo } from './git.js';

const WORKSPACES_ROOT = process.env.PORTSIDE_WORKSPACES_ROOT ?? '/var/portside/workspaces';
const NETWORK = 'portside-apps';
const CONTAINER_PORT = 8080;
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;
const LOCK_TTL_SECONDS = 600;

const docker = new Docker();

// Only releases the lock if it's still ours — a slow deploy that outlives its
// TTL must never delete a lock a newer deploy has since acquired.
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export class DeployCancelledError extends Error {}
export class DeployTimeoutError extends Error {}
export class DeployLockedError extends Error {}

function cancellationKey(deploymentId: string): string {
  return `portside:cancel:${deploymentId}`;
}

function lockKey(projectId: string): string {
  return `portside:lock:project:${projectId}`;
}

function requireEncryptionKey(): string {
  const key = process.env.PORTSIDE_ENCRYPTION_KEY;
  if (!key) throw new Error('PORTSIDE_ENCRYPTION_KEY is not set');
  return key;
}

async function assertNotCancelled(redis: Redis, deploymentId: string): Promise<void> {
  const flag = await redis.get(cancellationKey(deploymentId));
  if (flag) throw new DeployCancelledError('Deployment was cancelled');
}

async function transitionTo(deploymentId: string, status: DeploymentStatus): Promise<void> {
  const prisma = getPrismaClient();
  const current = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
  assertTransition(current.status as DeploymentStatus, status);
  await prisma.deployment.update({ where: { id: deploymentId }, data: { status } });
}

function decryptField(ciphertext: Uint8Array, iv: Uint8Array, authTag: Uint8Array): string {
  return decrypt(
    { ciphertext: Buffer.from(ciphertext), iv: Buffer.from(iv), authTag: Buffer.from(authTag) },
    requireEncryptionKey(),
  );
}

async function waitForHealthy(containerId: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const info = await docker.getContainer(containerId).inspect();
  if (!info.State.Running) {
    throw new Error(
      `Container exited shortly after starting (exit code ${info.State.ExitCode ?? 'unknown'})`,
    );
  }
}

/**
 * Runs one deployment end to end: clone/extract -> detect -> build -> run ->
 * health-check -> supersede the previous live deployment. All state lives in
 * Postgres — the only thing carried in the job payload is the deployment id,
 * so a requeued job can never act on stale data.
 */
export async function runDeployPipeline(deploymentId: string, redis: Redis): Promise<void> {
  const prisma = getPrismaClient();
  const lockValue = randomUUID();

  const deployment = await prisma.deployment.findUniqueOrThrow({
    where: { id: deploymentId },
    include: { project: { include: { user: true, envVars: true } } },
  });
  const { project } = deployment;

  const acquired = await redis.set(lockKey(project.id), lockValue, 'EX', LOCK_TTL_SECONDS, 'NX');
  if (!acquired) {
    throw new DeployLockedError(`Project ${project.id} already has a deploy in progress`);
  }

  let workspaceDir: string | undefined;
  let credentialHelperFile: string | undefined;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
  }, DEPLOY_TIMEOUT_MS);

  try {
    await runStages();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: DeploymentStatus = err instanceof DeployCancelledError ? 'CANCELLED' : 'FAILED';
    const current = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
    if (!isTerminal(current.status as DeploymentStatus)) {
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { status, errorMessage: message, finishedAt: new Date() },
      });
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    if (workspaceDir) await fsp.rm(workspaceDir, { recursive: true, force: true });
    if (credentialHelperFile) await fsp.rm(credentialHelperFile, { force: true });
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey(project.id), lockValue);
  }

  async function checkPoint(): Promise<void> {
    if (timedOut)
      throw new DeployTimeoutError(`Deployment timed out after ${DEPLOY_TIMEOUT_MS / 1000}s`);
    await assertNotCancelled(redis, deploymentId);
  }

  async function runStages(): Promise<void> {
    await transitionTo(deploymentId, 'CLONING');
    await checkPoint();

    workspaceDir = path.join(os.tmpdir(), `portside-deploy-${deploymentId}`);
    await fsp.mkdir(workspaceDir, { recursive: true });

    if (project.sourceType === 'GIT') {
      let githubToken: string | undefined;
      if (project.user.tokenCiphertext && project.user.tokenIv && project.user.tokenAuthTag) {
        githubToken = decryptField(
          project.user.tokenCiphertext,
          project.user.tokenIv,
          project.user.tokenAuthTag,
        );
      }
      const cloneResult = await cloneRepo(
        project.repoUrl!,
        project.branch,
        workspaceDir,
        githubToken,
      );
      credentialHelperFile = cloneResult.credentialHelperFile;
    } else {
      const uploadDir = path.join(WORKSPACES_ROOT, 'uploads', project.id);
      await fsp.cp(uploadDir, workspaceDir, { recursive: true });
    }

    await transitionTo(deploymentId, 'DETECTING');
    await checkPoint();

    const projectRoot =
      project.rootDir === '.' ? workspaceDir : path.join(workspaceDir, project.rootDir);
    const detection = detectProjectType(projectRoot);
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { detectedType: detection.type },
    });

    await transitionTo(deploymentId, 'BUILDING');
    await checkPoint();

    if (detection.type !== 'DOCKER') {
      const dockerfile = renderDockerfile(detection.type, {
        PORT: String(CONTAINER_PORT),
        ENTRYPOINT: detection.type === 'NODE' ? detectNodeEntrypoint(projectRoot) : '',
      });
      await fsp.writeFile(path.join(projectRoot, 'Dockerfile'), dockerfile);
    }

    const imageTag = `portside/${project.slug}:${deploymentId.slice(0, 12)}`;
    await buildImage({
      docker,
      contextDir: projectRoot,
      imageTag,
      labels: { 'portside.managed': 'true', 'portside.project-slug': project.slug },
      onLog: (line) => console.log(`[build ${deploymentId}] ${line}`),
    });
    await prisma.deployment.update({ where: { id: deploymentId }, data: { imageTag } });

    await transitionTo(deploymentId, 'DEPLOYING');
    await checkPoint();

    const { labels, hostname } = buildTraefikLabels({
      projectSlug: project.slug,
      deploymentId,
      port: CONTAINER_PORT,
      domain: process.env.PORTSIDE_BASE_DOMAIN,
    });

    const env: Record<string, string> = { PORT: String(CONTAINER_PORT) };
    for (const envVar of project.envVars) {
      env[envVar.key] = decryptField(envVar.ciphertext, envVar.iv, envVar.authTag);
    }

    const containerName = `portside-${project.slug}-${deploymentId.slice(0, 12)}`;
    const { containerId } = await runContainer({
      docker,
      imageTag,
      containerName,
      network: NETWORK,
      port: CONTAINER_PORT,
      env,
      labels,
    });
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { containerId, hostname, internalPort: CONTAINER_PORT },
    });

    await transitionTo(deploymentId, 'HEALTHCHECK');
    await checkPoint();
    await waitForHealthy(containerId);

    await transitionTo(deploymentId, 'LIVE');

    if (project.currentDeploymentId && project.currentDeploymentId !== deploymentId) {
      const previous = await prisma.deployment.findUnique({
        where: { id: project.currentDeploymentId },
      });
      if (previous?.containerId) {
        await stopAndRemoveContainer(docker, previous.containerId).catch(() => undefined);
      }
      if (previous) {
        await prisma.deployment.update({
          where: { id: previous.id },
          data: { status: 'SUPERSEDED' },
        });
      }
    }

    await prisma.project.update({
      where: { id: project.id },
      data: { currentDeploymentId: deploymentId },
    });
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { finishedAt: new Date() },
    });
  }
}
