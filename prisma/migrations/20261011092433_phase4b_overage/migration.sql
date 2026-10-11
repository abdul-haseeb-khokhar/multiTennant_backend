-- AlterTable
ALTER TABLE "tenant_core"."invoices" ADD COLUMN     "overage_amount_minor" INTEGER,
ADD COLUMN     "overage_count" INTEGER;

-- AlterTable
ALTER TABLE "tenant_core"."subscriptions" ADD COLUMN     "overage_enabled" BOOLEAN NOT NULL DEFAULT true;

-- Phase 4B (J6): overage on by default for every existing subscription. The setting only has an
-- effect on plans that have an overage price (Pro), so Starter and Free are unaffected.
-- The overage breakdown on an invoice is a record of what the admin received, never more than the total.
ALTER TABLE "tenant_core"."invoices"
  ADD CONSTRAINT "invoices_overage_nonneg" CHECK (
    ("overage_count" IS NULL OR "overage_count" >= 0)
    AND ("overage_amount_minor" IS NULL OR ("overage_amount_minor" >= 0 AND "overage_amount_minor" <= "amount_minor"))
  );
