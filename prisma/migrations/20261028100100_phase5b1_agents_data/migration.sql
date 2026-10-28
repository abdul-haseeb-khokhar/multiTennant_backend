-- Phase 5B-1 (L7, decided 2026-10-28): DATA ONLY, expand-only, idempotent. Take a pg_dump of
-- tenant_core before applying it to a database that holds real tenants.
--
-- (1) Every existing tenant gets ONE default agent named after the tenant, with settings version 1.
--     The document is the one `buildDefaultSettings` (src/agents/agent-settings.defaults.ts) builds
--     for a new tenant: the business is the tenant's name, the time zone and the language (when en or
--     ur, else en) are the tenant's, Monday to Friday 09:00 to 17:00, call forwarding off, nothing
--     collected yet. A tenant that already has a default agent is left alone, so re-running changes
--     nothing.
-- (2) The new plan limits `agents` and `phoneNumbers` (placeholders, decided 2026-10-28; from now on
--     the operator sets them with the PLAN_*_AGENTS and PLAN_*_PHONE_NUMBERS environment variables,
--     PlanCatalogSyncService applies the ones that are set at startup): Starter 1 agent and 0 numbers,
--     Free 1 and 0, Pro 3 and 5, Enterprise unlimited (JSON null; custom contracts use an entitlements
--     override). A plan that already has the key (set by hand) is left alone. Free and Starter make
--     browser test calls only; real numbers are for Pro and Enterprise.

-- (1) default agents ---------------------------------------------------------------------------
INSERT INTO "tenant_core"."agents" ("id", "tenant_id", "name", "status", "is_default", "created_by", "created_at", "updated_at")
SELECT
  gen_random_uuid()::text,
  t."id",
  COALESCE(NULLIF(btrim(left(btrim(t."name", E' \t\r\n'), 80), E' \t\r\n'), ''), 'Main agent'),
  'active',
  true,
  NULL,
  now(),
  now()
FROM "tenant_core"."tenants" t
WHERE NOT EXISTS (
  SELECT 1 FROM "tenant_core"."agents" a WHERE a."tenant_id" = t."id" AND a."is_default"
);

INSERT INTO "tenant_core"."agent_settings" ("id", "tenant_id", "agent_id", "version", "document", "created_by", "created_at")
SELECT
  gen_random_uuid()::text,
  a."tenant_id",
  a."id",
  1,
  jsonb_build_object(
    'businessName', COALESCE(NULLIF(btrim(left(btrim(t."name", E' \t\r\n'), 120), E' \t\r\n'), ''), 'Main agent'),
    'purpose', '',
    'tone', 'professional',
    'timezone', t."timezone",
    'uiLocale', CASE WHEN t."default_locale" IN ('en', 'ur') THEN t."default_locale" ELSE 'en' END,
    'replyLanguage', CASE WHEN t."default_locale" IN ('en', 'ur') THEN t."default_locale" ELSE 'en' END,
    'hours', jsonb_build_object(
      'mon', '[["09:00","17:00"]]'::jsonb,
      'tue', '[["09:00","17:00"]]'::jsonb,
      'wed', '[["09:00","17:00"]]'::jsonb,
      'thu', '[["09:00","17:00"]]'::jsonb,
      'fri', '[["09:00","17:00"]]'::jsonb,
      'sat', '[]'::jsonb,
      'sun', '[]'::jsonb
    ),
    'escalation', jsonb_build_object(
      'enabled', false,
      'contacts', '[]'::jsonb,
      'whenCallerAsks', true,
      'afterMisses', 2,
      'topics', '[]'::jsonb,
      'outsideHours', 'callback'
    ),
    'capabilities', '{}'::jsonb,
    'voices', '{}'::jsonb,
    'collect', 'null'::jsonb
  ),
  NULL,
  now()
FROM "tenant_core"."agents" a
JOIN "tenant_core"."tenants" t ON t."id" = a."tenant_id"
WHERE a."is_default"
  AND NOT EXISTS (SELECT 1 FROM "tenant_core"."agent_settings" s WHERE s."agent_id" = a."id")
ON CONFLICT ("agent_id", "version") DO NOTHING;

-- (2) plan limits ------------------------------------------------------------------------------
UPDATE "tenant_core"."plans"
SET "entitlements" = "entitlements" || jsonb_build_object('agents', 1, 'phoneNumbers', 0),
    "updated_at" = now()
WHERE "code" = 'starter' AND NOT ("entitlements" ? 'agents');

UPDATE "tenant_core"."plans"
SET "entitlements" = "entitlements" || jsonb_build_object('agents', 1, 'phoneNumbers', 0),
    "updated_at" = now()
WHERE "code" = 'free' AND NOT ("entitlements" ? 'agents');

UPDATE "tenant_core"."plans"
SET "entitlements" = "entitlements" || jsonb_build_object('agents', 3, 'phoneNumbers', 5),
    "updated_at" = now()
WHERE "code" = 'pro' AND NOT ("entitlements" ? 'agents');

-- Enterprise: unlimited (JSON null = unlimited, as for its other limits).
UPDATE "tenant_core"."plans"
SET "entitlements" = "entitlements" || jsonb_build_object('agents', NULL, 'phoneNumbers', NULL),
    "updated_at" = now()
WHERE "code" = 'enterprise' AND NOT ("entitlements" ? 'agents');
