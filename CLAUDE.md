# CLAUDE.md: multiTennant_backend

Backend core of a multi-tenant **AI customer-support platform** (call centres and businesses put an AI agent in front of their customers; humans take over when needed). This repo is the **backend core** only. Full design: [docs/architecture.md](docs/architecture.md). Open decisions with the other teams: [docs/team-alignment.md](docs/team-alignment.md). Read both before building features; the phase plan is in [docs/backend-roadmap.md](docs/backend-roadmap.md).

## Team split
- **Backend core (this repo, Abdul Haseeb):** tenants, auth, users/roles, end customers, keys, channel connections, agent config, plans/usage, gateway + dashboard API.
- **AI engine (Abdullah Younas, separate repo):** conversations, messages, RAG/knowledge chunks (pgvector), LLM, call logs, agent actions, voice. Schema `ai_engine` in the **same Postgres**; separate Prisma project.
- **Frontend (another colleague):** dashboard + widget; consumes this repo's OpenAPI.

## Stack and commands
NestJS 12, TypeScript 6, Prisma 6 (PostgreSQL, schema `tenant_core`), Passport JWT, bcrypt, class-validator/transformer, `@nestjs/config`, `@nestjs/swagger`, Jest 30, oxlint, Prettier (single quotes, trailing commas).

```bash
npm run start:dev      # watch mode (default port 3000)
npm run build          # nest build → dist/ (also copies src/lang/**/*.json)
npm test               # unit tests (mocked Prisma)
npm run test:e2e       # e2e: real AppModule over HTTP, Prisma mocked, no database needed (see test/README.md)
TEST_DATABASE_URL=postgresql://…/<throwaway db> npm run test:db   # account flows over HTTP against a REAL throwaway Postgres (never the shared DB)
npm run lint           # oxlint (type-aware)
npm run openapi:export # regenerate docs/openapi.json (no database needed)
npm run i18n:check     # warn about translation keys missing in a locale (never fails)
npm run platform-admin:create  # create a platform admin (PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD in the environment)
npx prisma migrate dev # apply/create migrations (see Database rules)
npx prisma generate
```
API: everything is under `/v1` except `GET /health` and `GET /health/ready`. OpenAPI UI at `/docs`, JSON at `/docs-json`, static copy in [docs/openapi.json](docs/openapi.json). CI: `.github/workflows/ci.yml`.

Env (`.env`, never commit or print values; names are listed in `.env.example` and validated at boot by `src/config/env.validation.ts`, which refuses to start without a `JWT_SECRET` of 16+ characters): `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN` (default `1d`), `PLATFORM_JWT_EXPIRES_IN` (default `1h`), `FRONTEND_URL` (the CORS origin and the base of emailed links; unset = no browser origin allowed; required when `NODE_ENV=production`), `MAIL_MODE` (`console` default; `link` also returns invite/reset/verification links in API responses for development, and the app refuses to start with `link` when `NODE_ENV=production`), optional `PORT`.

