import { generateToken, hashToken } from './tokens';

describe('tokens', () => {
  it('makes a 32-byte url-safe token and stores only its sha256', () => {
    const { token, tokenHash } = generateToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).not.toContain(token);
  });

  it('never repeats', () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => generateToken().token),
    );
    expect(seen.size).toBe(200);
  });

  it('hashes deterministically and differently per token', () => {
    expect(hashToken('a')).toBe(hashToken('a'));
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});
