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

  @ApiProperty({ description: 'Phone calls included.' })
  voice: boolean;

  @ApiProperty({ description: 'The widget shows our "powered by" label.' })
  poweredByLabel: boolean;

  @ApiPropertyOptional({
    description: 'Price hint: one extra conversation, minor units.',
  })
  overageConversationMinor?: number;

  @ApiPropertyOptional({
    description: 'Price hint: one voice minute, minor units.',
  })
  voicePerMinuteMinor?: number;
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
      'payment.succeeded, payment.failed, subscription.canceled, plan.changed, period.ended, period.extended, account.closed, tenant.suspended, tenant.unsuspended, subscription.created',
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

export class TenantBilling {
  @ApiProperty({ type: SubscriptionSummary })
  subscription: SubscriptionSummary;

  @ApiProperty({
    type: InvoicePage,
    description: 'Newest first; `skip` / `take` apply to this list.',
  })
  invoices: InvoicePage;
}

export class AdminTenantBilling {
  @ApiProperty({ type: AdminSubscriptionSummary })
  subscription: AdminSubscriptionSummary;

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
