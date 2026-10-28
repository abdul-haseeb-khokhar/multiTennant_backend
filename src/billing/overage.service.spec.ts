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
        minutePriceMinor: null,
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

  describe('call minutes (L6)', () => {
    const minutes = (limits = {}, over: Record<string, unknown> = {}) =>
      sub(over, {
        callMinutesPerPeriod: 300,
        callMinutePeriod: 'month',
        overageConversationMinor: undefined,
        overageMinuteMinor: 2500,
        ...limits,
      });

    it('is max(0, used - included) from the usage the limit check uses, priced in integer minor units', async () => {
      usage.getUsage.mockResolvedValue(342);
      const summary = await service.callMinuteSummary(minutes());
      expect(usage.getUsage).toHaveBeenCalledWith('tenant-a', 'callMinutes', {
        periodStart: new Date('2026-10-07T00:00:00.000Z'),
        conversationPeriod: 'month',
        callMinutePeriod: 'month',
      });
      expect(summary).toEqual({
        period: 'month',
        periodStart: new Date('2026-10-01T00:00:00.000Z'),
        included: 300,
        used: 342,
        overage: {
          available: true,
          enabled: true,
          priceMinor: null,
          minutePriceMinor: 2500,
          currency: 'PKR',
          minutes: 42,
          amountMinor: 105_000,
        },
      });
    });

    it('is zero inside the allowance, exactly at it and below', async () => {
      for (const used of [0, 299, 300]) {
        usage.getUsage.mockResolvedValue(used);
        const summary = await service.callMinuteSummary(minutes());
        expect(summary.overage).toMatchObject({ minutes: 0, amountMinor: 0 });
      }
    });

    it('does not query the conversations table: there is no "held for a human" for minutes', async () => {
      usage.getUsage.mockResolvedValue(500);
      await service.callMinuteSummary(minutes());
      expect(prisma.gatewayConversation.count).not.toHaveBeenCalled();
    });

    it('counts minutes served past the allowance even when the owner switched overage off (a call already running is not cut off)', async () => {
      usage.getUsage.mockResolvedValue(310);
      const summary = await service.callMinuteSummary(
        minutes({}, { overageEnabled: false }),
      );
      expect(summary.overage).toMatchObject({
        available: true,
        enabled: false,
        minutes: 10,
        amountMinor: 25_000,
      });
    });

    it.each([
      ['free', { callMinutesPerPeriod: 20, overageMinuteMinor: undefined }],
      [
        'starter',
        {
          callMinutesPerPeriod: 30,
          callMinutePeriod: 'total',
          overageMinuteMinor: undefined,
        },
      ],
    ])(
      '%s has no minute price: used past the limit is not overage',
      async (_name, limits) => {
        usage.getUsage.mockResolvedValue(95);
        const summary = await service.callMinuteSummary(minutes(limits));
        expect(summary.overage).toMatchObject({
          available: false,
          enabled: false,
          minutePriceMinor: null,
          minutes: 0,
          amountMinor: 0,
        });
      },
    );

    it('a plan that prices only conversations has no minute overage', async () => {
      usage.getUsage.mockResolvedValue(500);
      const summary = await service.callMinuteSummary(
        minutes({
          overageMinuteMinor: undefined,
          overageConversationMinor: 1500,
        }),
      );
      expect(summary.overage).toMatchObject({ minutes: 0, amountMinor: 0 });
    });

    it('a total allowance (Starter) counts from the UTC day the period began', async () => {
      usage.getUsage.mockResolvedValue(10);
      const summary = await service.callMinuteSummary(
        minutes(
          { callMinutesPerPeriod: 30, callMinutePeriod: 'total' },
          { currentPeriodStart: new Date('2026-10-07T18:30:00.000Z') },
        ),
      );
      expect(summary.period).toBe('total');
      expect(summary.periodStart).toEqual(new Date('2026-10-07T00:00:00.000Z'));
    });

    it('unlimited minutes (Enterprise): nothing is overage', async () => {
      usage.getUsage.mockResolvedValue(99_999);
      const summary = await service.callMinuteSummary(
        minutes({ callMinutesPerPeriod: null }),
      );
      expect(summary).toMatchObject({ included: null });
      expect(summary.overage.minutes).toBe(0);
    });
  });
});
