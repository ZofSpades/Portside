import { getPrismaClient } from '@portside/db';
import { stopAndRemoveContainer } from '@portside/docker';
import Docker from 'dockerode';

const docker = new Docker();
const IMAGES_KEPT_PER_PROJECT = 5;

const NON_LIVE_TERMINAL_STATUSES = new Set(['SUPERSEDED', 'STOPPED', 'FAILED', 'CANCELLED']);

/**
 * Removes containers and images the platform created but no longer needs.
 * Every check is scoped to `portside.managed=true` — resources without that
 * label are never touched, so a bug here can't reach into the user's other
 * Docker workloads.
 */
export async function runJanitor(): Promise<{ containersRemoved: number; imagesRemoved: number }> {
  const prisma = getPrismaClient();
  let containersRemoved = 0;
  let imagesRemoved = 0;

  const containers = await docker.listContainers({
    all: true,
    filters: { label: ['portside.managed=true'] },
  });

  for (const containerInfo of containers) {
    const deploymentId = containerInfo.Labels['portside.deployment-id'];
    const isRunning = containerInfo.State === 'running';
    if (isRunning || !deploymentId) continue;

    const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId } });
    const shouldRemove =
      !deployment ||
      NON_LIVE_TERMINAL_STATUSES.has(deployment.status) ||
      deployment.status === 'QUEUED';

    if (shouldRemove) {
      await stopAndRemoveContainer(docker, containerInfo.Id).catch(() => undefined);
      containersRemoved += 1;
    }
  }

  const images = await docker.listImages({ filters: { label: ['portside.managed=true'] } });
  const byProject = new Map<string, typeof images>();
  for (const image of images) {
    const slug = image.Labels?.['portside.project-slug'];
    if (!slug) continue;
    const bucket = byProject.get(slug) ?? [];
    bucket.push(image);
    byProject.set(slug, bucket);
  }

  for (const projectImages of byProject.values()) {
    const sorted = [...projectImages].sort((a, b) => b.Created - a.Created);
    for (const stale of sorted.slice(IMAGES_KEPT_PER_PROJECT)) {
      await docker
        .getImage(stale.Id)
        .remove({ force: false })
        .then(() => {
          imagesRemoved += 1;
        })
        .catch(() => undefined); // still in use by a container — leave it
    }
  }

  return { containersRemoved, imagesRemoved };
}
