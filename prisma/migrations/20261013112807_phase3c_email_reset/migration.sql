-- AlterTable
ALTER TABLE "tenant_core"."password_resets" ADD COLUMN     "all_workspaces" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "email" TEXT;
