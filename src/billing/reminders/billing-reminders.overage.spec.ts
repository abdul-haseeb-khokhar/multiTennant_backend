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

/** The 100% reminder when the AI keeps answering (overage on) and when it stops (J6). */
describe('BillingRemindersService usage reminders with overage (J6)', () => {
  let prisma: PrismaMock;
  let notifications: {
    activeStaffIds: jest.Mock;
    create: jest.Mock;
    announce: jest.Mock;
  };
  let entitlements: { forTenant: jest.Mock; check: jest.Mock };
  let service: BillingRemindersService;
  let stored: Stored[];

  const pro = (over: Record<string, unknown> = {}) => ({
    currentPeriodStart: new Date('2026-10-01T00:00:00.000Z'),
    status: 'active',
    currency: 'PKR',
    overageEnabled: true,
    entitlements: {
      conversationPeriod: 'month',
      overageConversationMinor: 1500,
    },
    ...over,
  });

  const usage = (used: number, limit: number, subscription = pro()) => {
    prisma.usageDaily.findMany.mockResolvedValue([{ tenantId: 'tenant-a' }]);
    entitlements.forTenant.mockResolvedValue(subscription);
    // Only the conversation allowance is under test here: call minutes are unlimited.
    entitlements.check.mockImplementation(async (_tenant, key) =>
      key === 'callMinutes'
        ? { allowed: true, planCode: 'pro', limit: null, used: null }
        : { allowed: true, planCode: 'pro', limit, used },
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

  it('overage on: 100% is "overage started" and carries the price, the AI is not said to stop', async () => {
    usage(1500, 1500);
    await service.generate();
    expect(ownerRows()).toHaveLength(1);
    expect(ownerRows()[0]).toMatchObject({
      type: 'usage.overage_started',
      dedupeKey: 'usage.overage_started:conversations:2026-10',
      params: {
        metric: 'conversations',
        percent: 100,
        used: 1500,
        limit: 1500,
        period: 'month',
        priceMinor: 1500,
        price: 15,
        currency: 'PKR',
      },
    });
  });

  it('overage off: 100% stays "AI stopped, limit reached" with the old params', async () => {
    usage(1500, 1500, pro({ overageEnabled: false }));
    await service.generate();
    expect(ownerRows()[0]).toMatchObject({
      type: 'usage.limit_reached',
      dedupeKey: 'usage.limit_reached:conversations:2026-10',
    });
    expect(ownerRows()[0].params).not.toHaveProperty('priceMinor');
  });

  it('a plan without an overage price always says "limit reached", whatever is stored', async () => {
    usage(
      30,
      30,
      pro({
        overageEnabled: true,
        entitlements: { conversationPeriod: 'month' },
      }),
    );
    await service.generate();
    expect(ownerRows()[0].type).toBe('usage.limit_reached');
  });

  it('a tenant whose payment is overdue gets "limit reached": overage does not apply to it', async () => {
    usage(1500, 1500, pro({ status: 'past_due' }));
    await service.generate();
    expect(ownerRows()[0].type).toBe('usage.limit_reached');
  });

  it('the 80% reminder is the same with either setting', async () => {
    usage(1200, 1500);
    await service.generate();
    usage(1200, 1500, pro({ overageEnabled: false }));
    await service.generate();
    expect(ownerRows()).toHaveLength(1);
    expect(ownerRows()[0]).toMatchObject({
      type: 'usage.threshold',
      dedupeKey: 'usage.threshold:conversations:2026-10',
    });
  });

  describe('switching the setting does not repeat reminders and shows the one that now applies', () => {
    it('on, then off: each message is sent once; running again changes nothing', async () => {
      usage(1500, 1500);
      await service.generate();
      usage(1520, 1500, pro({ overageEnabled: false }));
      await service.generate();
      await service.generate();
      expect(ownerRows().map((s) => s.type)).toEqual([
        'usage.overage_started',
        'usage.limit_reached',
      ]);
    });

    it('on, off, on again: nothing already sent is sent again', async () => {
      usage(1500, 1500);
      await service.generate();
      usage(1510, 1500, pro({ overageEnabled: false }));
      await service.generate();
      usage(1520, 1500);
      await service.generate();
      expect(ownerRows().map((s) => s.type)).toEqual([
        'usage.overage_started',
        'usage.limit_reached',
      ]);
    });

    it('a new month starts over for both', async () => {
      usage(1500, 1500);
      await service.generate();
      const november = new BillingRemindersService(
        prisma as never,
        notifications as never,
        entitlements as never,
        new FakeClock(new Date('2026-11-05T08:00:00.000Z')),
      );
      usage(1500, 1500);
      await november.generate();
      expect(ownerRows().map((s) => s.dedupeKey)).toEqual([
        'usage.overage_started:conversations:2026-10',
        'usage.overage_started:conversations:2026-11',
      ]);
    });
  });
});
