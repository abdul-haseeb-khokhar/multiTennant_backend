-- CreateTable
CREATE TABLE "tenant_core"."upgrade_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "requested_plan_code" TEXT NOT NULL,
    "note" TEXT,
    "requested_by" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "handled_by" TEXT,
    "handled_at" TIMESTAMP(3),
    "handled_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upgrade_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upgrade_requests_tenant_id_created_at_idx" ON "tenant_core"."upgrade_requests"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "upgrade_requests_status_created_at_idx" ON "tenant_core"."upgrade_requests"("status", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "tenant_core"."upgrade_requests" ADD CONSTRAINT "upgrade_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."upgrade_requests" ADD CONSTRAINT "upgrade_requests_requested_plan_code_fkey" FOREIGN KEY ("requested_plan_code") REFERENCES "tenant_core"."plans"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Not expressible in schema.prisma, added by hand (Prisma ignores both in its drift check):
-- the three states, and at most ONE pending request per tenant (asking again updates it).
ALTER TABLE "tenant_core"."upgrade_requests"
  ADD CONSTRAINT "upgrade_requests_status_check"
  CHECK ("status" IN ('pending', 'handled', 'declined'));

CREATE UNIQUE INDEX "upgrade_requests_one_pending_per_tenant"
  ON "tenant_core"."upgrade_requests" ("tenant_id")
  WHERE "status" = 'pending';
