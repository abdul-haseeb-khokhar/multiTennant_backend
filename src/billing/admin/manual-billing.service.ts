import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../../common/errors/api.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { BillingEventType } from '../billing.constants';
import { validateOverride } from '../entitlements/entitlements';
import { BillingProviders } from '../providers/billing-providers';
import { ManualProvider } from '../providers/manual.provider';
import {
  ApplyResult,
  BillingEventInput,
  SubscriptionService,
} from '../subscriptions/subscription.service';
import { TenantBillingService } from '../tenant/tenant-billing.service';
import { toAdminInvoiceView, toAdminSubscriptionSummary } from '../views';
import {
  ActivateSubscriptionDto,
  CancelSubscriptionDto,
  ChangePlanDto,
  ExtendSubscriptionDto,
  RecordPaymentDto,
} from './dto/subscription-commands.dto';

/**
 * The platform admin's billing commands (I6). Each one becomes a normalised event from the
 * `ManualProvider` and goes through the same `SubscriptionService.applyEvent` a payment
 * provider's webhook will use, so it is audited, idempotent and mirrored the same way.
 */
@Injectable()
export class ManualBillingService {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly providers: BillingProviders,
    private readonly manual: ManualProvider,
    private readonly billing: TenantBillingService,
  ) {}

  async activate(
    tenantId: string,
    adminId: string,
    dto: ActivateSubscriptionDto,
  ) {
    return this.run(
      tenantId,
      this.manual.event(
        tenantId,
        adminId,
        BillingEventType.PAYMENT_SUCCEEDED,
        {
          planCode: dto.planCode,
          amountMinor: dto.amountMinor,
          currency: dto.currency,
          interval: dto.interval,
          periodEnd: dto.periodEnd,
          method: dto.method,
          reference: dto.reference,
          entitlementsOverride: this.override(dto.entitlementsOverride),
        },
        dto.idempotencyKey,
      ),
    );
  }

  /** A renewal of the current paid plan. */
  async recordPayment(
    tenantId: string,
    adminId: string,
    dto: RecordPaymentDto,
  ) {
    return this.run(
      tenantId,
      this.manual.event(
        tenantId,
        adminId,
        BillingEventType.PAYMENT_SUCCEEDED,
        {
          amountMinor: dto.amountMinor,
          currency: dto.currency,
          interval: dto.interval,
          periodEnd: dto.periodEnd,
          method: dto.method,
          reference: dto.reference,
        },
        dto.idempotencyKey,
      ),
    );
  }

  async extend(tenantId: string, adminId: string, dto: ExtendSubscriptionDto) {
    return this.run(
      tenantId,
      this.manual.event(
        tenantId,
        adminId,
        BillingEventType.PERIOD_EXTENDED,
        { until: dto.until, days: dto.days },
        dto.idempotencyKey,
      ),
    );
  }

  async changePlan(tenantId: string, adminId: string, dto: ChangePlanDto) {
    return this.run(
      tenantId,
      this.manual.event(
        tenantId,
        adminId,
        BillingEventType.PLAN_CHANGED,
        {
          planCode: dto.planCode,
          interval: dto.interval,
          periodEnd: dto.periodEnd,
          entitlementsOverride: this.override(dto.entitlementsOverride),
        },
        dto.idempotencyKey,
      ),
    );
  }

  async cancel(tenantId: string, adminId: string, dto: CancelSubscriptionDto) {
    await this.billing.assertTenantExists(tenantId);
    const current = await this.subscriptions.getEffective(tenantId);
    if (current) {
      // Stops renewals on the provider's side first; for manual billing there is nothing to stop.
      await this.providers.get(current.provider).cancel({
        tenantId,
        providerSubscriptionId: null,
        atPeriodEnd: dto.atPeriodEnd ?? true,
      });
    }
    return this.run(
      tenantId,
      this.manual.event(
        tenantId,
        adminId,
        BillingEventType.SUBSCRIPTION_CANCELED,
        { atPeriodEnd: dto.atPeriodEnd ?? true },
        dto.idempotencyKey,
      ),
    );
  }

  // -------------------------------------------------------------------------------------------

  private override(value: Record<string, unknown> | undefined) {
    if (value === undefined) return undefined;
    const checked = validateOverride(value);
    if (!checked.ok) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        checked.error,
      );
    }
    return checked.value;
  }

  private async run(tenantId: string, event: BillingEventInput) {
    await this.billing.assertTenantExists(tenantId);
    const result = await this.subscriptions.applyEvent(event);
    return this.toResponse(tenantId, result);
  }

  private async toResponse(tenantId: string, result: ApplyResult) {
    const subscription = await this.subscriptions.getEffective(tenantId);
    return {
      applied: result.applied,
      duplicate: result.duplicate,
      subscription: subscription
        ? toAdminSubscriptionSummary(subscription)
        : null,
      invoice: result.invoice ? toAdminInvoiceView(result.invoice) : null,
    };
  }
}
