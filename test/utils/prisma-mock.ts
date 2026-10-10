import { Prisma } from '@prisma/client';

const model = (...methods: string[]) =>
  Object.fromEntries(methods.map((m) => [m, jest.fn()])) as Record<
    string,
    jest.Mock
  >;

/** A `PrismaService` stand-in: every delegate method is a `jest.fn()` the test configures. */
export function createPrismaMock() {
  return {
    tenant: model(
      'create',
      'findUnique',
      'findMany',
      'count',
      'update',
      'delete',
    ),
    tenantUser: model(
      'create',
      'findFirst',
      'findUnique',
      'findMany',
      'count',
      'update',
      'delete',
    ),
    endCustomer: model(
      'create',
      'findFirst',
      'findFirstOrThrow',
      'findMany',
      'count',
      'update',
      'upsert',
      'delete',
    ),
    platformAdmin: model('findUnique'),
    staffInvite: model(
      'create',
      'findFirst',
      'findUnique',
      'findMany',
      'count',
      'update',
      'updateMany',
    ),
    passwordReset: model('create', 'findUnique', 'updateMany'),
    emailVerification: model('create', 'findUnique', 'updateMany'),
    auditLog: model('create', 'findMany', 'count'),
    plan: model('findUnique', 'findMany'),
    subscription: model('create', 'findUnique', 'findMany', 'update'),
    invoice: model('create', 'findMany', 'count'),
    billingEvent: model('create', 'findFirst', 'findMany', 'count'),
    dataUseConsent: model('findUnique', 'upsert', 'update'),
    apiKey: model(
      'create',
      'findFirst',
      'findFirstOrThrow',
      'findUnique',
      'findMany',
      'count',
      'updateMany',
    ),
    gatewayConversation: model(
      'create',
      'findFirst',
      'findFirstOrThrow',
      'findMany',
      'count',
      'updateMany',
    ),
    usageEvent: model('createMany'),
    usageDaily: model('aggregate', 'findMany'),
    notification: model(
      'createManyAndReturn',
      'findFirst',
      'findMany',
      'count',
      'updateMany',
      'deleteMany',
    ),
    engineEvent: model('createMany', 'deleteMany'),
    streamTicket: model('create', 'updateMany', 'findUnique', 'deleteMany'),
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  };
}

export type PrismaMock = ReturnType<typeof createPrismaMock>;

/**
 * Makes `$transaction` run its callback against the same mock client (or resolve an array of
 * operations), the way the services use it. Call it after `jest.resetAllMocks()`.
 */
export function mockTransaction(prisma: PrismaMock) {
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => unknown)(prisma)
      : Promise.all(arg as unknown[]),
  );
}

/** A known Prisma error such as `P2002` (unique violation) or `P2025` (record not found). */
export function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError(`Prisma error ${code}`, {
    code,
    clientVersion: 'test',
  });
}
