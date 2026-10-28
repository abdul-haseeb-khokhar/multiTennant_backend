import type { BillingEvent, Invoice } from '@prisma/client';
import { overageSettings } from './overage';
import type {
  CallMinuteUsageSummary,
  ConversationUsageSummary,
} from './overage.service';
import type { EffectiveSubscription } from './subscriptions/effective-subscription';

/** Mappers from database rows to API shapes (see `entities/billing.entities.ts`). Internal columns stay out. */

export function toSubscriptionSummary(s: EffectiveSubscription) {
  return {
    planCode: s.planCode,
    planName: s.planName,
    status: s.status,
    interval: s.interval,
    currentPeriodStart: s.currentPeriodStart,
    currentPeriodEnd: s.currentPeriodEnd,
    daysLeft: s.daysLeft,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    graceEndsAt: s.graceEndsAt,
    graceDaysLeft: s.graceDaysLeft,
    limits: s.entitlements,
    overage: overageSettings(s),
  };
}

/** The period's conversation figures for the billing screens (J6). */
export function toConversationUsageView(u: ConversationUsageSummary) {
  return {
    period: u.period,
    periodStart: u.periodStart,
    included: u.included,
    used: u.used,
    overageCount: u.overage.count,
    overageAmountMinor: u.overage.amountMinor,
    overagePriceMinor: u.overage.priceMinor,
    currency: u.overage.currency,
  };
}

/** The period's call-minute figures for the billing screens (L6). */
export function toCallMinuteUsageView(u: CallMinuteUsageSummary) {
  return {
    period: u.period,
    periodStart: u.periodStart,
    included: u.included,
    used: u.used,
    overageMinutes: u.overage.minutes,
    overageAmountMinor: u.overage.amountMinor,
    overagePriceMinor: u.overage.minutePriceMinor,
    currency: u.overage.currency,
  };
}

export function toAdminSubscriptionSummary(s: EffectiveSubscription) {
  return {
    ...toSubscriptionSummary(s),
    id: s.subscriptionId,
    provider: s.provider,
    entitlementsOverride: s.entitlementsOverride,
  };
}

export function toInvoiceView(i: Invoice) {
  return {
    id: i.id,
    number: i.number,
    planCode: i.planCode,
    amountMinor: i.amountMinor,
    currency: i.currency,
    status: i.status,
    periodStart: i.periodStart,
    periodEnd: i.periodEnd,
    method: i.method,
    reference: i.reference,
    paidAt: i.paidAt,
    overageCount: i.overageCount,
    overageAmountMinor: i.overageAmountMinor,
    createdAt: i.createdAt,
  };
}

export function toAdminInvoiceView(i: Invoice) {
  return {
    ...toInvoiceView(i),
    recordedBy: i.recordedBy,
    providerInvoiceId: i.providerInvoiceId,
  };
}

export function toBillingEventView(e: BillingEvent) {
  return {
    id: e.id,
    type: e.type,
    source: e.source,
    provider: e.provider,
    providerEventId: e.providerEventId,
    payload: e.payload,
    createdAt: e.createdAt,
  };
}
