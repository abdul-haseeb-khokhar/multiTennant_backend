import { Test } from '@nestjs/testing';
import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { PrismaService } from '../prisma/prisma.service';
import { Clock, FakeClock } from './clock';
import { UsageProvider } from './entitlements/usage.provider';
import { OverageService } from './overage.service';

const NOW = new Date('2026-10-15T10:00:00.000Z');

const sub = (over: Record<string, unknown> = {}, limits = {}) =>
  ({
    tenantId: 'tenant-a',
    currentPeriodStart: new Date('2026-10-07T00:00:00.000Z'),
    currency: 'PKR',
    overageEnabled: true,
    entitlements: {
      seats: 10,
      conversationsPerPeriod: 1500,
      conversationPeriod: 'month',
      knowledgeMb: 500,
      channels: ['chat'],
      voice: false,
      poweredByLabel: false,
      overageConversationMinor: 1500,
      ...limits,
    },
    ...over,
  }) as never;

describe('OverageService', () => {
  let service: OverageService;
  let prisma: PrismaMock;
  let usage: { getUsage: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    prisma.gatewayConversation.count.mockResolvedValue(0);
    usage = { getUsage: jest.fn().mockResolvedValue(0) };
    const module = await Test.createTestingModule({
      providers: [
        OverageService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsageProvider, useValue: usage },
        { provide: Clock, useValue: new FakeClock(NOW) },
      ],
    }).compile();
    service = module.get(OverageService);
  });

  it('is max(0, used - included) from the usage the limit check uses, priced in integer minor units', async () => {
    usage.getUsage.mockResolvedValue(1620);
    const summary = await service.conversationSummary(sub());
    expect(usage.getUsage).toHaveBeenCalledWith('tenant-a', 'conversations', {
      periodStart: new Date('2026-10-07T00:00:00.000Z'),
      conversationPeriod: 'month',
    });
    expect(summary).toMatchObject({
      period: 'month',
      periodStart: new Date('2026-10-01T00:00:00.000Z'),
      included: 1500,
      used: 1620,
      overage: {
        available: true,
        enabled: true,
        priceMinor: 1500,
        currency: 'PKR',
        count: 120,
        amountMinor: 180_000,
      },
    });
  });

  it('is zero inside the allowance and does not query the conversations table', async () => {
    usage.getUsage.mockResolvedValue(1499);
    const summary = await service.conversationSummary(sub());
    expect(summary.overage).toMatchObject({ count: 0, amountMinor: 0 });
    expect(prisma.gatewayConversation.count).not.toHaveBeenCalled();
  });

  it('does not bill conversations that were handed to a human while overage was off (tenant scoped)', async () => {
    usage.getUsage.mockResolvedValue(1600);
    prisma.gatewayConversation.count.mockResolvedValue(30);
    const summary = await service.conversationSummary(sub());
    expect(prisma.gatewayConversation.count).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        aiBlocked: true,
        createdAt: { gte: new Date('2026-10-01T00:00:00.000Z') },
      },
    });
    expect(summary.overage).toMatchObject({ count: 70, amountMinor: 105_000 });
  });

  it('a hard-stop period bills nothing: every conversation past the limit was held for a human', async () => {
    usage.getUsage.mockResolvedValue(1580);
    prisma.gatewayConversation.count.mockResolvedValue(80);
    const summary = await service.conversationSummary(
      sub({ overageEnabled: false }),
    );
    expect(summary.overage).toMatchObject({
      enabled: false,
      available: true,
      count: 0,
      amountMinor: 0,
    });
  });

  it('never goes negative', async () => {
    usage.getUsage.mockResolvedValue(1510);
    prisma.gatewayConversation.count.mockResolvedValue(50);
    expect((await service.conversationSummary(sub())).overage.count).toBe(0);
  });

  it.each([
    [
      'free',
      { conversationsPerPeriod: 30, overageConversationMinor: undefined },
    ],
    [
      'starter',
      {
        conversationsPerPeriod: 100,
        conversationPeriod: 'total',
        overageConversationMinor: undefined,
      },
    ],
  ])(
    '%s has no overage price: used past the limit is not overage',
    async (_name, limits) => {
      usage.getUsage.mockResolvedValue(250);
      const summary = await service.conversationSummary(sub({}, limits));
      expect(summary.overage).toMatchObject({
        available: false,
        enabled: false,
        priceMinor: null,
        count: 0,
        amountMinor: 0,
      });
    },
  );

  it('a total allowance (Starter) counts from the UTC day the period began', async () => {
    usage.getUsage.mockResolvedValue(10);
    const summary = await service.conversationSummary(
      sub(
        { currentPeriodStart: new Date('2026-10-07T18:30:00.000Z') },
        { conversationsPerPeriod: 100, conversationPeriod: 'total' },
      ),
    );
    expect(summary.period).toBe('total');
    expect(summary.periodStart).toEqual(new Date('2026-10-07T00:00:00.000Z'));
  });

  it('unlimited conversations: nothing is overage', async () => {
    usage.getUsage.mockResolvedValue(99_999);
    const summary = await service.conversationSummary(
      sub({}, { conversationsPerPeriod: null }),
    );
    expect(summary).toMatchObject({ included: null });
    expect(summary.overage.count).toBe(0);
  });
});
