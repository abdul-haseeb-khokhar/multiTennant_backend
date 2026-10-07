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
  const strategy = new JwtStrategy(config());

  it('accepts a tenant-scoped token and returns the staff user', () => {
    expect(
      strategy.validate({
        sub: 'u1',
        tenantId: 't1',
        role: 'agent',
        scope: 'tenant',
      }),
    ).toEqual({
      userId: 'u1',
      tenantId: 't1',
      role: 'agent',
    });
  });

  it.each([
    ['a platform-scoped token', { sub: 'a1', scope: 'platform' }],
    ['a token without scope', { sub: 'u1', tenantId: 't1', role: 'owner' }],
    ['a token without tenantId', { sub: 'u1', role: 'owner', scope: 'tenant' }],
    [
      'a token without subject',
      { tenantId: 't1', role: 'owner', scope: 'tenant' },
    ],
    [
      'an unknown role',
      { sub: 'u1', tenantId: 't1', role: 'root', scope: 'tenant' },
    ],
  ])('rejects %s', (_name, payload) => {
    expect(() => strategy.validate(payload)).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('fails fast when JWT_SECRET is not configured', () => {
    expect(() => new JwtStrategy(config({}))).toThrow('Missing JWT_SECRET');
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

  it('rejects a token whose admin was deleted', async () => {
    prisma.platformAdmin.findUnique.mockResolvedValue(null);
    await expect(
      strategy.validate({ sub: 'gone', scope: 'platform' }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
