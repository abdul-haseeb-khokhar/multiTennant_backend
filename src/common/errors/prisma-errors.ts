import { Prisma } from '@prisma/client';

/** True when `error` is a Prisma known-request error with the given code (e.g. `P2002`). */
export function isPrismaError(
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}
