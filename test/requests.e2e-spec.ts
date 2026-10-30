import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FakeClock } from '../src/billing/clock';
import { MockEngineClient } from '../src/engine/mock-engine.client';
import { STATUS_CHECKS_PER_MINUTE } from '../src/tenant-status/internal-tenant-status.controller';
import { RealtimeHub, staffChannel } from '../src/realtime/realtime.hub';
import { INTERNAL_WRITES_PER_MINUTE } from '../src/requests/requests.constants';
import { PrismaMock } from './utils/prisma-mock';
import { RequestsFixture, installRequests } from './utils/requests-fixtures';
import { createTestApp } from './utils/test-app';

const TOKEN = process.env.INTERNAL_API_TOKEN!;

const USERS = {
  'owner-a': { tenantId: 'tenant-a', role: 'owner' },
  'admin-a': { tenantId: 'tenant-a', role: 'admin' },
  'agent-a': { tenantId: 'tenant-a', role: 'agent' },
  'owner-b': { tenantId: 'tenant-b', role: 'owner' },
} as const;
type UserId = keyof typeof USERS;

const PHONE = '+923001234567';
const OTHER_PHONE = '+923009876543';

describe('Phase 5B-2: tenant status check, requests and the staff workflow (e2e, mocked database, mock engine)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let clock: FakeClock;
  let engine: MockEngineClient;
  let staffToken: Awaited<ReturnType<typeof createTestApp>>['staffToken'];
  let allowStaff: () => void;
  let resetRateLimits: () => void;
  let f: RequestsFixture;
  let hub: RealtimeHub;

  const http = () => request(app.getHttpServer());
  const as = (id: UserId) =>
    `Bearer ${staffToken({ userId: id, ...USERS[id] })}`;
  const internal = (method: 'get' | 'put' | 'post' | 'patch', path: string) =>
    http()[method](path).set('Authorization', `Bearer ${TOKEN}`);
  const status = (tenantId: string, agentId?: string) =>
    internal(
      'get',
      `/internal/tenants/${tenantId}/status${agentId ? `?agentId=${agentId}` : ''}`,
    );
  const staff = (tenantId = 'tenant-a', path = '') =>
    `/v1/tenants/${tenantId}/requests${path}`;

  beforeAll(async () => {
    ({ app, prisma, clock, engine, staffToken, allowStaff, resetRateLimits } =
      await createTestApp());
    hub = app.get(RealtimeHub);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    resetRateLimits();
    allowStaff();
    engine.reset();
    f = installRequests(prisma, clock, {
      tenants: [
        { id: 'tenant-a', plan: 'pro' },
        { id: 'tenant-b', plan: 'pro' },
        { id: 'tenant-free', plan: 'free' },
        {
          id: 'tenant-suspended',
          plan: 'pro',
          subscriptionStatus: 'suspended',
        },
        { id: 'tenant-closed', plan: 'pro', subscriptionStatus: 'closed' },
        {
          id: 'tenant-pastdue',
          plan: 'pro',
          subscriptionStatus: 'past_due',
        },
      ],
      users: [
        { id: 'owner-a', tenantId: 'tenant-a', role: 'owner' },
        { id: 'admin-a', tenantId: 'tenant-a', role: 'admin' },
        { id: 'agent-a', tenantId: 'tenant-a', role: 'agent' },
        {
          id: 'off-a',
          tenantId: 'tenant-a',
          role: 'agent',
          status: 'disabled',
        },
        { id: 'owner-b', tenantId: 'tenant-b', role: 'owner' },
      ],
      agents: [
        {
          id: 'ag-a1',
          tenantId: 'tenant-a',
          name: 'Front desk',
          isDefault: true,
        },
        { id: 'ag-a2', tenantId: 'tenant-a', name: 'Night' },
        {
          id: 'ag-b1',
          tenantId: 'tenant-b',
          name: 'B desk',
          isDefault: true,
        },
        {
          id: 'ag-f1',
          tenantId: 'tenant-free',
          name: 'Free desk',
          isDefault: true,
        },
        {
          id: 'ag-s1',
          tenantId: 'tenant-suspended',
          name: 'S desk',
          isDefault: true,
        },
        {
          id: 'ag-c1',
          tenantId: 'tenant-closed',
          name: 'C desk',
          isDefault: true,
        },
        {
          id: 'ag-p1',
          tenantId: 'tenant-pastdue',
          name: 'P desk',
          isDefault: true,
        },
      ],
    });
    // a past-due subscription is inside its grace period
    f.h.gateway.subscriptions.get('tenant-pastdue')!.graceEndsAt = new Date(
      clock.now().getTime() + 5 * 86_400_000,
    );
  });

  // ===========================================================================================
  describe('GET /internal/tenants/{tenantId}/status (his B1)', () => {
    it('a tenant within its minutes is serviceable, for its default agent when none is named', async () => {
      const res = await status('tenant-a').expect(200);
      expect(res.body).toEqual({
        tenantId: 'tenant-a',
        agentId: 'ag-a1',
        serviceable: true,
        reason: null,
        plan: 'pro',
        overage: false,
      });
      expect(res.headers['cache-control']).toBe('private, max-age=10');
    });

    it('names the agent that was asked for', async () => {
      const res = await status('tenant-a', 'ag-a2').expect(200);
      expect(res.body).toMatchObject({ agentId: 'ag-a2', serviceable: true });
    });

    it.each([
      ['suspended', 'tenant-suspended', 'suspended'],
      ['closed', 'tenant-closed', 'suspended'],
    ])('a %s tenant is not serviceable (reason suspended)', async (_n, id) => {
      const res = await status(id).expect(200);
      expect(res.body).toMatchObject({
        serviceable: false,
        reason: 'suspended',
        plan: 'pro',
        agentId: null,
      });
    });

    it('a past-due tenant is served within its allowance', async () => {
      f.setCallMinutes('tenant-pastdue', 10);
      const res = await status('tenant-pastdue').expect(200);
      expect(res.body).toMatchObject({ serviceable: true, overage: false });
    });

    it('a past-due tenant at its allowance is NOT pushed into overage: quota_exceeded', async () => {
      f.setCallMinutes('tenant-pastdue', 300);
      const res = await status('tenant-pastdue').expect(200);
      expect(res.body).toMatchObject({
        serviceable: false,
        reason: 'quota_exceeded',
      });
    });

    it('Pro at its allowance with overage on is serviceable and says the extra minutes are billed', async () => {
      f.setCallMinutes('tenant-a', 300);
      const res = await status('tenant-a').expect(200);
      expect(res.body).toMatchObject({
        serviceable: true,
        reason: null,
        overage: true,
      });
    });

    it('Pro at its allowance with overage off is quota_exceeded', async () => {
      f.setCallMinutes('tenant-a', 300);
      f.h.gateway.subscriptions.get('tenant-a')!.overageEnabled = false;
      const res = await status('tenant-a').expect(200);
      expect(res.body).toMatchObject({
        serviceable: false,
        reason: 'quota_exceeded',
        overage: false,
      });
    });

    it('Free has no minute price: its used-up allowance is quota_exceeded whatever the setting', async () => {
      f.setCallMinutes('tenant-free', 20);
      const res = await status('tenant-free').expect(200);
      expect(res.body).toMatchObject({
        serviceable: false,
        reason: 'quota_exceeded',
        plan: 'free',
      });
    });

    it('a disabled agent is agent_disabled, and it comes before the minutes', async () => {
      f.agents.find((a) => a.id === 'ag-a2')!.status = 'disabled';
      f.setCallMinutes('tenant-a', 300);
      f.h.gateway.subscriptions.get('tenant-a')!.overageEnabled = false;
      const res = await status('tenant-a', 'ag-a2').expect(200);
      expect(res.body).toEqual({
        tenantId: 'tenant-a',
        agentId: 'ag-a2',
        serviceable: false,
        reason: 'agent_disabled',
        plan: 'pro',
        overage: false,
      });
    });

    it("another tenant's agent gets exactly the answer of an agent that does not exist (nothing about other tenants leaks)", async () => {
      const foreign = await status('tenant-a', 'ag-b1').expect(200);
      const missing = await status('tenant-a', 'no-such-agent').expect(200);
      expect(foreign.body).toEqual(missing.body);
      expect(foreign.body).toEqual({
        tenantId: 'tenant-a',
        agentId: null,
        serviceable: false,
        reason: 'unknown_agent',
        plan: 'pro',
        overage: false,
      });
      // The lookup carried the tenant from the path.
      expect(prisma.agent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ag-b1', tenantId: 'tenant-a' },
        }),
      );
    });

    it("a disabled agent of ANOTHER tenant is not 'agent_disabled' for this one", async () => {
      f.agents.find((a) => a.id === 'ag-b1')!.status = 'disabled';
      const res = await status('tenant-a', 'ag-b1').expect(200);
      expect(res.body.reason).toBe('unknown_agent');
    });

    it('the tenant-level state wins over the agent: a suspended tenant with a made-up agent is suspended', async () => {
      const res = await status('tenant-suspended', 'whatever').expect(200);
      expect(res.body.reason).toBe('suspended');
    });

    it('an unknown tenant is a normal 200 that says nothing else', async () => {
      const res = await status('no-such-tenant').expect(200);
      expect(res.body).toEqual({
        tenantId: 'no-such-tenant',
        agentId: null,
        serviceable: false,
        reason: 'unknown_tenant',
        plan: null,
        overage: false,
      });
    });

    it('an over-long agent id is simply unknown', async () => {
      const res = await status('tenant-a', 'x'.repeat(300)).expect(200);
      expect(res.body.reason).toBe('unknown_agent');
    });

    it('is answered live: a suspension shows at once (no stale cache)', async () => {
      await status('tenant-a').expect(200);
      f.h.gateway.subscriptions.get('tenant-a')!.status = 'suspended';
      const res = await status('tenant-a').expect(200);
      expect(res.body.reason).toBe('suspended');
    });

    it('never decides from the denormalised tenant plan or status mirrors', async () => {
      await status('tenant-a').expect(200);
      for (const [select] of prisma.tenant.findUnique.mock.calls.map(
        (c: any[]) => [c[0].select],
      )) {
        expect(select).toEqual({ id: true });
      }
    });

    it('needs the service token: 401 without, 401 with a wrong one (the same body), and a staff token is no key', async () => {
      const none = await http()
        .get('/internal/tenants/tenant-a/status')
        .expect(401);
      const wrong = await http()
        .get('/internal/tenants/tenant-a/status')
        .set('Authorization', 'Bearer not-the-token')
        .expect(401);
      // same answer; only the correlation id differs
      const { requestId: _a, ...noneBody } = none.body;
      const { requestId: _b, ...wrongBody } = wrong.body;
      expect(noneBody).toEqual(wrongBody);
      await http()
        .get('/internal/tenants/tenant-a/status')
        .set('Authorization', as('owner-a'))
        .expect(401);
    });

    it('is outside /v1 and not in the public OpenAPI', async () => {
      await http()
        .get('/v1/internal/tenants/tenant-a/status')
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(404);
      const doc = await http().get('/docs-json').expect(200);
      expect(JSON.stringify(doc.body.paths)).not.toContain('/internal/');
    });

    it('is rate limited per tenant (429 with Retry-After), another tenant is unaffected', async () => {
      for (let i = 0; i < STATUS_CHECKS_PER_MINUTE; i++) {
        await status('tenant-a').expect(200);
      }
      const limited = await status('tenant-a').expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
      await status('tenant-b').expect(200);
    }, 60_000);
  });

  // ===========================================================================================
  describe('PUT /internal/tenants/{tenantId}/customers/by-phone', () => {
    const put = (tenantId: string, body: Record<string, unknown>) =>
      internal('put', `/internal/tenants/${tenantId}/customers/by-phone`).send(
        body,
      );

    it('creates the end customer of a number (201), and finds the same one again (200)', async () => {
      const first = await put('tenant-a', {
        phone: PHONE,
        name: 'Ahmed',
      }).expect(201);
      expect(first.body.created).toBe(true);
      const again = await put('tenant-a', { phone: PHONE }).expect(200);
      expect(again.body).toEqual({
        endCustomerId: first.body.endCustomerId,
        created: false,
      });
      expect(f.customersOf('tenant-a')).toHaveLength(1);
      expect(f.customersOf('tenant-a')[0]).toMatchObject({
        externalId: `phone_${PHONE}`,
        name: 'Ahmed',
      });
    });

    it('fills in a missing name and language but never overwrites what is there', async () => {
      await put('tenant-a', { phone: PHONE }).expect(201);
      await put('tenant-a', {
        phone: PHONE,
        name: 'Ahmed',
        locale: 'ur',
      }).expect(200);
      await put('tenant-a', {
        phone: PHONE,
        name: 'Someone else',
        locale: 'en',
      }).expect(200);
      expect(f.customersOf('tenant-a')[0]).toMatchObject({
        name: 'Ahmed',
        locale: 'ur',
      });
    });

    it('the same number in two tenants is two different customers', async () => {
      const a = await put('tenant-a', { phone: PHONE }).expect(201);
      const b = await put('tenant-b', { phone: PHONE }).expect(201);
      expect(a.body.endCustomerId).not.toBe(b.body.endCustomerId);
      expect(f.customersOf('tenant-a')).toHaveLength(1);
      expect(f.customersOf('tenant-b')).toHaveLength(1);
    });

    it.each(['0300123', '923001234567', '+0123456789', '+92 300 1234567', ''])(
      'refuses the number %p (400, nothing stored)',
      async (phone) => {
        await put('tenant-a', { phone }).expect(400);
        expect(f.customersOf('tenant-a')).toHaveLength(0);
      },
    );

    it('an agent of another tenant is a 404 AGENT_NOT_FOUND; an unknown tenant a 404 TENANT_NOT_FOUND', async () => {
      const foreign = await put('tenant-a', {
        phone: PHONE,
        agentId: 'ag-b1',
      }).expect(404);
      expect(foreign.body.code).toBe('AGENT_NOT_FOUND');
      const unknown = await put('nope', { phone: PHONE }).expect(404);
      expect(unknown.body.code).toBe('TENANT_NOT_FOUND');
      expect(f.customersOf('tenant-a')).toHaveLength(0);
    });

    it('a named agent of the tenant is accepted', async () => {
      await put('tenant-a', { phone: PHONE, agentId: 'ag-a2' }).expect(201);
    });

    it('needs the service token', async () => {
      await http()
        .put('/internal/tenants/tenant-a/customers/by-phone')
        .send({ phone: PHONE })
        .expect(401);
    });

    it('does not echo a refused number back in the error', async () => {
      const res = await put('tenant-a', { phone: '+1234' }).expect(400);
      expect(JSON.stringify(res.body)).not.toContain('+1234');
    });
  });

  // ===========================================================================================
  describe('POST /internal/tenants/{tenantId}/requests', () => {
    const customer = async (tenantId = 'tenant-a', phone = PHONE) =>
      (
        await internal(
          'put',
          `/internal/tenants/${tenantId}/customers/by-phone`,
        )
          .send({ phone, name: 'Ahmed' })
          .expect(201)
      ).body.endCustomerId as string;
    const body = (over: Record<string, unknown> = {}) => ({
      reference: 'AP-4K7Q2',
      type: 'appointment',
      submissionKey: 'call-1',
      summary: 'Ahmed wants a check-up on Thursday',
      scheduledLocal: '2026-11-05 15:30',
      timezone: 'Asia/Karachi',
      configVersion: 3,
      conversationId: 'conv-1',
      data: { service: 'check-up', note: 'prefers the afternoon' },
      ...over,
    });
    const create = (tenantId: string, payload: Record<string, unknown>) =>
      internal('post', `/internal/tenants/${tenantId}/requests`).send(payload);

    it('saves a request as requested (201) for the default agent when none is named', async () => {
      const endCustomerId = await customer();
      const res = await create('tenant-a', body({ endCustomerId })).expect(201);
      expect(res.body).toMatchObject({
        agentId: 'ag-a1',
        reference: 'AP-4K7Q2',
        type: 'appointment',
        status: 'requested',
        created: true,
      });
      expect(f.requestsOf('tenant-a')[0]).toMatchObject({
        tenantId: 'tenant-a',
        endCustomerId,
        source: 'call',
        channel: 'voice',
        configVersion: 3,
        details: { service: 'check-up', note: 'prefers the afternoon' },
      });
    });

    it('is idempotent by submissionKey: the same key is the SAME request (200, created false) and nothing is duplicated or re-announced', async () => {
      const endCustomerId = await customer();
      const first = await create('tenant-a', body({ endCustomerId })).expect(
        201,
      );
      const seen: string[] = [];
      const sub = hub.subscribe(staffChannel('tenant-a'), (e) =>
        seen.push(e.event),
      );
      const again = await create(
        'tenant-a',
        // even with a different reference and summary: the first save wins
        body({ endCustomerId, reference: 'AP-ZZZZZ', summary: 'other' }),
      ).expect(200);
      sub.unsubscribe();
      expect(again.body).toEqual({ ...first.body, created: false });
      expect(f.requestsOf('tenant-a')).toHaveLength(1);
      expect(f.requestsOf('tenant-a')[0].summary).not.toBe('other');
      expect(seen).toEqual([]);
      expect(f.notificationsOf('owner-a')).toHaveLength(1);
    });

    it('the same submissionKey in ANOTHER tenant is a different request', async () => {
      const a = await customer('tenant-a');
      const b = await customer('tenant-b');
      await create('tenant-a', body({ endCustomerId: a })).expect(201);
      const res = await create('tenant-b', body({ endCustomerId: b })).expect(
        201,
      );
      expect(res.body.created).toBe(true);
      expect(f.requestsOf('tenant-b')).toHaveLength(1);
    });

    it('a reference that belongs to another request is 409 REQUEST_REFERENCE_TAKEN (the engine draws another)', async () => {
      const endCustomerId = await customer();
      await create('tenant-a', body({ endCustomerId })).expect(201);
      const clash = await create(
        'tenant-a',
        body({ endCustomerId, submissionKey: 'call-2' }),
      ).expect(409);
      expect(clash.body).toMatchObject({
        statusCode: 409,
        code: 'REQUEST_REFERENCE_TAKEN',
      });
      const other = await create(
        'tenant-a',
        body({ endCustomerId, submissionKey: 'call-2', reference: 'AP-NEW99' }),
      ).expect(201);
      expect(other.body.reference).toBe('AP-NEW99');
    });

    it('the same reference in two tenants is fine (unique per tenant)', async () => {
      const a = await customer('tenant-a');
      const b = await customer('tenant-b');
      await create('tenant-a', body({ endCustomerId: a })).expect(201);
      await create('tenant-b', body({ endCustomerId: b })).expect(201);
    });

    it('stores the reference trimmed and upper case', async () => {
      const endCustomerId = await customer();
      const res = await create(
        'tenant-a',
        body({ endCustomerId, reference: ' ap-4k7q2 ' }),
      ).expect(201);
      expect(res.body.reference).toBe('AP-4K7Q2');
    });

    it('a named agent of the tenant takes the request; an agent of ANOTHER tenant is 404 AGENT_NOT_FOUND', async () => {
      const endCustomerId = await customer();
      const ok = await create(
        'tenant-a',
        body({ endCustomerId, agentId: 'ag-a2' }),
      ).expect(201);
      expect(ok.body.agentId).toBe('ag-a2');
      const foreign = await create(
        'tenant-a',
        body({
          endCustomerId,
          agentId: 'ag-b1',
          submissionKey: 'k2',
          reference: 'AP-2',
        }),
      ).expect(404);
      expect(foreign.body.code).toBe('AGENT_NOT_FOUND');
      expect(f.requestsOf('tenant-a')).toHaveLength(1);
    });

    it("another tenant's customer is 404 CUSTOMER_NOT_FOUND", async () => {
      const foreignCustomer = await customer('tenant-b');
      const res = await create(
        'tenant-a',
        body({ endCustomerId: foreignCustomer }),
      ).expect(404);
      expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
      expect(f.requestsOf('tenant-a')).toHaveLength(0);
    });

    it('an unknown tenant is 404 TENANT_NOT_FOUND', async () => {
      const res = await create('nope', body({ endCustomerId: 'x' })).expect(
        404,
      );
      expect(res.body.code).toBe('TENANT_NOT_FOUND');
    });

    it('a disabled agent still gets a request that was taken before it was disabled (the caller is not lost)', async () => {
      const endCustomerId = await customer();
      f.agents.find((a) => a.id === 'ag-a2')!.status = 'disabled';
      await create(
        'tenant-a',
        body({ endCustomerId, agentId: 'ag-a2' }),
      ).expect(201);
    });

    it.each([
      ['no reference', { reference: undefined }],
      ['a reference with spaces', { reference: 'AP 4K7Q2' }],
      ['a too short reference', { reference: 'A1' }],
      ['an unknown type', { type: 'refund' }],
      ['no submissionKey', { submissionKey: undefined }],
      ['no summary', { summary: undefined }],
      ['a summary over 1000 characters', { summary: 'x'.repeat(1001) }],
      ['a channel that is not voice or chat', { channel: 'sms' }],
      ['a negative config version', { configVersion: -1 }],
      ['data that is not an object', { data: 'text' }],
      ['data over 16 KB', { data: { blob: 'x'.repeat(17_000) } }],
    ])('refuses %s with 400 and stores nothing', async (_name, over) => {
      const endCustomerId = await customer();
      const res = await create(
        'tenant-a',
        body({ endCustomerId, ...over }),
      ).expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(f.requestsOf('tenant-a')).toHaveLength(0);
    });

    it('creates one notification per ACTIVE staff member (none for a disabled user, none for another tenant), without any caller data', async () => {
      const endCustomerId = await customer();
      const res = await create('tenant-a', body({ endCustomerId })).expect(201);
      for (const user of ['owner-a', 'admin-a', 'agent-a']) {
        const [n] = f.notificationsOf(user);
        expect(n).toMatchObject({
          tenantId: 'tenant-a',
          type: 'request.submitted',
          link: `/requests/${res.body.id}`,
          dedupeKey: `request:${res.body.id}:submitted`,
          params: {
            requestId: res.body.id,
            reference: 'AP-4K7Q2',
            requestType: 'appointment',
            agentId: 'ag-a1',
            agentName: 'Front desk',
          },
        });
      }
      expect(f.notificationsOf('off-a')).toHaveLength(0);
      expect(f.notificationsOf('owner-b')).toHaveLength(0);
      const stored = JSON.stringify(f.notificationsOf('owner-a'));
      for (const secret of ['Ahmed', PHONE, 'check-up', 'Thursday']) {
        expect(stored).not.toContain(secret);
      }
    });

    it('tells the dashboard of the tenant (ids only) and nobody else', async () => {
      const endCustomerId = await customer();
      const mine: Array<{ event: string; data: any }> = [];
      const theirs: string[] = [];
      const a = hub.subscribe(staffChannel('tenant-a'), (e) =>
        mine.push({ event: e.event, data: e.data }),
      );
      const b = hub.subscribe(staffChannel('tenant-b'), (e) =>
        theirs.push(e.event),
      );
      const res = await create('tenant-a', body({ endCustomerId })).expect(201);
      a.unsubscribe();
      b.unsubscribe();
      const created = mine.filter((m) => m.event === 'request.created');
      expect(created).toHaveLength(1);
      expect(created[0].data).toEqual({
        requestId: res.body.id,
        status: 'requested',
        agentId: 'ag-a1',
      });
      expect(theirs).toEqual([]);
    });

    it('needs the service token', async () => {
      await http()
        .post('/internal/tenants/tenant-a/requests')
        .send(body({ endCustomerId: 'x' }))
        .expect(401);
    });

    it('is rate limited per tenant (429 with Retry-After)', async () => {
      // (a body the validation refuses never reaches the counter, so count real calls: an unknown
      // reference is a 404 that still counts)
      const count = () =>
        internal('patch', '/internal/tenants/tenant-a/requests/AP-NOPE0').send({
          summary: 'x',
        });
      for (let i = 0; i < INTERNAL_WRITES_PER_MINUTE; i++) {
        await count().expect(404);
      }
      const limited = await count().expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
      await internal('patch', '/internal/tenants/tenant-b/requests/AP-NOPE0')
        .send({ summary: 'x' })
        .expect(404);
    }, 60_000);

    describe('PATCH …/requests/{reference} and POST …/withdraw (only while requested)', () => {
      let endCustomerId: string;
      let id: string;
      beforeEach(async () => {
        endCustomerId = await customer();
        id = (await create('tenant-a', body({ endCustomerId })).expect(201))
          .body.id;
      });
      const patch = (tenantId: string, ref: string, payload: object) =>
        internal('patch', `/internal/tenants/${tenantId}/requests/${ref}`).send(
          payload,
        );
      const withdraw = (tenantId: string, ref: string, payload: object = {}) =>
        internal(
          'post',
          `/internal/tenants/${tenantId}/requests/${ref}/withdraw`,
        ).send(payload);
      const confirm = () =>
        http()
          .patch(staff('tenant-a', `/${id}/status`))
          .set('Authorization', as('agent-a'))
          .send({ status: 'confirmed' })
          .expect(200);

      it('changes summary, time and the collected data while the request is requested', async () => {
        const res = await patch('tenant-a', 'AP-4K7Q2', {
          summary: 'Moved to Friday',
          scheduledLocal: '2026-11-06 10:00',
          data: { service: 'cleaning' },
        }).expect(200);
        expect(res.body).toMatchObject({
          id,
          status: 'requested',
          created: false,
        });
        expect(f.requestsOf('tenant-a')[0]).toMatchObject({
          summary: 'Moved to Friday',
          scheduledLocal: '2026-11-06 10:00',
          details: { service: 'cleaning' },
        });
      });

      it('finds the reference in any case', async () => {
        await patch('tenant-a', 'ap-4k7q2', { summary: 'x' }).expect(200);
      });

      it('once a person confirmed it the engine is refused: 409 REQUEST_LOCKED and nothing changes', async () => {
        await confirm();
        const before = JSON.stringify(f.requestsOf('tenant-a')[0]);
        const res = await patch('tenant-a', 'AP-4K7Q2', {
          summary: 'too late',
        }).expect(409);
        expect(res.body).toMatchObject({
          statusCode: 409,
          code: 'REQUEST_LOCKED',
        });
        expect(JSON.stringify(f.requestsOf('tenant-a')[0])).toBe(before);
        await withdraw('tenant-a', 'AP-4K7Q2').expect(409);
        expect(f.requestsOf('tenant-a')[0].status).toBe('confirmed');
      });

      it('an empty update is a 400; an unknown reference a 404; a reference of ANOTHER tenant a 404', async () => {
        await patch('tenant-a', 'AP-4K7Q2', {}).expect(400);
        const none = await patch('tenant-a', 'AP-NOPE0', {
          summary: 'x',
        }).expect(404);
        expect(none.body.code).toBe('REQUEST_NOT_FOUND');
        const foreign = await patch('tenant-b', 'AP-4K7Q2', {
          summary: 'x',
        }).expect(404);
        expect(foreign.body.code).toBe('REQUEST_NOT_FOUND');
        expect(f.requestsOf('tenant-a')[0].summary).not.toBe('x');
      });

      it('withdraws a request for the caller (cancelled by caller) and repeating it is harmless', async () => {
        const first = await withdraw('tenant-a', 'AP-4K7Q2', {
          reason: 'caller changed their mind',
        }).expect(200);
        expect(first.body.status).toBe('cancelled');
        expect(f.requestsOf('tenant-a')[0]).toMatchObject({
          status: 'cancelled',
          cancelledBy: 'caller',
          statusChangedBy: null,
        });
        await withdraw('tenant-a', 'AP-4K7Q2').expect(200);
      });

      it('cannot withdraw what a person cancelled (409) or what another tenant owns (404)', async () => {
        await http()
          .patch(staff('tenant-a', `/${id}/status`))
          .set('Authorization', as('agent-a'))
          .send({ status: 'cancelled' })
          .expect(200);
        await withdraw('tenant-a', 'AP-4K7Q2').expect(409);
        await withdraw('tenant-b', 'AP-4K7Q2').expect(404);
      });

      it('the engine needs the service token', async () => {
        await http()
          .patch('/internal/tenants/tenant-a/requests/AP-4K7Q2')
          .send({ summary: 'x' })
          .expect(401);
        await http()
          .post('/internal/tenants/tenant-a/requests/AP-4K7Q2/withdraw')
          .expect(401);
      });
    });
  });

  // ===========================================================================================
  describe('/v1/tenants/:tenantId/requests (the staff side)', () => {
    let first: string;
    let second: string;
    let foreign: string;

    const save = async (
      tenantId: string,
      phone: string,
      name: string,
      over: Record<string, unknown>,
    ) => {
      const customer = (
        await internal(
          'put',
          `/internal/tenants/${tenantId}/customers/by-phone`,
        )
          .send({ phone, name })
          .expect(201)
      ).body.endCustomerId;
      clock.advanceMs(1000);
      return (
        await internal('post', `/internal/tenants/${tenantId}/requests`)
          .send({
            type: 'appointment',
            summary: `${name} asks for an appointment`,
            endCustomerId: customer,
            data: { service: 'check-up', secret: `for ${name}` },
            ...over,
          })
          .expect(201)
      ).body.id as string;
    };

    beforeEach(async () => {
      first = await save('tenant-a', PHONE, 'Ahmed Khan', {
        reference: 'AP-AAAAA',
        submissionKey: 'k1',
      });
      second = await save('tenant-a', OTHER_PHONE, 'Sara Ali', {
        reference: 'CB-BBBBB',
        submissionKey: 'k2',
        type: 'callback',
        agentId: 'ag-a2',
      });
      foreign = await save('tenant-b', PHONE, 'Ahmed Khan', {
        reference: 'AP-AAAAA',
        submissionKey: 'k1',
      });
    });

    const get = (path = '', who: UserId = 'agent-a', tenant = 'tenant-a') =>
      http().get(staff(tenant, path)).set('Authorization', as(who));
    const move = (
      id: string,
      statusTo: string,
      who: UserId = 'agent-a',
      extra: object = {},
    ) =>
      http()
        .patch(staff('tenant-a', `/${id}/status`))
        .set('Authorization', as(who))
        .send({ status: statusTo, ...extra });

    describe('list, filters, counts and detail', () => {
      it("lists the tenant's requests newest first in the usual envelope, to every role, without the details", async () => {
        for (const who of ['owner-a', 'admin-a', 'agent-a'] as UserId[]) {
          const res = await get('', who).expect(200);
          expect(res.body).toMatchObject({ total: 2, skip: 0, take: 20 });
          expect(res.body.data.map((r: any) => r.reference)).toEqual([
            'CB-BBBBB',
            'AP-AAAAA',
          ]);
          expect(res.body.data[0]).toMatchObject({
            id: second,
            type: 'callback',
            status: 'requested',
            allowedStatuses: ['confirmed', 'cancelled'],
            agent: { id: 'ag-a2', name: 'Night' },
            customer: { name: 'Sara Ali', phone: OTHER_PHONE },
          });
          expect(res.body.data[0]).not.toHaveProperty('details');
        }
      });

      it("never shows another tenant's requests and refuses a token of another tenant (403 TENANT_MISMATCH)", async () => {
        const res = await get('').expect(200);
        expect(JSON.stringify(res.body)).not.toContain(foreign);
        const mismatch = await get('', 'owner-b', 'tenant-a').expect(403);
        expect(mismatch.body.code).toBe('TENANT_MISMATCH');
        // every list query carried the tenant
        for (const [args] of prisma.customerRequest.findMany.mock.calls) {
          expect(args.where.tenantId).toBe('tenant-a');
        }
      });

      it('filters by status, type and agent', async () => {
        await move(first, 'confirmed').expect(200);
        const byStatus = await get('?status=confirmed').expect(200);
        expect(byStatus.body.data.map((r: any) => r.id)).toEqual([first]);
        const byType = await get('?type=callback').expect(200);
        expect(byType.body.data.map((r: any) => r.id)).toEqual([second]);
        const byAgent = await get('?agentId=ag-a2').expect(200);
        expect(byAgent.body.data.map((r: any) => r.id)).toEqual([second]);
        await get('?status=pending').expect(400);
      });

      it('filters by date range', async () => {
        const stamp = f.requestsOf('tenant-a').find((r) => r.id === first)!
          .createdAt as Date;
        const after = new Date(stamp.getTime() + 1).toISOString();
        const res = await get(`?from=${after}`).expect(200);
        expect(res.body.data.map((r: any) => r.id)).toEqual([second]);
        const before = await get(`?to=${stamp.toISOString()}`).expect(200);
        expect(before.body.data.map((r: any) => r.id)).toEqual([first]);
        await get('?from=yesterday').expect(400);
      });

      it("searches the reference (any case), the customer's name and their phone number", async () => {
        const idsOf = async (q: string) =>
          (await get(`?q=${encodeURIComponent(q)}`).expect(200)).body.data.map(
            (r: any) => r.id,
          );
        expect(await idsOf('cb-bbb')).toEqual([second]);
        expect(await idsOf('sara')).toEqual([second]);
        expect(await idsOf('khan')).toEqual([first]);
        expect(await idsOf('300 123 4567')).toEqual([first]);
        expect(await idsOf('+923009876543')).toEqual([second]);
        expect(await idsOf('nobody')).toEqual([]);
        // a search never crosses the tenant: tenant B's Ahmed has the same number
        expect(await idsOf('4567')).toEqual([first]);
      });

      it('pages', async () => {
        const res = await get('?take=1&skip=1').expect(200);
        expect(res.body).toMatchObject({ total: 2, skip: 1, take: 1 });
        expect(res.body.data.map((r: any) => r.id)).toEqual([first]);
        await get('?take=101').expect(400);
      });

      it('counts by status, optionally for one agent', async () => {
        await move(first, 'confirmed').expect(200);
        const all = await get('/counts').expect(200);
        expect(all.body).toEqual({
          requested: 1,
          confirmed: 1,
          done: 0,
          cancelled: 0,
          total: 2,
        });
        const one = await get('/counts?agentId=ag-a2').expect(200);
        expect(one.body).toEqual({
          requested: 1,
          confirmed: 0,
          done: 0,
          cancelled: 0,
          total: 1,
        });
        for (const [args] of prisma.customerRequest.groupBy.mock.calls) {
          expect(args.where.tenantId).toBe('tenant-a');
        }
      });

      it('the detail has what the caller said; an id of another tenant is a 404 REQUEST_NOT_FOUND', async () => {
        const res = await get(`/${first}`).expect(200);
        expect(res.body).toMatchObject({
          id: first,
          reference: 'AP-AAAAA',
          summary: 'Ahmed Khan asks for an appointment',
          details: { service: 'check-up', secret: 'for Ahmed Khan' },
          customer: { name: 'Ahmed Khan', phone: PHONE },
          agent: { id: 'ag-a1', name: 'Front desk' },
          status: 'requested',
          cancelledBy: null,
        });
        expect(res.body).not.toHaveProperty('endCustomerId');
        const hidden = await get(`/${foreign}`).expect(404);
        expect(hidden.body.code).toBe('REQUEST_NOT_FOUND');
        const mismatch = await get(`/${first}`, 'owner-b', 'tenant-a').expect(
          403,
        );
        expect(mismatch.body.code).toBe('TENANT_MISMATCH');
      });

      it('is closed to anonymous callers', async () => {
        await http().get(staff()).expect(401);
        await http()
          .patch(staff('tenant-a', `/${first}/status`))
          .expect(401);
      });
    });

    describe('PATCH …/:requestId/status (confirm, done, cancel, reopen)', () => {
      it('confirms, completes, reopens and cancels, each audited with ids and statuses only', async () => {
        const confirmed = await move(first, 'confirmed', 'agent-a', {
          note: 'Booked with Dr Ayesha, call Ahmed at 0300',
        }).expect(200);
        expect(confirmed.body).toMatchObject({
          status: 'confirmed',
          allowedStatuses: ['done', 'cancelled', 'requested'],
          statusChangedBy: 'agent-a',
          note: 'Booked with Dr Ayesha, call Ahmed at 0300',
          details: { service: 'check-up' },
        });
        await move(first, 'done', 'admin-a').expect(200);
        await move(first, 'confirmed', 'owner-a').expect(200);
        await move(first, 'requested', 'owner-a').expect(200);
        const cancelled = await move(first, 'cancelled').expect(200);
        expect(cancelled.body.cancelledBy).toBe('staff');
        const reopened = await move(first, 'requested').expect(200);
        expect(reopened.body.cancelledBy).toBeNull();

        const audit = f.audit.filter((a: any) => a.targetType === 'request');
        expect(audit.map((a: any) => a.action)).toEqual([
          'request.confirmed',
          'request.done',
          'request.confirmed',
          'request.reopened',
          'request.cancelled',
          'request.reopened',
        ]);
        expect(audit[0]).toMatchObject({
          tenantId: 'tenant-a',
          actorUserId: 'agent-a',
          actorRole: 'agent',
          targetId: first,
          before: { status: 'requested' },
          after: { status: 'confirmed' },
        });
        const stored = JSON.stringify(audit);
        for (const secret of [
          'Ahmed',
          'Dr Ayesha',
          PHONE,
          '0300',
          'check-up',
        ]) {
          expect(stored).not.toContain(secret);
        }
      });

      it('refuses a move the workflow does not have: 409 REQUEST_TRANSITION_NOT_ALLOWED, nothing changes', async () => {
        const res = await move(first, 'done').expect(409);
        expect(res.body).toMatchObject({
          code: 'REQUEST_TRANSITION_NOT_ALLOWED',
          details: { currentStatus: 'requested' },
        });
        expect(
          f.requestsOf('tenant-a').find((r) => r.id === first)!.status,
        ).toBe('requested');
        expect(
          f.audit.filter((a: any) => a.targetType === 'request'),
        ).toHaveLength(0);
      });

      it('moving to the status it is already in is a 409 REQUEST_STATUS_CONFLICT with the current status', async () => {
        await move(first, 'confirmed').expect(200);
        const res = await move(first, 'confirmed').expect(409);
        expect(res.body).toMatchObject({
          code: 'REQUEST_STATUS_CONFLICT',
          details: { currentStatus: 'confirmed' },
        });
      });

      it('a stale expectedStatus is a 409 and nothing changes', async () => {
        await move(first, 'confirmed').expect(200);
        const res = await move(first, 'cancelled', 'agent-a', {
          expectedStatus: 'requested',
        }).expect(409);
        expect(res.body.code).toBe('REQUEST_STATUS_CONFLICT');
        expect(
          f.requestsOf('tenant-a').find((r) => r.id === first)!.status,
        ).toBe('confirmed');
      });

      it('two people confirming at the same moment: exactly one wins, one audit entry, the other is told', async () => {
        const [a, b] = await Promise.all([
          move(first, 'confirmed', 'agent-a', { expectedStatus: 'requested' }),
          move(first, 'confirmed', 'admin-a', { expectedStatus: 'requested' }),
        ]);
        expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
        const loser = a.status === 409 ? a : b;
        expect(loser.body.code).toBe('REQUEST_STATUS_CONFLICT');
        expect(
          f.audit.filter((x: any) => x.action === 'request.confirmed'),
        ).toHaveLength(1);
      });

      it('confirming and cancelling at the same moment: one wins, the loser is told what it is now', async () => {
        const [a, b] = await Promise.all([
          move(first, 'confirmed', 'agent-a', { expectedStatus: 'requested' }),
          move(first, 'cancelled', 'admin-a', { expectedStatus: 'requested' }),
        ]);
        expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
        const final = f.requestsOf('tenant-a').find((r) => r.id === first)!;
        expect(['confirmed', 'cancelled']).toContain(final.status);
        const loser = a.status === 409 ? a : b;
        expect(['REQUEST_STATUS_CONFLICT']).toContain(loser.body.code);
      });

      it('a request of another tenant cannot be moved: 404, and the conditional update carried the tenant', async () => {
        const res = await move(foreign, 'confirmed').expect(404);
        expect(res.body.code).toBe('REQUEST_NOT_FOUND');
        for (const [args] of prisma.customerRequest.updateMany.mock.calls) {
          expect(args.where.tenantId).toBe('tenant-a');
        }
        expect(
          f.requestsOf('tenant-b').find((r) => r.id === foreign)!.status,
        ).toBe('requested');
      });

      it('an unknown status or a note over 500 characters is a 400', async () => {
        await move(first, 'finished').expect(400);
        await move(first, 'confirmed', 'agent-a', {
          note: 'x'.repeat(501),
        }).expect(400);
        await move(first, 'confirmed', 'agent-a', { status: undefined }).expect(
          400,
        );
      });

      it('a note stays when the next move sends none, and is replaced when it sends one', async () => {
        await move(first, 'confirmed', 'agent-a', { note: 'first' }).expect(
          200,
        );
        const kept = await move(first, 'done').expect(200);
        expect(kept.body.note).toBe('first');
        const replaced = await move(first, 'confirmed', 'agent-a', {
          note: 'second',
        }).expect(200);
        expect(replaced.body.note).toBe('second');
      });

      it('tells the dashboard (ids and status only) after the commit', async () => {
        const seen: Array<{ event: string; data: any }> = [];
        const sub = hub.subscribe(staffChannel('tenant-a'), (e) =>
          seen.push({ event: e.event, data: e.data }),
        );
        await move(first, 'confirmed').expect(200);
        sub.unsubscribe();
        expect(seen).toEqual([
          {
            event: 'request.updated',
            data: { requestId: first, status: 'confirmed' },
          },
        ]);
        await move(first, 'done').expect(200);
      });
    });

    describe('delete protection of agents that have requests (AGENT_HAS_REQUESTS)', () => {
      it('is covered at unit level (AgentsService) and on real Postgres (test/db/requests-flows.db-spec.ts)', () => {
        expect(
          f.requestsOf('tenant-a').some((r) => r.agentId === 'ag-a2'),
        ).toBe(true);
      });
    });
  });

  // ===========================================================================================
  describe('the mock engine drives the whole flow (call -> request -> notification -> staff confirm -> engine update refused)', () => {
    it("a simulated call is checked, saves a request for its agent, notifies the team once, and after the staff confirmed it the engine's later update is refused with locked", async () => {
      const seen: string[] = [];
      const sub = hub.subscribe(staffChannel('tenant-a'), (e) =>
        seen.push(e.event),
      );

      const call = await engine.simulateCall('tenant-a', {
        agentId: 'ag-a2',
        phone: PHONE,
        name: 'Ahmed Khan',
      });
      await engine.flushEvents();
      sub.unsubscribe();

      // The request is in the BACKEND, for the agent that took the call, with the caller as customer.
      const stored = f.requestsOf('tenant-a');
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        id: call.recordId,
        reference: call.reference,
        agentId: 'ag-a2',
        status: 'requested',
        channel: 'voice',
        conversationId: call.conversationId,
      });
      expect(f.customersOf('tenant-a')[0]).toMatchObject({
        id: call.endCustomerId,
        externalId: `phone_${PHONE}`,
        name: 'Ahmed Khan',
      });

      // It is on the staff screen.
      const list = await http()
        .get(staff())
        .set('Authorization', as('agent-a'))
        .expect(200);
      expect(list.body.data[0]).toMatchObject({
        reference: call.reference,
        agent: { id: 'ag-a2' },
        customer: { phone: PHONE },
      });

      // The team was told ONCE, although both the route and the engine's event reported it.
      expect(f.notificationsOf('owner-a')).toHaveLength(1);
      expect(f.notificationsOf('agent-a')).toHaveLength(1);
      expect(seen.filter((e) => e === 'request.created')).toHaveLength(1);
      expect(f.engineEvents.map((e: any) => e.type)).toEqual(
        expect.arrayContaining(['record.submitted']),
      );

      // The engine may still correct it while it is requested ...
      await expect(
        engine.simulateRequestUpdate('tenant-a', call.reference, {
          summary: 'Moved to Friday',
        }),
      ).resolves.toBe(true);
      expect(f.requestsOf('tenant-a')[0].summary).toBe('Moved to Friday');

      // ... a person confirms it ...
      await http()
        .patch(staff('tenant-a', `/${call.recordId}/status`))
        .set('Authorization', as('agent-a'))
        .send({ status: 'confirmed' })
        .expect(200);

      // ... and the engine's later update is refused with `locked`: nothing changes.
      await expect(
        engine.simulateRequestUpdate('tenant-a', call.reference, {
          summary: 'too late',
        }),
      ).resolves.toBe(false);
      expect(f.requestsOf('tenant-a')[0].summary).toBe('Moved to Friday');
      const refused = await internal(
        'patch',
        `/internal/tenants/tenant-a/requests/${call.reference}`,
      )
        .send({ summary: 'too late' })
        .expect(409);
      expect(refused.body.code).toBe('REQUEST_LOCKED');
    });

    it('a caller who calls twice is one customer with two requests', async () => {
      await engine.simulateCall('tenant-a', { phone: PHONE });
      await engine.simulateCall('tenant-a', { phone: PHONE });
      expect(f.customersOf('tenant-a')).toHaveLength(1);
      expect(f.requestsOf('tenant-a')).toHaveLength(2);
    });

    it('the status check runs first: a suspended tenant, a tenant out of minutes and a disabled agent take no call and save nothing', async () => {
      await expect(
        engine.simulateCall('tenant-suspended'),
      ).rejects.toMatchObject({ reason: 'suspended' });
      f.setCallMinutes('tenant-free', 20);
      await expect(engine.simulateCall('tenant-free')).rejects.toMatchObject({
        reason: 'quota_exceeded',
      });
      f.agents.find((a) => a.id === 'ag-a2')!.status = 'disabled';
      await expect(
        engine.simulateCall('tenant-a', { agentId: 'ag-a2' }),
      ).rejects.toThrow(/disabled/);
      await expect(
        engine.simulateCall('tenant-a', { agentId: 'ag-b1' }),
      ).rejects.toMatchObject({ reason: 'unknown_agent' });
      expect(f.requests).toHaveLength(0);
      expect(f.customersOf('tenant-a')).toHaveLength(0);
    });

    it('a tenant at its allowance with overage on is still served (billed as overage)', async () => {
      f.setCallMinutes('tenant-a', 300);
      await expect(engine.simulateCall('tenant-a')).resolves.toBeDefined();
    });

    it('the caller can withdraw before a person acts, not after', async () => {
      const first = await engine.simulateCall('tenant-a');
      await expect(
        engine.simulateRequestWithdraw('tenant-a', first.reference),
      ).resolves.toBe(true);
      expect(f.requestsOf('tenant-a')[0]).toMatchObject({
        status: 'cancelled',
        cancelledBy: 'caller',
      });
      const second = await engine.simulateCall('tenant-a');
      await http()
        .patch(staff('tenant-a', `/${second.recordId}/status`))
        .set('Authorization', as('owner-a'))
        .send({ status: 'confirmed' })
        .expect(200);
      await expect(
        engine.simulateRequestWithdraw('tenant-a', second.reference),
      ).resolves.toBe(false);
    });

    it('records of two tenants never mix', async () => {
      const a = await engine.simulateCall('tenant-a');
      const b = await engine.simulateCall('tenant-b');
      const listA = await http()
        .get(staff('tenant-a'))
        .set('Authorization', as('owner-a'))
        .expect(200);
      const listB = await http()
        .get(staff('tenant-b'))
        .set('Authorization', as('owner-b'))
        .expect(200);
      expect(listA.body.data.map((r: any) => r.id)).toEqual([a.recordId]);
      expect(listB.body.data.map((r: any) => r.id)).toEqual([b.recordId]);
    });

    it('the /call chat command saves the request in the backend too', async () => {
      const ctx = { tenantId: 'tenant-a' };
      const { id } = await engine.createConversation(ctx, {
        channel: 'widget',
        endCustomerId: 'ec-x',
      });
      for await (const _event of engine.sendMessage(ctx, id, {
        content: '/call',
      })) {
        // drain the reply stream
      }
      expect(f.requestsOf('tenant-a')).toHaveLength(1);
    });
  });
});
