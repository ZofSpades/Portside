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
  logStreamKey,
  LOG_STREAM_TTL_SECONDS,
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
import { LogEmitter } from './log-emitter.js';
import { formatSummary, scanImage } from './security-scan.js';

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

const HEALTHCHECK_SAMPLES = 4;
const HEALTHCHECK_INTERVAL_MS = 500;

/**
 * A single "is it Running?" snapshot isn't enough: our containers use
 * `RestartPolicy: on-failure`, so a container that crash-loops (exits,
 * restarts, exits again) can land back in the Running state at the exact
 * moment a one-shot check happens to sample it — a genuinely broken
 * deployment reading as healthy purely by timing luck. Sampling several
 * times and requiring RestartCount to stay at 0 throughout catches that:
 * a container that has needed even one automatic restart within this
 * window is not something the blue/green swap should ever cut traffic
 * over to.
 */
async function waitForHealthy(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  for (let i = 0; i < HEALTHCHECK_SAMPLES; i++) {
    await new Promise((resolve) => setTimeout(resolve, HEALTHCHECK_INTERVAL_MS));
    const info = await container.inspect();
    if (!info.State.Running) {
      throw new Error(
        `Container exited (exit code ${info.State.ExitCode ?? 'unknown'})${
          info.RestartCount > 0 ? ` after ${info.RestartCount} restart(s)` : ''
        }`,
      );
    }
    if (info.RestartCount > 0) {
      throw new Error(
        `Container has already restarted ${info.RestartCount} time(s) — it's crash-looping`,
      );
    }
  }
}

