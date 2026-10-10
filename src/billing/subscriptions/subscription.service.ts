import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Invoice, Prisma, Subscription } from '@prisma/client';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { ApiException } from '../../common/errors/api.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isPrismaError } from '../../common/errors/prisma-errors';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BillingEventType,
  BillingSource,
  MANUAL_PROVIDER,
  STARTER_PLAN_CODE,
  TRANSITION_JOB_LOCK_KEY,
} from '../billing.constants';
import { Clock } from '../clock';
import { addDays } from '../periods';
import {
  EffectiveSubscription,
  buildEffective,
  toColumns,
  toPlanSnapshot,
  toState,
} from './effective-subscription';
import { InvoiceNumberService } from './invoice-number.service';
import {
  AppliedEventType,
  BillingEventPayloads,
  PlanMap,
  RecordedStep,
  advance,
  applyEventToState,
  mirrorOf,
  sameState,
  summarize,
} from './state-machine';

export interface EventMeta {
  tenantId: string;
  source: BillingSource;
  /** Who is behind the event: a platform admin (`role: 'platform_admin'`) or the system. */
  actor?: { userId?: string | null; role: string };
  /** Provider name; the manual admin API uses `manual`. */
  provider?: string | null;
  /** The provider's own id for this event. Applying the same one twice changes nothing. */
  providerEventId?: string | null;
}

/** A normalised billing event (I4): the only way anything changes a subscription. */
export type BillingEventInput = {
  [K in AppliedEventType]: {
    type: K;
    payload: BillingEventPayloads[K];
  } & EventMeta;
}[AppliedEventType];

export interface ApplyResult {
  /** True when this call recorded something (an event, an invoice or a due transition). */
  applied: boolean;
  /** True when the same provider event id had been applied before: nothing was done. */
  duplicate: boolean;
  subscription: Subscription | null;
  invoice: Invoice | null;
}

type Tx = Prisma.TransactionClient;
const SYSTEM_ACTOR = { userId: null, role: 'system' } as const;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const JOB_BATCH = 100;

