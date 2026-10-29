-- Phase 5B-2 (his B4, L1, L7): requests, the appointments and call-backs the AI takes on a call and
-- staff confirm. EXPAND-ONLY: one new table and one new unique index on end_customers (the target of
-- the composite foreign key; the pair (tenant_id, id) is unique because id alone already is). Nothing
-- existing is changed or dropped. Generated with `prisma migrate diff` against a throwaway database,
-- then the CHECK constraints below were added by hand (Prisma cannot express them).
-- The engine's word for a request is a "record"; the table is `requests`, the model CustomerRequest.

-- CreateTable
CREATE TABLE "tenant_core"."requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "end_customer_id" TEXT,
    "reference" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "submission_key" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'call',
    "channel" TEXT NOT NULL DEFAULT 'voice',
    "conversation_id" TEXT,
    "language" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "scheduled_local" TEXT,
    "timezone" TEXT,
    "config_version" INTEGER,
    "details" JSONB NOT NULL DEFAULT '{}',
    "note" TEXT,
    "cancelled_by" TEXT,
    "status_changed_at" TIMESTAMP(3),
    "status_changed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "requests_tenant_id_status_created_at_idx" ON "tenant_core"."requests"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "requests_tenant_id_agent_id_created_at_idx" ON "tenant_core"."requests"("tenant_id", "agent_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "requests_tenant_id_created_at_idx" ON "tenant_core"."requests"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "requests_tenant_id_end_customer_id_idx" ON "tenant_core"."requests"("tenant_id", "end_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "requests_tenant_id_reference_key" ON "tenant_core"."requests"("tenant_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "requests_tenant_id_submission_key_key" ON "tenant_core"."requests"("tenant_id", "submission_key");

-- CreateIndex
CREATE UNIQUE INDEX "end_customers_tenant_id_id_key" ON "tenant_core"."end_customers"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "tenant_core"."requests" ADD CONSTRAINT "requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."requests" ADD CONSTRAINT "requests_tenant_id_agent_id_fkey" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "tenant_core"."agents"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."requests" ADD CONSTRAINT "requests_tenant_id_end_customer_id_fkey" FOREIGN KEY ("tenant_id", "end_customer_id") REFERENCES "tenant_core"."end_customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules Prisma cannot express (the Prisma schema documents them).
ALTER TABLE "tenant_core"."requests"
  ADD CONSTRAINT "requests_type_check" CHECK ("type" IN ('appointment', 'callback')),
  ADD CONSTRAINT "requests_status_check" CHECK ("status" IN ('requested', 'confirmed', 'done', 'cancelled')),
  ADD CONSTRAINT "requests_source_check" CHECK ("source" IN ('call')),
  ADD CONSTRAINT "requests_channel_check" CHECK ("channel" IN ('voice', 'chat')),
  -- 'caller' = withdrawn through the engine, 'staff' = cancelled on the staff screen; only while cancelled
  ADD CONSTRAINT "requests_cancelled_by_check" CHECK ("cancelled_by" IS NULL OR ("cancelled_by" IN ('caller', 'staff') AND "status" = 'cancelled')),
  -- stored trimmed and upper case (a reference is read aloud and typed back), short enough for the phone
  ADD CONSTRAINT "requests_reference_check" CHECK ("reference" ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'),
  ADD CONSTRAINT "requests_submission_key_check" CHECK (char_length("submission_key") BETWEEN 1 AND 200),
  ADD CONSTRAINT "requests_summary_check" CHECK (char_length("summary") <= 1000),
  ADD CONSTRAINT "requests_note_check" CHECK ("note" IS NULL OR char_length("note") <= 500),
  ADD CONSTRAINT "requests_text_columns_check" CHECK (
    char_length(coalesce("conversation_id", '')) <= 200
    AND char_length(coalesce("language", '')) <= 16
    AND char_length(coalesce("scheduled_local", '')) <= 64
    AND char_length(coalesce("timezone", '')) <= 64
  ),
  ADD CONSTRAINT "requests_config_version_check" CHECK ("config_version" IS NULL OR "config_version" >= 0),
  -- The application caps the engine's document at 16 KB; this is the looser safety net.
  ADD CONSTRAINT "requests_details_check" CHECK (jsonb_typeof("details") = 'object' AND octet_length("details"::text) <= 32768);
