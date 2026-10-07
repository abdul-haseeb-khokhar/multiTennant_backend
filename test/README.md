# Tests

| Command            | What it runs                                                                                                                                                                                         | Needs a database         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `npm test`         | Unit specs next to the code (`src/**/*.spec.ts`): services, guards, strategies, filter, helpers, controllers. Prisma is a `jest.fn()` mock.                                                          | no                       |
| `npm run test:e2e` | `test/*.e2e-spec.ts`: boots the real `AppModule` with the same prefix, pipes, filter and CORS as production (`configureApp`) and calls it over HTTP with supertest. **Prisma is replaced by mocks.** | no                       |
| `npm run test:db`  | `test/db/*.db-spec.ts`: the same real `AppModule` over HTTP with **real Prisma** against a throwaway Postgres: account flows, constraints, the audit trigger, the last-owner race.                   | yes, `TEST_DATABASE_URL` |

## What the mocked e2e suite proves, and what it cannot

It proves the HTTP layer: `/v1` routing, authentication, `403 TENANT_MISMATCH` when a token's tenant differs from the URL, `403 TENANT_SUSPENDED`, the role matrix (`INSUFFICIENT_ROLE`, `OWNER_REQUIRED`, `LAST_OWNER`), disabled/deleted/stale tokens, error body shape, pagination envelope and limits, request ids, CORS, i18n caching headers and the OpenAPI document. It also asserts which `where` clause each route sends to Prisma, so a missing `tenantId` shows up as a failing test.

It does **not** run SQL, so unique constraints, foreign keys, triggers, transactions and migrations are not covered here. That is what `npm run test:db` and the CI job `migrations` are for.

## The database-backed suite (`npm run test:db`)

It drives the whole account lifecycle through HTTP (signup, verify, invite, accept, disable, demote, delete, password reset, audit log, platform-admin suspension, tenant isolation) and checks database guarantees directly (lower-case email CHECK constraint, append-only `audit_logs`, cascade of reset/verification rows, two owners demoting each other at the same moment).

It leaves its data behind: tenants cannot be deleted (foreign keys are `RESTRICT`, the audit log is append-only), and every run uses fresh random names so runs do not collide. So **always use a disposable database**:

```bash
docker run -d --name mt-scratch -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app -p 55433:5432 postgres:16
DATABASE_URL=postgresql://postgres:postgres@localhost:55433/app npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55433/app npm run test:db
docker rm -f mt-scratch
```

The suite reads only `TEST_DATABASE_URL` (never `DATABASE_URL`) and refuses databases named `multitenant`, `caller-ai-agent` or `postgres`. CI runs it in the `migrations` job against the Postgres service that job creates and throws away.

Never use `prisma migrate reset` or `db push` for any of this: the development database is shared with the AI engine project.

## Helpers

- `utils/prisma-mock.ts`: `createPrismaMock()`, `mockTransaction(prisma)` (runs `$transaction` callbacks against the same mock) and `prismaError('P2002')` (a real `PrismaClientKnownRequestError`). The mocks do not apply `omit`: a mock that echoes `create` data must strip hashes itself.
- `utils/test-app.ts`: `createTestApp()` returns the app, the Prisma mock and helpers: `staffToken(user, record?, iat?)` registers the user in a small directory (active and verified unless `record` says otherwise), `allowStaff()` installs the `tenantUser.findUnique` stub that answers `JwtStrategy` from that directory (call it in `beforeEach` after `jest.resetAllMocks()`), and `platformToken`.
- `setup-env.ts`: sets `JWT_SECRET`, `MAIL_MODE=link` and friends before `AppModule` is imported (env validation runs at import time).
- `db/setup-db-env.ts`: the same for the database suite, plus the safety checks above.
