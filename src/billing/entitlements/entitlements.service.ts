import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiException } from '../../common/errors/api.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { SubscriptionStatus } from '../billing.constants';
import { Clock } from '../clock';
import { EffectiveSubscription } from '../subscriptions/effective-subscription';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { EntitlementKey, LIMIT_KEYS, LimitKey, limitFor } from './entitlements';
import { UsageProvider } from './usage.provider';

/** How long a tenant's subscription is cached. It never outlives the next time-based transition. */
export const ENTITLEMENTS_CACHE_TTL_MS = 30_000;

export type EntitlementDecision =
  | {
      allowed: true;
      planCode: string;
      /** The limit that applied (null = unlimited or not a numeric limit). */
      limit: number | null;
      used: number | null;
    }
  | {
      allowed: false;
      /** One of PLAN_LIMIT_REACHED, PLAN_FEATURE_UNAVAILABLE, SUBSCRIPTION_PAST_DUE, TENANT_SUSPENDED, TENANT_CLOSED, NO_ACTIVE_SUBSCRIPTION. */
      code: ErrorCode;
      reason: string;
      planCode: string | null;
      limit: number | null;
      used: number | null;
    };

export interface CheckOptions {
  /** Current usage when the caller already knows it (skips the `UsageProvider`). */
  currentUsage?: number;
  /** Bypass the cache (used while holding the subscription lock). */
  fresh?: boolean;
  /**
   * Treat `past_due` like `active` for this check. The chat gateway sets it: a tenant whose
   * payment is overdue keeps answering its customers (I5), so only the other statuses and the
   * plan's own features decide.
   */
  allowPastDue?: boolean;
}

interface CacheEntry {
  value: EffectiveSubscription | null;
  expiresAt: number;
}

/**
 * "May this tenant do this?" (I5): the single answer used by the gateway, knowledge upload, seats
 * and invites, and channel connection. The tenant's effective subscription is cached briefly
 * (30 s, and never past its next transition) and dropped on every subscription change made by
 * this instance; other instances see a change within the TTL (Redis invalidation: Phase 8).
 *
 * Statuses: suspended and closed tenants are always denied; a `past_due` tenant keeps answering
 * customers (`conversations`) but cannot grow (more seats, uploads, channels) until it pays.
 */
