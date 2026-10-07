# CLAUDE.md: multiTennant_backend

Backend core of a multi-tenant **AI customer-support platform** (call centres and businesses put an AI agent in front of their customers; humans take over when needed). This repo is the **backend core** only. Full design: [docs/architecture.md](docs/architecture.md). Open decisions with the other teams: [docs/team-alignment.md](docs/team-alignment.md). Read both before building features; the phase plan is in [docs/backend-roadmap.md](docs/backend-roadmap.md).

## Team split
- **Backend core (this repo, Abdul Haseeb):** tenants, auth, users/roles, end customers, keys, channel connections, agent config, plans/usage, gateway + dashboard API.
- **AI engine (Abdullah Younas, separate repo):** conversations, messages, RAG/knowledge chunks (pgvector), LLM, call logs, agent actions, voice. Schema `ai_engine` in the **same Postgres**; separate Prisma project.
- **Frontend (another colleague):** dashboard + widget; consumes this repo's OpenAPI.

## Stack and commands
NestJS 12, TypeScript 6, Prisma 6 (PostgreSQL, schema `tenant_core`), Passport JWT, bcrypt, class-validator/transformer, Jest 30, oxlint, Prettier (single quotes, trailing commas).

```bash
npm run start:dev      # watch mode (default port 3000)
npm run build          # nest build → dist/
npm test               # unit tests
npm run test:e2e       # e2e (needs a database)
npm run lint           # oxlint
npx prisma migrate dev # apply/create migrations (see Database rules)
npx prisma generate
```
Env (`.env`, never commit or print values): `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN` (default `1d`), `FRONTEND_URL`, optional `PORT`.

## Layout
```
src/
  main.ts                 global ValidationPipe(whitelist, transform), CORS = FRONTEND_URL
  app.module.ts
  prisma/                 global PrismaModule + PrismaService (extends PrismaClient)
  auth/                   signup, login, JwtStrategy, JwtAuthGuard (+ tenant match)
  tenants/                CRUD /tenants   (unguarded, see Known issues)
  tenant-users/           CRUD /tenants/:tenantId/users      (guarded)
  end-customers/          CRUD /tenants/:tenantId/customers  (guarded)
prisma/schema.prisma      Tenant, TenantUser, EndCustomer (schema tenant_core)
src/lang/<locale>/<ns>.json   (planned, H7) UI translations with stable keys, `en` is the source; served at /v1/i18n
docs/                     architecture + team alignment
```
Each feature: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/` (`Create*`, `Update*` = `PartialType(Create*)`, `Query*` with `skip`/`take`), `entities/` (empty scaffolds, unused).

## Rules for this codebase
1. **Tenant isolation is the top rule.** Every query on tenant data includes `tenantId` in the `where`. Services take `tenantId` as the first argument. The tenant comes from the verified JWT/key, never from request content. After a scoped `findOne`, still scope the mutation where practical.
2. Tenant-scoped routes live under `/tenants/:tenantId/...` and use `JwtAuthGuard`, which rejects a token whose `tenantId` differs from the URL.
3. Never return `passwordHash`; use `omit: { passwordHash: true }`.
4. Map Prisma errors: `P2002` → 409, `P2003`/`P2025` → 404.
5. **One writer per table.** Do not write to `ai_engine` tables; do not declare `ai_engine` models in this Prisma schema.
6. New tables go in schema `tenant_core` (`@@schema("tenant_core")`, `@@map` snake_case, columns `@map` snake_case).
7. Match surrounding style; run `npm run lint` and `npm test` before finishing.

## Database rules (shared Postgres, two Prisma projects)
- Do **not** run `prisma migrate reset` or `db push` against the shared database. See A2 in team-alignment (separate `?schema=` per project, to be verified).
- `tenant_core` migrations must run before `ai_engine` migrations (their FK points here).
- `ON DELETE RESTRICT` everywhere: tenant removal follows the offboarding procedure (architecture §5.6).
- The DB currently configured in `.env` is `multitenant`; the AI side uses `caller-ai-agent`. Pending decision A1.

## Known issues (fix in Phase 0 unless noted)
1. `src/tenants/tenants.controller.ts`: **no auth** on any route; `CreateTenantDto` lets callers set `plan`/`status`. → B1.
2. Roles are in the JWT but **never enforced**; `CreateTenantUserDto` accepts `role: 'owner'`. → B2.
3. `src/tenant-users/tenant-users.service.ts:69`: `remove(id, tenantId)` has its parameters swapped relative to the controller call `remove(tenantId, id)`, so **user delete always returns 404**.
4. Unhandled `P2002` (500) on email/`externalId` change in user/customer `update`, and on duplicate signup; no `P2025` handling there.
5. `findAll` with no `take` returns every row; no maximum.
6. Lists return bare arrays; planned envelope `{data,total,skip,take}` (G1).
7. `src/auth/auth.module.ts:13` reads `JWT_SECRET` at import time and nothing loads `.env` explicitly (needs a runtime check); `prisma.config.ts` imports `dotenv`, which is not in `package.json`.
8. Stray imports: `node:test` in `end-customers.service.ts:7`; `typescript` in `tenant-users/dto/query-tenant-user.dto.ts:3`; `tenant-users.controller.ts` uses `QueryTenantDto` instead of `QueryTenantUserDto`.
9. Tests: only `tenants.service.spec.ts` is real. The tenant-user and end-customer specs lack a `PrismaService` provider (DI failure); the e2e test expects "Hello World!" and needs a DB.
10. Login needs a tenant UUID (B3); no refresh tokens, throttling, password reset or email verification. Planned: invites (H1), reset (H2), verification (H4), user status, audit log (H6), in-app notifications (H5).
11. `POST /tenants/:tenantId/users` takes a password for another person. It is to be replaced by invites where staff set their own password (H1).

## Roadmap
Phase 0 foundation and hardening → 1 account and team management → 2 shared infra and engine contract (parallel with 1) → 3 gateway and widget entry → 4 human-agent flow and notifications → 5 tenant config, knowledge, actions, usage → 6 WhatsApp and voice → 7 agent productivity (deferred) → 8 production hardening. Scope checklists and exit criteria: [docs/backend-roadmap.md](docs/backend-roadmap.md). Tick boxes there as work completes.

## Working notes
- Do not invent facts about the AI engine's code beyond its schema (shared in chat, see docs); ask or record a question in team-alignment instead.
