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

## Billing tests

- `src/billing/subscriptions/state-machine.spec.ts`: every transition as a table with explicit dates (the pure state machine, no database).
- `src/billing/subscriptions/subscription.service.spec.ts`: idempotency, the single transaction, mirrors, audit and lazy transitions against a mocked Prisma.
- `billing.e2e-spec.ts`: the HTTP side with the mocked database made stateful by `utils/billing-fixtures.ts` (`installBilling`): roles, tenant isolation, the pricing list, the whole Starter-to-Free and past-due lifecycle on a `FakeClock`, seat limits, consent.
- `db/billing-flows.db-spec.ts`: the same on real Postgres, including the invoice counter and the seat limit under parallel requests, the advisory-locked job, the append-only `billing_events` trigger and the CHECK constraints. `db/team-flows.db-spec.ts` upgrades its tenants to an unlimited plan so the Starter seat limit does not interfere.

Time: `createTestApp()` returns a `clock` (`FakeClock`) that replaces the `Clock` provider; move it with `clock.advanceDays(n)` instead of waiting.

## Gateway tests (Phase 3)

- `src/engine/*.spec.ts`: the engine layer. `engine-client.contract.spec.ts` runs ONE behaviour suite against both the mock and the HTTP client (over a real socket to `utils/fake-engine-server.ts`), so the mock stays faithful to the contract; `http-engine.client.spec.ts` covers headers, the single retry, timeouts, broken streams and aborts; the contract file itself is checked by `engine-contract-file.spec.ts`.
- `widget.e2e-spec.ts` / `api-keys.e2e-spec.ts`: the whole HTTP stack with the in-memory Prisma of `utils/gateway-fixtures.ts` (`installGateway`) and the mock engine: sessions, SSE, escalation, fallbacks, CORS, widget/staff/platform token confusion, origin allow-list, two-tenant two-visitor isolation, idempotency, rate limits (a second app with tiny limits), API-key roles and validation.
- `db/gateway-flows.db-spec.ts`: the same flows on real Postgres: the migration's tables and CHECK constraints, the atomic usage upsert and dedupe ledger under parallel requests, the GIN origin lookup, `conversationsPerPeriod` from real rows.

`createTestApp({ widgetLimits })` lets a test use small rate limits and returns the mock `engine` (use `engine.setDown(true)`, `engine.resolve(...)`, `engine.inspect(tenant, id)`). The shared limiter keeps counting across tests, so the big suites build their app with very high limits.

## Helpers

- `utils/prisma-mock.ts`: `createPrismaMock()`, `mockTransaction(prisma)` (runs `$transaction` callbacks against the same mock) and `prismaError('P2002')` (a real `PrismaClientKnownRequestError`). The mocks do not apply `omit`: a mock that echoes `create` data must strip hashes itself.
- `utils/test-app.ts`: `createTestApp()` returns the app, the Prisma mock and helpers: `staffToken(user, record?, iat?)` registers the user in a small directory (active and verified unless `record` says otherwise), `allowStaff()` installs the `tenantUser.findUnique` stub that answers `JwtStrategy` from that directory (call it in `beforeEach` after `jest.resetAllMocks()`), and `platformToken`.
- `setup-env.ts`: sets `JWT_SECRET`, `MAIL_MODE=link` and friends before `AppModule` is imported (env validation runs at import time).
- `db/setup-db-env.ts`: the same for the database suite, plus the safety checks above.
