-- AlterTable
ALTER TABLE "tenant_core"."tenants" ADD COLUMN     "slug_changed_at" TIMESTAMP(3),
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Karachi';

-- CreateTable
CREATE TABLE "tenant_core"."tenant_slug_aliases" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "accepted_until" TIMESTAMP(3) NOT NULL,
    "reserved_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_slug_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_aliases_slug_key" ON "tenant_core"."tenant_slug_aliases"("slug");

-- CreateIndex
CREATE INDEX "tenant_slug_aliases_tenant_id_idx" ON "tenant_core"."tenant_slug_aliases"("tenant_id");

-- AddForeignKey
ALTER TABLE "tenant_core"."tenant_slug_aliases" ADD CONSTRAINT "tenant_slug_aliases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
