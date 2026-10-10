-- CreateTable
CREATE TABLE "tenant_core"."plans" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "price_minor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "interval" TEXT NOT NULL DEFAULT 'none',
    "yearly_price_minor" INTEGER,
    "duration_days" INTEGER,
    "fallback_plan_code" TEXT,
    "entitlements" JSONB NOT NULL,
    "provider_price_ids" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "tenant_core"."subscriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plan_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "interval" TEXT NOT NULL DEFAULT 'none',
    "current_period_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "grace_ends_at" TIMESTAMP(3),
    "status_before_suspension" TEXT,
    "closed_at" TIMESTAMP(3),
    "entitlements_override" JSONB,
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "provider_customer_id" TEXT,
    "provider_subscription_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_core"."invoices" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "plan_code" TEXT,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "status" TEXT NOT NULL,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "method" TEXT,
    "reference" TEXT,
    "recorded_by" TEXT,
    "provider_invoice_id" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_core"."invoice_sequences" (
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "tenant_core"."billing_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "provider" TEXT,
    "provider_event_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_core"."data_use_consents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "terms_version" TEXT NOT NULL,
    "accepted_by" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_use_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenant_id_key" ON "tenant_core"."subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "tenant_core"."subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "tenant_core"."invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_created_at_idx" ON "tenant_core"."invoices"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "billing_events_tenant_id_created_at_idx" ON "tenant_core"."billing_events"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_provider_provider_event_id_key" ON "tenant_core"."billing_events"("provider", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "data_use_consents_tenant_id_purpose_key" ON "tenant_core"."data_use_consents"("tenant_id", "purpose");

-- AddForeignKey
ALTER TABLE "tenant_core"."subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."subscriptions" ADD CONSTRAINT "subscriptions_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "tenant_core"."plans"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."invoices" ADD CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."invoices" ADD CONSTRAINT "invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "tenant_core"."subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."billing_events" ADD CONSTRAINT "billing_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_core"."data_use_consents" ADD CONSTRAINT "data_use_consents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Phase 2B (billing foundation). EXPAND-ONLY: the statements above only ADD tables, indexes and
-- foreign keys; nothing existing is dropped or rewritten. Below: constraints, the append-only
-- trigger, the plan seed and the backfill of every existing tenant.
-- ---------------------------------------------------------------------------------------------

-- Value guards (Prisma does not model CHECK constraints; same approach as the lower-case email check).
ALTER TABLE "tenant_core"."plans"
  ADD CONSTRAINT "plans_visibility_check" CHECK ("visibility" IN ('public', 'hidden')),
  ADD CONSTRAINT "plans_interval_check" CHECK ("interval" IN ('month', 'year', 'none')),
  ADD CONSTRAINT "plans_price_check" CHECK (("price_minor" IS NULL OR "price_minor" >= 0) AND ("yearly_price_minor" IS NULL OR "yearly_price_minor" >= 0)),
  ADD CONSTRAINT "plans_duration_check" CHECK ("duration_days" IS NULL OR "duration_days" > 0);

ALTER TABLE "tenant_core"."subscriptions"
  ADD CONSTRAINT "subscriptions_status_check" CHECK ("status" IN ('active', 'past_due', 'canceled', 'closed', 'suspended')),
  ADD CONSTRAINT "subscriptions_interval_check" CHECK ("interval" IN ('month', 'year', 'none'));

ALTER TABLE "tenant_core"."invoices"
  ADD CONSTRAINT "invoices_status_check" CHECK ("status" IN ('draft', 'open', 'paid', 'void')),
  ADD CONSTRAINT "invoices_amount_check" CHECK ("amount_minor" >= 0),
  ADD CONSTRAINT "invoices_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "tenant_core"."billing_events"
  ADD CONSTRAINT "billing_events_source_check" CHECK ("source" IN ('manual', 'provider', 'system'));

ALTER TABLE "tenant_core"."data_use_consents"
  ADD CONSTRAINT "data_use_consents_status_check" CHECK ("status" IN ('granted', 'revoked'));

-- Append-only billing log (I4), same mechanism as audit_logs: refuse UPDATE and DELETE. Offboarding
-- and retention purges (Phase 8) must run as a privileged step that drops and recreates this trigger.
CREATE FUNCTION "tenant_core"."billing_events_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'billing_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "billing_events_no_update_delete"
  BEFORE UPDATE OR DELETE ON "tenant_core"."billing_events"
  FOR EACH ROW EXECUTE FUNCTION "tenant_core"."billing_events_append_only"();

-- Seed the plan catalogue (I1). Every number is data: adjust the rows, not the code. The Starter and
-- Free values are placeholders. Entitlements shape: seats / conversationsPerPeriod (null = unlimited)
-- / conversationPeriod ('total' = since the subscription period began, 'month') / knowledgeMb /
-- channels / voice / poweredByLabel, plus optional price hints in minor units.
INSERT INTO "tenant_core"."plans"
  ("code", "name", "visibility", "price_minor", "currency", "interval", "yearly_price_minor",
   "duration_days", "fallback_plan_code", "entitlements", "sort_order")
VALUES
  ('starter', 'Starter', 'hidden', 0, 'PKR', 'none', NULL, 15, 'free',
   '{"seats":3,"conversationsPerPeriod":100,"conversationPeriod":"total","knowledgeMb":20,"channels":["chat"],"voice":false,"poweredByLabel":false}'::jsonb, 0),
  ('free', 'Free', 'public', 0, 'PKR', 'none', NULL, NULL, NULL,
   '{"seats":1,"conversationsPerPeriod":30,"conversationPeriod":"month","knowledgeMb":10,"channels":["chat"],"voice":false,"poweredByLabel":true}'::jsonb, 1),
  ('pro', 'Pro', 'public', 1999900, 'PKR', 'month', 19999000, NULL, 'free',
   '{"seats":10,"conversationsPerPeriod":1500,"conversationPeriod":"month","knowledgeMb":500,"channels":["chat","whatsapp"],"voice":false,"poweredByLabel":false,"overageConversationMinor":1500,"voicePerMinuteMinor":2500}'::jsonb, 2),
  ('enterprise', 'Enterprise', 'public', NULL, 'PKR', 'none', NULL, NULL, 'free',
   '{"seats":null,"conversationsPerPeriod":null,"conversationPeriod":"month","knowledgeMb":null,"channels":["chat","whatsapp","voice"],"voice":true,"poweredByLabel":false}'::jsonb, 3)
ON CONFLICT ("code") DO NOTHING;

-- Backfill: every existing tenant gets a Starter subscription that starts today (not at its creation
-- date) and runs for the plan's duration (I2). A tenant a platform admin had suspended stays suspended
-- and returns to an active Starter when un-suspended.
-- tenants.plan and tenants.status are KEPT as denormalised mirrors of the subscription (see the
-- comment on the Tenant model); they are updated here and by SubscriptionService from now on.
INSERT INTO "tenant_core"."subscriptions"
  ("id", "tenant_id", "plan_code", "status", "interval", "current_period_start", "current_period_end",
   "status_before_suspension", "provider")
SELECT gen_random_uuid()::text, t."id", 'starter',
       CASE WHEN t."status" = 'suspended' THEN 'suspended' ELSE 'active' END,
       'none', now(),
       now() + make_interval(days => (SELECT "duration_days" FROM "tenant_core"."plans" WHERE "code" = 'starter')),
       CASE WHEN t."status" = 'suspended' THEN 'active' ELSE NULL END,
       'manual'
FROM "tenant_core"."tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "tenant_core"."subscriptions" s WHERE s."tenant_id" = t."id");

UPDATE "tenant_core"."tenants" t
SET "plan" = 'starter',
    "status" = CASE WHEN t."status" = 'suspended' THEN 'suspended' ELSE 'trial' END;

INSERT INTO "tenant_core"."billing_events" ("id", "tenant_id", "type", "source", "provider", "payload")
SELECT gen_random_uuid()::text, s."tenant_id", 'subscription.created', 'system', NULL,
       jsonb_build_object('planCode', s."plan_code", 'reason', 'migration', 'periodEnd', s."current_period_end")
FROM "tenant_core"."subscriptions" s;

INSERT INTO "tenant_core"."audit_logs" ("id", "tenant_id", "actor_role", "action", "target_type", "target_id", "after")
SELECT gen_random_uuid()::text, s."tenant_id", 'system', 'subscription.created', 'subscription', s."id",
       jsonb_build_object('planCode', s."plan_code", 'status', s."status", 'reason', 'migration')
FROM "tenant_core"."subscriptions" s;
