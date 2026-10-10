import { createHash } from 'node:crypto';
import { FakeClock } from '../../src/billing/clock';
import { PLAN_ROWS, T0, subscriptionRow } from './billing-fixtures';
import { PrismaMock, mockTransaction, prismaError } from './prisma-mock';

type Row = Record<string, any>;

export interface TenantSetup {
  id: string;
  status?: string;
  defaultLocale?: string;
  /** Plan code of the tenant's subscription (default `free`). */
  plan?: string;
  subscriptionStatus?: string;
  /** Overrides merged over the plan's entitlements, e.g. `{ conversationsPerPeriod: 2 }`. */
  entitlementsOverride?: Record<string, unknown> | null;
  periodStart?: Date;
}

export interface KeySetup {
  id: string;
  tenantId: string;
  /** The full key as the browser would send it. */
  key: string;
  allowedOrigins: string[];
  type?: string;
  revokedAt?: Date | null;
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Does `row` satisfy a Prisma-style `where` (the small subset the gateway uses)? */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'OR') {
      return (condition as Row[]).some((alternative) =>
        matches(row, alternative),
      );
    }
    const value = row[field];
    if (condition === null) return value === null || value === undefined;
    if (
      condition &&
      typeof condition === 'object' &&
      !(condition instanceof Date)
    ) {
      if ('has' in condition)
        return (value as unknown[]).includes(condition.has);
      if ('lt' in condition) return value !== null && value < condition.lt;
      if ('gte' in condition) return value >= condition.gte;
      if ('gt' in condition) return value > condition.gt;
      if ('not' in condition) return value !== condition.not;
    }
    return value === condition;
  });
}

const omitHash = (row: Row, omit?: { keyHash?: boolean }) => {
  if (!omit?.keyHash) return { ...row };
  const { keyHash: _hash, ...rest } = row;
  return rest;
};

/**
 * An in-memory Prisma for the gateway: tenants, subscriptions (several tenants, unlike
 * `installBilling`), API keys, end customers, gateway conversations, usage counters and the
 * dedupe ledger. Everything the widget and API-key routes read or write is here, so a test can
 * drive the real HTTP stack and then inspect what was stored. Call after `jest.resetAllMocks()`.
 */
