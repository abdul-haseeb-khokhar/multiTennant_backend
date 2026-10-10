import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AllowedOrigins, normalizeOrigin } from './origin';

class Dto {
  @AllowedOrigins()
  origins: string[];
}

const check = (origins: unknown) => {
  const dto = plainToInstance(Dto, { origins });
  return { dto, errors: validateSync(dto) };
};

describe('normalizeOrigin', () => {
  it.each([
    ['https://shop.example.com', 'https://shop.example.com'],
    ['HTTPS://Shop.Example.COM', 'https://shop.example.com'],
    ['https://shop.example.com/', 'https://shop.example.com'],
    ['https://shop.example.com:443', 'https://shop.example.com'],
    ['https://shop.example.com:8443', 'https://shop.example.com:8443'],
    ['  https://shop.example.com  ', 'https://shop.example.com'],
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://127.0.0.1:3001', 'http://127.0.0.1:3001'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
    ['http://app.localhost:3000', 'http://app.localhost:3000'],
  ])('accepts %s as %s', (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it.each([
    ['a wildcard host', 'https://*.example.com'],
    ['a bare wildcard', '*'],
    ['a path', 'https://shop.example.com/chat'],
    ['a query', 'https://shop.example.com?x=1'],
    ['a bare question mark', 'https://shop.example.com?'],
    ['a fragment', 'https://shop.example.com#top'],
    ['credentials', 'https://user:pass@shop.example.com'],
    ['plain http on a real host', 'http://shop.example.com'],
    ['another scheme', 'ftp://shop.example.com'],
    ['a javascript url', 'javascript:alert(1)'],
    ['the literal null origin', 'null'],
    ['an empty string', ''],
    ['not a url', 'shop.example.com'],
    ['a number', 42],
    ['undefined', undefined],
    ['an over-long value', `https://${'a'.repeat(300)}.com`],
  ])('refuses %s', (_label, input) => {
    expect(normalizeOrigin(input)).toBeNull();
  });
});

describe('@AllowedOrigins', () => {
  it('normalises, de-duplicates and accepts a good list (also an empty one)', () => {
    const { dto, errors } = check([
      'https://Shop.example.com/',
      'https://shop.example.com',
      'http://localhost:5173',
    ]);
    expect(errors).toHaveLength(0);
    expect(dto.origins).toEqual([
      'https://shop.example.com',
      'http://localhost:5173',
    ]);
    expect(check([]).errors).toHaveLength(0);
  });

  it('rejects an invalid entry, a non-array and more than 20 entries', () => {
    expect(
      check(['https://ok.example.com', 'https://*.example.com']).errors,
    ).not.toHaveLength(0);
    expect(check('https://shop.example.com').errors).not.toHaveLength(0);
    const many = Array.from(
      { length: 21 },
      (_, i) => `https://s${i}.example.com`,
    );
    expect(check(many).errors).not.toHaveLength(0);
    expect(check(many.slice(0, 20)).errors).toHaveLength(0);
  });
});
