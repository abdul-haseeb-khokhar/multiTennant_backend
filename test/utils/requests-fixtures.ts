import { randomUUID } from 'node:crypto';
import { FakeClock } from '../../src/billing/clock';
import { TenantSetup, matches } from './gateway-fixtures';
import { Handoff, UserSetup, installHandoff } from './handoff-fixtures';
import { PrismaMock, prismaError } from './prisma-mock';

type Row = Record<string, any>;

export interface AgentSetup {
  id: string;
  tenantId: string;
  name?: string;
  status?: 'active' | 'disabled';
  isDefault?: boolean;
}

/**
 * The handoff fixture (tenants with subscriptions, staff users, notifications, the event inbox) plus
 * what Phase 5B-2 reads and writes, all in memory: the tenant's agents, end customers created by
 * phone, the `requests` table with its unique (tenant, reference) and (tenant, submission key), the
 * composite foreign keys (a request cannot name another tenant's agent or customer: P2003) and the
 * conditional `updateMany` the workflow relies on, and the call minutes counted in `usage_daily`.
 * Call after `jest.resetAllMocks()`.
 */
export function installRequests(
  prisma: PrismaMock,
  clock: FakeClock,
  setups: {
    tenants: TenantSetup[];
    users: UserSetup[];
    agents: AgentSetup[];
  },
) {
  const h: Handoff = installHandoff(prisma, clock, {
    tenants: setups.tenants,
    users: setups.users,
  });
  const state = {
    agents: setups.agents.map((a) => ({
      name: a.id,
      status: 'active',
      isDefault: false,
      ...a,
    })) as Row[],
    requests: [] as Row[],
    callMinutes: new Map<string, number>(),
    sequence: 0,
  };
  const nextId = (prefix: string) => `${prefix}-${(state.sequence += 1)}`;
  const customers = h.gateway.endCustomers;

  // ---- agents ---------------------------------------------------------------------------------
  prisma.agent.findFirst.mockImplementation(({ where, select }: Row) => {
    const row = state.agents.find((a) => matches(a, where));
    return Promise.resolve(row ? pick(row, select) : null);
  });
  prisma.agent.count.mockImplementation(({ where }: Row) =>
    Promise.resolve(state.agents.filter((a) => matches(a, where)).length),
  );

  // The settings an agent has (the mock engine pulls them at the start of a simulated call).
  prisma.agentSettings.findFirst.mockImplementation(({ where }: Row) => {
    const agent = state.agents.find(
      (a) => a.tenantId === where.tenantId && a.id === where.agentId,
    );
    return Promise.resolve(
      agent
        ? {
            tenantId: agent.tenantId,
            agentId: agent.id,
            version: 1,
            document: { businessName: agent.name },
          }
        : null,
    );
  });

  // ---- end customers (the handoff fixture has findFirst, findMany and upsert) -----------------
  prisma.endCustomer.create.mockImplementation(({ data, select }: Row) => {
    if (
      customers.some(
        (c) => c.tenantId === data.tenantId && c.externalId === data.externalId,
      )
    ) {
      return Promise.reject(prismaError('P2002'));
    }
    const row = {
      id: nextId('ec'),
      metadata: null,
      name: null,
      locale: null,
      createdAt: clock.now(),
      ...data,
    };
    customers.push(row);
    return Promise.resolve(pick(row, select));
  });
  prisma.endCustomer.updateMany.mockImplementation(({ where, data }: Row) => {
    const hits = customers.filter((c) => matches(c, where));
    hits.forEach((c) => Object.assign(c, data));
    return Promise.resolve({ count: hits.length });
  });

  // ---- call minutes in usage_daily -------------------------------------------------------------
  const conversationsAggregate =
    prisma.usageDaily.aggregate.getMockImplementation()!;
  prisma.usageDaily.aggregate.mockImplementation((args: Row) => {
    if (args._sum?.callMinutes) {
      return Promise.resolve({
        _sum: { callMinutes: state.callMinutes.get(args.where.tenantId) ?? 0 },
      });
    }
    return conversationsAggregate(args);
  });

  // ---- requests ---------------------------------------------------------------------------------
  const view = (row: Row, select?: Row): Row => {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [key, wanted] of Object.entries(select)) {
      if (key === 'agent') {
        const agent = state.agents.find(
          (a) => a.tenantId === row.tenantId && a.id === row.agentId,
        )!;
        out.agent = pick(agent, wanted.select);
      } else if (key === 'customer') {
        const customer = customers.find(
          (c) => c.tenantId === row.tenantId && c.id === row.endCustomerId,
        );
        out.customer = customer ? pick(customer, wanted.select) : null;
      } else {
        out[key] = row[key];
      }
    }
    return out;
  };

  const requestMatches = (row: Row, where: Row = {}): boolean => {
    const { OR, createdAt, ...simple } = where;
    if (!matches(row, simple)) return false;
    if (createdAt) {
      if (createdAt.gte && !(row.createdAt >= createdAt.gte)) return false;
      if (createdAt.lte && !(row.createdAt <= createdAt.lte)) return false;
    }
    if (OR) {
      const customer = customers.find(
        (c) => c.tenantId === row.tenantId && c.id === row.endCustomerId,
      );
      const hit = (OR as Row[]).some((alternative) => {
        if (alternative.reference) {
          return String(row.reference)
            .toLowerCase()
            .includes(String(alternative.reference.contains).toLowerCase());
        }
        if (alternative.customer) {
          if (!customer) return false;
          return (alternative.customer.is.OR as Row[]).some((c) => {
            if (c.name) {
              return String(customer.name ?? '')
                .toLowerCase()
                .includes(String(c.name.contains).toLowerCase());
            }
            if (c.externalId) {
              return String(customer.externalId).includes(
                c.externalId.contains,
              );
            }
            return false;
          });
        }
        return false;
      });
      if (!hit) return false;
    }
    return true;
  };

  prisma.customerRequest.create.mockImplementation(({ data, select }: Row) => {
    if (
      state.requests.some(
        (r) =>
          r.tenantId === data.tenantId &&
          (r.reference === data.reference ||
            r.submissionKey === data.submissionKey),
      )
    ) {
      return Promise.reject(prismaError('P2002'));
    }
    // The composite foreign keys: the agent and the customer must belong to the tenant.
    if (
      !state.agents.some(
        (a) => a.tenantId === data.tenantId && a.id === data.agentId,
      ) ||
      (data.endCustomerId &&
        !customers.some(
          (c) => c.tenantId === data.tenantId && c.id === data.endCustomerId,
        ))
    ) {
      return Promise.reject(prismaError('P2003'));
    }
    const row = {
      id: randomUUID(),
      status: 'requested',
      source: 'call',
      channel: 'voice',
      conversationId: null,
      language: null,
      scheduledLocal: null,
      timezone: null,
      configVersion: null,
      details: {},
      note: null,
      cancelledBy: null,
      statusChangedAt: null,
      statusChangedBy: null,
      createdAt: new Date(clock.now().getTime() + state.sequence++),
      updatedAt: clock.now(),
      ...data,
    };
    state.requests.push(row);
    return Promise.resolve(view(row, select));
  });
  prisma.customerRequest.findFirst.mockImplementation(
    ({ where, select }: Row) => {
      const row = state.requests.find((r) => requestMatches(r, where));
      return Promise.resolve(row ? view(row, select) : null);
    },
  );
  prisma.customerRequest.findFirstOrThrow.mockImplementation(
    ({ where, select }: Row) => {
      const row = state.requests.find((r) => requestMatches(r, where));
      return row
        ? Promise.resolve(view(row, select))
        : Promise.reject(prismaError('P2025'));
    },
  );
  prisma.customerRequest.findMany.mockImplementation(
    ({ where, skip = 0, take = 20, select }: Row) =>
      Promise.resolve(
        state.requests
          .filter((r) => requestMatches(r, where))
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              (a.id < b.id ? -1 : 1),
          )
          .slice(skip, skip + take)
          .map((r) => view(r, select)),
      ),
  );
  prisma.customerRequest.count.mockImplementation(({ where }: Row) =>
    Promise.resolve(
      state.requests.filter((r) => requestMatches(r, where)).length,
    ),
  );
  prisma.customerRequest.groupBy.mockImplementation(({ where }: Row) => {
    const counts = new Map<string, number>();
    for (const r of state.requests.filter((x) => requestMatches(x, where))) {
      counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    }
    return Promise.resolve(
      [...counts].map(([status, n]) => ({ status, _count: { _all: n } })),
    );
  });
  // The conditional update the whole workflow relies on: it matches only while the status is still
  // the one the caller read.
  prisma.customerRequest.updateMany.mockImplementation(
    ({ where, data }: Row) => {
      const hits = state.requests.filter((r) => requestMatches(r, where));
      hits.forEach((r) => Object.assign(r, data, { updatedAt: clock.now() }));
      return Promise.resolve({ count: hits.length });
    },
  );

  return {
    ...h,
    h,
    agents: state.agents,
    get requests() {
      return state.requests;
    },
    requestsOf: (tenantId: string) =>
      state.requests.filter((r) => r.tenantId === tenantId),
    customersOf: (tenantId: string) =>
      customers.filter((c) => c.tenantId === tenantId),
    /** Pretends `n` call minutes were counted in usage_daily for the tenant (what the status check reads). */
    setCallMinutes: (tenantId: string, n: number) =>
      state.callMinutes.set(tenantId, n),
  };
}

function pick(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

export type RequestsFixture = ReturnType<typeof installRequests>;
