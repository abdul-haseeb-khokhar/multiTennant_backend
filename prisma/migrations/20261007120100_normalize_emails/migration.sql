-- Emails are stored trimmed and lower-cased from now on (the application normalises on write and
-- on lookup). This migration is a data migration: it refuses to run when lower-casing would make
-- two existing rows collide, so nothing is merged or deleted silently. Resolve the listed rows by
-- hand (rename or remove one of each pair), then run it again.

DO $$
DECLARE
  clashes text;
BEGIN
  SELECT string_agg(format('tenant_user %s: %s', tenant_id, email_norm), '; ')
    INTO clashes
    FROM (
      SELECT tenant_id, lower(btrim(email)) AS email_norm
        FROM "tenant_core"."tenant_user"
       GROUP BY tenant_id, lower(btrim(email))
      HAVING count(*) > 1
    ) c;
  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot normalise emails, case-insensitive duplicates exist: %', clashes;
  END IF;

  SELECT string_agg(email_norm, '; ')
    INTO clashes
    FROM (
      SELECT lower(btrim(email)) AS email_norm
        FROM "tenant_core"."platform_admins"
       GROUP BY lower(btrim(email))
      HAVING count(*) > 1
    ) c;
  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot normalise emails, case-insensitive duplicate platform admins exist: %', clashes;
  END IF;
END $$;

UPDATE "tenant_core"."tenant_user"
   SET "email" = lower(btrim("email"))
 WHERE "email" <> lower(btrim("email"));

UPDATE "tenant_core"."platform_admins"
   SET "email" = lower(btrim("email"))
 WHERE "email" <> lower(btrim("email"));

-- Keep it that way even if some code path forgets to normalise.
ALTER TABLE "tenant_core"."tenant_user"
  ADD CONSTRAINT "tenant_user_email_normalized" CHECK ("email" = lower(btrim("email")));
ALTER TABLE "tenant_core"."platform_admins"
  ADD CONSTRAINT "platform_admins_email_normalized" CHECK ("email" = lower(btrim("email")));
ALTER TABLE "tenant_core"."staff_invites"
  ADD CONSTRAINT "staff_invites_email_normalized" CHECK ("email" = lower(btrim("email")));
