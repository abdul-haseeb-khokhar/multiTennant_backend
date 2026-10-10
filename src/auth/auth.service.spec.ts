import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import {
  createPrismaMock,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import { SubscriptionService } from '../billing/subscriptions/subscription.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { EmailVerificationService } from './email-verification.service';
import { SessionTokenService } from './session-token.service';

jest.mock('bcrypt', () => {
  const actual = jest.requireActual('bcrypt');
  return { ...actual, compare: jest.fn(actual.compare) };
});

describe('AuthService', () => {
  let service: AuthService;
  let prisma: PrismaMock;
  let sessionTokens: { sign: jest.Mock };
  let verification: { issue: jest.Mock };
  let subscriptions: { createStarter: jest.Mock };
  let passwordHash: string;

  beforeAll(() => {
    passwordHash = bcrypt.hashSync('password123', 4);
  });

  beforeEach(async () => {
    prisma = createPrismaMock();
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(prisma),
    );
    sessionTokens = { sign: jest.fn().mockReturnValue('signed.jwt.token') };
    verification = { issue: jest.fn().mockResolvedValue({}) };
    subscriptions = { createStarter: jest.fn().mockResolvedValue({}) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: SessionTokenService, useValue: sessionTokens },
        { provide: EmailVerificationService, useValue: verification },
        { provide: SubscriptionService, useValue: subscriptions },
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
        status: 'active',
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
      expect(sessionTokens.sign).toHaveBeenCalledWith('u1', 't1', 'admin');
    });

    it('trims and lower-cases the email before looking the user up', async () => {
      await service.login({ ...dto, email: '  Owner@ACME.com ' });
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 't1', email: 'owner@acme.com' },
      });
    });

    it('refuses a disabled user with 403 ACCOUNT_DISABLED, but only after the password checked out', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u1',
        tenantId: 't1',
        role: 'agent',
        status: 'disabled',
        passwordHash,
      });
      await expect(service.login(dto)).rejects.toMatchObject({
        status: 403,
        response: { code: 'ACCOUNT_DISABLED' },
      });
      await expect(
        service.login({ ...dto, password: 'wrong-pass' }),
      ).rejects.toMatchObject({
        status: 401,
        response: { code: 'INVALID_CREDENTIALS' },
      });
      expect(sessionTokens.sign).not.toHaveBeenCalled();
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
      expect(sessionTokens.sign).not.toHaveBeenCalled();
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

    it('refuses a closed account with 403 TENANT_CLOSED', async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        slug: 'acme',
        status: 'closed',
      });
      await expect(service.login(dto)).rejects.toMatchObject({
        status: 403,
        response: { code: 'TENANT_CLOSED' },
      });
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
        Promise.resolve({
          id: 't1',
          plan: 'free',
          status: 'trial',
          defaultLocale: 'en',
          ...data,
        }),
      );
      prisma.tenantUser.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'u1',
          tenantId: data.tenantId,
          email: data.email,
          role: data.role,
        }),
      );
    });

    it('creates tenant and owner in one transaction; plan and status come from the schema defaults', async () => {
      const res = await service.signup(dto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.tenant.create).toHaveBeenCalledWith({
        data: {
          name: 'Acme Support',
          slug: 'acme-support',
          defaultLocale: 'en',
        },
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
      expect(sessionTokens.sign).toHaveBeenCalledWith('u1', 't1', 'owner');
    });

    it('starts the tenant on Starter inside the signup transaction (I2)', async () => {
      await service.signup(dto);
      expect(subscriptions.createStarter).toHaveBeenCalledTimes(1);
      expect(subscriptions.createStarter).toHaveBeenCalledWith(prisma, 't1');
    });

    it('does not create a subscription when the signup fails (the transaction rolls back)', async () => {
      prisma.tenantUser.create.mockRejectedValue(new Error('boom'));
      await expect(service.signup(dto)).rejects.toThrow('boom');
      expect(subscriptions.createStarter).not.toHaveBeenCalled();
    });

    it('normalises the owner email and stores the chosen default locale', async () => {
      await service.signup({
        ...dto,
        ownerEmail: ' Owner@ACME.com ',
        locale: 'ur',
      });
      expect(prisma.tenant.create.mock.calls[0][0].data.defaultLocale).toBe(
        'ur',
      );
      expect(prisma.tenantUser.create.mock.calls[0][0].data.email).toBe(
        'owner@acme.com',
      );
    });

    it('starts email verification for the new owner and exposes the link only when the mailer returns one', async () => {
      const res = await service.signup(dto);
      expect(verification.issue).toHaveBeenCalledWith({
        id: 'u1',
        email: 'owner@acme.com',
        locale: 'en',
      });
      expect(res.verificationLink).toBeUndefined();

      verification.issue.mockResolvedValue({ link: 'http://x/verify?token=t' });
      await expect(service.signup(dto)).resolves.toMatchObject({
        verificationLink: 'http://x/verify?token=t',
      });
    });

    it('uses the slug the caller asked for', async () => {
      await service.signup({ ...dto, tenantSlug: 'acme' });
      expect(prisma.tenant.create).toHaveBeenCalledWith({
        data: { name: 'Acme Support', slug: 'acme', defaultLocale: 'en' },
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
