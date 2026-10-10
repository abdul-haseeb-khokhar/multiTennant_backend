import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '../../notifications/notification-types';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Clock } from '../clock';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { daysUntil } from '../periods';

/** Days before a period ends at which the owners and admins are reminded (I8). */
export const REMINDER_THRESHOLDS = [7, 3, 1] as const;
/** A plan limit warning at 80% of the included conversations and again when they are used up. */
export const USAGE_THRESHOLDS = [80, 100] as const;

const RECIPIENT_ROLES = ['owner', 'admin'];
const DAY_MS = 86_400_000;
/** How far back the sweep looks for billing events that deserve a notification (a late job still catches them). */
const EVENT_LOOKBACK_DAYS = 7;
/** A tenant's usage is re-checked when its counter changed within this window (the job runs hourly). */
const USAGE_LOOKBACK_MS = 3 * 60 * 60_000;
const BATCH = 1000;

export interface ReminderResult {
  created: number;
}

/**
 * The reminders of I8 as in-app notifications for the owners and admins of a tenant: the trial
 * (Starter) or a paid period ends in 7, 3 and 1 days, the grace period started, the workspace was
 * moved to a lower plan, and the conversation allowance is 80% and 100% used. (Data-deletion
 * notices belong to Phase 8.)
 *
 * IDEMPOTENT: every notification carries a `dedupeKey` naming the reminder and its period, and the
 * table is unique on (tenant, recipient, key), so running the sweep twice, from two instances, or
 * after a restart creates nothing new. A job that was late still sends the most urgent threshold
 * that applies (at 2 days left: the "3 days" reminder, once). Correctness never depends on this job:
 * the banner data in `GET /v1/me` is computed on read.
 */
@Injectable()
export class BillingRemindersService {
  private readonly logger = new Logger(BillingRemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly entitlements: EntitlementsService,
    private readonly clock: Clock,
  ) {}

  async generate(): Promise<ReminderResult> {
    const created =
      (await this.periodEnding()) +
      (await this.fromBillingEvents()) +
      (await this.usageThresholds());
    if (created > 0) {
      this.logger.log(`Created ${created} billing reminders`);
    }
    return { created };
  }

  // ---- the trial or a paid period is about to end --------------------------------------------

