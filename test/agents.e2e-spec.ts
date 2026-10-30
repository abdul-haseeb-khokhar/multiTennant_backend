import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CONFIG_PULLS_PER_MINUTE } from '../src/agents/internal-agent-config.controller';
import { AGENT_LISTS_PER_MINUTE } from '../src/agents/internal-agent-list.controller';
import { buildDefaultSettings } from '../src/agents/agent-settings.defaults';
import { FakeClock } from '../src/billing/clock';
import { EntitlementsService } from '../src/billing/entitlements/entitlements.service';
import { MockEngineClient } from '../src/engine/mock-engine.client';
import { Gateway, installGateway, matches } from './utils/gateway-fixtures';
import { PrismaMock, prismaError } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

type Role = 'owner' | 'admin' | 'agent';
type Row = Record<string, any>;

const INTERNAL_TOKEN = 'e2e-internal-token-0123456789abcdef-xyz';

describe('Agents (e2e, L7)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let clock: FakeClock;
  let engine: MockEngineClient;
  let gateway: Gateway;
  let staffToken: Awaited<ReturnType<typeof createTestApp>>['staffToken'];
  let allowStaff: () => void;
  let resetRateLimits: () => void;

  let agents: Row[];
  let settings: Row[];
  let sequence: number;

  const http = () => request(app.getHttpServer());
  const as = (role: Role, tenantId = 'tenant-a') =>
    `Bearer ${staffToken({ userId: `${role}-1`, tenantId, role })}`;
  const url = (suffix = '', tenantId = 'tenant-a') =>
    `/v1/tenants/${tenantId}/agents${suffix}`;
  const internal = (tenantId: string, agentId: string, query = '') =>
    http()
      .get(`/internal/tenants/${tenantId}/agents/${agentId}/config${query}`)
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`);

  const tenantsInfo: Record<string, Row> = {
    'tenant-a': { id: 'tenant-a', name: 'Acme Dental', plan: 'pro' },
    'tenant-b': { id: 'tenant-b', name: 'Beta Clinic', plan: 'pro' },
    'tenant-c': { id: 'tenant-c', name: 'Free Shop', plan: 'free' },
  };

  const seedAgent = (tenantId: string, id: string, over: Row = {}) => {
    const row = {
      id,
      tenantId,
      name: tenantsInfo[tenantId].name,
      status: 'active',
      isDefault: true,
      createdBy: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      ...over,
    };
    agents.push(row);
    settings.push({
      id: `s-${id}-1`,
      tenantId,
      agentId: id,
      version: 1,
      document: buildDefaultSettings({
        tenantName: row.name,
        timezone: 'Asia/Karachi',
        defaultLocale: 'en',
      }),
      createdBy: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    });
    return row;
  };

  const omitCreatedBy = (row: Row, omit?: Row) => {
    if (!omit?.createdBy) return { ...row };
    const { createdBy: _c, ...rest } = row;
    return rest;
  };

  /** An in-memory agents / agent_settings table behind the Prisma mock, with the two unique rules the migration adds. */
  const installAgents = () => {
    agents = [];
    settings = [];
    sequence = 0;
    prisma.tenant.findUnique.mockImplementation(({ where }: { where: Row }) => {
      const info = tenantsInfo[where.id];
      return Promise.resolve(
        info
          ? {
              ...info,
              status: 'active',
              timezone: 'Asia/Karachi',
              defaultLocale: 'en',
            }
          : null,
      );
    });
    prisma.agent.create.mockImplementation(({ data, omit }: Row) => {
      const clash = agents.some(
        (a) =>
          a.tenantId === data.tenantId &&
          a.name.toLowerCase() === data.name.toLowerCase(),
      );
      if (clash) return Promise.reject(prismaError('P2002'));
      const row = {
        id: `ag-new-${(sequence += 1)}`,
        status: 'active',
        createdAt: new Date(clock.now()),
        updatedAt: new Date(clock.now()),
        ...data,
      };
      agents.push(row);
      return Promise.resolve(omitCreatedBy(row, omit));
    });
    const find = ({ where, omit }: Row) => {
      const row = agents.find((a) => matches(a, where));
      return row ? omitCreatedBy(row, omit) : null;
    };
    prisma.agent.findFirst.mockImplementation((args: Row) =>
      Promise.resolve(find(args as never)),
    );
    prisma.agent.findFirstOrThrow.mockImplementation((args: Row) => {
      const row = find(args as never);
      return row ? Promise.resolve(row) : Promise.reject(prismaError('P2025'));
    });
    prisma.agent.findMany.mockImplementation(
      ({ where, skip = 0, take = 20, omit }: Row) =>
        Promise.resolve(
          agents
            .filter((a) => matches(a, where))
            .sort(
              (x, y) =>
                Number(y.isDefault) - Number(x.isDefault) ||
                x.createdAt.getTime() - y.createdAt.getTime(),
            )
            .slice(skip, skip + take)
            .map((a) => omitCreatedBy(a, omit)),
        ),
    );
    prisma.agent.count.mockImplementation(({ where }: Row) =>
      Promise.resolve(agents.filter((a) => matches(a, where)).length),
    );
    prisma.agent.updateMany.mockImplementation(({ where, data }: Row) => {
      const hits = agents.filter((a) => matches(a, where));
      for (const hit of hits) {
        if (
          data.name &&
          agents.some(
            (a) =>
              a !== hit &&
              a.tenantId === hit.tenantId &&
              a.name.toLowerCase() === data.name.toLowerCase(),
          )
        ) {
          return Promise.reject(prismaError('P2002'));
        }
        Object.assign(hit, data, { updatedAt: new Date(clock.now()) });
      }
      return Promise.resolve({ count: hits.length });
    });
    prisma.agent.deleteMany.mockImplementation(({ where }: Row) => {
      const hits = agents.filter((a) => matches(a, where));
      agents = agents.filter((a) => !hits.includes(a));
      settings = settings.filter((s) => agents.some((a) => a.id === s.agentId));
      return Promise.resolve({ count: hits.length });
    });
    prisma.agentSettings.create.mockImplementation(({ data }: Row) => {
      if (
        settings.some(
          (s) => s.agentId === data.agentId && s.version === data.version,
        )
      ) {
        return Promise.reject(prismaError('P2002'));
      }
      if (!agents.some((a) => a.id === data.agentId)) {
        return Promise.reject(prismaError('P2003'));
      }
      const row = {
        id: `set-${(sequence += 1)}`,
        createdAt: new Date(clock.now()),
        ...data,
      };
      settings.push(row);
      return Promise.resolve({ ...row });
    });
    prisma.agentSettings.findFirst.mockImplementation(
      ({ where, orderBy }: Row) => {
        const rows = settings.filter((s) => matches(s, where));
        if (orderBy?.version === 'desc')
          rows.sort((a, b) => b.version - a.version);
        return Promise.resolve(rows[0] ? { ...rows[0] } : null);
      },
    );
    prisma.agentSettings.findMany.mockImplementation(
      ({ where, skip = 0, take = 20, omit }: Row) =>
        Promise.resolve(
          settings
            .filter((s) => matches(s, where))
            .sort((a, b) => b.version - a.version)
            .slice(skip, skip + take)
            .map((s) => {
              const { document: _d, ...rest } = s;
              return omit?.document ? rest : { ...s };
            }),
        ),
    );
    prisma.agentSettings.count.mockImplementation(({ where }: Row) =>
      Promise.resolve(settings.filter((s) => matches(s, where)).length),
    );
  };

  beforeAll(async () => {
    ({ app, prisma, clock, engine, staffToken, allowStaff, resetRateLimits } =
      await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    allowStaff();
    resetRateLimits();
    gateway = installGateway(prisma, clock, {
      tenants: [
        { id: 'tenant-a', plan: 'pro' },
        { id: 'tenant-b', plan: 'pro' },
        { id: 'tenant-c', plan: 'free' },
      ],
    });
    installAgents();
    // the subscription row lock (FOR UPDATE) finds the tenant's subscription
    prisma.$queryRaw.mockResolvedValue([{ id: 'sub' }]);
    seedAgent('tenant-a', 'ag-a1');
    seedAgent('tenant-b', 'ag-b1');
    seedAgent('tenant-c', 'ag-c1');
    for (const id of Object.keys(tenantsInfo)) {
      app.get(EntitlementsService).invalidate(id);
    }
    engine.reset();
  });

  describe('list and get', () => {
    it("every role lists its own tenant's agents in the page envelope, default first, without createdBy", async () => {
      seedAgent('tenant-a', 'ag-a2', { name: 'Night desk', isDefault: false });
      for (const role of ['owner', 'admin', 'agent'] as Role[]) {
        const res = await http()
          .get(url())
          .set('Authorization', as(role))
          .expect(200);
        expect(res.body).toMatchObject({ total: 2, skip: 0, take: 20 });
        expect(res.body.data.map((a: Row) => a.id)).toEqual(['ag-a1', 'ag-a2']);
        expect(res.body.data[0]).toMatchObject({
          tenantId: 'tenant-a',
          status: 'active',
          isDefault: true,
        });
        expect(res.body.data[0]).not.toHaveProperty('createdBy');
      }
    });

    it("never shows another tenant's agents: list, get", async () => {
      const list = await http()
        .get(url('', 'tenant-b'))
        .set('Authorization', as('owner', 'tenant-b'))
        .expect(200);
      expect(list.body.data.map((a: Row) => a.id)).toEqual(['ag-b1']);
      const res = await http()
        .get(url('/ag-b1'))
        .set('Authorization', as('owner'))
        .expect(404);
      expect(res.body.code).toBe('AGENT_NOT_FOUND');
      await http()
        .get(url('/ag-a1', 'tenant-b'))
        .set('Authorization', as('owner'))
        .expect(403); // token of tenant-a on tenant-b's URL
    });

    it('filters by status', async () => {
      seedAgent('tenant-a', 'ag-a2', {
        name: 'Off',
        isDefault: false,
        status: 'disabled',
      });
      const res = await http()
        .get(url('?status=disabled'))
        .set('Authorization', as('agent'))
        .expect(200);
      expect(res.body.data.map((a: Row) => a.id)).toEqual(['ag-a2']);
    });
  });

  describe('create and plan limits', () => {
    it('owner and admin create an agent that starts with default settings (version 1), audited without settings', async () => {
      const res = await http()
        .post(url())
        .set('Authorization', as('admin'))
        .send({ name: '  Night desk ' })
        .expect(201);
      expect(res.body).toMatchObject({
        tenantId: 'tenant-a',
        name: 'Night desk',
        status: 'active',
        isDefault: false,
      });
      const first = settings.find((s) => s.agentId === res.body.id)!;
      expect(first.version).toBe(1);
      expect(first.document).toMatchObject({
        businessName: 'Acme Dental',
        tone: 'professional',
      });
      expect(gateway.audit.at(-1)).toMatchObject({
        tenantId: 'tenant-a',
        action: 'agent.created',
        actorUserId: 'admin-1',
        targetId: res.body.id,
      });
      expect(JSON.stringify(gateway.audit.at(-1))).not.toContain('Acme Dental');
    });

    it('Pro allows 3 agents (disabled ones count); the 4th is 403 PLAN_LIMIT_REACHED with details', async () => {
      seedAgent('tenant-a', 'ag-a2', {
        name: 'Two',
        isDefault: false,
        status: 'disabled',
      });
      await http()
        .post(url())
        .set('Authorization', as('owner'))
        .send({ name: 'Three' })
        .expect(201);
      const res = await http()
        .post(url())
        .set('Authorization', as('owner'))
        .send({ name: 'Four' })
        .expect(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        code: 'PLAN_LIMIT_REACHED',
        details: { limit: 'agents', used: 3, max: 3 },
      });
      expect(agents.filter((a) => a.tenantId === 'tenant-a')).toHaveLength(3);
    });

    it('Free (and Starter) have exactly one agent: the default; a second is refused', async () => {
      const res = await http()
        .post(url('', 'tenant-c'))
        .set('Authorization', as('owner', 'tenant-c'))
        .send({ name: 'Second' })
        .expect(403);
      expect(res.body).toMatchObject({
        code: 'PLAN_LIMIT_REACHED',
        details: { limit: 'agents', used: 1, max: 1 },
      });
    });

    it('a suspended subscription cannot add agents', async () => {
      gateway.subscriptions.get('tenant-a')!.status = 'past_due';
      app.get(EntitlementsService).invalidate('tenant-a');
      const res = await http()
        .post(url())
        .set('Authorization', as('owner'))
        .send({ name: 'Late' })
        .expect(403);
      expect(res.body.code).toBe('SUBSCRIPTION_PAST_DUE');
    });

    it('409 AGENT_NAME_TAKEN for a name that exists, ignoring case; the same name in another tenant is fine', async () => {
      const clash = await http()
        .post(url())
        .set('Authorization', as('owner'))
        .send({ name: 'ACME DENTAL' })
        .expect(409);
      expect(clash.body.code).toBe('AGENT_NAME_TAKEN');
      await http()
        .post(url('', 'tenant-b'))
        .set('Authorization', as('owner', 'tenant-b'))
        .send({ name: 'ACME DENTAL' })
        .expect(201);
    });

    it('validates the name (1 to 80 characters)', async () => {
      for (const name of ['', '   ', 'x'.repeat(81), 5, undefined]) {
        await http()
          .post(url())
          .set('Authorization', as('owner'))
          .send({ name })
          .expect(400);
      }
    });

    it('the staff role agent cannot create (403 INSUFFICIENT_ROLE)', async () => {
      const res = await http()
        .post(url())
        .set('Authorization', as('agent'))
        .send({ name: 'Nope' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('GET /v1/plans shows the new limits', async () => {
      const res = await http().get('/v1/plans').expect(200);
      const byCode = Object.fromEntries(
        res.body.data.map((p: Row) => [p.code, p.entitlements]),
      );
      expect(byCode.free).toMatchObject({ agents: 1, phoneNumbers: 0 });
      expect(byCode.pro).toMatchObject({ agents: 3, phoneNumbers: 5 });
      expect(byCode.enterprise).toMatchObject({
        agents: null,
        phoneNumbers: null,
      });
    });
  });

  describe('rename, disable, delete', () => {
    beforeEach(() => {
      seedAgent('tenant-a', 'ag-a2', { name: 'Night desk', isDefault: false });
    });

    it('renames and disables, then enables, with one audit entry each (names and status only)', async () => {
      const renamed = await http()
        .patch(url('/ag-a2'))
        .set('Authorization', as('admin'))
        .send({ name: 'Evening desk' })
        .expect(200);
      expect(renamed.body.name).toBe('Evening desk');
      const off = await http()
        .patch(url('/ag-a2'))
        .set('Authorization', as('owner'))
        .send({ status: 'disabled' })
        .expect(200);
      expect(off.body.status).toBe('disabled');
      await http()
        .patch(url('/ag-a2'))
        .set('Authorization', as('owner'))
        .send({ status: 'active' })
        .expect(200);
      expect(gateway.audit.map((a) => a.action)).toEqual([
        'agent.renamed',
        'agent.disabled',
        'agent.enabled',
      ]);
    });

    it('a disabled agent can still be read and have its settings edited by staff', async () => {
      await http()
        .patch(url('/ag-a2'))
        .set('Authorization', as('owner'))
        .send({ status: 'disabled' })
        .expect(200);
      await http()
        .get(url('/ag-a2'))
        .set('Authorization', as('agent'))
        .expect(200);
      await http()
        .put(url('/ag-a2/settings'))
        .set('Authorization', as('owner'))
        .send({ expectedVersion: 1, settings: { tone: 'friendly' } })
        .expect(200);
    });

    it('the default agent can be renamed but not deleted', async () => {
      await http()
        .patch(url('/ag-a1'))
        .set('Authorization', as('owner'))
        .send({ name: 'Main line' })
        .expect(200);
      const res = await http()
        .delete(url('/ag-a1'))
        .set('Authorization', as('owner'))
        .expect(409);
      expect(res.body.code).toBe('CANNOT_DELETE_DEFAULT_AGENT');
      expect(agents.some((a) => a.id === 'ag-a1')).toBe(true);
    });

    it('deleting returns the removed agent, drops its settings and audits it; the name is free again', async () => {
      const res = await http()
        .delete(url('/ag-a2'))
        .set('Authorization', as('admin'))
        .expect(200);
      expect(res.body).toMatchObject({ id: 'ag-a2', name: 'Night desk' });
      expect(settings.some((s) => s.agentId === 'ag-a2')).toBe(false);
      expect(gateway.audit.at(-1)).toMatchObject({ action: 'agent.deleted' });
      await http()
        .post(url())
        .set('Authorization', as('owner'))
        .send({ name: 'Night desk' })
        .expect(201);
    });

    it('409 AGENT_NAME_TAKEN on a clashing rename', async () => {
      const res = await http()
        .patch(url('/ag-a2'))
        .set('Authorization', as('owner'))
        .send({ name: 'acme dental' })
        .expect(409);
      expect(res.body.code).toBe('AGENT_NAME_TAKEN');
    });

    it("another tenant's agent is 404 for PATCH and DELETE, and stays untouched", async () => {
      await http()
        .patch(url('/ag-b1'))
        .set('Authorization', as('owner'))
        .send({ name: 'Hijacked' })
        .expect(404);
      await http()
        .delete(url('/ag-b1'))
        .set('Authorization', as('owner'))
        .expect(404);
      expect(agents.find((a) => a.id === 'ag-b1')!.name).toBe('Beta Clinic');
    });

    it('rejects an unknown status', async () => {
      await http()
        .patch(url('/ag-a2'))
        .set('Authorization', as('owner'))
        .send({ status: 'paused' })
        .expect(400);
    });
  });

  describe('settings', () => {
    const putSettings = (
      body: Record<string, unknown>,
      auth = as('owner'),
      agentId = 'ag-a1',
      tenantId = 'tenant-a',
    ) =>
      http()
        .put(url(`/${agentId}/settings`, tenantId))
        .set('Authorization', auth)
        .send(body);

    it('owner and admin read the current document; the staff role agent is refused', async () => {
      const res = await http()
        .get(url('/ag-a1/settings'))
        .set('Authorization', as('admin'))
        .expect(200);
      expect(res.body).toMatchObject({
        agentId: 'ag-a1',
        version: 1,
        document: { businessName: 'Acme Dental', tone: 'professional' },
      });
      await http()
        .get(url('/ag-a1/settings'))
        .set('Authorization', as('agent'))
        .expect(403);
      await http()
        .put(url('/ag-a1/settings'))
        .set('Authorization', as('agent'))
        .send({ expectedVersion: 1, settings: {} })
        .expect(403);
    });

    it('saves a new version, keeps the old one, and audits version numbers only (no phone numbers)', async () => {
      const res = await putSettings({
        expectedVersion: 1,
        settings: {
          tone: 'friendly',
          escalation: {
            enabled: true,
            contacts: [
              { role: 'Doctor', name: 'Dr A', phone: '+92 300 1234567' },
            ],
            whenCallerAsks: true,
            afterMisses: 3,
            topics: ['emergency'],
            outsideHours: 'forward',
          },
        },
      }).expect(200);
      expect(res.body.version).toBe(2);
      expect(res.body.document.tone).toBe('friendly');
      expect(res.body.document.escalation.contacts[0]).toMatchObject({
        id: 'c1',
        phone: '+923001234567',
      });
      // v1 is untouched
      const v1 = await http()
        .get(url('/ag-a1/settings/versions/1'))
        .set('Authorization', as('owner'))
        .expect(200);
      expect(v1.body.document.tone).toBe('professional');
      const entry = gateway.audit.at(-1)!;
      expect(entry).toMatchObject({
        action: 'agent.settings_updated',
        targetId: 'ag-a1',
        actorUserId: 'owner-1',
      });
      expect(JSON.stringify(entry)).not.toContain('923001234567');
      expect(JSON.stringify(entry)).not.toContain('friendly');
    });

    it('optimistic concurrency: a stale expectedVersion is 409 with currentVersion and writes nothing', async () => {
      await putSettings({
        expectedVersion: 1,
        settings: { tone: 'concise' },
      }).expect(200);
      const stale = await putSettings({
        expectedVersion: 1,
        settings: { tone: 'formal' },
      }).expect(409);
      expect(stale.body).toMatchObject({
        code: 'AGENT_SETTINGS_VERSION_CONFLICT',
        currentVersion: 2,
      });
      expect(settings.filter((s) => s.agentId === 'ag-a1')).toHaveLength(2);
      // reload and retry
      await putSettings({
        expectedVersion: 2,
        settings: { tone: 'formal' },
      }).expect(200);
    });

    it('expectedVersion is required', async () => {
      await putSettings({ settings: { tone: 'friendly' } }).expect(400);
      await putSettings({ expectedVersion: 0, settings: {} }).expect(400);
      await putSettings({ expectedVersion: 1 }).expect(400);
    });

    it('400 AGENT_SETTINGS_INVALID lists every field problem', async () => {
      const res = await putSettings({
        expectedVersion: 1,
        settings: {
          tone: 'rude',
          hours: { mon: [['17:00', '09:00']] },
          escalation: {
            enabled: true,
            contacts: [{ name: 'X', phone: '0300' }],
            whenCallerAsks: true,
            afterMisses: 9,
            topics: [],
            outsideHours: 'callback',
          },
          extra: 1,
        },
      }).expect(400);
      expect(res.body.code).toBe('AGENT_SETTINGS_INVALID');
      const pairs = res.body.details.map((d: Row) => `${d.field}:${d.code}`);
      expect(pairs).toEqual(
        expect.arrayContaining([
          'tone:not_allowed',
          'hours.mon[0]:end_before_start',
          'escalation.contacts[0].phone:invalid_phone',
          'escalation.afterMisses:out_of_range',
        ]),
      );
      // an unknown key (`extra`) is not a problem: the engine owns the field list
      expect(pairs.some((pair: string) => pair.startsWith('extra:'))).toBe(
        false,
      );
      expect(settings.filter((s) => s.agentId === 'ag-a1')).toHaveLength(1);
    });

    it("stores the engine's collect document as it is", async () => {
      const collect = {
        enabled: true,
        services: [{ id: 'x', label: { en: 'X' } }],
      };
      const res = await putSettings({
        expectedVersion: 1,
        settings: { collect },
      }).expect(200);
      expect(res.body.document.collect).toEqual(collect);
    });

    it('saving the same document again adds no version', async () => {
      const res = await putSettings({
        expectedVersion: 1,
        settings: { tone: 'professional' },
      }).expect(200);
      expect(res.body.version).toBe(1);
      expect(gateway.audit).toHaveLength(0);
    });

    it('lists versions newest first without documents; an unknown version is 404', async () => {
      await putSettings({ expectedVersion: 1, settings: { tone: 'concise' } });
      const list = await http()
        .get(url('/ag-a1/settings/versions'))
        .set('Authorization', as('owner'))
        .expect(200);
      expect(list.body.data.map((v: Row) => v.version)).toEqual([2, 1]);
      expect(list.body.data[0]).not.toHaveProperty('document');
      expect(list.body.data[0].createdBy).toBe('owner-1');
      const missing = await http()
        .get(url('/ag-a1/settings/versions/9'))
        .set('Authorization', as('owner'))
        .expect(404);
      expect(missing.body.code).toBe('AGENT_SETTINGS_VERSION_NOT_FOUND');
      await http()
        .get(url('/ag-a1/settings/versions/99999999999'))
        .set('Authorization', as('owner'))
        .expect(404);
    });

    it("two tenants: another tenant's agent settings are 404 to read, list and write", async () => {
      const auth = as('owner');
      await http()
        .get(url('/ag-b1/settings'))
        .set('Authorization', auth)
        .expect(404);
      await http()
        .get(url('/ag-b1/settings/versions'))
        .set('Authorization', auth)
        .expect(404);
      await http()
        .get(url('/ag-b1/settings/versions/1'))
        .set('Authorization', auth)
        .expect(404);
      await putSettings(
        { expectedVersion: 1, settings: { tone: 'formal' } },
        auth,
        'ag-b1',
      ).expect(404);
      expect(settings.filter((s) => s.agentId === 'ag-b1')).toHaveLength(1);
    });
  });

  describe('GET /internal/tenants/:tenantId/agents/:agentId/config (the engine pull)', () => {
    it('is outside /v1 and needs the service token: 401 without or with a wrong one, never staff or platform tokens', async () => {
      const path = '/internal/tenants/tenant-a/agents/ag-a1/config';
      await http().get(path).expect(401);
      await http().get(path).set('Authorization', 'Bearer wrong').expect(401);
      await http().get(path).set('Authorization', as('owner')).expect(401);
      await http()
        .get(`/v1${path}`)
        .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
        .expect(404);
    });

    it('returns the current version with status and the document, cacheable for 60 seconds, with an ETag', async () => {
      const res = await internal('tenant-a', 'ag-a1').expect(200);
      expect(res.body).toMatchObject({
        tenantId: 'tenant-a',
        agentId: 'ag-a1',
        version: 1,
        status: 'active',
        config: { businessName: 'Acme Dental', timezone: 'Asia/Karachi' },
      });
      expect(res.headers['cache-control']).toBe('private, max-age=60');
      expect(res.headers.etag).toMatch(/^"[0-9a-f]{24}"$/);
    });

    it('answers 304 to a matching If-None-Match, and a new body once the version or status changes', async () => {
      const first = await internal('tenant-a', 'ag-a1').expect(200);
      const etag = first.headers.etag;
      const again = await internal('tenant-a', 'ag-a1')
        .set('If-None-Match', etag)
        .expect(304);
      expect(again.text).toBe('');
      expect(again.headers.etag).toBe(etag);
      await internal('tenant-a', 'ag-a1')
        .set('If-None-Match', `W/${etag}, "x"`)
        .expect(304);
      await internal('tenant-a', 'ag-a1')
        .set('If-None-Match', '"other"')
        .expect(200);

      await http()
        .put(url('/ag-a1/settings'))
        .set('Authorization', as('owner'))
        .send({ expectedVersion: 1, settings: { tone: 'friendly' } })
        .expect(200);
      const changed = await internal('tenant-a', 'ag-a1')
        .set('If-None-Match', etag)
        .expect(200);
      expect(changed.body).toMatchObject({
        version: 2,
        config: { tone: 'friendly' },
      });
      expect(changed.headers.etag).not.toBe(etag);

      await http()
        .patch(url('/ag-a1'))
        .set('Authorization', as('owner'))
        .send({ status: 'disabled' })
        .expect(200);
      await internal('tenant-a', 'ag-a1')
        .set('If-None-Match', changed.headers.etag)
        .expect(200);
    });

    it('a disabled agent answers 200 with status "disabled" so the engine can play its message', async () => {
      agents.find((a) => a.id === 'ag-a1')!.status = 'disabled';
      const res = await internal('tenant-a', 'ag-a1').expect(200);
      expect(res.body.status).toBe('disabled');
      expect(res.body.config).toBeDefined();
    });

    it('?version= pins a past version; an unknown or malformed one is 404 / 400', async () => {
      await http()
        .put(url('/ag-a1/settings'))
        .set('Authorization', as('owner'))
        .send({ expectedVersion: 1, settings: { tone: 'friendly' } })
        .expect(200);
      const old = await internal('tenant-a', 'ag-a1', '?version=1').expect(200);
      expect(old.body).toMatchObject({
        version: 1,
        config: { tone: 'professional' },
      });
      const missing = await internal('tenant-a', 'ag-a1', '?version=7').expect(
        404,
      );
      expect(missing.body.code).toBe('AGENT_SETTINGS_VERSION_NOT_FOUND');
      for (const bad of ['0', '-1', 'abc', '1.5', '99999999999']) {
        await internal('tenant-a', 'ag-a1', `?version=${bad}`).expect(400);
      }
    });

    it("the agent must belong to the tenant in the path: another tenant's agent and unknown ids are the same 404", async () => {
      const cross = await internal('tenant-a', 'ag-b1').expect(404);
      const unknown = await internal('tenant-a', 'nope').expect(404);
      const unknownTenant = await internal('tenant-zzz', 'ag-a1').expect(404);
      for (const res of [cross, unknown, unknownTenant]) {
        expect(res.body).toMatchObject({
          statusCode: 404,
          code: 'AGENT_NOT_FOUND',
          message: 'Agent not found',
        });
      }
    });

    it('is rate limited per tenant (429 with Retry-After), while another tenant is unaffected', async () => {
      for (let i = 0; i < CONFIG_PULLS_PER_MINUTE; i++) {
        await internal('tenant-a', 'ag-a1').expect(200);
      }
      const limited = await internal('tenant-a', 'ag-a1').expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
      await internal('tenant-b', 'ag-b1').expect(200);
    }, 60_000);
  });

  describe('GET /internal/tenants/:tenantId/agents (the engine list, Phase 5B-3)', () => {
    const list = (tenantId: string) =>
      http()
        .get(`/internal/tenants/${tenantId}/agents`)
        .set('Authorization', `Bearer ${INTERNAL_TOKEN}`);

    it('is outside /v1 and needs the service token: 401 without or with a wrong one, never staff tokens', async () => {
      const path = '/internal/tenants/tenant-a/agents';
      await http().get(path).expect(401);
      await http().get(path).set('Authorization', 'Bearer wrong').expect(401);
      await http().get(path).set('Authorization', as('owner')).expect(401);
      await http()
        .get(`/v1${path}`)
        .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
        .expect(404);
    });

    it("answers {agents:[{agentId, name, status, isDefault}]} for the tenant's agents and nothing else (no settings, no other tenant)", async () => {
      seedAgent('tenant-a', 'ag-a2', {
        name: 'Branch',
        status: 'disabled',
        isDefault: false,
      });
      const res = await list('tenant-a').expect(200);
      expect(res.body).toEqual({
        agents: [
          {
            agentId: 'ag-a1',
            name: 'Acme Dental',
            status: 'active',
            isDefault: true,
          },
          {
            agentId: 'ag-a2',
            name: 'Branch',
            status: 'disabled',
            isDefault: false,
          },
        ],
      });
      const other = await list('tenant-b').expect(200);
      expect(other.body.agents.map((a: Row) => a.agentId)).toEqual(['ag-b1']);
      expect(JSON.stringify(res.body)).not.toMatch(/document|phone|escalation/);
    });

    it('an unknown tenant is a 404 TENANT_NOT_FOUND, like the other internal routes', async () => {
      const res = await list('tenant-zzz').expect(404);
      expect(res.body).toMatchObject({
        statusCode: 404,
        code: 'TENANT_NOT_FOUND',
      });
    });

    it('is rate limited per tenant (429 with Retry-After), while another tenant is unaffected', async () => {
      for (let i = 0; i < AGENT_LISTS_PER_MINUTE; i++) {
        await list('tenant-a').expect(200);
      }
      const limited = await list('tenant-a').expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
      await list('tenant-b').expect(200);
    }, 60_000);
  });

  describe('a settings document written the way the engine hand-off shows it (Phase 5B-3)', () => {
    const engineFields = {
      greeting: {
        en: 'Hello, thanks for calling {business}. How can I help?',
      },
      recordCalls: false,
      autoEndCalls: true,
      endCallDelaySeconds: 3,
      profileSummary: 'A dental clinic open on weekdays.',
      profileSummarySources: [
        { id: 'ks_1', title: 'About us', hash: '9f86d081884c7d65' },
      ],
      collectVersion: 4,
      futureEngineField: { anything: ['goes', 1] },
    };

    it('is saved through PUT (new fields, an unknown key, escalation.announce and an unknown escalation key) and handed back unchanged by the config pull', async () => {
      const escalation = {
        enabled: true,
        contacts: [
          { id: 'c1', role: 'Doctor', name: 'Ayesha', phone: '+923001234567' },
        ],
        whenCallerAsks: true,
        afterMisses: 2,
        topics: ['emergency'],
        outsideHours: 'callback',
        announce: { en: "I'm connecting you to {name}, our {role}." },
        futureRule: { x: 1 },
      };
      const saved = await http()
        .put(url('/ag-a1/settings'))
        .set('Authorization', as('owner'))
        .send({
          expectedVersion: 1,
          settings: { ...engineFields, escalation },
        })
        .expect(200);
      expect(saved.body.version).toBe(2);
      const pulled = await internal('tenant-a', 'ag-a1').expect(200);
      expect(pulled.body.version).toBe(2);
      expect(pulled.body.config).toMatchObject({
        ...engineFields,
        escalation,
        businessName: 'Acme Dental',
      });
    });

    it('saving exactly the same fields again adds no version', async () => {
      await http()
        .put(url('/ag-a1/settings'))
        .set('Authorization', as('owner'))
        .send({ expectedVersion: 1, settings: engineFields })
        .expect(200);
      const again = await http()
        .put(url('/ag-a1/settings'))
        .set('Authorization', as('owner'))
        .send({ expectedVersion: 2, settings: engineFields })
        .expect(200);
      expect(again.body.version).toBe(2);
      expect(settings.filter((s) => s.agentId === 'ag-a1')).toHaveLength(2);
    });

    it('a value the engine would also refuse is a 400 AGENT_SETTINGS_INVALID with the field named, and nothing is saved', async () => {
      const res = await http()
        .put(url('/ag-a1/settings'))
        .set('Authorization', as('owner'))
        .send({
          expectedVersion: 1,
          settings: { endCallDelaySeconds: 99, greeting: { fr: 'x' } },
        })
        .expect(400);
      expect(res.body.code).toBe('AGENT_SETTINGS_INVALID');
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'endCallDelaySeconds',
            code: 'out_of_range',
          }),
          expect.objectContaining({
            field: 'greeting.fr',
            code: 'unknown_field',
          }),
        ]),
      );
      expect(settings.filter((s) => s.agentId === 'ag-a1')).toHaveLength(1);
    });
  });

  describe('the mock engine pulls the settings at the start of a call', () => {
    // This suite proves the settings pull in isolation (no subscription fixtures here), so the mock
    // runs without the backend bridge; the whole call flow with the status check is in
    // requests.e2e-spec.ts and the database suite.
    beforeAll(() => engine.setBackend(undefined));

    it('a simulated call uses the default agent, its current settings version, and puts the agent id on the events', async () => {
      const first = await engine.simulateCall('tenant-a');
      expect(first).toMatchObject({
        agentId: 'ag-a1',
        settingsVersion: 1,
        config: { businessName: 'Acme Dental' },
      });
      await http()
        .put(url('/ag-a1/settings'))
        .set('Authorization', as('owner'))
        .send({
          expectedVersion: 1,
          settings: { businessName: 'Acme Dental Care' },
        })
        .expect(200);
      const second = await engine.simulateCall('tenant-a');
      expect(second).toMatchObject({
        settingsVersion: 2,
        config: { businessName: 'Acme Dental Care' },
      });
      expect(
        engine.eventsOf('tenant-a', 'record.submitted')[1].data.agentId,
      ).toBe('ag-a1');
    });

    it("a named agent is pulled; another tenant's agent and a disabled agent take no call", async () => {
      seedAgent('tenant-a', 'ag-a2', { name: 'Night', isDefault: false });
      await expect(
        engine.simulateCall('tenant-a', { agentId: 'ag-a2' }),
      ).resolves.toMatchObject({ agentId: 'ag-a2' });
      await expect(
        engine.simulateCall('tenant-a', { agentId: 'ag-b1' }),
      ).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
      agents.find((a) => a.id === 'ag-a2')!.status = 'disabled';
      await expect(
        engine.simulateCall('tenant-a', { agentId: 'ag-a2' }),
      ).rejects.toThrow(/disabled/);
      expect(engine.recordsOf('tenant-a')).toHaveLength(1);
    });
  });
});
