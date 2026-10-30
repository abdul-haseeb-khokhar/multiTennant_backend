// Environment for the database-backed suite (`npm run test:db`).
//
// It talks to a REAL Postgres and leaves its data behind (tenants cannot be deleted: foreign keys
// are RESTRICT and the audit log is append-only), so it only ever uses TEST_DATABASE_URL, never
// DATABASE_URL, and refuses the databases that matter.
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    'Set TEST_DATABASE_URL to a throwaway Postgres that already has the migrations applied ' +
      '(see test/README.md). This suite never reads DATABASE_URL.',
  );
}
const database = new URL(url).pathname.replace(/^\//, '');
if (['multitenant', 'caller-ai-agent', 'postgres'].includes(database)) {
  throw new Error(
    `Refusing to run the database tests against "${database}": use a disposable database.`,
  );
}

process.env.DATABASE_URL = url;
process.env.JWT_SECRET = 'db-test-secret-at-least-16-chars';
process.env.JWT_EXPIRES_IN = '1h';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.MAIL_MODE = 'link';
process.env.INTERNAL_API_TOKEN = 'db-internal-token-0123456789abcdef-xyz';
process.env.ENGINE_FIRST_TOKEN_TIMEOUT_MS = '400';
process.env.MOCK_ENGINE_TOKEN_DELAY_MS = '0';
// Mail (H3): the database suite never sends real email, whatever `.env` holds.
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
