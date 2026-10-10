import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { parseEntitlements } from '../entitlements/entitlements';

/** The public price list (I1): only `public`, active plans. Hidden plans such as Starter never appear. */
@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  async findPublic() {
    const plans = await this.prisma.plan.findMany({
      where: { visibility: 'public', active: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
    const data = plans.map((plan) => ({
      code: plan.code,
      name: plan.name,
      priceMinor: plan.priceMinor,
      yearlyPriceMinor: plan.yearlyPriceMinor,
      currency: plan.currency,
      interval: plan.interval,
      entitlements: parseEntitlements(plan.entitlements),
    }));
    return { data, total: data.length, skip: 0, take: data.length };
  }
}
