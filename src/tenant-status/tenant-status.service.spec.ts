import { Test } from '@nestjs/testing';
import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { Clock, FakeClock } from '../billing/clock';
import { Entitlements } from '../billing/entitlements/entitlements';
import { EntitlementsService } from '../billing/entitlements/entitlements.service';
import { UsageProvider } from '../billing/entitlements/usage.provider';
import { SubscriptionService } from '../billing/subscriptions/subscription.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantStatusService } from './tenant-status.service';

const T0 = new Date('2026-10-07T00:00:00.000Z');

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

const agent = (over: Record<string, unknown> = {}) => ({
  id: 'ag1',
  status: 'active',
  ...over,
});

/**
 * The tenant status check (his B1) against the REAL entitlements service, so the matrix is the one
 * rule 10 describes: only the effective subscription and the agent decide, never the tenant mirrors.
 */
describe('TenantStatusService', () => {
  let prisma: PrismaMock;
  let subscriptions: { getEffective: jest.Mock; onChange: jest.Mock };
  let usage: { getUsage: jest.Mock };
  let service: TenantStatusService;

  beforeEach(async () => {
    prisma = createPrismaMock();
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-a' });
    prisma.agent.findFirst.mockResolvedValue(agent());
    subscriptions = { getEffective: jest.fn(), onChange: jest.fn() };
    usage = { getUsage: jest.fn().mockResolvedValue(0) };
    const module = await Test.createTestingModule({
      providers: [
        TenantStatusService,
        EntitlementsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SubscriptionService, useValue: subscriptions },
        { provide: UsageProvider, useValue: usage },
        { provide: Clock, useValue: new FakeClock(T0) },
      ],
    }).compile();
    service = module.get(TenantStatusService);
  });

  const ask = (
    sub: ReturnType<typeof subscription> | null,
    used = 0,
    agentId?: string,
  ) => {
    subscriptions.getEffective.mockResolvedValue(sub);
    usage.getUsage.mockResolvedValue(used);
    return service.check('tenant-a', agentId);
  };

  describe('the matrix: plan x setting x minutes used x subscription state', () => {
    it.each([
      // [plan, overage setting, used, state, serviceable, reason, overage]
      ['pro', true, 0, 'active', true, null, false],
      ['pro', true, 299, 'active', true, null, false],
      ['pro', true, 300, 'active', true, null, true],
      ['pro', true, 5000, 'active', true, null, true],
      ['pro', false, 299, 'active', true, null, false],
      ['pro', false, 300, 'active', false, 'quota_exceeded', false],
      ['free', true, 19, 'active', true, null, false],
      ['free', true, 20, 'active', false, 'quota_exceeded', false],
      ['starter', true, 29, 'active', true, null, false],
      ['starter', true, 30, 'active', false, 'quota_exceeded', false],
      ['enterprise', true, 999_999, 'active', true, null, false],
      // past due: served within the allowance, never into overage
      ['pro', true, 10, 'past_due', true, null, false],
      ['pro', true, 300, 'past_due', false, 'quota_exceeded', false],
      ['pro', true, 10, 'suspended', false, 'suspended', false],
      ['pro', true, 10, 'closed', false, 'suspended', false],
      ['free', true, 0, 'suspended', false, 'suspended', false],
    ])(
      '%s, overage %s, %i minutes used, %s -> serviceable %s, reason %s, overage %s',
      async (plan, overageEnabled, used, state, ok, reason, overage) => {
        const answer = await ask(
          subscription(plan as string, {
            status: state as string,
            overageEnabled: overageEnabled as boolean,
          }),
          used as number,
        );
        expect(answer).toEqual({
          tenantId: 'tenant-a',
          // a refusal for the account says nothing about an agent
          agentId: reason === 'suspended' ? null : 'ag1',
          serviceable: ok,
          reason,
          plan,
          overage,
        });
      },
    );
  });

  it('a tenant that does not exist is unknown_tenant, with nothing else asked or answered', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    await expect(ask(subscription('pro'))).resolves.toEqual({
      tenantId: 'tenant-a',
      agentId: null,
      serviceable: false,
      reason: 'unknown_tenant',
      plan: null,
      overage: false,
    });
    expect(subscriptions.getEffective).not.toHaveBeenCalled();
    expect(prisma.agent.findFirst).not.toHaveBeenCalled();
  });

  it('reads only the tenant id from the tenants table: the plan and status mirrors decide nothing (rule 10)', async () => {
    await ask(subscription('pro'));
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: 'tenant-a' },
      select: { id: true },
    });
    expect(subscriptions.getEffective).toHaveBeenCalledWith('tenant-a');
  });

  it('a tenant with no subscription at all fails closed (suspended)', async () => {
    await expect(ask(null)).resolves.toMatchObject({
      serviceable: false,
      reason: 'suspended',
      plan: null,
    });
  });

  it('a plan without voice has an empty allowance: quota_exceeded', async () => {
    await expect(
      ask(subscription('pro', {}, { voice: false })),
    ).resolves.toMatchObject({
      serviceable: false,
      reason: 'quota_exceeded',
      plan: 'pro',
      agentId: 'ag1',
    });
  });

  describe('the agent', () => {
    it('is the default agent of the tenant when none is asked for, looked up under the tenant', async () => {
      await ask(subscription('pro'));
      expect(prisma.agent.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a', isDefault: true },
        select: { id: true, status: true },
      });
    });

    it('a named agent is looked up under the tenant and the answer names it', async () => {
      prisma.agent.findFirst.mockResolvedValue(agent({ id: 'ag2' }));
      const answer = await ask(subscription('pro'), 0, 'ag2');
      expect(prisma.agent.findFirst).toHaveBeenCalledWith({
        where: { id: 'ag2', tenantId: 'tenant-a' },
        select: { id: true, status: true },
      });
      expect(answer.agentId).toBe('ag2');
    });

    it('a disabled agent is agent_disabled (before the minutes are even asked)', async () => {
      prisma.agent.findFirst.mockResolvedValue(agent({ status: 'disabled' }));
      await expect(
        ask(subscription('pro', { overageEnabled: false }), 300),
      ).resolves.toEqual({
        tenantId: 'tenant-a',
        agentId: 'ag1',
        serviceable: false,
        reason: 'agent_disabled',
        plan: 'pro',
        overage: false,
      });
      expect(usage.getUsage).not.toHaveBeenCalled();
    });

    it('an agent of another tenant (the tenant-scoped lookup finds nothing) is unknown_agent, the same answer as an agent that does not exist, and never agent_disabled', async () => {
      prisma.agent.findFirst.mockResolvedValue(null);
      const foreign = await ask(subscription('pro'), 0, 'ag-of-tenant-b');
      const missing = await ask(subscription('pro'), 0, 'nope');
      expect(foreign).toEqual({
        tenantId: 'tenant-a',
        agentId: null,
        serviceable: false,
        reason: 'unknown_agent',
        plan: 'pro',
        overage: false,
      });
      expect(missing).toEqual(foreign);
    });

    it('a tenant without a default agent has no agent to serve: unknown_agent', async () => {
      prisma.agent.findFirst.mockResolvedValue(null);
      await expect(ask(subscription('pro'))).resolves.toMatchObject({
        reason: 'unknown_agent',
      });
    });

    it('an over-long id is unknown without a query', async () => {
      await expect(
        ask(subscription('pro'), 0, 'x'.repeat(101)),
      ).resolves.toMatchObject({ reason: 'unknown_agent' });
      expect(prisma.agent.findFirst).not.toHaveBeenCalled();
    });

    it('the account state wins over the agent: a suspended tenant is suspended even for an unknown agent', async () => {
      prisma.agent.findFirst.mockResolvedValue(null);
      await expect(
        ask(subscription('pro', { status: 'suspended' }), 0, 'nope'),
      ).resolves.toMatchObject({ reason: 'suspended', agentId: null });
      expect(prisma.agent.findFirst).not.toHaveBeenCalled();
    });
  });

  it('answers live: every check skips the entitlements cache', async () => {
    await ask(subscription('pro'));
    await ask(subscription('pro', { status: 'suspended' }));
    expect(subscriptions.getEffective).toHaveBeenCalledTimes(2);
  });
});