/**
 * The single writer of `subscriptions`, `invoices` and `billing_events`, and of the
 * `tenants.plan` / `tenants.status` mirrors (section I).
 *
 * `applyEvent` is the one idempotent, transactional state machine behind every payment source:
 * it locks the tenant's subscription row, applies any time-based transition that is already due,
 * applies the event, and in the same transaction persists the new state, the invoice (payments),
 * the append-only billing event, an audit entry and the tenant mirrors.
 *
 * Time: `getEffective` applies due transitions lazily, so a tenant is never treated as having a
 * plan it no longer has, even when `processDueTransitions` (the daily job) is late.
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);
  private readonly listeners = new Set<(tenantId: string) => void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly invoiceNumbers: InvoiceNumberService,
  ) {}

  /** Called after a subscription changed (for example to drop the entitlements cache). */
  onChange(listener: (tenantId: string) => void) {
    this.listeners.add(listener);
  }

  /** New tenants start on Starter (I2). Runs inside the signup transaction. */
  async createStarter(tx: Tx, tenantId: string) {
    const plan = await tx.plan.findUnique({
      where: { code: STARTER_PLAN_CODE },
    });
    if (!plan) {
      throw new Error(
        `Plan "${STARTER_PLAN_CODE}" is missing from the plans table`,
      );
    }
    const now = this.clock.now();
    const periodEnd = plan.durationDays
      ? addDays(now, plan.durationDays)
      : null;
    const subscription = await tx.subscription.create({
      data: {
        tenantId,
        planCode: plan.code,
        status: 'active',
        interval: 'none',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        provider: MANUAL_PROVIDER,
      },
    });
    const snapshot = toPlanSnapshot(plan);
    await tx.tenant.update({
      where: { id: tenantId },
      data: mirrorOf(
        toState(subscription),
        new Map([[snapshot.code, snapshot]]),
      ),
    });
    await tx.billingEvent.create({
      data: {
        tenantId,
        type: BillingEventType.SUBSCRIPTION_CREATED,
        source: 'system',
        payload: {
          planCode: plan.code,
          reason: 'signup',
          periodEnd: periodEnd?.toISOString() ?? null,
        },
      },
    });
    await this.audit.record(
      {
        tenantId,
        actor: SYSTEM_ACTOR,
        action: AuditAction.SUBSCRIPTION_CREATED,
        targetType: 'subscription',
        targetId: subscription.id,
        after: summarize(toState(subscription)),
      },
      tx,
    );
    return subscription;
  }

  /**
   * The tenant's subscription with every due transition applied (null when it has none). Cheap
   * when nothing is due: one indexed read.
   */
  async getEffective(tenantId: string): Promise<EffectiveSubscription | null> {
    let row = await this.prisma.subscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (!row) return null;
    let now = this.clock.now();
    let effective = buildEffective(row, row.plan, now);
    if (effective.nextTransitionAt && effective.nextTransitionAt <= now) {
      await this.applyEvent({
        tenantId,
        type: BillingEventType.PERIOD_ENDED,
        payload: {},
        source: 'system',
        actor: SYSTEM_ACTOR,
      });
      row = await this.prisma.subscription.findUnique({
        where: { tenantId },
        include: { plan: true },
      });
      if (!row) return null;
      now = this.clock.now();
      effective = buildEffective(row, row.plan, now);
    }
    return effective;
  }

  async applyEvent(event: BillingEventInput): Promise<ApplyResult> {
    let result: ApplyResult;
    try {
      result = await this.prisma.$transaction((tx) =>
        this.applyInTransaction(tx, event),
      );
    } catch (error) {
      // Two deliveries of one provider event raced past the lookup: the unique index caught it.
      if (event.providerEventId && isPrismaError(error, 'P2002')) {
        const seen = await this.prisma.billingEvent.findFirst({
          where: this.eventIdentity(event),
          select: { id: true },
        });
        if (seen) {
          return {
            applied: false,
            duplicate: true,
            subscription: null,
            invoice: null,
          };
        }
      }
      throw error;
    }
    if (result.applied) {
      this.notify(event.tenantId);
    }
    return result;
  }

  /** The daily job: applies every transition that is due. Safe to run on several instances at once. */
  async processDueTransitions(): Promise<{
    processed: number;
    skipped: boolean;
  }> {
    // A transaction-level advisory lock: one instance does the sweep, the others skip. It only
    // avoids duplicate work; correctness comes from the per-subscription row lock and the fact
    // that a transition, once applied, is no longer due.
    return this.prisma.$transaction(
      async (lockTx) => {
        const [{ locked }] = await lockTx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${TRANSITION_JOB_LOCK_KEY}::bigint) AS locked`;
        if (!locked) {
          return { processed: 0, skipped: true };
        }
        const seen = new Set<string>();
        let processed = 0;
        for (;;) {
          const now = this.clock.now();
          const due = await this.prisma.subscription.findMany({
            where: {
              status: { in: ['active', 'canceled', 'past_due'] },
              OR: [
                { currentPeriodEnd: { lte: now } },
                { graceEndsAt: { lte: now } },
              ],
            },
            select: { tenantId: true },
            orderBy: { currentPeriodEnd: 'asc' },
            take: JOB_BATCH,
          });
          const fresh = due.filter((d) => !seen.has(d.tenantId));
          if (fresh.length === 0) break;
          for (const { tenantId } of fresh) {
            seen.add(tenantId);
            try {
              const result = await this.applyEvent({
                tenantId,
                type: BillingEventType.PERIOD_ENDED,
                payload: {},
                source: 'system',
                actor: SYSTEM_ACTOR,
              });
              if (result.applied) processed++;
            } catch (error) {
              this.logger.error({
                message: 'Could not apply due transitions',
                tenantId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
        return { processed, skipped: false };
      },
      { timeout: JOB_TIMEOUT_MS, maxWait: 10_000 },
    );
  }

  /** Takes the tenant's subscription row lock, serialising seat-consuming changes. False when the tenant has none. */
  async lock(tx: Tx, tenantId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "tenant_core"."subscriptions" WHERE "tenant_id" = ${tenantId} FOR UPDATE`;
    return rows.length > 0;
  }

  // -------------------------------------------------------------------------------------------

  private eventIdentity(event: EventMeta) {
    return {
      tenantId: event.tenantId,
      provider: this.providerOf(event),
      providerEventId: event.providerEventId ?? undefined,
    };
  }

  private providerOf(event: EventMeta): string | null {
    return (
      event.provider ?? (event.source === 'manual' ? MANUAL_PROVIDER : null)
    );
  }

  private async loadPlans(tx: Tx): Promise<PlanMap> {
    const plans = await tx.plan.findMany();
    return new Map(plans.map((p) => [p.code, toPlanSnapshot(p)]));
  }

  private async applyInTransaction(
    tx: Tx,
    event: BillingEventInput,
  ): Promise<ApplyResult> {
    const { tenantId } = event;
    const now = this.clock.now();

    if (!(await this.lock(tx, tenantId))) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Tenant ${tenantId} has no subscription`,
      );
    }
    if (event.providerEventId) {
      const seen = await tx.billingEvent.findFirst({
        where: this.eventIdentity(event),
        select: { id: true },
      });
      if (seen) {
        return {
          applied: false,
          duplicate: true,
          subscription: null,
          invoice: null,
        };
      }
    }

    const row = await tx.subscription.findUnique({ where: { tenantId } });
    if (!row) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Tenant ${tenantId} has no subscription`,
      );
    }
    const plans = await this.loadPlans(tx);
    const initial = toState(row);

    const due = advance(initial, plans, now);
    const transition = applyEventToState(
      due.state,
      event.type,
      event.payload as never,
      plans,
      now,
    );
    const primary: RecordedStep | null = transition.step
      ? { ...transition.step, before: due.state, after: transition.state }
      : null;
    // Time-based transitions are the system's doing even when an admin's event triggered the check.
    const steps: { step: RecordedStep; primary: boolean }[] = [
      ...due.steps.map((step) => ({ step, primary: false })),
      ...(primary ? [{ step: primary, primary: true }] : []),
    ];
    // A bare `period.ended` is only "evaluate what is due": its own step is the due ones.
    if (steps.length === 0) {
      return {
        applied: false,
        duplicate: false,
        subscription: row,
        invoice: null,
      };
    }

    const final = transition.state;
    const stateChanged = !sameState(initial, final);
    const updated = stateChanged
      ? await tx.subscription.update({
          where: { id: row.id, tenantId },
          data: toColumns(final),
        })
      : row;
    if (stateChanged) {
      await tx.tenant.update({
        where: { id: tenantId },
        data: mirrorOf(final, plans),
      });
    }

    let invoice: Invoice | null = null;
    for (const { step, primary: isPrimary } of steps) {
      const actor = isPrimary ? (event.actor ?? SYSTEM_ACTOR) : SYSTEM_ACTOR;
      if (step.invoice) {
        invoice = await this.createInvoice(tx, row, step.invoice, now, event);
      }
      await tx.billingEvent.create({
        data: {
          tenantId,
          type: step.type,
          source: isPrimary ? event.source : 'system',
          provider: isPrimary ? this.providerOf(event) : null,
          providerEventId: isPrimary ? (event.providerEventId ?? null) : null,
          payload: {
            ...step.payload,
            ...(invoice && isPrimary && { invoiceNumber: invoice.number }),
          } as Prisma.InputJsonObject,
        },
      });
      await this.audit.record(
        {
          tenantId,
          actor,
          action: step.auditAction,
          targetType: 'subscription',
          targetId: row.id,
          before: summarize(step.before),
          after: {
            ...summarize(step.after),
            ...(invoice && isPrimary && { invoiceNumber: invoice.number }),
          },
        },
        tx,
      );
    }
    return { applied: true, duplicate: false, subscription: updated, invoice };
  }

  private async createInvoice(
    tx: Tx,
    subscription: Subscription,
    draft: NonNullable<RecordedStep['invoice']>,
    now: Date,
    event: BillingEventInput,
  ) {
    const number = await this.invoiceNumbers.next(tx, now);
    return tx.invoice.create({
      data: {
        number,
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
        planCode: draft.planCode,
        amountMinor: draft.amountMinor,
        currency: draft.currency,
        status: 'paid',
        periodStart: draft.periodStart,
        periodEnd: draft.periodEnd,
        method: draft.method,
        reference: draft.reference,
        recordedBy:
          event.actor?.role === 'platform_admin'
            ? (event.actor.userId ?? null)
            : null,
        providerInvoiceId: draft.providerInvoiceId,
        paidAt: now,
      },
    });
  }

  private notify(tenantId: string) {
    for (const listener of this.listeners) {
      try {
        listener(tenantId);
      } catch (error) {
        this.logger.warn(
          `Subscription listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
