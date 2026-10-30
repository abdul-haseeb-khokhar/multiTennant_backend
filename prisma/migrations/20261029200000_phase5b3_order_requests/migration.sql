-- Phase 5B-3 (team-alignment N3 row 3): the engine's third request type, `order` (a restaurant order:
-- dishes from the owner's menu, pickup or delivery; reference prefix OR-). Expand-only: the CHECK is
-- widened, nothing existing changes. Prisma cannot express CHECK constraints, so this migration is written
-- by hand (the drift check in CI compares the rest of the schema).
--
-- The reference rule needs no change: `requests_reference_check` ('^[A-Z0-9][A-Z0-9-]{2,39}$') already
-- accepts the engine's OR-XXXXX references (prefix AP/CB/OR/RQ, a hyphen and 5 characters of the
-- alphabet ABCDEFGHJKMNPQRSTUVWXYZ23456789).
ALTER TABLE "tenant_core"."requests"
  DROP CONSTRAINT "requests_type_check",
  ADD CONSTRAINT "requests_type_check" CHECK ("type" IN ('appointment', 'callback', 'order'));
