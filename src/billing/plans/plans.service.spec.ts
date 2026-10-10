import { Test } from '@nestjs/testing';
import { createPrismaMock, PrismaMock } from '../../../test/utils/prisma-mock';
import { PrismaService } from '../../prisma/prisma.service';
import { PlansService } from './plans.service';

describe('PlansService (public price list)', () => {
  let service: PlansService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module = await Test.createTestingModule({
      providers: [PlansService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(PlansService);
  });

  it('asks only for public, active plans in display order', async () => {
    prisma.plan.findMany.mockResolvedValue([]);
    await service.findPublic();
    expect(prisma.plan.findMany).toHaveBeenCalledWith({
      where: { visibility: 'public', active: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  });

  it('returns the list envelope with prices in minor units and parsed entitlements, and nothing internal', async () => {
    prisma.plan.findMany.mockResolvedValue([
      {
        code: 'pro',
        name: 'Pro',
        visibility: 'public',
        priceMinor: 1_999_900,
        yearlyPriceMinor: 19_999_000,
        currency: 'PKR',
        interval: 'month',
        durationDays: null,
        fallbackPlanCode: 'free',
        entitlements: { seats: 10, channels: ['chat', 'whatsapp'] },
        providerPriceIds: { somebody: { month: 'price_1' } },
        active: true,
        sortOrder: 2,
      },
      {
        code: 'enterprise',
        name: 'Enterprise',
        priceMinor: null,
        yearlyPriceMinor: null,
        currency: 'PKR',
        interval: 'none',
        entitlements: { seats: null },
        providerPriceIds: {},
      },
    ]);
    const page = await service.findPublic();
    expect(page).toMatchObject({ total: 2, skip: 0, take: 2 });
    expect(page.data[0]).toEqual({
      code: 'pro',
      name: 'Pro',
      priceMinor: 1_999_900,
      yearlyPriceMinor: 19_999_000,
      currency: 'PKR',
      interval: 'month',
      entitlements: expect.objectContaining({
        seats: 10,
        channels: ['chat', 'whatsapp'],
      }),
    });
    expect(page.data[1].priceMinor).toBeNull();
    expect(JSON.stringify(page)).not.toMatch(
      /providerPriceIds|price_1|fallbackPlanCode|visibility/,
    );
  });
});
