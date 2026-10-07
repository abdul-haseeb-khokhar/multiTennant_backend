import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import {
  createPrismaMock,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

jest.mock('bcrypt', () => {
  const actual = jest.requireActual('bcrypt');
  return { ...actual, compare: jest.fn(actual.compare) };
});

describe('AuthService', () => {
  let service: AuthService;
  let prisma: PrismaMock;
  let jwt: { sign: jest.Mock };
  let passwordHash: string;

  beforeAll(() => {
    passwordHash = bcrypt.hashSync('password123', 4);
  });

  beforeEach(async () => {
    prisma = createPrismaMock();
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(prisma),
    );
    jwt = { sign: jest.fn().mockReturnValue('signed.jwt.token') };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  describe('login', () => {
    const dto = {
      tenantSlug: 'acme',
      email: 'owner@acme.com',
      password: 'password123',
    };

    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        slug: 'acme',
        status: 'active',
      });
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u1',
        tenantId: 't1',
        role: 'admin',
        passwordHash,
      });
    });

    it('resolves the tenant by slug, scopes the user lookup to it and signs a tenant-scoped token', async () => {
      await expect(service.login(dto)).resolves.toEqual({
        access_token: 'signed.jwt.token',
      });
      expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
        where: { slug: 'acme' },
      });
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 't1', email: 'owner@acme.com' },
      });
      expect(jwt.sign).toHaveBeenCalledWith({
        sub: 'u1',
        tenantId: 't1',
        role: 'admin',
        scope: 'tenant',
      });
    });

    it('fails with INVALID_CREDENTIALS for a wrong password, unknown user and unknown tenant alike', async () => {
      await expect(
        service.login({ ...dto, password: 'nope-nope' }),
      ).rejects.toMatchObject({
        status: 401,
        response: { code: 'INVALID_CREDENTIALS' },
      });

      prisma.tenantUser.findFirst.mockResolvedValue(null);
      await expect(service.login(dto)).rejects.toMatchObject({
        status: 401,
        response: { code: 'INVALID_CREDENTIALS' },
      });

      prisma.tenant.findUnique.mockResolvedValue(null);
      await expect(service.login(dto)).rejects.toMatchObject({
        status: 401,
        response: { code: 'INVALID_CREDENTIALS' },
      });
      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('still compares a password when the tenant is unknown, to keep timing similar', async () => {
      const compare = bcrypt.compare as unknown as jest.Mock;
      compare.mockClear();
      prisma.tenant.findUnique.mockResolvedValue(null);
      await expect(service.login(dto)).rejects.toBeDefined();
      expect(compare).toHaveBeenCalledTimes(1);
      expect(prisma.tenantUser.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a suspended tenant with 403 TENANT_SUSPENDED, but only after the password checked out', async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        slug: 'acme',
        status: 'suspended',
      });
      await expect(service.login(dto)).rejects.toMatchObject({
        status: 403,
        response: { code: 'TENANT_SUSPENDED' },
      });

      await expect(
        service.login({ ...dto, password: 'wrong-pass' }),
      ).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('signup', () => {
    const dto = {
      tenantName: 'Acme Support',
      ownerEmail: 'owner@acme.com',
      ownerPassword: 'password123',
    };

    beforeEach(() => {
      prisma.tenant.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 't1', plan: 'free', status: 'trial', ...data }),
      );
      prisma.tenantUser.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'u1', tenantId: data.tenantId, role: data.role }),
      );
    });

    it('creates tenant and owner in one transaction; plan and status come from the schema defaults', async () => {
      const res = await service.signup(dto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.tenant.create).toHaveBeenCalledWith({
        data: { name: 'Acme Support', slug: 'acme-support' },
      });
      const ownerArg = prisma.tenantUser.create.mock.calls[0][0];
      expect(ownerArg.data).toMatchObject({
        tenantId: 't1',
        email: 'owner@acme.com',
        role: 'owner',
      });
      expect(
        await bcrypt.compare('password123', ownerArg.data.passwordHash),
      ).toBe(true);
      expect(ownerArg.omit).toEqual({ passwordHash: true });
      expect(res.access_token).toBe('signed.jwt.token');
      expect(jwt.sign).toHaveBeenCalledWith({
        sub: 'u1',
        tenantId: 't1',
        role: 'owner',
        scope: 'tenant',
      });
    });

    it('uses the slug the caller asked for', async () => {
      await service.signup({ ...dto, tenantSlug: 'acme' });
      expect(prisma.tenant.create).toHaveBeenCalledWith({
        data: { name: 'Acme Support', slug: 'acme' },
      });
    });

    it('409 SLUG_TAKEN for a taken explicit slug (P2002), without retrying', async () => {
      prisma.tenant.create.mockRejectedValue(prismaError('P2002'));
      await expect(
        service.signup({ ...dto, tenantSlug: 'acme' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'SLUG_TAKEN' },
      });
      expect(prisma.tenant.create).toHaveBeenCalledTimes(1);
    });

    it('409 SLUG_TAKEN for a reserved explicit slug, before touching the database', async () => {
      await expect(
        service.signup({ ...dto, tenantSlug: 'admin' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'SLUG_TAKEN' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('retries a derived slug with a random suffix, then gives up with 409', async () => {
      prisma.tenant.create.mockRejectedValueOnce(prismaError('P2002'));
      await service.signup(dto);
      expect(prisma.tenant.create).toHaveBeenCalledTimes(2);
      expect(prisma.tenant.create.mock.calls[1][0].data.slug).toMatch(
        /^acme-support-[0-9a-f]{6}$/,
      );

      prisma.tenant.create.mockReset();
      prisma.tenant.create.mockRejectedValue(prismaError('P2002'));
      await expect(service.signup(dto)).rejects.toMatchObject({
        status: 409,
        response: { code: 'SLUG_TAKEN' },
      });
      expect(prisma.tenant.create).toHaveBeenCalledTimes(5);
    });

    it('rethrows unexpected errors', async () => {
      prisma.tenant.create.mockRejectedValue(new Error('db down'));
      await expect(service.signup(dto)).rejects.toThrow('db down');
    });
  });
});
