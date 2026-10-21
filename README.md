# multiTennant_backend

Backend core of a multi-tenant **AI customer-support platform**. Businesses and call centres put an AI agent in front of their customers; the agent answers from the tenant's own knowledge base and hands over to a human when it should. This repository is the **backend core** (NestJS + Prisma + PostgreSQL). The AI engine and the frontend are separate projects that talk to it through documented contracts.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Foundation and hardening (roles, `/v1`, error codes, platform admin, tests, CI) | merged |
| 1 | Account and team management (invites, password reset, email verification, audit log, i18n) | merged (the mail provider came in Phase 4C) |
| 2B | Billing foundation (plans, Starter → Free, subscriptions, entitlements, manual payments) | merged (tax wording and training-data consent stay open) |
| 3 | Gateway and widget entry (API keys, widget sessions, streamed chat, usage, fallbacks) | merged; runs against a **mock engine** only |
| 3B | Frontend gap-report fixes (password limit, proxy-aware IPs, invite preview, locale validation, OpenAPI fixes) | merged (PR #5) |
| 4 | Human takeover (conversation API, claim/reply/release/resolve), engine event receiver, live streams, in-app notifications and billing reminders | merged (PR #5) against the **mock engine** only |
| 4B | Pro overage setting (the owner chooses between PKR 15 per extra conversation and a hard stop), overage figures, overage reminder | merged (PR #6); the optional spending cap is undecided |
| 4C | Real email through Resend (test mode), HTML and plain-text templates in English and Urdu, `delivery` in API answers, mail health | merged (PR #6); real delivery in test mode was confirmed by the owner on 2026-10-11 (see Email below) |
| 3C | Account decisions: logout that ends all sessions, email-first login with a workspace picker (and login throttling), owner self-service with slug rename and time zone, nobody can disable, demote or delete themselves, upgrade requests to the platform team | built on branch `phase-3c-account`, not yet merged; see the frontend list in [docs/team-alignment.md](docs/team-alignment.md) J1 to J5 |
| 5A to 5F, 6 and later | Voice-first plan: alignment with call minutes, tenant status check and requests workflow, real-engine integration, phone numbers, call usage and billing, agent settings and knowledge; then telephony go-live and hardening. Message operations are halted and WhatsApp is deferred | planned, see [docs/backend-roadmap.md](docs/backend-roadmap.md) and team-alignment L |

## Documentation

| File | What it is |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Working rules, layout, commands and the list of known issues. Start here when changing code. |
| [docs/architecture.md](docs/architecture.md) | System design, data model, key flows, what is built |
| [docs/team-alignment.md](docs/team-alignment.md) | Open decisions and contracts with the AI engine and frontend colleagues (ids such as B2, H1, I5, J1) |
| [docs/backend-roadmap.md](docs/backend-roadmap.md) | Phase plan with checklists; tick boxes as work completes |
| [docs/for-abdullah.md](docs/for-abdullah.md) | The one document to send the AI engine owner: what we need from the engine (27 numbered questions, blocking ones first) and a reply table |
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

For local development MAIL_MODE=link returns invite, reset and verification links in the API responses (the app refuses to start with it when NODE_ENV=production). Emails are only logged until you configure a mail provider (see Email below). The engine defaults to the in-process mock (`ENGINE_MODE=mock`); see [docs/contracts/README.md](docs/contracts/README.md) for a curl walkthrough, or run `npm run widget:walkthrough` / `npm run handoff:walkthrough` against the running server.

Optional: `PLATFORM_ADMIN_NOTIFY_EMAIL` in `.env` is the address that gets an email when a workspace owner asks for a plan upgrade (the request is stored either way). In the Resend test stage `MAIL_REDIRECT_TO` still sends it to the redirect address.

Create a platform admin (needed for `/v1/admin/...`):

```bash
PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_PASSWORD='a long password' npm run platform-admin:create
```

## Email

Invites, password resets and email verification are emailed through [Resend](https://resend.com). `MAIL_PROVIDER=console` (the default) only logs each message, link included, for development; `MAIL_PROVIDER=resend` sends it. Production refuses to start with `console`. Tests never send email, whatever your `.env` holds.

**Set up (test mode, no domain needed)**
1. Create a Resend account and, under *API Keys*, a key with the **Sending access** permission (not full access).
2. Put it in `.env` yourself; never paste it into chat, a commit or an issue:
   ```
   MAIL_PROVIDER=resend
   RESEND_API_KEY=<your key>
   MAIL_FROM=onboarding@resend.dev
   MAIL_FROM_NAME=SupportDesk AI
   MAIL_REDIRECT_TO=<the email address you registered the Resend account with>
   ```
3. Restart the backend. `GET /health/ready` now reports `mail.provider: "resend"`.

**Why `MAIL_REDIRECT_TO`.** Resend's shared test sender `onboarding@resend.dev` only delivers to the email address of the Resend account itself and refuses other recipients with a 403 (Resend's error reference lists it as "Testing emails can only be sent to your own email address"). With `MAIL_REDIRECT_TO` set, **every** message goes to that one address; the subject starts with `[TEST for <real recipient>]` and a marked line at the top of the body names the intended recipient, so invites and resets can still be tried end to end. In this stage the invited person does not receive anything: you forward the link or copy it from your inbox. Starting the backend with `NODE_ENV=production` refuses `MAIL_REDIRECT_TO`, the `resend.dev` sender and the console provider.

**What the API tells the caller.** Creating an invite, signing up and resending verification answer with `delivery`: `sent` (handed to Resend), `failed` (Resend refused or could not be reached; the invite or verification record still exists, so re-invite the same address or resend) or `skipped` (console provider). The password-reset request always answers the same 202 and never reports a delivery, so it cannot reveal whether an account exists. A send waits at most 5 seconds per attempt (`MAIL_TIMEOUT_MS`) and is retried once after a network error, a timeout or a 5xx, never after a 4xx or 429. Failures are logged by template and reason code only (for example `test_mode_recipient`, `quota_daily`, `quota_monthly`, `rate_limited`, `auth`, `timeout`), never with an address, a link or the key. After 3 failed sends in a row `GET /health/ready` shows `mail.status: "degraded"` (a warning; readiness stays 200).

**Limits of the free plan** (Resend's pricing pages; check resend.com/pricing): 3,000 emails a month and 100 a day, counted per recipient; at the cap sending stops with a 429 (reason `quota_daily` or `quota_monthly`, resets at midnight UTC for the day) until the next period or a paid plan.

**Moving to a verified domain.** Add your domain in Resend (*Domains*), create the DNS records it shows (SPF, DKIM; add a DMARC record such as `v=DMARC1; p=none; rua=mailto:you@yourdomain` and tighten it once mail flows), wait until the domain shows *Verified*, then set `MAIL_FROM` to an address on it (for example `noreply@yourdomain`) and **remove `MAIL_REDIRECT_TO`**. No code change is needed. Bounce and complaint handling (a suppression list) is not built yet.

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
