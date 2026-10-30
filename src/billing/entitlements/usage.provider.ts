import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Clock } from '../clock';
import { usageWindowStart } from '../periods';
import type {
  CallMinutePeriod,
  ConversationPeriod,
  LimitKey,
} from './entitlements';

export interface UsageContext {
  /** Start of the subscription's current period (the base of a `total` allowance). */
  periodStart: Date;
  conversationPeriod: ConversationPeriod;
  /** Window of the call-minute allowance (`callMinutePeriod`); defaults to the month. */
  callMinutePeriod?: CallMinutePeriod;
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
 * from earlier on the very day a period started still counts. Call minutes (L6) come from
 * `usage_daily.call_minutes` with the same two windows, chosen by `callMinutePeriod`; the rows are
 * written by `UsageService` (the engine's call usage is ingested in Phase 5E). Knowledge size is
 * still 0 until the knowledge upload (Phase 5F) provides it.
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
    if (key === 'callMinutes' && context) {
      return this.countCallMinutes(tenantId, context);
    }
    return 0;
  }

  private async countConversations(
    tenantId: string,
    context: UsageContext,
  ): Promise<number> {
    const since = usageWindowStart(
      context.conversationPeriod,
      this.clock.now(),
      context.periodStart,
    );
    const total = await this.prisma.usageDaily.aggregate({
      where: { tenantId, day: { gte: since } },
      _sum: { conversations: true },
    });
    return total._sum.conversations ?? 0;
  }

  private async countCallMinutes(
    tenantId: string,
    context: UsageContext,
  ): Promise<number> {
    const since = usageWindowStart(
      context.callMinutePeriod ?? 'month',
      this.clock.now(),
      context.periodStart,
    );
    const total = await this.prisma.usageDaily.aggregate({
      where: { tenantId, day: { gte: since } },
      _sum: { callMinutes: true },
    });
    return total._sum.callMinutes ?? 0;
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
