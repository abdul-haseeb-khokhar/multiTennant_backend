import { validateEnv } from './env.validation';
import { parseTrustProxy } from './trust-proxy';

describe('parseTrustProxy', () => {
  it.each([undefined, '', ' ', 'false', '0', 'off', 'No', 'FALSE'])(
    'trusts nobody for %p',
    (value) => {
      expect(parseTrustProxy(value)).toBe(false);
    },
  );

  it('takes a number of hops', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
    expect(parseTrustProxy('10')).toBe(10);
  });

  it.each(['11', '100'])('refuses %s hops', (value) => {
    expect(() => parseTrustProxy(value)).toThrow('between 1 and 10');
  });

  it('refuses "true": it would trust a header any client can forge', () => {
    expect(() => parseTrustProxy('true')).toThrow('not allowed');
  });

  it('takes addresses, CIDR ranges and Express names', () => {
    expect(parseTrustProxy('10.0.0.0/8, loopback ,::1')).toEqual([
      '10.0.0.0/8',
      'loopback',
      '::1',
    ]);
    expect(parseTrustProxy('uniquelocal')).toEqual(['uniquelocal']);
  });

  it.each(['example.com', '10.0.0.0/33', '10.0.0.0/8/1', '1.2.3', 'x,y', ',,'])(
    'refuses %p',
    (value) => {
      expect(() => parseTrustProxy(value)).toThrow('TRUST_PROXY');
    },
  );
});

describe('TRUST_PROXY in the environment', () => {
  const env = {
    DATABASE_URL: 'postgresql://x',
    JWT_SECRET: 'a-secret-of-16-chars-or-more',
  };

  it('is optional', () => {
    expect(() => validateEnv(env)).not.toThrow();
  });

  it('a valid value boots', () => {
    expect(validateEnv({ ...env, TRUST_PROXY: '1' })).toMatchObject({
      TRUST_PROXY: '1',
    });
  });

  it('a bad value stops the boot and names the variable, not a value', () => {
    expect(() => validateEnv({ ...env, TRUST_PROXY: 'true' })).toThrow(
      /TRUST_PROXY/,
    );
    expect(() => validateEnv({ ...env, TRUST_PROXY: 'whatever' })).toThrow(
      /TRUST_PROXY/,
    );
  });
});
