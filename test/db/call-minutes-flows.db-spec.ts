import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { Clock, FakeClock } from '../../src/billing/clock';
import { EntitlementsService } from '../../src/billing/entitlements/entitlements.service';
import { BillingRemindersService } from '../../src/billing/reminders/billing-reminders.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { UsageService } from '../../src/usage/usage.service';

/**
 * Phase 5A (L6) against a real Postgres: the migration's plan values and ledger CHECK, call minutes
 * counted once from `usage_daily`, the allowed/denied matrix per plan and setting and state, the
 * billing summary, the owner switch, the 80% and 100% reminders and two-tenant isolation.
 */
describe('Call minutes flows (real database, mock engine)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let usage: UsageService;
  let entitlements: EntitlementsService;
  let reminders: BillingRemindersService;
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
  let counter = 0;

  type Tenant = Awaited<ReturnType<typeof signup>>;

  async function signup(name: string) {
    counter += 1;
    const res = await http()
      .post('/v1/auth/signup')
      .send({
        tenantName: `${name} ${run}-${counter}`,
        ownerEmail: `owner.${counter}.${run}@minutes.test`,
        ownerPassword: password,
      })
      .expect(201);
    await http()
      .post('/v1/auth/verify-email')
      .send({ token: tokenFrom(res.body.verificationLink) })
      .expect(204);
    return {
      tenantId: res.body.tenant.id as string,
      token: res.body.access_token as string,
    };
  }

  const admin = (path: string) =>
    http()
      .post(`/v1/admin/tenants/${path}`)
      .set('Authorization', bearer(adminToken));

  async function proTenant() {
    const t = await signup('Pro');
    await admin(`${t.tenantId}/subscription/activate`)
      .send({ planCode: 'pro', ...PAYMENT, interval: 'month' })
      .expect(201);
    return t;
  }

  /** The minutes of one finished call, counted once per call id. */
  const call = (
    t: Tenant,
    minutes: number,
    callId = randomBytes(8).toString('hex'),
  ) => usage.recordCallMinutes(t.tenantId, { callId, minutes });

  const check = (t: Tenant, amount = 1) =>
    entitlements.check(t.tenantId, 'callMinutes', amount, { fresh: true });

  const billing = async (t: Tenant) =>
    (
      await http()
        .get(`/v1/tenants/${t.tenantId}/billing`)
        .set('Authorization', bearer(t.token))
        .expect(200)
    ).body;

  const setOverage = (t: Tenant, overageEnabled: boolean) =>
    http()
      .patch(`/v1/tenants/${t.tenantId}/billing/settings`)
      .set('Authorization', bearer(t.token))
      .send({ overageEnabled });

  const rows = <T>(sql: string, ...params: unknown[]) =>
    prisma.$queryRawUnsafe<T[]>(sql, ...params);

  const notificationTypes = async (tenantId: string) =>
    (
      await rows<{ type: string }>(
        `SELECT DISTINCT "type" FROM "tenant_core"."notifications" WHERE "tenant_id" = $1 ORDER BY "type"`,
        tenantId,
      )
    ).map((r) => r.type);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    usage = app.get(UsageService);
    entitlements = app.get(EntitlementsService);
    reminders = app.get(BillingRemindersService);

    const adminEmail = `ops.${run}@minutes.test`;
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

  describe('the migration', () => {
    it('gave the four plans their call minutes: Starter 30 in total, Free 20 a month, Pro 300 a month at PKR 25 a minute, Enterprise unlimited; voice on everywhere', async () => {
      const plans = await rows<{ code: string; entitlements: any }>(
        `SELECT "code", "entitlements" FROM "tenant_core"."plans" ORDER BY "sort_order"`,
      );
      expect(plans.map((p) => p.code)).toEqual([
        'starter',
        'free',
        'pro',
        'enterprise',
      ]);
      const by = Object.fromEntries(plans.map((p) => [p.code, p.entitlements]));
      expect(by.starter).toMatchObject({
        voice: true,
        callMinutesPerPeriod: 30,
        callMinutePeriod: 'total',
      });
      expect(by.free).toMatchObject({
        voice: true,
        callMinutesPerPeriod: 20,
        callMinutePeriod: 'month',
      });
      expect(by.pro).toMatchObject({
        voice: true,
        callMinutesPerPeriod: 300,
        callMinutePeriod: 'month',
        overageMinuteMinor: 2500,
      });
      expect(by.enterprise).toMatchObject({
        voice: true,
        callMinutesPerPeriod: null,
      });
      for (const plan of plans) {
        expect(plan.entitlements.channels).toContain('voice');
      }
      // the chat limits are untouched
      expect(by.pro.conversationsPerPeriod).toBe(1500);
      expect(by.pro.overageConversationMinor).toBe(1500);
      expect(by.starter.conversationsPerPeriod).toBe(100);
    });

    it('the usage ledger accepts a call and still refuses any other kind', async () => {
      const t = await signup('Ledger');
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "tenant_core"."usage_events" ("id","tenant_id","kind","ref_id","day") VALUES (gen_random_uuid()::text,$1,'call','c-check',CURRENT_DATE)`,
          t.tenantId,
        ),
      ).resolves.toBe(1);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "tenant_core"."usage_events" ("id","tenant_id","kind","ref_id","day") VALUES (gen_random_uuid()::text,$1,'sms','c-check',CURRENT_DATE)`,
          t.tenantId,
        ),
      ).rejects.toThrow(/usage_events_kind_check/);
    });

    it('GET /v1/plans (public) shows the minutes and the price per extra minute', async () => {
      const res = await http().get('/v1/plans').expect(200);
      const by = Object.fromEntries(res.body.data.map((p: any) => [p.code, p]));
      expect(Object.keys(by).sort()).toEqual(['enterprise', 'free', 'pro']);
      expect(by.free.entitlements).toMatchObject({
        voice: true,
        callMinutesPerPeriod: 20,
        callMinutePeriod: 'month',
      });
      expect(by.free.entitlements.overageMinuteMinor).toBeUndefined();
      expect(by.pro).toMatchObject({
        priceMinor: 1_999_900,
        yearlyPriceMinor: 19_999_000,
        currency: 'PKR',
      });
      expect(by.pro.entitlements).toMatchObject({
        callMinutesPerPeriod: 300,
        overageMinuteMinor: 2500,
      });
      expect(by.enterprise.entitlements.callMinutesPerPeriod).toBeNull();
    });
  });

  describe('counting minutes', () => {
    it('counts a call once however often it is reported, and adds the days of the period up', async () => {
      const t = await proTenant();
      expect(await call(t, 4, 'call-1')).toBe(true);
      expect(await call(t, 4, 'call-1')).toBe(false);
      expect(await call(t, 6, 'call-2')).toBe(true);
      const [day] = await rows<{ call_minutes: number }>(
        `SELECT "call_minutes" FROM "tenant_core"."usage_daily" WHERE "tenant_id" = $1`,
        t.tenantId,
      );
      expect(day.call_minutes).toBe(10);
      expect((await billing(t)).usage.callMinutes).toMatchObject({
        included: 300,
        used: 10,
        overageMinutes: 0,
        overageAmountMinor: 0,
        overagePriceMinor: 2500,
        currency: 'PKR',
      });
    });

    it('the same call id of two tenants counts for each of them (the ledger is per tenant)', async () => {
      const a = await proTenant();
      const b = await proTenant();
      expect(await call(a, 5, 'shared-id')).toBe(true);
      expect(await call(b, 7, 'shared-id')).toBe(true);
      expect((await billing(a)).usage.callMinutes.used).toBe(5);
      expect((await billing(b)).usage.callMinutes.used).toBe(7);
    });

    it('chat conversations and call minutes are separate allowances', async () => {
      const t = await proTenant();
      await usage.recordConversation(t.tenantId, `conv-${run}-${counter}`);
      await call(t, 12);
      const view = await billing(t);
      expect(view.usage.conversations.used).toBe(1);
      expect(view.usage.callMinutes.used).toBe(12);
    });
  });

  describe('plan x setting x usage', () => {
    it('Pro with overage on keeps serving past 300 minutes and bills each extra minute; off is a hard stop; on again serves again', async () => {
      const t = await proTenant();
      await call(t, 299);
      expect(await check(t)).toMatchObject({ allowed: true, used: 299 });
      await call(t, 1);
      // exactly at the allowance: the next minute is already an extra one
      expect(await check(t)).toMatchObject({
        allowed: true,
        overage: true,
        limit: 300,
        used: 300,
      });
      await call(t, 42);
      let view = await billing(t);
      expect(view.subscription.overage).toMatchObject({
        available: true,
        enabled: true,
        priceMinor: 1500,
        minutePriceMinor: 2500,
      });
      expect(view.usage.callMinutes).toMatchObject({
        included: 300,
        used: 342,
        overageMinutes: 42,
        overageAmountMinor: 105_000,
        overagePriceMinor: 2500,
      });

      const off = await setOverage(t, false).expect(200);
      expect(off.body.subscription.overage.enabled).toBe(false);
      expect(await check(t)).toMatchObject({
        allowed: false,
        code: 'PLAN_LIMIT_REACHED',
      });
      // the minutes already served stay in the summary
      view = await billing(t);
      expect(view.usage.callMinutes).toMatchObject({
        used: 342,
        overageMinutes: 42,
      });

      await setOverage(t, true).expect(200);
      expect(await check(t)).toMatchObject({ allowed: true, overage: true });
    });

    it('Free: 20 minutes a month and a hard stop; the switch does not exist for it', async () => {
      const t = await signup('Free');
      await admin(`${t.tenantId}/subscription/change-plan`)
        .send({ planCode: 'free' })
        .expect(200);
      await call(t, 19);
      expect(await check(t)).toMatchObject({ allowed: true, limit: 20 });
      await call(t, 1);
      expect(await check(t)).toMatchObject({
        allowed: false,
        code: 'PLAN_LIMIT_REACHED',
      });
      const view = await billing(t);
      expect(view.subscription.overage).toMatchObject({
        available: false,
        enabled: false,
        minutePriceMinor: null,
      });
      expect(view.usage.callMinutes).toMatchObject({
        period: 'month',
        included: 20,
        used: 20,
        overageMinutes: 0,
        overagePriceMinor: null,
      });
      expect((await setOverage(t, false).expect(409)).body.code).toBe(
        'OVERAGE_NOT_AVAILABLE',
      );
    });

    it('Starter: 30 minutes counted in total from the day the trial began', async () => {
      const t = await signup('Starter');
      await call(t, 30);
      expect(await check(t)).toMatchObject({
        allowed: false,
        code: 'PLAN_LIMIT_REACHED',
        limit: 30,
        used: 30,
      });
      const view = await billing(t);
      expect(view.usage.callMinutes).toMatchObject({
        period: 'total',
        included: 30,
        used: 30,
      });
      expect(view.subscription.limits).toMatchObject({
        voice: true,
        callMinutesPerPeriod: 30,
        callMinutePeriod: 'total',
      });
    });

    it('Enterprise is unlimited', async () => {
      const t = await signup('Enterprise');
      await admin(`${t.tenantId}/subscription/activate`)
        .send({
          planCode: 'enterprise',
          ...PAYMENT,
          periodEnd: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        })
        .expect(201);
      await call(t, 50_000);
      expect(await check(t)).toMatchObject({ allowed: true, limit: null });
      expect((await billing(t)).usage.callMinutes).toMatchObject({
        included: null,
        used: 50_000,
        overageMinutes: 0,
      });
    });

    it('an override grants a custom number of minutes and a price to any plan', async () => {
      const t = await signup('Custom');
      await admin(`${t.tenantId}/subscription/change-plan`)
        .send({
          planCode: 'free',
          entitlementsOverride: {
            callMinutesPerPeriod: 60,
            overageMinuteMinor: 2000,
          },
        })
        .expect(200);
      await call(t, 60);
      expect(await check(t)).toMatchObject({ allowed: true, overage: true });
      expect(
        (await setOverage(t, false).expect(200)).body.subscription.overage,
      ).toMatchObject({
        available: true,
        enabled: false,
        minutePriceMinor: 2000,
      });
      expect(await check(t)).toMatchObject({ allowed: false });
    });

    it('a suspended tenant is refused whatever it has left; lifting it restores service', async () => {
      const t = await proTenant();
      await admin(`${t.tenantId}/subscription/suspend`).send({}).expect(200);
      expect(await check(t)).toMatchObject({
        allowed: false,
        code: 'TENANT_SUSPENDED',
      });
      await admin(`${t.tenantId}/subscription/unsuspend`).send({}).expect(200);
      expect(await check(t)).toMatchObject({ allowed: true });
    });

    it('past_due keeps serving within the allowance but never runs up overage', async () => {
      const t = await proTenant();
      clock.advanceDays(31); // the paid month ended unpaid: grace period
      expect((await billing(t)).subscription.status).toBe('past_due');
      await call(t, 100);
      expect(await check(t)).toMatchObject({ allowed: true, used: 100 });
      await call(t, 200);
      expect(await check(t)).toMatchObject({
        allowed: false,
        code: 'PLAN_LIMIT_REACHED',
      });
      // paying brings overage back
      await admin(`${t.tenantId}/subscription/record-payment`)
        .send(PAYMENT)
        .expect(201);
      expect(await check(t)).toMatchObject({ allowed: true, overage: true });
    });
  });

  describe('reminders', () => {
    it('80% then 100% with overage on: "minutes warning" then "overage started"; sweeping again repeats nothing', async () => {
      const t = await proTenant();
      await call(t, 250);
      await reminders.generate();
      expect(await notificationTypes(t.tenantId)).toEqual([
        'usage.minutes_threshold',
      ]);
      await call(t, 50);
      await reminders.generate();
      await reminders.generate();
      expect(await notificationTypes(t.tenantId)).toEqual([
        'usage.minutes_overage_started',
        'usage.minutes_threshold',
      ]);
      const [row] = await rows<{ params: any; dedupe_key: string }>(
        `SELECT "params", "dedupe_key" FROM "tenant_core"."notifications"
          WHERE "tenant_id" = $1 AND "type" = 'usage.minutes_overage_started'`,
        t.tenantId,
      );
      expect(row.params).toMatchObject({
        metric: 'callMinutes',
        percent: 100,
        used: 300,
        limit: 300,
        priceMinor: 2500,
        price: 25,
        currency: 'PKR',
      });
      expect(row.dedupe_key).toMatch(
        /^usage\.minutes_overage_started:callMinutes:/,
      );
    });

    it('overage off at 100%: "call minutes used up"; switching sends only the message that now applies, once', async () => {
      const t = await proTenant();
      await setOverage(t, false).expect(200);
      await call(t, 300);
      await reminders.generate();
      expect(await notificationTypes(t.tenantId)).toEqual([
        'usage.minutes_limit_reached',
      ]);
      await setOverage(t, true).expect(200);
      await reminders.generate();
      await reminders.generate();
      await setOverage(t, false).expect(200);
      await reminders.generate();
      expect(await notificationTypes(t.tenantId)).toEqual([
        'usage.minutes_limit_reached',
        'usage.minutes_overage_started',
      ]);
      const counts = await rows<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "tenant_core"."notifications" WHERE "tenant_id" = $1 GROUP BY "type"`,
        t.tenantId,
      );
      expect(counts.every((c) => c.n === 1)).toBe(true);
    });

    it('a tenant sees only its own reminders, and an unlimited plan gets none', async () => {
      const a = await proTenant();
      const b = await proTenant();
      await call(a, 300);
      await reminders.generate();
      expect(await notificationTypes(a.tenantId)).toEqual([
        'usage.minutes_overage_started',
      ]);
      expect(await notificationTypes(b.tenantId)).toEqual([]);

      const e = await signup('Unlimited');
      await admin(`${e.tenantId}/subscription/activate`)
        .send({
          planCode: 'enterprise',
          ...PAYMENT,
          periodEnd: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        })
        .expect(201);
      await call(e, 100_000);
      await reminders.generate();
      expect(await notificationTypes(e.tenantId)).toEqual([]);
    });
  });

  describe('who may see and change it', () => {
    it('only the owner flips the switch; an agent cannot read the billing summary; another tenant sees none of it', async () => {
      const t = await proTenant();
      const other = await proTenant();
      await call(t, 123);
      counter += 1;
      const invite = await http()
        .post(`/v1/tenants/${t.tenantId}/invites`)
        .set('Authorization', bearer(t.token))
        .send({ email: `agent.${counter}.${run}@minutes.test`, role: 'agent' })
        .expect(201);
      const accepted = await http()
        .post('/v1/auth/invites/accept')
        .send({ token: tokenFrom(invite.body.link), password, name: 'Agent' })
        .expect(201);
      const agent = accepted.body.access_token as string;
      expect(
        (
          await http()
            .patch(`/v1/tenants/${t.tenantId}/billing/settings`)
            .set('Authorization', bearer(agent))
            .send({ overageEnabled: false })
            .expect(403)
        ).body.code,
      ).toBe('INSUFFICIENT_ROLE');
      await http()
        .get(`/v1/tenants/${t.tenantId}/billing`)
        .set('Authorization', bearer(agent))
        .expect(403);
      // another tenant's owner cannot read or change this tenant (TENANT_MISMATCH)
      await http()
        .get(`/v1/tenants/${t.tenantId}/billing`)
        .set('Authorization', bearer(other.token))
        .expect(403);
      expect((await billing(other)).usage.callMinutes.used).toBe(0);
      expect((await billing(t)).usage.callMinutes.used).toBe(123);
    });

    it('the platform admin view of a tenant carries the same minute figures', async () => {
      const t = await proTenant();
      await call(t, 310);
      const res = await http()
        .get(`/v1/admin/tenants/${t.tenantId}/subscription`)
        .set('Authorization', bearer(adminToken))
        .expect(200);
      expect(res.body.usage.callMinutes).toMatchObject({
        used: 310,
        overageMinutes: 10,
        overageAmountMinor: 25_000,
      });
    });
  });
});
