import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shapes (documentation only; the services return plain objects of these shapes). */

export class EntitlementsView {
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 3,
    description:
      'Staff seats: active users plus pending invites. null = unlimited.',
  })
  seats: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 100,
    description:
      'AI conversations allowed per `conversationPeriod`. null = unlimited.',
  })
  conversationsPerPeriod: number | null;

  @ApiProperty({
    enum: ['total', 'month'],
    description:
      '`total` = since the subscription period began (Starter), `month` = per calendar month.',
  })
  conversationPeriod: 'total' | 'month';

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 20,
    description: 'Knowledge base size in MB. null = unlimited.',
  })
  knowledgeMb: number | null;

  @ApiProperty({ type: [String], example: ['chat', 'whatsapp'] })
  channels: string[];

  @ApiProperty({
    description:
      'Phone calls included. True on every plan since the voice-first decision (L6); the minutes are limited by `callMinutesPerPeriod`.',
  })
  voice: boolean;

  @ApiProperty({ description: 'The widget shows our "powered by" label.' })
  poweredByLabel: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 300,
    description:
      'Call minutes included per `callMinutePeriod` (L6). null = unlimited (Enterprise). The numbers come from the plans table, which the operator sets from environment variables (`PLAN_*_CALL_MINUTES`).',
  })
  callMinutesPerPeriod: number | null;

  @ApiProperty({
    enum: ['total', 'month'],
    description:
      '`total` = since the subscription period began (Starter), `month` = per UTC calendar month.',
  })
  callMinutePeriod: 'total' | 'month';

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 3,
    description:
      'Agents the workspace may have, disabled ones included (L7). null = unlimited. Creating one past the limit answers 403 PLAN_LIMIT_REACHED with `details: { limit: "agents", used, max }`. Set by `PLAN_*_AGENTS`.',
  })
  agents: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 5,
    description:
      'Real phone numbers the workspace may hold (L7, assigned from Phase 5D). 0 on Free and Starter: they make browser test calls only. null = unlimited. Set by `PLAN_*_PHONE_NUMBERS`.',
  })
  phoneNumbers: number | null;

  @ApiPropertyOptional({
    description: 'Price: one extra conversation, minor units (chat, halted).',
  })
  overageConversationMinor?: number;

  @ApiPropertyOptional({
    description:
      'Price: one extra call minute, minor units (PKR 25 = 2500). Present only on plans that bill minutes past the included amount (Pro); the owner can switch that off (PATCH …/billing/settings).',
  })
  overageMinuteMinor?: number;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'Legacy price hint from Phase 2B. Nothing reads it; use `overageMinuteMinor`.',
  })
  voicePerMinuteMinor?: number;
}

export class OverageSettingsView {
  @ApiProperty({
    description:
      'The plan has a price for extra call minutes or extra conversations (Pro). Free and Starter do not: they always stop hard at the limit and the dashboard shows no switch. One switch governs both units.',
  })
  available: boolean;

  @ApiProperty({
    description:
      'Past the included call minutes (and conversations) the service keeps going and each extra unit is billed. Always false when `available` is false. Default true on plans that have a price; the owner switches it with PATCH /v1/tenants/:tenantId/billing/settings.',
  })
  enabled: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1500,
    description:
      'One extra conversation, minor units of `currency` (PKR 15 = 1500). null when the plan has no such price.',
  })
  priceMinor: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 2500,
    description:
      'One extra call minute, minor units of `currency` (PKR 25 = 2500). null when the plan has no such price.',
  })
  minutePriceMinor: number | null;

  @ApiProperty({ example: 'PKR' })
  currency: string;
}

export class SubscriptionSummary {
  @ApiProperty({ example: 'starter' })
  planCode: string;

  @ApiProperty({ example: 'Starter' })
  planName: string;

  @ApiProperty({
    enum: ['active', 'past_due', 'canceled', 'closed', 'suspended'],
    description:
      '`active` includes Starter and Free; `past_due` = a paid period ended unpaid (grace period); `canceled` = ends at period end.',
  })
  status: string;

  @ApiProperty({ enum: ['month', 'year', 'none'] })
  interval: string;

