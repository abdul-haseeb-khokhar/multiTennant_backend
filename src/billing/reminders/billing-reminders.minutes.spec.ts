import { createPrismaMock, PrismaMock } from '../../../test/utils/prisma-mock';
import { FakeClock } from '../clock';
import { BillingRemindersService } from './billing-reminders.service';

const NOW = new Date('2026-10-10T08:00:00.000Z');

interface Stored {
  userId: string;
  type: string;
  params: any;
  dedupeKey: string;
}

/** The 80% and 100% reminders for the call-minute allowance (L6), next to the conversation ones. */
describe('BillingRemindersService call-minute reminders (L6)', () => {
  let prisma: PrismaMock;
  let notifications: {
    activeStaffIds: jest.Mock;
    create: jest.Mock;
    announce: jest.Mock;
  };
  let entitlements: { forTenant: jest.Mock; check: jest.Mock };
  let service: BillingRemindersService;
  let stored: Stored[];

  const pro = (over: Record<string, unknown> = {}, limits = {}) => ({
    currentPeriodStart: new Date('2026-10-01T00:00:00.000Z'),
    status: 'active',
    currency: 'PKR',
    overageEnabled: true,
    entitlements: {
      conversationPeriod: 'month',
      callMinutePeriod: 'month',
      overageMinuteMinor: 2500,
      ...limits,
    },
    ...over,
  });

  /** Call minutes at `used` of `limit`; chat conversations are unlimited so only minutes warn. */
  const minutes = (
    used: number,
    limit: number | null,
    subscription = pro(),
  ) => {
    prisma.usageDaily.findMany.mockResolvedValue([{ tenantId: 'tenant-a' }]);
    entitlements.forTenant.mockResolvedValue(subscription);
    entitlements.check.mockImplementation(async (_tenant, key) =>
      key === 'callMinutes'
        ? { allowed: true, planCode: 'pro', limit, used }
        : { allowed: true, planCode: 'pro', limit: null, used: null },
    );
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.subscription.findMany.mockResolvedValue([]);
    prisma.billingEvent.findMany.mockResolvedValue([]);
    prisma.plan.findMany.mockResolvedValue([]);
    stored = [];
    notifications = {
      activeStaffIds: jest.fn().mockResolvedValue(['owner-1', 'admin-1']),
      create: jest.fn(
        async (_tenant: string, recipients: string[], input: any) => {
          const created = recipients.filter(
            (u) =>
              !stored.some(
                (s) => s.userId === u && s.dedupeKey === input.dedupeKey,
              ),
          );
          for (const userId of created) {
            stored.push({
              userId,
              type: input.type,
              params: input.params,
              dedupeKey: input.dedupeKey,
            });
          }
          return created.map((userId) => ({ userId }));
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

  const ownerRows = () => stored.filter((s) => s.userId === 'owner-1');

  it('asks for the call minutes with a fresh read and no extra minute, next to the conversations', async () => {
    minutes(10, 300);
    await service.generate();
    expect(entitlements.check).toHaveBeenCalledWith(
      'tenant-a',
      'callMinutes',
      0,
      { fresh: true },
    );
    expect(entitlements.check).toHaveBeenCalledWith(
      'tenant-a',
      'conversations',
      0,
      { fresh: true },
    );
  });

  it.each([
    [239, 300, null],
    [240, 300, 80],
    [299, 300, 80],
    [16, 20, 80],
    [15, 20, null],
    [24, 30, 80],
  ])(
    '%s of %s minutes used gives threshold %s',
    async (used, limit, expected) => {
      minutes(used, limit);
      await service.generate();
      if (expected === null) {
        expect(stored).toEqual([]);
      } else {
        expect(stored[0]).toMatchObject({
          type: 'usage.minutes_threshold',
          params: {
            metric: 'callMinutes',
            percent: 80,
            used,
            limit,
            period: 'month',
          },
          dedupeKey: 'usage.minutes_threshold:callMinutes:2026-10',
        });
      }
    },
  );

  it('overage on and a minute price: 100% is "overage started" with the price per minute; calls are not said to stop', async () => {
    minutes(300, 300);
    await service.generate();
    expect(ownerRows()).toHaveLength(1);
    expect(ownerRows()[0]).toMatchObject({
      type: 'usage.minutes_overage_started',
      params: {
        metric: 'callMinutes',
        percent: 100,
        used: 300,
        limit: 300,
        period: 'month',
        priceMinor: 2500,
        price: 25,
        currency: 'PKR',
      },
      dedupeKey: 'usage.minutes_overage_started:callMinutes:2026-10',
    });
    expect(stored.map((s) => s.type)).not.toContain(
      'usage.minutes_limit_reached',
    );
  });

  it('overage switched off: 100% is "limit reached" (calls stop), without a price in the params', async () => {
    minutes(300, 300, pro({ overageEnabled: false }));
    await service.generate();
    expect(ownerRows()[0].type).toBe('usage.minutes_limit_reached');
    expect(ownerRows()[0].params).not.toHaveProperty('priceMinor');
    expect(ownerRows()[0].params).toMatchObject({
      metric: 'callMinutes',
      percent: 100,
    });
  });

  it('a plan with no minute price (Free, Starter): 100% is always "limit reached", whatever is stored', async () => {
    minutes(20, 20, pro({}, { overageMinuteMinor: undefined }));
    await service.generate();
    expect(ownerRows()[0].type).toBe('usage.minutes_limit_reached');
  });

  it('a plan that prices only conversations does not promise to bill minutes', async () => {
    minutes(
      300,
      300,
      pro(
        {},
        { overageMinuteMinor: undefined, overageConversationMinor: 1500 },
      ),
    );
    await service.generate();
    expect(ownerRows()[0].type).toBe('usage.minutes_limit_reached');
  });

  it('past_due: no overage is running up, so 100% is "limit reached"', async () => {
    minutes(300, 300, pro({ status: 'past_due' }));
    await service.generate();
    expect(ownerRows()[0].type).toBe('usage.minutes_limit_reached');
  });

  it('is idempotent: sweeping again, or from another instance, creates nothing new', async () => {
    minutes(300, 300);
    await service.generate();
    await service.generate();
    await service.generate();
    expect(ownerRows()).toHaveLength(1);
  });

  it('a new month starts over, and the 80% and 100% reminders of one month are separate rows', async () => {
    minutes(250, 300);
    await service.generate();
    minutes(300, 300);
    await service.generate();
    expect(ownerRows().map((s) => s.type)).toEqual([
      'usage.minutes_threshold',
      'usage.minutes_overage_started',
    ]);
    const november = new BillingRemindersService(
      prisma as never,
      notifications as never,
      entitlements as never,
      new FakeClock(new Date('2026-11-02T08:00:00.000Z')),
    );
    await november.generate();
    expect(ownerRows()).toHaveLength(3);
    expect(ownerRows()[2].dedupeKey).toBe(
      'usage.minutes_overage_started:callMinutes:2026-11',
    );
  });

  it('switching the setting sends the message that now applies once, never both for one state, and repeats nothing', async () => {
    minutes(300, 300);
    await service.generate(); // overage on: started
    minutes(300, 300, pro({ overageEnabled: false }));
    await service.generate(); // off: limit reached
    await service.generate();
    minutes(300, 300);
    await service.generate(); // on again: started was already sent
    expect(ownerRows().map((s) => s.type)).toEqual([
      'usage.minutes_overage_started',
      'usage.minutes_limit_reached',
    ]);
    expect(new Set(ownerRows().map((s) => s.dedupeKey)).size).toBe(2);
  });

  it('an allowance that counts "in total" (Starter) is keyed by the period start', async () => {
    minutes(
      30,
      30,
      pro({}, { callMinutePeriod: 'total', overageMinuteMinor: undefined }),
    );
    await service.generate();
    expect(ownerRows()[0]).toMatchObject({
      type: 'usage.minutes_limit_reached',
      dedupeKey: 'usage.minutes_limit_reached:callMinutes:since-2026-10-01',
    });
    expect(ownerRows()[0].params.period).toBe('total');
  });

  it.each([null, 0])(
    'an unlimited allowance (limit %s) is skipped',
    async (limit) => {
      minutes(5000, limit);
      await expect(service.generate()).resolves.toEqual({ created: 0 });
    },
  );

  it('a suspended tenant (the check answers without a limit) gets nothing', async () => {
    prisma.usageDaily.findMany.mockResolvedValue([{ tenantId: 'tenant-a' }]);
    entitlements.forTenant.mockResolvedValue(pro({ status: 'suspended' }));
    entitlements.check.mockResolvedValue({
      allowed: false,
      code: 'TENANT_SUSPENDED',
      limit: null,
      used: null,
    });
    await expect(service.generate()).resolves.toEqual({ created: 0 });
  });

  it('minutes and conversations warn independently, each with its own key', async () => {
    prisma.usageDaily.findMany.mockResolvedValue([{ tenantId: 'tenant-a' }]);
    entitlements.forTenant.mockResolvedValue(
      pro({}, { overageConversationMinor: 1500 }),
    );
    entitlements.check.mockImplementation(async (_tenant, key) => ({
      allowed: true,
      planCode: 'pro',
      limit: key === 'callMinutes' ? 300 : 1500,
      used: key === 'callMinutes' ? 300 : 1500,
    }));
    await service.generate();
    expect(
      ownerRows()
        .map((s) => s.type)
        .sort(),
    ).toEqual(['usage.minutes_overage_started', 'usage.overage_started']);
    expect(
      ownerRows().find((s) => s.type === 'usage.overage_started')?.params,
    ).toMatchObject({ metric: 'conversations', priceMinor: 1500 });
  });

  it('only owners and admins are told, and the live streams hear about it', async () => {
    minutes(300, 300);
    await service.generate();
    expect(notifications.activeStaffIds).toHaveBeenCalledWith('tenant-a', [
      'owner',
      'admin',
    ]);
    expect(notifications.announce).toHaveBeenCalled();
  });
});
