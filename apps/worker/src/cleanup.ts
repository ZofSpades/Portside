import { stopAndRemoveContainer } from '@portside/docker';
import Docker from 'dockerode';

const docker = new Docker();

export interface CleanupJobData {
  containerIds: string[];
  imageTags: string[];
}

/**
 * Tears down the containers and images a deleted project left behind. The
 * API enqueues this instead of touching Docker itself — only the worker
 * holds socket access (see docs/SECURITY.md).
 */
export async function runCleanupJob(data: CleanupJobData): Promise<void> {
  for (const containerId of data.containerIds) {
    await stopAndRemoveContainer(docker, containerId).catch((err) =>
      console.error(`[cleanup] failed to remove container ${containerId}`, err),
    );
  }
  for (const imageTag of data.imageTags) {
    await docker
      .getImage(imageTag)
      .remove({ force: false })
      .catch(() => undefined); // may already be gone, or still in use elsewhere
  }
}
