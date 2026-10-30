import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
} from '../../../test/utils/prisma-mock';
import { PLAN_CATALOG_LOCK_KEY } from '../billing.constants';
import { PlanCatalogSyncService } from './plan-catalog-sync.service';

type Row = {
  code: string;
  priceMinor: number | null;
  yearlyPriceMinor: number | null;
  entitlements: unknown;
};

/** The plans the migration of Phase 5A leaves behind. */
const seed = (): Row[] => [
  {
    code: 'starter',
    priceMinor: 0,
    yearlyPriceMinor: null,
    entitlements: {
      seats: 3,
      voice: true,
      callMinutesPerPeriod: 30,
      callMinutePeriod: 'total',
    },
  },
  {
    code: 'free',
    priceMinor: 0,
    yearlyPriceMinor: null,
    entitlements: {
      seats: 1,
      voice: true,
      callMinutesPerPeriod: 20,
      callMinutePeriod: 'month',
    },
  },
  {
    code: 'pro',
    priceMinor: 1_999_900,
    yearlyPriceMinor: 19_999_000,
    entitlements: {
      seats: 10,
      voice: true,
      callMinutesPerPeriod: 300,
      callMinutePeriod: 'month',
      overageMinuteMinor: 2500,
      overageConversationMinor: 1500,
    },
  },
  {
    code: 'enterprise',
    priceMinor: null,
    yearlyPriceMinor: null,
    entitlements: { seats: null, callMinutesPerPeriod: null },
  },
];

