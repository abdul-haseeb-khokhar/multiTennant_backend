import { PLAN_CATALOG_VARIABLE_NAMES } from '../src/billing/plan-catalog/plan-catalog.env';
// Environment for e2e tests. Set before AppModule is imported so env validation passes.
process.env.JWT_SECRET = 'e2e-test-secret-at-least-16-chars';
process.env.JWT_EXPIRES_IN = '1h';
process.env.DATABASE_URL = 'postgresql://unused:unused@localhost:5432/unused';
process.env.FRONTEND_URL = 'http://localhost:5173';
// Development mode that also returns emailed links in responses, so flows can be driven over HTTP.
process.env.MAIL_MODE = 'link';
// Shared secret of the engine event receiver (POST /internal/events), at least 32 characters.
process.env.INTERNAL_API_TOKEN = 'e2e-internal-token-0123456789abcdef-xyz';
// Engine: the in-process mock (the default), with instant tokens and a short first-token timeout so
// the "model never answers" case takes a fraction of a second.
process.env.ENGINE_FIRST_TOKEN_TIMEOUT_MS = '400';
process.env.MOCK_ENGINE_TOKEN_DELAY_MS = '0';
// Mail (H3): tests never send real email, whatever a developer keeps in `.env` (dotenv does not
// override variables that are already set, even to an empty string).
process.env.MAIL_PROVIDER = 'console';
for (const name of [
  'RESEND_API_KEY',
  'MAIL_FROM',
  'MAIL_FROM_NAME',
  'MAIL_REDIRECT_TO',
  'RESEND_API_URL',
]) {
  process.env[name] = '';
}
// Platform notifications (J5): a fixed test address, whatever a developer keeps in `.env`.
process.env.PLATFORM_ADMIN_NOTIFY_EMAIL = 'ops@platform.test';

// Plan catalogue (L6): the PLAN_* variables must not leak in from a developer .env, or the sync
// would change the plans the tests assert on (an empty value means "not set").
for (const name of PLAN_CATALOG_VARIABLE_NAMES) {
  process.env[name] = '';
}
