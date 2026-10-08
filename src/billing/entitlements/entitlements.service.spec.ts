import { Test, TestingModule } from '@nestjs/testing';
import { Clock, FakeClock } from '../clock';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { Entitlements } from './entitlements';
import {
  ENTITLEMENTS_CACHE_TTL_MS,
  EntitlementsService,
} from './entitlements.service';
import { UsageProvider } from './usage.provider';

const T0 = new Date('2026-10-07T00:00:00.000Z');

const entitlements = (over: Partial<Entitlements> = {}): Entitlements => ({
  seats: 3,
  conversationsPerPeriod: 100,
  conversationPeriod: 'total',
  knowledgeMb: 20,
  channels: ['chat'],
  voice: false,
  poweredByLabel: false,
  ...over,
});

const effective = (over: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-a',
  subscriptionId: 's1',
  planCode: 'starter',
  planName: 'Starter',
  status: 'active',
  interval: 'none',
  currentPeriodStart: T0,
  currentPeriodEnd: new Date('2026-10-22T00:00:00.000Z'),
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  daysLeft: 15,
  graceDaysLeft: null,
  provider: 'manual',
  entitlements: entitlements(),
  entitlementsOverride: null,
  nextTransitionAt: null,
  ...over,
});

describe('EntitlementsService', () => {
  let service: EntitlementsService;
  let subscriptions: {
    getEffective: jest.Mock;
    onChange: jest.Mock;
    lock: jest.Mock;
  };
  let usage: { getUsage: jest.Mock };
  let clock: FakeClock;
  let changeListener: (tenantId: string) => void;

  beforeEach(async () => {
    clock = new FakeClock(T0);
    subscriptions = {
      getEffective: jest.fn().mockResolvedValue(effective()),
      onChange: jest.fn((listener) => {
        changeListener = listener;
      }),
      lock: jest.fn().mockResolvedValue(true),
    };
    usage = { getUsage: jest.fn().mockResolvedValue(0) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntitlementsService,
        { provide: SubscriptionService, useValue: subscriptions },
        { provide: UsageProvider, useValue: usage },
        { provide: Clock, useValue: clock },
      ],
    }).compile();
    service = module.get(EntitlementsService);
  });

  describe('limits', () => {
    it('allows work under the limit and reports the limit and usage', async () => {
      usage.getUsage.mockResolvedValue(2);
      await expect(service.check('tenant-a', 'seats')).resolves.toEqual({
        allowed: true,
        planCode: 'starter',
        limit: 3,
        used: 2,
      });
    });

    it('denies at the limit with PLAN_LIMIT_REACHED', async () => {
      usage.getUsage.mockResolvedValue(3);
      await expect(service.check('tenant-a', 'seats')).resolves.toMatchObject({
        allowed: false,
        code: 'PLAN_LIMIT_REACHED',
        planCode: 'starter',
        limit: 3,
        used: 3,
      });
    });

    it('honours the requested amount (a 25 MB upload on a 20 MB plan)', async () => {
      await expect(
        service.check('tenant-a', 'knowledgeMb', 25),
      ).resolves.toMatchObject({ allowed: false, code: 'PLAN_LIMIT_REACHED' });
      usage.getUsage.mockResolvedValue(10);
      await expect(
        service.check('tenant-a', 'knowledgeMb', 10),
      ).resolves.toMatchObject({ allowed: true });
      await expect(
        service.check('tenant-a', 'knowledgeMb', 11),
      ).resolves.toMatchObject({ allowed: false });
    });

    it('null means unlimited', async () => {
      subscriptions.getEffective.mockResolvedValue(
        effective({ entitlements: entitlements({ seats: null }) }),
      );
      usage.getUsage.mockResolvedValue(9999);
      await expect(service.check('tenant-a', 'seats')).resolves.toMatchObject({
        allowed: true,
        limit: null,
      });
    });

    it('asks the usage provider with the period context of the plan', async () => {
      await service.check('tenant-a', 'conversations');
      expect(usage.getUsage).toHaveBeenCalledWith('tenant-a', 'conversations', {
        periodStart: T0,
        conversationPeriod: 'total',
      });
    });

    it('uses currentUsage when the caller already knows it, without asking the provider', async () => {
      await service.check('tenant-a', 'seats', 1, { currentUsage: 3 });
      expect(usage.getUsage).not.toHaveBeenCalled();
    });

    it('an unknown key is a programming error, not a quiet "allowed"', async () => {
      await expect(
        service.check('tenant-a', 'nonsense' as never),
      ).rejects.toThrow(/Unknown entitlement/);
    });
  });

  describe('features', () => {
    it('denies a channel the plan does not include with PLAN_FEATURE_UNAVAILABLE', async () => {
      await expect(
        service.check('tenant-a', 'channel:whatsapp'),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'PLAN_FEATURE_UNAVAILABLE',
      });
      await expect(
        service.check('tenant-a', 'channel:chat'),
      ).resolves.toMatchObject({ allowed: true });
    });

    it('voice follows the voice flag (key voice and channel:voice alike)', async () => {
      await expect(service.check('tenant-a', 'voice')).resolves.toMatchObject({
        allowed: false,
        code: 'PLAN_FEATURE_UNAVAILABLE',
      });
      subscriptions.getEffective.mockResolvedValue(
        effective({ entitlements: entitlements({ voice: true }) }),
      );
      service.invalidate('tenant-a');
      await expect(
        service.check('tenant-a', 'channel:voice'),
      ).resolves.toMatchObject({ allowed: true });
    });
  });

  describe('subscription states', () => {
    it.each([
      ['suspended', 'TENANT_SUSPENDED'],
      ['closed', 'TENANT_CLOSED'],
    ])('a %s tenant is denied everything with %s', async (status, code) => {
      subscriptions.getEffective.mockResolvedValue(effective({ status }));
      for (const key of ['seats', 'conversations', 'channel:chat'] as const) {
        await expect(service.check('tenant-a', key)).resolves.toMatchObject({
          allowed: false,
          code,
        });
      }
    });

    it('past_due keeps answering customers but cannot grow (SUBSCRIPTION_PAST_DUE)', async () => {
      subscriptions.getEffective.mockResolvedValue(
        effective({ status: 'past_due', planCode: 'pro', planName: 'Pro' }),
      );
      await expect(
        service.check('tenant-a', 'conversations'),
      ).resolves.toMatchObject({ allowed: true });
      for (const key of [
        'seats',
        'knowledgeMb',
        'channel:chat',
        'voice',
      ] as const) {
        await expect(service.check('tenant-a', key)).resolves.toMatchObject({
          allowed: false,
          code: 'SUBSCRIPTION_PAST_DUE',
        });
      }
    });

    it('a canceled plan keeps working until it ends', async () => {
      subscriptions.getEffective.mockResolvedValue(
        effective({ status: 'canceled' }),
      );
      await expect(service.check('tenant-a', 'seats')).resolves.toMatchObject({
        allowed: true,
      });
    });

    it('no subscription at all: NO_ACTIVE_SUBSCRIPTION', async () => {
      subscriptions.getEffective.mockResolvedValue(null);
      await expect(service.check('tenant-a', 'seats')).resolves.toMatchObject({
        allowed: false,
        code: 'NO_ACTIVE_SUBSCRIPTION',
        planCode: null,
      });
    });
  });

  describe('assert', () => {
    it('throws a 403 ApiException carrying the denial code', async () => {
      usage.getUsage.mockResolvedValue(3);
      await expect(service.assert('tenant-a', 'seats')).rejects.toMatchObject({
        status: 403,
        response: { code: 'PLAN_LIMIT_REACHED' },
      });
      usage.getUsage.mockResolvedValue(0);
      await expect(
        service.assert('tenant-a', 'seats'),
      ).resolves.toBeUndefined();
    });
  });

  describe('cache', () => {
    it('reads the subscription once within the TTL', async () => {
      await service.check('tenant-a', 'seats');
      await service.check('tenant-a', 'seats');
      await service.check('tenant-a', 'channel:chat');
      expect(subscriptions.getEffective).toHaveBeenCalledTimes(1);
    });

    it('is per tenant', async () => {
      await service.check('tenant-a', 'seats');
      await service.check('tenant-b', 'seats');
      expect(subscriptions.getEffective).toHaveBeenCalledWith('tenant-a');
      expect(subscriptions.getEffective).toHaveBeenCalledWith('tenant-b');
    });

    it('expires after the TTL', async () => {
      await service.check('tenant-a', 'seats');
      clock.advanceMs(ENTITLEMENTS_CACHE_TTL_MS + 1);
      await service.check('tenant-a', 'seats');
      expect(subscriptions.getEffective).toHaveBeenCalledTimes(2);
    });

    it('never outlives the next time-based transition', async () => {
      subscriptions.getEffective.mockResolvedValue(
        effective({ nextTransitionAt: new Date(T0.getTime() + 5_000) }),
      );
      await service.check('tenant-a', 'seats');
      clock.advanceMs(5_000);
      await service.check('tenant-a', 'seats');
      expect(subscriptions.getEffective).toHaveBeenCalledTimes(2);
    });

    it('is dropped when a subscription changes (a plan upgrade is visible at once)', async () => {
      usage.getUsage.mockResolvedValue(3);
      await expect(service.check('tenant-a', 'seats')).resolves.toMatchObject({
        allowed: false,
      });
      subscriptions.getEffective.mockResolvedValue(
        effective({ entitlements: entitlements({ seats: 10 }) }),
      );
      changeListener('tenant-a');
      await expect(service.check('tenant-a', 'seats')).resolves.toMatchObject({
        allowed: true,
        limit: 10,
      });
    });

    it('a change for one tenant leaves the others cached', async () => {
      await service.check('tenant-a', 'seats');
      await service.check('tenant-b', 'seats');
      changeListener('tenant-a');
      await service.check('tenant-b', 'seats');
      expect(subscriptions.getEffective).toHaveBeenCalledTimes(2);
    });

    it('fresh bypasses the cache', async () => {
      await service.check('tenant-a', 'seats');
      await service.check('tenant-a', 'seats', 1, { fresh: true });
      expect(subscriptions.getEffective).toHaveBeenCalledTimes(2);
    });
  });

  describe('assertSeatAvailable (seat limit for invites, acceptance, reactivation)', () => {
    const tx = {
      tenantUser: { count: jest.fn() },
      staffInvite: { count: jest.fn() },
    };

    beforeEach(() => {
      tx.tenantUser.count.mockReset().mockResolvedValue(1);
      tx.staffInvite.count.mockReset().mockResolvedValue(1);
    });

    it('invite: counts active users plus other pending invites, scoped to the tenant', async () => {
      await service.assertSeatAvailable(
        tx as never,
        'tenant-a',
        'invite',
        'x@acme.com',
      );
      expect(subscriptions.lock).toHaveBeenCalledWith(tx, 'tenant-a');
      expect(tx.tenantUser.count).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a', status: 'active' },
      });
      expect(tx.staffInvite.count).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-a',
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: T0 },
          email: { not: 'x@acme.com' },
        },
      });
    });

    it('invite: refuses with PLAN_LIMIT_REACHED when users + invites fill the plan', async () => {
      tx.tenantUser.count.mockResolvedValue(2);
      tx.staffInvite.count.mockResolvedValue(1); // 3 of 3
      await expect(
        service.assertSeatAvailable(tx as never, 'tenant-a', 'invite'),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'PLAN_LIMIT_REACHED' },
      });
    });

    it('invite: allows the last free seat', async () => {
      tx.tenantUser.count.mockResolvedValue(1);
      tx.staffInvite.count.mockResolvedValue(1); // 2 of 3
      await expect(
        service.assertSeatAvailable(tx as never, 'tenant-a', 'invite'),
      ).resolves.toBeUndefined();
    });

    it('accept: the invite already holds its seat, so only active users count', async () => {
      tx.tenantUser.count.mockResolvedValue(2);
      tx.staffInvite.count.mockResolvedValue(5);
      await expect(
        service.assertSeatAvailable(tx as never, 'tenant-a', 'accept'),
      ).resolves.toBeUndefined();
      expect(tx.staffInvite.count).not.toHaveBeenCalled();
    });

    it('accept: refused when a downgrade left no seat (users already at the limit)', async () => {
      tx.tenantUser.count.mockResolvedValue(3);
      await expect(
        service.assertSeatAvailable(tx as never, 'tenant-a', 'accept'),
      ).rejects.toMatchObject({ response: { code: 'PLAN_LIMIT_REACHED' } });
    });

    it('reactivate: counts users and pending invites', async () => {
      tx.tenantUser.count.mockResolvedValue(2);
      tx.staffInvite.count.mockResolvedValue(1);
      await expect(
        service.assertSeatAvailable(tx as never, 'tenant-a', 'reactivate'),
      ).rejects.toMatchObject({ response: { code: 'PLAN_LIMIT_REACHED' } });
    });

    it('reads the subscription BEFORE taking the row lock (a due transition needs that lock itself)', async () => {
      const order: string[] = [];
      subscriptions.getEffective.mockImplementation(() => {
        order.push('read');
        return Promise.resolve(effective());
      });
      subscriptions.lock.mockImplementation(() => {
        order.push('lock');
        return Promise.resolve(true);
      });
      await service.assertSeatAvailable(tx as never, 'tenant-a', 'invite');
      expect(order).toEqual(['read', 'lock']);
    });

    it('never trusts a stale cache: it re-reads the plan every time', async () => {
      await service.assertSeatAvailable(tx as never, 'tenant-a', 'invite');
      await service.assertSeatAvailable(tx as never, 'tenant-a', 'invite');
      expect(subscriptions.getEffective).toHaveBeenCalledTimes(2);
    });

    it('a suspended tenant cannot add seats (TENANT_SUSPENDED)', async () => {
      subscriptions.getEffective.mockResolvedValue(
        effective({ status: 'suspended' }),
      );
      await expect(
        service.assertSeatAvailable(tx as never, 'tenant-a', 'invite'),
      ).rejects.toMatchObject({ response: { code: 'TENANT_SUSPENDED' } });
    });
  });
});
