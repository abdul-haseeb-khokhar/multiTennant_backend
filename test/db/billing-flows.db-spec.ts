import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { Clock, FakeClock } from '../../src/billing/clock';
import { SubscriptionService } from '../../src/billing/subscriptions/subscription.service';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Phase 2B against a real Postgres: the SQL the mocked suites cannot see (row locks, the invoice
 * counter, the append-only billing log, unique and CHECK constraints, the advisory-locked job)
 * and the billing flows end to end over HTTP. Time is a FakeClock so 15 days pass instantly.
 */
describe('Billing flows (real database)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let subscriptions: SubscriptionService;
  let adminToken: string;
  const clock = new FakeClock(new Date());

  const http = () => request(app.getHttpServer());
  const run = randomBytes(4).toString('hex');
  const password = 'correct-horse-battery';
  const bearer = (token: string) => `Bearer ${token}`;
  const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;
  const PAYMENT = {
    amountMinor: 1_999_900,
    currency: 'PKR',
    method: 'bank_transfer',
  };

  type Tenant = Awaited<ReturnType<typeof signup>>;
  let counter = 0;

  async function signup(name: string) {
    counter += 1;
    const res = await http()
      .post('/v1/auth/signup')
      .send({
        tenantName: `${name} ${run}-${counter}`,
        ownerEmail: `owner.${counter}.${run}@billing.test`,
        ownerPassword: password,
      })
      .expect(201);
    await http()
      .post('/v1/auth/verify-email')
      .send({ token: tokenFrom(res.body.verificationLink) })
      .expect(204);
    return {
      tenantId: res.body.tenant.id as string,
      slug: res.body.tenant.slug as string,
      ownerId: res.body.owner.id as string,
      token: res.body.access_token as string,
    };
  }

  const admin = (method: 'get' | 'post', tenantId: string, path = '') =>
    (http() as any)
      [method](`/v1/admin/tenants/${tenantId}/subscription${path}`)
      .set('Authorization', bearer(adminToken)) as request.Test;

  const billingOf = (t: Tenant) =>
    http()
      .get(`/v1/tenants/${t.tenantId}/billing`)
      .set('Authorization', bearer(t.token));

  const meOf = async (t: Tenant) =>
    (
      await http()
        .get('/v1/me')
        .set('Authorization', bearer(t.token))
        .expect(200)
    ).body;

  const rows = <T>(tenantId: string, table: string) =>
    prisma.$queryRawUnsafe<T[]>(
      `SELECT * FROM "tenant_core"."${table}" WHERE "tenant_id" = $1 ORDER BY "created_at", "id"`,
      tenantId,
    );

  async function invite(t: Tenant, email: string) {
    return http()
      .post(`/v1/tenants/${t.tenantId}/invites`)
      .set('Authorization', bearer(t.token))
      .send({ email, role: 'agent' });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication({
      logger: false,
      rawBody: true,
    });
    configureApp(app);
    await app.init();
    // Listen once: with parallel requests supertest would otherwise close the shared server
    // under the requests that are still running.
    await app.listen(0);
    prisma = app.get(PrismaService);
    subscriptions = app.get(SubscriptionService);

    const adminEmail = `ops.${run}@billing.test`;
    await prisma.platformAdmin.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash('ops-password-123', 4),
      },
    });
    const login = await http()
      .post('/v1/admin/auth/login')
      .send({ email: adminEmail, password: 'ops-password-123' })
      .expect(201);
    adminToken = login.body.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    clock.set(new Date());
  });

  describe('a new tenant gets Starter for 15 days, then Free automatically', () => {
    it('signup creates the Starter subscription, the mirrors, an event and an audit entry in one go', async () => {
      const t = await signup('Starter');
      const sub = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: t.tenantId },
      });
      expect(sub).toMatchObject({
        planCode: 'starter',
        status: 'active',
        provider: 'manual',
        cancelAtPeriodEnd: false,
      });
      expect(
        (sub.currentPeriodEnd!.getTime() - sub.currentPeriodStart.getTime()) /
          86_400_000,
      ).toBe(15);
      const tenant = await prisma.tenant.findUniqueOrThrow({
        where: { id: t.tenantId },
      });
      expect(tenant).toMatchObject({ plan: 'starter', status: 'trial' });
      const events = await rows<{ type: string; source: string }>(
        t.tenantId,
        'billing_events',
      );
      expect(events.map((e) => [e.type, e.source])).toEqual([
        ['subscription.created', 'system'],
      ]);
      const audit = await prisma.auditLog.findMany({
        where: { tenantId: t.tenantId, action: 'subscription.created' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].actorRole).toBe('system');

      const me = await meOf(t);
      expect(me.subscription).toMatchObject({
        planCode: 'starter',
        status: 'active',
        daysLeft: 15,
        limits: expect.objectContaining({ seats: 3, knowledgeMb: 20 }),
      });
    });

    it('after 15 days /me and /billing show Free, the mirrors and the log agree, even though no job ran', async () => {
      const t = await signup('Lapse');
      clock.advanceDays(14);
      expect((await meOf(t)).subscription.planCode).toBe('starter');
      clock.advanceDays(1);
      const me = await meOf(t);
      expect(me.subscription).toMatchObject({
        planCode: 'free',
        status: 'active',
        daysLeft: null,
        limits: expect.objectContaining({ seats: 1, poweredByLabel: true }),
      });
      const tenant = await prisma.tenant.findUniqueOrThrow({
        where: { id: t.tenantId },
      });
      expect(tenant).toMatchObject({ plan: 'free', status: 'active' });
      const sub = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: t.tenantId },
      });
      expect(sub.planCode).toBe('free');
      expect(sub.currentPeriodEnd).toBeNull();
      const events = await rows<{ type: string; source: string }>(
        t.tenantId,
        'billing_events',
      );
      expect(events.map((e) => e.type)).toEqual([
        'subscription.created',
        'period.ended',
      ]);
      // Reading again applies nothing twice.
      await meOf(t);
      expect(await rows(t.tenantId, 'billing_events')).toHaveLength(2);
    });

    it('the daily job applies due transitions once, even when two instances sweep at the same time', async () => {
      const a = await signup('JobA');
      const b = await signup('JobB');
      clock.advanceDays(16);
      const [first, second] = await Promise.all([
        subscriptions.processDueTransitions(),
        subscriptions.processDueTransitions(),
      ]);
      // Whoever got the advisory lock did the work; the other either skipped or found nothing left.
      expect(first.processed + second.processed).toBeGreaterThanOrEqual(2);
      for (const t of [a, b]) {
        const events = await rows<{ type: string }>(
          t.tenantId,
          'billing_events',
        );
        expect(events.filter((e) => e.type === 'period.ended')).toHaveLength(1);
        const tenant = await prisma.tenant.findUniqueOrThrow({
          where: { id: t.tenantId },
        });
        expect(tenant.plan).toBe('free');
      }
      // Nothing is due any more.
      await expect(
        subscriptions.processDueTransitions(),
      ).resolves.toMatchObject({
        processed: 0,
      });
    });
  });

  describe('a platform admin activates Pro with a recorded invoice', () => {
    it('Starter + payment: Pro for a month, a sequential paid invoice, mirror, event and audit', async () => {
      const t = await signup('Activate');
      const res = await admin('post', t.tenantId, '/activate')
        .send({ planCode: 'pro', reference: 'TX-1', ...PAYMENT })
        .expect(201);
      expect(res.body.subscription).toMatchObject({
        planCode: 'pro',
        status: 'active',
        interval: 'month',
      });
      expect(res.body.invoice).toMatchObject({
        amountMinor: 1_999_900,
        currency: 'PKR',
        status: 'paid',
        method: 'bank_transfer',
        reference: 'TX-1',
      });
      expect(res.body.invoice.number).toMatch(
        new RegExp(`^INV-${clock.now().getUTCFullYear()}-\\d{6}$`),
      );

      const tenant = await prisma.tenant.findUniqueOrThrow({
        where: { id: t.tenantId },
      });
      expect(tenant).toMatchObject({ plan: 'pro', status: 'active' });

      const invoices = await rows<{
        amount_minor: number;
        recorded_by: string;
      }>(t.tenantId, 'invoices');
      expect(invoices).toHaveLength(1);
      expect(Number.isInteger(invoices[0].amount_minor)).toBe(true);
      const audit = await prisma.auditLog.findMany({
        where: {
          tenantId: t.tenantId,
          action: 'subscription.payment_recorded',
        },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorRole: 'platform_admin' });
      expect(audit[0].actorUserId).toBe(invoices[0].recorded_by);

      const view = await billingOf(t).expect(200);
      expect(view.body.subscription.planCode).toBe('pro');
      expect(view.body.invoices.data).toHaveLength(1);
      expect(view.body.invoices.data[0].number).toBe(res.body.invoice.number);
    });

    it('the pricing list shows exactly Free, Pro and Enterprise', async () => {
      const res = await http().get('/v1/plans').expect(200);
      expect(res.body.data.map((p: { code: string }) => p.code)).toEqual([
        'free',
        'pro',
        'enterprise',
      ]);
      const pro = res.body.data[1];
      expect(pro).toMatchObject({
        priceMinor: 1_999_900,
        yearlyPriceMinor: 19_999_000,
        currency: 'PKR',
      });
    });

    it('extend, renew, cancel and the fall back to Free after the period', async () => {
      const t = await signup('Lifecycle');
      await admin('post', t.tenantId, '/activate')
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(201);

      // Renewal 20 days in starts where the old period ends.
      clock.advanceDays(20);
      const renewal = await admin('post', t.tenantId, '/record-payment')
        .send(PAYMENT)
        .expect(201);
      const sub = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: t.tenantId },
      });
      expect(renewal.body.subscription.currentPeriodEnd.slice(0, 10)).toBe(
        sub.currentPeriodEnd!.toISOString().slice(0, 10),
      );
      expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(
        clock.now().getTime() + 35 * 86_400_000,
      );

      const extended = await admin('post', t.tenantId, '/extend')
        .send({ days: 10 })
        .expect(200);
      expect(extended.body.invoice).toBeNull();

      const canceled = await admin('post', t.tenantId, '/cancel')
        .send({})
        .expect(200);
      expect(canceled.body.subscription).toMatchObject({
        planCode: 'pro',
        status: 'canceled',
        cancelAtPeriodEnd: true,
      });

      clock.advanceDays(80);
      expect((await meOf(t)).subscription).toMatchObject({
        planCode: 'free',
        status: 'active',
        cancelAtPeriodEnd: false,
      });
      const types = (
        await rows<{ type: string }>(t.tenantId, 'billing_events')
      ).map((e) => e.type);
      expect(types).toEqual([
        'subscription.created',
        'payment.succeeded',
        'payment.succeeded',
        'period.extended',
        'subscription.canceled',
        'period.ended',
      ]);
    });

    it('unpaid Pro goes past_due, then to Free after 7 days of grace; a payment inside the grace period saves it', async () => {
      const t = await signup('Grace');
      await admin('post', t.tenantId, '/activate')
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(201);
      clock.advanceDays(31);
      expect((await meOf(t)).subscription).toMatchObject({
        planCode: 'pro',
        status: 'past_due',
        graceDaysLeft: 7,
      });
      clock.advanceDays(4);
      await admin('post', t.tenantId, '/record-payment')
        .send(PAYMENT)
        .expect(201);
      expect((await meOf(t)).subscription).toMatchObject({
        planCode: 'pro',
        status: 'active',
        graceEndsAt: null,
      });

      const u = await signup('Grace2');
      await admin('post', u.tenantId, '/activate')
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(201);
      clock.advanceDays(31 + 7);
      expect((await meOf(u)).subscription).toMatchObject({
        planCode: 'free',
        status: 'active',
      });
    });

    it('a suspended tenant is locked out, cannot be billed, and returns to its previous state when lifted', async () => {
      const t = await signup('Suspend');
      await http()
        .patch(`/v1/admin/tenants/${t.tenantId}`)
        .set('Authorization', bearer(adminToken))
        .send({ status: 'suspended' })
        .expect(200);
      const locked = await http()
        .get('/v1/me')
        .set('Authorization', bearer(t.token))
        .expect(403);
      expect(locked.body.code).toBe('TENANT_SUSPENDED');
      const refused = await admin('post', t.tenantId, '/activate')
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(409);
      expect(refused.body.code).toBe('INVALID_SUBSCRIPTION_STATE');

      await http()
        .patch(`/v1/admin/tenants/${t.tenantId}`)
        .set('Authorization', bearer(adminToken))
        .send({ status: 'active' })
        .expect(200);
      const me = await meOf(t);
      expect(me.subscription).toMatchObject({
        planCode: 'starter',
        status: 'active',
      });
      expect(me.tenant).toMatchObject({ status: 'trial' });
      const audit = await prisma.auditLog.findMany({
        where: { tenantId: t.tenantId },
        orderBy: { createdAt: 'asc' },
      });
      const suspended = audit.find((a) => a.action === 'tenant.suspended')!;
      expect(suspended).toMatchObject({ actorRole: 'platform_admin' });
      expect(audit.map((a) => a.action)).toContain('tenant.reactivated');
    });
  });

  describe('concurrency', () => {
    it('the same idempotency key sent five times at once records one payment, one event, one invoice', async () => {
      const t = await signup('Idem');
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          admin('post', t.tenantId, '/activate').send({
            planCode: 'pro',
            ...PAYMENT,
            idempotencyKey: 'slip-1',
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(results.filter((r) => r.body.applied)).toHaveLength(1);
      expect(results.filter((r) => r.body.duplicate)).toHaveLength(4);
      expect(await rows(t.tenantId, 'invoices')).toHaveLength(1);
      const payments = (
        await rows<{ type: string }>(t.tenantId, 'billing_events')
      ).filter((e) => e.type === 'payment.succeeded');
      expect(payments).toHaveLength(1);
    });

    it('invoice numbers are unique and gapless when many payments land at once across tenants', async () => {
      const tenants = await Promise.all(
        [1, 2, 3, 4].map((i) => signup(`Seq${i}`)),
      );
      const responses = await Promise.all(
        tenants.flatMap((t) => [
          admin('post', t.tenantId, '/activate').send({
            planCode: 'pro',
            ...PAYMENT,
          }),
          admin('post', t.tenantId, '/activate').send({
            planCode: 'pro',
            ...PAYMENT,
            interval: 'year',
            amountMinor: 19_999_000,
          }),
        ]),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(8).fill(201));
      const numbers = responses
        .map((r) => Number(r.body.invoice.number.split('-')[2]))
        .sort((a, b) => a - b);
      expect(new Set(numbers).size).toBe(8);
      expect(numbers[7] - numbers[0]).toBe(7);
    });

    it('simultaneous invites cannot take more seats than the plan has', async () => {
      const t = await signup('Seats'); // Starter: 3 seats, the owner uses one
      const results = await Promise.all(
        Array.from({ length: 6 }, (_v, i) =>
          invite(t, `race.${i}.${run}@billing.test`),
        ),
      );
      const created = results.filter((r) => r.status === 201);
      const refused = results.filter((r) => r.status === 403);
      expect(created).toHaveLength(2);
      expect(refused).toHaveLength(4);
      for (const r of refused) expect(r.body.code).toBe('PLAN_LIMIT_REACHED');
    });
  });

  describe('seat limits (I5)', () => {
    it('Starter has 3 seats: invites fill them, revoking frees one, acceptance does not need a second seat', async () => {
      const t = await signup('Fill');
      expect((await invite(t, `a.${run}@fill.test`)).status).toBe(201);
      const second = await invite(t, `b.${run}@fill.test`);
      expect(second.status).toBe(201);
      const full = await invite(t, `c.${run}@fill.test`);
      expect(full.status).toBe(403);
      expect(full.body).toMatchObject({
        statusCode: 403,
        code: 'PLAN_LIMIT_REACHED',
      });

      // Re-inviting an address that is already pending does not use a new seat.
      expect((await invite(t, `a.${run}@fill.test`)).status).toBe(201);

      // The invite already holds its seat, so accepting works while the plan is full.
      await http()
        .post('/v1/auth/invites/accept')
        .send({
          token: tokenFrom((await invite(t, `a.${run}@fill.test`)).body.link),
          password,
        })
        .expect(201);

      // Revoking a pending invite frees its seat.
      await http()
        .delete(`/v1/tenants/${t.tenantId}/invites/${second.body.id}`)
        .set('Authorization', bearer(t.token))
        .expect(200);
      expect((await invite(t, `d.${run}@fill.test`)).status).toBe(201);
    });

    it('re-enabling a disabled user needs a free seat', async () => {
      const t = await signup('Reenable');
      const accept = async (email: string) => {
        const inv = await invite(t, email).then((r) => {
          expect(r.status).toBe(201);
          return r.body;
        });
        const res = await http()
          .post('/v1/auth/invites/accept')
          .send({ token: tokenFrom(inv.link), password })
          .expect(201);
        return res.body.user.id as string;
      };
      const u1 = await accept(`u1.${run}@re.test`);
      await accept(`u2.${run}@re.test`); // owner + u1 + u2 = 3 of 3
      await http()
        .patch(`/v1/tenants/${t.tenantId}/users/${u1}`)
        .set('Authorization', bearer(t.token))
        .send({ status: 'disabled' })
        .expect(200);
      await invite(t, `u3.${run}@re.test`).then((r) =>
        expect(r.status).toBe(201),
      ); // takes the freed seat
      const res = await http()
        .patch(`/v1/tenants/${t.tenantId}/users/${u1}`)
        .set('Authorization', bearer(t.token))
        .send({ status: 'active' })
        .expect(403);
      expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
    });

    it('Free has one seat; upgrading to Pro opens ten at once', async () => {
      const t = await signup('FreeSeats');
      await admin('post', t.tenantId, '/change-plan')
        .send({ planCode: 'free' })
        .expect(200);
      const denied = await invite(t, `x.${run}@free.test`);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('PLAN_LIMIT_REACHED');
      await admin('post', t.tenantId, '/activate')
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(201);
      expect((await invite(t, `x.${run}@free.test`)).status).toBe(201);
    });

    it('a past_due tenant cannot add staff but is not locked out', async () => {
      const t = await signup('PastDue');
      await admin('post', t.tenantId, '/activate')
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(201);
      clock.advanceDays(33);
      const res = await invite(t, `y.${run}@pd.test`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SUBSCRIPTION_PAST_DUE');
      await meOf(t);
    });
  });

  describe('tenant isolation', () => {
    it("another tenant cannot read this tenant's billing or consent, and sees none of its invoices", async () => {
      const a = await signup('IsoA');
      const b = await signup('IsoB');
      await admin('post', a.tenantId, '/activate')
        .send({ planCode: 'pro', ...PAYMENT })
        .expect(201);

      const cross = await http()
        .get(`/v1/tenants/${a.tenantId}/billing`)
        .set('Authorization', bearer(b.token))
        .expect(403);
      expect(cross.body.code).toBe('TENANT_MISMATCH');
      await http()
        .get(`/v1/tenants/${a.tenantId}/data-use`)
        .set('Authorization', bearer(b.token))
        .expect(403);

      const own = await billingOf(b).expect(200);
      expect(own.body.invoices.total).toBe(0);
      expect(own.body.subscription.planCode).toBe('starter');
    });

    it('agents cannot read billing; admins can; only the owner touches the consent', async () => {
      const t = await signup('Roles');
      const inviteFor = async (role: string) => {
        const inv = await http()
          .post(`/v1/tenants/${t.tenantId}/invites`)
          .set('Authorization', bearer(t.token))
          .send({ email: `${role}.${run}@roles.test`, role })
          .expect(201);
        const res = await http()
          .post('/v1/auth/invites/accept')
          .send({ token: tokenFrom(inv.body.link), password })
          .expect(201);
        return res.body.access_token as string;
      };
      const agent = await inviteFor('agent');
      const adminStaff = await inviteFor('admin');

      const denied = await http()
        .get(`/v1/tenants/${t.tenantId}/billing`)
        .set('Authorization', bearer(agent))
        .expect(403);
      expect(denied.body.code).toBe('INSUFFICIENT_ROLE');
      await http()
        .get(`/v1/tenants/${t.tenantId}/billing`)
        .set('Authorization', bearer(adminStaff))
        .expect(200);
      for (const token of [agent, adminStaff]) {
        await http()
          .put(`/v1/tenants/${t.tenantId}/data-use`)
          .set('Authorization', bearer(token))
          .send({ enabled: true, termsVersion: 'v1' })
          .expect(403);
      }
      await http()
        .get(`/v1/admin/tenants/${t.tenantId}/subscription`)
        .set('Authorization', bearer(t.token))
        .expect(401);
    });
  });

  describe('data use consent (I11)', () => {
    it('is off by default, granted only by an explicit owner call, revocable, and audited', async () => {
      const t = await signup('Consent');
      const url = `/v1/tenants/${t.tenantId}/data-use`;
      const get = () => http().get(url).set('Authorization', bearer(t.token));
      expect((await get().expect(200)).body).toMatchObject({
        enabled: false,
        status: 'off',
      });
      expect(await rows(t.tenantId, 'data_use_consents')).toHaveLength(0);

      const granted = await http()
        .put(url)
        .set('Authorization', bearer(t.token))
        .send({ enabled: true, termsVersion: '2026-10-01' })
        .expect(200);
      expect(granted.body).toMatchObject({
        enabled: true,
        status: 'granted',
        termsVersion: '2026-10-01',
        acceptedBy: t.ownerId,
      });

      const revoked = await http()
        .put(url)
        .set('Authorization', bearer(t.token))
        .send({ enabled: false })
        .expect(200);
      expect(revoked.body).toMatchObject({ enabled: false, status: 'revoked' });
      expect(revoked.body.revokedAt).not.toBeNull();
      expect(await rows(t.tenantId, 'data_use_consents')).toHaveLength(1);

      const regrant = await http()
        .put(url)
        .set('Authorization', bearer(t.token))
        .send({ enabled: true, termsVersion: '2027-01-01' })
        .expect(200);
      expect(regrant.body).toMatchObject({ enabled: true, revokedAt: null });

      const audit = await prisma.auditLog.findMany({
        where: { tenantId: t.tenantId, action: { startsWith: 'data_use.' } },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((a) => a.action)).toEqual([
        'data_use.granted',
        'data_use.revoked',
        'data_use.granted',
      ]);
    });
  });

  describe('database guarantees', () => {
    it('billing_events is append-only: UPDATE and DELETE are refused', async () => {
      const t = await signup('Append');
      const [event] = await rows<{ id: string }>(t.tenantId, 'billing_events');
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "tenant_core"."billing_events" SET "type" = 'x' WHERE "id" = $1`,
          event.id,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM "tenant_core"."billing_events" WHERE "id" = $1`,
          event.id,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('a provider event id is unique per provider; events without one never collide', async () => {
      const t = await signup('Unique');
      const data = (providerEventId: string | null, provider = 'acme-pay') => ({
        tenantId: t.tenantId,
        type: 'payment.failed',
        source: 'provider',
        provider,
        providerEventId,
        payload: {},
      });
      await prisma.billingEvent.create({ data: data(`evt_${run}`) });
      await expect(
        prisma.billingEvent.create({ data: data(`evt_${run}`) }),
      ).rejects.toMatchObject({
        code: 'P2002',
      });
      await prisma.billingEvent.create({
        data: data(`evt_${run}`, 'other-pay'),
      });
      await prisma.billingEvent.create({ data: data(null) });
      await prisma.billingEvent.create({ data: data(null) });
    });

    it('rejects impossible values with CHECK constraints', async () => {
      const t = await signup('Checks');
      const sub = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: t.tenantId },
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "tenant_core"."subscriptions" SET "status" = 'paused' WHERE "id" = $1`,
          sub.id,
        ),
      ).rejects.toThrow(/subscriptions_status_check/);
      const invoice = (amount: number, currency: string, number: string) =>
        prisma.invoice.create({
          data: {
            number,
            tenantId: t.tenantId,
            subscriptionId: sub.id,
            amountMinor: amount,
            currency,
            status: 'paid',
          },
        });
      await expect(invoice(-1, 'PKR', `NEG-${run}`)).rejects.toThrow(
        /invoices_amount_check/,
      );
      await expect(invoice(100, 'pkr', `LOW-${run}`)).rejects.toThrow(
        /invoices_currency_check/,
      );
      await invoice(100, 'PKR', `OK-${run}`);
      await expect(invoice(100, 'PKR', `OK-${run}`)).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it('there is one subscription per tenant, and the tenant row cannot be deleted from under it', async () => {
      const t = await signup('One');
      await expect(
        prisma.subscription.create({
          data: { tenantId: t.tenantId, planCode: 'free' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        prisma.tenant.delete({ where: { id: t.tenantId } }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('the four plans are seeded and Starter is hidden', async () => {
      const plans = await prisma.plan.findMany({
        orderBy: { sortOrder: 'asc' },
      });
      expect(plans.map((p) => [p.code, p.visibility])).toEqual([
        ['starter', 'hidden'],
        ['free', 'public'],
        ['pro', 'public'],
        ['enterprise', 'public'],
      ]);
      expect(plans[0]).toMatchObject({
        durationDays: 15,
        fallbackPlanCode: 'free',
      });
    });

    it('a tenant failing mid-signup leaves no subscription behind (single transaction)', async () => {
      const before = await prisma.subscription.count();
      const dupe = await signup('Dup');
      const res = await http()
        .post('/v1/auth/signup')
        .send({
          tenantName: 'Whatever',
          tenantSlug: dupe.slug,
          ownerEmail: `dupe.${run}@billing.test`,
          ownerPassword: password,
        })
        .expect(409);
      expect(res.body.code).toBe('SLUG_TAKEN');
      expect(await prisma.subscription.count()).toBe(before + 1);
    });
  });
});
