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

## Human hand-off tests (Phase 3B and 4)

- `phase3b.e2e-spec.ts`: the frontend gap-report fixes over HTTP (password byte limit, agents' user list, `name: null`, invite preview and its limits, `Retry-After` through CORS, OpenAPI conventions) and `TRUST_PROXY` with the real `configureApp`.
- `handoff.e2e-spec.ts`: the staff conversation API on the mock engine with an in-memory database (`utils/handoff-fixtures.ts`): roles, the assignee rule, claim races, two-tenant isolation, audit, a disabled holder, the dashboard stream (header, tickets, resume, caps) and the widget stream over a real socket (`utils/sse-client.ts`), and the whole demo (ask, escalate, notify, claim, reply reaches the widget, release, AI resumes, resolve).
- `events-notifications.e2e-spec.ts`: `POST /internal/events` (signature, envelope, idempotency, tenant from the envelope, each event type), the notification API and `GET /v1/me`, the OpenAPI document.
- `db/handoff-flows.db-spec.ts`: the same on real Postgres: the migration, ten parallel deliveries of one event, rollback of a half-applied event, parallel claims, single-use tickets, billing reminders and their idempotency (three sweeps at once), the purge, the escalation retry job, reactivating a suspended tenant, and the whole hand-off.
- Unit specs: `src/realtime/*` (hub, SSE, registry, tickets, guard), `src/events/*` (signature, guard, service), `src/notifications/*`, `src/conversations/*`, `src/billing/reminders/*`, `src/widget/escalation-retry` and `widget-stream`, and the new mock-engine behaviour in `src/engine/*` (the contract suite runs the staff calls against both the mock and the HTTP client).
- `overage.e2e-spec.ts` (Phase 4B, J6): the owner-only overage switch, the billing and `/me` figures, tenant isolation, and the overage fields of `record-payment`; `widget.e2e-spec.ts` has the matching gateway cases (Pro keeps answering, off is a hard stop, Free and `past_due` never get overage). `db/overage-flows.db-spec.ts` runs the whole flow on real Postgres, including the CHECK constraint and the reminders.
- `mail-delivery.e2e-spec.ts` (Phase 4C, H3): `delivery` in the invite, signup and verification-resend answers, the constant password-reset answer, and the `mail` part of `/health/ready`, with the app's `Mailer` stubbed. `src/mail/resend.mailer.spec.ts` drives `ResendMailer` against a fake Resend HTTP server (success, 403 test mode, 429 quotas, timeout, retry rules, no leaks in logs). **No suite sends real email:** `setup-env.ts` and `db/setup-db-env.ts` force `MAIL_PROVIDER=console` because `.env` may hold real Resend settings.
  `createTestApp()` now creates the app with `rawBody: true` (the event receiver verifies the exact bytes) and `setup-env.ts` sets an `INTERNAL_API_TOKEN`. Wait for the mock engine's events with `await engine.flushEvents()` before asserting on notifications or streams.

## Account decisions tests (Phase 3C)

- `account-session.e2e-spec.ts` (J1): logout over HTTP with a stateful user table: all sessions of the user end, nobody else's, a login in the same second works, a suspended workspace can still log out, platform admins too.
- `tenant-settings.e2e-spec.ts` (J3, J7): `GET/PATCH /v1/tenants/:tenantId` with an in-memory tenant and alias table and the `FakeClock`: roles, tenant isolation, the whole slug life (taken, suggestions, once per 30 days, old slug at login for 30 days, reserved for 90, taking it back), time zone validation, mass assignment.
- `role-matrix.e2e-spec.ts` (B2, J4): ONE table of every tenant route and the roles allowed; denied roles must get 403 `INSUFFICIENT_ROLE` with no data touched, allowed roles must get past the role check, a test fails for a tenant route that is not in the table; plus the self-protection rule over HTTP.
- `upgrade-requests.e2e-spec.ts` (J5): the owner's request (replace, plan rules, rate limit, mail result), the platform queue and handling, the removed `plan`/`status` PATCH fields, suspend and unsuspend. The mailer is spied on; nothing is sent.
- `workspace-login.e2e-spec.ts` (J2): login-email and select-workspace with in-memory users in several workspaces (matching, unmatched count, availability reasons, token confusion with staff/platform/widget tokens, J1 interplay, expiry), login throttling, password reset by email, slug-available.
- `db/account-flows.db-spec.ts`: the same on real Postgres: `tokens_valid_after`, the alias windows and the advisory-lock races (two renames to one slug, a rename against a signup), the partial unique index and CHECK on `upgrade_requests`, the whole picker journey with a reset by email.
- Unit specs: `auth/token-freshness`, `login-throttle`, `workspace-login`, `workspace-selection-token`, `slug-availability`, `password-reset` (both ways), `slugs/slug.service`, `tenants/tenant-settings`, `billing/upgrade/upgrade-requests`, `common/validation/timezone`, the `peek`/`reset` of the rate limiter.
- `createTestApp()` returns `resetRateLimits()` (empties every in-memory limiter, so a test starts with fresh login counters) and its tokens carry `iatMs` like real ones.

## Helpers

- `utils/prisma-mock.ts`: `createPrismaMock()`, `mockTransaction(prisma)` (runs `$transaction` callbacks against the same mock) and `prismaError('P2002')` (a real `PrismaClientKnownRequestError`). The mocks do not apply `omit`: a mock that echoes `create` data must strip hashes itself.
- `utils/test-app.ts`: `createTestApp()` returns the app, the Prisma mock and helpers: `staffToken(user, record?, iat?)` registers the user in a small directory (active and verified unless `record` says otherwise), `allowStaff()` installs the `tenantUser.findUnique` stub that answers `JwtStrategy` from that directory (call it in `beforeEach` after `jest.resetAllMocks()`), and `platformToken`.
- `setup-env.ts`: sets `JWT_SECRET`, `MAIL_MODE=link` and friends before `AppModule` is imported (env validation runs at import time).
- `db/setup-db-env.ts`: the same for the database suite, plus the safety checks above.
