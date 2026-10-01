-- CreateTable
CREATE TABLE "tenant_core"."tenant_user" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'agent',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_user_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_user_tenant_id_email_key" ON "tenant_core"."tenant_user"("tenant_id", "email");

-- AddForeignKey
ALTER TABLE "tenant_core"."tenant_user" ADD CONSTRAINT "tenant_user_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
