import { Test } from '@nestjs/testing';
import { Clock, FakeClock } from '../clock';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { Entitlements } from './entitlements';
import { EntitlementsService } from './entitlements.service';
import { UsageProvider } from './usage.provider';

const T0 = new Date('2026-10-07T00:00:00.000Z');

/** The placeholder plans of L6 (Phase 5A). */
const PLANS: Record<string, Partial<Entitlements>> = {
  starter: { callMinutesPerPeriod: 30, callMinutePeriod: 'total' },
  free: { callMinutesPerPeriod: 20, callMinutePeriod: 'month' },
  pro: {
    callMinutesPerPeriod: 300,
    callMinutePeriod: 'month',
    overageMinuteMinor: 2500,
  },
  enterprise: { callMinutesPerPeriod: null, callMinutePeriod: 'month' },
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
    conversationsPerPeriod: 100,
    conversationPeriod: 'month',
    knowledgeMb: 500,
    channels: ['chat', 'voice'],
    voice: true,
    poweredByLabel: false,
    ...PLANS[planCode],
    ...limits,
  },
  entitlementsOverride: null,
  nextTransitionAt: null,
  ...over,
});

describe('EntitlementsService call minutes (L6)', () => {
  let service: EntitlementsService;
  let subscriptions: { getEffective: jest.Mock; onChange: jest.Mock };
  let usage: { getUsage: jest.Mock };

  beforeEach(async () => {
    subscriptions = { getEffective: jest.fn(), onChange: jest.fn() };
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

  const check = async (
    sub: ReturnType<typeof subscription>,
    used: number,
    amount = 1,
  ) => {
    subscriptions.getEffective.mockResolvedValue(sub);
    usage.getUsage.mockResolvedValue(used);
    return service.check('tenant-a', 'callMinutes', amount, { fresh: true });
  };

  it('asks the usage provider for call minutes with the call-minute window of the plan', async () => {
    await check(subscription('starter'), 5);
    expect(usage.getUsage).toHaveBeenCalledWith('tenant-a', 'callMinutes', {
      periodStart: T0,
      conversationPeriod: 'month',
      callMinutePeriod: 'total',
    });
  });

  // plan x setting x used (inside the allowance, exactly at it, past it). check() asks for ONE more minute.
  describe.each([
    ['pro', true, 299, { allowed: true }],
    ['pro', true, 300, { allowed: true, overage: true }],
    ['pro', true, 450, { allowed: true, overage: true }],
    ['pro', false, 299, { allowed: true }],
    ['pro', false, 300, { allowed: false, code: 'PLAN_LIMIT_REACHED' }],
    ['pro', false, 450, { allowed: false, code: 'PLAN_LIMIT_REACHED' }],
    // no minute price: the stored choice is irrelevant, they always stop hard
    ['free', true, 19, { allowed: true }],
    ['free', true, 20, { allowed: false, code: 'PLAN_LIMIT_REACHED' }],
    ['free', false, 20, { allowed: false, code: 'PLAN_LIMIT_REACHED' }],
    ['starter', true, 29, { allowed: true }],
    ['starter', true, 30, { allowed: false, code: 'PLAN_LIMIT_REACHED' }],
    ['starter', false, 99, { allowed: false, code: 'PLAN_LIMIT_REACHED' }],
    // Enterprise: unlimited
    ['enterprise', true, 100_000, { allowed: true, limit: null }],
    ['enterprise', false, 100_000, { allowed: true, limit: null }],
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
    await expect(check(subscription('pro'), 342)).resolves.toEqual({
      allowed: true,
      planCode: 'pro',
      limit: 300,
      used: 342,
      overage: true,
    });
  });

  it('a request for several minutes at once is checked as a whole', async () => {
    const pro = subscription('pro', { overageEnabled: false });
    await expect(check(pro, 296, 4)).resolves.toMatchObject({ allowed: true });
    await expect(check(pro, 296, 5)).resolves.toMatchObject({
      allowed: false,
      code: 'PLAN_LIMIT_REACHED',
    });
  });

  it('amount 0 is the reminder job question ("how much is used"), never a denial at exactly the limit', async () => {
    await expect(
      check(subscription('pro', { overageEnabled: false }), 300, 0),
    ).resolves.toMatchObject({ allowed: true, limit: 300, used: 300 });
  });

  describe('the minute price decides, not the conversation price', () => {
    it('a plan that prices only conversations does not bill minutes', async () => {
      const onlyConversations = subscription(
        'pro',
        {},
        { overageMinuteMinor: undefined, overageConversationMinor: 1500 },
      );
      await expect(check(onlyConversations, 300)).resolves.toMatchObject({
        allowed: false,
        code: 'PLAN_LIMIT_REACHED',
      });
    });

    it('a plan that prices only minutes does not bill extra conversations', async () => {
      const onlyMinutes = subscription(
        'pro',
        {},
        { conversationsPerPeriod: 5 },
      );
      subscriptions.getEffective.mockResolvedValue(onlyMinutes);
      usage.getUsage.mockResolvedValue(5);
      await expect(
        service.check('tenant-a', 'conversations', 1, { fresh: true }),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'PLAN_LIMIT_REACHED',
      });
    });

    it('a zero minute price is no price: the plan stops hard', async () => {
      await expect(
        check(subscription('pro', {}, { overageMinuteMinor: 0 }), 300),
      ).resolves.toMatchObject({ allowed: false, code: 'PLAN_LIMIT_REACHED' });
    });

    it('an Enterprise override can give a plan a minute price, and the owner setting then applies', async () => {
      const enterprise = subscription(
        'enterprise',
        { overageEnabled: true },
        { callMinutesPerPeriod: 1000, overageMinuteMinor: 2000 },
      );
      await expect(check(enterprise, 1000)).resolves.toMatchObject({
        allowed: true,
        overage: true,
      });
      await expect(
        check({ ...enterprise, overageEnabled: false }, 1000),
      ).resolves.toMatchObject({ allowed: false, code: 'PLAN_LIMIT_REACHED' });
    });
  });

  describe('statuses', () => {
    it('suspended and closed tenants are denied whatever the setting or the usage', async () => {
      await expect(
        check(subscription('pro', { status: 'suspended' }), 1),
      ).resolves.toMatchObject({ allowed: false, code: 'TENANT_SUSPENDED' });
      await expect(
        check(subscription('pro', { status: 'closed' }), 1),
      ).resolves.toMatchObject({ allowed: false, code: 'TENANT_CLOSED' });
      await expect(
        check(subscription('free', { status: 'suspended' }), 0),
      ).resolves.toMatchObject({ allowed: false, code: 'TENANT_SUSPENDED' });
    });

    it('past_due keeps serving callers within the limit (like chat, I5) but never starts overage', async () => {
      const pastDue = subscription('pro', { status: 'past_due' });
      await expect(check(pastDue, 100)).resolves.toMatchObject({
        allowed: true,
      });
      await expect(check(pastDue, 299)).resolves.toMatchObject({
        allowed: true,
      });
      await expect(check(pastDue, 300)).resolves.toMatchObject({
        allowed: false,
        code: 'PLAN_LIMIT_REACHED',
      });
      await expect(check(pastDue, 450)).resolves.toMatchObject({
        allowed: false,
        code: 'PLAN_LIMIT_REACHED',
      });
    });

    it('a plan that is canceled at period end keeps overage until it ends', async () => {
      await expect(
        check(subscription('pro', { status: 'canceled' }), 300),
      ).resolves.toMatchObject({ allowed: true, overage: true });
    });
  });

  describe('voice is on for every plan', () => {
    it.each(['starter', 'free', 'pro', 'enterprise'])('%s', async (plan) => {
      subscriptions.getEffective.mockResolvedValue(subscription(plan));
      await expect(
        service.check('tenant-a', 'voice', 1, { fresh: true }),
      ).resolves.toMatchObject({ allowed: true });
      await expect(
        service.check('tenant-a', 'channel:voice', 1, { fresh: true }),
      ).resolves.toMatchObject({ allowed: true });
    });
  });

  it('a plan row without the call-minute keys allows no minutes (the most restrictive reading)', async () => {
    const broken = subscription('pro');
    broken.entitlements = {
      seats: 10,
      conversationsPerPeriod: 100,
      conversationPeriod: 'month',
      knowledgeMb: 500,
      channels: ['chat'],
      voice: true,
      poweredByLabel: false,
    } as never;
    // the service reads what getEffective returns, which parses the row: simulate the parsed 0
    (broken.entitlements as Entitlements).callMinutesPerPeriod = 0;
    (broken.entitlements as Entitlements).callMinutePeriod = 'month';
    await expect(
      check({ ...broken, overageEnabled: false }, 0),
    ).resolves.toMatchObject({ allowed: false, code: 'PLAN_LIMIT_REACHED' });
  });

  it('assert throws PLAN_LIMIT_REACHED at a hard stop and not for an overage minute', async () => {
    subscriptions.getEffective.mockResolvedValue(subscription('pro'));
    usage.getUsage.mockResolvedValue(300);
    await expect(
      service.assert('tenant-a', 'callMinutes', 1, { fresh: true }),
    ).resolves.toBeUndefined();
    subscriptions.getEffective.mockResolvedValue(
      subscription('pro', { overageEnabled: false }),
    );
    await expect(
      service.assert('tenant-a', 'callMinutes', 1, { fresh: true }),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'PLAN_LIMIT_REACHED' },
    });
  });
});
