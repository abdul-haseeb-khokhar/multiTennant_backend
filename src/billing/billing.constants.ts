/** Plan codes the code itself must know (signup grants Starter; lapsing lands on Free). Everything else about a plan is data. */
export const STARTER_PLAN_CODE = 'starter';
export const FREE_PLAN_CODE = 'free';

/** I3: a paid period that ends without renewal is `past_due` for this long, then the tenant falls back. */
export const GRACE_DAYS = 7;

/** Currencies accepted on invoices and payments. Amounts are integer minor units (I7). */
export const CURRENCIES = ['PKR'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const DEFAULT_CURRENCY: Currency = 'PKR';

/** Largest amount accepted in one payment (minor units): the `invoices.amount_minor` column is a 32-bit integer. */
export const MAX_AMOUNT_MINOR = 2_000_000_000;

export const PAYMENT_METHODS = [
  'bank_transfer',
  'cash',
  'cheque',
  'mobile_wallet',
  'other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const BILLING_INTERVALS = ['month', 'year', 'none'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const SubscriptionStatus = {
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
  CLOSED: 'closed',
  SUSPENDED: 'suspended',
} as const;
export type SubscriptionStatus =
  (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

/** Normalised billing events (I4). Every provider, and the manual admin API, speaks only these. */
export const BillingEventType = {
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  SUBSCRIPTION_CANCELED: 'subscription.canceled',
  PLAN_CHANGED: 'plan.changed',
  PERIOD_ENDED: 'period.ended',
  PERIOD_EXTENDED: 'period.extended',
  ACCOUNT_CLOSED: 'account.closed',
  TENANT_SUSPENDED: 'tenant.suspended',
  TENANT_UNSUSPENDED: 'tenant.unsuspended',
  /** Written when a subscription is first created (signup, migration); not applied through `applyEvent`. */
  SUBSCRIPTION_CREATED: 'subscription.created',
} as const;
export type BillingEventType =
  (typeof BillingEventType)[keyof typeof BillingEventType];

export type BillingSource = 'manual' | 'provider' | 'system';

/** Name of the provider recorded on events and subscriptions created by the admin API. */
export const MANUAL_PROVIDER = 'manual';

/** `tenants.status` mirror values (see the Tenant model). */
export const TenantStatusMirror = {
  TRIAL: 'trial',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSED: 'closed',
} as const;

/** Arbitrary constant used as the Postgres advisory lock key of the daily transition job. */
export const TRANSITION_JOB_LOCK_KEY = 7_270_001;