## Layout
```
src/
  main.ts                 bootstrap: JSON logger, configureApp, Swagger
  app.setup.ts            configureApp (request id, /v1 prefix, ValidationPipe, error filter, CORS) + OpenAPI config; shared with the e2e tests
  app.module.ts
  config/                 env validation (fail fast)
  common/                 errors (ErrorCode, ApiException, AllExceptionsFilter), pagination (DTO, envelope, decorator), request-context
                          (middleware, interceptor + ALS store with request id/IP/user agent), tokens (32-byte tokens, sha256),
                          validation/email (@NormalizedEmail), throttle (in-memory RateLimiter), JsonLogger
  prisma/                 global PrismaModule + PrismaService (extends PrismaClient)
  auth/                   signup, login by tenantSlug, platform-admin login, JwtStrategy (re-checks the user in the DB on every request:
                          deleted, disabled, password_changed_at, current role) + JwtAuthGuard (tenant match, suspended check),
                          PlatformJwtStrategy + guard (scope "platform"), @Roles + RolesGuard, EmailVerifiedGuard, @CurrentUser,
                          password reset + email verification services/controllers, SessionTokenService
  tenants/                platform-admin only: /v1/admin/tenants (list, get, patch, delete); slug helpers. No create route: tenants come from signup
  tenant-users/           list/get/PATCH/DELETE /v1/tenants/:tenantId/users (no create: people join by invite); serializable last-owner check
  invites/                /v1/tenants/:tenantId/invites (create/list/revoke) and public POST /v1/auth/invites/accept
  audit/                  AuditService (record, optionally inside a transaction), @Audit decorator + interceptor, GET …/audit-logs
  mail/                   Mailer (abstract provider token), ConsoleMailer, MailService (builds links; MAIL_MODE=link returns them in dev)
  me/                     GET/PATCH /v1/me
  i18n/                   GET /v1/i18n/locales and /:locale/:namespace (public, ETag); locales.ts is the locale registry
  end-customers/          CRUD /v1/tenants/:tenantId/customers  (JwtAuthGuard + RolesGuard)
  health/                 GET /health (liveness), GET /health/ready (database)
  lang/<locale>/<ns>.json UI translations: locales en, ur; namespaces common, errors, notifications, widget; flat stable dot-notation keys,
                          `en` is the source (served with fallback to en). errors has a key per ErrorCode (a unit test enforces it)
prisma/schema.prisma      Tenant, TenantUser, EndCustomer, PlatformAdmin, StaffInvite, PasswordReset, EmailVerification, AuditLog (schema tenant_core)
scripts/                  create-platform-admin.ts, export-openapi.ts, check-i18n.ts
test/                     e2e specs + utils (Prisma mock, test app factory) and db/ (real-Postgres flows); see test/README.md
docs/                     architecture, team alignment, roadmap, openapi.json
```
Each feature: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/` (`Create*`, `Update*` = `PartialType(Create*)` from `@nestjs/swagger`, `Query*` extending `PaginationQueryDto`), `entities/` (response shapes; documentation only, used for OpenAPI).

## Rules for this codebase
1. **Tenant isolation is the top rule.** Every query on tenant data includes `tenantId` in the `where`. Services take `tenantId` as the first argument. The tenant comes from the verified JWT/key, never from request content. After a scoped `findOne`, still scope the mutation (`update({ where: { id, tenantId } })`). Public token flows (invite accept, reset, verification) take the tenant from the record the hashed token belongs to.
2. Tenant-scoped routes live under `/v1/tenants/:tenantId/...` and use `@UseGuards(JwtAuthGuard, RolesGuard)`. `JwtAuthGuard` rejects a token whose `tenantId` differs from the URL (403 `TENANT_MISMATCH`) and a suspended tenant (403 `TENANT_SUSPENDED`). `RolesGuard` fails closed: every handler needs `@Roles(...)`. Platform-admin routes (`/v1/admin/...`) use `PlatformJwtAuthGuard`; the two token kinds are not interchangeable (`scope` claim: `tenant` or `platform`). `request.user.role` comes from the database (JwtStrategy), not from the token.
3. Never return `passwordHash` or `tokenHash`; use `omit: { passwordHash: true }` / `omit: { tokenHash: true }`.
4. Map Prisma errors in the service with `isPrismaError`: `P2002` → 409, `P2003`/`P2025` → 404 (`P2003` on tenant delete → 409 `TENANT_HAS_DEPENDENCIES`). Throw `ApiException(status, ErrorCode.X, message)` so the body is `{statusCode, code, message}`; add new codes to `common/errors/error-codes.ts` **and a translation to `src/lang/en/errors.json` and `ur/errors.json`** (a unit test fails otherwise) and never rename one (the frontend translates them).
5. **One writer per table.** Do not write to `ai_engine` tables; do not declare `ai_engine` models in this Prisma schema.
6. New tables go in schema `tenant_core` (`@@schema("tenant_core")`, `@@map` snake_case, columns `@map` snake_case).
7. Match surrounding style; run `npm run lint`, `npm test`, `npm run test:e2e` and `npm run build` before finishing. Lists return `{data,total,skip,take}` (default `take` 20, max 100). After changing a route or DTO run `npm run openapi:export`.
8. Role matrix (B2) as built: owner and admin invite staff and manage users (email, role, status, delete); an admin cannot invite, change, disable or delete an owner or promote anyone to owner; a tenant always keeps one **active** owner; every role reads users and reads, creates and edits customers; only owner/admin delete customers and read the audit log. Roles are `owner`, `admin`, `agent`. Nobody sets another person's password (invite, reset).
9. Emails are stored trimmed and lower-case (DTO `@NormalizedEmail`, services normalise too, and a DB CHECK constraint enforces it): normalise any new email input. A change that must not be half-done (role or status change plus its audit entry, the last-owner check) runs in one transaction and passes `tx` to `AuditService.record`. Never put tokens, hashes or links in logs (only `ConsoleMailer` may log a link) or in audit `before`/`after` (keys such as `password`, `token`, `hash`, `link` are stripped anyway).

## Database rules (shared Postgres, two Prisma projects)
- Do **not** run `prisma migrate reset` or `db push` against the shared database. See A2 in team-alignment (separate `?schema=` per project, to be verified).
- `tenant_core` migrations must run before `ai_engine` migrations (their FK points here).
- `ON DELETE RESTRICT` everywhere: tenant removal follows the offboarding procedure (architecture §5.6). Exceptions: `password_resets` and `email_verifications` cascade with their user (ephemeral data), and `audit_logs`/`staff_invites` reference the tenant with RESTRICT but their user columns are plain text without FK.
- The DB currently configured in `.env` is `multitenant`; the AI side uses `caller-ai-agent`. Pending decision A1.
- Generate migrations against a **throwaway** Postgres (`DATABASE_URL` pointing at it, `prisma migrate dev --create-only`), read the SQL, then `prisma migrate deploy` on the real database. Check the generated folder name sorts after the previous migration. CI applies all migrations to a throwaway Postgres, fails if `schema.prisma` has changes without a migration, then runs `npm run test:db`.
- The audit log is append-only by a DB trigger; anything that must delete from it (offboarding, retention) is a privileged maintenance step.

## Known issues
Phases 0 and 1 closed the original account-lifecycle issues (unprotected `/tenants`, unenforced roles, deleted/demoted users keeping a valid token, passwords set for other people, non-atomic last-owner check, case-sensitive emails, and the rest). Still open:

1. No refresh tokens or login throttling (Phase 8). Password-reset throttling exists but its counters are in process memory, so with several instances each counts on its own (move it behind Redis with the rest of Phase 8). Behind a reverse proxy set Express `trust proxy`, otherwise every request counts as the proxy's IP.
2. No real mail provider yet (H3): invite, reset and verification links are logged by `ConsoleMailer`, or returned in the response with `MAIL_MODE=link` in development. Choose a provider and sender domain, implement `Mailer`, render the `email.<template>.*` keys of the `notifications` namespace, bind it in `MailModule`. Until then nobody receives an email.
3. In-app notifications (H5) are not built yet (Phase 4). The Urdu translations (`src/lang/ur`) were written by an AI and reviewed as fine by the owner; new keys still need a native-speaker check.
4. Users that existed before Phase 1 have `email_verified_at = NULL`, so an existing owner cannot invite until they verify (`POST /v1/auth/verify-email/resend`; the link is in the log or, with `MAIL_MODE=link`, in the response). Not backfilled on purpose: nobody verified anything.
5. "An unverified owner cannot change plan" is enforced by `EmailVerifiedGuard` on invites only: tenants have no plan-change route yet (platform admins change plans). Put the guard on that route when it exists (Phase 5).
6. Tenant hard delete (`DELETE /v1/admin/tenants/:id`) only succeeds for a tenant with no users, customers, invites or audit entries (`RESTRICT`; the audit log is append-only by trigger). The real offboarding procedure (architecture §5.6) is Phase 8 and must drop that trigger as a privileged step; so must the 12-month audit retention purge.
7. The e2e tests run against mocked Prisma; SQL, constraints, the audit trigger and migrations are exercised by `npm run test:db` and the CI `migrations` job (`migrate deploy`, drift check, then the DB-backed tests). The DB suite refuses anything but `TEST_DATABASE_URL` and leaves its data behind (tenants cannot be deleted), so use a disposable database. Its last-owner race test demonstrates the invariant; it does not prove the isolation level on its own.
8. Migration `20261007100000_add_tenant_slug_and_platform_admins` backfilled `slug` for existing tenants as `<name>-<first 8 chars of id>` (rename of a slug is not exposed yet). The Phase 1 migrations `20261007120000_phase1_account_team` and `20261007120100_normalize_emails` are applied to the local `multitenant` database (a pre-Phase-1 `pg_dump` of `tenant_core` is in the Phase 1 session's scratchpad); any other database needs `prisma migrate deploy`. The second refuses to run, and names the rows, if lower-casing would make two emails collide.
9. `oxlint` could not run on the Windows machine that built Phases 0 and 1 (an Application Control policy blocks its native binary). Lint there was checked only by `tsc --noUnusedLocals --noUnusedParameters` and Prettier; CI runs the real linter.
10. The Prisma mocks do not apply `omit`: a mock that echoes `create` data back must strip `passwordHash`/`tokenHash` itself (see the e2e mocks); the unit tests assert the `omit` argument instead.

## Roadmap
Phase 0 foundation and hardening (merged, CI green) → 1 account and team management (implemented, uncommitted on branch `phase-1-account-team`; only the mail provider, H3, is open) → 2 shared infra and engine contract (parallel with 1) → 3 gateway and widget entry → 4 human-agent flow and notifications → 5 tenant config, knowledge, actions, usage → 6 WhatsApp and voice → 7 agent productivity (deferred) → 8 production hardening. Scope checklists and exit criteria: [docs/backend-roadmap.md](docs/backend-roadmap.md). Tick boxes there as work completes.

## Working notes
- Do not invent facts about the AI engine's code beyond its schema (shared in chat, see docs); ask or record a question in team-alignment instead.