export function installGateway(
  prisma: PrismaMock,
  clock: FakeClock,
  setups: { tenants: TenantSetup[]; keys?: KeySetup[] },
) {
  clock.set(T0);
  mockTransaction(prisma);

  const state = {
    tenants: new Map<string, Row>(),
    subscriptions: new Map<string, Row>(),
    apiKeys: [] as Row[],
    endCustomers: [] as Row[],
    conversations: [] as Row[],
    usageEvents: [] as Row[],
    usageDaily: [] as Row[],
    audit: [] as Row[],
    sequence: 0,
  };
  const nextId = (prefix: string) => `${prefix}-${(state.sequence += 1)}`;

  for (const tenant of setups.tenants) {
    state.tenants.set(tenant.id, {
      id: tenant.id,
      status: tenant.status ?? 'active',
      defaultLocale: tenant.defaultLocale ?? 'en',
    });
    state.subscriptions.set(
      tenant.id,
      subscriptionRow({
        id: `sub-${tenant.id}`,
        tenantId: tenant.id,
        planCode: tenant.plan ?? 'free',
        status: tenant.subscriptionStatus ?? 'active',
        entitlementsOverride: tenant.entitlementsOverride ?? null,
        currentPeriodStart: tenant.periodStart ?? T0,
        currentPeriodEnd: null,
      }),
    );
  }
  for (const key of setups.keys ?? []) {
    state.apiKeys.push({
      id: key.id,
      tenantId: key.tenantId,
      type: key.type ?? 'widget',
      name: key.id,
      keyPrefix: key.key.slice(0, 8),
      keyHash: sha256(key.key),
      allowedOrigins: key.allowedOrigins,
      lastUsedAt: null,
      revokedAt: key.revokedAt ?? null,
      createdBy: 'seed',
      createdAt: T0,
    });
  }

  // ---- tenants and subscriptions (billing reads them) --------------------------------------
  prisma.tenant.findUnique.mockImplementation(({ where }: { where: Row }) =>
    Promise.resolve(state.tenants.get(where.id) ?? null),
  );
  prisma.plan.findMany.mockResolvedValue(PLAN_ROWS);
  prisma.plan.findUnique.mockImplementation(({ where }: { where: Row }) =>
    Promise.resolve(PLAN_ROWS.find((p) => p.code === where.code) ?? null),
  );
  prisma.subscription.findUnique.mockImplementation(
    ({ where, include }: { where: Row; include?: Row }) => {
      const row = state.subscriptions.get(where.tenantId);
      if (!row) return Promise.resolve(null);
      return Promise.resolve(
        include?.plan
          ? { ...row, plan: PLAN_ROWS.find((p) => p.code === row.planCode) }
          : { ...row },
      );
    },
  );
  prisma.subscription.findMany.mockResolvedValue([]);

  // ---- API keys ------------------------------------------------------------------------------
  prisma.apiKey.create.mockImplementation(
    ({ data, omit }: { data: Row; omit?: Row }) => {
      const row = {
        id: nextId('key'),
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date(clock.now()),
        ...data,
      };
      state.apiKeys.push(row);
      return Promise.resolve(omitHash(row, omit));
    },
  );
  prisma.apiKey.findUnique.mockImplementation(
    ({ where, omit }: { where: Row; omit?: Row }) => {
      const row = state.apiKeys.find((k) => k.keyHash === where.keyHash);
      return Promise.resolve(row ? omitHash(row, omit) : null);
    },
  );
  const findKey = ({ where, omit }: { where: Row; omit?: Row }) => {
    const row = state.apiKeys.find((k) => matches(k, where));
    return row ? omitHash(row, omit) : null;
  };
  prisma.apiKey.findFirst.mockImplementation((args: Row) =>
    Promise.resolve(findKey(args as never)),
  );
  prisma.apiKey.findFirstOrThrow.mockImplementation((args: Row) => {
    const row = findKey(args as never);
    return row ? Promise.resolve(row) : Promise.reject(prismaError('P2025'));
  });
  prisma.apiKey.findMany.mockImplementation(
    ({ where, skip = 0, take = 20, omit }: Row) =>
      Promise.resolve(
        state.apiKeys
          .filter((k) => matches(k, where))
          .slice(skip, skip + take)
          .map((k) => omitHash(k, omit)),
      ),
  );
  prisma.apiKey.count.mockImplementation(({ where }: { where: Row }) =>
    Promise.resolve(state.apiKeys.filter((k) => matches(k, where)).length),
  );
  prisma.apiKey.updateMany.mockImplementation(
    ({ where, data }: { where: Row; data: Row }) => {
      const hits = state.apiKeys.filter((k) => matches(k, where));
      hits.forEach((k) => Object.assign(k, data));
      return Promise.resolve({ count: hits.length });
    },
  );

  // ---- end customers ------------------------------------------------------------------------
  prisma.endCustomer.upsert.mockImplementation(
    ({ where, create }: { where: Row; create: Row }) => {
      const { tenantId, externalId } = where.tenantId_externalId;
      let row = state.endCustomers.find(
        (c) => c.tenantId === tenantId && c.externalId === externalId,
      );
      if (!row) {
        row = { id: nextId('ec'), name: null, metadata: null, ...create };
        state.endCustomers.push(row);
      }
      return Promise.resolve({ ...row });
    },
  );
  const findCustomer = ({ where }: { where: Row }) =>
    state.endCustomers.find((c) => matches(c, where));
  prisma.endCustomer.findFirst.mockImplementation((args: Row) =>
    Promise.resolve(findCustomer(args as never) ?? null),
  );
  prisma.endCustomer.findFirstOrThrow.mockImplementation((args: Row) => {
    const row = findCustomer(args as never);
    return row
      ? Promise.resolve({ ...row })
      : Promise.reject(prismaError('P2025'));
  });

  // ---- gateway conversations ----------------------------------------------------------------
  prisma.gatewayConversation.create.mockImplementation(
    ({ data }: { data: Row }) => {
      if (
        state.conversations.some(
          (c) =>
            c.tenantId === data.tenantId &&
            c.conversationId === data.conversationId,
        )
      ) {
        return Promise.reject(prismaError('P2002'));
      }
      const row = {
        id: nextId('gc'),
        apiKeyId: null,
        aiBlocked: false,
        escalationReason: null,
        escalationPending: false,
        closedAt: null,
        createdAt: new Date(state.sequence),
        lastActivityAt: clock.now(),
        ...data,
      };
      state.conversations.push(row);
      return Promise.resolve({ ...row });
    },
  );
  const findConversation = ({ where, orderBy }: Row) => {
    const hits = state.conversations.filter((c) => matches(c, where));
    if (orderBy?.createdAt === 'desc') {
      hits.sort((a, b) => b.createdAt - a.createdAt);
    }
    return hits[0];
  };
  prisma.gatewayConversation.findFirst.mockImplementation((args: Row) => {
    const row = findConversation(args);
    return Promise.resolve(row ? { ...row } : null);
  });
  prisma.gatewayConversation.findFirstOrThrow.mockImplementation(
    (args: Row) => {
      const row = findConversation(args);
      return row
        ? Promise.resolve({ ...row })
        : Promise.reject(prismaError('P2025'));
    },
  );
  prisma.gatewayConversation.count.mockImplementation(
    ({ where }: { where: Row }) =>
      Promise.resolve(
        state.conversations.filter((c) => matches(c, where)).length,
      ),
  );
  prisma.gatewayConversation.updateMany.mockImplementation(
    ({ where, data }: { where: Row; data: Row }) => {
      const hits = state.conversations.filter((c) => matches(c, where));
      hits.forEach((c) => Object.assign(c, data));
      return Promise.resolve({ count: hits.length });
    },
  );

  // ---- usage ---------------------------------------------------------------------------------
  prisma.usageEvent.createMany.mockImplementation(
    ({ data }: { data: Row[] }) => {
      let count = 0;
      for (const event of data) {
        const duplicate = state.usageEvents.some(
          (e) =>
            e.tenantId === event.tenantId &&
            e.kind === event.kind &&
            e.refId === event.refId,
        );
        if (!duplicate) {
          state.usageEvents.push({ ...event });
          count += 1;
        }
      }
      return Promise.resolve({ count });
    },
  );
  // The increment is a raw upsert: tenant, date, conversations, messages, tokensIn, tokensOut.
  prisma.$executeRaw.mockImplementation(
    (_strings: TemplateStringsArray, ...v: unknown[]) => {
      const [tenantId, date, conversations, messages, tokensIn, tokensOut] =
        v as [string, string, number, number, number, number];
      const day = new Date(`${date}T00:00:00.000Z`);
      let row = state.usageDaily.find(
        (r) => r.tenantId === tenantId && r.day.getTime() === day.getTime(),
      );
      if (!row) {
        row = {
          tenantId,
          day,
          conversations: 0,
          messages: 0,
          tokensIn: 0,
          tokensOut: 0,
        };
        state.usageDaily.push(row);
      }
      row.conversations += conversations;
      row.messages += messages;
      row.tokensIn += tokensIn;
      row.tokensOut += tokensOut;
      return Promise.resolve(1);
    },
  );
  prisma.usageDaily.aggregate.mockImplementation(({ where }: { where: Row }) =>
    Promise.resolve({
      _sum: {
        conversations: state.usageDaily
          .filter((r) => matches(r, where))
          .reduce((sum, r) => sum + r.conversations, 0),
      },
    }),
  );

  // ---- audit and misc -------------------------------------------------------------------------
  prisma.auditLog.create.mockImplementation(({ data }: { data: Row }) => {
    state.audit.push(data);
    return Promise.resolve(data);
  });
  prisma.platformAdmin.findUnique.mockResolvedValue({ id: 'admin-1' });
  prisma.tenantUser.count.mockResolvedValue(1);
  prisma.staffInvite.count.mockResolvedValue(0);

  return {
    ...state,
    /** Today's UTC usage row for a tenant. */
    usageOf: (tenantId: string) =>
      state.usageDaily.filter((r) => r.tenantId === tenantId),
    /** Pretends `n` conversations were already counted this month. */
    seedConversations: (tenantId: string, n: number) =>
      state.usageDaily.push({
        tenantId,
        day: new Date(Date.UTC(2026, 9, 1)),
        conversations: n,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    sha256,
  };
}

export type Gateway = ReturnType<typeof installGateway>;
