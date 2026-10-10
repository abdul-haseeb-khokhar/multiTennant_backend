import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../../common/errors/api.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { MANUAL_PROVIDER } from '../billing.constants';
import type {
  AppliedEventType,
  BillingEventPayloads,
} from '../subscriptions/state-machine';
import type { BillingEventInput } from '../subscriptions/subscription.service';
import {
  BillingProvider,
  CancelInput,
  CheckoutInput,
  CheckoutSession,
  PortalInput,
  PortalSession,
} from './billing-provider';

const notImplemented = (what: string) =>
  new ApiException(
    HttpStatus.NOT_IMPLEMENTED,
    ErrorCode.NOT_IMPLEMENTED,
    `${what} is not available with manual billing: a platform admin records payments`,
  );

/**
 * The launch "provider": there is no external system. A platform admin records a payment or a
 * change through the admin API, and this class turns that into the same normalised event a real
 * provider's webhook would produce. Everything that needs an external payment system throws
 * `NOT_IMPLEMENTED` (501).
 */
@Injectable()
export class ManualProvider extends BillingProvider {
  readonly name = MANUAL_PROVIDER;

  createCheckout(_input: CheckoutInput): Promise<CheckoutSession> {
    return Promise.reject(notImplemented('Hosted checkout'));
  }

  createPortalSession(_input: PortalInput): Promise<PortalSession> {
    return Promise.reject(notImplemented('A customer portal'));
  }

  /** Nothing to stop outside this system: the platform applies the cancellation itself. */
  cancel(_input: CancelInput): Promise<void> {
    return Promise.resolve();
  }

  handleWebhook(): Promise<BillingEventInput[]> {
    return Promise.reject(notImplemented('Webhooks'));
  }

  /**
   * An admin action as a normalised event. `idempotencyKey` (optional, from the admin client)
   * becomes the provider event id, so a double click or a retried request is applied once; it is
   * scoped to the tenant so keys never collide across tenants.
   */
  event<T extends AppliedEventType>(
    tenantId: string,
    adminId: string,
    type: T,
    payload: BillingEventPayloads[T],
    idempotencyKey?: string,
  ): BillingEventInput {
    return {
      tenantId,
      type,
      payload,
      source: 'manual',
      provider: this.name,
      providerEventId: idempotencyKey ? `${tenantId}:${idempotencyKey}` : null,
      actor: { userId: adminId, role: 'platform_admin' },
    } as BillingEventInput;
  }
}
