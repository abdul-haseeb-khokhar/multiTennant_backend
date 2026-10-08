import { HttpStatus } from '@nestjs/common';
import { AuditAction } from '../../audit/audit.service';
import { ApiException } from '../../common/errors/api.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  BillingEventType,
  BillingInterval,
  FREE_PLAN_CODE,
  GRACE_DAYS,
  SubscriptionStatus,
  TenantStatusMirror,
} from '../billing.constants';
import { addDays, addInterval } from '../periods';

/**
 * The subscription state machine (I3) as pure functions: no database, no clock. Given the current
 * state, the plan catalogue, "now" and a normalised billing event, they return the next state and
 * a description of what happened. `SubscriptionService` does the I/O (locking, persisting,
 * auditing, mirrors) around them, which keeps every transition table-testable with a fake clock.
 *
 *   Starter --15 days--> Free --payment--> Pro/Enterprise (active)
 *   Starter --payment--------------------> Pro (active)
 *   paid active --period ends, no renewal--> past_due --7 days grace--> Free
 *   paid active --cancel--> canceled (keeps the plan until the period ends) --> Free
 *   any --admin--> suspended (and back)       any --close--> closed
 */

export interface PlanSnapshot {
  code: string;
  name: string;
  /** 0 = free; null = custom quote. */
  priceMinor: number | null;
  currency: string;
  interval: BillingInterval;
  durationDays: number | null;
  fallbackPlanCode: string | null;
  active: boolean;
}

export type PlanMap = ReadonlyMap<string, PlanSnapshot>;

export interface SubscriptionState {
  planCode: string;
  status: SubscriptionStatus;
  interval: BillingInterval;
  currentPeriodStart: Date;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  graceEndsAt: Date | null;
  statusBeforeSuspension: SubscriptionStatus | null;
  closedAt: Date | null;
  entitlementsOverride: Record<string, unknown> | null;
}

/** A plan that costs money (or is quoted): everything except Starter and Free. */
export function isPaidPlan(plan: PlanSnapshot): boolean {
  return plan.priceMinor !== 0;
}

export type EntitlementsOverride = Record<string, unknown>;

export type BillingEventPayloads = {
  [BillingEventType.PAYMENT_SUCCEEDED]: {
    /** Omit for a renewal of the current plan. */
    planCode?: string;
    amountMinor: number;
    currency: string;
    interval?: BillingInterval;
    periodEnd?: Date;
    method: string;
    reference?: string;
    providerInvoiceId?: string;
    entitlementsOverride?: EntitlementsOverride | null;
  };
  [BillingEventType.PAYMENT_FAILED]: {
    reason?: string;
    amountMinor?: number;
    reference?: string;
  };
  [BillingEventType.SUBSCRIPTION_CANCELED]: { atPeriodEnd?: boolean };
  [BillingEventType.PLAN_CHANGED]: {
    planCode: string;
    interval?: BillingInterval;
    periodEnd?: Date;
    entitlementsOverride?: EntitlementsOverride | null;
  };
  [BillingEventType.PERIOD_ENDED]: Record<string, never>;
  [BillingEventType.PERIOD_EXTENDED]: { until?: Date; days?: number };
  [BillingEventType.ACCOUNT_CLOSED]: { reason?: string };
  [BillingEventType.TENANT_SUSPENDED]: { reason?: string };
  [BillingEventType.TENANT_UNSUSPENDED]: Record<string, never>;
};

/** The normalised event every payment source produces (I4). */
export type AppliedEventType = keyof BillingEventPayloads;

export interface InvoiceDraft {
  planCode: string;
  amountMinor: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  method: string;
  reference: string | null;
  providerInvoiceId: string | null;
}

export interface Step {
  type: BillingEventType;
  auditAction: string;
  /** JSON-safe description stored in `billing_events.payload`. */
  payload: Record<string, unknown>;
  invoice?: InvoiceDraft;
}

/** A step together with the states around it, for the audit entry. */
export type RecordedStep = Step & {
  before: SubscriptionState;
  after: SubscriptionState;
};

export interface Transition {
  state: SubscriptionState;
  /** Null when the event changes nothing (already in the target state). */
  step: Step | null;
}

const MAX_CHAIN = 5;

const iso = (date: Date | null) => (date ? date.toISOString() : null);

/** Small, secret-free description of a state for audit `before`/`after` and event payloads. */
export function summarize(state: SubscriptionState) {
  return {
    planCode: state.planCode,
    status: state.status,
    interval: state.interval,
    currentPeriodStart: iso(state.currentPeriodStart),
    currentPeriodEnd: iso(state.currentPeriodEnd),
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    graceEndsAt: iso(state.graceEndsAt),
  };
}

