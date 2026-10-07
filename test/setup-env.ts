// Environment for e2e tests. Set before AppModule is imported so env validation passes.
process.env.JWT_SECRET = 'e2e-test-secret-at-least-16-chars';
process.env.JWT_EXPIRES_IN = '1h';
process.env.DATABASE_URL = 'postgresql://unused:unused@localhost:5432/unused';
process.env.FRONTEND_URL = 'http://localhost:5173';
