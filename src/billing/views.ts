import type { BillingEvent, Invoice } from '@prisma/client';
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
