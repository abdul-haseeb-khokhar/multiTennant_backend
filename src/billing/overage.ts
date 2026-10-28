import type { Entitlements } from './entitlements/entitlements';

/**
 * Overage (J6, extended to call minutes by L6): on a plan with an overage price (Pro) the tenant may
 * let the service keep going after the included amount is used up, each extra unit billed at the
 * plan's price. ONE switch per tenant, `subscriptions.overage_enabled` (default on), governs both
 * units; the prices are the entitlements `overageConversationMinor` (an extra chat conversation,
 * chat is halted) and `overageMinuteMinor` (an extra call minute). Plans without a price (Free,
 * Starter) always stop hard.
 */
export type OverageUnit = 'conversations' | 'callMinutes';

export interface OverageSettings {
  /**
   * The plan (with the tenant's override) has an overage price for at least one unit, so the owner
   * has a choice to make and the dashboard shows the switch.
   */
  available: boolean;
  /**
   * Past the included amount the service keeps going and the extras are billed. Always false when
   * `available` is false, whatever the stored choice is. Whether it applies to a given unit also
   * needs that unit's price: use `overageApplies`.
   */
  enabled: boolean;
  /** One extra conversation, minor units of `currency`; null when the plan has no such price. */
  priceMinor: number | null;
  /** One extra call minute, minor units of `currency`; null when the plan has no such price. */
  minutePriceMinor: number | null;
  currency: string;
}

function price(value: number | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}

export function overageSettings(subscription: {
  entitlements: Entitlements;
  currency: string;
  overageEnabled: boolean;
}): OverageSettings {
  const conversationPrice = price(
    subscription.entitlements.overageConversationMinor,
  );
  const minutePrice = price(subscription.entitlements.overageMinuteMinor);
  const available = conversationPrice !== null || minutePrice !== null;
  return {
    available,
    enabled: available && subscription.overageEnabled,
    priceMinor: conversationPrice,
    minutePriceMinor: minutePrice,
    currency: subscription.currency,
  };
}

/** The price of one extra unit, or null when the plan has none for it. */
export function overagePrice(
  settings: OverageSettings,
  unit: OverageUnit,
): number | null {
  return unit === 'callMinutes'
    ? settings.minutePriceMinor
    : settings.priceMinor;
}

/** The service continues past the included amount of this unit: the owner left overage on AND the plan prices this unit. */
export function overageApplies(
  settings: OverageSettings,
  unit: OverageUnit,
): boolean {
  return settings.enabled && overagePrice(settings, unit) !== null;
}

/** The overage figures of one period; `amountMinor` is always `count * price` (integers, never floats). */
export function overageAmountMinor(count: number, priceMinor: number | null) {
  return priceMinor === null ? 0 : count * priceMinor;
}