/** What `tenants.plan` / `tenants.status` should say for this state (the denormalised mirrors). */
export function mirrorOf(state: SubscriptionState, plans: PlanMap) {
  let status: string = TenantStatusMirror.ACTIVE;
  if (state.status === SubscriptionStatus.SUSPENDED) {
    status = TenantStatusMirror.SUSPENDED;
  } else if (state.status === SubscriptionStatus.CLOSED) {
    status = TenantStatusMirror.CLOSED;
  } else if (plans.get(state.planCode)?.durationDays != null) {
    // A plan that ends by itself (Starter) is the trial.
    status = TenantStatusMirror.TRIAL;
  }
  return { plan: state.planCode, status };
}

/** The next moment something changes by itself, or null. Drives cache expiry and the daily job. */
export function nextTransitionAt(
  state: SubscriptionState,
  plans: PlanMap,
): Date | null {
  if (
    state.status === SubscriptionStatus.SUSPENDED ||
    state.status === SubscriptionStatus.CLOSED
  ) {
    return null;
  }
  const plan = plans.get(state.planCode);
  if (!plan) return null;
  if (state.status === SubscriptionStatus.PAST_DUE) {
    return (
      state.graceEndsAt ??
      (state.currentPeriodEnd
        ? addDays(state.currentPeriodEnd, GRACE_DAYS)
        : null)
    );
  }
  if (!state.currentPeriodEnd) return null;
  if (!isPaidPlan(plan) && !plan.fallbackPlanCode) return null;
  return state.currentPeriodEnd;
}

// ---------------------------------------------------------------------------------------------
// Time-based transitions
// ---------------------------------------------------------------------------------------------

function fallbackTo(
  state: SubscriptionState,
  plan: PlanSnapshot,
  plans: PlanMap,
  reason: string,
  at: Date,
): Transition | null {
  const target =
    (plan.fallbackPlanCode && plans.get(plan.fallbackPlanCode)) ||
    plans.get(FREE_PLAN_CODE);
  if (!target || target.code === state.planCode) return null;
  const next: SubscriptionState = {
    ...state,
    planCode: target.code,
    status: SubscriptionStatus.ACTIVE,
    interval: 'none',
    currentPeriodStart: at,
    currentPeriodEnd: target.durationDays
      ? addDays(at, target.durationDays)
      : null,
    cancelAtPeriodEnd: false,
    graceEndsAt: null,
    entitlementsOverride: null,
  };
  return {
    state: next,
    step: {
      type: BillingEventType.PERIOD_ENDED,
      auditAction: AuditAction.SUBSCRIPTION_PERIOD_ENDED,
      payload: {
        reason,
        fromPlanCode: state.planCode,
        toPlanCode: target.code,
        effectiveAt: at.toISOString(),
      },
    },
  };
}

function dueTransition(
  state: SubscriptionState,
  plans: PlanMap,
  now: Date,
): Transition | null {
  const plan = plans.get(state.planCode);
  if (!plan) return null;
  const end = state.currentPeriodEnd;

  switch (state.status) {
    case SubscriptionStatus.ACTIVE: {
      if (!end || now < end) return null;
      if (!isPaidPlan(plan)) {
        return fallbackTo(
          state,
          plan,
          plans,
          plan.durationDays != null ? 'trial_ended' : 'plan_ended',
          end,
        );
      }
      if (state.cancelAtPeriodEnd) {
        return fallbackTo(state, plan, plans, 'canceled', end);
      }
      const graceEndsAt = addDays(end, GRACE_DAYS);
      return {
        state: {
          ...state,
          status: SubscriptionStatus.PAST_DUE,
          graceEndsAt,
        },
        step: {
          type: BillingEventType.PERIOD_ENDED,
          auditAction: AuditAction.SUBSCRIPTION_PERIOD_ENDED,
          payload: {
            reason: 'period_ended_unpaid',
            planCode: state.planCode,
            graceEndsAt: graceEndsAt.toISOString(),
          },
        },
      };
    }
    case SubscriptionStatus.CANCELED:
      if (!end || now < end) return null;
      return fallbackTo(state, plan, plans, 'canceled', end);
    case SubscriptionStatus.PAST_DUE: {
      const graceEndsAt =
        state.graceEndsAt ?? (end ? addDays(end, GRACE_DAYS) : null);
      if (!graceEndsAt || now < graceEndsAt) return null;
      return fallbackTo(state, plan, plans, 'grace_expired', graceEndsAt);
    }
    default:
      return null;
  }
}

