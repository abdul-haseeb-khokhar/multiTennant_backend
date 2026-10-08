import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { ConversationPeriod, LimitKey } from './entitlements';

export interface UsageContext {
  /** Start of the subscription's current period (the base of a `total` allowance). */
  periodStart: Date;
  conversationPeriod: ConversationPeriod;
}

/**
 * Where `EntitlementsService.check` gets "how much has this tenant used". Injected so the real
 * counters can replace the stub without touching the checks: `conversations` will come from
 * `usage_daily` (Phase 3) and `knowledgeMb` from `knowledge_sources` (Phase 5).
 */
export abstract class UsageProvider {
  abstract getUsage(
    tenantId: string,
    key: LimitKey,
    context: UsageContext,
  ): Promise<number>;
}

/**
 * Stub until the counters exist: seats are counted for real (active users plus pending invites);
 * conversations and knowledge size report 0, so those limits are not enforced yet.
 */
@Injectable()
export class DefaultUsageProvider extends UsageProvider {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async getUsage(tenantId: string, key: LimitKey): Promise<number> {
    if (key === 'seats') {
      return this.countSeats(tenantId);
    }
    return 0;
  }

  private async countSeats(tenantId: string): Promise<number> {
    const [users, invites] = await Promise.all([
      this.prisma.tenantUser.count({ where: { tenantId, status: 'active' } }),
      this.prisma.staffInvite.count({
        where: {
          tenantId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
    ]);
    return users + invites;
  }
}
