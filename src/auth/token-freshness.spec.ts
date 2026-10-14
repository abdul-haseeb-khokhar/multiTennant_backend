import { wasIssuedBefore } from './token-freshness';

describe('wasIssuedBefore', () => {
  const instant = new Date('2026-10-11T10:00:30.500Z');
  const sec = Math.floor(instant.getTime() / 1000);

  describe('tokens with iatMs (every token since Phase 3C)', () => {
    it('refuses a token issued before the instant, to the millisecond', () => {
      expect(wasIssuedBefore({ iatMs: instant.getTime() - 1 }, instant)).toBe(
        true,
      );
      expect(
        wasIssuedBefore({ iatMs: instant.getTime() - 60_000 }, instant),
      ).toBe(true);
    });

    it('refuses a token issued in the very same millisecond (it cannot be a login that came after)', () => {
      expect(wasIssuedBefore({ iatMs: instant.getTime() }, instant)).toBe(true);
    });

    it('accepts a login in the same SECOND but after the instant (logout then login at once)', () => {
      expect(
        wasIssuedBefore({ iat: sec, iatMs: instant.getTime() + 120 }, instant),
      ).toBe(false);
    });

    it('refuses a token from the same second that was issued before the instant', () => {
      // The whole-second claim alone could not tell these two apart.
      expect(
        wasIssuedBefore({ iat: sec, iatMs: instant.getTime() - 400 }, instant),
      ).toBe(true);
    });

    it('prefers iatMs over iat', () => {
      expect(
        wasIssuedBefore(
          { iat: sec - 100, iatMs: instant.getTime() + 5 },
          instant,
        ),
      ).toBe(false);
    });
  });

  describe('older tokens that only have iat (whole seconds)', () => {
    it('refuses a token from an earlier second', () => {
      expect(wasIssuedBefore({ iat: sec - 1 }, instant)).toBe(true);
    });

    it('accepts a token from the same second or later (keeps a same-second login working)', () => {
      expect(wasIssuedBefore({ iat: sec }, instant)).toBe(false);
      expect(wasIssuedBefore({ iat: sec + 30 }, instant)).toBe(false);
    });
  });

  it('refuses a token that carries neither claim', () => {
    expect(wasIssuedBefore({}, instant)).toBe(true);
  });
});
