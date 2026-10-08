import { FakeClock } from '../../src/billing/clock';
import type { PrismaMock } from './prisma-mock';

/** The seeded plan catalogue (migration 20261007140000_phase2b_billing), as Prisma rows. */
export const PLAN_ROWS = [
  {
    code: 'starter',
    name: 'Starter',
    visibility: 'hidden',
    priceMinor: 0,
    currency: 'PKR',
    interval: 'none',
    yearlyPriceMinor: null,
    durationDays: 15,
    fallbackPlanCode: 'free',
    entitlements: {
      seats: 3,
      conversationsPerPeriod: 100,
      conversationPeriod: 'total',
      knowledgeMb: 20,
      channels: ['chat'],
      voice: false,
      poweredByLabel: false,
    },
    providerPriceIds: {},
    active: true,
    sortOrder: 0,
  },
  {
    code: 'free',
    name: 'Free',
    visibility: 'public',
    priceMinor: 0,
    currency: 'PKR',
    interval: 'none',
    yearlyPriceMinor: null,
    durationDays: null,
    fallbackPlanCode: null,
    entitlements: {
      seats: 1,
      conversationsPerPeriod: 30,
      conversationPeriod: 'month',
      knowledgeMb: 10,
      channels: ['chat'],
      voice: false,
      poweredByLabel: true,
    },
    providerPriceIds: {},
    active: true,
    sortOrder: 1,
  },
  {
    code: 'pro',
    name: 'Pro',
    visibility: 'public',
    priceMinor: 1_999_900,
    currency: 'PKR',
    interval: 'month',
    yearlyPriceMinor: 19_999_000,
    durationDays: null,
    fallbackPlanCode: 'free',
    entitlements: {
      seats: 10,
      conversationsPerPeriod: 1500,
      conversationPeriod: 'month',
      knowledgeMb: 500,
      channels: ['chat', 'whatsapp'],
      voice: false,
      poweredByLabel: false,
      overageConversationMinor: 1500,
      voicePerMinuteMinor: 2500,
    },
    providerPriceIds: {},
    active: true,
    sortOrder: 2,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    visibility: 'public',
    priceMinor: null,
    currency: 'PKR',
    interval: 'none',
    yearlyPriceMinor: null,
    durationDays: null,
    fallbackPlanCode: 'free',
    entitlements: {
      seats: null,
      conversationsPerPeriod: null,
      conversationPeriod: 'month',
      knowledgeMb: null,
      channels: ['chat', 'whatsapp', 'voice'],
      voice: true,
      poweredByLabel: false,
    },
    providerPriceIds: {},
    active: true,
    sortOrder: 3,
  },
];

export const T0 = new Date('2026-10-07T00:00:00.000Z');

export type SubscriptionRow = Record<string, unknown> & {
  id: string;
  tenantId: string;
  planCode: string;
};

