// Drives the real deploy path end to end against a local fixture repo, with
// no API, auth, or queue involved: detect -> render Dockerfile -> build via
// the Docker Engine API -> run with Traefik labels -> reachable in a browser.
// Usage: npm run deploy:demo -- static
//        npm run deploy:demo -- node
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Docker from 'dockerode';
import {
  buildImage,
  buildTraefikLabels,
  renderDockerfile,
  runContainer,
  stopAndRemoveContainer,
} from '@portside/docker';
import { detectNodeEntrypoint, detectProjectType } from '@portside/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const NETWORK = 'portside-apps';

const FIXTURES: Record<string, string> = {
  static: 'static-site',
  node: 'node-app',
};

async function main() {
  const fixtureArg = process.argv[2];
  if (!fixtureArg || !(fixtureArg in FIXTURES)) {
    console.error(`Usage: npm run deploy:demo -- <${Object.keys(FIXTURES).join('|')}>`);
    process.exit(1);
  }

  const fixtureDir = path.join(REPO_ROOT, 'examples', FIXTURES[fixtureArg]!);
  const docker = new Docker();

  console.log(`\n[1/5] Detecting project type for ${fixtureDir}`);
  const detection = detectProjectType(fixtureDir);
  console.log(`  -> ${detection.type} (${detection.reason})`);

  // Build in a scratch copy so a rendered Dockerfile never touches the
  // fixture's own source tree. node_modules is excluded the same way a real
  // git clone would never contain it — dependencies always come from the
  // deps stage's own `npm ci`, never from the host.
  const buildDir = mkdtempSync(path.join(tmpdir(), 'portside-deploy-demo-'));
  cpSync(fixtureDir, buildDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== 'node_modules',
  });

  const containerPort = 8080;
  const dockerfile = renderDockerfile(detection.type, {
    PORT: String(containerPort),
    ENTRYPOINT: detection.type === 'NODE' ? detectNodeEntrypoint(fixtureDir) : '',
  });
  writeFileSync(path.join(buildDir, 'Dockerfile'), dockerfile);

  const deploymentId = `demo-${fixtureArg}-${Date.now()}`;
  const imageTag = `portside/demo-${fixtureArg}:latest`;

  console.log(`\n[2/5] Building image ${imageTag} via the Docker Engine API`);
  try {
    await buildImage({
      docker,
      contextDir: buildDir,
      imageTag,
      onLog: (line) => console.log(`  ${line}`),
    });
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }

  const containerName = `portside-demo-${fixtureArg}`;
  console.log(`\n[3/5] Removing any previous demo container named ${containerName}`);
  try {
    await stopAndRemoveContainer(docker, containerName);
  } catch {
    // no previous container — fine
  }

  console.log(`\n[4/5] Generating Traefik labels and starting the container`);
  const { labels, hostname } = buildTraefikLabels({
    projectSlug: `demo-${fixtureArg}`,
    deploymentId,
    port: containerPort,
  });

  const env: Record<string, string> =
    detection.type === 'NODE' ? { PORT: String(containerPort) } : {};
  const { containerId } = await runContainer({
    docker,
    imageTag,
    containerName,
    network: NETWORK,
    port: containerPort,
    env,
    labels,
  });
  console.log(`  -> container ${containerId.slice(0, 12)} started on network "${NETWORK}"`);

  console.log(`\n[5/5] Done`);
  console.log(`  URL: http://${hostname}`);
  console.log(
    `  (Traefik must be running via docker-compose and this container must share its network.)\n`,
  );
}

main().catch((err) => {
  console.error('\nDeploy demo failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
