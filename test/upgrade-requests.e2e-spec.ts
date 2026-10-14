import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Mailer } from '../src/mail/mailer';
import { FakeClock } from '../src/billing/clock';
import { installBilling } from './utils/billing-fixtures';
import { mockTransaction, PrismaMock } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

type Role = 'owner' | 'admin' | 'agent';

interface RequestRow {
  id: string;
  tenantId: string;
  requestedPlanCode: string;
  note: string | null;
  requestedBy: string;
  status: string;
  handledBy: string | null;
  handledAt: Date | null;
  handledNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Phase 3C, J5: the owner's upgrade request, the platform team's queue, and the removed PATCH fields. */
describe('Upgrade requests (e2e, J5)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let clock: FakeClock;
  let staffToken: (u: {
    userId: string;
    tenantId: string;
    role: string;
  }) => string;
  let platformToken: (id?: string) => string;
  let allowStaff: () => void;
  let sent: Array<{
    to: string;
    template: string;
    locale: string;
    link: string;
    params?: Record<string, unknown>;
  }>;
  let rows: RequestRow[];
  // The per-tenant request limit counts in real time; every test starts two hours later than the
  // one before, so its counter is fresh (Date.now is the limiter's clock).
  let wallClock = Date.now();

  const http = () => request(app.getHttpServer());
  const as = (role: Role, tenantId = 'tenant-a', verified = true) =>
    `Bearer ${staffToken({ userId: `${role}-${tenantId}`, tenantId, role })}${verified ? '' : ''}`;
  const asAdmin = () => `Bearer ${platformToken()}`;
  const ask = (planCode: string, note?: string, token = as('owner')) =>
    http()
      .post('/v1/tenants/tenant-a/billing/upgrade-request')
      .set('Authorization', token)
      .send({ planCode, note });

  beforeAll(async () => {
    ({ app, prisma, clock, staffToken, platformToken, allowStaff } =
      await createTestApp());
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    allowStaff();
    mockTransaction(prisma);
    sent = [];
    rows = [];
    wallClock += 2 * 60 * 60 * 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => wallClock);
    // Record what would have been emailed instead of logging it (resetAllMocks clears the spy).
    jest.spyOn(app.get(Mailer), 'send').mockImplementation((message) => {
      sent.push(message as never);
      return Promise.resolve('sent');
    });
    installBilling(prisma, clock, {
      subscription: { tenantId: 'tenant-a', planCode: 'starter' },
    });
    prisma.platformAdmin.findUnique.mockResolvedValue({ id: 'admin-1' });
    prisma.tenant.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve({
          id: where.id,
          name: where.id === 'tenant-a' ? 'Acme <b>Support</b>' : 'Beta',
          slug: where.id,
          status: 'active',
          defaultLocale: 'en',
        }),
    );

    // The upgrade_requests table, in memory, with its "one pending per tenant" index.
    prisma.upgradeRequest.findFirst.mockImplementation(
      ({ where }: { where: { tenantId: string; status?: string } }) => {
        const matches = rows
          .filter(
            (r) =>
              r.tenantId === where.tenantId &&
              (where.status === undefined || r.status === where.status),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const found = matches[0];
        return Promise.resolve(
          found
            ? {
                ...found,
                plan: {
                  name:
                    found.requestedPlanCode === 'pro' ? 'Pro' : 'Enterprise',
                },
              }
            : null,
        );
      },
    );
    prisma.upgradeRequest.create.mockImplementation(
      ({ data }: { data: Partial<RequestRow> & { tenantId: string } }) => {
        const row: RequestRow = {
          id: `req-${rows.length + 1}`,
          note: null,
          status: 'pending',
          handledBy: null,
          handledAt: null,
          handledNote: null,
          createdAt: clock.now(),
          updatedAt: clock.now(),
          ...data,
        } as RequestRow;
        rows.push(row);
        return Promise.resolve({ ...row });
      },
    );
    prisma.upgradeRequest.update.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string; tenantId: string };
        data: Partial<RequestRow>;
      }) => {
        const row = rows.find(
          (r) => r.id === where.id && r.tenantId === where.tenantId,
        )!;
        Object.assign(row, data, { updatedAt: clock.now() });
        return Promise.resolve({ ...row });
      },
    );
    prisma.upgradeRequest.updateMany.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: Partial<RequestRow>;
      }) => {
        const row = rows.find(
          (r) => r.id === where.id && r.status === where.status,
        );
        if (row) Object.assign(row, data);
        return Promise.resolve({ count: row ? 1 : 0 });
      },
    );
    prisma.upgradeRequest.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        return Promise.resolve(row ? { ...row, plan: { name: 'Pro' } } : null);
      },
    );
    prisma.upgradeRequest.findMany.mockImplementation(
      ({ where }: { where: { status?: string } }) =>
        Promise.resolve(
          rows
            .filter((r) => !where.status || r.status === where.status)
            .map((r) => ({
              ...r,
              plan: { name: 'Pro' },
              tenant: { id: r.tenantId, name: r.tenantId, slug: r.tenantId },
            })),
        ),
    );
    prisma.upgradeRequest.count.mockImplementation(
      ({ where }: { where: { status?: string } }) =>
        Promise.resolve(
          rows.filter((r) => !where.status || r.status === where.status).length,
        ),
    );
    prisma.tenantUser.findMany.mockResolvedValue([]);
  });

  describe('POST /v1/tenants/:tenantId/billing/upgrade-request', () => {
    it('the owner asks: 201, stored as pending, audited, and the platform address is emailed', async () => {
      const res = await ask('pro', ' more seats please ').expect(201);
      expect(res.body).toMatchObject({
        requestedPlanCode: 'pro',
        requestedPlanName: 'Pro',
        note: 'more seats please',
        status: 'pending',
        replacedPending: false,
        notification: 'sent',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId: 'tenant-a',
        requestedBy: 'owner-tenant-a',
      });
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-a',
        action: 'upgrade.requested',
        actorRole: 'owner',
      });
      // the email: to the configured platform address, English, link to the console, tenant data as params
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        to: 'ops@platform.test',
        template: 'upgrade-request',
        locale: 'en',
        link: 'http://localhost:5173/admin/upgrade-requests',
      });
      expect(sent[0].params).toMatchObject({
        currentPlan: 'Starter',
        requestedPlan: 'Pro',
        note: 'more seats please',
      });
    });

    it.each(['admin', 'agent'] as Role[])(
      '%s gets 403 INSUFFICIENT_ROLE: only the owner asks',
      async (role) => {
        const res = await ask('pro', undefined, as(role)).expect(403);
        expect(res.body.code).toBe('INSUFFICIENT_ROLE');
        expect(rows).toHaveLength(0);
        expect(sent).toHaveLength(0);
      },
    );

    it('an owner of ANOTHER tenant is refused: the URL tenant must be the token tenant', async () => {
      const res = await http()
        .post('/v1/tenants/tenant-a/billing/upgrade-request')
        .set('Authorization', as('owner', 'tenant-b'))
        .send({ planCode: 'pro' })
        .expect(403);
      expect(res.body.code).toBe('TENANT_MISMATCH');
      expect(rows).toHaveLength(0);
    });

    it('an unverified owner is refused (H4: no way to a paid plan before the email is confirmed)', async () => {
      // allowStaff() has no unverified user; register one through the directory
      const unverified = staffToken({
        userId: 'owner-unverified',
        tenantId: 'tenant-a',
        role: 'owner',
      });
      void unverified;
      // staffToken registers an unrestricted user; make this one unverified via the strategy lookup
      prisma.tenantUser.findUnique.mockResolvedValue({
        role: 'owner',
        status: 'active',
        emailVerifiedAt: null,
        passwordChangedAt: null,
        tokensValidAfter: null,
      });
      const res = await ask('pro', undefined, `Bearer ${unverified}`).expect(
        403,
      );
      expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
      expect(rows).toHaveLength(0);
    });

    it('404 PLAN_NOT_FOUND for an unknown plan and for a plan that is not public (Starter)', async () => {
      for (const planCode of ['platinum', 'starter']) {
        const res = await ask(planCode).expect(404);
        expect(res.body.code).toBe('PLAN_NOT_FOUND');
      }
      expect(rows).toHaveLength(0);
    });

    it('409 ALREADY_ON_PLAN for the plan the workspace is on', async () => {
      installBilling(prisma, clock, {
        subscription: {
          tenantId: 'tenant-a',
          planCode: 'pro',
          interval: 'month',
          currentPeriodEnd: new Date('2026-11-07T00:00:00Z'),
        },
      });
      const res = await ask('pro').expect(409);
      expect(res.body.code).toBe('ALREADY_ON_PLAN');
    });

    it('400 VALIDATION_ERROR for a missing plan or a note over 500 characters', async () => {
      await http()
        .post('/v1/tenants/tenant-a/billing/upgrade-request')
        .set('Authorization', as('owner'))
        .send({})
        .expect(400);
      await ask('pro', 'x'.repeat(501)).expect(400);
    });

    it('asking again while pending replaces the request: one row, the new plan and note, a new email', async () => {
      await ask('pro', 'first').expect(201);
      const res = await ask('enterprise', 'second').expect(201);
      expect(res.body).toMatchObject({
        requestedPlanCode: 'enterprise',
        note: 'second',
        replacedPending: true,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        requestedPlanCode: 'enterprise',
        note: 'second',
        status: 'pending',
      });
      expect(sent).toHaveLength(2);
    });

    it('asking after the last one was handled opens a new pending request', async () => {
      await ask('pro').expect(201);
      await http()
        .post('/v1/admin/upgrade-requests/req-1/handle')
        .set('Authorization', asAdmin())
        .send({ status: 'declined' })
        .expect(200);
      const res = await ask('pro').expect(201);
      expect(res.body.replacedPending).toBe(false);
      expect(rows.map((r) => r.status)).toEqual(['declined', 'pending']);
    });

    it('is limited to five per hour (429 with Retry-After)', async () => {
      for (let i = 0; i < 5; i++) await ask('pro').expect(201);
      const res = await ask('pro').expect(429);
      expect(res.headers['retry-after']).toBeDefined();
    });

    it('a mail that cannot be delivered does not lose the request', async () => {
      jest
        .spyOn(app.get(Mailer), 'send')
        .mockRejectedValueOnce(new Error('provider down'));
      const res = await ask('pro').expect(201);
      expect(res.body.notification).toBe('failed');
      expect(rows).toHaveLength(1);
    });

    it('401 without a token', async () => {
      await http()
        .post('/v1/tenants/tenant-a/billing/upgrade-request')
        .send({ planCode: 'pro' })
        .expect(401);
    });
  });

  describe('GET /v1/tenants/:tenantId/billing/upgrade-request', () => {
    it('owner and admin see the latest request (or null); agents do not', async () => {
      for (const role of ['owner', 'admin'] as Role[]) {
        const none = await http()
          .get('/v1/tenants/tenant-a/billing/upgrade-request')
          .set('Authorization', as(role))
          .expect(200);
        expect(none.body).toEqual({ request: null });
      }
      await ask('pro').expect(201);
      const res = await http()
        .get('/v1/tenants/tenant-a/billing/upgrade-request')
        .set('Authorization', as('admin'))
        .expect(200);
      expect(res.body.request).toMatchObject({
        requestedPlanCode: 'pro',
        status: 'pending',
      });
      expect(res.body.request).not.toHaveProperty('requestedBy');
      await http()
        .get('/v1/tenants/tenant-a/billing/upgrade-request')
        .set('Authorization', as('agent'))
        .expect(403);
    });
  });

  describe('platform admin: /v1/admin/upgrade-requests', () => {
    beforeEach(async () => {
      await ask('pro', 'please').expect(201);
    });

    it('lists the queue, filtered by status, newest first, with the envelope', async () => {
      const res = await http()
        .get('/v1/admin/upgrade-requests?status=pending')
        .set('Authorization', asAdmin())
        .expect(200);
      expect(res.body).toMatchObject({ total: 1, skip: 0, take: 20 });
      expect(res.body.data[0]).toMatchObject({
        id: 'req-1',
        requestedPlanCode: 'pro',
        status: 'pending',
        tenant: { id: 'tenant-a' },
      });
      const none = await http()
        .get('/v1/admin/upgrade-requests?status=handled')
        .set('Authorization', asAdmin())
        .expect(200);
      expect(none.body.total).toBe(0);
      await http()
        .get('/v1/admin/upgrade-requests?status=bogus')
        .set('Authorization', asAdmin())
        .expect(400);
    });

    it('handles a pending request once: 200, audited in the tenant log by the platform admin; the second time 409', async () => {
      const res = await http()
        .post('/v1/admin/upgrade-requests/req-1/handle')
        .set('Authorization', asAdmin())
        .send({ status: 'handled', note: 'activated Pro' })
        .expect(200);
      expect(res.body).toMatchObject({
        id: 'req-1',
        status: 'handled',
        handledNote: 'activated Pro',
      });
      expect(rows[0]).toMatchObject({ handledBy: 'admin-1' });
      const handledAudit = prisma.auditLog.create.mock.calls
        .map((c) => c[0].data)
        .find((d) => d.action === 'upgrade.handled');
      expect(handledAudit).toMatchObject({
        tenantId: 'tenant-a',
        actorUserId: 'admin-1',
        actorRole: 'platform_admin',
      });

      const again = await http()
        .post('/v1/admin/upgrade-requests/req-1/handle')
        .set('Authorization', asAdmin())
        .send({ status: 'declined' })
        .expect(409);
      expect(again.body.code).toBe('UPGRADE_REQUEST_ALREADY_HANDLED');
      expect(rows[0].status).toBe('handled');
    });

    it('404 for an unknown request, 400 for a status that is not handled/declined', async () => {
      await http()
        .post('/v1/admin/upgrade-requests/nope/handle')
        .set('Authorization', asAdmin())
        .send({ status: 'handled' })
        .expect(404);
      await http()
        .post('/v1/admin/upgrade-requests/req-1/handle')
        .set('Authorization', asAdmin())
        .send({ status: 'pending' })
        .expect(400);
    });

    it('is closed to tenant staff of every role and to anonymous callers', async () => {
      for (const role of ['owner', 'admin', 'agent'] as Role[]) {
        await http()
          .get('/v1/admin/upgrade-requests')
          .set('Authorization', as(role))
          .expect(401);
        await http()
          .post('/v1/admin/upgrade-requests/req-1/handle')
          .set('Authorization', as(role))
          .send({ status: 'handled' })
          .expect(401);
      }
      await http().get('/v1/admin/upgrade-requests').expect(401);
      expect(rows[0].status).toBe('pending');
    });
  });

  describe('PATCH /v1/admin/tenants/:id no longer takes plan or status (J5)', () => {
    it.each([
      [{ plan: 'pro' }],
      [{ status: 'suspended' }],
      [{ name: 'Renamed', plan: 'free', status: 'active' }],
    ])('%j -> 400 USE_SUBSCRIPTION_ROUTES, nothing changes', async (body) => {
      const res = await http()
        .patch('/v1/admin/tenants/tenant-a')
        .set('Authorization', asAdmin())
        .send(body)
        .expect(400);
      expect(res.body.code).toBe('USE_SUBSCRIPTION_ROUTES');
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('name and default language still work', async () => {
      prisma.tenant.update.mockResolvedValue({});
      await http()
        .patch('/v1/admin/tenants/tenant-a')
        .set('Authorization', asAdmin())
        .send({ name: 'Renamed', defaultLocale: 'ur' })
        .expect(200);
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 'tenant-a' },
        data: { name: 'Renamed', defaultLocale: 'ur' },
      });
    });

    it('suspension moved to POST /admin/tenants/:id/subscription/suspend and unsuspend', async () => {
      const suspended = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/suspend')
        .set('Authorization', asAdmin())
        .send({ reason: 'unpaid' })
        .expect(200);
      expect(suspended.body.subscription.status).toBe('suspended');
      const back = await http()
        .post('/v1/admin/tenants/tenant-a/subscription/unsuspend')
        .set('Authorization', asAdmin())
        .send({})
        .expect(200);
      expect(back.body.subscription.status).toBe('active');
    });
  });
});