  private async periodEnding(): Promise<number> {
    const now = this.clock.now();
    const horizon = new Date(now.getTime() + REMINDER_THRESHOLDS[0] * DAY_MS);
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        // past_due already ended; suspended and closed are frozen
        status: { in: ['active', 'canceled'] },
        currentPeriodEnd: { gt: now, lte: horizon },
      },
      include: { plan: true },
      orderBy: { currentPeriodEnd: 'asc' },
      take: BATCH,
    });
    let created = 0;
    for (const subscription of subscriptions) {
      const end = subscription.currentPeriodEnd;
      if (!end) continue;
      const daysLeft = daysUntil(end, now) ?? 0;
      // The most urgent threshold already reached: 2 days left is the "3 days" reminder.
      const threshold = [...REMINDER_THRESHOLDS]
        .reverse()
        .find((t) => daysLeft <= t);
      if (!threshold) continue;
      const trial =
        subscription.plan.priceMinor === 0 &&
        subscription.plan.durationDays !== null;
      const type = trial
        ? NotificationType.BILLING_TRIAL_ENDING
        : NotificationType.BILLING_PERIOD_ENDING;
      created += await this.notify(subscription.tenantId, {
        type,
        params: {
          daysLeft,
          endsAt: end.toISOString(),
          threshold,
          ...(!trial && {
            plan: subscription.plan.name,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          }),
        },
        link: '/billing',
        dedupeKey: `${type}:${threshold}:${end.toISOString().slice(0, 10)}`,
      });
    }
    return created;
  }

  // ---- something happened to the plan (read from the append-only billing events) --------------

  private async fromBillingEvents(): Promise<number> {
    const since = new Date(
      this.clock.now().getTime() - EVENT_LOOKBACK_DAYS * DAY_MS,
    );
    const [events, plans] = await Promise.all([
      this.prisma.billingEvent.findMany({
        where: { type: 'period.ended', createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
      }),
      this.prisma.plan.findMany({ select: { code: true, name: true } }),
    ]);
    const nameOf = (code: unknown) =>
      plans.find((plan) => plan.code === code)?.name ??
      (typeof code === 'string' ? code : '');
    let created = 0;
    for (const event of events) {
      const payload = asRecord(event.payload);
      if (payload.reason === 'period_ended_unpaid') {
        const graceEndsAt = new Date(String(payload.graceEndsAt));
        created += await this.notify(event.tenantId, {
          type: NotificationType.BILLING_GRACE_STARTED,
          params: {
            plan: nameOf(payload.planCode),
            graceEndsAt: Number.isNaN(graceEndsAt.getTime())
              ? null
              : graceEndsAt.toISOString(),
            graceDaysLeft: Number.isNaN(graceEndsAt.getTime())
              ? null
              : daysUntil(graceEndsAt, event.createdAt),
          },
          link: '/billing',
          dedupeKey: `${NotificationType.BILLING_GRACE_STARTED}:${event.id}`,
        });
      } else if (payload.toPlanCode) {
        created += await this.notify(event.tenantId, {
          type: NotificationType.BILLING_DOWNGRADED,
          params: {
            fromPlan: nameOf(payload.fromPlanCode),
            toPlan: nameOf(payload.toPlanCode),
            reason: payload.reason ?? null,
          },
          link: '/billing',
          dedupeKey: `${NotificationType.BILLING_DOWNGRADED}:${event.id}`,
        });
      }
    }
    return created;
  }

  // ---- 80% and 100% of the included conversations -------------------------------------------

  private async usageThresholds(): Promise<number> {
    const now = this.clock.now();
    const touched = await this.prisma.usageDaily.findMany({
      where: {
        updatedAt: { gte: new Date(now.getTime() - USAGE_LOOKBACK_MS) },
      },
      distinct: ['tenantId'],
      select: { tenantId: true },
      take: BATCH,
    });
    let created = 0;
    for (const { tenantId } of touched) {
      // Fresh first: it drops a cached subscription, so the plan read next is the current one.
      const decision = await this.entitlements.check(
        tenantId,
        'conversations',
        0,
        {
          fresh: true,
        },
      );
      const subscription = await this.entitlements.forTenant(tenantId);
      if (!subscription) continue;
      // null = unlimited; a suspended or closed tenant answers without a limit and is skipped
      if (
        decision.limit === null ||
        decision.used === null ||
        decision.limit <= 0
      ) {
        continue;
      }
      const percent = Math.floor((decision.used * 100) / decision.limit);
      const threshold = [...USAGE_THRESHOLDS]
        .reverse()
        .find((t) => percent >= t);
      if (!threshold) continue;
      const period = subscription.entitlements.conversationPeriod;
      const periodKey =
        period === 'month'
          ? now.toISOString().slice(0, 7)
          : `since-${subscription.currentPeriodStart.toISOString().slice(0, 10)}`;
      const type =
        threshold === 100
          ? NotificationType.USAGE_LIMIT_REACHED
          : NotificationType.USAGE_THRESHOLD;
      created += await this.notify(tenantId, {
        type,
        params: {
          metric: 'conversations',
          percent: threshold,
          used: decision.used,
          limit: decision.limit,
          period,
        },
        link: '/billing',
        dedupeKey: `${type}:conversations:${periodKey}`,
      });
    }
    return created;
  }

  // -------------------------------------------------------------------------------------------

  private async notify(
    tenantId: string,
    input: Parameters<NotificationsService['create']>[2],
  ): Promise<number> {
    const recipients = await this.notifications.activeStaffIds(
      tenantId,
      RECIPIENT_ROLES,
    );
    const rows = await this.notifications.create(tenantId, recipients, input);
    this.notifications.announce(tenantId, rows);
    return rows.length;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