  @ApiProperty({ type: String, format: 'date-time' })
  currentPeriodStart: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'null = no end (Free).',
  })
  currentPeriodEnd: Date | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Whole days until the period ends (never negative). null = no end.',
  })
  daysLeft: number | null;

  @ApiProperty({
    description:
      'The plan ends at the period end and the tenant falls back to Free.',
  })
  cancelAtPeriodEnd: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'While `past_due`: when the grace period ends.',
  })
  graceEndsAt: Date | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'While `past_due`: whole days of grace left.',
  })
  graceDaysLeft: number | null;

  @ApiProperty({
    type: EntitlementsView,
    description: 'What the plan (plus any per-tenant override) allows.',
  })
  limits: EntitlementsView;

  @ApiProperty({
    type: OverageSettingsView,
    description: 'The overage setting of this plan and tenant (J6).',
  })
  overage: OverageSettingsView;
}

export class AdminSubscriptionSummary extends SubscriptionSummary {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'manual' })
  provider: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'Per-tenant entitlement overrides merged over the plan (custom contracts).',
  })
  entitlementsOverride: Record<string, unknown> | null;
}

export class InvoiceView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'INV-2026-000001',
    description: 'Sequential per year.',
  })
  number: string;

  @ApiProperty({ type: String, nullable: true })
  planCode: string | null;

  @ApiProperty({
    example: 1999900,
    description: 'Integer minor units of `currency` (PKR 19,999.00 = 1999900).',
  })
  amountMinor: number;

  @ApiProperty({ example: 'PKR' })
  currency: string;

  @ApiProperty({ enum: ['draft', 'open', 'paid', 'void'] })
  status: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  periodStart: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  periodEnd: Date | null;

  @ApiProperty({ type: String, nullable: true, example: 'bank_transfer' })
  method: string | null;

  @ApiProperty({ type: String, nullable: true })
  reference: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt: Date | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Extra conversations this payment covers, as recorded by the platform admin (J6). The invoice has no tax lines.',
  })
  overageCount: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'The part of `amountMinor` that is overage, minor units. null = none recorded.',
  })
  overageAmountMinor: number | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class AdminInvoiceView extends InvoiceView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The platform admin who recorded it.',
  })
  recordedBy: string | null;

  @ApiProperty({ type: String, nullable: true })
  providerInvoiceId: string | null;
}

export class BillingEventView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'payment.succeeded',
    description:
      'payment.succeeded, payment.failed, subscription.canceled, plan.changed, period.ended, period.extended, account.closed, tenant.suspended, tenant.unsuspended, subscription.created, overage.changed',
  })
  type: string;

  @ApiProperty({ enum: ['manual', 'provider', 'system'] })
  source: string;

  @ApiProperty({ type: String, nullable: true })
  provider: string | null;

  @ApiProperty({ type: String, nullable: true })
  providerEventId: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true })
  payload: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

class Page {
  @ApiProperty() total: number;
  @ApiProperty() skip: number;
  @ApiProperty() take: number;
}

export class InvoicePage extends Page {
  @ApiProperty({ type: [InvoiceView] })
  data: InvoiceView[];
}

export class AdminInvoicePage extends Page {
  @ApiProperty({ type: [AdminInvoiceView] })
  data: AdminInvoiceView[];
}

export class BillingEventPage extends Page {
  @ApiProperty({ type: [BillingEventView] })
  data: BillingEventView[];
}

export class ConversationUsageView {
  @ApiProperty({
    enum: ['month', 'total'],
    description:
      '`month` = the UTC calendar month, `total` = since the subscription period began (Starter).',
  })
  period: 'month' | 'total';

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Start of the counting window (a UTC day).',
  })
  periodStart: Date;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1500,
    description: 'Conversations included in the plan. null = unlimited.',
  })
  included: number | null;

  @ApiProperty({
    example: 1620,
    description:
      'Conversations started in the period (a conversation counts once).',
  })
  used: number;

  @ApiProperty({
    example: 120,
    description:
      'Extra conversations the AI answered past the included amount, billed at `overagePriceMinor`. 0 on plans without an overage price. Conversations that were handed to a human at the limit while overage was off are not counted.',
  })
  overageCount: number;

  @ApiProperty({
    example: 180000,
    description:
      '`overageCount` times `overagePriceMinor`, integer minor units.',
  })
  overageAmountMinor: number;

  @ApiProperty({ type: Number, nullable: true, example: 1500 })
  overagePriceMinor: number | null;

  @ApiProperty({ example: 'PKR' })
  currency: string;
}

