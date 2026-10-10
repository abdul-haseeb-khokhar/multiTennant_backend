import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Clock } from '../clock';
import type { ConversationPeriod, LimitKey } from './entitlements';

export interface UsageContext {
  /** Start of the subscription's current period (the base of a `total` allowance). */
  periodStart: Date;
  conversationPeriod: ConversationPeriod;
}

/**
 * Where `EntitlementsService.check` gets "how much has this tenant used". Injected so the
 * counters can change without touching the checks.
 */
export abstract class UsageProvider {
  abstract getUsage(
    tenantId: string,
    key: LimitKey,
    context: UsageContext,
  ): Promise<number>;
}

/**
 * Seats are counted live (active users plus pending invites). Conversations come from
 * `usage_daily` (written by `UsageService` as the gateway starts conversations): a `total`
 * allowance (Starter) counts from the UTC day the subscription period began, a `month` allowance
 * from the first day of the current UTC calendar month. Daily granularity means a conversation
 * from earlier on the very day a period started still counts. Knowledge size is still 0 until the
 * knowledge upload (Phase 5) provides it.
 */
@Injectable()
export class DefaultUsageProvider extends UsageProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {
    super();
  }

  async getUsage(
    tenantId: string,
    key: LimitKey,
    context?: UsageContext,
  ): Promise<number> {
    if (key === 'seats') {
      return this.countSeats(tenantId);
    }
    if (key === 'conversations' && context) {
      return this.countConversations(tenantId, context);
    }
    return 0;
  }

  private async countConversations(
    tenantId: string,
    context: UsageContext,
  ): Promise<number> {
    const now = this.clock.now();
    const since =
      context.conversationPeriod === 'month'
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        : new Date(
            Date.UTC(
              context.periodStart.getUTCFullYear(),
              context.periodStart.getUTCMonth(),
              context.periodStart.getUTCDate(),
            ),
          );
    const total = await this.prisma.usageDaily.aggregate({
      where: { tenantId, day: { gte: since } },
      _sum: { conversations: true },
    });
    return total._sum.conversations ?? 0;
  }

  private async countSeats(tenantId: string): Promise<number> {
    const [users, invites] = await Promise.all([
      this.prisma.tenantUser.count({ where: { tenantId, status: 'active' } }),
      this.prisma.staffInvite.count({
        where: {
          tenantId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: this.clock.now() },
        },
      }),
    ]);
    return users + invites;
  }
}
