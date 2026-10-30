import { ConfigService } from '@nestjs/config';
import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { PrismaService } from '../prisma/prisma.service';
import { JwtStrategy } from './jwt.strategy';
import { PlatformJwtStrategy } from './platform-jwt.strategy';

const config = (
  values: Record<string, string> = { JWT_SECRET: 'x'.repeat(32) },
) =>
  ({
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`Missing ${key}`);
      return values[key];
    },
  }) as unknown as ConfigService;

describe('JwtStrategy (staff tokens)', () => {
  let prisma: PrismaMock;
  let strategy: JwtStrategy;

  const dbUser = (over: Record<string, unknown> = {}) => ({
    role: 'agent',
    status: 'active',
    emailVerifiedAt: new Date('2026-01-01'),
    passwordChangedAt: null,
    tokensValidAfter: null,
    ...over,
  });
  const payload = (over: Record<string, unknown> = {}) => ({
    sub: 'u1',
    tenantId: 't1',
    role: 'agent',
    scope: 'tenant',
    iat: Math.floor(Date.now() / 1000),
    ...over,
  });

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.tenantUser.findUnique.mockResolvedValue(dbUser());
    strategy = new JwtStrategy(config(), prisma as unknown as PrismaService);
  });

  it('accepts a tenant-scoped token and returns the staff user from the database', async () => {
    await expect(strategy.validate(payload())).resolves.toEqual({
      userId: 'u1',
      tenantId: 't1',
      role: 'agent',
      emailVerified: true,
    });
    // The lookup is scoped to the tenant named in the token.
    expect(prisma.tenantUser.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1', tenantId: 't1' },
      select: expect.any(Object),
    });
  });

  it('uses the current role from the database, not the one in the token (demotion is immediate)', async () => {
    prisma.tenantUser.findUnique.mockResolvedValue(dbUser({ role: 'agent' }));
    await expect(
      strategy.validate(payload({ role: 'owner' })),
    ).resolves.toMatchObject({ role: 'agent' });
  });

  it('reports an unverified email', async () => {
    prisma.tenantUser.findUnique.mockResolvedValue(
      dbUser({ emailVerifiedAt: null }),
    );
    await expect(strategy.validate(payload())).resolves.toMatchObject({
      emailVerified: false,
    });
  });

  it.each([
    ['a platform-scoped token', { sub: 'a1', scope: 'platform' }],
    ['a token without scope', { scope: undefined }],
    ['a token without tenantId', { tenantId: undefined }],
    ['a token without subject', { sub: undefined }],
  ])('rejects %s without a database lookup', async (_name, over) => {
    await expect(strategy.validate(payload(over))).rejects.toMatchObject({
      status: 401,
    });
    expect(prisma.tenantUser.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a deleted user, and a user that belongs to another tenant than the token says', async () => {
    prisma.tenantUser.findUnique.mockResolvedValue(null);
    await expect(strategy.validate(payload())).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects a disabled user with 401 ACCOUNT_DISABLED', async () => {
    prisma.tenantUser.findUnique.mockResolvedValue(
      dbUser({ status: 'disabled' }),
    );
    await expect(strategy.validate(payload())).rejects.toMatchObject({
      status: 401,
      response: { code: 'ACCOUNT_DISABLED' },
    });
  });

  it('rejects an unknown role in the database', async () => {
    prisma.tenantUser.findUnique.mockResolvedValue(dbUser({ role: 'root' }));
    await expect(strategy.validate(payload())).rejects.toMatchObject({
      status: 401,
    });
  });

  describe('passwordChangedAt', () => {
    const changedAt = new Date('2026-10-07T10:00:30.500Z');
    const changedSec = Math.floor(changedAt.getTime() / 1000);

    beforeEach(() => {
      prisma.tenantUser.findUnique.mockResolvedValue(
        dbUser({ passwordChangedAt: changedAt }),
      );
    });

    it('rejects a token issued before the password change', async () => {
      await expect(
        strategy.validate(payload({ iat: changedSec - 5 })),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects a token without iat once the password was changed', async () => {
      await expect(
        strategy.validate(payload({ iat: undefined })),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('accepts a token issued in the same second as the change or later (login right after a reset)', async () => {
      await expect(
        strategy.validate(payload({ iat: changedSec })),
      ).resolves.toMatchObject({ userId: 'u1' });
      await expect(
        strategy.validate(payload({ iat: changedSec + 60 })),
      ).resolves.toMatchObject({ userId: 'u1' });
    });
  });

  describe('tokensValidAfter (logout, J1)', () => {
    const loggedOutAt = new Date('2026-10-11T10:00:30.500Z');
    const loggedOutMs = loggedOutAt.getTime();
    const loggedOutSec = Math.floor(loggedOutMs / 1000);

    beforeEach(() => {
      prisma.tenantUser.findUnique.mockResolvedValue(
        dbUser({ tokensValidAfter: loggedOutAt }),
      );
    });

    it('rejects a token issued before the logout', async () => {
      await expect(
        strategy.validate(
          payload({ iat: loggedOutSec - 5, iatMs: loggedOutMs - 5000 }),
        ),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects an old token (no iatMs) from an earlier second, and one with no iat at all', async () => {
      await expect(
        strategy.validate(payload({ iat: loggedOutSec - 1 })),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        strategy.validate(payload({ iat: undefined })),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects a token from the same second that was issued before the logout', async () => {
      await expect(
        strategy.validate(
          payload({ iat: loggedOutSec, iatMs: loggedOutMs - 300 }),
        ),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('accepts a login in the same second, after the logout (second-resolution iat versus millisecond timestamps)', async () => {
      await expect(
        strategy.validate(
          payload({ iat: loggedOutSec, iatMs: loggedOutMs + 250 }),
        ),
      ).resolves.toMatchObject({ userId: 'u1' });
    });

    it('accepts a later token, and any token when the user never logged out', async () => {
      await expect(
        strategy.validate(payload({ iat: loggedOutSec + 3600 })),
      ).resolves.toMatchObject({ userId: 'u1' });
      prisma.tenantUser.findUnique.mockResolvedValue(dbUser());
      await expect(
        strategy.validate(payload({ iat: 1 })),
      ).resolves.toMatchObject({ userId: 'u1' });
    });

    it('applies together with the password change: the later of the two cut-offs wins', async () => {
      prisma.tenantUser.findUnique.mockResolvedValue(
        dbUser({
          passwordChangedAt: new Date(loggedOutMs + 10_000),
          tokensValidAfter: loggedOutAt,
        }),
      );
      await expect(
        strategy.validate(
          payload({ iat: loggedOutSec + 2, iatMs: loggedOutMs + 2000 }),
        ),
      ).rejects.toMatchObject({ status: 401 });
    });
  });

  it('fails fast when JWT_SECRET is not configured', () => {
    expect(
      () => new JwtStrategy(config({}), prisma as unknown as PrismaService),
    ).toThrow('Missing JWT_SECRET');
  });
});

describe('PlatformJwtStrategy (platform-admin tokens)', () => {
  let prisma: PrismaMock;
  let strategy: PlatformJwtStrategy;

  beforeEach(() => {
    prisma = createPrismaMock();
    strategy = new PlatformJwtStrategy(
      config(),
      prisma as unknown as PrismaService,
    );
  });

  it('accepts a platform-scoped token of an existing admin', async () => {
    prisma.platformAdmin.findUnique.mockResolvedValue({ id: 'a1' });
    await expect(
      strategy.validate({ sub: 'a1', scope: 'platform' }),
    ).resolves.toEqual({ adminId: 'a1' });
  });

  it('rejects a tenant-scoped token without a database lookup', async () => {
    await expect(
      strategy.validate({ sub: 'u1', scope: 'tenant' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(prisma.platformAdmin.findUnique).not.toHaveBeenCalled();
  });

  describe('tokensValidAfter (logout, J1)', () => {
    const loggedOutAt = new Date('2026-10-11T10:00:30.500Z');

    it('rejects a token issued before the logout and accepts one issued right after it', async () => {
      prisma.platformAdmin.findUnique.mockResolvedValue({
        id: 'a1',
        tokensValidAfter: loggedOutAt,
      });
      await expect(
        strategy.validate({
          sub: 'a1',
          scope: 'platform',
          iat: 1_791_000_000,
          iatMs: loggedOutAt.getTime() - 1000,
        }),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        strategy.validate({
          sub: 'a1',
          scope: 'platform',
          iat: Math.floor(loggedOutAt.getTime() / 1000),
          iatMs: loggedOutAt.getTime() + 200,
        }),
      ).resolves.toEqual({ adminId: 'a1' });
    });
  });

  it('rejects a token whose admin was deleted', async () => {
    prisma.platformAdmin.findUnique.mockResolvedValue(null);
    await expect(
      strategy.validate({ sub: 'gone', scope: 'platform' }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
