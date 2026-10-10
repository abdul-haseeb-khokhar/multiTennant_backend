# multiTennant_backend

Backend core of a multi-tenant **AI customer-support platform**. Businesses and call centres put an AI agent in front of their customers; the agent answers from the tenant's own knowledge base and hands over to a human when it should. This repository is the **backend core** (NestJS + Prisma + PostgreSQL). The AI engine and the frontend are separate projects that talk to it through documented contracts.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Foundation and hardening (roles, `/v1`, error codes, platform admin, tests, CI) | merged |
| 1 | Account and team management (invites, password reset, email verification, audit log, i18n) | merged (mail provider: Resend chosen, built in Phase 4C) |
| 2B | Billing foundation (plans, Starter → Free, subscriptions, entitlements, manual payments) | merged (tax wording and training-data consent stay open) |
| 3 | Gateway and widget entry (API keys, widget sessions, streamed chat, usage, fallbacks) | merged; runs against a **mock engine** only |
| 3B | Frontend gap-report fixes (password limit, proxy-aware IPs, invite preview, locale validation, OpenAPI fixes) | done on branch `phase-4-human-agent`, not merged yet |
| 4 | Human takeover (conversation API, claim/reply/release/resolve), engine event receiver, live streams, in-app notifications and billing reminders | done on branch `phase-4-human-agent` against the **mock engine** only, not merged yet |
| 4B and later | Overage setting, mail provider, tenant configuration, WhatsApp and voice, hardening | planned, see [docs/backend-roadmap.md](docs/backend-roadmap.md) |

## Documentation

| File | What it is |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Working rules, layout, commands and the list of known issues. Start here when changing code. |
| [docs/architecture.md](docs/architecture.md) | System design, data model, key flows, what is built |
| [docs/team-alignment.md](docs/team-alignment.md) | Open decisions and contracts with the AI engine and frontend colleagues (ids such as B2, H1, I5, J1) |
| [docs/backend-roadmap.md](docs/backend-roadmap.md) | Phase plan with checklists; tick boxes as work completes |
| [docs/contracts/README.md](docs/contracts/README.md) | How to run the chat against the mock engine; the engine API contract |
| [docs/openapi.json](docs/openapi.json) | The API contract for the frontend (live copy at `/docs` when the server runs) |
| [test/README.md](test/README.md) | How the test suites work |

## Quick start

Requirements: Node.js 24, PostgreSQL (with the `tenant_core` schema; the AI side uses a separate `ai_engine` schema in the same server).

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL and JWT_SECRET (16+ characters); never commit .env
npx prisma migrate deploy   # apply the migrations (never use migrate reset or db push on the shared database)
npx prisma generate
npm run start:dev           # http://localhost:3000, API under /v1, docs at /docs
```

For local development MAIL_MODE=link returns invite, reset and verification links in the API responses (the app refuses to start with it when NODE_ENV=production). The engine defaults to the in-process mock (`ENGINE_MODE=mock`); see [docs/contracts/README.md](docs/contracts/README.md) for a curl walkthrough, or run `npm run widget:walkthrough` / `npm run handoff:walkthrough` against the running server.

Create a platform admin (needed for `/v1/admin/...`):

```bash
PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_PASSWORD='a long password' npm run platform-admin:create
```

## Commands

```bash
npm run build            # compile to dist/ (also copies src/lang/**/*.json)
npm test                 # unit tests (mocked Prisma)
npm run test:e2e         # HTTP tests over the real AppModule, Prisma mocked
TEST_DATABASE_URL=postgresql://…/<throwaway db> npm run test:db   # account, billing and gateway flows against a REAL throwaway Postgres
npm run lint             # oxlint (type-aware)
npm run openapi:export   # regenerate docs/openapi.json after changing a route or DTO
npm run widget:walkthrough   # scripted widget chat against a running backend (mock engine)
npm run handoff:walkthrough  # the whole human hand-off: escalate, notify, claim, reply, release, resolve (mock engine, MAIL_MODE=link)
npm run i18n:check       # warn about translation keys missing in a locale
```

CI (`.github/workflows/ci.yml`) runs lint, tests, the build, applies every migration to a throwaway Postgres, checks for schema drift and runs the database tests.

## Team

- **Backend core** (this repository): Abdul Haseeb
- **AI engine** (separate repository, Postgres schema `ai_engine`): Abdullah Younas
- **Frontend** (separate repository): a third colleague
