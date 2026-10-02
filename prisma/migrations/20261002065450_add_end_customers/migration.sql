-- CreateTable
CREATE TABLE "tenant_core"."end_customers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "end_customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "end_customers_tenant_id_external_id_key" ON "tenant_core"."end_customers"("tenant_id", "external_id");

-- AddForeignKey
ALTER TABLE "tenant_core"."end_customers" ADD CONSTRAINT "end_customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
