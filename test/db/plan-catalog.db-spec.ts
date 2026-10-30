import { ConfigModule, ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PlanCatalogModule } from '../../src/billing/plan-catalog/plan-catalog.module';
import { PlanCatalogSyncService } from '../../src/billing/plan-catalog/plan-catalog-sync.service';
import { PLAN_CATALOG_VARIABLE_NAMES } from '../../src/billing/plan-catalog/plan-catalog.env';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * L6 (Phase 5A) against a real Postgres: the plan numbers and prices come from environment
 * variables. The sync really changes the `plans` rows, only for the variables that are set, a
 * second run changes nothing, parallel starts do not fight, existing tenants see the new limits
 * at once and invoices already recorded are never touched. The plans are put back afterwards.
 */
describe('Plan catalogue from environment variables (real database)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let original: {
    code: string;
    price_minor: number | null;
    yearly_price_minor: number | null;
    entitlements: unknown;
  }[];

  const http = () => request(app.getHttpServer());
  const run = randomBytes(4).toString('hex');
  const password = 'correct-horse-battery';
  const bearer = (token: string) => `Bearer ${token}`;
  const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;

  const sync = (env: Record<string, string>) =>
    new PlanCatalogSyncService(prisma, {
      get: (name: string) => env[name],
    } as unknown as ConfigService).sync();

  const plan = async (code: string) => {
    const [row] = await prisma.$queryRawUnsafe<
      {
        price_minor: number | null;
        yearly_price_minor: number | null;
        entitlements: Record<string, unknown>;
        updated_at: Date;
      }[]
    >(
      `SELECT "price_minor","yearly_price_minor","entitlements","updated_at" FROM "tenant_core"."plans" WHERE "code" = $1`,
      code,
    );
    return row;
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
    original = await prisma.$queryRawUnsafe(
      `SELECT "code","price_minor","yearly_price_minor","entitlements" FROM "tenant_core"."plans"`,
    );

    const adminEmail = `ops.${run}@catalog.test`;
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

  /** Puts the four plans back exactly as they were, even when a test failed halfway. */
  afterAll(async () => {
    for (const row of original) {
      await prisma.$executeRawUnsafe(
        `UPDATE "tenant_core"."plans" SET "price_minor" = $2, "yearly_price_minor" = $3, "entitlements" = $4::jsonb WHERE "code" = $1`,
        row.code,
        row.price_minor,
        row.yearly_price_minor,
        JSON.stringify(row.entitlements),
      );
    }
    await app.close();
  });

  afterEach(async () => {
    for (const row of original) {
      await prisma.$executeRawUnsafe(
        `UPDATE "tenant_core"."plans" SET "price_minor" = $2, "yearly_price_minor" = $3, "entitlements" = $4::jsonb WHERE "code" = $1`,
        row.code,
        row.price_minor,
        row.yearly_price_minor,
        JSON.stringify(row.entitlements),
      );
    }
  });

  it('the app boots without any variable and the plans are exactly what the migration left', async () => {
    const pro = await plan('pro');
    expect(pro).toMatchObject({
      price_minor: 1_999_900,
      yearly_price_minor: 19_999_000,
      entitlements: {
        callMinutesPerPeriod: 300,
        overageMinuteMinor: 2500,
        agents: 3,
        phoneNumbers: 5,
      },
    });
    expect(PLAN_CATALOG_VARIABLE_NAMES).toHaveLength(12);
  });

  it('the agent and phone-number variables (L7) change only their own key, and restore cleanly', async () => {
    const before = await plan('pro');
    const changes = await sync({
      PLAN_PRO_AGENTS: '7',
      PLAN_PRO_PHONE_NUMBERS: '9',
    });
    expect(
      changes.map((c) => `${c.plan} ${c.field} ${c.from}->${c.to}`),
    ).toEqual([
      'pro entitlements.agents 3->7',
      'pro entitlements.phoneNumbers 5->9',
    ]);
    const after = await plan('pro');
    expect(after.entitlements).toEqual({
      ...before.entitlements,
      agents: 7,
      phoneNumbers: 9,
    });
    await expect(
      sync({ PLAN_PRO_AGENTS: '7', PLAN_PRO_PHONE_NUMBERS: '9' }),
    ).resolves.toEqual([]);
    await sync({ PLAN_PRO_AGENTS: '3', PLAN_PRO_PHONE_NUMBERS: '5' });
    expect((await plan('pro')).entitlements).toEqual(before.entitlements);
  });

  it('changes the rows for the variables that are SET and nothing else; a second run changes nothing, not even updated_at', async () => {
    const before = {
      starter: await plan('starter'),
      free: await plan('free'),
      pro: await plan('pro'),
      enterprise: await plan('enterprise'),
    };
    const env = {
      PLAN_FREE_CALL_MINUTES: '25',
      PLAN_PRO_CALL_MINUTES: '500',
      PLAN_PRO_OVERAGE_MINUTE_MINOR: '3000',
      PLAN_PRO_PRICE_MONTH_MINOR: '2499900',
      PLAN_PRO_PRICE_YEAR_MINOR: '24999000',
      PLAN_STARTER_CALL_MINUTES: '',
    };
    const changes = await sync(env);
    expect(
      changes.map((c) => `${c.plan} ${c.field} ${c.from}->${c.to}`),
    ).toEqual([
      'free entitlements.callMinutesPerPeriod 20->25',
      'pro entitlements.callMinutesPerPeriod 300->500',
      'pro entitlements.overageMinuteMinor 2500->3000',
      'pro priceMinor 1999900->2499900',
      'pro yearlyPriceMinor 19999000->24999000',
    ]);

    const after = {
      starter: await plan('starter'),
      free: await plan('free'),
      pro: await plan('pro'),
      enterprise: await plan('enterprise'),
    };
    expect(after.free.entitlements).toEqual({
      ...before.free.entitlements,
      callMinutesPerPeriod: 25,
    });
    expect(after.pro).toMatchObject({
      price_minor: 2_499_900,
      yearly_price_minor: 24_999_000,
      entitlements: {
        ...before.pro.entitlements,
        callMinutesPerPeriod: 500,
        overageMinuteMinor: 3000,
      },
    });
    // an unset (empty) variable and an untouched plan keep what the table had
    expect(after.starter).toEqual(before.starter);
    expect(after.enterprise).toEqual(before.enterprise);

    // second run: nothing to change, nothing written
    await expect(sync(env)).resolves.toEqual([]);
    const again = await plan('pro');
    expect(again.updated_at).toEqual(after.pro.updated_at);
    expect((await plan('free')).updated_at).toEqual(after.free.updated_at);
  });

  it('several instances starting at the same moment end with one consistent result and every change is made exactly once', async () => {
    const env = { PLAN_PRO_CALL_MINUTES: '777', PLAN_FREE_CALL_MINUTES: '33' };
    const results = await Promise.all([
      sync(env),
      sync(env),
      sync(env),
      sync(env),
    ]);
    // the advisory lock serialises them: the first applies both changes, the others find nothing left
    expect(results.flat()).toHaveLength(2);
    expect(results.filter((r) => r.length === 2)).toHaveLength(1);
    expect((await plan('pro')).entitlements.callMinutesPerPeriod).toBe(777);
    expect((await plan('free')).entitlements.callMinutesPerPeriod).toBe(33);
  });

  it('every tenant on the plan gets the new limits at once, and an invoice already recorded keeps its amount', async () => {
    const signup = async (name: string) => {
      const res = await http()
        .post('/v1/auth/signup')
        .send({
          tenantName: `${name} ${run}`,
          ownerEmail: `owner.${name}.${run}@catalog.test`,
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
    };
    const a = await signup('a');
    const b = await signup('b');
    for (const t of [a, b]) {
      await http()
        .post(`/v1/admin/tenants/${t.tenantId}/subscription/activate`)
        .set('Authorization', bearer(adminToken))
        .send({
          planCode: 'pro',
          amountMinor: 1_999_900,
          currency: 'PKR',
          method: 'bank_transfer',
          interval: 'month',
        })
        .expect(201);
    }
    // tenant b has a custom number of minutes through an override: it must keep it
    await http()
      .post(`/v1/admin/tenants/${b.tenantId}/subscription/change-plan`)
      .set('Authorization', bearer(adminToken))
      .send({
        planCode: 'pro',
        entitlementsOverride: { callMinutesPerPeriod: 1000 },
      })
      .expect(200);

    const limits = async (t: { tenantId: string; token: string }) =>
      (
        await http()
          .get(`/v1/tenants/${t.tenantId}/billing`)
          .set('Authorization', bearer(t.token))
          .expect(200)
      ).body;

    expect((await limits(a)).subscription.limits.callMinutesPerPeriod).toBe(
      300,
    );
    await sync({
      PLAN_PRO_CALL_MINUTES: '450',
      PLAN_PRO_PRICE_MONTH_MINOR: '2999900',
    });
    // read live from the plan row (a fresh read: the entitlement cache is per request path here)
    const afterA = await limits(a);
    expect(afterA.subscription.limits.callMinutesPerPeriod).toBe(450);
    expect(afterA.usage.callMinutes.included).toBe(450);
    expect((await limits(b)).subscription.limits.callMinutesPerPeriod).toBe(
      1000,
    );
    // the invoice recorded at the old price is untouched
    expect(afterA.invoices.data[0]).toMatchObject({ amountMinor: 1_999_900 });
    const [invoice] = await prisma.$queryRawUnsafe<{ amount_minor: number }[]>(
      `SELECT "amount_minor" FROM "tenant_core"."invoices" WHERE "tenant_id" = $1`,
      a.tenantId,
    );
    expect(invoice.amount_minor).toBe(1_999_900);
    // and the public price list shows the new price
    const plans = await http().get('/v1/plans').expect(200);
    const pro = plans.body.data.find((p: { code: string }) => p.code === 'pro');
    expect(pro.priceMinor).toBe(2_999_900);
    expect(pro.entitlements.callMinutesPerPeriod).toBe(450);
  });

  it('AppModule registers the sync, so every boot runs it', () => {
    expect(app.get(PlanCatalogSyncService, { strict: false })).toBeInstanceOf(
      PlanCatalogSyncService,
    );
  });

  it('a Nest boot with the variables in the environment applies them (ConfigModule, PlanCatalogModule and the bootstrap hook together)', async () => {
    let second: INestApplication | undefined;
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            ignoreEnvVars: true,
            load: [
              () => ({
                PLAN_FREE_CALL_MINUTES: '27',
                PLAN_PRO_OVERAGE_MINUTE_MINOR: '3100',
              }),
            ],
          }),
          PrismaModule,
          PlanCatalogModule,
        ],
      }).compile();
      second = moduleRef.createNestApplication({ logger: false });
      await second.init();
      expect((await plan('free')).entitlements.callMinutesPerPeriod).toBe(27);
      expect((await plan('pro')).entitlements.overageMinuteMinor).toBe(3100);
      // a value that was not set is untouched
      expect((await plan('pro')).entitlements.callMinutesPerPeriod).toBe(300);
    } finally {
      await second?.close();
    }
  });
});