export function subscriptionRow(
  over: Partial<SubscriptionRow> = {},
): SubscriptionRow {
  return {
    id: 'sub-1',
    tenantId: 'tenant-a',
    planCode: 'starter',
    status: 'active',
    interval: 'none',
    currentPeriodStart: T0,
    currentPeriodEnd: new Date('2026-10-22T00:00:00.000Z'),
    cancelAtPeriodEnd: false,
    graceEndsAt: null,
    statusBeforeSuspension: null,
    closedAt: null,
    entitlementsOverride: null,
    provider: 'manual',
    providerCustomerId: null,
    providerSubscriptionId: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/**
 * Wires the Prisma mock the way the billing code needs it: the plan catalogue, ONE tenant's
 * subscription row (other tenants have none), row locks, the invoice counter and the append-only
 * event/invoice tables, all kept in memory so a test can inspect what was written. Call it after
 * `jest.resetAllMocks()`. Pass `subscription: null` for a tenant without a subscription.
 */
export function installBilling(
  prisma: PrismaMock,
  clock: FakeClock,
  options: { subscription?: Partial<SubscriptionRow> | null } = {},
) {
  clock.set(T0);
  const state = {
    row:
      options.subscription === null
        ? null
        : subscriptionRow(options.subscription ?? {}),
    events: [] as Array<Record<string, unknown>>,
    invoices: [] as Array<Record<string, unknown>>,
    mirrors: [] as Array<Record<string, unknown>>,
    invoiceCounter: 0,
  };
  const plan = (code: unknown) =>
    PLAN_ROWS.find((p) => p.code === code) ?? null;

  prisma.plan.findMany.mockResolvedValue(PLAN_ROWS);
  prisma.plan.findUnique.mockImplementation(
    ({ where }: { where: { code: string } }) =>
      Promise.resolve(plan(where.code)),
  );

  prisma.subscription.findUnique.mockImplementation(
    ({
      where,
      include,
    }: {
      where: { tenantId: string };
      include?: { plan?: boolean };
    }) => {
      if (!state.row || state.row.tenantId !== where.tenantId) {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        include?.plan
          ? { ...state.row, plan: plan(state.row.planCode) }
          : { ...state.row },
      );
    },
  );
  prisma.subscription.create.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) => {
      state.row = subscriptionRow({
        id: 'sub-new',
        ...(data as Partial<SubscriptionRow>),
      });
      return Promise.resolve({ ...state.row });
    },
  );
  prisma.subscription.update.mockImplementation(
    ({
      where,
      data,
    }: {
      where: { id: string; tenantId: string };
      data: Record<string, unknown>;
    }) => {
      if (!state.row || state.row.tenantId !== where.tenantId) {
        return Promise.reject(new Error('update outside the tenant'));
      }
      state.row = { ...state.row, ...data } as SubscriptionRow;
      return Promise.resolve({ ...state.row });
    },
  );
  prisma.subscription.findMany.mockResolvedValue([]);

  prisma.$queryRaw.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('pg_try_advisory'))
        return Promise.resolve([{ locked: true }]);
      if (sql.includes('invoice_sequences')) {
        state.invoiceCounter += 1;
        return Promise.resolve([{ last_number: state.invoiceCounter }]);
      }
      // Row lock: only the tenant that has a subscription row can be locked.
      return Promise.resolve(
        state.row && state.row.tenantId === values[0]
          ? [{ id: state.row.id }]
          : [],
      );
    },
  );

  prisma.billingEvent.findFirst.mockImplementation(
    ({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        state.events.find(
          (e) =>
            e.tenantId === where.tenantId &&
            e.provider === where.provider &&
            e.providerEventId === where.providerEventId,
        ) ?? null,
      ),
  );
  prisma.billingEvent.create.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) => {
      const event = {
        id: `ev-${state.events.length + 1}`,
        createdAt: clock.now(),
        ...data,
      };
      state.events.push(event);
      return Promise.resolve(event);
    },
  );
  prisma.invoice.create.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) => {
      const invoice = {
        id: `inv-${state.invoices.length + 1}`,
        createdAt: clock.now(),
        ...data,
      };
      state.invoices.push(invoice);
      return Promise.resolve(invoice);
    },
  );
  prisma.invoice.findMany.mockImplementation(
    ({ where }: { where: { tenantId: string } }) =>
      Promise.resolve(
        state.invoices.filter((i) => i.tenantId === where.tenantId),
      ),
  );
  prisma.invoice.count.mockImplementation(
    ({ where }: { where: { tenantId: string } }) =>
      Promise.resolve(
        state.invoices.filter((i) => i.tenantId === where.tenantId).length,
      ),
  );
  prisma.billingEvent.findMany.mockImplementation(
    ({ where }: { where: { tenantId: string } }) =>
      Promise.resolve(
        state.events.filter((e) => e.tenantId === where.tenantId),
      ),
  );
  prisma.billingEvent.count.mockImplementation(
    ({ where }: { where: { tenantId: string } }) =>
      Promise.resolve(
        state.events.filter((e) => e.tenantId === where.tenantId).length,
      ),
  );
  prisma.tenant.update.mockImplementation(
    ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      state.mirrors.push({ id: where.id, ...data });
      return Promise.resolve({ id: where.id, ...data });
    },
  );
  return state;
}