@Injectable()
export class EntitlementsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly usage: UsageProvider,
    private readonly clock: Clock,
  ) {
    subscriptions.onChange((tenantId) => this.invalidate(tenantId));
  }

  invalidate(tenantId: string) {
    this.cache.delete(tenantId);
  }

  /** The tenant's effective subscription (cached like `check`), for callers that need the plan's entitlements themselves. */
  forTenant(tenantId: string): Promise<EffectiveSubscription | null> {
    return this.effective(tenantId);
  }

  /** `amount` is how much the caller wants to add (default 1). */
  async check(
    tenantId: string,
    key: EntitlementKey,
    amount = 1,
    options: CheckOptions = {},
  ): Promise<EntitlementDecision> {
    if (options.fresh) this.invalidate(tenantId);
    const subscription = await this.effective(tenantId);
    return this.evaluate(tenantId, subscription, key, amount, options);
  }

  private async evaluate(
    tenantId: string,
    subscription: EffectiveSubscription | null,
    key: EntitlementKey,
    amount: number,
    options: CheckOptions,
  ): Promise<EntitlementDecision> {
    if (!subscription) {
      return this.deny(
        ErrorCode.NO_ACTIVE_SUBSCRIPTION,
        'This tenant has no subscription',
        null,
      );
    }
    const plan = subscription.planCode;
    if (subscription.status === SubscriptionStatus.SUSPENDED) {
      return this.deny(
        ErrorCode.TENANT_SUSPENDED,
        'This tenant is suspended',
        plan,
      );
    }
    if (subscription.status === SubscriptionStatus.CLOSED) {
      return this.deny(ErrorCode.TENANT_CLOSED, 'This account is closed', plan);
    }
    if (
      subscription.status === SubscriptionStatus.PAST_DUE &&
      key !== 'conversations' &&
      !options.allowPastDue
    ) {
      return this.deny(
        ErrorCode.SUBSCRIPTION_PAST_DUE,
        'The subscription payment is overdue',
        plan,
      );
    }

    const entitlements = subscription.entitlements;
    if (key === 'voice' || key === 'channel:voice') {
      return entitlements.voice
        ? this.allow(plan, null, null)
        : this.deny(
            ErrorCode.PLAN_FEATURE_UNAVAILABLE,
            `Voice is not included in the ${subscription.planName} plan`,
            plan,
          );
    }
    if (key.startsWith('channel:')) {
      const channel = key.slice('channel:'.length);
      return entitlements.channels.includes(channel)
        ? this.allow(plan, null, null)
        : this.deny(
            ErrorCode.PLAN_FEATURE_UNAVAILABLE,
            `The ${channel} channel is not included in the ${subscription.planName} plan`,
            plan,
          );
    }
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown entitlement key "${key}"`);
    }

    const limitKey = key as LimitKey;
    const limit = limitFor(entitlements, limitKey);
    if (limit === null) {
      return this.allow(plan, null, null);
    }
    const used =
      options.currentUsage ??
      (await this.usage.getUsage(tenantId, limitKey, {
        periodStart: subscription.currentPeriodStart,
        conversationPeriod: entitlements.conversationPeriod,
      }));
    if (used + amount > limit) {
      return {
        allowed: false,
        code: ErrorCode.PLAN_LIMIT_REACHED,
        reason: `The ${subscription.planName} plan allows ${limit} ${limitKey}`,
        planCode: plan,
        limit,
        used,
      };
    }
    return this.allow(plan, limit, used);
  }

  /** Like `check`, but throws the matching `ApiException` (403) when the answer is no. */
  async assert(
    tenantId: string,
    key: EntitlementKey,
    amount = 1,
    options: CheckOptions = {},
  ): Promise<void> {
    const decision = await this.check(tenantId, key, amount, options);
    if (!decision.allowed) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        decision.code,
        decision.reason,
      );
    }
  }

  /**
   * Seat check for the three ways a seat gets used, run inside the caller's transaction. It takes
   * the tenant's subscription row lock first, so two simultaneous invites cannot both claim the
   * last seat.
   *  - `invite`: a new pending invite (active users + other pending invites)
   *  - `accept`: a pending invite becoming a user (the invite already holds the seat: active users only)
   *  - `reactivate`: a disabled user becoming active (active users + pending invites)
   */
  async assertSeatAvailable(
    tx: Prisma.TransactionClient,
    tenantId: string,
    mode: 'invite' | 'accept' | 'reactivate',
    exceptEmail?: string,
  ): Promise<void> {
    // Read the subscription (which may apply a due transition in its own transaction) BEFORE taking
    // the row lock: afterwards that transition would wait for our lock while we wait for it.
    this.invalidate(tenantId);
    const subscription = await this.effective(tenantId);
    await this.subscriptions.lock(tx, tenantId);
    let used = await tx.tenantUser.count({
      where: { tenantId, status: 'active' },
    });
    if (mode !== 'accept') {
      used += await tx.staffInvite.count({
        where: {
          tenantId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: this.clock.now() },
          ...(exceptEmail && { email: { not: exceptEmail } }),
        },
      });
    }
    const decision = await this.evaluate(tenantId, subscription, 'seats', 1, {
      currentUsage: used,
    });
    if (!decision.allowed) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        decision.code,
        decision.reason,
      );
    }
  }

  // -------------------------------------------------------------------------------------------

  private async effective(
    tenantId: string,
  ): Promise<EffectiveSubscription | null> {
    const now = this.clock.now().getTime();
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const value = await this.subscriptions.getEffective(tenantId);
    const transition = value?.nextTransitionAt?.getTime();
    this.cache.set(tenantId, {
      value,
      expiresAt: Math.min(
        now + ENTITLEMENTS_CACHE_TTL_MS,
        transition ?? Number.POSITIVE_INFINITY,
      ),
    });
    return value;
  }

  private allow(
    planCode: string,
    limit: number | null,
    used: number | null,
  ): EntitlementDecision {
    return { allowed: true, planCode, limit, used };
  }

  private deny(
    code: ErrorCode,
    reason: string,
    planCode: string | null,
  ): EntitlementDecision {
    return { allowed: false, code, reason, planCode, limit: null, used: null };
  }
}
