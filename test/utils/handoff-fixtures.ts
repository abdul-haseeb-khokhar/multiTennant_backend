import { randomUUID } from 'node:crypto';
import { FakeClock } from '../../src/billing/clock';
import {
  Gateway,
  TenantSetup,
  installGateway,
  matches,
} from './gateway-fixtures';
import { PrismaMock, prismaError } from './prisma-mock';

type Row = Record<string, any>;

export interface UserSetup {
  id: string;
  tenantId: string;
  role: 'owner' | 'admin' | 'agent';
  name?: string | null;
  email?: string;
  status?: 'active' | 'disabled';
}

/**
 * The gateway fixture plus everything Phase 4 reads and writes: staff users (names, recipients),
 * end customers for the conversation views, the notification table with its unique
 * (tenant, user, dedupe key), the engine event inbox with its unique (tenant, event id) and the
 * stream tickets with their single-use claim. Call after `jest.resetAllMocks()`.
 */
export function installHandoff(
  prisma: PrismaMock,
  clock: FakeClock,
  setups: {
    tenants: TenantSetup[];
    keys?: Parameters<typeof installGateway>[2]['keys'];
    users: UserSetup[];
  },
) {
  const gateway: Gateway = installGateway(prisma, clock, setups);
  const state = {
    users: setups.users.map((u) => ({
      name: null,
      email: `${u.id}@example.test`,
      status: 'active',
      ...u,
    })) as Row[],
    notifications: [] as Row[],
    engineEvents: [] as Row[],
    tickets: [] as Row[],
    sequence: 0,
  };
  const nextId = (prefix: string) => `${prefix}-${(state.sequence += 1)}`;

  // ---- staff users --------------------------------------------------------------------------
  const pick = (row: Row, select?: Row) => {
    if (!select) return { ...row };
    return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
  };
  prisma.tenantUser.findMany.mockImplementation(({ where, select }: Row) =>
    Promise.resolve(
      state.users.filter((u) => matches(u, where)).map((u) => pick(u, select)),
    ),
  );
  prisma.tenantUser.findFirst.mockImplementation(({ where, select }: Row) => {
    const user = state.users.find((u) => matches(u, where));
    return Promise.resolve(user ? pick(user, select) : null);
  });

  // ---- end customers (the gateway fixture has upsert and findFirst) ---------------------------
  prisma.endCustomer.findMany.mockImplementation(({ where, select }: Row) =>
    Promise.resolve(
      gateway.endCustomers
        .filter((c) => matches(c, where))
        .map((c) => pick(c, select)),
    ),
  );

  // ---- notifications --------------------------------------------------------------------------
  prisma.notification.createManyAndReturn.mockImplementation(
    ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      const created: Row[] = [];
      for (const item of data) {
        const duplicate =
          item.dedupeKey !== null &&
          item.dedupeKey !== undefined &&
          state.notifications.some(
            (n) =>
              n.tenantId === item.tenantId &&
              n.userId === item.userId &&
              n.dedupeKey === item.dedupeKey,
          );
        if (duplicate) {
          if (skipDuplicates) continue;
          return Promise.reject(prismaError('P2002'));
        }
        const row = {
          id: randomUUID(),
          readAt: null,
          createdAt: new Date(clock.now().getTime() + state.sequence++),
          ...item,
        };
        state.notifications.push(row);
        created.push({ ...row });
      }
      return Promise.resolve(created);
    },
  );
  prisma.notification.findMany.mockImplementation(
    ({ where, skip = 0, take = 20, select }: Row) =>
      Promise.resolve(
        state.notifications
          .filter((n) => matches(n, where))
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(skip, skip + take)
          .map((n) => pick(n, select)),
      ),
  );
  prisma.notification.findFirst.mockImplementation(({ where, select }: Row) => {
    const row = state.notifications.find((n) => matches(n, where));
    return Promise.resolve(row ? pick(row, select) : null);
  });
  prisma.notification.count.mockImplementation(({ where }: Row) =>
    Promise.resolve(
      state.notifications.filter((n) => matches(n, where)).length,
    ),
  );
  prisma.notification.updateMany.mockImplementation(({ where, data }: Row) => {
    const hits = state.notifications.filter((n) => matches(n, where));
    hits.forEach((n) => Object.assign(n, data));
    return Promise.resolve({ count: hits.length });
  });
  prisma.notification.deleteMany.mockImplementation(({ where }: Row) => {
    const before = state.notifications.length;
    state.notifications = state.notifications.filter((n) => !matches(n, where));
    return Promise.resolve({ count: before - state.notifications.length });
  });

  // ---- engine event inbox -----------------------------------------------------------------------
  prisma.engineEvent.createMany.mockImplementation(
    ({ data }: { data: Row[] }) => {
      let count = 0;
      for (const item of data) {
        if (
          state.engineEvents.some(
            (e) => e.tenantId === item.tenantId && e.eventId === item.eventId,
          )
        ) {
          continue;
        }
        state.engineEvents.push({ ...item, receivedAt: clock.now() });
        count += 1;
      }
      return Promise.resolve({ count });
    },
  );
  prisma.engineEvent.deleteMany.mockImplementation(({ where }: Row) => {
    const before = state.engineEvents.length;
    state.engineEvents = state.engineEvents.filter((e) => !matches(e, where));
    return Promise.resolve({ count: before - state.engineEvents.length });
  });

  // ---- stream tickets -----------------------------------------------------------------------------
  prisma.streamTicket.create.mockImplementation(({ data }: { data: Row }) => {
    const row = {
      id: nextId('ticket'),
      usedAt: null,
      createdAt: clock.now(),
      ...data,
    };
    state.tickets.push(row);
    return Promise.resolve({ ...row });
  });
  prisma.streamTicket.updateMany.mockImplementation(({ where, data }: Row) => {
    const hits = state.tickets.filter((t) => matches(t, where));
    hits.forEach((t) => Object.assign(t, data));
    return Promise.resolve({ count: hits.length });
  });
  prisma.streamTicket.findUnique.mockImplementation(
    ({ where, select }: Row) => {
      const row = state.tickets.find((t) => t.tokenHash === where.tokenHash);
      return Promise.resolve(row ? pick(row, select) : null);
    },
  );
  prisma.streamTicket.deleteMany.mockImplementation(({ where }: Row) => {
    const before = state.tickets.length;
    state.tickets = state.tickets.filter((t) => !matches(t, where));
    return Promise.resolve({ count: before - state.tickets.length });
  });

  // ---- transaction-level raw queries (advisory locks) ----------------------------------------------
  prisma.$queryRaw.mockResolvedValue([{ locked: true }]);

  return {
    gateway,
    get users() {
      return state.users;
    },
    get notifications() {
      return state.notifications;
    },
    get engineEvents() {
      return state.engineEvents;
    },
    get tickets() {
      return state.tickets;
    },
    get audit() {
      return gateway.audit;
    },
    userById: (id: string) => state.users.find((u) => u.id === id),
    notificationsOf: (userId: string) =>
      state.notifications.filter((n) => n.userId === userId),
  };
}

export type Handoff = ReturnType<typeof installHandoff>;
