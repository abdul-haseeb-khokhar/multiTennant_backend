import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { buildDefaultSettings } from '../../src/agents/agent-settings.defaults';
import { EngineClient } from '../../src/engine/engine-client';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Agents (L7, Phase 5B-1) against a real Postgres: the default agent that signup creates, the
 * backfill migration for tenants that already exist (idempotent, same document as the code), the
 * constraints the Prisma schema cannot express (one default per tenant, unique name ignoring case,
 * append-only versions, tenant-consistent settings), plan limits under concurrency, optimistic
 * concurrency of settings saves and the engine's pull route.
 */
describe('Agents (real database, Phase 5B-1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = () => request(app.getHttpServer());
  const run = randomBytes(4).toString('hex');
  const password = 'correct-horse-battery';
  const bearer = (token: string) => `Bearer ${token}`;
  const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;
  const internalToken = () => process.env.INTERNAL_API_TOKEN!;

  async function signup(name: string, plan = 'starter', locale?: string) {
    const email = `${name.toLowerCase().replace(/\W/g, '')}.${run}@agents.test`;
    const res = await http()
      .post('/v1/auth/signup')
      .send({
        tenantName: `${name} ${run}`,
        ownerEmail: email,
        ownerPassword: password,
        ...(locale && { locale }),
      })
      .expect(201);
    await http()
      .post('/v1/auth/verify-email')
      .send({ token: tokenFrom(res.body.verificationLink) })
      .expect(204);
    if (plan !== 'starter') {
      await prisma.subscription.update({
        where: { tenantId: res.body.tenant.id },
        data: { planCode: plan, currentPeriodEnd: null },
      });
    }
    return {
      tenantId: res.body.tenant.id as string,
      name: res.body.tenant.name as string,
      token: res.body.access_token as string,
    };
  }

  const agentsOf = (tenantId: string) =>
    prisma.$queryRawUnsafe<
      { id: string; name: string; status: string; is_default: boolean }[]
    >(
      `SELECT "id","name","status","is_default" FROM "tenant_core"."agents" WHERE "tenant_id" = $1 ORDER BY "created_at"`,
      tenantId,
    );
  const settingsOf = (agentId: string) =>
    prisma.$queryRawUnsafe<
      { version: number; document: Record<string, unknown> }[]
    >(
      `SELECT "version","document" FROM "tenant_core"."agent_settings" WHERE "agent_id" = $1 ORDER BY "version"`,
      agentId,
    );
  const sqlFails = async (sql: string, ...params: unknown[]) => {
    try {
      await prisma.$executeRawUnsafe(sql, ...params);
    } catch (error) {
      return String((error as Error).message);
    }
    return null;
  };

  /** Runs a migration file's statements one by one (comments removed). */
  const runMigration = async (folder: string) => {
    const sql = readFileSync(
      join(__dirname, '../../prisma/migrations', folder, 'migration.sql'),
      'utf8',
    )
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    for (const statement of sql.split(/;\s*\n/)) {
      if (statement.trim()) await prisma.$executeRawUnsafe(statement);
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('signup', () => {
    it("creates the tenant's default agent, named after the tenant, with settings version 1", async () => {
      const acme = await signup('Defaults', 'starter', 'ur');
      const agents = await agentsOf(acme.tenantId);
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        name: acme.name,
        status: 'active',
        is_default: true,
      });
      const versions = await settingsOf(agents[0].id);
      expect(versions.map((v) => v.version)).toEqual([1]);
      const tenant = await prisma.tenant.findUniqueOrThrow({
        where: { id: acme.tenantId },
      });
      expect(versions[0].document).toEqual(
        buildDefaultSettings({
          tenantName: tenant.name,
          timezone: tenant.timezone,
          defaultLocale: tenant.defaultLocale,
        }),
      );
      expect(versions[0].document).toMatchObject({
        uiLocale: 'ur',
        replyLanguage: 'ur',
      });
      const audit = await prisma.auditLog.findMany({
        where: { tenantId: acme.tenantId, action: 'agent.created' },
      });
      expect(audit).toHaveLength(1);
    });

    it('the owner sees it in the list', async () => {
      const t = await signup('Listing');
      const res = await http()
        .get(`/v1/tenants/${t.tenantId}/agents`)
        .set('Authorization', bearer(t.token))
        .expect(200);
      expect(res.body).toMatchObject({ total: 1 });
      expect(res.body.data[0]).toMatchObject({ isDefault: true, name: t.name });
    });
  });

  describe('the plan limits live in the plans table', () => {
    it('Starter 1/0, Free 1/0, Pro 3/5, Enterprise unlimited', async () => {
      const rows = await prisma.$queryRawUnsafe<
        { code: string; entitlements: Record<string, unknown> }[]
      >(`SELECT "code","entitlements" FROM "tenant_core"."plans"`);
      const by = Object.fromEntries(rows.map((r) => [r.code, r.entitlements]));
      expect([by.starter.agents, by.starter.phoneNumbers]).toEqual([1, 0]);
      expect([by.free.agents, by.free.phoneNumbers]).toEqual([1, 0]);
      expect([by.pro.agents, by.pro.phoneNumbers]).toEqual([3, 5]);
      expect(by.enterprise.agents).toBeNull();
      expect(by.enterprise.phoneNumbers).toBeNull();
      expect('agents' in by.enterprise).toBe(true);
    });

    it('Starter cannot add a second agent', async () => {
      const t = await signup('StarterLimit');
      const res = await http()
        .post(`/v1/tenants/${t.tenantId}/agents`)
        .set('Authorization', bearer(t.token))
        .send({ name: 'Second' })
        .expect(403);
      expect(res.body).toMatchObject({
        code: 'PLAN_LIMIT_REACHED',
        details: { limit: 'agents', used: 1, max: 1 },
      });
    });

    it('Pro allows three; two parallel creations for the last slot give exactly one 201', async () => {
      const t = await signup('ProLimit', 'pro');
      const create = (name: string) =>
        http()
          .post(`/v1/tenants/${t.tenantId}/agents`)
          .set('Authorization', bearer(t.token))
          .send({ name });
      await create('Two').expect(201);
      const results = await Promise.all([create('Three-a'), create('Three-b')]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
      expect(await agentsOf(t.tenantId)).toHaveLength(3);
    });

    it('Enterprise is unlimited', async () => {
      const t = await signup('EntLimit', 'enterprise');
      for (const n of [1, 2, 3, 4]) {
        await http()
          .post(`/v1/tenants/${t.tenantId}/agents`)
          .set('Authorization', bearer(t.token))
          .send({ name: `Agent ${n}` })
          .expect(201);
      }
    });
  });

  describe('constraints the schema file cannot express', () => {
    it('at most one default agent per tenant (partial unique index)', async () => {
      const t = await signup('OneDefault', 'pro');
      const error = await sqlFails(
        `INSERT INTO "tenant_core"."agents" ("id","tenant_id","name","is_default") VALUES (gen_random_uuid()::text,$1,'Another',true)`,
        t.tenantId,
      );
      expect(error).toContain('Key (tenant_id)=');
    });

    it('names are unique per tenant ignoring case, but free across tenants', async () => {
      const a = await signup('NamesA', 'pro');
      const b = await signup('NamesB', 'pro');
      const insert = (tenantId: string, name: string) =>
        sqlFails(
          `INSERT INTO "tenant_core"."agents" ("id","tenant_id","name") VALUES (gen_random_uuid()::text,$1,$2)`,
          tenantId,
          name,
        );
      expect(await insert(a.tenantId, 'Night')).toBeNull();
      expect(await insert(a.tenantId, 'NIGHT')).toContain('lower(name)');
      expect(await insert(b.tenantId, 'night')).toBeNull();
    });

    it('rejects an untrimmed, empty or over-long name and an unknown status', async () => {
      const t = await signup('Checks', 'pro');
      const insert = (name: string, status = 'active') =>
        sqlFails(
          `INSERT INTO "tenant_core"."agents" ("id","tenant_id","name","status") VALUES (gen_random_uuid()::text,$1,$2,$3)`,
          t.tenantId,
          name,
          status,
        );
      expect(await insert(' padded')).toMatch(/23514|agents_name_check/);
      expect(await insert('')).toMatch(/23514|agents_name_check/);
      expect(await insert('x'.repeat(81))).toMatch(/23514|agents_name_check/);
      expect(await insert('Fine', 'paused')).toMatch(/agents_status_check/);
    });

    it('settings versions are append-only: an UPDATE is refused, a second row for the same version too', async () => {
      const t = await signup('AppendOnly');
      const [agent] = await agentsOf(t.tenantId);
      expect(
        await sqlFails(
          `UPDATE "tenant_core"."agent_settings" SET "document" = '{}'::jsonb WHERE "agent_id" = $1`,
          agent.id,
        ),
      ).toMatch(/immutable/);
      expect(
        await sqlFails(
          `INSERT INTO "tenant_core"."agent_settings" ("id","tenant_id","agent_id","version","document") VALUES (gen_random_uuid()::text,$1,$2,1,'{}'::jsonb)`,
          t.tenantId,
          agent.id,
        ),
      ).toContain('Key (agent_id, version)');
      expect(
        await sqlFails(
          `INSERT INTO "tenant_core"."agent_settings" ("id","tenant_id","agent_id","version","document") VALUES (gen_random_uuid()::text,$1,$2,0,'{}'::jsonb)`,
          t.tenantId,
          agent.id,
        ),
      ).toMatch(/agent_settings_version_check/);
      expect(
        await sqlFails(
          `INSERT INTO "tenant_core"."agent_settings" ("id","tenant_id","agent_id","version","document") VALUES (gen_random_uuid()::text,$1,$2,2,'[]'::jsonb)`,
          t.tenantId,
          agent.id,
        ),
      ).toMatch(/agent_settings_document_check/);
    });

    it("a settings row cannot name another tenant's agent (composite foreign key)", async () => {
      const a = await signup('FkA');
      const b = await signup('FkB');
      const [agentOfA] = await agentsOf(a.tenantId);
      expect(
        await sqlFails(
          `INSERT INTO "tenant_core"."agent_settings" ("id","tenant_id","agent_id","version","document") VALUES (gen_random_uuid()::text,$1,$2,2,'{}'::jsonb)`,
          b.tenantId,
          agentOfA.id,
        ),
      ).toMatch(/agent_settings_tenant_id_agent_id_fkey/);
    });
  });

  describe('staff API', () => {
    it('create, rename, disable, edit settings of a disabled agent, delete: versions go with the agent', async () => {
      const t = await signup('Lifecycle', 'pro');
      const base = `/v1/tenants/${t.tenantId}/agents`;
      const auth = bearer(t.token);
      const created = await http()
        .post(base)
        .set('Authorization', auth)
        .send({ name: 'Night desk' })
        .expect(201);
      const id = created.body.id as string;
      await http()
        .patch(`${base}/${id}`)
        .set('Authorization', auth)
        .send({ name: 'Evening desk', status: 'disabled' })
        .expect(200);
      const saved = await http()
        .put(`${base}/${id}/settings`)
        .set('Authorization', auth)
        .send({ expectedVersion: 1, settings: { tone: 'friendly' } })
        .expect(200);
      expect(saved.body.version).toBe(2);
      expect((await settingsOf(id)).map((v) => v.version)).toEqual([1, 2]);
      await http()
        .delete(`${base}/${id}`)
        .set('Authorization', auth)
        .expect(200);
      expect(await settingsOf(id)).toEqual([]);
      const audit = await prisma.auditLog.findMany({
        where: { tenantId: t.tenantId, targetId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((a) => a.action)).toEqual([
        'agent.created',
        'agent.renamed',
        'agent.disabled',
        'agent.settings_updated',
        'agent.deleted',
      ]);
    });

    it('the default agent cannot be deleted; a clashing name is 409', async () => {
      const t = await signup('DefaultKeep', 'pro');
      const [agent] = await agentsOf(t.tenantId);
      const res = await http()
        .delete(`/v1/tenants/${t.tenantId}/agents/${agent.id}`)
        .set('Authorization', bearer(t.token))
        .expect(409);
      expect(res.body.code).toBe('CANNOT_DELETE_DEFAULT_AGENT');
      const clash = await http()
        .post(`/v1/tenants/${t.tenantId}/agents`)
        .set('Authorization', bearer(t.token))
        .send({ name: agent.name.toUpperCase() })
        .expect(409);
      expect(clash.body.code).toBe('AGENT_NAME_TAKEN');
    });

    it('two simultaneous saves from the same version: exactly one wins, the other gets the conflict', async () => {
      const t = await signup('Race');
      const [agent] = await agentsOf(t.tenantId);
      const save = (tone: string) =>
        http()
          .put(`/v1/tenants/${t.tenantId}/agents/${agent.id}/settings`)
          .set('Authorization', bearer(t.token))
          .send({ expectedVersion: 1, settings: { tone } });
      const results = await Promise.all([save('friendly'), save('formal')]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body).toMatchObject({
        code: 'AGENT_SETTINGS_VERSION_CONFLICT',
        currentVersion: 2,
      });
      expect((await settingsOf(agent.id)).map((v) => v.version)).toEqual([
        1, 2,
      ]);
    });

    it("another tenant's owner gets 404 on an agent id from elsewhere", async () => {
      const a = await signup('IsoA');
      const b = await signup('IsoB');
      const [agentOfA] = await agentsOf(a.tenantId);
      for (const suffix of ['', '/settings', '/settings/versions']) {
        await http()
          .get(`/v1/tenants/${b.tenantId}/agents/${agentOfA.id}${suffix}`)
          .set('Authorization', bearer(b.token))
          .expect(404);
      }
      await http()
        .put(`/v1/tenants/${b.tenantId}/agents/${agentOfA.id}/settings`)
        .set('Authorization', bearer(b.token))
        .send({ expectedVersion: 1, settings: { tone: 'formal' } })
        .expect(404);
      expect((await settingsOf(agentOfA.id)).map((v) => v.version)).toEqual([
        1,
      ]);
    });
  });

  describe('the engine pull route', () => {
    it('serves the stored document with the service token, 304 for an unchanged ETag, 404 across tenants', async () => {
      const a = await signup('PullA');
      const b = await signup('PullB');
      const [agent] = await agentsOf(a.tenantId);
      const path = `/internal/tenants/${a.tenantId}/agents/${agent.id}/config`;
      await http().get(path).expect(401);
      const ok = await http()
        .get(path)
        .set('Authorization', bearer(internalToken()))
        .expect(200);
      expect(ok.body).toMatchObject({
        tenantId: a.tenantId,
        agentId: agent.id,
        version: 1,
        status: 'active',
      });
      expect(ok.body.config).toEqual((await settingsOf(agent.id))[0].document);
      await http()
        .get(path)
        .set('Authorization', bearer(internalToken()))
        .set('If-None-Match', ok.headers.etag)
        .expect(304);
      await http()
        .get(`/internal/tenants/${b.tenantId}/agents/${agent.id}/config`)
        .set('Authorization', bearer(internalToken()))
        .expect(404);
    });

    it('the mock engine pulls the same document and version a simulated call is served with', async () => {
      const t = await signup('MockPull');
      const [agent] = await agentsOf(t.tenantId);
      await http()
        .put(`/v1/tenants/${t.tenantId}/agents/${agent.id}/settings`)
        .set('Authorization', bearer(t.token))
        .send({ expectedVersion: 1, settings: { purpose: 'Take bookings' } })
        .expect(200);
      const engine = app.get(EngineClient) as unknown as {
        simulateCall(tenantId: string): Promise<{
          agentId: string;
          settingsVersion: number;
          config: { purpose: string };
        }>;
      };
      const call = await engine.simulateCall(t.tenantId);
      expect(call).toMatchObject({
        agentId: agent.id,
        settingsVersion: 2,
        config: { purpose: 'Take bookings' },
      });
    });
  });

  describe('the data migration for tenants that already exist', () => {
    const makeLegacyTenant = async (
      name: string,
      locale: string,
      timezone: string,
    ) => {
      const tenant = await prisma.tenant.create({
        data: {
          name,
          slug: `legacy-${randomBytes(5).toString('hex')}`,
          defaultLocale: locale,
          timezone,
        },
      });
      return tenant;
    };

    it("gives every tenant without an agent a default agent plus settings v1 that equal the code's defaults, and a second run changes nothing", async () => {
      const cases = [
        { name: `  Legacy Clinic ${run}  `, locale: 'ur', tz: 'Asia/Karachi' },
        { name: `Legacy Shop ${run}`, locale: 'fr', tz: 'Europe/Paris' },
        { name: `L${run}`.padEnd(120, 'x'), locale: 'en', tz: 'UTC' },
      ];
      const tenants: Awaited<ReturnType<typeof makeLegacyTenant>>[] = [];
      for (const c of cases) {
        tenants.push(await makeLegacyTenant(c.name, c.locale, c.tz));
      }
      const countBefore = Number(
        (
          await prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "tenant_core"."tenants"`,
          )
        )[0].n,
      );

      await runMigration('20261028100100_phase5b1_agents_data');

      const snapshot = async () => {
        const rows: {
          agent: Awaited<ReturnType<typeof agentsOf>>[number];
          version: Awaited<ReturnType<typeof settingsOf>>[number];
        }[] = [];
        for (const tenant of tenants) {
          const agents = await agentsOf(tenant.id);
          expect(agents).toHaveLength(1);
          expect(agents[0].is_default).toBe(true);
          const versions = await settingsOf(agents[0].id);
          expect(versions.map((v) => v.version)).toEqual([1]);
          expect(versions[0].document).toEqual(
            buildDefaultSettings({
              tenantName: tenant.name,
              timezone: tenant.timezone,
              defaultLocale: tenant.defaultLocale,
            }),
          );
          rows.push({ agent: agents[0], version: versions[0] });
        }
        return rows;
      };
      const first = await snapshot();
      expect(first[0].agent.name).toBe(`Legacy Clinic ${run}`);
      expect(first[2].agent.name).toHaveLength(80);

      await runMigration('20261028100100_phase5b1_agents_data');
      expect(await snapshot()).toEqual(first);
      const missing = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "tenant_core"."tenants" t WHERE NOT EXISTS (SELECT 1 FROM "tenant_core"."agents" a WHERE a."tenant_id" = t."id" AND a."is_default")`,
      );
      expect(Number(missing[0].n)).toBe(0);
      const countAfter = Number(
        (
          await prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "tenant_core"."tenants"`,
          )
        )[0].n,
      );
      expect(countAfter).toBe(countBefore);
    });

    it('leaves a plan limit that was set by hand alone', async () => {
      const [before] = await prisma.$queryRawUnsafe<
        { entitlements: Record<string, unknown> }[]
      >(
        `SELECT "entitlements" FROM "tenant_core"."plans" WHERE "code" = 'pro'`,
      );
      await runMigration('20261028100100_phase5b1_agents_data');
      const [after] = await prisma.$queryRawUnsafe<
        { entitlements: Record<string, unknown> }[]
      >(
        `SELECT "entitlements" FROM "tenant_core"."plans" WHERE "code" = 'pro'`,
      );
      expect(after.entitlements).toEqual(before.entitlements);
    });
  });
});