/** Flushes the full (already-redacted) log to disk and records it in Postgres. */
async function archiveLog(deploymentId: string, logger: LogEmitter): Promise<void> {
  const fullLog = logger.fullLog();
  const logsDir = path.join(WORKSPACES_ROOT, 'logs');
  await fsp.mkdir(logsDir, { recursive: true });
  const storageKey = path.join('logs', `${deploymentId}.log`);
  await fsp.writeFile(path.join(WORKSPACES_ROOT, storageKey), fullLog, 'utf8');

  const prisma = getPrismaClient();
  await prisma.logArchive.upsert({
    where: { deploymentId },
    create: {
      deploymentId,
      storageKey,
      byteSize: Buffer.byteLength(fullLog, 'utf8'),
      lineCount: fullLog.length === 0 ? 0 : fullLog.split('\n').length,
    },
    update: {
      storageKey,
      byteSize: Buffer.byteLength(fullLog, 'utf8'),
      lineCount: fullLog.length === 0 ? 0 : fullLog.split('\n').length,
    },
  });
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

  // Decrypted up front so every secret is known to the redactor before the
  // very first log line — including git's own clone output — is emitted.
  const secrets: string[] = [];
  let githubToken: string | undefined;
  if (project.user.tokenCiphertext && project.user.tokenIv && project.user.tokenAuthTag) {
    githubToken = decryptField(
      project.user.tokenCiphertext,
      project.user.tokenIv,
      project.user.tokenAuthTag,
    );
    secrets.push(githubToken);
  }
  const envVarValues = new Map<string, string>();
  for (const envVar of project.envVars) {
    const value = decryptField(envVar.ciphertext, envVar.iv, envVar.authTag);
    envVarValues.set(envVar.key, value);
    secrets.push(value);
  }

  const logger = new LogEmitter(redis, deploymentId, secrets);

  let workspaceDir: string | undefined;
  let credentialHelperFile: string | undefined;
  // Set the moment this deployment's own container starts, so the failure
  // handler can tear it down if anything goes wrong afterward — see the
  // blue/green note above runContainer() for why that matters.
  let newContainerId: string | undefined;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
  }, DEPLOY_TIMEOUT_MS);

  try {
    await runStages();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: DeploymentStatus = err instanceof DeployCancelledError ? 'CANCELLED' : 'FAILED';
    await logger.emit(`Deployment ${status.toLowerCase()}: ${message}`);

    // This deployment's router shares its Host() rule with whatever was
    // already live (see the blue/green note above runContainer()) and may
    // have out-ranked it on priority alone, before this container ever
    // proved itself healthy. Tearing it down immediately removes its
    // router from Traefik's discovery and reverts live traffic to the
    // still-running previous deployment — bounding a bad deploy's impact
    // to roughly one Traefik provider poll interval instead of leaving a
    // broken high-priority backend in place indefinitely.
    if (newContainerId) {
      await stopAndRemoveContainer(docker, newContainerId).catch((cleanupErr) =>
        console.error(`[worker] failed to remove broken container for ${deploymentId}`, cleanupErr),
      );
    }

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
    await archiveLog(deploymentId, logger).catch((err) =>
      console.error(`[worker] failed to archive log for ${deploymentId}`, err),
    );
    await redis.expire(logStreamKey(deploymentId), LOG_STREAM_TTL_SECONDS);
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey(project.id), lockValue);
  }

  async function checkPoint(): Promise<void> {
    if (timedOut)
      throw new DeployTimeoutError(`Deployment timed out after ${DEPLOY_TIMEOUT_MS / 1000}s`);
    await assertNotCancelled(redis, deploymentId);
  }

  async function buildFromSource(): Promise<string> {
    workspaceDir = path.join(os.tmpdir(), `portside-deploy-${deploymentId}`);
    await fsp.mkdir(workspaceDir, { recursive: true });

    if (project.sourceType === 'GIT') {
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
    await logger.emit(`Detected project type: ${detection.type} (${detection.reason})`);
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
    await logger.emit(`Building image ${imageTag}...`);
    await buildImage({
      docker,
      contextDir: projectRoot,
      imageTag,
      labels: { 'portside.managed': 'true', 'portside.project-slug': project.slug },
      onLog: (line) => {
        logger.emit(line).catch((err) => console.error('[worker] failed to emit log line', err));
      },
    });
    await prisma.deployment.update({ where: { id: deploymentId }, data: { imageTag } });

    // Reporting only — never gates the deploy, however bad the findings.
    // Worth reconsidering once there's a per-project way to opt into
    // treating CRITICAL findings as a hard failure.
    await checkPoint();
    await logger.emit('Running security scan...');
    const scanSummary = await scanImage(imageTag);
    await logger.emit(
      scanSummary ? formatSummary(scanSummary) : 'Security scan: skipped (scanner unavailable).',
    );

    return imageTag;
  }

  /** Reuses a previous deployment's already-built image — no clone, no build. */
  async function reuseImageForRollback(): Promise<string> {
    if (!deployment.rolledBackFromId) {
      throw new Error('Rollback deployment is missing rolledBackFromId');
    }
    const source = await prisma.deployment.findUniqueOrThrow({
      where: { id: deployment.rolledBackFromId },
    });
    if (!source.imageTag || !source.detectedType) {
      throw new Error(`Cannot roll back to deployment ${source.id}: it has no recorded image`);
    }
    await logger.emit(
      `Rolling back to deployment ${source.id} — reusing image ${source.imageTag}, no rebuild`,
    );

    await transitionTo(deploymentId, 'DETECTING');
    await checkPoint();
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { detectedType: source.detectedType },
    });

    await transitionTo(deploymentId, 'BUILDING');
    await checkPoint();
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { imageTag: source.imageTag },
    });
    return source.imageTag;
  }

  async function runStages(): Promise<void> {
    const isRollback = deployment.trigger === 'ROLLBACK';

    await transitionTo(deploymentId, 'CLONING');
    await checkPoint();
    if (!isRollback) {
      await logger.emit(
        project.sourceType === 'GIT'
          ? `Cloning ${project.repoUrl} (branch ${project.branch})...`
          : 'Extracting uploaded archive...',
      );
    }

    const imageTag = isRollback ? await reuseImageForRollback() : await buildFromSource();

    await transitionTo(deploymentId, 'DEPLOYING');
    await checkPoint();
    await logger.emit('Starting container...');

    // Blue/green swap: the hostname is stable across every deployment of
    // this project (see labels.ts), so if there's already a live container
    // it and this new one briefly share the exact same Host() rule the
    // instant this container starts — Traefik's Docker provider discovers
    // it within its own poll interval, well before our own health check
    // below completes. Priority is what decides which one actually
    // receives traffic in that window: a plain timestamp guarantees each
    // new deployment always outranks whatever it's replacing, with no
    // state to track between deploys. The failure handler above is what
    // keeps this safe if the new container turns out to be broken.
    const { labels, hostname } = buildTraefikLabels({
      projectSlug: project.slug,
      deploymentId,
      port: CONTAINER_PORT,
      domain: process.env.PORTSIDE_BASE_DOMAIN,
      priority: Date.now(),
      customDomain: project.customDomain ?? undefined,
    });

    const env: Record<string, string> = {
      PORT: String(CONTAINER_PORT),
      ...Object.fromEntries(envVarValues),
    };

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
    newContainerId = containerId;
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { containerId, hostname, internalPort: CONTAINER_PORT },
    });

    await transitionTo(deploymentId, 'HEALTHCHECK');
    await checkPoint();
    await logger.emit('Waiting for the container to become healthy...');
    await waitForHealthy(containerId);

    await transitionTo(deploymentId, 'LIVE');
    await logger.emit(`Live at http://${hostname}`);

    if (project.currentDeploymentId && project.currentDeploymentId !== deploymentId) {
      const previous = await prisma.deployment.findUnique({
        where: { id: project.currentDeploymentId },
      });
      if (previous?.containerId) {
        // stopAndRemoveContainer sends SIGTERM and gives the container 5s
        // to exit before SIGKILL — connection draining, not an abrupt cut.
        // By now this new container has already out-ranked it in Traefik
        // (higher priority, same Host() rule) and passed our own health
        // check, so no new requests should be landing on the old one; this
        // just lets whatever was already in flight finish.
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
