import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Clock } from './clock';
import type {
  CallMinutePeriod,
  ConversationPeriod,
} from './entitlements/entitlements';
import { UsageProvider } from './entitlements/usage.provider';
import {
  OverageSettings,
  overageAmountMinor,
  overagePrice,
  overageSettings,
} from './overage';
import { usageWindowStart } from './periods';
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

/** The same for call minutes (L6): the allowance, the use and the overage of the current period. */
export interface CallMinuteUsageSummary {
  /** `month` = UTC calendar month, `total` = since the subscription period began (same windows as the limit check). */
  period: CallMinutePeriod;
  periodStart: Date;
  /** Included call minutes (null = unlimited). */
  included: number | null;
  /** Call minutes used in the period, from `usage_daily.call_minutes`. */
  used: number;
  overage: OverageSettings & {
    /** Minutes used past the included amount (billed at the plan's minute price). */
    minutes: number;
    /** `minutes` times the price, minor units. */
    amountMinor: number;
  };
}

/**
 * The overage figures of J6 (conversations) and L6 (call minutes). Both are derived, never stored.
 *
 * Conversations: `max(0, used - included - held for a human)`, where `used` is the same
 * `usage_daily` figure the limit check uses and "held for a human" are the conversations of this
 * period that were started over the limit while overage was off
 * (`gateway_conversations.ai_blocked`): they are counted as used but the AI never answered them, so
 * they are not billed.
 *
 * Call minutes: `max(0, used - included)` from `usage_daily.call_minutes`. There is no "held"
 * concept: with overage off the status check stops the service at the limit, so what lies past it
 * is a call that was already running (it is not cut off) or minutes served while overage was on;
 * both were served and are counted.
 *
 * A plan without a price for the unit always reports 0.
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
    const since = usageWindowStart(
      period,
      this.clock.now(),
      subscription.currentPeriodStart,
    );
    const used = await this.usage.getUsage(tenantId, 'conversations', {
      periodStart: subscription.currentPeriodStart,
      conversationPeriod: period,
    });
    const settings = overageSettings(subscription);
    const priceMinor = overagePrice(settings, 'conversations');
    const included = entitlements.conversationsPerPeriod;
    let count = 0;
    if (priceMinor !== null && included !== null && used > included) {
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
        amountMinor: overageAmountMinor(count, priceMinor),
      },
    };
  }

  async callMinuteSummary(
    subscription: EffectiveSubscription,
  ): Promise<CallMinuteUsageSummary> {
    const { tenantId, entitlements } = subscription;
    const period = entitlements.callMinutePeriod;
    const used = await this.usage.getUsage(tenantId, 'callMinutes', {
      periodStart: subscription.currentPeriodStart,
      conversationPeriod: entitlements.conversationPeriod,
      callMinutePeriod: period,
    });
    const settings = overageSettings(subscription);
    const priceMinor = overagePrice(settings, 'callMinutes');
    const included = entitlements.callMinutesPerPeriod;
    const minutes =
      priceMinor !== null && included !== null
        ? Math.max(0, used - included)
        : 0;
    return {
      period,
      periodStart: usageWindowStart(
        period,
        this.clock.now(),
        subscription.currentPeriodStart,
      ),
      included,
      used,
      overage: {
        ...settings,
        minutes,
        amountMinor: overageAmountMinor(minutes, priceMinor),
      },
    };
  }
}
