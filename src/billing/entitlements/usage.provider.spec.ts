import { Test } from '@nestjs/testing';
import { createPrismaMock, PrismaMock } from '../../../test/utils/prisma-mock';
import { PrismaService } from '../../prisma/prisma.service';
import { Clock, FakeClock } from '../clock';
import { DefaultUsageProvider } from './usage.provider';

describe('DefaultUsageProvider (conversations come from usage_daily)', () => {
  let provider: DefaultUsageProvider;
  let prisma: PrismaMock;
  const clock = new FakeClock(new Date('2026-10-18T10:00:00.000Z'));

  beforeEach(async () => {
    prisma = createPrismaMock();
    prisma.usageDaily.aggregate.mockResolvedValue({
      _sum: { conversations: 42 },
    });
    const module = await Test.createTestingModule({
      providers: [
        DefaultUsageProvider,
        { provide: PrismaService, useValue: prisma },
        { provide: Clock, useValue: clock },
      ],
    }).compile();
    provider = module.get(DefaultUsageProvider);
  });

  it('a monthly allowance sums the current UTC calendar month of this tenant only', async () => {
    const used = await provider.getUsage('tenant-a', 'conversations', {
      periodStart: new Date('2026-10-02T00:00:00.000Z'),
      conversationPeriod: 'month',
    });
    expect(used).toBe(42);
    expect(prisma.usageDaily.aggregate).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        day: { gte: new Date('2026-10-01T00:00:00.000Z') },
      },
      _sum: { conversations: true },
    });
  });

  it('a total allowance (Starter) counts from the UTC day the period began', async () => {
    await provider.getUsage('tenant-a', 'conversations', {
      periodStart: new Date('2026-10-07T13:30:00.000Z'),
      conversationPeriod: 'total',
    });
    expect(prisma.usageDaily.aggregate.mock.calls[0][0].where).toEqual({
      tenantId: 'tenant-a',
      day: { gte: new Date('2026-10-07T00:00:00.000Z') },
    });
  });

  it('is 0 for a tenant without any usage row', async () => {
    prisma.usageDaily.aggregate.mockResolvedValue({
      _sum: { conversations: null },
    });
    await expect(
      provider.getUsage('tenant-a', 'conversations', {
        periodStart: new Date('2026-10-01T00:00:00.000Z'),
        conversationPeriod: 'month',
      }),
    ).resolves.toBe(0);
  });

  it('still counts seats live and reports 0 for knowledge until Phase 5', async () => {
    prisma.tenantUser.count.mockResolvedValue(2);
    prisma.staffInvite.count.mockResolvedValue(1);
    await expect(
      provider.getUsage('tenant-a', 'seats', undefined),
    ).resolves.toBe(3);
    await expect(
      provider.getUsage('tenant-a', 'knowledgeMb', undefined),
    ).resolves.toBe(0);
  });
});
