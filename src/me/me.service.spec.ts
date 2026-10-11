import { Test, TestingModule } from '@nestjs/testing';
import {
  createPrismaMock,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import type { AuthUser } from '../auth/roles';
import { SubscriptionService } from '../billing/subscriptions/subscription.service';
import { PrismaService } from '../prisma/prisma.service';
import { MeService } from './me.service';

const actor: AuthUser = {
  userId: 'u1',
  tenantId: 'tenant-a',
  role: 'agent',
  emailVerified: true,
};

describe('MeService', () => {
  let service: MeService;
  let prisma: PrismaMock;
  let subscriptions: { getEffective: jest.Mock };

  const dbUser = (over: Record<string, unknown> = {}) => ({
    id: 'u1',
    email: 'agent@acme.com',
    name: 'Sana',
    role: 'agent',
    emailVerifiedAt: new Date('2026-10-01'),
    locale: null,
    tenant: {
      id: 'tenant-a',
      name: 'Acme',
      slug: 'acme',
      plan: 'pro',
      status: 'active',
      defaultLocale: 'ur',
    },
    ...over,
  });

  beforeEach(async () => {
    prisma = createPrismaMock();
    prisma.notification.count.mockResolvedValue(0);
    subscriptions = { getEffective: jest.fn().mockResolvedValue(null) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MeService,
        { provide: PrismaService, useValue: prisma },
        { provide: SubscriptionService, useValue: subscriptions },
      ],
    }).compile();
    service = module.get(MeService);
  });

  describe('get', () => {
    it('returns profile, role, tenant (slug, plan, status) and the effective language, looked up within the token tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(dbUser());
      await expect(service.get(actor)).resolves.toEqual({
        user: {
          id: 'u1',
          email: 'agent@acme.com',
          name: 'Sana',
          role: 'agent',
          locale: null,
          emailVerified: true,
        },
        tenant: {
          id: 'tenant-a',
          name: 'Acme',
          slug: 'acme',
          plan: 'pro',
          status: 'active',
          defaultLocale: 'ur',
        },
        subscription: null,
        unreadNotifications: 0,
        locale: 'ur',
      });
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1', tenantId: 'tenant-a' } }),
      );
    });

    it('counts MY unread notifications, scoped to the tenant and the user (the bell badge)', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(dbUser());
      prisma.notification.count.mockResolvedValue(4);
      const me = await service.get(actor);
      expect(me.unreadNotifications).toBe(4);
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a', userId: 'u1', readAt: null },
      });
    });

    it('adds the subscription summary for the dashboard banner, read for the token tenant only', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(dbUser());
      const limits = {
        seats: 3,
        conversationsPerPeriod: 100,
        conversationPeriod: 'total',
        knowledgeMb: 20,
        channels: ['chat'],
        voice: false,
        poweredByLabel: false,
      };
      subscriptions.getEffective.mockResolvedValue({
        tenantId: 'tenant-a',
        subscriptionId: 's1',
        planCode: 'starter',
        planName: 'Starter',
        status: 'active',
        interval: 'none',
        currentPeriodStart: new Date('2026-10-01'),
        currentPeriodEnd: new Date('2026-10-16'),
        cancelAtPeriodEnd: false,
        graceEndsAt: null,
        daysLeft: 9,
        graceDaysLeft: null,
        provider: 'manual',
        entitlements: limits,
        entitlementsOverride: null,
        nextTransitionAt: new Date('2026-10-16'),
      });
      const me = await service.get(actor);
      expect(subscriptions.getEffective).toHaveBeenCalledWith('tenant-a');
      expect(me.subscription).toEqual({
        planCode: 'starter',
        planName: 'Starter',
        status: 'active',
        interval: 'none',
        currentPeriodStart: new Date('2026-10-01'),
        currentPeriodEnd: new Date('2026-10-16'),
        daysLeft: 9,
        cancelAtPeriodEnd: false,
        graceEndsAt: null,
        graceDaysLeft: null,
        limits,
      });
      // Internal billing columns do not leak into /me.
      expect(me.subscription).not.toHaveProperty('provider');
      expect(me.subscription).not.toHaveProperty('subscriptionId');
    });

    it("prefers the user's own language over the tenant default", async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(dbUser({ locale: 'en' }));
      await expect(service.get(actor)).resolves.toMatchObject({
        locale: 'en',
        user: { locale: 'en' },
      });
    });

    it('reports an unverified email and never returns password material', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        dbUser({ emailVerifiedAt: null }),
      );
      const me = await service.get(actor);
      expect(me.user.emailVerified).toBe(false);
      expect(JSON.stringify(me)).not.toMatch(/password|hash/i);
      expect(me.user).not.toHaveProperty('emailVerifiedAt');
    });

    it('401 when the user no longer exists', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      await expect(service.get(actor)).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('update', () => {
    it('changes name and locale of the signed-in user only, scoped to the tenant, and returns the new profile', async () => {
      prisma.tenantUser.update.mockResolvedValue({});
      prisma.tenantUser.findFirst.mockResolvedValue(dbUser({ locale: 'ur' }));
      await expect(
        service.update(actor, { name: 'New', locale: 'ur' }),
      ).resolves.toMatchObject({ locale: 'ur' });
      expect(prisma.tenantUser.update).toHaveBeenCalledWith({
        where: { id: 'u1', tenantId: 'tenant-a' },
        data: { name: 'New', locale: 'ur' },
      });
    });

    it('null clears the language, undefined leaves it alone', async () => {
      prisma.tenantUser.update.mockResolvedValue({});
      prisma.tenantUser.findFirst.mockResolvedValue(dbUser());
      await service.update(actor, { locale: null });
      expect(prisma.tenantUser.update.mock.calls[0][0].data).toEqual({
        name: undefined,
        locale: null,
      });
    });

    it('404 USER_NOT_FOUND when the user vanished (P2025)', async () => {
      prisma.tenantUser.update.mockRejectedValue(prismaError('P2025'));
      await expect(service.update(actor, { name: 'x' })).rejects.toMatchObject({
        status: 404,
        response: { code: 'USER_NOT_FOUND' },
      });
    });
  });
});
