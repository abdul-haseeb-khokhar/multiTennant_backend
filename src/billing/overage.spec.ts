import { overageAmountMinor, overageSettings } from './overage';

const limits = (over = {}) => ({
  seats: 10,
  conversationsPerPeriod: 1500,
  conversationPeriod: 'month' as const,
  knowledgeMb: 500,
  channels: ['chat'],
  voice: false,
  poweredByLabel: false,
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
      currency: 'PKR',
    });
    expect(
      overageSettings({
        entitlements: limits({ overageConversationMinor: 0 }),
        currency: 'PKR',
        overageEnabled: true,
      }).available,
    ).toBe(false);
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
