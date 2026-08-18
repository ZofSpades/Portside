import type Docker from 'dockerode';
import tar from 'tar-fs';

export interface DockerBuildEvent {
  stream?: string;
  status?: string;
  error?: string;
  errorDetail?: { message: string };
  aux?: { ID?: string };
}

/**
 * Turns one raw build-progress event from the Docker daemon into a single
 * log line, or null if the event carries nothing worth showing. Pure and
 * daemon-free on purpose so the parsing logic is unit-testable without a
 * live build.
 */
export function parseBuildEvent(event: DockerBuildEvent): string | null {
  if (event.error) {
    return `ERROR: ${event.errorDetail?.message ?? event.error}`;
  }
  if (event.stream) {
    const trimmed = event.stream.replace(/\n+$/, '');
    return trimmed.length > 0 ? trimmed : null;
  }
  if (event.status) {
    return event.status;
  }
  return null;
}

export interface BuildImageOptions {
  docker: Docker;
  /** Directory to tar and send as the build context. */
  contextDir: string;
  /** Path to the Dockerfile, relative to contextDir. Defaults to "Dockerfile". */
  dockerfile?: string;
  imageTag: string;
  /**
   * Applied to the built image itself (not just the container) via the
   * Docker Engine API's build `labels` option — this works uniformly across
   * every project type, including DOCKER projects using their own
   * Dockerfile, without needing a LABEL instruction in the Dockerfile
   * itself. The janitor (packages/docker consumers) relies on these to find
   * images it's allowed to prune.
   */
  labels?: Record<string, string>;
  onLog?: (line: string) => void;
}

/**
 * Builds an image entirely through the Docker Engine API: tars the context
 * in memory and streams it to the daemon, never shelling out to `docker
 * build`. Build output is parsed into log lines as it arrives.
 */
export async function buildImage(opts: BuildImageOptions): Promise<{ imageTag: string }> {
  const { docker, contextDir, dockerfile = 'Dockerfile', imageTag, labels, onLog } = opts;

  const tarStream = tar.pack(contextDir);
  const buildStream = await docker.buildImage(tarStream, { t: imageTag, dockerfile, labels });

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      buildStream,
      (err: Error | null, events: DockerBuildEvent[]) => {
        if (err) return reject(err);
        const failure = events.find((event) => event.error);
        if (failure) {
          return reject(new Error(failure.errorDetail?.message ?? failure.error));
        }
        resolve();
      },
      (event: DockerBuildEvent) => {
        const line = parseBuildEvent(event);
        if (line && onLog) onLog(line);
      },
    );
  });

  return { imageTag };
}

export interface RunContainerOptions {
  docker: Docker;
  imageTag: string;
  containerName: string;
  /** Docker network to attach to — the container joins this network only. */
  network: string;
  /** The port the process inside the container listens on. */
  port: number;
  env?: Record<string, string>;
  labels?: Record<string, string>;
}

const HARDENING_HOST_CONFIG = {
  Memory: 512 * 1024 * 1024,
  NanoCpus: 0.5e9,
  PidsLimit: 256,
  CapDrop: ['ALL'],
  SecurityOpt: ['no-new-privileges'],
  RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
} as const;

/** Starts a container with Portside's standard resource limits and capability drops. */
export async function runContainer(opts: RunContainerOptions): Promise<{ containerId: string }> {
  const { docker, imageTag, containerName, network, port, env = {}, labels = {} } = opts;

  const container = await docker.createContainer({
    name: containerName,
    Image: imageTag,
    Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    Labels: labels,
    ExposedPorts: { [`${port}/tcp`]: {} },
    HostConfig: {
      ...HARDENING_HOST_CONFIG,
      NetworkMode: network,
    },
  });

  await container.start();
  return { containerId: container.id };
}

/** Stops and removes a container by id. Safe to call on an already-stopped container. */
export async function stopAndRemoveContainer(docker: Docker, containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await container.stop({ t: 5 });
  } catch {
    // already stopped — fall through to remove
  }
  await container.remove({ force: true });
}
