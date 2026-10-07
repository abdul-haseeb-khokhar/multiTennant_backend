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
});