/** Applies every transition that is due at `now` (a late job may owe several in a row). */
export function advance(
  state: SubscriptionState,
  plans: PlanMap,
  now: Date,
): { state: SubscriptionState; steps: RecordedStep[] } {
  const steps: RecordedStep[] = [];
  let current = state;
  for (let i = 0; i < MAX_CHAIN; i++) {
    const due = dueTransition(current, plans, now);
    if (!due) break;
    steps.push({ ...due.step!, before: current, after: due.state });
    current = due.state;
  }
  return { state: current, steps };
}

// ---------------------------------------------------------------------------------------------
// Event transitions
// ---------------------------------------------------------------------------------------------

const invalidState = (message: string) =>
  new ApiException(
    HttpStatus.CONFLICT,
    ErrorCode.INVALID_SUBSCRIPTION_STATE,
    message,
  );

const invalidInput = (message: string) =>
  new ApiException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, message);

function requirePlan(plans: PlanMap, code: string): PlanSnapshot {
  const plan = plans.get(code);
  if (!plan || !plan.active) {
    throw new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.PLAN_NOT_FOUND,
      `Plan ${code} not found`,
    );
  }
  return plan;
}

export function sameState(a: SubscriptionState, b: SubscriptionState): boolean {
  return (
    JSON.stringify(summarize(a)) === JSON.stringify(summarize(b)) &&
    JSON.stringify(a.entitlementsOverride) ===
      JSON.stringify(b.entitlementsOverride) &&
    a.statusBeforeSuspension === b.statusBeforeSuspension
  );
}

/** Moves to a non-paid plan (Free, Starter) starting at `at`. */
function toUnpaid(
  state: SubscriptionState,
  target: PlanSnapshot,
  at: Date,
  override: EntitlementsOverride | null,
): SubscriptionState {
  return {
    ...state,
    planCode: target.code,
    status: SubscriptionStatus.ACTIVE,
    interval: 'none',
    currentPeriodStart: at,
    currentPeriodEnd: target.durationDays
      ? addDays(at, target.durationDays)
      : null,
    cancelAtPeriodEnd: false,
    graceEndsAt: null,
    entitlementsOverride: override,
  };
}

function guardStatus(state: SubscriptionState, type: AppliedEventType) {
  if (type === BillingEventType.PAYMENT_FAILED) return;
  if (
    state.status === SubscriptionStatus.CLOSED &&
    type !== BillingEventType.ACCOUNT_CLOSED
  ) {
    throw invalidState('This account is closed');
  }
  if (
    state.status === SubscriptionStatus.SUSPENDED &&
    type !== BillingEventType.TENANT_UNSUSPENDED &&
    type !== BillingEventType.TENANT_SUSPENDED &&
    type !== BillingEventType.ACCOUNT_CLOSED &&
    type !== BillingEventType.PERIOD_ENDED
  ) {
    throw invalidState('This tenant is suspended: lift the suspension first');
  }
}

/**
 * Applies one normalised event. Time-based transitions that were already due must have been
 * applied with `advance` first. Throws `ApiException` for an event the current state cannot take
 * (409 INVALID_SUBSCRIPTION_STATE), for bad input (400) and for an unknown plan (404).
 */
