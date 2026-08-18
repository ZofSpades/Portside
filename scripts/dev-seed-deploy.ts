// Dev-only integration check: exercises the real queue -> worker pipeline
// (BullMQ job, git clone or zip extraction, detect, build, run, Traefik
// labels, DB state transitions) without going through a real GitHub OAuth
// login. Not part of the app's runtime — run manually while developing:
//   npm run dev:seed-deploy -- git
//   npm run dev:seed-deploy -- zip
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPrismaClient } from '@portside/db';
import AdmZip from 'adm-zip';
import { Queue } from 'bullmq';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const WORKSPACES_ROOT = process.env.PORTSIDE_WORKSPACES_ROOT ?? '/var/portside/workspaces';

async function main() {
  const mode = process.argv[2];
  if (mode !== 'git' && mode !== 'zip') {
    console.error('Usage: npm run dev:seed-deploy -- <git|zip>');
    process.exit(1);
  }

  const prisma = getPrismaClient();
  const queue = new Queue('deploys', { connection: { url: REDIS_URL } });

  const user = await prisma.user.upsert({
    where: { githubId: 'dev-seed-user' },
    create: { githubId: 'dev-seed-user', login: 'dev-seed-user' },
    update: {},
  });

  const name = `seed-${mode}-${Date.now()}`;
  const project =
    mode === 'git'
      ? await prisma.project.create({
          data: {
            userId: user.id,
            name,
            slug: name,
            sourceType: 'GIT',
            repoUrl: 'https://github.com/ZofSpades/Portside.git',
            branch: 'main',
            rootDir: 'examples/node-app',
          },
        })
      : await seedZipProject(user.id, name);

  const deployment = await prisma.deployment.create({
    data: { projectId: project.id, status: 'QUEUED', trigger: 'MANUAL' },
  });
  await queue.add('deploy', { deploymentId: deployment.id }, { jobId: deployment.id });
  console.log(`Enqueued deployment ${deployment.id} for project ${project.name} (${mode})`);

  const finalStatus = await pollUntilDone(deployment.id);
  const finalDeployment = await prisma.deployment.findUniqueOrThrow({
    where: { id: deployment.id },
  });

  console.log(`\nFinal status: ${finalStatus}`);
  if (finalDeployment.hostname) console.log(`URL: http://${finalDeployment.hostname}`);
  if (finalDeployment.errorMessage) console.log(`Error: ${finalDeployment.errorMessage}`);

  await queue.close();
  await prisma.$disconnect();
  process.exit(finalStatus === 'LIVE' ? 0 : 1);
}

async function seedZipProject(userId: string, name: string) {
  const prisma = getPrismaClient();
  const project = await prisma.project.create({
    data: { userId, name, slug: name, sourceType: 'ZIP' },
  });

  const zip = new AdmZip();
  const staticSiteDir = path.join(REPO_ROOT, 'examples', 'static-site');
  for (const file of fs.readdirSync(staticSiteDir)) {
    zip.addLocalFile(path.join(staticSiteDir, file));
  }
  const destDir = path.join(WORKSPACES_ROOT, 'uploads', project.id);
  fs.mkdirSync(destDir, { recursive: true });
  zip.extractAllTo(destDir, true);

  return project;
}

async function pollUntilDone(deploymentId: string): Promise<string> {
  const prisma = getPrismaClient();
  const terminal = new Set(['LIVE', 'SUPERSEDED', 'STOPPED', 'FAILED', 'CANCELLED']);
  for (let i = 0; i < 120; i++) {
    const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
    process.stdout.write(`\r  status: ${deployment.status.padEnd(12)}`);
    if (terminal.has(deployment.status)) {
      console.log();
      return deployment.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.log();
  return 'TIMED_OUT_WAITING';
}

main().catch((err) => {
  console.error('dev-seed-deploy failed:', err);
  process.exit(1);
});
