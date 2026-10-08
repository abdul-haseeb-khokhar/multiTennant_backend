import type { BillingInterval } from '../billing.constants';
import type { BillingEventInput } from '../subscriptions/subscription.service';

export interface CheckoutInput {
  tenantId: string;
  planCode: string;
  interval?: Exclude<BillingInterval, 'none'>;
  successUrl?: string;
  cancelUrl?: string;
}

export interface CheckoutSession {
  /** Where to send the customer to pay (a hosted page: card data never reaches our servers). */
  url: string;
  providerSessionId?: string;
}

export interface PortalInput {
  tenantId: string;
  returnUrl?: string;
}

export interface PortalSession {
  url: string;
}

export interface CancelInput {
  tenantId: string;
  providerSubscriptionId: string | null;
  atPeriodEnd: boolean;
}

/**
 * The whole contract between the billing core and a payment source (I4). A provider turns what
 * happens on its side into normalised `BillingEventInput`s; the state machine, the tables, the
 * enforcement and the screens never learn which provider took the money. Adding one must not
 * change any of them.
 *
 * `handleWebhook` receives the raw, unparsed body and the headers so the provider can verify the
 * signature itself, and returns the events to apply (each with a `providerEventId`, which makes
 * redelivery harmless).
 */
export abstract class BillingProvider {
  /** Stored in `subscriptions.provider` and `billing_events.provider`. */
  abstract readonly name: string;

  abstract createCheckout(input: CheckoutInput): Promise<CheckoutSession>;

  abstract createPortalSession(input: PortalInput): Promise<PortalSession>;

  /** Stops renewals on the provider's side. The caller applies the matching `subscription.canceled` event. */
  abstract cancel(input: CancelInput): Promise<void>;

  abstract handleWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BillingEventInput[]>;
}
