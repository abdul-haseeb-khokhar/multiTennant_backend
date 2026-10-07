import { validateEnv } from './env.validation';

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
        }),
      ).toMatchObject({ NODE_ENV: 'production', MAIL_MODE: 'console' });
    });

    it('requires FRONTEND_URL in production because emailed links point at it', () => {
      expect(() => validateEnv({ ...valid, NODE_ENV: 'production' })).toThrow(
        /FRONTEND_URL is required/,
      );
    });
  });
});
