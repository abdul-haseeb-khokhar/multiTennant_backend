import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FakeClock } from '../src/billing/clock';
import {
  installBilling,
  PLAN_ROWS,
  subscriptionRow,
} from './utils/billing-fixtures';
import { mockTransaction, PrismaMock } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

type Role = 'owner' | 'admin' | 'agent';

const PAYMENT = {
  amountMinor: 1_999_900,
  currency: 'PKR',
  method: 'bank_transfer',
  reference: 'TX-100',
};

describe('Billing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let clock: FakeClock;
  let staffToken: Awaited<ReturnType<typeof createTestApp>>['staffToken'];
  let platformToken: (id?: string) => string;
  let allowStaff: () => void;
  let billing: ReturnType<typeof installBilling>;

  const as = (role: Role, tenantId = 'tenant-a') =>
    `Bearer ${staffToken({ userId: `${role}-1`, tenantId, role })}`;
  const asAdmin = () => `Bearer ${platformToken()}`;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, prisma, clock, staffToken, platformToken, allowStaff } =
      await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    allowStaff();
    mockTransaction(prisma);
    billing = installBilling(prisma, clock, {
      subscription: { tenantId: 'tenant-a' },
    });
    prisma.platformAdmin.findUnique.mockResolvedValue({ id: 'admin-1' });
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-a',
      status: 'trial',
      defaultLocale: 'en',
    });
  });

  describe('GET /v1/plans (public pricing)', () => {
    beforeEach(() => {
      // Apply the where clause the service sends, so the test proves what is listed.
      prisma.plan.findMany.mockImplementation(
        ({ where }: { where?: { visibility?: string; active?: boolean } }) =>
          Promise.resolve(
            PLAN_ROWS.filter(
              (p) =>
                (!where?.visibility || p.visibility === where.visibility) &&
                (where?.active === undefined || p.active === where.active),
            ),
          ),
      );
    });

    it('needs no token and lists only Free, Pro and Enterprise (Starter is hidden)', async () => {
      const res = await http().get('/v1/plans').expect(200);
      expect(res.body.data.map((p: { code: string }) => p.code)).toEqual([
        'free',
        'pro',
        'enterprise',
      ]);
      expect(res.body).toMatchObject({ total: 3, skip: 0, take: 3 });
    });

    it('shows prices as integer minor units and entitlements; enterprise is a custom quote', async () => {
      const res = await http().get('/v1/plans').expect(200);
      const byCode = Object.fromEntries(
        res.body.data.map((p: { code: string }) => [p.code, p]),
      );
      expect(byCode.pro).toMatchObject({
        priceMinor: 1_999_900,
        yearlyPriceMinor: 19_999_000,
        currency: 'PKR',
        interval: 'month',
        entitlements: expect.objectContaining({ seats: 10 }),
      });
      expect(byCode.free).toMatchObject({ priceMinor: 0 });
      expect(byCode.enterprise.priceMinor).toBeNull();
      for (const plan of res.body.data) {
        expect(Number.isInteger(plan.priceMinor ?? 0)).toBe(true);
      }
      expect(JSON.stringify(res.body)).not.toMatch(
        /starter|providerPriceIds|fallback/i,
      );
    });
  });

  describe('GET /v1/tenants/:tenantId/billing (owner/admin)', () => {
    beforeEach(() => {
      billing.invoices.push(
        {
          id: 'inv-a',
          number: 'INV-2026-000001',
          tenantId: 'tenant-a',
          amountMinor: 1_999_900,
          currency: 'PKR',
          status: 'paid',
          recordedBy: 'admin-1',
        },
        {
          id: 'inv-b',
          number: 'INV-2026-000002',
          tenantId: 'tenant-b',
          amountMinor: 5_000_000,
          currency: 'PKR',
          status: 'paid',
        },
      );
    });

    it.each(['owner', 'admin'] as const)(
      'a %s sees plan, status, period, days left, limits and the tenant invoices',
      async (role) => {
        const res = await http()
          .get('/v1/tenants/tenant-a/billing')
          .set('Authorization', as(role))
          .expect(200);
        expect(res.body.subscription).toMatchObject({
          planCode: 'starter',
          planName: 'Starter',
          status: 'active',
          daysLeft: 15,
          currentPeriodEnd: '2026-10-22T00:00:00.000Z',
          cancelAtPeriodEnd: false,
          limits: expect.objectContaining({ seats: 3, knowledgeMb: 20 }),
        });
        expect(res.body.invoices.total).toBe(1);
        expect(res.body.invoices.data[0].number).toBe('INV-2026-000001');
      },
    );

    it('an agent cannot read billing (403 INSUFFICIENT_ROLE)', async () => {
      const res = await http()
        .get('/v1/tenants/tenant-a/billing')
        .set('Authorization', as('agent'))
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('401 without a token', async () => {
      await http().get('/v1/tenants/tenant-a/billing').expect(401);
    });

    it("tenant isolation: another tenant's token gets 403 TENANT_MISMATCH and sees nothing", async () => {
      const res = await http()
        .get('/v1/tenants/tenant-a/billing')
        .set('Authorization', as('owner', 'tenant-b'))
        .expect(403);
      expect(res.body.code).toBe('TENANT_MISMATCH');
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    });

    it("never shows another tenant's invoices or the admin-only columns", async () => {
      const res = await http()
        .get('/v1/tenants/tenant-a/billing')
        .set('Authorization', as('owner'))
        .expect(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('tenant-b');
      expect(text).not.toContain('INV-2026-000002');
      expect(text).not.toMatch(/recordedBy|admin-1|events/);
    });

    it('403 TENANT_SUSPENDED for a suspended tenant', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ status: 'suspended' });
      const res = await http()
        .get('/v1/tenants/tenant-a/billing')
        .set('Authorization', as('owner'))
        .expect(403);
      expect(res.body.code).toBe('TENANT_SUSPENDED');
    });

    it('403 TENANT_CLOSED for a closed account', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ status: 'closed' });
      const res = await http()
        .get('/v1/tenants/tenant-a/billing')
        .set('Authorization', as('owner'))
        .expect(403);
      expect(res.body.code).toBe('TENANT_CLOSED');
    });
  });

  describe('GET /v1/me carries the subscription for the dashboard banner', () => {
    beforeEach(() => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'agent-1',
        email: 'a@acme.com',
        name: null,
        role: 'agent',
        emailVerifiedAt: new Date(),
        locale: null,
        tenant: {
          id: 'tenant-a',
          name: 'Acme',
          slug: 'acme',
          plan: 'starter',
          status: 'trial',
          defaultLocale: 'en',
        },
      });
    });

    it('is visible to every role, and shows days left and limits', async () => {
      for (const role of ['owner', 'admin', 'agent'] as const) {
        const res = await http()
          .get('/v1/me')
          .set('Authorization', as(role))
          .expect(200);
        expect(res.body.subscription).toMatchObject({
          planCode: 'starter',
          status: 'active',
          daysLeft: 15,
          limits: expect.objectContaining({ seats: 3 }),
        });
        expect(res.body.subscription).not.toHaveProperty('provider');
      }
    });

    it('shows Free once Starter has run out, even though no job ever ran (request-time correctness)', async () => {
      clock.advanceDays(16);
      const res = await http()
        .get('/v1/me')
        .set('Authorization', as('agent'))
        .expect(200);
      expect(res.body.subscription).toMatchObject({
        planCode: 'free',
        planName: 'Free',
        status: 'active',
        daysLeft: null,
        limits: expect.objectContaining({ seats: 1, poweredByLabel: true }),
      });
      expect(billing.mirrors.at(-1)).toEqual({
        id: 'tenant-a',
        plan: 'free',
        status: 'active',
      });
    });
  });

  describe('platform-admin subscription routes: who may call them', () => {
    const routes: Array<[string, string, object | null]> = [
      ['get', '/v1/admin/tenants/tenant-a/subscription', null],
      [
        'post',
        '/v1/admin/tenants/tenant-a/subscription/activate',
        { planCode: 'pro', ...PAYMENT },
      ],
      [
        'post',
        '/v1/admin/tenants/tenant-a/subscription/record-payment',
        PAYMENT,
      ],
      ['post', '/v1/admin/tenants/tenant-a/subscription/extend', { days: 5 }],
      [
        'post',
        '/v1/admin/tenants/tenant-a/subscription/change-plan',
        { planCode: 'free' },
      ],
      ['post', '/v1/admin/tenants/tenant-a/subscription/cancel', {}],
    ];

    it.each(routes)(
      '%s %s: 401 without a token, 401 for every staff role',
      async (method, url, body) => {
        const call = (auth?: string) => {
          const req = (http() as any)[method](url) as request.Test;
          if (auth) req.set('Authorization', auth);
          return body ? req.send(body) : req;
        };
        await call().expect(401);
        for (const role of ['owner', 'admin', 'agent'] as const) {
          await call(as(role)).expect(401);
        }
        expect(prisma.subscription.update).not.toHaveBeenCalled();
        expect(prisma.invoice.create).not.toHaveBeenCalled();
      },
    );
  });

  describe('platform-admin subscription routes', () => {
    it('GET returns the subscription, invoices and the billing event log', async () => {
      const res = await http()
        .get('/v1/admin/tenants/tenant-a/subscription')
        .set('Authorization', asAdmin())
        .expect(200);
      expect(res.body.subscription).toMatchObject({
        id: 'sub-1',
        planCode: 'starter',
        provider: 'manual',
      });
      expect(res.body.invoices).toMatchObject({ data: [], total: 0 });
      expect(res.body.events).toMatchObject({ data: [], total: 0 });
    });

    it('GET 404 TENANT_NOT_FOUND for an unknown tenant', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      const res = await http()
        .get('/v1/admin/tenants/nope/subscription')
        .set('Authorization', asAdmin())
        .expect(404);
      expect(res.body.code).toBe('TENANT_NOT_FOUND');
    });

    it('activate moves Starter to Pro with a paid invoice, an event, an audit entry and the mirrors', async () => {
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(201);

      expect(res.body).toMatchObject({
        applied: true,
        duplicate: false,
        subscription: {
          planCode: 'pro',
          status: 'active',
          interval: 'month',
          currentPeriodEnd: '2026-11-07T00:00:00.000Z',
          limits: expect.objectContaining({ seats: 10 }),
        },
        invoice: {
          number: 'INV-2026-000001',
          amountMinor: 1_999_900,
          currency: 'PKR',
          status: 'paid',
          method: 'bank_transfer',
          reference: 'TX-100',
          recordedBy: 'admin-1',
        },
      });
      expect(billing.mirrors).toEqual([
        { id: 'tenant-a', plan: 'pro', status: 'active' },
      ]);
      expect(billing.events.map((e) => e.type)).toEqual(['payment.succeeded']);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-a',
        actorUserId: 'admin-1',
        actorRole: 'platform_admin',
        action: 'subscription.payment_recorded',
        requestId: expect.any(String),
      });
      // everything in one transaction
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('a yearly activation lasts twelve months; invoice numbers are sequential', async () => {
      await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({
          planCode: 'pro',
          interval: 'year',
          ...PAYMENT,
          amountMinor: 19_999_000,
        })
        .expect(201);
      expect(billing.row?.currentPeriodEnd).toEqual(
        new Date('2027-10-07T00:00:00.000Z'),
      );
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/record-payment')
        .set('Authorization', asAdmin())
        .send(PAYMENT)
        .expect(201);
      expect(res.body.invoice.number).toBe('INV-2026-000002');
    });

    it('applying the same idempotency key twice records one payment', async () => {
      const send = () =>
        http()
          .post('/v1/admin/tenants/tenant-a/subscription/activate')
          .set('Authorization', asAdmin())
          .send({ planCode: 'pro', ...PAYMENT, idempotencyKey: 'bank-slip-77' })
          .expect(201);
      const first = await send();
      const second = await send();
      expect(first.body).toMatchObject({ applied: true, duplicate: false });
      expect(second.body).toMatchObject({
        applied: false,
        duplicate: true,
        invoice: null,
      });
      expect(billing.invoices).toHaveLength(1);
      expect(billing.events).toHaveLength(1);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('record-payment renews from the end of the running period', async () => {
      await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(201);
      clock.advanceDays(20);
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/record-payment')
        .set('Authorization', asAdmin())
        .send({ ...PAYMENT, reference: 'TX-101' })
        .expect(201);
      expect(res.body.subscription.currentPeriodEnd).toBe(
        '2026-12-07T00:00:00.000Z',
      );
      expect(res.body.invoice.reference).toBe('TX-101');
    });

    it('extend lengthens Starter by days or to a date, with no invoice', async () => {
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/extend')
        .set('Authorization', asAdmin())
        .send({ days: 7 })
        .expect(200);
      expect(res.body.subscription).toMatchObject({
        planCode: 'starter',
        currentPeriodEnd: '2026-10-29T00:00:00.000Z',
        daysLeft: 22,
      });
      expect(res.body.invoice).toBeNull();
      expect(billing.invoices).toEqual([]);
      const dated = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/extend')
        .set('Authorization', asAdmin())
        .send({ until: '2026-12-01T00:00:00.000Z' })
        .expect(200);
      expect(dated.body.subscription.currentPeriodEnd).toBe(
        '2026-12-01T00:00:00.000Z',
      );
    });

    it('extend needs exactly one of until / days (400) and cannot shorten (400)', async () => {
      for (const body of [
        {},
        { days: 3, until: '2026-12-01T00:00:00.000Z' },
        { until: '2026-10-10T00:00:00.000Z' },
      ]) {
        const res = await http()
          .post('/v1/admin/tenants/tenant-a/subscription/extend')
          .set('Authorization', asAdmin())
          .send(body)
          .expect(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
    });

    it('change-plan moves to Free immediately with no invoice', async () => {
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/change-plan')
        .set('Authorization', asAdmin())
        .send({ planCode: 'free' })
        .expect(200);
      expect(res.body.subscription).toMatchObject({
        planCode: 'free',
        currentPeriodEnd: null,
        daysLeft: null,
      });
      expect(billing.invoices).toEqual([]);
      expect(billing.mirrors.at(-1)).toEqual({
        id: 'tenant-a',
        plan: 'free',
        status: 'active',
      });
    });

    it('change-plan to an unknown plan is 404 PLAN_NOT_FOUND', async () => {
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/change-plan')
        .set('Authorization', asAdmin())
        .send({ planCode: 'platinum' })
        .expect(404);
      expect(res.body.code).toBe('PLAN_NOT_FOUND');
    });

    it('cancel keeps Pro until the period ends, then Free', async () => {
      await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(201);
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/cancel')
        .set('Authorization', asAdmin())
        .send({})
        .expect(200);
      expect(res.body.subscription).toMatchObject({
        planCode: 'pro',
        status: 'canceled',
        cancelAtPeriodEnd: true,
      });
      clock.advanceDays(31);
      const after = await http()
        .get('/v1/admin/tenants/tenant-a/subscription')
        .set('Authorization', asAdmin())
        .expect(200);
      expect(after.body.subscription).toMatchObject({
        planCode: 'free',
        status: 'active',
      });
    });

    it('cancel on Free is 409 INVALID_SUBSCRIPTION_STATE', async () => {
      billing.row = subscriptionRow({
        tenantId: 'tenant-a',
        planCode: 'free',
        currentPeriodEnd: null,
      });
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/cancel')
        .set('Authorization', asAdmin())
        .send({})
        .expect(409);
      expect(res.body.code).toBe('INVALID_SUBSCRIPTION_STATE');
    });

    it.each([
      ['a fractional amount', { amountMinor: 19999.5 }],
      ['a zero amount', { amountMinor: 0 }],
      ['a negative amount', { amountMinor: -5 }],
      ['an amount above the maximum', { amountMinor: 3_000_000_000 }],
      ['an amount as a string', { amountMinor: '1999900' }],
      ['an unsupported currency', { currency: 'USD' }],
      ['an unknown method', { method: 'bitcoin' }],
      ['a missing method', { method: undefined }],
      ['a bad interval', { interval: 'week' }],
      ['a bad period end', { periodEnd: 'tomorrow' }],
    ])('activate rejects %s with 400', async (_name, patch) => {
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({ planCode: 'pro', ...PAYMENT, ...patch })
        .expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it('activating a plan that is not paid is 400 and a payment while suspended is 409', async () => {
      const notPaid = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({ planCode: 'free', ...PAYMENT })
        .expect(400);
      expect(notPaid.body.code).toBe('VALIDATION_ERROR');

      billing.row = subscriptionRow({
        tenantId: 'tenant-a',
        status: 'suspended',
        statusBeforeSuspension: 'active',
      });
      const suspended = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(409);
      expect(suspended.body.code).toBe('INVALID_SUBSCRIPTION_STATE');
    });

    it('Enterprise needs a period end and accepts an entitlement override', async () => {
      await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({ planCode: 'enterprise', ...PAYMENT })
        .expect(400);
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({
          planCode: 'enterprise',
          ...PAYMENT,
          periodEnd: '2027-06-30T00:00:00.000Z',
          entitlementsOverride: { seats: 40, voice: true },
        })
        .expect(201);
      expect(res.body.subscription).toMatchObject({
        planCode: 'enterprise',
        currentPeriodEnd: '2027-06-30T00:00:00.000Z',
        entitlementsOverride: { seats: 40, voice: true },
        limits: expect.objectContaining({ seats: 40, voice: true }),
      });
    });

    it('rejects an entitlement override with an unknown key', async () => {
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({
          planCode: 'enterprise',
          ...PAYMENT,
          periodEnd: '2027-06-30T00:00:00.000Z',
          entitlementsOverride: { unlimitedEverything: true },
        })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it("only touches the addressed tenant: a command for a tenant without a subscription changes nothing of tenant-a's", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-z' });
      const res = await http()
        .post('/v1/admin/tenants/tenant-z/subscription/activate')
        .set('Authorization', asAdmin())
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(404);
      expect(res.body.code).toBe('SUBSCRIPTION_NOT_FOUND');
      expect(billing.row?.planCode).toBe('starter');
      expect(billing.invoices).toEqual([]);
    });
  });

  describe('the whole lifecycle on a fake clock (I2, I3)', () => {
    const me = async () =>
      (
        await http()
          .get('/v1/tenants/tenant-a/billing')
          .set('Authorization', as('owner'))
          .expect(200)
      ).body.subscription;

    it('Starter for 15 days, then Free automatically', async () => {
      expect(await me()).toMatchObject({ planCode: 'starter', daysLeft: 15 });
      clock.advanceDays(14);
      expect(await me()).toMatchObject({ planCode: 'starter', daysLeft: 1 });
      clock.advanceDays(1);
      expect(await me()).toMatchObject({ planCode: 'free', status: 'active' });
    });

    it('Pro active -> period ends unpaid -> past_due -> 7 days grace -> Free', async () => {
      await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(201);
      clock.advanceDays(31);
      expect(await me()).toMatchObject({
        planCode: 'pro',
        status: 'past_due',
        graceDaysLeft: 7,
      });
      clock.advanceDays(6);
      expect(await me()).toMatchObject({
        planCode: 'pro',
        status: 'past_due',
        graceDaysLeft: 1,
      });
      clock.advanceDays(1);
      expect(await me()).toMatchObject({ planCode: 'free', status: 'active' });
    });

    it('paying during the grace period brings the tenant back to active', async () => {
      await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(201);
      clock.advanceDays(33);
      expect(await me()).toMatchObject({ status: 'past_due' });
      await http()
        .post('/v1/admin/tenants/tenant-a/subscription/record-payment')
        .set('Authorization', asAdmin())
        .send(PAYMENT)
        .expect(201);
      expect(await me()).toMatchObject({
        planCode: 'pro',
        status: 'active',
        graceEndsAt: null,
      });
    });

    it('records every automatic transition as a system billing event and audit entry', async () => {
      clock.advanceDays(20);
      await me();
      expect(billing.events.map((e) => [e.type, e.source])).toEqual([
        ['period.ended', 'system'],
      ]);
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-a',
        action: 'subscription.period_ended',
        actorRole: 'system',
      });
    });
  });

  describe('plan limits over HTTP', () => {
    const invite = (role: Role = 'owner', email = 'new@acme.com') =>
      http()
        .post('/v1/tenants/tenant-a/invites')
        .set('Authorization', as(role))
        .send({ email });

    beforeEach(() => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      prisma.staffInvite.create.mockImplementation(
        ({ data: { tokenHash: _omitted, ...data } }) =>
          Promise.resolve({ id: 'inv-1', createdAt: new Date(), ...data }),
      );
    });

    it('Starter (3 seats): the last free seat can be invited, the next one gets 403 PLAN_LIMIT_REACHED', async () => {
      prisma.tenantUser.count.mockResolvedValue(2); // owner + one agent
      prisma.staffInvite.count.mockResolvedValue(0);
      await invite().expect(201);

      prisma.staffInvite.count.mockResolvedValue(1); // that invite is now pending
      const res = await invite().expect(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        code: 'PLAN_LIMIT_REACHED',
      });
      expect(prisma.staffInvite.create).toHaveBeenCalledTimes(1);
    });

    it('counts only active users and pending invites of THIS tenant', async () => {
      prisma.tenantUser.count.mockResolvedValue(1);
      prisma.staffInvite.count.mockResolvedValue(0);
      await invite().expect(201);
      expect(prisma.tenantUser.count).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a', status: 'active' },
      });
      expect(prisma.staffInvite.count.mock.calls[0][0].where).toMatchObject({
        tenantId: 'tenant-a',
        acceptedAt: null,
        revokedAt: null,
      });
    });

    it('Free (1 seat) has no room for an invite; upgrading to Pro makes room at once', async () => {
      billing.row = subscriptionRow({
        tenantId: 'tenant-a',
        planCode: 'free',
        currentPeriodEnd: null,
      });
      prisma.tenantUser.count.mockResolvedValue(1);
      prisma.staffInvite.count.mockResolvedValue(0);
      const denied = await invite().expect(403);
      expect(denied.body.code).toBe('PLAN_LIMIT_REACHED');

      await http()
        .post('/v1/admin/tenants/tenant-a/subscription/activate')
        .set('Authorization', asAdmin())
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(201);
      await invite().expect(201);
    });

    it('a past_due tenant cannot add staff (403 SUBSCRIPTION_PAST_DUE)', async () => {
      billing.row = subscriptionRow({
        tenantId: 'tenant-a',
        planCode: 'pro',
        status: 'past_due',
        currentPeriodEnd: new Date('2026-10-05T00:00:00.000Z'),
        graceEndsAt: new Date('2026-10-12T00:00:00.000Z'),
      });
      prisma.tenantUser.count.mockResolvedValue(1);
      prisma.staffInvite.count.mockResolvedValue(0);
      const res = await invite().expect(403);
      expect(res.body.code).toBe('SUBSCRIPTION_PAST_DUE');
    });

    it('a downgrade that leaves no seat blocks invite acceptance and keeps the invite pending', async () => {
      billing.row = subscriptionRow({
        tenantId: 'tenant-a',
        planCode: 'free',
        currentPeriodEnd: null,
      });
      prisma.staffInvite.findUnique.mockResolvedValue({
        id: 'inv-1',
        tenantId: 'tenant-a',
        email: 'late@acme.com',
        role: 'agent',
        acceptedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 3_600_000),
        tenant: { status: 'trial' },
      });
      prisma.staffInvite.updateMany.mockResolvedValue({ count: 1 });
      prisma.tenantUser.count.mockResolvedValue(1);
      const res = await http()
        .post('/v1/auth/invites/accept')
        .send({ token: 'x'.repeat(43), password: 'correct-horse-battery' })
        .expect(403);
      expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
      expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    });

    it('re-enabling a disabled user takes a seat back (403 PLAN_LIMIT_REACHED when full)', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u9',
        tenantId: 'tenant-a',
        email: 'u9@acme.com',
        role: 'agent',
        status: 'disabled',
      });
      prisma.tenantUser.count.mockResolvedValue(3); // already at 3 of 3
      prisma.staffInvite.count.mockResolvedValue(0);
      const res = await http()
        .patch('/v1/tenants/tenant-a/users/u9')
        .set('Authorization', as('owner'))
        .send({ status: 'active' })
        .expect(403);
      expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });
  });

  describe('data use consent (I11): owner only, default off', () => {
    const consentRow = (over: Record<string, unknown> = {}) => ({
      id: 'c1',
      tenantId: 'tenant-a',
      purpose: 'model_training',
      status: 'granted',
      termsVersion: '2026-10-01',
      acceptedBy: 'owner-1',
      acceptedAt: new Date('2026-10-07T00:00:00.000Z'),
      revokedAt: null,
      ...over,
    });

    beforeEach(() => {
      prisma.dataUseConsent.findUnique.mockResolvedValue(null);
      prisma.dataUseConsent.upsert.mockImplementation(({ create }) =>
        Promise.resolve(consentRow(create)),
      );
      prisma.dataUseConsent.update.mockImplementation(({ data }) =>
        Promise.resolve(consentRow(data)),
      );
    });

    it('is OFF by default', async () => {
      const res = await http()
        .get('/v1/tenants/tenant-a/data-use')
        .set('Authorization', as('owner'))
        .expect(200);
      expect(res.body).toEqual({
        purpose: 'model_training',
        enabled: false,
        status: 'off',
        termsVersion: null,
        acceptedBy: null,
        acceptedAt: null,
        revokedAt: null,
      });
    });

    it.each(['admin', 'agent'] as const)(
      'a %s cannot read or change it (403 INSUFFICIENT_ROLE)',
      async (role) => {
        const get = await http()
          .get('/v1/tenants/tenant-a/data-use')
          .set('Authorization', as(role))
          .expect(403);
        expect(get.body.code).toBe('INSUFFICIENT_ROLE');
        const put = await http()
          .put('/v1/tenants/tenant-a/data-use')
          .set('Authorization', as(role))
          .send({ enabled: true, termsVersion: 'v1' })
          .expect(403);
        expect(put.body.code).toBe('INSUFFICIENT_ROLE');
        expect(prisma.dataUseConsent.upsert).not.toHaveBeenCalled();
      },
    );

    it('401 without a token; 403 TENANT_MISMATCH for another tenant', async () => {
      await http().get('/v1/tenants/tenant-a/data-use').expect(401);
      const res = await http()
        .put('/v1/tenants/tenant-a/data-use')
        .set('Authorization', as('owner', 'tenant-b'))
        .send({ enabled: true, termsVersion: 'v1' })
        .expect(403);
      expect(res.body.code).toBe('TENANT_MISMATCH');
    });

    it('the owner grants it explicitly: terms version, who and when are recorded and audited', async () => {
      const res = await http()
        .put('/v1/tenants/tenant-a/data-use')
        .set('Authorization', as('owner'))
        .send({ enabled: true, termsVersion: '2026-10-01' })
        .expect(200);
      expect(res.body).toMatchObject({
        enabled: true,
        status: 'granted',
        termsVersion: '2026-10-01',
        acceptedBy: 'owner-1',
      });
      expect(
        prisma.dataUseConsent.upsert.mock.calls[0][0].create,
      ).toMatchObject({
        tenantId: 'tenant-a',
        purpose: 'model_training',
        acceptedBy: 'owner-1',
      });
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-a',
        actorUserId: 'owner-1',
        action: 'data_use.granted',
      });
    });

    it('revoking keeps the record and is audited', async () => {
      prisma.dataUseConsent.findUnique.mockResolvedValue(consentRow());
      const res = await http()
        .put('/v1/tenants/tenant-a/data-use')
        .set('Authorization', as('owner'))
        .send({ enabled: false })
        .expect(200);
      expect(res.body).toMatchObject({ enabled: false, status: 'revoked' });
      expect(res.body.revokedAt).toEqual(expect.any(String));
      expect(prisma.auditLog.create.mock.calls[0][0].data.action).toBe(
        'data_use.revoked',
      );
    });

    it.each([
      ['no body', {}],
      [
        'enabled as a string (no implicit "ticked")',
        { enabled: 'true', termsVersion: 'v1' },
      ],
      ['enabled without the terms version', { enabled: true }],
      ['an empty terms version', { enabled: true, termsVersion: '' }],
    ])('rejects %s with 400', async (_name, body) => {
      await http()
        .put('/v1/tenants/tenant-a/data-use')
        .set('Authorization', as('owner'))
        .send(body)
        .expect(400);
      expect(prisma.dataUseConsent.upsert).not.toHaveBeenCalled();
    });
  });
});
