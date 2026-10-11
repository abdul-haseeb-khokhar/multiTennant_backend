import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { BillingRemindersService } from '../../src/billing/reminders/billing-reminders.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { WIDGET_LIMITS } from '../../src/widget/widget.constants';

/**
 * Phase 4B (J6) against a real Postgres: the migration's column and CHECK constraint, the setting
 * through the owner API, the gateway answering (or not) past the included conversations, the
 * derived overage figures, the manual invoice fields and the 100% reminder for both settings.
 */
describe('Overage flows (real database, mock engine)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const http = () => request(app.getHttpServer());
  const run = randomBytes(4).toString('hex');
  const password = 'correct-horse-battery';
  const bearer = (token: string) => `Bearer ${token}`;
  const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;
  const ORIGIN = `https://overage-${run}.example.com`;
  let counter = 0;

  type Tenant = Awaited<ReturnType<typeof signup>>;

  async function signup(name: string) {
    counter += 1;
    const res = await http()
      .post('/v1/auth/signup')
      .send({
        tenantName: `${name} ${run}-${counter}`,
        ownerEmail: `owner.${counter}.${run}@overage.test`,
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

  /** A Pro tenant with a small allowance, so a handful of conversations cross it. */
  async function proTenant(included: number) {
    const t = await signup('Pro');
    await http()
      .post(`/v1/admin/tenants/${t.tenantId}/subscription/activate`)
      .set('Authorization', bearer(adminToken))
      .send({
        planCode: 'pro',
        amountMinor: 1_999_900,
        currency: 'PKR',
        method: 'bank_transfer',
        interval: 'month',
        entitlementsOverride: { conversationsPerPeriod: included },
      })
      .expect(201);
    const key = await http()
      .post(`/v1/tenants/${t.tenantId}/api-keys`)
      .set('Authorization', bearer(t.token))
      .send({ name: 'Website', allowedOrigins: [ORIGIN] })
      .expect(201);
    return { ...t, widgetKey: key.body.key as string, visitors: 0 };
  }

  const open = async (t: { widgetKey: string; visitors: number }) => {
    t.visitors += 1;
    const res = await http()
      .post('/v1/widget/sessions')
      .set('Origin', ORIGIN)
      .send({
        widgetKey: t.widgetKey,
        visitorId: `visitor-${run}-${t.visitors}-${counter}`.padEnd(24, '0'),
      })
      .expect(200);
    return res.body as { status: string; fallback?: { reason: string } };
  };

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
    const big = 1_000_000;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WIDGET_LIMITS)
      .useValue({
        windowMs: 60_000,
        sessionPerIp: big,
        sessionPerKey: big,
        sessionPerVisitor: big,
        messagePerIp: big,
        messagePerKey: big,
        messagePerVisitor: big,
        readPerIp: big,
        readPerVisitor: big,
        preflightPerIp: big,
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);

    const adminEmail = `ops.${run}@overage.test`;
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

  it('every subscription starts with overage on (the column default), Starter included', async () => {
    const t = await signup('Default');
    const [row] = await rows<{ overage_enabled: boolean }>(
      `SELECT "overage_enabled" FROM "tenant_core"."subscriptions" WHERE "tenant_id" = $1`,
      t.tenantId,
    );
    expect(row.overage_enabled).toBe(true);
    // ...but Starter has no price, so the setting does not exist for it
    expect((await billing(t)).subscription.overage).toMatchObject({
      available: false,
      enabled: false,
    });
    const res = await setOverage(t, false).expect(409);
    expect(res.body.code).toBe('OVERAGE_NOT_AVAILABLE');
  });

  it('the whole J6 flow: past the allowance the AI keeps answering and the extras are counted; off is a hard stop; on again answers again', async () => {
    const t = await proTenant(2);
    const reminders = app.get(BillingRemindersService);

    // inside the allowance, then past it with overage on (the default)
    for (let i = 0; i < 2; i++) expect((await open(t)).status).toBe('ready');
    expect(await notificationTypes(t.tenantId)).toEqual([]);
    const third = await open(t);
    expect(third.status).toBe('ready');
    expect(third.fallback).toBeUndefined();
    let view = await billing(t);
    expect(view.subscription.overage).toMatchObject({
      available: true,
      enabled: true,
      priceMinor: 1500,
    });
    expect(view.usage.conversations).toMatchObject({
      included: 2,
      used: 3,
      overageCount: 1,
      overageAmountMinor: 1500,
    });

    // 100% with overage on: "overage started"
    await reminders.generate();
    expect(await notificationTypes(t.tenantId)).toEqual([
      'usage.overage_started',
    ]);

    // the owner switches it off: audited, evented, and the next conversation is held for a human
    await setOverage(t, false).expect(200);
    const [audit] = await rows<{ actor_role: string; after: any }>(
      `SELECT "actor_role", "after" FROM "tenant_core"."audit_logs"
        WHERE "tenant_id" = $1 AND "action" = 'billing.overage_changed'`,
      t.tenantId,
    );
    expect(audit).toMatchObject({
      actor_role: 'owner',
      after: { overageEnabled: false },
    });
    const events = await rows<{ type: string; source: string }>(
      `SELECT "type", "source" FROM "tenant_core"."billing_events"
        WHERE "tenant_id" = $1 AND "type" = 'overage.changed'`,
      t.tenantId,
    );
    expect(events).toEqual([{ type: 'overage.changed', source: 'manual' }]);
    const stopped = await open(t);
    expect(stopped).toMatchObject({
      status: 'limited',
      fallback: { reason: 'limit_reached' },
    });
    view = await billing(t);
    // 4 used, 2 included, 1 held for a human: only the one the AI answered is overage
    expect(view.usage.conversations).toMatchObject({
      used: 4,
      overageCount: 1,
      overageAmountMinor: 1500,
    });

    // 100% with overage off: "AI stopped"; the earlier reminder is not repeated
    await reminders.generate();
    await reminders.generate();
    expect(await notificationTypes(t.tenantId)).toEqual([
      'usage.limit_reached',
      'usage.overage_started',
    ]);

    // back on: answered again; switching never re-sends what was sent
    await setOverage(t, true).expect(200);
    expect((await open(t)).status).toBe('ready');
    await reminders.generate();
    expect(await notificationTypes(t.tenantId)).toEqual([
      'usage.limit_reached',
      'usage.overage_started',
    ]);
    const counts = await rows<{ type: string; n: number }>(
      `SELECT "type", COUNT(*)::int AS n FROM "tenant_core"."notifications"
        WHERE "tenant_id" = $1 GROUP BY "type"`,
      t.tenantId,
    );
    // one owner: one row per type
    expect(counts.every((c) => c.n === 1)).toBe(true);
    view = await billing(t);
    expect(view.usage.conversations).toMatchObject({
      used: 5,
      overageCount: 2,
      overageAmountMinor: 3000,
    });
  });

  it('owner only: an admin and an agent cannot change it; another tenant cannot see it', async () => {
    const t = await proTenant(2);
    const invited = async (role: 'admin' | 'agent') => {
      counter += 1;
      const email = `${role}.${counter}.${run}@overage.test`;
      const inv = await http()
        .post(`/v1/tenants/${t.tenantId}/invites`)
        .set('Authorization', bearer(t.token))
        .send({ email, role })
        .expect(201);
      const accepted = await http()
        .post('/v1/auth/invites/accept')
        .send({ token: tokenFrom(inv.body.link), password, name: role })
        .expect(201);
      return accepted.body.access_token as string;
    };
    for (const role of ['admin', 'agent'] as const) {
      const token = await invited(role);
      const res = await http()
        .patch(`/v1/tenants/${t.tenantId}/billing/settings`)
        .set('Authorization', bearer(token))
        .send({ overageEnabled: false })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    }
    const other = await proTenant(2);
    await http()
      .patch(`/v1/tenants/${t.tenantId}/billing/settings`)
      .set('Authorization', bearer(other.token))
      .send({ overageEnabled: false })
      .expect(403);
    expect((await billing(t)).subscription.overage.enabled).toBe(true);
    expect((await billing(other)).subscription.overage.enabled).toBe(true);
  });

  it('manual invoicing: record-payment keeps the overage figures on the invoice, and the CHECK constraint guards them', async () => {
    const t = await proTenant(1);
    await open(t);
    await open(t);
    await open(t);
    const view = (
      await http()
        .get(`/v1/admin/tenants/${t.tenantId}/subscription`)
        .set('Authorization', bearer(adminToken))
        .expect(200)
    ).body;
    expect(view.usage.conversations).toMatchObject({
      overageCount: 2,
      overageAmountMinor: 3000,
    });
    const pay = await http()
      .post(`/v1/admin/tenants/${t.tenantId}/subscription/record-payment`)
      .set('Authorization', bearer(adminToken))
      .send({
        amountMinor: 1_999_900 + 3000,
        currency: 'PKR',
        method: 'cash',
        overageCount: 2,
        overageAmountMinor: 3000,
      })
      .expect(201);
    expect(pay.body.invoice).toMatchObject({
      overageCount: 2,
      overageAmountMinor: 3000,
    });
    const [invoice] = await rows<{
      overage_count: number;
      overage_amount_minor: number;
    }>(
      `SELECT "overage_count", "overage_amount_minor" FROM "tenant_core"."invoices" WHERE "id" = $1`,
      pay.body.invoice.id,
    );
    expect(invoice).toEqual({ overage_count: 2, overage_amount_minor: 3000 });

    // the database refuses an overage larger than the invoice, or a negative one
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "tenant_core"."invoices" SET "overage_amount_minor" = "amount_minor" + 1 WHERE "id" = $1`,
        pay.body.invoice.id,
      ),
    ).rejects.toThrow(/invoices_overage_nonneg/);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "tenant_core"."invoices" SET "overage_count" = -1 WHERE "id" = $1`,
        pay.body.invoice.id,
      ),
    ).rejects.toThrow(/invoices_overage_nonneg/);
  });
});