export class CallMinuteUsageView {
  @ApiProperty({
    enum: ['month', 'total'],
    description:
      '`month` = the UTC calendar month, `total` = since the subscription period began (Starter).',
  })
  period: 'month' | 'total';

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Start of the counting window (a UTC day).',
  })
  periodStart: Date;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 300,
    description: 'Call minutes included in the plan. null = unlimited.',
  })
  included: number | null;

  @ApiProperty({
    example: 342,
    description:
      'Call minutes used in the period (whole minutes, from `usage_daily.call_minutes`; the engine reports them from Phase 5E on).',
  })
  used: number;

  @ApiProperty({
    example: 42,
    description:
      'Minutes used past the included amount, billed at `overagePriceMinor`. 0 on plans without a minute price. A call that was already running when the allowance ran out is not cut off, so its extra minutes are counted here even when overage is switched off.',
  })
  overageMinutes: number;

  @ApiProperty({
    example: 105000,
    description:
      '`overageMinutes` times `overagePriceMinor`, integer minor units.',
  })
  overageAmountMinor: number;

  @ApiProperty({ type: Number, nullable: true, example: 2500 })
  overagePriceMinor: number | null;

  @ApiProperty({ example: 'PKR' })
  currency: string;
}

export class CountUsageView {
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 3,
    description: 'What the plan allows. null = unlimited.',
  })
  included: number | null;

  @ApiProperty({ example: 1, description: 'What the workspace has now.' })
  used: number;
}

export class BillingUsageView {
  @ApiProperty({
    type: CallMinuteUsageView,
    description: 'Call minutes (L6): the product of the voice-first plans.',
  })
  callMinutes: CallMinuteUsageView;

  @ApiProperty({
    type: ConversationUsageView,
    description: 'Chat conversations (halted, kept as built).',
  })
  conversations: ConversationUsageView;

  @ApiProperty({
    type: CountUsageView,
    description:
      'Agents (L7): the limit and how many exist, disabled ones included.',
  })
  agents: CountUsageView;

  @ApiProperty({
    type: CountUsageView,
    description:
      'Real phone numbers (L7): the limit and how many are assigned (0 until Phase 5D).',
  })
  phoneNumbers: CountUsageView;
}

export class TenantBillingSettings {
  @ApiProperty({ type: SubscriptionSummary })
  subscription: SubscriptionSummary;

  @ApiProperty({ type: BillingUsageView })
  usage: BillingUsageView;
}

export class TenantBilling {
  @ApiProperty({ type: SubscriptionSummary })
  subscription: SubscriptionSummary;

  @ApiProperty({ type: BillingUsageView })
  usage: BillingUsageView;

  @ApiProperty({
    type: InvoicePage,
    description: 'Newest first; `skip` / `take` apply to this list.',
  })
  invoices: InvoicePage;
}

export class AdminTenantBilling {
  @ApiProperty({ type: AdminSubscriptionSummary })
  subscription: AdminSubscriptionSummary;

  @ApiProperty({ type: BillingUsageView })
  usage: BillingUsageView;

  @ApiProperty({
    type: AdminInvoicePage,
    description: 'Newest first; `skip` / `take` apply to this list.',
  })
  invoices: AdminInvoicePage;

  @ApiProperty({
    type: BillingEventPage,
    description: 'Newest first; `skip` / `take` apply to this list.',
  })
  events: BillingEventPage;
}

export class SubscriptionCommandResult {
  @ApiProperty({
    description:
      'False when the command changed nothing (already in the requested state).',
  })
  applied: boolean;

  @ApiProperty({
    description:
      'True when the same `idempotencyKey` was applied before: nothing was done.',
  })
  duplicate: boolean;

  @ApiProperty({ type: AdminSubscriptionSummary, nullable: true })
  subscription: AdminSubscriptionSummary | null;

  @ApiProperty({
    type: AdminInvoiceView,
    nullable: true,
    description: 'The invoice a payment created.',
  })
  invoice: AdminInvoiceView | null;
}

export class PlanView {
  @ApiProperty({ example: 'pro' })
  code: string;

  @ApiProperty({ example: 'Pro' })
  name: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1999900,
    description: 'Price per `interval` in minor units. null = custom quote.',
  })
  priceMinor: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 19999000,
    description: 'Price of a year when sold yearly too.',
  })
  yearlyPriceMinor: number | null;

  @ApiProperty({ example: 'PKR' })
  currency: string;

  @ApiProperty({ enum: ['month', 'year', 'none'] })
  interval: string;

  @ApiProperty({ type: EntitlementsView })
  entitlements: EntitlementsView;
}

export class PlanPage extends Page {
  @ApiProperty({ type: [PlanView] })
  data: PlanView[];
}
