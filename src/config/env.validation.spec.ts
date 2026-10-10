import { validateEnv } from './env.validation';

const engine = {
  ENGINE_MODE: 'http',
  ENGINE_BASE_URL: 'http://engine.internal:4000',
  INTERNAL_API_TOKEN: 'x'.repeat(40),
};

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'a-secret-with-at-least-16-chars',
};

describe('validateEnv', () => {
  it('accepts the minimum configuration and fills in defaults', () => {
    const env = validateEnv(valid);
    expect(env).toMatchObject({
      ...valid,
      JWT_EXPIRES_IN: '1d',
      PLATFORM_JWT_EXPIRES_IN: '1h',
      PORT: 3000,
      NODE_ENV: 'development',
      MAIL_MODE: 'console',
    });
  });

  it('fails fast when JWT_SECRET is missing', () => {
    expect(() => validateEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('fails fast when JWT_SECRET is too short or empty', () => {
    expect(() => validateEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(
      /JWT_SECRET/,
    );
    expect(() => validateEnv({ ...valid, JWT_SECRET: '' })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => validateEnv({ JWT_SECRET: valid.JWT_SECRET })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('never puts a secret value in the error message', () => {
    expect(() =>
      validateEnv({ ...valid, JWT_SECRET: 'short-secret', PORT: 'abc' }),
    ).toThrow(
      expect.not.objectContaining({
        message: expect.stringContaining('short-secret'),
      }),
    );
  });

  it('validates PORT, FRONTEND_URL and NODE_ENV', () => {
    expect(validateEnv({ ...valid, PORT: '8080' })).toMatchObject({
      PORT: 8080,
    });
    expect(() => validateEnv({ ...valid, PORT: '70000' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...valid, FRONTEND_URL: 'not a url' })).toThrow(
      /FRONTEND_URL/,
    );
    expect(
      validateEnv({ ...valid, FRONTEND_URL: 'http://localhost:5173' }),
    ).toBeDefined();
    expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });

  describe('MAIL_MODE (H3)', () => {
    it('accepts console and link outside production', () => {
      expect(validateEnv({ ...valid, MAIL_MODE: 'link' })).toMatchObject({
        MAIL_MODE: 'link',
      });
      expect(
        validateEnv({ ...valid, NODE_ENV: 'test', MAIL_MODE: 'link' }),
      ).toMatchObject({ MAIL_MODE: 'link' });
    });

    it('refuses an unknown mode', () => {
      expect(() => validateEnv({ ...valid, MAIL_MODE: 'smtp' })).toThrow(
        /MAIL_MODE/,
      );
    });

    it('refuses MAIL_MODE=link when NODE_ENV=production, so a link never leaks into a live response', () => {
      expect(() =>
        validateEnv({
          ...valid,
          NODE_ENV: 'production',
          FRONTEND_URL: 'https://app.example.com',
          MAIL_MODE: 'link',
        }),
      ).toThrow(/MAIL_MODE=link is not allowed/);
    });

    it('allows the console mode in production, with FRONTEND_URL set', () => {
      expect(
        validateEnv({
          ...valid,
          NODE_ENV: 'production',
          FRONTEND_URL: 'https://app.example.com',
          ...engine,
        }),
      ).toMatchObject({ NODE_ENV: 'production', MAIL_MODE: 'console' });
    });

    it('requires FRONTEND_URL in production because emailed links point at it', () => {
      expect(() => validateEnv({ ...valid, NODE_ENV: 'production' })).toThrow(
        /FRONTEND_URL is required/,
      );
    });

    it('the billing job is on by default, hourly, and configurable', () => {
      expect(validateEnv(valid)).toMatchObject({
        BILLING_JOB: 'on',
        BILLING_JOB_INTERVAL_MINUTES: 60,
      });
      expect(
        validateEnv({
          ...valid,
          BILLING_JOB: 'off',
          BILLING_JOB_INTERVAL_MINUTES: '15',
        }),
      ).toMatchObject({ BILLING_JOB: 'off', BILLING_JOB_INTERVAL_MINUTES: 15 });
    });

    it.each([
      { BILLING_JOB: 'maybe' },
      { BILLING_JOB_INTERVAL_MINUTES: '0' },
      { BILLING_JOB_INTERVAL_MINUTES: '5000' },
    ])('refuses a bad billing job setting %j', (bad) => {
      expect(() => validateEnv({ ...valid, ...bad })).toThrow(
        /Invalid environment configuration/,
      );
    });
  });

  describe('ENGINE_MODE (Phase 3)', () => {
    it('defaults to the mock engine outside production and leaves the timeouts at the D7 values', () => {
      const env = validateEnv(valid);
      expect(env.ENGINE_MODE).toBeUndefined();
      expect(env).toMatchObject({
        ENGINE_FIRST_TOKEN_TIMEOUT_MS: 5000,
        ENGINE_TOTAL_TIMEOUT_MS: 30000,
        ENGINE_REQUEST_TIMEOUT_MS: 10000,
      });
      expect(validateEnv({ ...valid, ENGINE_MODE: 'mock' })).toMatchObject({
        ENGINE_MODE: 'mock',
      });
    });

    it('refuses to start in production without ENGINE_MODE=http, so the mock can never answer real customers', () => {
      const prod = {
        ...valid,
        NODE_ENV: 'production',
        FRONTEND_URL: 'https://app.example.com',
      };
      expect(() => validateEnv(prod)).toThrow(/ENGINE_MODE=http is required/);
      expect(() => validateEnv({ ...prod, ENGINE_MODE: 'mock' })).toThrow(
        /ENGINE_MODE=http is required/,
      );
      expect(validateEnv({ ...prod, ...engine })).toMatchObject({
        ENGINE_MODE: 'http',
      });
    });

    it('needs the engine address and the service token for ENGINE_MODE=http', () => {
      expect(() => validateEnv({ ...valid, ENGINE_MODE: 'http' })).toThrow(
        /ENGINE_BASE_URL is required.*INTERNAL_API_TOKEN is required/,
      );
      expect(() =>
        validateEnv({
          ...valid,
          ENGINE_MODE: 'http',
          ENGINE_BASE_URL: 'http://engine.internal:4000',
          INTERNAL_API_TOKEN: 'short',
        }),
      ).toThrow(/INTERNAL_API_TOKEN/);
    });

    it('never puts the service token in an error message', () => {
      expect(() =>
        validateEnv({
          ...valid,
          ENGINE_MODE: 'http',
          INTERNAL_API_TOKEN: 'secret-token-value-that-is-long-enough-123',
        }),
      ).toThrow(
        expect.not.objectContaining({
          message: expect.stringContaining('secret-token-value'),
        }),
      );
    });

    it.each([
      { ENGINE_MODE: 'grpc' },
      { ENGINE_BASE_URL: 'not a url' },
      { ENGINE_FIRST_TOKEN_TIMEOUT_MS: '5' },
      { ENGINE_TOTAL_TIMEOUT_MS: '999999999' },
    ])('refuses a bad engine setting %j', (bad) => {
      expect(() => validateEnv({ ...valid, ...bad })).toThrow(
        /Invalid environment configuration/,
      );
    });
  });
});
