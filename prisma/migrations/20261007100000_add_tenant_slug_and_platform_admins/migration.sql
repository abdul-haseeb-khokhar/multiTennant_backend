-- AlterTable: add slug as nullable first so existing tenants can be backfilled
ALTER TABLE "tenant_core"."tenants" ADD COLUMN     "slug" TEXT;

-- Backfill: lower-cased name with non-alphanumerics collapsed to '-', plus the first
-- 8 characters of the id so the value is unique. Owners can rename it later.
UPDATE "tenant_core"."tenants"
SET "slug" = COALESCE(NULLIF(trim(both '-' from lower(regexp_replace("name", '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'tenant')
             || '-' || substr("id", 1, 8)
WHERE "slug" IS NULL;

ALTER TABLE "tenant_core"."tenants" ALTER COLUMN "slug" SET NOT NULL;

-- CreateTable
CREATE TABLE "tenant_core"."platform_admins" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "tenant_core"."platform_admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenant_core"."tenants"("slug");