export function applyEventToState<T extends AppliedEventType>(
  state: SubscriptionState,
  type: T,
  payload: BillingEventPayloads[T],
  plans: PlanMap,
  now: Date,
): Transition {
  guardStatus(state, type);
  const noop: Transition = { state, step: null };

  switch (type) {
    case BillingEventType.PERIOD_ENDED:
      // Only "evaluate what is due"; `advance` already did and recorded it.
      return noop;

    case BillingEventType.PAYMENT_FAILED: {
      const p = payload as BillingEventPayloads['payment.failed'];
      return {
        state,
        step: {
          type,
          auditAction: AuditAction.SUBSCRIPTION_PAYMENT_FAILED,
          payload: { ...p },
        },
      };
    }

    case BillingEventType.PAYMENT_SUCCEEDED: {
      const p = payload as BillingEventPayloads['payment.succeeded'];
      if (!Number.isInteger(p.amountMinor) || p.amountMinor <= 0) {
        throw invalidInput(
          'amountMinor must be a positive integer (minor units)',
        );
      }
      const target = requirePlan(plans, p.planCode ?? state.planCode);
      if (!isPaidPlan(target)) {
        throw invalidInput(
          `Plan ${target.code} is not a paid plan: choose a paid plan`,
        );
      }
      if (p.currency !== target.currency) {
        throw invalidInput(
          `Plan ${target.code} is billed in ${target.currency}`,
        );
      }
      const renewal =
        target.code === state.planCode &&
        isPaidPlan(plans.get(state.planCode)!) &&
        state.status !== SubscriptionStatus.SUSPENDED;
      const start =
        renewal && state.currentPeriodEnd && state.currentPeriodEnd > now
          ? state.currentPeriodEnd
          : now;
      const interval: BillingInterval =
        p.interval ??
        (renewal && state.interval !== 'none'
          ? state.interval
          : target.interval);
      let end: Date;
      if (p.periodEnd) {
        end = p.periodEnd;
      } else if (interval === 'none') {
        throw invalidInput(
          `Plan ${target.code} has no billing interval: send periodEnd or interval`,
        );
      } else {
        end = addInterval(start, interval);
      }
      if (end <= start) {
        throw invalidInput('periodEnd must be after the start of the period');
      }
      const override =
        p.entitlementsOverride !== undefined
          ? p.entitlementsOverride
          : target.code === state.planCode
            ? state.entitlementsOverride
            : null;
      const next: SubscriptionState = {
        ...state,
        planCode: target.code,
        status: SubscriptionStatus.ACTIVE,
        interval,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        cancelAtPeriodEnd: false,
        graceEndsAt: null,
        entitlementsOverride: override,
      };
      return {
        state: next,
        step: {
          type,
          auditAction: AuditAction.SUBSCRIPTION_PAYMENT_RECORDED,
          payload: {
            planCode: target.code,
            amountMinor: p.amountMinor,
            currency: p.currency,
            interval,
            periodStart: start.toISOString(),
            periodEnd: end.toISOString(),
            method: p.method,
            reference: p.reference ?? null,
            renewal,
          },
          invoice: {
            planCode: target.code,
            amountMinor: p.amountMinor,
            currency: p.currency,
            periodStart: start,
            periodEnd: end,
            method: p.method,
            reference: p.reference ?? null,
            providerInvoiceId: p.providerInvoiceId ?? null,
          },
        },
      };
    }

    case BillingEventType.SUBSCRIPTION_CANCELED: {
      const p = payload as BillingEventPayloads['subscription.canceled'];
      const atPeriodEnd = p.atPeriodEnd ?? true;
      const plan = plans.get(state.planCode)!;
      if (!isPaidPlan(plan)) {
        throw invalidState(`Plan ${plan.code} has nothing to cancel`);
      }
      const base = {
        type,
        auditAction: AuditAction.SUBSCRIPTION_CANCELED,
      };
      if (atPeriodEnd && state.status === SubscriptionStatus.CANCELED) {
        return noop;
      }
      if (atPeriodEnd && state.status !== SubscriptionStatus.PAST_DUE) {
        return {
          state: {
            ...state,
            status: SubscriptionStatus.CANCELED,
            cancelAtPeriodEnd: true,
          },
          step: {
            ...base,
            payload: { atPeriodEnd: true, planCode: plan.code },
          },
        };
      }
      // Immediately (or the period is already over): straight to the fallback plan.
      const lapsed = fallbackTo(state, plan, plans, 'canceled_now', now);
      if (!lapsed) throw invalidState('There is no plan to fall back to');
      return {
        state: lapsed.state,
        step: {
          ...base,
          payload: {
            atPeriodEnd: false,
            fromPlanCode: plan.code,
            toPlanCode: lapsed.state.planCode,
          },
        },
      };
    }

    case BillingEventType.PLAN_CHANGED: {
      const p = payload as BillingEventPayloads['plan.changed'];
      const target = requirePlan(plans, p.planCode);
      const current = plans.get(state.planCode)!;
      const samePlan = target.code === state.planCode;
      const override =
        p.entitlementsOverride !== undefined
          ? p.entitlementsOverride
          : samePlan
            ? state.entitlementsOverride
            : null;
      let next: SubscriptionState;
      if (!isPaidPlan(target)) {
        next =
          samePlan && state.status === SubscriptionStatus.ACTIVE
            ? { ...state, entitlementsOverride: override }
            : toUnpaid(state, target, now, override);
      } else {
        const running =
          isPaidPlan(current) &&
          state.currentPeriodEnd != null &&
          state.currentPeriodEnd > now &&
          (state.status === SubscriptionStatus.ACTIVE ||
            state.status === SubscriptionStatus.CANCELED);
        const interval: BillingInterval =
          p.interval ??
          (running && state.interval !== 'none'
            ? state.interval
            : target.interval);
        let start = running ? state.currentPeriodStart : now;
        let end: Date;
        if (p.periodEnd) {
          start = running ? state.currentPeriodStart : now;
          end = p.periodEnd;
        } else if (running) {
          end = state.currentPeriodEnd!;
        } else if (interval === 'none') {
          throw invalidInput(
            `Plan ${target.code} has no billing interval: send periodEnd or interval`,
          );
        } else {
          end = addInterval(now, interval);
        }
        if (end <= now) throw invalidInput('periodEnd must be in the future');
        next = {
          ...state,
          planCode: target.code,
          status: SubscriptionStatus.ACTIVE,
          interval,
          currentPeriodStart: start,
          currentPeriodEnd: end,
          cancelAtPeriodEnd: false,
          graceEndsAt: null,
          entitlementsOverride: override,
        };
      }
      if (sameState(state, next)) return noop;
      return {
        state: next,
        step: {
          type,
          auditAction: AuditAction.SUBSCRIPTION_PLAN_CHANGED,
          payload: {
            fromPlanCode: state.planCode,
            toPlanCode: target.code,
            interval: next.interval,
            periodEnd: iso(next.currentPeriodEnd),
            hasEntitlementsOverride: next.entitlementsOverride !== null,
          },
        },
      };
    }

    case BillingEventType.PERIOD_EXTENDED: {
      const p = payload as BillingEventPayloads['period.extended'];
      if ((p.until === undefined) === (p.days === undefined)) {
        throw invalidInput('Send either until or days');
      }
      if (!state.currentPeriodEnd) {
        throw invalidState(
          `Plan ${state.planCode} has no end to extend: change the plan instead`,
        );
      }
      const base = state.currentPeriodEnd > now ? state.currentPeriodEnd : now;
      const newEnd = p.until ?? addDays(base, p.days!);
      if (p.days !== undefined && (!Number.isInteger(p.days) || p.days < 1)) {
        throw invalidInput('days must be a positive integer');
      }
      if (newEnd <= now || newEnd <= state.currentPeriodEnd) {
        throw invalidInput(
          'The new end must be later than the current end and in the future',
        );
      }
      const next: SubscriptionState = {
        ...state,
        currentPeriodEnd: newEnd,
        status:
          state.status === SubscriptionStatus.PAST_DUE
            ? SubscriptionStatus.ACTIVE
            : state.status,
        graceEndsAt: null,
      };
      return {
        state: next,
        step: {
          type,
          auditAction: AuditAction.SUBSCRIPTION_EXTENDED,
          payload: {
            planCode: state.planCode,
            previousPeriodEnd: iso(state.currentPeriodEnd),
            periodEnd: newEnd.toISOString(),
          },
        },
      };
    }

    case BillingEventType.ACCOUNT_CLOSED: {
      if (state.status === SubscriptionStatus.CLOSED) return noop;
      const p = payload as BillingEventPayloads['account.closed'];
      return {
        state: {
          ...state,
          status: SubscriptionStatus.CLOSED,
          cancelAtPeriodEnd: false,
          graceEndsAt: null,
          statusBeforeSuspension: null,
          closedAt: now,
        },
        step: {
          type,
          auditAction: AuditAction.SUBSCRIPTION_CLOSED,
          payload: { reason: p.reason ?? null, planCode: state.planCode },
        },
      };
    }

    case BillingEventType.TENANT_SUSPENDED: {
      if (state.status === SubscriptionStatus.SUSPENDED) return noop;
      const p = payload as BillingEventPayloads['tenant.suspended'];
      return {
        state: {
          ...state,
          status: SubscriptionStatus.SUSPENDED,
          statusBeforeSuspension: state.status,
        },
        step: {
          type,
          auditAction: AuditAction.TENANT_SUSPENDED,
          payload: { reason: p.reason ?? null, previousStatus: state.status },
        },
      };
    }

    case BillingEventType.TENANT_UNSUSPENDED: {
      if (state.status !== SubscriptionStatus.SUSPENDED) return noop;
      return {
        state: {
          ...state,
          status: state.statusBeforeSuspension ?? SubscriptionStatus.ACTIVE,
          statusBeforeSuspension: null,
        },
        step: {
          type,
          auditAction: AuditAction.TENANT_REACTIVATED,
          payload: {
            restoredStatus:
              state.statusBeforeSuspension ?? SubscriptionStatus.ACTIVE,
          },
        },
      };
    }

    default:
      throw invalidInput(`Unknown billing event type ${String(type)}`);
  }
}
