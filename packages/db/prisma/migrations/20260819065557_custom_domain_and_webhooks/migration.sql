-- AlterEnum
ALTER TYPE "DeploymentTrigger" ADD VALUE 'WEBHOOK';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "customDomain" TEXT,
ADD COLUMN     "webhookSecret" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "projects_customDomain_key" ON "projects"("customDomain");
