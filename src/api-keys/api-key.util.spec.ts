import { hashToken } from '../common/tokens/tokens';
import { generateApiKey, hashApiKey, looksLikeWidgetKey } from './api-key.util';

describe('api key helpers', () => {
  it('makes a widget key with a prefix, a display prefix and the sha256 of the key', () => {
    const { key, keyHash, keyPrefix } = generateApiKey('widget');
    expect(key).toMatch(/^wk_[A-Za-z0-9_-]{32}$/);
    expect(keyPrefix).toBe(key.slice(0, 8));
    expect(keyHash).toBe(hashToken(key));
    expect(keyHash).toBe(hashApiKey(key));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('makes a longer server key and never repeats', () => {
    const server = generateApiKey('server');
    expect(server.key).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
    const keys = new Set(
      Array.from({ length: 50 }, () => generateApiKey('widget').key),
    );
    expect(keys.size).toBe(50);
  });

  it('the stored hash does not contain the key', () => {
    const { key, keyHash, keyPrefix } = generateApiKey('widget');
    expect(keyHash).not.toContain(key.slice(3));
    expect(keyPrefix.length).toBeLessThan(key.length);
  });

  it('recognises the shape of a widget key only', () => {
    expect(looksLikeWidgetKey(generateApiKey('widget').key)).toBe(true);
    expect(looksLikeWidgetKey(generateApiKey('server').key)).toBe(false);
    expect(looksLikeWidgetKey('wk_short')).toBe(false);
    expect(looksLikeWidgetKey('')).toBe(false);
    expect(looksLikeWidgetKey(undefined)).toBe(false);
    expect(looksLikeWidgetKey({ toString: () => 'wk_x' })).toBe(false);
  });
});
