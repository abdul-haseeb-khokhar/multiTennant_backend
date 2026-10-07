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
npm run build          # nest build → dist/
npm test               # unit tests (mocked Prisma)
npm run test:e2e       # e2e: real AppModule over HTTP, Prisma mocked, no database needed (see test/README.md)
npm run lint           # oxlint (type-aware)
npm run openapi:export # regenerate docs/openapi.json (no database needed)
npm run platform-admin:create  # create a platform admin (PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD in the environment)
npx prisma migrate dev # apply/create migrations (see Database rules)
npx prisma generate
```
API: everything is under `/v1` except `GET /health` and `GET /health/ready`. OpenAPI UI at `/docs`, JSON at `/docs-json`, static copy in [docs/openapi.json](docs/openapi.json). CI: `.github/workflows/ci.yml`.

Env (`.env`, never commit or print values; names are listed in `.env.example` and validated at boot by `src/config/env.validation.ts`, which refuses to start without a `JWT_SECRET` of 16+ characters): `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN` (default `1d`), `PLATFORM_JWT_EXPIRES_IN` (default `1h`), `FRONTEND_URL` (the CORS origin; unset = no browser origin allowed), optional `PORT`.

## Layout
```
src/
  main.ts                 bootstrap: JSON logger, configureApp, Swagger
  app.setup.ts            configureApp (request id, /v1 prefix, ValidationPipe, error filter, CORS) + OpenAPI config; shared with the e2e tests
  app.module.ts
  config/                 env validation (fail fast)
  common/                 errors (ErrorCode, ApiException, AllExceptionsFilter), pagination (DTO, envelope, decorator), request-context middleware, JsonLogger
  prisma/                 global PrismaModule + PrismaService (extends PrismaClient)
  auth/                   signup, login by tenantSlug, platform-admin login, JwtStrategy + JwtAuthGuard (tenant match, suspended check),
                          PlatformJwtStrategy + guard (scope "platform"), @Roles + RolesGuard, @CurrentUser
  tenants/                platform-admin only: /v1/admin/tenants (list, get, patch, delete); slug helpers. No create route: tenants come from signup
  tenant-users/           CRUD /v1/tenants/:tenantId/users      (JwtAuthGuard + RolesGuard)
  end-customers/          CRUD /v1/tenants/:tenantId/customers  (JwtAuthGuard + RolesGuard)
  health/                 GET /health (liveness), GET /health/ready (database)
prisma/schema.prisma      Tenant (with slug), TenantUser, EndCustomer, PlatformAdmin (schema tenant_core)
scripts/                  create-platform-admin.ts, export-openapi.ts
test/                     e2e specs + utils (Prisma mock, test app factory); see test/README.md
src/lang/<locale>/<ns>.json   (planned, H7) UI translations with stable keys, `en` is the source; served at /v1/i18n
docs/                     architecture, team alignment, roadmap, openapi.json
```
Each feature: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/` (`Create*`, `Update*` = `PartialType(Create*)` from `@nestjs/swagger`, `Query*` extending `PaginationQueryDto`), `entities/` (response shapes; documentation only, used for OpenAPI).

## Rules for this codebase
1. **Tenant isolation is the top rule.** Every query on tenant data includes `tenantId` in the `where`. Services take `tenantId` as the first argument. The tenant comes from the verified JWT/key, never from request content. After a scoped `findOne`, still scope the mutation (`update({ where: { id, tenantId } })`).
2. Tenant-scoped routes live under `/v1/tenants/:tenantId/...` and use `@UseGuards(JwtAuthGuard, RolesGuard)`. `JwtAuthGuard` rejects a token whose `tenantId` differs from the URL (403 `TENANT_MISMATCH`) and a suspended tenant (403 `TENANT_SUSPENDED`). `RolesGuard` fails closed: every handler needs `@Roles(...)`. Platform-admin routes (`/v1/admin/...`) use `PlatformJwtAuthGuard`; the two token kinds are not interchangeable (`scope` claim: `tenant` or `platform`).
3. Never return `passwordHash`; use `omit: { passwordHash: true }`.
4. Map Prisma errors in the service with `isPrismaError`: `P2002` → 409, `P2003`/`P2025` → 404 (`P2003` on tenant delete → 409 `TENANT_HAS_DEPENDENCIES`). Throw `ApiException(status, ErrorCode.X, message)` so the body is `{statusCode, code, message}`; add new codes to `common/errors/error-codes.ts` and never rename one (the frontend translates them).
5. **One writer per table.** Do not write to `ai_engine` tables; do not declare `ai_engine` models in this Prisma schema.
6. New tables go in schema `tenant_core` (`@@schema("tenant_core")`, `@@map` snake_case, columns `@map` snake_case).
7. Match surrounding style; run `npm run lint`, `npm test`, `npm run test:e2e` and `npm run build` before finishing. Lists return `{data,total,skip,take}` (default `take` 20, max 100). After changing a route or DTO run `npm run openapi:export`.
8. Role matrix (B2) as built: owner and admin manage users (an admin cannot create, change or delete an owner or promote anyone to owner; a tenant always keeps one owner); every role reads users and reads, creates and edits customers; only owner/admin delete customers. Roles are `owner`, `admin`, `agent`.

