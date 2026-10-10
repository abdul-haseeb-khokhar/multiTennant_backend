-- Phase 3: gateway and widget entry. Additive only: new tables, indexes and foreign keys.
-- Generated with `prisma migrate diff` from the previous schema, then value guards added by hand.

-- CreateTable
CREATE TABLE "tenant_core"."api_keys" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "allowed_origins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_core"."gateway_conversations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "end_customer_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "api_key_id" TEXT,
    "ai_blocked" BOOLEAN NOT NULL DEFAULT false,
    "escalation_reason" TEXT,
    "escalation_pending" BOOLEAN NOT NULL DEFAULT false,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_core"."usage_daily" (
    "tenant_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "conversations" INTEGER NOT NULL DEFAULT 0,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "call_minutes" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_daily_pkey" PRIMARY KEY ("tenant_id","day")
);

-- CreateTable
CREATE TABLE "tenant_core"."usage_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "tenant_core"."api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_tenant_id_created_at_idx" ON "tenant_core"."api_keys"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "api_keys_allowed_origins_idx" ON "tenant_core"."api_keys" USING GIN ("allowed_origins");

-- CreateIndex
CREATE INDEX "gateway_conversations_tenant_id_end_customer_id_channel_cre_idx" ON "tenant_core"."gateway_conversations"("tenant_id", "end_customer_id", "channel", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "gateway_conversations_tenant_id_conversation_id_key" ON "tenant_core"."gateway_conversations"("tenant_id", "conversation_id");

-- CreateIndex
CREATE INDEX "usage_events_tenant_id_day_idx" ON "tenant_core"."usage_events"("tenant_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_tenant_id_kind_ref_id_key" ON "tenant_core"."usage_events"("tenant_id", "kind", "ref_id");

-- AddForeignKey
ALTER TABLE "tenant_core"."api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."gateway_conversations" ADD CONSTRAINT "gateway_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."gateway_conversations" ADD CONSTRAINT "gateway_conversations_end_customer_id_fkey" FOREIGN KEY ("end_customer_id") REFERENCES "tenant_core"."end_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."usage_daily" ADD CONSTRAINT "usage_daily_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."usage_events" ADD CONSTRAINT "usage_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Value guards (Prisma does not model CHECK constraints; same approach as the earlier migrations).
ALTER TABLE "tenant_core"."api_keys"
  ADD CONSTRAINT "api_keys_type_check" CHECK ("type" IN ('widget', 'server')),
  ADD CONSTRAINT "api_keys_origins_check" CHECK (cardinality("allowed_origins") <= 20);

ALTER TABLE "tenant_core"."gateway_conversations"
  ADD CONSTRAINT "gateway_conversations_channel_check" CHECK ("channel" IN ('widget', 'whatsapp', 'voice'));

ALTER TABLE "tenant_core"."usage_daily"
  ADD CONSTRAINT "usage_daily_counters_check" CHECK (
    "conversations" >= 0 AND "messages" >= 0 AND "tokens_in" >= 0 AND "tokens_out" >= 0 AND "call_minutes" >= 0
  );

ALTER TABLE "tenant_core"."usage_events"
  ADD CONSTRAINT "usage_events_kind_check" CHECK ("kind" IN ('conversation', 'message'));
