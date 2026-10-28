-- Phase 5A (L6, decided 2026-10-21): every plan includes call minutes and voice is on.
-- EXPAND-ONLY and data-only: no table or column is added, dropped or retyped. It (1) adds the new
-- entitlement keys to the four seeded plans, (2) lets the usage ledger record a call, and nothing else.
--
-- The numbers are PLACEHOLDERS (to be confirmed against real call costs): Starter 30 minutes in
-- total (its 15 days), Free 20 minutes a month, Pro 300 minutes a month with PKR 25 (2500 minor
-- units) for each extra minute, Enterprise unlimited (custom contracts use an entitlements override).
-- They are plain data in `plans.entitlements`; from now on the operator sets them with the PLAN_*
-- environment variables (PlanCatalogSyncService applies the ones that are set at startup), so
-- re-running this migration is never how they change.
--
-- Each UPDATE leaves a plan alone when it already has `callMinutesPerPeriod` (someone set it by hand
-- before this migration ran). `voice` becomes true and `channels` gains "voice" where it is missing.
-- The chat limits (conversationsPerPeriod ...) and the legacy `voicePerMinuteMinor` hint of Pro are
-- untouched; tenants' own `subscriptions.entitlements_override` are untouched.

UPDATE "tenant_core"."plans"
SET "entitlements" = "entitlements" || jsonb_build_object(
      'voice', true,
      'callMinutesPerPeriod', 30,
      'callMinutePeriod', 'total',
      'channels', CASE
        WHEN COALESCE("entitlements"->'channels', '[]'::jsonb) @> '"voice"'::jsonb THEN COALESCE("entitlements"->'channels', '[]'::jsonb)
        ELSE COALESCE("entitlements"->'channels', '[]'::jsonb) || '"voice"'::jsonb
      END
    ),
    "updated_at" = now()
WHERE "code" = 'starter' AND NOT ("entitlements" ? 'callMinutesPerPeriod');

UPDATE "tenant_core"."plans"
SET "entitlements" = "entitlements" || jsonb_build_object(
      'voice', true,
      'callMinutesPerPeriod', 20,
      'callMinutePeriod', 'month',
      'channels', CASE
        WHEN COALESCE("entitlements"->'channels', '[]'::jsonb) @> '"voice"'::jsonb THEN COALESCE("entitlements"->'channels', '[]'::jsonb)
        ELSE COALESCE("entitlements"->'channels', '[]'::jsonb) || '"voice"'::jsonb
      END
    ),
    "updated_at" = now()
WHERE "code" = 'free' AND NOT ("entitlements" ? 'callMinutesPerPeriod');

UPDATE "tenant_core"."plans"
SET "entitlements" = "entitlements" || jsonb_build_object(
      'voice', true,
      'callMinutesPerPeriod', 300,
      'callMinutePeriod', 'month',
      'overageMinuteMinor', 2500,
      'channels', CASE
        WHEN COALESCE("entitlements"->'channels', '[]'::jsonb) @> '"voice"'::jsonb THEN COALESCE("entitlements"->'channels', '[]'::jsonb)
        ELSE COALESCE("entitlements"->'channels', '[]'::jsonb) || '"voice"'::jsonb
      END
    ),
    "updated_at" = now()
WHERE "code" = 'pro' AND NOT ("entitlements" ? 'callMinutesPerPeriod');

-- Enterprise: unlimited minutes (JSON null = unlimited, as for its other limits); it already has voice.
UPDATE "tenant_core"."plans"
SET "entitlements" = "entitlements" || jsonb_build_object(
      'voice', true,
      'callMinutesPerPeriod', NULL,
      'callMinutePeriod', 'month',
      'channels', CASE
        WHEN COALESCE("entitlements"->'channels', '[]'::jsonb) @> '"voice"'::jsonb THEN COALESCE("entitlements"->'channels', '[]'::jsonb)
        ELSE COALESCE("entitlements"->'channels', '[]'::jsonb) || '"voice"'::jsonb
      END
    ),
    "updated_at" = now()
WHERE "code" = 'enterprise' AND NOT ("entitlements" ? 'callMinutesPerPeriod');

-- The usage ledger (the dedupe table behind usage_daily) may now hold a call besides a conversation
-- and a message: one row per call id, so the engine's call-usage event of Phase 5E counts a call
-- once however often it is delivered. A looser CHECK, replaced in one statement; every row that
-- satisfied the old one satisfies this one.
ALTER TABLE "tenant_core"."usage_events"
  DROP CONSTRAINT "usage_events_kind_check",
  ADD CONSTRAINT "usage_events_kind_check" CHECK ("kind" IN ('conversation', 'message', 'call'));
