import { Test } from '@nestjs/testing';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
} from '../../../test/utils/prisma-mock';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Clock, FakeClock } from '../clock';
import { InvoiceNumberService } from './invoice-number.service';
import { SubscriptionService } from './subscription.service';

const T0 = new Date('2026-10-07T00:00:00.000Z');
const owner = { userId: 'owner-1', role: 'owner' };

const plan = (code: string, entitlements: Record<string, unknown>) => ({
  code,
  name: code === 'pro' ? 'Pro' : 'Free',
  visibility: 'public',
  priceMinor: code === 'pro' ? 1_999_900 : 0,
  currency: 'PKR',
  interval: code === 'pro' ? 'month' : 'none',
  yearlyPriceMinor: null,
  durationDays: null,
  fallbackPlanCode: code === 'pro' ? 'free' : null,
  entitlements,
  providerPriceIds: {},
  active: true,
  sortOrder: 0,
});

const PRO = plan('pro', {
  seats: 10,
  conversationsPerPeriod: 1500,
  conversationPeriod: 'month',
  overageConversationMinor: 1500,
});
const FREE = plan('free', {
  seats: 1,
  conversationsPerPeriod: 30,
  conversationPeriod: 'month',
});

const row = (
  p: ReturnType<typeof plan>,
  over: Record<string, unknown> = {},
) => ({
  id: 'sub-1',
  tenantId: 'tenant-a',
  planCode: p.code,
  status: 'active',
  interval: p.interval,
  currentPeriodStart: T0,
  currentPeriodEnd: new Date('2026-11-07T00:00:00.000Z'),
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  statusBeforeSuspension: null,
  closedAt: null,
  entitlementsOverride: null,
  overageEnabled: true,
  provider: 'manual',
  providerCustomerId: null,
  providerSubscriptionId: null,
  createdAt: T0,
  updatedAt: T0,
  plan: p,
  ...over,
});

describe('SubscriptionService.setOverageEnabled (J6)', () => {
  let service: SubscriptionService;
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let listener: jest.Mock;

  beforeEach(async () => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    prisma.$queryRaw.mockResolvedValue([{ id: 'sub-1' }]);
    prisma.subscription.findUnique.mockResolvedValue(row(PRO));
    prisma.subscription.update.mockResolvedValue({});
    prisma.billingEvent.create.mockResolvedValue({});
    const module = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: Clock, useValue: new FakeClock(T0) },
        { provide: InvoiceNumberService, useValue: { next: jest.fn() } },
      ],
    }).compile();
    service = module.get(SubscriptionService);
    listener = jest.fn();
    service.onChange(listener);
  });

  it('switches it off: one update scoped to the tenant, a billing event, an audit entry in the same transaction, the cache dropped', async () => {
    await expect(
      service.setOverageEnabled('tenant-a', false, owner),
    ).resolves.toEqual({ changed: true });
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-1', tenantId: 'tenant-a' },
      data: { overageEnabled: false },
    });
    expect(prisma.billingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-a',
        type: 'overage.changed',
        source: 'manual',
        payload: {
          planCode: 'pro',
          overageEnabled: false,
          previous: true,
          changedBy: 'owner-1',
        },
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-a',
        actor: owner,
        action: 'billing.overage_changed',
        targetType: 'subscription',
        targetId: 'sub-1',
        before: { overageEnabled: true },
        after: { overageEnabled: false },
      },
      prisma,
    );
    expect(listener).toHaveBeenCalledWith('tenant-a');
  });

  it('switches it back on', async () => {
    prisma.subscription.findUnique.mockResolvedValue(
      row(PRO, { overageEnabled: false }),
    );
    await service.setOverageEnabled('tenant-a', true, owner);
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { overageEnabled: true } }),
    );
  });

  it('asking for the value it already has writes nothing and tells nobody', async () => {
    await expect(
      service.setOverageEnabled('tenant-a', true, owner),
    ).resolves.toEqual({ changed: false });
    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(prisma.billingEvent.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('409 OVERAGE_NOT_AVAILABLE on a plan without an overage price (Free, Starter), nothing written', async () => {
    prisma.subscription.findUnique.mockResolvedValue(row(FREE));
    await expect(
      service.setOverageEnabled('tenant-a', false, owner),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'OVERAGE_NOT_AVAILABLE' },
    });
    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a price for call minutes alone (L6) makes the one switch available', async () => {
    prisma.subscription.findUnique.mockResolvedValue(
      row(FREE, {
        overageEnabled: true,
        entitlementsOverride: { overageMinuteMinor: 2500 },
      }),
    );
    await expect(
      service.setOverageEnabled('tenant-a', false, owner),
    ).resolves.toEqual({ changed: true });
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-1', tenantId: 'tenant-a' },
      data: { overageEnabled: false },
    });
  });

  it('a zero minute price and a zero conversation price are no price', async () => {
    prisma.subscription.findUnique.mockResolvedValue(
      row(FREE, {
        entitlementsOverride: {
          overageMinuteMinor: 0,
          overageConversationMinor: 0,
        },
      }),
    );
    await expect(
      service.setOverageEnabled('tenant-a', false, owner),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'OVERAGE_NOT_AVAILABLE' },
    });
  });

  it('a price granted through the tenant override makes the setting available', async () => {
    prisma.subscription.findUnique.mockResolvedValue(
      row(FREE, { entitlementsOverride: { overageConversationMinor: 1200 } }),
    );
    await expect(
      service.setOverageEnabled('tenant-a', false, owner),
    ).resolves.toEqual({ changed: true });
  });

  it('404 SUBSCRIPTION_NOT_FOUND when the tenant has no subscription', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.subscription.findUnique.mockResolvedValue(null);
    await expect(
      service.setOverageEnabled('tenant-a', false, owner),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'SUBSCRIPTION_NOT_FOUND' },
    });
  });

  it('a closed account cannot change it (409 INVALID_SUBSCRIPTION_STATE)', async () => {
    prisma.subscription.findUnique.mockResolvedValue(
      row(PRO, { status: 'closed' }),
    );
    await expect(
      service.setOverageEnabled('tenant-a', false, owner),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'INVALID_SUBSCRIPTION_STATE' },
    });
  });

  it('takes the subscription row lock before reading the plan', async () => {
    await service.setOverageEnabled('tenant-a', false, owner);
    const lockOrder = prisma.$queryRaw.mock.invocationCallOrder[0];
    const readOrder = prisma.subscription.findUnique.mock.invocationCallOrder;
    // the first read is getEffective (outside the lock); the one inside the transaction comes after the lock
    expect(readOrder[readOrder.length - 1]).toBeGreaterThan(lockOrder);
  });
});
