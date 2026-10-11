import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Clock } from './clock';
import type { ConversationPeriod } from './entitlements/entitlements';
import { UsageProvider } from './entitlements/usage.provider';
import {
  OverageSettings,
  overageAmountMinor,
  overageSettings,
} from './overage';
import type { EffectiveSubscription } from './subscriptions/effective-subscription';

/** What the billing screens show about conversations: the allowance, the use and the overage of the current period. */
export interface ConversationUsageSummary {
  /** `month` = UTC calendar month, `total` = since the subscription period began (same windows as the limit check). */
  period: ConversationPeriod;
  periodStart: Date;
  /** Included conversations (null = unlimited). */
  included: number | null;
  /** Conversations started in the period (a conversation counts once, from `usage_daily`). */
  used: number;
  overage: OverageSettings & {
    /** Extra conversations the AI answered past the included amount (billed at the plan price). */
    count: number;
    /** `count` times the price, minor units. */
    amountMinor: number;
  };
}

/**
 * The overage figures of J6. The count is derived, never stored:
 * `max(0, used - included - held for a human)`, where `used` is the same `usage_daily` figure the
 * limit check uses and "held for a human" are the conversations of this period that were started
 * over the limit while overage was off (`gateway_conversations.ai_blocked`): they are counted as
 * used but the AI never answered them, so they are not billed. Plans without an overage price
 * always report 0.
 */
@Injectable()
export class OverageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageProvider,
    private readonly clock: Clock,
  ) {}

  async conversationSummary(
    subscription: EffectiveSubscription,
  ): Promise<ConversationUsageSummary> {
    const { tenantId, entitlements } = subscription;
    const period = entitlements.conversationPeriod;
    const since = this.windowStart(subscription, period);
    const used = await this.usage.getUsage(tenantId, 'conversations', {
      periodStart: subscription.currentPeriodStart,
      conversationPeriod: period,
    });
    const settings = overageSettings(subscription);
    const included = entitlements.conversationsPerPeriod;
    let count = 0;
    if (settings.available && included !== null && used > included) {
      const heldForHuman = await this.prisma.gatewayConversation.count({
        where: { tenantId, aiBlocked: true, createdAt: { gte: since } },
      });
      count = Math.max(0, used - included - heldForHuman);
    }
    return {
      period,
      periodStart: since,
      included,
      used,
      overage: {
        ...settings,
        count,
        amountMinor: overageAmountMinor(count, settings.priceMinor),
      },
    };
  }

  private windowStart(
    subscription: EffectiveSubscription,
    period: ConversationPeriod,
  ): Date {
    // The same day boundaries as DefaultUsageProvider.countConversations.
    const base =
      period === 'month' ? this.clock.now() : subscription.currentPeriodStart;
    return period === 'month'
      ? new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1))
      : new Date(
          Date.UTC(
            base.getUTCFullYear(),
            base.getUTCMonth(),
            base.getUTCDate(),
          ),
        );
  }
}
