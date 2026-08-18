import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildImage, parseBuildEvent, runContainer, stopAndRemoveContainer } from './builder.js';

// buildImage() calls the real tar-fs `pack()` on contextDir before handing the
// stream to the (mocked) Docker client, so tests need a real directory on disk.
let contextDir: string;

beforeEach(() => {
  contextDir = mkdtempSync(path.join(tmpdir(), 'portside-build-context-'));
  writeFileSync(path.join(contextDir, 'Dockerfile'), 'FROM scratch\n');
});

afterEach(() => {
  rmSync(contextDir, { recursive: true, force: true });
});

describe('parseBuildEvent', () => {
  it('extracts a stream line, trimming trailing newlines', () => {
    expect(parseBuildEvent({ stream: 'Step 1/4 : FROM node:22-alpine\n' })).toBe(
      'Step 1/4 : FROM node:22-alpine',
    );
  });

  it('drops stream events that are pure whitespace', () => {
    expect(parseBuildEvent({ stream: '\n' })).toBeNull();
  });

  it('extracts a status line when there is no stream field', () => {
    expect(parseBuildEvent({ status: 'Pulling from library/node' })).toBe(
      'Pulling from library/node',
    );
  });

  it('prefers errorDetail.message over the bare error field', () => {
    expect(
      parseBuildEvent({ error: 'build failed', errorDetail: { message: 'npm ci exited 1' } }),
    ).toBe('ERROR: npm ci exited 1');
  });

  it('falls back to the bare error field when errorDetail is absent', () => {
    expect(parseBuildEvent({ error: 'build failed' })).toBe('ERROR: build failed');
  });

  it('returns null for an event with none of the known fields', () => {
    expect(parseBuildEvent({})).toBeNull();
  });
});

function makeFakeDocker(events: Array<Record<string, unknown>>, finalError?: Error) {
  // Real dockerode consumes the tar stream by piping it into the HTTP
  // request body. This mock has to drain it the same way — otherwise
  // tar-fs's async directory scan is still in flight when the test's
  // afterEach deletes the temp context dir, causing a stray ENOENT.
  const buildImage = vi.fn().mockImplementation((stream: NodeJS.ReadableStream) => {
    return new Promise((resolve) => {
      stream.resume();
      stream.on('end', () => resolve({ fakeStream: true }));
    });
  });
  const followProgress = vi.fn(
    (
      _stream: unknown,
      onFinished: (err: Error | null, events: unknown[]) => void,
      onProgress: (event: unknown) => void,
    ) => {
      for (const event of events) onProgress(event);
      onFinished(finalError ?? null, events);
    },
  );

  return {
    buildImage,
    modem: { followProgress },
  };
}

describe('buildImage', () => {
  it('resolves with the image tag and forwards parsed log lines', async () => {
    const docker = makeFakeDocker([
      { stream: 'Step 1/2 : FROM nginx:1.27-alpine\n' },
      { stream: 'Successfully built abc123\n' },
    ]);
    const onLog = vi.fn();

    const result = await buildImage({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      docker: docker as any,
      contextDir,
      imageTag: 'portside/demo:latest',
      onLog,
    });

    expect(result).toEqual({ imageTag: 'portside/demo:latest' });
    expect(onLog).toHaveBeenCalledWith('Step 1/2 : FROM nginx:1.27-alpine');
    expect(onLog).toHaveBeenCalledWith('Successfully built abc123');
  });

  it('rejects when the build stream reports an error event', async () => {
    const docker = makeFakeDocker([
      { stream: 'Step 1/2 : FROM node:22-alpine\n' },
      { error: 'exit code 1', errorDetail: { message: 'npm ci failed' } },
    ]);

    await expect(
      buildImage({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        docker: docker as any,
        contextDir,
        imageTag: 'portside/demo:latest',
      }),
    ).rejects.toThrow('npm ci failed');
  });

  it('rejects when followProgress itself errors out', async () => {
    const docker = makeFakeDocker([], new Error('daemon connection lost'));

    await expect(
      buildImage({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        docker: docker as any,
        contextDir,
        imageTag: 'portside/demo:latest',
      }),
    ).rejects.toThrow('daemon connection lost');
  });
});

describe('runContainer', () => {
  it('creates the container with resource limits, labels, and the given network, then starts it', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const createContainer = vi.fn().mockResolvedValue({ id: 'container-123', start });
    const docker = { createContainer };

    const result = await runContainer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      docker: docker as any,
      imageTag: 'portside/demo:latest',
      containerName: 'portside-demo',
      network: 'portside-apps',
      port: 8080,
      env: { PORT: '8080' },
      labels: { 'portside.managed': 'true' },
    });

    expect(result).toEqual({ containerId: 'container-123' });
    expect(start).toHaveBeenCalled();

    const [createArgs] = createContainer.mock.calls[0] as [Record<string, unknown>];
    expect(createArgs.Image).toBe('portside/demo:latest');
    expect(createArgs.Env).toEqual(['PORT=8080']);
    expect(createArgs.Labels).toEqual({ 'portside.managed': 'true' });
    expect(createArgs.ExposedPorts).toEqual({ '8080/tcp': {} });

    const hostConfig = createArgs.HostConfig as Record<string, unknown>;
    expect(hostConfig.NetworkMode).toBe('portside-apps');
    expect(hostConfig.CapDrop).toEqual(['ALL']);
    expect(hostConfig.Memory).toBe(512 * 1024 * 1024);
    expect(hostConfig.PidsLimit).toBe(256);
  });
});

describe('stopAndRemoveContainer', () => {
  it('stops then removes the container', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const getContainer = vi.fn().mockReturnValue({ stop, remove });
    const docker = { getContainer };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await stopAndRemoveContainer(docker as any, 'container-123');

    expect(getContainer).toHaveBeenCalledWith('container-123');
    expect(stop).toHaveBeenCalledWith({ t: 5 });
    expect(remove).toHaveBeenCalledWith({ force: true });
  });

  it('still removes the container when stop fails (already stopped)', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('container already stopped'));
    const remove = vi.fn().mockResolvedValue(undefined);
    const getContainer = vi.fn().mockReturnValue({ stop, remove });
    const docker = { getContainer };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await stopAndRemoveContainer(docker as any, 'container-123');

    expect(remove).toHaveBeenCalledWith({ force: true });
  });
});
