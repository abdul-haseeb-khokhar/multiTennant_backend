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
      'findMany',
      'count',
      'update',
      'delete',
    ),
    endCustomer: model(
      'create',
      'findFirst',
      'findMany',
      'count',
      'update',
      'delete',
    ),
    platformAdmin: model('findUnique'),
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
}

export type PrismaMock = ReturnType<typeof createPrismaMock>;

/** A known Prisma error such as `P2002` (unique violation) or `P2025` (record not found). */
export function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError(`Prisma error ${code}`, {
    code,
    clientVersion: 'test',
  });
}
