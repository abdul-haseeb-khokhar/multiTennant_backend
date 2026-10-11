import type { Entitlements } from './entitlements/entitlements';

/**
 * Overage (J6): on a plan with an overage price (Pro) the tenant may let the AI keep answering after
 * the included conversations are used up, each extra one billed at the plan's price. The tenant's
 * choice is `subscriptions.overage_enabled` (default on); the price is the entitlement
 * `overageConversationMinor`. Plans without a price (Free, Starter) always stop hard.
 */
export interface OverageSettings {
  /** The plan (with the tenant's override) has an overage price. */
  available: boolean;
  /**
   * Past the included conversations the AI keeps answering and the extras are billed. Always false
   * when `available` is false, whatever the stored choice is.
   */
  enabled: boolean;
  /** One extra conversation, minor units of `currency`; null when not available. */
  priceMinor: number | null;
  currency: string;
}

export function overageSettings(subscription: {
  entitlements: Entitlements;
  currency: string;
  overageEnabled: boolean;
}): OverageSettings {
  const price = subscription.entitlements.overageConversationMinor;
  const available = typeof price === 'number' && price > 0;
  return {
    available,
    enabled: available && subscription.overageEnabled,
    priceMinor: available ? price : null,
    currency: subscription.currency,
  };
}

/** The overage figures of one period; `amountMinor` is always `count * price` (integers, never floats). */
export function overageAmountMinor(count: number, priceMinor: number | null) {
  return priceMinor === null ? 0 : count * priceMinor;
}
