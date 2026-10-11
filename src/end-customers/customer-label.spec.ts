import { customerLabel, displayExternalId } from './customer-label';

describe('displayExternalId', () => {
  it("shortens an anonymous visitor's id: the full one is that visitor's secret", () => {
    const visitor = 'f3a91c0d-7b2e-4c55-9a10-0123456789ab';
    const shown = displayExternalId(`web_${visitor}`);
    expect(shown).toBe('web_f3a91c…');
    expect(shown).not.toContain(visitor.slice(6));
  });

  it('shows a phone number or a tenant-supplied id as it is', () => {
    expect(displayExternalId('+923001234567')).toBe('+923001234567');
    expect(displayExternalId('cust-0042')).toBe('cust-0042');
  });

  it('handles a very short visitor id', () => {
    expect(displayExternalId('web_ab')).toBe('web_ab…');
  });
});

describe('customerLabel', () => {
  it('prefers the name, else the shortened id', () => {
    expect(
      customerLabel({ name: 'Sana Malik', externalId: 'web_abcdefgh' }),
    ).toBe('Sana Malik');
    expect(customerLabel({ name: '  ', externalId: 'web_abcdefgh' })).toBe(
      'web_abcdef…',
    );
    expect(customerLabel({ name: null, externalId: '+92300' })).toBe('+92300');
  });
});
