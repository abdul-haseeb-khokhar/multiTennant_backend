import { Test } from '@nestjs/testing';
import { Clock, FakeClock } from '../clock';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { Entitlements } from './entitlements';
import { EntitlementsService } from './entitlements.service';
import { UsageProvider } from './usage.provider';

const T0 = new Date('2026-10-07T00:00:00.000Z');

const PLANS: Record<string, Partial<Entitlements>> = {
  starter: { conversationsPerPeriod: 100, conversationPeriod: 'total' },
  free: { conversationsPerPeriod: 30, conversationPeriod: 'month' },
  pro: {
    conversationsPerPeriod: 1500,
    conversationPeriod: 'month',
    overageConversationMinor: 1500,
  },
  enterprise: { conversationsPerPeriod: null, conversationPeriod: 'month' },
};

const subscription = (
  planCode: string,
  over: Record<string, unknown> = {},
  limits: Partial<Entitlements> = {},
) => ({
  tenantId: 'tenant-a',
  subscriptionId: 's1',
  planCode,
  planName: planCode,
  status: 'active',
  interval: 'month',
  currentPeriodStart: T0,
  currentPeriodEnd: new Date('2026-11-07T00:00:00.000Z'),
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  daysLeft: 31,
  graceDaysLeft: null,
  provider: 'manual',
  currency: 'PKR',
  overageEnabled: true,
  entitlements: {
    seats: 10,
    knowledgeMb: 500,
    channels: ['chat'],
    voice: false,
    poweredByLabel: false,
    ...PLANS[planCode],
    ...limits,
  },
  entitlementsOverride: null,
  nextTransitionAt: null,
  ...over,
});

describe('EntitlementsService conversations with overage (J6)', () => {
  let service: EntitlementsService;
  let subscriptions: { getEffective: jest.Mock; onChange: jest.Mock };
  let usage: { getUsage: jest.Mock };

  beforeEach(async () => {
    subscriptions = {
      getEffective: jest.fn(),
      onChange: jest.fn(),
    };
    usage = { getUsage: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        EntitlementsService,
        { provide: SubscriptionService, useValue: subscriptions },
        { provide: UsageProvider, useValue: usage },
        { provide: Clock, useValue: new FakeClock(T0) },
      ],
    }).compile();
    service = module.get(EntitlementsService);
  });

  const check = async (sub: ReturnType<typeof subscription>, used: number) => {
    subscriptions.getEffective.mockResolvedValue(sub);
    usage.getUsage.mockResolvedValue(used);
    return service.check('tenant-a', 'conversations', 1, { fresh: true });
  };

  // plan x setting x used (inside the allowance, exactly at it, past it)
  describe.each([
    ['pro', true, 1499, { allowed: true }],
    ['pro', true, 1500, { allowed: true, overage: true }],
    ['pro', true, 2400, { allowed: true, overage: true }],
    ['pro', false, 1499, { allowed: true }],
    ['pro', false, 1500, { allowed: false, code: 'PLAN_LIMIT_REACHED' }],
    ['pro', false, 2400, { allowed: false, code: 'PLAN_LIMIT_REACHED' }],
    // no overage price: the stored choice is irrelevant, they always stop hard
    ['free', true, 30, { allowed: false, code: 'PLAN_LIMIT_REACHED' }],
    ['free', false, 30, { allowed: false, code: 'PLAN_LIMIT_REACHED' }],
    ['starter', true, 100, { allowed: false, code: 'PLAN_LIMIT_REACHED' }],
    ['starter', false, 250, { allowed: false, code: 'PLAN_LIMIT_REACHED' }],
  ] as const)('%s, overage %s, used %i', (plan, enabled, used, expected) => {
    it(`answers ${JSON.stringify(expected)}`, async () => {
      const decision = await check(
        subscription(plan, { overageEnabled: enabled }),
        used,
      );
      expect(decision).toMatchObject(expected);
      if (!('overage' in expected)) {
        expect(decision).not.toHaveProperty('overage');
      }
    });
  });

  it('reports the limit and the usage on an overage decision (the reminders read them)', async () => {
    await expect(check(subscription('pro'), 1620)).resolves.toEqual({
      allowed: true,
      planCode: 'pro',
      limit: 1500,
      used: 1620,
      overage: true,
    });
  });

  it('an Enterprise override can give a plan an overage price, and the setting then applies', async () => {
    const enterprise = subscription(
      'enterprise',
      { overageEnabled: true },
      { conversationsPerPeriod: 5000, overageConversationMinor: 1200 },
    );
    await expect(check(enterprise, 5000)).resolves.toMatchObject({
      allowed: true,
      overage: true,
    });
    await expect(
      check({ ...enterprise, overageEnabled: false }, 5000),
    ).resolves.toMatchObject({ allowed: false, code: 'PLAN_LIMIT_REACHED' });
  });

  it('a zero price is no price: the plan stops hard', async () => {
    await expect(
      check(subscription('pro', {}, { overageConversationMinor: 0 }), 1500),
    ).resolves.toMatchObject({ allowed: false, code: 'PLAN_LIMIT_REACHED' });
  });

  describe('statuses are unchanged', () => {
    it('suspended and closed tenants are denied whatever the setting', async () => {
      await expect(
        check(subscription('pro', { status: 'suspended' }), 10),
      ).resolves.toMatchObject({ allowed: false, code: 'TENANT_SUSPENDED' });
      await expect(
        check(subscription('pro', { status: 'closed' }), 10),
      ).resolves.toMatchObject({ allowed: false, code: 'TENANT_CLOSED' });
    });

    it('past_due keeps answering within the limit but never starts running up overage', async () => {
      const pastDue = subscription('pro', { status: 'past_due' });
      await expect(check(pastDue, 100)).resolves.toMatchObject({
        allowed: true,
      });
      await expect(check(pastDue, 1500)).resolves.toMatchObject({
        allowed: false,
        code: 'PLAN_LIMIT_REACHED',
      });
    });

    it('a plan that is canceled at period end keeps overage until it ends', async () => {
      await expect(
        check(subscription('pro', { status: 'canceled' }), 1500),
      ).resolves.toMatchObject({ allowed: true, overage: true });
    });
  });

  it('overage applies to conversations only: seats and knowledge still stop at the limit', async () => {
    subscriptions.getEffective.mockResolvedValue(subscription('pro'));
    await expect(
      service.check('tenant-a', 'seats', 1, { currentUsage: 10, fresh: true }),
    ).resolves.toMatchObject({ allowed: false, code: 'PLAN_LIMIT_REACHED' });
    await expect(
      service.check('tenant-a', 'knowledgeMb', 1, {
        currentUsage: 500,
        fresh: true,
      }),
    ).resolves.toMatchObject({ allowed: false, code: 'PLAN_LIMIT_REACHED' });
  });

  it('assert does not throw for an overage conversation, and throws PLAN_LIMIT_REACHED when it is off', async () => {
    subscriptions.getEffective.mockResolvedValue(subscription('pro'));
    usage.getUsage.mockResolvedValue(1500);
    await expect(
      service.assert('tenant-a', 'conversations', 1, { fresh: true }),
    ).resolves.toBeUndefined();
    subscriptions.getEffective.mockResolvedValue(
      subscription('pro', { overageEnabled: false }),
    );
    await expect(
      service.assert('tenant-a', 'conversations', 1, { fresh: true }),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'PLAN_LIMIT_REACHED' },
    });
  });
});