describe('PlanCatalogSyncService', () => {
  let prisma: PrismaMock;
  let rows: Row[];
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const make = (env: Record<string, unknown>) =>
    new PlanCatalogSyncService(
      prisma as never,
      {
        get: (name: string) => env[name],
      } as unknown as ConfigService,
    );

  const row = (code: string) => rows.find((r) => r.code === code)!;
  const minutes = (code: string) =>
    (row(code).entitlements as Record<string, unknown>).callMinutesPerPeriod;

  beforeEach(() => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    prisma.$executeRaw.mockResolvedValue(1);
    rows = seed();
    prisma.plan.findUnique.mockImplementation(
      async ({ where }: { where: { code: string } }) => {
        const found = rows.find((r) => r.code === where.code);
        return found ? structuredClone(found) : null;
      },
    );
    prisma.plan.update.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { code: string };
        data: Partial<Row>;
      }) => {
        Object.assign(
          rows.find((r) => r.code === where.code)!,
          data,
        );
      },
    );
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('does not touch the database at all when no plan variable is set', async () => {
    await expect(make({}).sync()).resolves.toEqual([]);
    await expect(
      make({
        PLAN_PRO_CALL_MINUTES: '',
        PLAN_FREE_CALL_MINUTES: undefined,
      }).sync(),
    ).resolves.toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.plan.findUnique).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('applies only the variables that are SET and leaves everything else as the table has it', async () => {
    const before = seed();
    const changes = await make({
      PLAN_PRO_CALL_MINUTES: '500',
      PLAN_PRO_PRICE_MONTH_MINOR: '2499900',
    }).sync();
    expect(changes).toEqual([
      {
        plan: 'pro',
        field: 'entitlements.callMinutesPerPeriod',
        from: 300,
        to: 500,
      },
      { plan: 'pro', field: 'priceMinor', from: 1_999_900, to: 2_499_900 },
    ]);
    expect(row('pro').priceMinor).toBe(2_499_900);
    expect(row('pro').entitlements).toEqual({
      ...(before[2].entitlements as object),
      callMinutesPerPeriod: 500,
    });
    // the other plans and the other fields of Pro are untouched
    expect(row('pro').yearlyPriceMinor).toBe(19_999_000);
    expect(row('starter')).toEqual(before[0]);
    expect(row('free')).toEqual(before[1]);
    expect(row('enterprise')).toEqual(before[3]);
    expect(prisma.plan.update).toHaveBeenCalledTimes(1);
  });

  it('can set every variable: three call-minute allowances, the minute price and both prices', async () => {
    await make({
      PLAN_STARTER_CALL_MINUTES: '45',
      PLAN_FREE_CALL_MINUTES: '10',
      PLAN_PRO_CALL_MINUTES: '600',
      PLAN_PRO_OVERAGE_MINUTE_MINOR: '3000',
      PLAN_PRO_PRICE_MONTH_MINOR: '2000000',
      PLAN_PRO_PRICE_YEAR_MINOR: '20000000',
    }).sync();
    expect(minutes('starter')).toBe(45);
    expect(minutes('free')).toBe(10);
    expect(row('pro').entitlements).toMatchObject({
      callMinutesPerPeriod: 600,
      overageMinuteMinor: 3000,
    });
    expect(row('pro').priceMinor).toBe(2_000_000);
    expect(row('pro').yearlyPriceMinor).toBe(20_000_000);
  });

  it('a 0 is applied (no minutes), it is not mistaken for "unset"', async () => {
    await make({ PLAN_FREE_CALL_MINUTES: '0' }).sync();
    expect(minutes('free')).toBe(0);
  });

  it('is idempotent: a second run finds nothing to change, writes nothing and logs nothing', async () => {
    const env = {
      PLAN_PRO_CALL_MINUTES: '500',
      PLAN_PRO_PRICE_MONTH_MINOR: '2499900',
    };
    await make(env).sync();
    prisma.plan.update.mockClear();
    log.mockClear();
    await expect(make(env).sync()).resolves.toEqual([]);
    expect(prisma.plan.update).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('a value that already matches the table changes nothing the first time either', async () => {
    await expect(
      make({
        PLAN_PRO_CALL_MINUTES: '300',
        PLAN_PRO_OVERAGE_MINUTE_MINOR: '2500',
      }).sync(),
    ).resolves.toEqual([]);
    expect(prisma.plan.update).not.toHaveBeenCalled();
  });

  it('takes the Postgres advisory lock first, inside the transaction, before reading any plan', async () => {
    const order: string[] = [];
    prisma.$executeRaw.mockImplementation(async (...args: unknown[]) => {
      const sql = (args[0] as string[]).join('?');
      expect(sql).toContain('pg_advisory_xact_lock');
      expect(args[1]).toBe(PLAN_CATALOG_LOCK_KEY);
      order.push('lock');
      return 1;
    });
    prisma.plan.findUnique.mockImplementation(async () => {
      order.push('read');
      return structuredClone(row('pro'));
    });
    await make({ PLAN_PRO_CALL_MINUTES: '301' }).sync();
    expect(order).toEqual(['lock', 'read']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('two instances starting one after the other end with one result: the second finds the first values', async () => {
    const env = { PLAN_PRO_CALL_MINUTES: '700' };
    const first = await make(env).sync();
    const second = await make(env).sync();
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(minutes('pro')).toBe(700);
  });

  it('logs one structured line per change (plan, field, from, to) and nothing secret', async () => {
    await make({
      PLAN_PRO_CALL_MINUTES: '500',
      PLAN_FREE_CALL_MINUTES: '25',
    }).sync();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith({
      message: 'Plan catalogue changed from the environment',
      plan: 'free',
      field: 'entitlements.callMinutesPerPeriod',
      from: 20,
      to: 25,
    });
    expect(log).toHaveBeenCalledWith({
      message: 'Plan catalogue changed from the environment',
      plan: 'pro',
      field: 'entitlements.callMinutesPerPeriod',
      from: 300,
      to: 500,
    });
  });

  it('reports a change only after the transaction committed (a failure logs nothing)', async () => {
    prisma.plan.update.mockRejectedValue(new Error('constraint'));
    await expect(make({ PLAN_PRO_CALL_MINUTES: '500' }).sync()).rejects.toThrow(
      'constraint',
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('skips a plan that does not exist (a warning, no crash) and still applies the others', async () => {
    rows = rows.filter((r) => r.code !== 'free');
    const changes = await make({
      PLAN_FREE_CALL_MINUTES: '5',
      PLAN_PRO_CALL_MINUTES: '350',
    }).sync();
    expect(changes.map((c) => c.plan)).toEqual(['pro']);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'free' }),
    );
  });

  it('skips a plan whose entitlements are not an object instead of overwriting them', async () => {
    row('pro').entitlements = 'junk';
    await expect(
      make({ PLAN_PRO_CALL_MINUTES: '350' }).sync(),
    ).resolves.toEqual([]);
    expect(row('pro').entitlements).toBe('junk');
    expect(warn).toHaveBeenCalled();
  });

  it('refuses the boot when an invalid value reaches it (validation normally stops that earlier)', async () => {
    await expect(
      make({ PLAN_PRO_CALL_MINUTES: '12.5' }).sync(),
    ).rejects.toThrow(/PLAN_PRO_CALL_MINUTES/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  describe('agents and phone numbers (L7)', () => {
    const entitlementsOf = (code: string) =>
      row(code).entitlements as Record<string, unknown>;

    it('writes the agent and phone-number limits into the matching plan, logging one line per change', async () => {
      const changes = await make({
        PLAN_PRO_AGENTS: '6',
        PLAN_PRO_PHONE_NUMBERS: '10',
        PLAN_STARTER_AGENTS: '2',
        PLAN_FREE_PHONE_NUMBERS: '0',
      }).sync();
      expect(changes).toEqual(
        expect.arrayContaining([
          { plan: 'starter', field: 'entitlements.agents', from: null, to: 2 },
          { plan: 'pro', field: 'entitlements.agents', from: null, to: 6 },
          {
            plan: 'pro',
            field: 'entitlements.phoneNumbers',
            from: null,
            to: 10,
          },
          {
            plan: 'free',
            field: 'entitlements.phoneNumbers',
            from: null,
            to: 0,
          },
        ]),
      );
      expect(entitlementsOf('pro')).toMatchObject({
        agents: 6,
        phoneNumbers: 10,
        callMinutesPerPeriod: 300,
      });
      expect(entitlementsOf('starter').agents).toBe(2);
      expect(entitlementsOf('free').phoneNumbers).toBe(0);
      expect(log).toHaveBeenCalledTimes(4);
    });

    it('is idempotent and leaves Enterprise (no variable) alone', async () => {
      await make({ PLAN_PRO_AGENTS: '6' }).sync();
      log.mockClear();
      await expect(make({ PLAN_PRO_AGENTS: '6' }).sync()).resolves.toEqual([]);
      expect(log).not.toHaveBeenCalled();
      expect(entitlementsOf('enterprise')).not.toHaveProperty('agents');
    });

    it('lowering a limit changes only the plan row (no tenant data is touched)', async () => {
      row('pro').entitlements = { ...entitlementsOf('pro'), agents: 3 };
      await make({ PLAN_PRO_AGENTS: '1' }).sync();
      expect(entitlementsOf('pro').agents).toBe(1);
      expect(prisma.plan.update).toHaveBeenCalledTimes(1);
    });
  });

  it('runs at application bootstrap', async () => {
    await make({ PLAN_PRO_CALL_MINUTES: '400' }).onApplicationBootstrap();
    expect(minutes('pro')).toBe(400);
  });
});
