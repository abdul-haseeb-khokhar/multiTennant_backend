import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FakeClock } from '../src/billing/clock';
import { installBilling } from './utils/billing-fixtures';
import { mockTransaction, PrismaMock } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

type Role = 'owner' | 'admin' | 'agent';

/** Phase 4B (J6): the overage setting, its figures and the manual-invoicing fields, over HTTP. */
describe('Overage (e2e)', () => {
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

  const setup = (subscription: Record<string, unknown>) => {
    billing = installBilling(prisma, clock, {
      subscription: { tenantId: 'tenant-a', ...subscription },
    });
    billing.conversationsUsed = 0;
  };

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
    prisma.platformAdmin.findUnique.mockResolvedValue({ id: 'admin-1' });
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-a',
      status: 'active',
      defaultLocale: 'en',
    });
    setup({
      planCode: 'pro',
      interval: 'month',
      currentPeriodEnd: new Date('2026-11-07T00:00:00.000Z'),
    });
  });

  describe('GET /v1/tenants/:tenantId/billing', () => {
    it.each(['owner', 'admin'] as const)(
      'a %s sees the setting and the period figures: included, used, overage count and amount',
      async (role) => {
        billing.conversationsUsed = 1620;
        const res = await http()
          .get('/v1/tenants/tenant-a/billing')
          .set('Authorization', as(role))
          .expect(200);
        expect(res.body.subscription.overage).toEqual({
          available: true,
          enabled: true,
          priceMinor: 1500,
          minutePriceMinor: 2500,
          currency: 'PKR',
        });
        expect(res.body.usage.conversations).toEqual({
          period: 'month',
          periodStart: '2026-10-01T00:00:00.000Z',
          included: 1500,
          used: 1620,
          overageCount: 120,
          overageAmountMinor: 180_000,
          overagePriceMinor: 1500,
          currency: 'PKR',
        });
      },
    );

    it('inside the allowance the overage is zero', async () => {
      billing.conversationsUsed = 900;
      const res = await http()
        .get('/v1/tenants/tenant-a/billing')
        .set('Authorization', as('owner'))
        .expect(200);
      expect(res.body.usage.conversations).toMatchObject({
        used: 900,
        overageCount: 0,
        overageAmountMinor: 0,
      });
    });

    it('conversations held for a human while overage was off are not billed', async () => {
      billing.conversationsUsed = 1600;
      billing.heldForHuman = 100;
      const res = await http()
        .get('/v1/tenants/tenant-a/billing')
        .set('Authorization', as('owner'))
        .expect(200);
      expect(res.body.usage.conversations.overageCount).toBe(0);
    });

    it('Free has no overage price: no setting, nothing billed however far past the limit', async () => {
      setup({ planCode: 'free', interval: 'none', currentPeriodEnd: null });
      billing.conversationsUsed = 250;
      const res = await http()
        .get('/v1/tenants/tenant-a/billing')
        .set('Authorization', as('owner'))
        .expect(200);
      expect(res.body.subscription.overage).toEqual({
        available: false,
        enabled: false,
        priceMinor: null,
        minutePriceMinor: null,
        currency: 'PKR',
      });
      expect(res.body.usage.conversations).toMatchObject({
        included: 30,
        used: 250,
        overageCount: 0,
        overageAmountMinor: 0,
        overagePriceMinor: null,
      });
    });

    it('an agent cannot read billing (403 INSUFFICIENT_ROLE)', async () => {
      const res = await http()
        .get('/v1/tenants/tenant-a/billing')
        .set('Authorization', as('agent'))
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });
  });

  describe('GET /v1/me', () => {
    beforeEach(() => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'owner-1',
        tenantId: 'tenant-a',
        email: 'o@example.com',
        name: 'Owner',
        role: 'owner',
        status: 'active',
        locale: null,
        emailVerifiedAt: new Date(),
        createdAt: new Date(),
        tenant: {
          id: 'tenant-a',
          name: 'A',
          slug: 'a',
          plan: 'pro',
          status: 'active',
          defaultLocale: 'en',
        },
      });
      prisma.notification.count.mockResolvedValue(0);
    });

    it.each(['owner', 'admin', 'agent'] as const)(
      'a %s sees the setting in the subscription summary',
      async (role) => {
        const res = await http()
          .get('/v1/me')
          .set('Authorization', as(role))
          .expect(200);
        expect(res.body.subscription.overage).toEqual({
          available: true,
          enabled: true,
          priceMinor: 1500,
          minutePriceMinor: 2500,
          currency: 'PKR',
        });
        // the call-minute allowance and its price are in the limits (L6)
        expect(res.body.subscription.limits).toMatchObject({
          voice: true,
          callMinutesPerPeriod: 300,
          callMinutePeriod: 'month',
          overageMinuteMinor: 2500,
        });
      },
    );
  });

  describe('PATCH /v1/tenants/:tenantId/billing/settings (owner only)', () => {
    const patch = (role: Role, body: unknown, tenantId = 'tenant-a') =>
      http()
        .patch('/v1/tenants/tenant-a/billing/settings')
        .set('Authorization', as(role, tenantId))
        .send(body as object);

    it('the owner switches overage off: stored, audited, evented, and visible at once', async () => {
      const res = await patch('owner', { overageEnabled: false }).expect(200);
      expect(res.body.subscription.overage).toMatchObject({
        available: true,
        enabled: false,
        priceMinor: 1500,
      });
      expect(res.body.usage.conversations).toMatchObject({ included: 1500 });
      expect(billing.row?.overageEnabled).toBe(false);

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-a',
        actorUserId: 'owner-1',
        actorRole: 'owner',
        action: 'billing.overage_changed',
        targetType: 'subscription',
        before: { overageEnabled: true },
        after: { overageEnabled: false },
      });
      expect(billing.events.at(-1)).toMatchObject({
        tenantId: 'tenant-a',
        type: 'overage.changed',
        payload: { overageEnabled: false, previous: true },
      });

      const read = await http()
        .get('/v1/tenants/tenant-a/billing')
        .set('Authorization', as('admin'))
        .expect(200);
      expect(read.body.subscription.overage.enabled).toBe(false);
    });

    it('and back on', async () => {
      await patch('owner', { overageEnabled: false }).expect(200);
      const res = await patch('owner', { overageEnabled: true }).expect(200);
      expect(res.body.subscription.overage.enabled).toBe(true);
      expect(billing.row?.overageEnabled).toBe(true);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    });

    it('sending the value it already has is a no-op: no audit entry, no event', async () => {
      await patch('owner', { overageEnabled: true }).expect(200);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(billing.events).toEqual([]);
    });

    it.each(['admin', 'agent'] as const)(
      'a %s cannot change it (403 INSUFFICIENT_ROLE) and nothing is written',
      async (role) => {
        const res = await patch(role, { overageEnabled: false }).expect(403);
        expect(res.body.code).toBe('INSUFFICIENT_ROLE');
        expect(billing.row?.overageEnabled).toBe(true);
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      },
    );

    it('Free and Starter have no such setting: 409 OVERAGE_NOT_AVAILABLE', async () => {
      for (const planCode of ['free', 'starter']) {
        setup({ planCode, interval: 'none' });
        const res = await patch('owner', { overageEnabled: false }).expect(409);
        expect(res.body).toMatchObject({
          statusCode: 409,
          code: 'OVERAGE_NOT_AVAILABLE',
        });
        expect(billing.row?.overageEnabled).toBe(true);
      }
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it.each([
      ['a missing value', {}],
      ['a string instead of a boolean', { overageEnabled: 'false' }],
      ['null', { overageEnabled: null }],
    ])('400 for %s', async (_name, body) => {
      const res = await patch('owner', body).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(billing.row?.overageEnabled).toBe(true);
    });

    it("tenant isolation: another tenant's owner gets 403 TENANT_MISMATCH and changes nothing", async () => {
      const res = await patch(
        'owner',
        { overageEnabled: false },
        'tenant-b',
      ).expect(403);
      expect(res.body.code).toBe('TENANT_MISMATCH');
      expect(billing.row?.overageEnabled).toBe(true);
    });

    it('401 without a token; a platform admin token is not a tenant token', async () => {
      await http()
        .patch('/v1/tenants/tenant-a/billing/settings')
        .send({ overageEnabled: false })
        .expect(401);
      await http()
        .patch('/v1/tenants/tenant-a/billing/settings')
        .set('Authorization', asAdmin())
        .send({ overageEnabled: false })
        .expect(401);
      expect(billing.row?.overageEnabled).toBe(true);
    });

    it('a suspended tenant cannot change it (403 TENANT_SUSPENDED)', async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 'tenant-a',
        status: 'suspended',
        defaultLocale: 'en',
      });
      const res = await patch('owner', { overageEnabled: false }).expect(403);
      expect(res.body.code).toBe('TENANT_SUSPENDED');
    });
  });

  describe('platform admin: figures and manual invoicing', () => {
    it('GET shows the setting and the period figures', async () => {
      billing.conversationsUsed = 1620;
      const res = await http()
        .get('/v1/admin/tenants/tenant-a/subscription')
        .set('Authorization', asAdmin())
        .expect(200);
      expect(res.body.subscription.overage).toMatchObject({
        available: true,
        enabled: true,
      });
      expect(res.body.usage.conversations).toMatchObject({
        used: 1620,
        overageCount: 120,
        overageAmountMinor: 180_000,
      });
    });

    it('record-payment stores the overage count and amount on the invoice and the billing event; no tax lines', async () => {
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/record-payment')
        .set('Authorization', asAdmin())
        .send({
          amountMinor: 2_179_900,
          currency: 'PKR',
          method: 'bank_transfer',
          reference: 'TX-200',
          overageCount: 120,
          overageAmountMinor: 180_000,
        })
        .expect(201);
      expect(res.body.invoice).toMatchObject({
        amountMinor: 2_179_900,
        overageCount: 120,
        overageAmountMinor: 180_000,
      });
      expect(billing.invoices[0]).toMatchObject({
        overageCount: 120,
        overageAmountMinor: 180_000,
      });
      expect(billing.events.at(-1)?.payload).toMatchObject({
        overageCount: 120,
        overageAmountMinor: 180_000,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/tax/i);
    });

    it('without them the invoice has null overage fields (nothing invented)', async () => {
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/record-payment')
        .set('Authorization', asAdmin())
        .send({ amountMinor: 1_999_900, currency: 'PKR', method: 'cash' })
        .expect(201);
      expect(res.body.invoice).toMatchObject({
        overageCount: null,
        overageAmountMinor: null,
      });
    });

    it.each([
      ['a count without an amount', { overageCount: 3 }],
      [
        'an amount above the total paid',
        {
          overageCount: 3,
          overageAmountMinor: 3_000_000,
        },
      ],
      ['a negative amount', { overageCount: 3, overageAmountMinor: -5 }],
      ['a fractional count', { overageCount: 1.5, overageAmountMinor: 100 }],
    ])('400 for %s', async (_name, extra) => {
      const res = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/record-payment')
        .set('Authorization', asAdmin())
        .send({
          amountMinor: 2_179_900,
          currency: 'PKR',
          method: 'bank_transfer',
          ...extra,
        })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(billing.invoices).toEqual([]);
    });
  });

  describe('call minutes (L6, Phase 5A)', () => {
    const billingOf = (role: Role = 'owner', tenantId = 'tenant-a') =>
      http()
        .get('/v1/tenants/tenant-a/billing')
        .set('Authorization', as(role, tenantId));

    it.each(['owner', 'admin'] as const)(
      'a %s sees included, used, the extra minutes and their amount for the period',
      async (role) => {
        billing.callMinutesUsed = 342;
        const res = await billingOf(role).expect(200);
        expect(res.body.usage.callMinutes).toEqual({
          period: 'month',
          periodStart: '2026-10-01T00:00:00.000Z',
          included: 300,
          used: 342,
          overageMinutes: 42,
          overageAmountMinor: 105_000,
          overagePriceMinor: 2500,
          currency: 'PKR',
        });
        // chat figures are still there, separate
        expect(res.body.usage.conversations).toMatchObject({
          included: 1500,
          overageCount: 0,
        });
      },
    );

    it('inside the allowance, and exactly at it, nothing is overage', async () => {
      for (const used of [0, 299, 300]) {
        billing.callMinutesUsed = used;
        const res = await billingOf().expect(200);
        expect(res.body.usage.callMinutes).toMatchObject({
          used,
          overageMinutes: 0,
          overageAmountMinor: 0,
        });
      }
    });

    it('the figures follow the plan: Starter counts 30 in total, Free 20 a month, neither bills anything', async () => {
      setup({ planCode: 'starter', interval: 'none' });
      billing.callMinutesUsed = 99;
      let res = await billingOf().expect(200);
      expect(res.body.usage.callMinutes).toEqual({
        period: 'total',
        periodStart: '2026-10-07T00:00:00.000Z',
        included: 30,
        used: 99,
        overageMinutes: 0,
        overageAmountMinor: 0,
        overagePriceMinor: null,
        currency: 'PKR',
      });
      setup({ planCode: 'free', interval: 'none', currentPeriodEnd: null });
      billing.callMinutesUsed = 99;
      res = await billingOf().expect(200);
      expect(res.body.usage.callMinutes).toMatchObject({
        period: 'month',
        included: 20,
        used: 99,
        overageMinutes: 0,
        overagePriceMinor: null,
      });
      expect(res.body.subscription.overage.minutePriceMinor).toBeNull();
    });

    it('Enterprise is unlimited: included null, nothing overage', async () => {
      setup({ planCode: 'enterprise', interval: 'none' });
      billing.callMinutesUsed = 12_345;
      const res = await billingOf().expect(200);
      expect(res.body.usage.callMinutes).toMatchObject({
        included: null,
        used: 12_345,
        overageMinutes: 0,
      });
    });

    it('the owner switch changes the setting, not the minutes already used', async () => {
      billing.callMinutesUsed = 342;
      const res = await http()
        .patch('/v1/tenants/tenant-a/billing/settings')
        .set('Authorization', as('owner'))
        .send({ overageEnabled: false })
        .expect(200);
      expect(res.body.subscription.overage).toMatchObject({
        available: true,
        enabled: false,
        minutePriceMinor: 2500,
      });
      expect(res.body.usage.callMinutes).toMatchObject({
        used: 342,
        overageMinutes: 42,
      });
    });

    it('a price for minutes alone (an override on Free) makes the switch available; without a price it stays 409', async () => {
      setup({
        planCode: 'free',
        interval: 'none',
        currentPeriodEnd: null,
        entitlementsOverride: { overageMinuteMinor: 2000 },
      });
      const ok = await http()
        .patch('/v1/tenants/tenant-a/billing/settings')
        .set('Authorization', as('owner'))
        .send({ overageEnabled: false })
        .expect(200);
      expect(ok.body.subscription.overage).toMatchObject({
        available: true,
        enabled: false,
        priceMinor: null,
        minutePriceMinor: 2000,
      });
      setup({ planCode: 'free', interval: 'none', currentPeriodEnd: null });
      await http()
        .patch('/v1/tenants/tenant-a/billing/settings')
        .set('Authorization', as('owner'))
        .send({ overageEnabled: false })
        .expect(409);
    });

    it('an agent cannot read the minutes (billing is owner and admin), another tenant gets 403 TENANT_MISMATCH', async () => {
      expect((await billingOf('agent').expect(403)).body.code).toBe(
        'INSUFFICIENT_ROLE',
      );
      expect((await billingOf('owner', 'tenant-b').expect(403)).body.code).toBe(
        'TENANT_MISMATCH',
      );
    });

    it('the platform admin view carries the same figures', async () => {
      billing.callMinutesUsed = 310;
      const res = await http()
        .get('/v1/admin/tenants/tenant-a/subscription')
        .set('Authorization', asAdmin())
        .expect(200);
      expect(res.body.usage.callMinutes).toMatchObject({
        included: 300,
        used: 310,
        overageMinutes: 10,
        overageAmountMinor: 25_000,
      });
    });

    it('reads the minutes of this tenant only (the usage query is scoped to the token tenant)', async () => {
      await billingOf().expect(200);
      const calls = prisma.usageDaily.aggregate.mock.calls.map((c) => c[0]);
      const minuteCall = calls.find((c) => c._sum.callMinutes);
      expect(minuteCall.where.tenantId).toBe('tenant-a');
    });
  });
});
