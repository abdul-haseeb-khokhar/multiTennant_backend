import { Prisma } from '@prisma/client';
import type { Plan, Subscription } from '@prisma/client';
import {
  BILLING_INTERVALS,
  BillingInterval,
  SubscriptionStatus,
} from '../billing.constants';
import { Entitlements, mergeEntitlements } from '../entitlements/entitlements';
import { daysUntil } from '../periods';
import {
  PlanSnapshot,
  SubscriptionState,
  nextTransitionAt,
} from './state-machine';

const STATUSES = Object.values(SubscriptionStatus) as string[];

export function toPlanSnapshot(plan: Plan): PlanSnapshot {
  return {
    code: plan.code,
    name: plan.name,
    priceMinor: plan.priceMinor,
    currency: plan.currency,
    interval: asInterval(plan.interval),
    durationDays: plan.durationDays,
    fallbackPlanCode: plan.fallbackPlanCode,
    active: plan.active,
  };
}

function asInterval(value: string): BillingInterval {
  return (BILLING_INTERVALS as readonly string[]).includes(value)
    ? (value as BillingInterval)
    : 'none';
}

function asStatus(value: string): SubscriptionStatus {
  if (!STATUSES.includes(value)) {
    throw new Error(`Unexpected subscription status "${value}"`);
  }
  return value as SubscriptionStatus;
}

export function toState(row: Subscription): SubscriptionState {
  const override = row.entitlementsOverride;
  return {
    planCode: row.planCode,
    status: asStatus(row.status),
    interval: asInterval(row.interval),
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    graceEndsAt: row.graceEndsAt,
    statusBeforeSuspension: row.statusBeforeSuspension
      ? asStatus(row.statusBeforeSuspension)
      : null,
    closedAt: row.closedAt,
    entitlementsOverride:
      override && typeof override === 'object' && !Array.isArray(override)
        ? (override as Record<string, unknown>)
        : null,
  };
}

/** Columns to write for a state (the inverse of `toState`). */
export function toColumns(state: SubscriptionState) {
  return {
    planCode: state.planCode,
    status: state.status,
    interval: state.interval,
    currentPeriodStart: state.currentPeriodStart,
    currentPeriodEnd: state.currentPeriodEnd,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    graceEndsAt: state.graceEndsAt,
    statusBeforeSuspension: state.statusBeforeSuspension,
    closedAt: state.closedAt,
    entitlementsOverride:
      (state.entitlementsOverride as Prisma.InputJsonObject | null) ??
      Prisma.DbNull,
  };
}

/** A tenant's subscription as the rest of the application sees it: due transitions already applied. */
export interface EffectiveSubscription {
  tenantId: string;
  subscriptionId: string;
  planCode: string;
  planName: string;
  status: SubscriptionStatus;
  interval: BillingInterval;
  currentPeriodStart: Date;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  graceEndsAt: Date | null;
  /** Whole days until the period ends (null = no end). */
  daysLeft: number | null;
  /** While `past_due`: whole days until the grace period ends and the tenant falls back. */
  graceDaysLeft: number | null;
  provider: string;
  /** Plan entitlements with the tenant's override merged in. */
  entitlements: Entitlements;
  entitlementsOverride: Record<string, unknown> | null;
  /** When something next changes by itself; caches must not outlive it. */
  nextTransitionAt: Date | null;
}

export function buildEffective(
  row: Subscription,
  plan: Plan,
  now: Date,
): EffectiveSubscription {
  const state = toState(row);
  const snapshot = toPlanSnapshot(plan);
  return {
    tenantId: row.tenantId,
    subscriptionId: row.id,
    planCode: row.planCode,
    planName: plan.name,
    status: state.status,
    interval: state.interval,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    graceEndsAt: row.graceEndsAt,
    daysLeft: daysUntil(row.currentPeriodEnd, now),
    graceDaysLeft:
      state.status === SubscriptionStatus.PAST_DUE
        ? daysUntil(row.graceEndsAt, now)
        : null,
    provider: row.provider,
    entitlements: mergeEntitlements(
      plan.entitlements,
      row.entitlementsOverride,
    ),
    entitlementsOverride: state.entitlementsOverride,
    nextTransitionAt: nextTransitionAt(
      state,
      new Map([[snapshot.code, snapshot]]),
    ),
  };
}