## Database rules (shared Postgres, two Prisma projects)
- Do **not** run `prisma migrate reset` or `db push` against the shared database. See A2 in team-alignment (separate `?schema=` per project, to be verified).
- `tenant_core` migrations must run before `ai_engine` migrations (their FK points here).
- `ON DELETE RESTRICT` everywhere: tenant removal follows the offboarding procedure (architecture §5.6).
- The DB currently configured in `.env` is `multitenant`; the AI side uses `caller-ai-agent`. Pending decision A1.
- Prefer `prisma migrate dev --create-only`, read the SQL, then apply. CI applies all migrations to a throwaway Postgres and fails if `schema.prisma` has changes without a migration.

## Known issues
Phase 0 closed the original issues 1-9 (unprotected `/tenants`, unenforced roles, user delete always 404, unhandled `P2002`/`P2025`, unbounded lists, `JWT_SECRET` read at import time, stray imports, broken specs, login by tenant UUID). Still open:

1. A deleted or demoted user keeps a valid token until it expires (default 1d): nothing re-checks the user after login. Planned: `tenant_user.status` and a `password_changed_at` check (H2).
2. No refresh tokens, login throttling, password reset or email verification. Planned: invites (H1), reset (H2), verification (H4), audit log (H6), in-app notifications (H5), throttling and refresh (Phase 8).
3. `POST /tenants/:tenantId/users` and `PATCH` still take a password for another person (an admin can set an agent's password). To be replaced by invites where staff set their own password (H1).
4. The "last owner" check in `TenantUsersService` is count-then-write, not atomic: two simultaneous owner removals could both pass. Make it a serializable transaction when it matters.
5. Tenant hard delete (`DELETE /v1/admin/tenants/:id`) only succeeds for a tenant with no users or customers (`RESTRICT`); the real offboarding procedure (architecture §5.6) is Phase 8.
6. The e2e tests run against mocked Prisma, so SQL, constraints and migrations are exercised only by the CI `migrations` job (`migrate deploy` plus a drift check on a throwaway Postgres), not by the HTTP tests.
7. Email addresses are case-sensitive (`A@x.com` and `a@x.com` are different users). Decide on normalisation together with H1.
8. Migration `20261007100000_add_tenant_slug_and_platform_admins` is written but **not applied** to any database yet. Review and apply it with `prisma migrate dev` / `migrate deploy`. It backfills `slug` for existing tenants as `<name>-<first 8 chars of id>`; log in with that slug or rename via the platform-admin route (rename of slug is not exposed yet).
9. `oxlint` could not run on the Windows machine that built Phase 0 (an Application Control policy blocks its native binary). Lint there was checked only by `tsc --noUnusedLocals` and Prettier; CI runs the real linter.

## Roadmap
Phase 0 foundation and hardening (implemented, uncommitted on branch `phase-0-foundation`; CI not yet run) → 1 account and team management → 2 shared infra and engine contract (parallel with 1) → 3 gateway and widget entry → 4 human-agent flow and notifications → 5 tenant config, knowledge, actions, usage → 6 WhatsApp and voice → 7 agent productivity (deferred) → 8 production hardening. Scope checklists and exit criteria: [docs/backend-roadmap.md](docs/backend-roadmap.md). Tick boxes there as work completes.

## Working notes
- Do not invent facts about the AI engine's code beyond its schema (shared in chat, see docs); ask or record a question in team-alignment instead.
