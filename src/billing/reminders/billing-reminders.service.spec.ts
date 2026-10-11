import { createPrismaMock, PrismaMock } from '../../../test/utils/prisma-mock';
import { FakeClock } from '../clock';
import { BillingRemindersService } from './billing-reminders.service';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const starter = {
  code: 'starter',
  name: 'Starter',
  priceMinor: 0,
  durationDays: 15,
};
const pro = {
  code: 'pro',
  name: 'Pro',
  priceMinor: 1_999_900,
  durationDays: null,
};

const subscription = (over: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-a',
  status: 'active',
  cancelAtPeriodEnd: false,
  currentPeriodEnd: days(5),
  plan: pro,
  ...over,
});

describe('BillingRemindersService', () => {
  let prisma: PrismaMock;
  let notifications: {
    activeStaffIds: jest.Mock;
    create: jest.Mock;
    announce: jest.Mock;
  };
  let entitlements: { forTenant: jest.Mock; check: jest.Mock };
  let service: BillingRemindersService;
  /** One row per (recipient, dedupeKey), like the table's unique index. */
  let stored: {
    userId: string;
    type: string;
    params: any;
    dedupeKey: string;
  }[];

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.subscription.findMany.mockResolvedValue([]);
    prisma.billingEvent.findMany.mockResolvedValue([]);
    prisma.plan.findMany.mockResolvedValue([
      { code: 'starter', name: 'Starter' },
      { code: 'free', name: 'Free' },
      { code: 'pro', name: 'Pro' },
    ]);
    prisma.usageDaily.findMany.mockResolvedValue([]);
    stored = [];
    notifications = {
      activeStaffIds: jest.fn().mockResolvedValue(['owner-1', 'admin-1']),
      create: jest.fn(
        async (_tenant: string, recipients: string[], input: any) => {
          const created = recipients
            .filter(
              (u) =>
                !stored.some(
                  (s) => s.userId === u && s.dedupeKey === input.dedupeKey,
                ),
            )
            .map((userId) => ({
              id: `n-${stored.length + 1}`,
              userId,
              type: input.type,
            }));
          for (const row of created) {
            stored.push({
              userId: row.userId,
              type: input.type,
              params: input.params,
              dedupeKey: input.dedupeKey,
            });
          }
          return created;
        },
      ),
      announce: jest.fn(),
    };
    entitlements = { forTenant: jest.fn(), check: jest.fn() };
    service = new BillingRemindersService(
      prisma as never,
      notifications as never,
      entitlements as never,
      new FakeClock(NOW),
    );
  });

  it('only ever notifies owners and admins', async () => {
    prisma.subscription.findMany.mockResolvedValue([subscription()]);
    await service.generate();
    expect(notifications.activeStaffIds).toHaveBeenCalledWith('tenant-a', [
      'owner',
      'admin',
    ]);
  });

  describe('the trial or a paid period is about to end (7, 3 and 1 days)', () => {
    it('only looks at subscriptions that end within 7 days and are still running', async () => {
      await service.generate();
      expect(prisma.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: { in: ['active', 'canceled'] },
            currentPeriodEnd: { gt: NOW, lte: days(7) },
          },
        }),
      );
    });

    it.each([
      [7, 7],
      [6, 7],
      [4, 7],
      [3, 3],
      [2, 3],
      [1, 1],
    ])(
      '%s days left gives the %s-day reminder',
      async (daysLeft, threshold) => {
        prisma.subscription.findMany.mockResolvedValue([
          subscription({ currentPeriodEnd: days(daysLeft) }),
        ]);
        await service.generate();
        expect(stored[0]).toMatchObject({
          type: 'billing.period_ending',
          params: {
            daysLeft,
            threshold,
            plan: 'Pro',
            cancelAtPeriodEnd: false,
          },
        });
      },
    );

    it('under a day left counts as 1 day', async () => {
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          currentPeriodEnd: new Date(NOW.getTime() + 3 * 3600_000),
        }),
      ]);
      await service.generate();
      expect(stored[0].params).toMatchObject({ daysLeft: 1, threshold: 1 });
    });

    it('the Starter trial gets its own type and no plan name', async () => {
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ plan: starter, currentPeriodEnd: days(3) }),
      ]);
      await service.generate();
      expect(stored[0]).toMatchObject({ type: 'billing.trial_ending' });
      expect(stored[0].params).toEqual({
        daysLeft: 3,
        endsAt: days(3).toISOString(),
        threshold: 3,
      });
    });

    it('a cancelled plan says it will not renew', async () => {
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          status: 'canceled',
          cancelAtPeriodEnd: true,
          currentPeriodEnd: days(2),
        }),
      ]);
      await service.generate();
      expect(stored[0].params).toMatchObject({ cancelAtPeriodEnd: true });
    });

    it('is idempotent: a second sweep, even from another instance, creates nothing', async () => {
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ currentPeriodEnd: days(3) }),
      ]);
      await expect(service.generate()).resolves.toEqual({ created: 2 });
      await expect(service.generate()).resolves.toEqual({ created: 0 });
      expect(stored).toHaveLength(2);
      expect(notifications.announce).toHaveBeenCalledTimes(2);
    });

    it('names the threshold and the period in the dedupe key, so the next period reminds again', async () => {
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ currentPeriodEnd: days(3) }),
      ]);
      await service.generate();
      expect(stored[0].dedupeKey).toBe('billing.period_ending:3:2026-10-13');
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ currentPeriodEnd: days(2) }),
      ]);
      // the same threshold (3) for the same period is the same key; a later period is a new one
      await service.generate();
      expect(
        stored.filter((s) => s.dedupeKey.endsWith('2026-10-12')),
      ).toHaveLength(2);
    });

    it('with a fixed end date the three thresholds give exactly three reminders per recipient', async () => {
      const end = days(7);
      const clock = new FakeClock(NOW);
      service = new BillingRemindersService(
        prisma as never,
        notifications as never,
        entitlements as never,
        clock,
      );
      for (const elapsed of [0, 1, 2, 3, 4, 5, 6]) {
        clock.set(new Date(NOW.getTime() + elapsed * 86_400_000));
        prisma.subscription.findMany.mockResolvedValue([
          subscription({ currentPeriodEnd: end }),
        ]);
        await service.generate();
      }
      const perRecipient = stored
        .filter((s) => s.userId === 'owner-1')
        .map((s) => s.params.threshold);
      expect(perRecipient).toEqual([7, 3, 1]);
    });

    it('skips a subscription without an end', async () => {
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ currentPeriodEnd: null }),
      ]);
      await expect(service.generate()).resolves.toEqual({ created: 0 });
    });
  });

  describe('grace started and downgraded (read from the billing events)', () => {
    const event = (
      id: string,
      payload: Record<string, unknown>,
      createdAt = NOW,
    ) => ({
      id,
      tenantId: 'tenant-a',
      type: 'period.ended',
      payload,
      createdAt,
    });

    it('looks back seven days at period.ended events only', async () => {
      await service.generate();
      expect(prisma.billingEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { type: 'period.ended', createdAt: { gte: days(-7) } },
        }),
      );
    });

    it('a paid period that ended unpaid starts the grace period: one notification with the dates', async () => {
      prisma.billingEvent.findMany.mockResolvedValue([
        event('ev1', {
          reason: 'period_ended_unpaid',
          planCode: 'pro',
          graceEndsAt: days(7).toISOString(),
        }),
      ]);
      await service.generate();
      expect(stored[0]).toMatchObject({
        type: 'billing.grace_started',
        dedupeKey: 'billing.grace_started:ev1',
        params: {
          plan: 'Pro',
          graceEndsAt: days(7).toISOString(),
          graceDaysLeft: 7,
        },
      });
    });

    it.each(['trial_ended', 'grace_expired', 'canceled', 'plan_ended'])(
      'a move to a lower plan (%s) tells owners and admins once',
      async (reason) => {
        prisma.billingEvent.findMany.mockResolvedValue([
          event('ev2', { reason, fromPlanCode: 'starter', toPlanCode: 'free' }),
        ]);
        await service.generate();
        await service.generate();
        expect(stored).toHaveLength(2);
        expect(stored[0]).toMatchObject({
          type: 'billing.downgraded',
          dedupeKey: 'billing.downgraded:ev2',
          params: { fromPlan: 'Starter', toPlan: 'Free', reason },
        });
      },
    );

    it('ignores period.ended events that are neither', async () => {
      prisma.billingEvent.findMany.mockResolvedValue([
        event('ev3', { reason: 'something_else' }),
      ]);
      await expect(service.generate()).resolves.toEqual({ created: 0 });
    });

    it('survives a payload that is not an object', async () => {
      prisma.billingEvent.findMany.mockResolvedValue([
        { ...event('ev4', {}), payload: 'junk' },
      ]);
      await expect(service.generate()).resolves.toEqual({ created: 0 });
    });
  });

  describe('80% and 100% of the included conversations', () => {
    const checkAt = (used: number, limit: number | null) => {
      prisma.usageDaily.findMany.mockResolvedValue([{ tenantId: 'tenant-a' }]);
      entitlements.forTenant.mockResolvedValue({
        currentPeriodStart: new Date('2026-10-01T00:00:00.000Z'),
        entitlements: { conversationPeriod: 'month' },
      });
      entitlements.check.mockResolvedValue({
        allowed: true,
        planCode: 'pro',
        limit,
        used,
      });
    };

    it('re-checks only tenants whose usage changed in the last hours, with a fresh read and no extra conversation', async () => {
      checkAt(10, 100);
      await service.generate();
      expect(prisma.usageDaily.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { updatedAt: { gte: new Date(NOW.getTime() - 3 * 3600_000) } },
          distinct: ['tenantId'],
        }),
      );
      expect(entitlements.check).toHaveBeenCalledWith(
        'tenant-a',
        'conversations',
        0,
        { fresh: true },
      );
    });

    it.each([
      [79, 100, null],
      [80, 100, 80],
      [99, 100, 80],
      [100, 100, 100],
      [250, 100, 100],
      [16, 20, 80],
      [4, 5, 80],
      [3, 5, null],
    ])('%s of %s used gives threshold %s', async (used, limit, threshold) => {
      checkAt(used, limit);
      await service.generate();
      if (threshold === null) {
        expect(stored).toEqual([]);
      } else {
        expect(stored[0]).toMatchObject({
          type: threshold === 100 ? 'usage.limit_reached' : 'usage.threshold',
          params: {
            metric: 'conversations',
            percent: threshold,
            used,
            limit,
            period: 'month',
          },
        });
      }
    });

    it('is idempotent per period: the same month never repeats, a new month does', async () => {
      checkAt(85, 100);
      await service.generate();
      await service.generate();
      expect(stored.filter((s) => s.userId === 'owner-1')).toHaveLength(1);
      expect(stored[0].dedupeKey).toBe('usage.threshold:conversations:2026-10');
      const clock = new FakeClock(new Date('2026-11-02T08:00:00.000Z'));
      service = new BillingRemindersService(
        prisma as never,
        notifications as never,
        entitlements as never,
        clock,
      );
      await service.generate();
      expect(stored.filter((s) => s.userId === 'owner-1')).toHaveLength(2);
    });

    it('an allowance that counts "in total" is keyed by the period start', async () => {
      checkAt(100, 100);
      entitlements.forTenant.mockResolvedValue({
        currentPeriodStart: new Date('2026-10-01T00:00:00.000Z'),
        entitlements: { conversationPeriod: 'total' },
      });
      await service.generate();
      expect(stored[0].dedupeKey).toBe(
        'usage.limit_reached:conversations:since-2026-10-01',
      );
      expect(stored[0].params.period).toBe('total');
    });

    it.each([null, 0])(
      'an unlimited plan (limit %s) is skipped',
      async (limit) => {
        checkAt(500, limit);
        await expect(service.generate()).resolves.toEqual({ created: 0 });
      },
    );

    it('a tenant without a subscription is skipped', async () => {
      prisma.usageDaily.findMany.mockResolvedValue([{ tenantId: 'tenant-a' }]);
      entitlements.forTenant.mockResolvedValue(null);
      entitlements.check.mockResolvedValue({
        allowed: false,
        limit: null,
        used: null,
      });
      await expect(service.generate()).resolves.toEqual({ created: 0 });
    });
  });

  it('tells the live streams about every notification it created, and logs nothing personal', async () => {
    prisma.subscription.findMany.mockResolvedValue([
      subscription({ currentPeriodEnd: days(1) }),
    ]);
    const log = jest
      .spyOn(service['logger'], 'log')
      .mockImplementation(() => undefined);
    await service.generate();
    expect(notifications.announce).toHaveBeenCalledWith(
      'tenant-a',
      expect.any(Array),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('owner-1');
  });
});
