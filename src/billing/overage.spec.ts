import {
  overageAmountMinor,
  overageApplies,
  overagePrice,
  overageSettings,
} from './overage';

const limits = (over = {}) => ({
  seats: 10,
  conversationsPerPeriod: 1500,
  conversationPeriod: 'month' as const,
  knowledgeMb: 500,
  channels: ['chat'],
  voice: false,
  poweredByLabel: false,
  callMinutesPerPeriod: 300,
  callMinutePeriod: 'month' as const,
  ...over,
});

describe('overageSettings', () => {
  it('is available and enabled on a plan with a price when the owner left it on', () => {
    expect(
      overageSettings({
        entitlements: limits({ overageConversationMinor: 1500 }),
        currency: 'PKR',
        overageEnabled: true,
      }),
    ).toEqual({
      available: true,
      enabled: true,
      priceMinor: 1500,
      minutePriceMinor: null,
      currency: 'PKR',
    });
  });

  it('is available but not enabled when the owner switched it off', () => {
    expect(
      overageSettings({
        entitlements: limits({ overageConversationMinor: 1500 }),
        currency: 'PKR',
        overageEnabled: false,
      }),
    ).toMatchObject({ available: true, enabled: false, priceMinor: 1500 });
  });

  it('is neither available nor enabled without a price, whatever is stored', () => {
    expect(
      overageSettings({
        entitlements: limits(),
        currency: 'PKR',
        overageEnabled: true,
      }),
    ).toEqual({
      available: false,
      enabled: false,
      priceMinor: null,
      minutePriceMinor: null,
      currency: 'PKR',
    });
    expect(
      overageSettings({
        entitlements: limits({
          overageConversationMinor: 0,
          overageMinuteMinor: 0,
        }),
        currency: 'PKR',
        overageEnabled: true,
      }).available,
    ).toBe(false);
  });

  it('a price for call minutes alone makes the switch available (one switch governs both units)', () => {
    expect(
      overageSettings({
        entitlements: limits({ overageMinuteMinor: 2500 }),
        currency: 'PKR',
        overageEnabled: true,
      }),
    ).toEqual({
      available: true,
      enabled: true,
      priceMinor: null,
      minutePriceMinor: 2500,
      currency: 'PKR',
    });
  });
});

describe('overageApplies and overagePrice (per unit)', () => {
  const settings = (entitlements: object, overageEnabled = true) =>
    overageSettings({
      entitlements: limits(entitlements),
      currency: 'PKR',
      overageEnabled,
    });

  it('needs the switch AND the price of that very unit', () => {
    const onlyMinutes = settings({ overageMinuteMinor: 2500 });
    expect(overageApplies(onlyMinutes, 'callMinutes')).toBe(true);
    expect(overageApplies(onlyMinutes, 'conversations')).toBe(false);
    expect(overagePrice(onlyMinutes, 'callMinutes')).toBe(2500);
    expect(overagePrice(onlyMinutes, 'conversations')).toBeNull();

    const both = settings({
      overageMinuteMinor: 2500,
      overageConversationMinor: 1500,
    });
    expect(overageApplies(both, 'callMinutes')).toBe(true);
    expect(overageApplies(both, 'conversations')).toBe(true);
  });

  it('is false for both units when the owner switched overage off', () => {
    const off = settings(
      { overageMinuteMinor: 2500, overageConversationMinor: 1500 },
      false,
    );
    expect(overageApplies(off, 'callMinutes')).toBe(false);
    expect(overageApplies(off, 'conversations')).toBe(false);
  });

  it('is false without any price (Free, Starter)', () => {
    const none = settings({});
    expect(overageApplies(none, 'callMinutes')).toBe(false);
    expect(overageApplies(none, 'conversations')).toBe(false);
  });
});

describe('overageAmountMinor', () => {
  it('is an integer count times the price', () => {
    expect(overageAmountMinor(120, 1500)).toBe(180_000);
    expect(overageAmountMinor(0, 1500)).toBe(0);
  });
  it('is 0 without a price', () => {
    expect(overageAmountMinor(50, null)).toBe(0);
  });
});
