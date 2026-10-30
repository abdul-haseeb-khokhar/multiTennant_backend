# multiTennant_backend

Backend core of a multi-tenant **AI customer-support platform**. Businesses and call centres put an AI agent in front of their customers; the agent answers from the tenant's own knowledge base and hands over to a human when it should. Since 2026-10-21 the product is **voice-first**: an AI phone receptionist that saves appointment and call-back requests for staff to confirm, with plans measured in call minutes. The chat widget and the staff chat queue are halted (they keep working, with no new work). This repository is the **backend core** (NestJS + Prisma + PostgreSQL). The AI engine and the frontend are separate projects that talk to it through documented contracts.

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
| 5A | Voice-first alignment: call minutes in every plan (Starter, Free, Pro, Enterprise), minute overage under the owner's existing switch, 80% and 100% minute reminders, plan numbers and prices from environment variables, updated engine contracts, a simulated phone call on the mock engine | built on branch `phase-5a-alignment`, not yet merged; see [docs/backend-roadmap.md](docs/backend-roadmap.md) and "Plan numbers and prices" below |
| 5B-1 | Agents foundation (team-alignment L7): a tenant has many agents (its own setup the one shared engine uses for a call), one default agent per tenant (created at signup, backfilled for existing tenants), plan limits for agents and phone numbers, versioned agent settings in the engine's shape, and the route the engine pulls them from at the start of every call | built on branch `phase-5b1-agents`, not yet merged; see [docs/backend-roadmap.md](docs/backend-roadmap.md) and "Agents" below |
| 5B-2 | Tenant status check (`GET /internal/tenants/{tenantId}/status`: may this business and agent be served, derived only from the effective subscription, the call minutes and the agent) and the requests workflow (what the AI takes on a call, saved through the engine's routes, confirmed by staff: list, search, confirm, complete, cancel, reopen, counts, audit, notification, live update); an agent that has requests cannot be deleted | built on branch `phase-5b2-requests`, not yet merged; against the **mock engine** only, the engine owner has confirmed nothing; see [docs/backend-roadmap.md](docs/backend-roadmap.md) and "Requests" below |
| 5C to 5F, 6 and later | Voice-first plan: real-engine integration, phone numbers (each linked to one agent), call usage and billing, agent settings screens and knowledge; then telephony go-live and hardening. Message operations are halted and WhatsApp is deferred | planned, see [docs/backend-roadmap.md](docs/backend-roadmap.md) and team-alignment L |

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

For local development MAIL_MODE=link returns invite, reset and verification links in the API responses (the app refuses to start with it when NODE_ENV=production). Emails are only logged until you configure a mail provider (see Email below). The engine defaults to the in-process mock (`ENGINE_MODE=mock`); see [docs/contracts/README.md](docs/contracts/README.md) for a curl walkthrough, or run `npm run widget:walkthrough` / `npm run handoff:walkthrough` against the running server. The mock can also play a phone call (a saved request with a reference, its update and the call minutes): see "Simulate a phone call" in the same file.

**Two things to know when the engine runs beside the backend.** (1) Both projects default to port **3000**: start one of them on another port (`PORT` here, `ENGINE_BASE_URL` for where this backend looks for the engine). (2) The engine's newer routes accept `Authorization: Bearer <INTERNAL_API_TOKEN>` plus `X-Tenant-Id`, which is what this backend sends; its OLDER `/api/*` routes use the header `x-internal-key` (his `INTERNAL_API_KEY`) and `?tenantId=`, and he is converting only the ones this backend will call. The first-token timeout towards the engine is 10 seconds by default since Phase 5A (`ENGINE_FIRST_TOKEN_TIMEOUT_MS`).

Optional: `PLATFORM_ADMIN_NOTIFY_EMAIL` in `.env` is the address that gets an email when a workspace owner asks for a plan upgrade (the request is stored either way). In the Resend test stage `MAIL_REDIRECT_TO` still sends it to the redirect address.

Create a platform admin (needed for `/v1/admin/...`):

```bash
PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_PASSWORD='a long password' npm run platform-admin:create
```

## Agents (Phase 5B-1)

An **agent** is the *tenant's own setup* that the one shared AI engine uses for a call: its settings, hours, greeting, voice, language, what it collects and who it forwards calls to. It is not a separate AI, and it is not the staff role named `agent` (owner, admin, agent), which keeps its name. A tenant has many agents; later each phone number will belong to exactly one of them. Every tenant has one **default agent** (created when it signs up, named after the tenant); it can be renamed or disabled but not deleted.

- **Staff API** (`/v1/tenants/:tenantId/agents`): every role lists and reads agents (name, status, default flag); owner and admin create, rename, disable/enable and delete them, and read and edit their **settings** (`…/agents/:agentId/settings`, versioned: every save adds a version, `expectedVersion` guards against two people saving at once). Settings hold forwarding phone numbers, so the staff role `agent` cannot read them.
- **Plan limits:** Starter 1 agent and 0 phone numbers, Free 1 and 0, Pro 3 and 5, Enterprise unlimited (placeholders, set by the variables below). 0 numbers means browser test calls only. Disabled agents count; lowering a limit never deletes anything.
- **The engine pulls the settings:** `GET /internal/tenants/{tenantId}/agents/{agentId}/config` (service token, outside `/v1`, not in the public API) returns the current version, its ETag and the agent's status; see [docs/contracts/backend-internal.openapi.yaml](docs/contracts/backend-internal.openapi.yaml). With the mock engine a simulated call pulls the settings through the same service.

| Variable | What it sets | Placeholder the database starts with |
|---|---|---|
| `PLAN_STARTER_AGENTS`, `PLAN_FREE_AGENTS`, `PLAN_PRO_AGENTS` | agents per plan | 1, 1, 3 |
| `PLAN_STARTER_PHONE_NUMBERS`, `PLAN_FREE_PHONE_NUMBERS`, `PLAN_PRO_PHONE_NUMBERS` | real phone numbers per plan (assigned from Phase 5D) | 0, 0, 5 |

They work exactly like the plan variables below (optional, whole numbers in digits, 0 to 10,000, applied to the `plans` table at startup).

## Requests and the status check (Phase 5B-2)

A **request** is what the AI receptionist took on a phone call (an appointment or a call-back). The AI never books or confirms anything: it saves the request as `requested` and a person on the staff screen moves it on.

- **Staff API** (`/v1/tenants/:tenantId/requests`, every role including the staff role `agent`): `GET` the list (filters `status`, `type`, `agentId`, `from`, `to`, `q` = part of the reference, the customer's name or their phone number; newest first; `details` only in the detail), `GET …/counts` (a badge), `GET …/:requestId`, `PATCH …/:requestId/status` with `{status, note?, expectedStatus?}`. The moves: `requested → confirmed | cancelled`, `confirmed → done | cancelled | requested`, `done → confirmed`, `cancelled → requested` (each request lists its `allowedStatuses`). Two people acting at once cannot both win (409 `REQUEST_STATUS_CONFLICT`). Every move is audited (`request.confirmed|done|cancelled|reopened`, ids and statuses only). A new request notifies every active staff member (`request.submitted`) and pushes a `request.created` message to the dashboard stream.
- **What the engine calls** (outside `/v1`, service token, private network, not in the public OpenAPI): `PUT /internal/tenants/{tenantId}/customers/by-phone`, `POST …/requests` (idempotent by `submissionKey`), `PATCH …/requests/{reference}`, `POST …/requests/{reference}/withdraw` and the status check `GET /internal/tenants/{tenantId}/status?agentId=`. Once staff confirmed a request the engine's update is refused (409 `REQUEST_LOCKED`). The contract is [docs/contracts/backend-internal.openapi.yaml](docs/contracts/backend-internal.openapi.yaml); **it has been built against the mock engine only and the engine owner has not confirmed it.**
- **Try it without the real engine:** with `ENGINE_MODE=mock` (the default outside production) send `/call` in a mock widget chat, or call `engine.simulateCall(tenantId, { phone })` from a test: the mock asks the status check, creates the caller as an end customer, saves the request through the same services as the routes above and the staff API lists it.
- **Deleting an agent** that has requests is refused (409 `AGENT_HAS_REQUESTS`); disable it instead.

## Plan numbers and prices (environment variables)

The call minutes of each plan, the price of an extra minute, the Pro prices (and, since Phase 5B-1, the agents and phone numbers above) come from **environment variables**, not from code. All twelve are optional. Whole numbers in digits only (no decimals, signs or `1e3`); an empty value counts as "not set"; a bad value stops the backend from starting and the error names the variable (never its value). Money is in **minor units** (PKR 25 = `2500`); minutes are whole minutes. Bounds: minutes 0 to 1,000,000, money 0 to 2,000,000,000, agents and phone numbers 0 to 10,000.

| Variable | What it sets | Placeholder the database starts with |
|---|---|---|
| `PLAN_STARTER_CALL_MINUTES` | call minutes of Starter, counted in total over its 15 days | 30 |
| `PLAN_FREE_CALL_MINUTES` | call minutes of Free per month | 20 |
| `PLAN_PRO_CALL_MINUTES` | call minutes of Pro per month | 300 |
| `PLAN_PRO_OVERAGE_MINUTE_MINOR` | price of one extra minute on Pro | 2500 (PKR 25) |
| `PLAN_PRO_PRICE_MONTH_MINOR` | Pro price per month | 1999900 (PKR 19,999) |
| `PLAN_PRO_PRICE_YEAR_MINOR` | Pro price per year | 19999000 (PKR 199,990) |

The placeholders are the data the Phase 5A migration put into the `plans` table; they are to be confirmed against real call costs. Enterprise has unlimited minutes and a custom price (set per tenant by a platform admin).

**How it works.** The `plans` table stays the single source of truth that all other code reads. At startup the backend writes the variables that are **set** into the matching plan rows (once, in one transaction under a Postgres advisory lock, so several instances starting together do not fight) and logs one line per change (`plan`, `field`, `from`, `to`); a variable that is **unset** leaves the value already in the table, and nothing is logged when nothing changes. The public price list (`GET /v1/plans`), `GET /v1/me`, the billing screens, the limits and the reminders all read the table, so they follow.

**Before you change one:**
- Changing a variable and restarting changes the limits or prices of **every tenant on that plan, immediately** (other running instances see it within 30 seconds). Tenants with their own number (a platform admin's `entitlementsOverride`) keep it.
- Invoices already recorded are never touched.
- Every instance must run with the **same values**; the one that starts last wins.
- While a variable is set, a hand edit of that one field in the table is undone at the next start. Unset the variable to take manual control of that field.
- Changing a price here does not invoice anybody; payments are still recorded by a platform admin.

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
