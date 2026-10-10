-- AlterTable
ALTER TABLE "tenant_core"."gateway_conversations" ADD COLUMN     "escalation_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "escalation_last_attempt_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "tenant_core"."notifications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "link" TEXT,
    "dedupe_key" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_core"."engine_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engine_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_core"."stream_tickets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stream_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_tenant_id_user_id_read_at_created_at_idx" ON "tenant_core"."notifications"("tenant_id", "user_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "tenant_core"."notifications"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_user_id_dedupe_key_key" ON "tenant_core"."notifications"("tenant_id", "user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "engine_events_received_at_idx" ON "tenant_core"."engine_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "engine_events_tenant_id_event_id_key" ON "tenant_core"."engine_events"("tenant_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "stream_tickets_token_hash_key" ON "tenant_core"."stream_tickets"("token_hash");

-- CreateIndex
CREATE INDEX "stream_tickets_expires_at_idx" ON "tenant_core"."stream_tickets"("expires_at");

-- CreateIndex
CREATE INDEX "gateway_conversations_escalation_pending_idx" ON "tenant_core"."gateway_conversations"("escalation_pending");

-- AddForeignKey
ALTER TABLE "tenant_core"."notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "tenant_core"."tenant_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."engine_events" ADD CONSTRAINT "engine_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."stream_tickets" ADD CONSTRAINT "stream_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."stream_tickets" ADD CONSTRAINT "stream_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "tenant_core"."tenant_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
