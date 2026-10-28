-- Phase 5B-1 (L7, decided 2026-10-28): agents. EXPAND-ONLY: two new tables, nothing existing is
-- changed. An agent is the TENANT's own setup that the one shared engine uses for a call (not a
-- separate AI, not the staff role named `agent`). The data (a default agent with settings version 1
-- for every existing tenant, the new plan limits) is in the next migration.

-- CreateTable
CREATE TABLE "tenant_core"."agents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_core"."agent_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agents_tenant_id_created_at_idx" ON "tenant_core"."agents"("tenant_id", "created_at");

-- CreateIndex (the target of the composite foreign key of agent_settings)
CREATE UNIQUE INDEX "agents_tenant_id_id_key" ON "tenant_core"."agents"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "agent_settings_tenant_id_idx" ON "tenant_core"."agent_settings"("tenant_id");

-- CreateIndex (a version number exists once per agent)
CREATE UNIQUE INDEX "agent_settings_agent_id_version_key" ON "tenant_core"."agent_settings"("agent_id", "version");

-- AddForeignKey (RESTRICT everywhere: tenant removal follows the offboarding procedure)
ALTER TABLE "tenant_core"."agents" ADD CONSTRAINT "agents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (composite: a settings row cannot name another tenant's agent; the versions go with their agent)
ALTER TABLE "tenant_core"."agent_settings" ADD CONSTRAINT "agent_settings_tenant_id_agent_id_fkey" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "tenant_core"."agents"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rules Prisma cannot express (the Prisma schema documents them).
ALTER TABLE "tenant_core"."agents"
  ADD CONSTRAINT "agents_status_check" CHECK ("status" IN ('active', 'disabled')),
  -- stored trimmed, 1 to 80 characters
  ADD CONSTRAINT "agents_name_check" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 80);

-- Exactly one default agent per tenant (at most one is the database's job; at least one is the
-- application's: the default is created with the tenant and cannot be deleted).
CREATE UNIQUE INDEX "agents_one_default_per_tenant"
  ON "tenant_core"."agents" ("tenant_id") WHERE "is_default";

-- A name is unique within a tenant, ignoring case.
CREATE UNIQUE INDEX "agents_tenant_name_lower_key"
  ON "tenant_core"."agents" ("tenant_id", lower("name"));

ALTER TABLE "tenant_core"."agent_settings"
  ADD CONSTRAINT "agent_settings_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "agent_settings_document_check" CHECK (jsonb_typeof("document") = 'object');

-- Settings versions are append-only: a save inserts the next version, an old one is never edited.
-- DELETE stays possible because the versions go with their agent (cascade); nothing in the
-- application deletes them on their own.
CREATE FUNCTION "tenant_core"."agent_settings_no_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent_settings versions are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "agent_settings_no_update"
  BEFORE UPDATE ON "tenant_core"."agent_settings"
  FOR EACH ROW EXECUTE FUNCTION "tenant_core"."agent_settings_no_update"();
