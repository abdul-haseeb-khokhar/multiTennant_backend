# Backend Roadmap (backend core)

Owner: Abdul Haseeb · Status: draft v0.1 (2026-10-07) · Design: [architecture.md](architecture.md) · Open decisions: [team-alignment.md](team-alignment.md) (ids like A2, H1 refer to it)

Size: **S** ≈ days · **M** ≈ 1–2 weeks · **L** ≈ 2+ weeks (rough, solo, includes tests). Re-estimate at the start of each phase.

## Overview

| # | Phase | Size | Needs from others | Unblocks |
|---|---|---|---|---|
| 0 | Foundation and hardening | M | nothing | FE (OpenAPI, stable errors/pagination) |
| 1 | Account and team management | M | nothing (H3 mail provider can follow) | FE (auth, invite, audit, language screens) |
| 2 | Shared infrastructure and engine contract (continued as **5C**) | S–M | AI: A1–A6, D2, schema requests | everything that talks to the engine |
| 2B | Billing foundation (plans, subscriptions, entitlements, manual payments) | M | nothing (can run beside 2); **built**, reminders wait for H5 | Phase 3 enforcement, FE billing screens |
| 3 | Gateway and widget entry (**built**, mock engine only; widget work **frozen**, L2) | M | AI: B5, D1–D3, engine create/message API; Phase 2B | FE widget, first end-to-end chat |
| 3B | Frontend gap-report fixes (confirmed defects, section J of team-alignment) | S | nothing; decisions J1–J8 from Abdul | FE (correct, safe API) |
| 4 | Human-agent flow and notifications (**built**; staff chat features **halted**, L2) | L | AI: C1–C4, D5, D6 | FE dashboard conversations |
| 4C | Mail provider: Resend, test mode (H3, decided) | S | Resend account and API key from Abdul | invites, resets and verification reach a real inbox |
| 4B | Pro overage setting and optional spending cap (J6, decided) | S | nothing; follows Phase 4 | FE billing switch |
| 3C | Account decisions: logout and revocation, email-first login, owner self-service and slug rename, upgrade request, time zone (J1, J2, J3, J4, J5, J7; J8 deferred) (**built**) | M | nothing | FE (logout, two-step login, settings, upgrade request) |
| 5A | Voice-first alignment: plans with call minutes, overage for minutes, plan numbers from environment variables, contracts, timeouts, docs, mock voice (**built**, branch `phase-5a-alignment`) | S–M | Abdul: minute numbers (placeholders ok), answers to M3 | everything below |
| 5B | agents foundation (5B-1, L7; **built**, branch `phase-5b1-agents`), then the tenant status check and the requests workflow (5B-2) | L | AI: confirm agent-aware engine (Q28), request shape and event names | a tenant has agents; staff can confirm what the agents take |
| 5C | Real-engine integration, first slice | M | AI: Q1–Q5 tested, his build steps 1–3 done | proof that the contract works |
| 5D | Phone numbers linked to agents, Twilio routing (backend first, L8), call tickets, dashboard test call (the only call path for Free and Starter) | L | AI: ticket design, public voice endpoint; Twilio account | a dialled number reaches the right agent |
| 5E | Call usage, billing and call history, per tenant and per agent | M | AI: usage-event shape | minutes counted, limited and shown |
| 5F | Agent settings and knowledge, per agent | L | Abdul: storage provider; AI | a business teaches and configures each agent |
| 6 | Telephony go-live (numbers, consent, SMS confirmation) | L | Twilio account, legal wording | real phone calls for real customers |
| 7 | Deferred: chat and widget (halted), WhatsApp, agent productivity, calendar, translation keys, spending cap | – | product decisions | – |
| 8 | Production hardening and launch | L | all above | go-live |
| 9 | Payment provider integration | M | provider chosen; company/bank account set up | self-serve card payments |

Phases 1 and 2 run **in parallel**: Phase 1 needs nobody, so do it while waiting for Abdullah and the frontend to answer [team-alignment.md](team-alignment.md). The order below is the order of dependency, not strictly calendar order.

---

## Phase 0: Foundation and hardening
**Goal:** a trustworthy base. No known security holes, stable API conventions, tests and CI.

Scope:
- [x] Lock down `/tenants`; add `platform_admins` and `/v1/admin/...` (B1); stop callers setting `plan`/`status` on create
- [x] `RolesGuard` and the role matrix (B2); owner-only owner creation
- [x] Fix `TenantUsersService.remove` argument order (user delete always 404s today)
- [x] Handle `P2002`/`P2025` on update paths and signup; cap `take` (max 100, default 20)
- [x] Response envelope `{data,total,skip,take}` for lists (G1)
- [x] `/v1` prefix, `@nestjs/swagger` OpenAPI at `/docs`, error body `{statusCode, code, message}` with stable codes (F5)
- [x] `@nestjs/config` with env validation (fail fast on a missing `JWT_SECRET`); `.env.example`; remove stray imports (`node:test`, `typescript`); use `QueryTenantUserDto`
- [x] `tenants.slug`, login by slug (B3); tenant `suspended` check in the guard (B6, basic)
- [x] Health endpoint, request-id middleware, JSON logging with `tenantId` (F3)
- [x] Tests: unit tests for every service (mocked Prisma, including tenant-isolation cases), e2e tests against a test database (auth, tenant mismatch → 403, role denials); CI running lint + test + build

Implementation status (merged to main, PR #1): all items are built; `npm test` (127), `npm run test:e2e` (67), `npm run build` and a full `tsc --noEmit` pass locally. Caveats, details in `CLAUDE.md` known issues 6, 8 and 9: the e2e suite uses **mocked Prisma** (the database-backed check is the CI `migrations` job), the new migration is **not applied** anywhere yet, the CI workflow has **not run yet**, and `oxlint` could not run on the build machine (blocked native binary), so lint is unverified locally. The static OpenAPI document is `docs/openapi.json` (served live at `/docs`).

Depends on: nothing. Decisions needed: B1, B2, B3, F5, G1 (all backend-owned; frontend should review G1).
**Done when:** known issues 1–9 in `CLAUDE.md` are closed, CI is green, and the OpenAPI document is published for the frontend.

## Phase 1: Account and team management
**Goal:** a real staff lifecycle, an audit trail and translations.

Scope:
- [x] Invitations: `staff_invites`, send/list/revoke/accept; remove password from user-create (H1)
- [x] Password reset, `tenant_user.status`, `password_changed_at` check (H2)
- [x] `Mailer` interface with a console implementation, `MAIL_MODE=link` for dev (H3)
- [ ] H3 follow-up: real mail provider. **Resend chosen on 2026-10-10**, test mode until a domain exists; scheduled as Phase 4C below (the `Mailer` interface and `MailModule` are the only places to change)
- [x] Email verification (H4)
- [x] Audit log: table, `@Audit` decorator/interceptor, query endpoint (H6)
- [x] i18n: `src/lang/<locale>/<ns>.json`, `GET /v1/i18n/locales` and `/:locale/:namespace`, ETag, `en` fallback, missing-key check script, `nest-cli.json` assets, `locale` columns (H7)
- [x] `GET /me` (profile, role, tenant, locale)
- [x] Also done in this phase: email normalisation (known issue 7) and an atomic last-owner check (known issue 4)

Implementation status (merged to main, PR #2): everything above is built except the mail provider. `npm test` (unit), `npm run test:e2e` (mocked Prisma), `npm run test:db` (new: the account flows over HTTP against a throwaway Postgres, including the constraints, the append-only trigger and the last-owner race), `npm run build` pass locally; `oxlint` could not run on the build machine (see `CLAUDE.md` known issue 9), so lint is unverified locally. Migrations `20261007120000_phase1_account_team` (additive) and `20261007120100_normalize_emails` (data guard plus CHECK constraints) are applied to the local `multitenant` database. Urdu translations were reviewed and accepted by the owner.

Depends on: Phase 0. Decision needed: H3 (mail provider; everything else is built behind the `Mailer` interface).
**Done when:** an owner can invite an agent who sets their own password, reset flows work end to end, role changes appear in the audit log, and the frontend can load `en` and `ur`. (All four are covered by `test/db/team-flows.db-spec.ts`; only the real mail provider is outstanding.)

## Phase 2: Shared infrastructure and engine contract
**Status 2026-10-21:** not started; its database and contract work is now scheduled as Phase 5C (real-engine integration), after Abdullah answered Q1 to Q5 (team-alignment M1) and tests the two-migration-history scenario.

**Goal:** both services run on one database and agree on the contract.

Scope:
- [ ] Agree A1–A6 with Abdullah; `docker-compose.yml` + `infra/init/00-init.sql`; switch `DATABASE_URL` and add `?schema=tenant_core` (A1, A2, A3)
- [ ] **Verify A2** (migration histories stay separate) on a throwaway database before anyone migrates
- [ ] Seed script: demo tenant with a fixed UUID, owner, agent, a few customers (A6)
- [x] Write the engine internal API as an OpenAPI file in `docs/contracts/` (Appendix A): the subset Phase 3 uses is in `docs/contracts/engine-internal.openapi.yaml` (built in Phase 3, **proposed, not yet reviewed by the AI side**)
- [ ] The agent-config schema (E1) and the rest of the engine API (claim, release, knowledge, actions, erasure); both sides review
- [x] Backend `EngineClient`: service token, request id, `Idempotency-Key`, timeouts and retry policy (D2, D7), plus a **mock engine** so backend work never waits for AI (built in Phase 3: `src/engine/`, `ENGINE_MODE=mock|http`; the HTTP client has only met a fake server so far)
- [ ] README: how to start everything from scratch, migration order

Depends on: AI answers to A1–A6 and D2; the AI side adds `end_customer_id` and the foreign keys (A5, B5).
**Done when:** a fresh clone brings up Postgres, runs both migration sets in order, seeds data, and the backend can call the mock engine and the real one.

## Phase 2B: Billing foundation
**Goal:** every tenant has a plan, Starter turns into Free after 15 days, limits are enforceable, and you can take payments manually, with a design that accepts a payment provider later without rework (section I of team-alignment).

Scope:
- [x] Tables: `plans` (seed Starter, Free, Pro, Enterprise), `subscriptions`, `invoices`, `billing_events`; money as integer minor units plus currency (I1, I4, I7). Also `invoice_sequences` (gapless numbers per year) and `data_use_consents`
- [x] Migrate existing tenants: every current tenant gets a Starter subscription starting at deployment; `tenants.plan`/`status` **kept as denormalised mirrors** of the subscription (expand-contract: nothing dropped), written only by `SubscriptionService` (I2, I3); pre-migration dump taken
- [x] `SubscriptionService.applyEvent()` state machine (idempotent, audited) and the transition job (timer + Postgres advisory lock); request-time checks for correctness through `getEffective` (I3, I8)
- [x] `EntitlementsService.check()` with a short cache, wired into seats/invites and the user API now (invite create, invite accept, user re-enable), ready for the gateway and knowledge upload later (I5); usage counters for conversations and knowledge are a stub until Phases 3 and 5
- [x] `BillingProvider` interface and `ManualProvider`; platform-admin endpoints activate, record-payment, extend, change-plan, cancel (I4, I6)
- [x] Subscription and invoice read endpoints for the tenant owner (`GET /v1/tenants/:tenantId/billing`), pricing endpoint for public plans only (`GET /v1/plans`)
- [x] Banner data for reminders and limits through `GET /v1/me` (`subscription`: plan, status, period end, `daysLeft`, `graceDaysLeft`, limits)
- [x] In-app reminder notifications for I8 (7/3/1 days, grace started, 80%/100% of a limit, downgrade happened): built in Phase 4 (H5), see `BillingRemindersService`
- [x] Error codes and `en`/`ur` translations: `PLAN_LIMIT_REACHED`, `PLAN_FEATURE_UNAVAILABLE`, `SUBSCRIPTION_PAST_DUE`, `TENANT_SUSPENDED` (existing), plus `NO_ACTIVE_SUBSCRIPTION`, `TENANT_CLOSED`, `INVALID_SUBSCRIPTION_STATE`, `SUBSCRIPTION_NOT_FOUND`, `PLAN_NOT_FOUND`, `NOT_IMPLEMENTED`. The Urdu text was written by an AI and needs a native-speaker check
- [x] `data_use_consents` table and owner API (`GET`/`PUT /v1/tenants/:tenantId/data-use`, default off, I11), without any training export

Implementation status (merged to main with Phase 3, PR #4): everything above is built except the in-app reminder notifications (they need H5). `npm test` (517), `npm run test:e2e` (187), `npm run test:db` (49, against a throwaway database, run twice) and `npm run build` pass; `oxlint` could not run on the build machine (CLAUDE.md known issue 9). Migration `20261007140000_phase2b_billing` is additive only (new tables, CHECK constraints, the append-only trigger on `billing_events`, the four seeded plans, a Starter subscription for every existing tenant starting at deployment); it was generated against a throwaway database and applied to the local `multitenant` database after a `pg_dump` of `tenant_core`.

How it works (details: `CLAUDE.md` rule 10 and the I-section of team-alignment.md):
- **One writer.** `SubscriptionService.applyEvent` is the only place that changes `subscriptions`, `invoices`, `billing_events` and the `tenants.plan`/`status` mirrors, in one transaction with an audit entry. The transitions are pure functions in `billing/subscriptions/state-machine.ts`.
- **Time.** An injectable `Clock`. `getEffective(tenantId)` applies due transitions on read, so Starter becomes Free on day 15 even if the job is late; the job (`billing.scheduler.ts`) sweeps on boot and every `BILLING_JOB_INTERVAL_MINUTES` (60) on every instance, one of them holding `pg_try_advisory_xact_lock`.
- **Provider later.** `BillingProvider` (checkout, portal, cancel, `handleWebhook(rawBody, headers) -> BillingEvent[]`) and `ManualProvider`. Phase 9 adds a class and registers it in `BillingCoreModule` and `BillingProviders`; the state machine, tables, enforcement and screens do not change.

Depends on: Phase 1. Decisions needed: I1–I10 confirmed with the accountant for tax and invoice wording (I7, **still open**); I11 needs legal review before any training use (**still open**).
**Done when:** a new tenant has Starter for 15 days and then Free automatically, an admin can activate Pro with a recorded invoice, limits return the right error codes, and nothing in the code mentions a specific payment provider outside `ManualProvider`.

## Phase 3: Gateway and widget entry
**Goal:** the first end-to-end conversation: a visitor chats through the widget and gets an AI answer.

Scope:
- [x] `api_keys` (widget/server), per-key allowed origins, per-tenant CORS for widget routes (D8): owner/admin endpoints under `/v1/tenants/:tenantId/api-keys` (create returns the key once, list, get, update origins, revoke), audit entries `apikey.*`, CORS via `WidgetCorsService`
- [x] `POST /v1/widget/sessions`: validate key and origin, check tenant status/plan, upsert `EndCustomer` per channel rules (B4), create the conversation in the engine, issue a widget token (D3); `GET /v1/widget/conversation` for history
- [x] `POST /v1/widget/messages` and the streamed reply (SSE) relayed from the engine (D1): one design, POST answering `text/event-stream` (events `accepted`, `token`, `escalated`, `fallback`, `done`, `error`)
- [x] Fallback and auto-escalation when the engine is down or the plan limit is reached (D7, I5): structured `fallback` with stable translated reason codes
- [x] Rate limiting per key, per visitor and per IP (in process memory, per instance), message length cap of 2,000 (F6)
- [x] `usage_daily` and the real `UsageProvider`: `conversationsPerPeriod` is enforced from real usage when a conversation starts (the roadmap said Phase 5; it was cheap and the exit criteria need it)
- [x] `usage.recorded` event receiver (`POST /internal/events`): built in Phase 4 (`src/events/`); the gateway counts from the reply stream and `UsageService` dedupes per conversation and message id, so an event for the same message is a no-op

Implementation status (merged to main, PR #4): everything above is built and tested against the **mock engine and a contract-faithful fake engine server only**; no real engine exists yet, so the second half of "Done when" (a full chat against the real engine) is open and waits for the AI side to implement `docs/contracts/engine-internal.openapi.yaml`. Migration `20261008100000_phase3_gateway` is additive (tables `api_keys`, `gateway_conversations`, `usage_daily`, `usage_events`); it was applied from empty to a throwaway database (drift check against `schema.prisma`: none; `npm run test:db`: 62 tests, repeated runs, which also caught and fixed a parallel-start race) and then to the local `multitenant` database after a `pg_dump` (the 11 existing tenants and their Starter subscriptions untouched). `npm run widget:walkthrough` was run against the real server on real Postgres with the mock engine and passes every step. How it works and how the frontend runs against the mock: `docs/contracts/README.md`; rules and known issues: `CLAUDE.md` rule 11 and known issue 12.

Decisions the docs did not settle (taken in Phase 3, change them in code if you disagree): a blocked or engine-less start is **HTTP 200 `status: "blocked"`** with a fallback text and no token (not 403); an over-limit conversation is created, counted and given to humans (`status: "limited"`); **`month` allowance = UTC calendar month**, `total` = since the UTC day the period began; widget origins are exact (no wildcards, https or http for localhost); a missing `Origin` header is refused; reading and managing API keys is owner/admin only (agents get 403); at most 10 active API keys per tenant; the widget token is signed with a secret derived from `JWT_SECRET`; `visitorId` must be 16 to 64 characters of `A-Za-z0-9_-`; `past_due` keeps chatting but cannot create new widget keys.

Depends on: Phase 2; engine endpoints for create/message; B4, B5, C3.
**Done when:** the frontend widget completes a full chat against the real engine, and a suspended tenant or wrong origin is refused. (Met against the mock engine; the real engine is outstanding.)

## Phase 3B: Frontend gap-report fixes
**Goal:** close the defects a frontend prototype found in the backend (report: `D:multiTennant_frontendGAP-REPORT.md`, triage in team-alignment section J). Small items, no new product decisions.

Scope (J0 in team-alignment; each with a test):
- [x] Signup password `@MaxLength(72)` (G23.11): counts bytes, and the invite and reset passwords use the same rule
- [x] Hide `passwordChangedAt` and `emailVerifiedAt` from agents in the user list (G23.3)
- [x] `TRUST_PROXY` setting so audit `ip` and per-IP limits are correct behind the frontend proxy (G25)
- [x] `PATCH /me` accepts `name: null`; 429 responses carry `Retry-After` (G29.1, G29.4): the header already existed, now CORS exposes it and the body has `retryAfterSeconds`
- [x] OpenAPI: invite `acceptedAt`/`revokedAt`, dev-only `link` fields marked (`x-dev-only`), one delete-response convention (G23.4, G23.6, G23.13): all five DELETE routes already answered 200 with the removed object, now tested and documented
- [x] Locale fields validated against the locale registry instead of an `en|ur` enum (G23.5)
- [x] `GET /v1/auth/invites/preview?token=` for the accept page (G20)
- [x] Re-check that reactivating a suspended tenant restores its previous state (G29.6): it did; covered by a database test
- [x] Fix stale text in team-alignment (G1 "bare array")

Decisions J1–J8 (logout and revocation, slug discovery, owner self-service, role rows, upgrade request, conversation unit, time zone, translation keys) were taken later: J1 to J5 and J7 are Phase 3C below, J6 is Phase 4B, J8 is deferred.

Implementation status (merged to main in PR #5; built before Phase 4, **no migration**): every box is done and has a test (`test/phase3b.e2e-spec.ts`, unit specs next to the code, one database test for the reactivation). Not handled from the gap report (they need decisions or are bigger): G3 logout (J1), G4 slug discovery (J2), G5 owner self-service (J3), G12 ownership rules, G13/G19 time zone and audit gaps, G17 upgrade request (J5), G21 translation keys (J8), G23.2 / .7 / .8 / .9 / .10 / .12, G24 search and sort on lists, G29.2 / .3 / .5 / .9 / .10.
**Done when:** every box above is ticked, tests cover each, and the OpenAPI document and CLAUDE.md are updated. (Met.)

## Phase 4: Human-agent flow and notifications
**Goal:** staff see escalated conversations, take over, reply and hand back, with live updates.

Scope:
- [x] Conversation read endpoints for the dashboard: list/queue/detail, filters by status and assignee (D6: engine API, option (a))
- [x] Claim, release, resolve, human reply, relayed to the customer channel (C1–C4, C2): the reply reaches the widget through `GET /v1/widget/events`
- [x] `POST /internal/events` receiver (signed) and dashboard SSE stream (D5)
- [x] In-app notifications: table, creation from events, read/unread API, `notification.created` over SSE, retention purge (H5)
- [x] Customer view: `GET …/customers/:id/conversations`
- [x] Role checks on every action; audit entries for claim/release/resolve
- [x] Also: the undelivered-escalation retry job, billing reminders (I8), conversations of a disabled or deleted user go back to the queue, the new engine calls and events in `docs/contracts/` as proposals

Depends on: Phase 3; C1–C4, D5, D6 and the engine's claim/human-message endpoints.
**Done when:** the demo scenario works: AI escalates → agent is notified → claims → replies → customer sees it → agent hands back → AI resumes. (Met on the mock engine; `npm run handoff:walkthrough` runs it against a live backend, the e2e and database suites run it automatically.)

Implementation status (merged to main, PR #5): everything above is built and tested against the **mock engine and a contract-faithful fake server only**; no real engine exists, and the engine owner has confirmed none of the new calls or events. Checks: `npm test` 1046, `npm run test:e2e` 413, `npm run test:db` 88 (a throwaway database, run several times), build, `tsc --noUnusedLocals`, Prettier and `oxlint` (0 errors) pass; `npm run handoff:walkthrough` was run against a live server on real Postgres. Migration `20261010100000_phase4_handoff` is additive only (tables `notifications`, `engine_events`, `stream_tickets`, two columns and an index on `gateway_conversations`); it was generated against a throwaway database, read, and applied to the local `multitenant` database after a `pg_dump` of `tenant_core`.

How it works (rules: `CLAUDE.md` rule 12 and known issue 13; flows: `docs/architecture.md` 5.3 and 5.7; wire contracts: `docs/contracts/`):
- **One pipe for engine events.** `EngineEventsService.ingest` is called by `POST /internal/events` (after the HMAC check) and by the mock engine in process. In one transaction it records (tenant, event id) in `engine_events` and applies the effects (usage, notifications); after the commit it publishes to the in-process `RealtimeHub` for the dashboard and the widget.
- **Conversations stay in the engine.** `ConversationsService` calls it through `EngineClient` with the verified tenant and the acting user, enforces the role rules (only the assignee replies, releases or resolves) and writes the audit entries; the engine enforces them again, atomically.
- **Streams.** `GET /v1/tenants/:tenantId/events` (Bearer header or a single-use 30 s ticket kept in the database) and `GET /v1/widget/events` (widget token, key and Origin re-checked); heartbeat, `Last-Event-ID` resume (100 events, else `resync`), caps per user and conversation. In process memory: several instances need Redis (Phase 8).
- **Notifications.** No text is stored; the frontend renders `<type>.title|body` with `params` (architecture 5.7). Reminders are created by the hourly billing job and are idempotent through a `dedupe_key`.

Decisions the docs did not settle (taken in Phase 4; change them in code if you disagree): `/internal/events` lives outside `/v1` and is authenticated by a signature, not by sending the token; a plain claim does not notify the claimant (`conversation.assigned` only when someone else assigned it); resolving needs the claim first (no resolving an unclaimed conversation); a repeated claim by the holder is a 200, not a 409; the dashboard shows an anonymous visitor as `web_ab12cd…` and the staff stream closes the oldest stream beyond five instead of refusing the sixth; `customer` in a notification is the name or that short label; billing reminders go to owners and admins only; tickets are stored in the database (a single-use ticket must also work across instances).

## Phase 4B: Overage setting (J6)
**Goal:** Pro tenants choose between paying PKR 15 per extra conversation (default) and a hard stop at the included amount.

Scope (decided by Abdul on 2026-10-10, see team-alignment J6):
- [x] `overageEnabled` billing setting (default true), owner-only change (`PATCH /v1/tenants/:tenantId/billing/settings`) with audit entry `billing.overage_changed`; exposed in `GET /v1/me` and `GET …/billing`
- [x] `EntitlementsService.check('conversations')` allows past the included amount when overage is on and the plan has an overage price; denies with `PLAN_LIMIT_REACHED` otherwise; the gateway keeps its fallback and `limit_reached` escalation for the hard stop
- [x] Overage count and amount per period in the tenant billing summary and in the platform-admin subscription view (manual invoicing now); `record-payment`/`activate` can store the count and amount on the invoice
- [x] Notifications: 80% and 100% of included, overage started (`usage.overage_started`), AI stopped (`usage.limit_reached`) (H5, I8)
- [ ] Decide and, if wanted, build the optional monthly spending cap for overage (**not decided, not built**: open question for Abdul; the design leaves room, see the 4B paragraph)
- [x] Tests: allowed/denied matrix per plan and setting, owner-only change, usage derivation, no overage on Free and Starter

Depends on: Phase 4 (notifications). **Done when:** switching the setting changes whether the AI keeps answering past the limit, and the billing summary shows the right overage count and amount. (Met, except the optional spending cap, which was not decided.)

Implementation status (merged to main, PR #6): built and tested on the mock engine and real Postgres. Migration `20261011092433_phase4b_overage` is expand-only (`subscriptions.overage_enabled boolean not null default true`; `invoices.overage_count` and `overage_amount_minor`, both nullable, with a CHECK that the amount is at most the invoice total); generated against a throwaway database, read, drift-checked.

How it works (rule 10 of `CLAUDE.md`, J6 in team-alignment):
- **Setting.** `SubscriptionService.setOverageEnabled` (the subscription writer) changes it under the row lock, writes a `overage.changed` billing event and the `billing.overage_changed` audit entry in one transaction and drops the entitlements cache. Owner only (`RolesGuard`); a plan without an overage price answers 409 `OVERAGE_NOT_AVAILABLE`; asking for the current value writes nothing. `overageSettings()` (`billing/overage.ts`) says `{available, enabled, priceMinor, currency}`; it is in the subscription summary of `GET /v1/me`, `GET …/billing` and the admin `GET`.
- **Enforcement.** `check('conversations')` returns `allowed: true, overage: true` past the included amount when the plan has the price and the setting is on, else `PLAN_LIMIT_REACHED` as before. Seats and knowledge never get overage. **`past_due` does not start overage** (that tenant keeps answering within the limit as before, and must not run up more charges); `suspended`/`closed` are denied first, as before. The gateway needed no new branch: `aiBlocked = !allowed`.
- **Numbers.** `OverageService.conversationSummary`: `overage count = max(0, used − included − held for a human)`; `used` is the same `usage_daily` figure the limit check reads; "held for a human" are the period's `gateway_conversations.ai_blocked` rows (conversations started at the limit while overage was off: counted as used, never answered by the AI, so never billed). `GET …/billing` and the admin `GET` carry `usage.conversations` (period, included, used, overageCount, overageAmountMinor, overagePriceMinor). Nothing is stored per conversation.
- **Invoices.** `record-payment` and `activate` accept optional `overageCount` + `overageAmountMinor` (both or neither, integers, amount at most the amount paid); stored on the invoice and in the billing event payload. No tax lines.
- **Reminders.** At 100% the hourly job sends `usage.overage_started` (overage on and applying) or `usage.limit_reached` (AI stops); 80% is unchanged. The two types have separate dedupe keys per period, so switching the setting never re-sends what was sent and the message that now applies is still sent once.

Decisions the docs did not settle (change them in code if you disagree): the setting lives in a column of `subscriptions` outside the state machine (it is not a state transition); overage does not apply while `past_due`; conversations held for a human are not billed even if the owner later switches overage on (they stay human-only for life, known issue 12); a change reaches other backend instances within the 30 s entitlements cache; the "overage started" reminder is sent when the included amount is used up (100%), before the first extra conversation, and its text says extras are billed from now on.

Open question for Abdul: the optional **monthly spending cap** for overage (J6). Not built. To add it: a nullable `subscriptions.overage_cap_minor`, a check in `EntitlementsService` comparing `OverageService`'s amount with it, and a "cap reached" notification; the summary already has the figures it needs.

## Phase 4C: Mail provider, Resend in test mode (H3)
**Goal:** invites, password resets and verification links are really emailed. Starts only after the Phase 4 session has finished, because both touch `env.validation.ts`, `.env.example` and the docs.

Scope (decided by Abdul on 2026-10-10, see team-alignment H3):
- [x] `ResendMailer` implementing `Mailer` (HTTPS call to Resend with the API key, timeout, one retry), selected by `MAIL_PROVIDER=console|resend`; production refuses `console`
- [x] Settings `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_FROM_NAME` (default `SupportDesk AI`, a working name), `MAIL_REDIRECT_TO`, `MAIL_TIMEOUT_MS` validated at boot and listed in `.env.example` (names only); production refuses `MAIL_REDIRECT_TO`
- [x] Redirect mode: every message goes to `MAIL_REDIRECT_TO` with the intended recipient in the subject/body header (needed because test mode only delivers to the Resend account's own address)
- [x] HTML and plain-text templates for invite, password reset, email verification and the billing reminders, from the `email.*` keys, en and ur (right-to-left), with the link and expiry (the billing templates are rendered and tested but **not sent yet**: wiring them to the reminder job is a follow-up)
- [x] Send failures are logged without recipient or link, never break the flow, and are reported to the caller (`delivery: sent | failed | skipped`); health warning after repeated failures
- [x] Tests with a fake Resend server (success, 403 test-mode rejection, timeout, retry), redirect mode, production refusals, template rendering in both locales
- [x] README section: how to create the Resend account and key, how to switch to a verified domain (SPF, DKIM, DMARC), what the free cap means

Depends on: a Resend account and API key from Abdul (kept in `.env`, never in chat). **Done when:** signing up, inviting and resetting a password deliver real emails to the Resend account's inbox, and the tests above pass. (The tests pass; real delivery to the inbox is **unverified**, Abdul checks it with the list in the README "Email" section.)

Implementation status (merged to main, PR #6): built and tested against a **fake Resend HTTP server**, and real delivery in test mode was confirmed by the owner on 2026-10-11; the build session never read or printed `RESEND_API_KEY`, and the test suites now force the console provider. No migration. The Resend API facts (error names, the 403 test-mode refusal, 429 quota errors, the Bearer key, the `Idempotency-Key` header, 100 a day / 3,000 a month on the free plan, 10 requests a second per team) were checked against Resend's official documentation on 2026-10-11 (resend.com/docs/api-reference/errors, …/emails/send-email, …/knowledge-base/resend-sending-limits). One thing the pages do not say: what the free plan does at its cap; the code treats a 429 `daily_quota_exceeded` / `monthly_quota_exceeded` as the signal.

How it works (rule 13 of `CLAUDE.md`):
- **Selection.** `MAIL_PROVIDER=console|resend` picks the `Mailer` in `MailModule`; production refuses `console`, `MAIL_REDIRECT_TO`, a `@resend.dev` sender and `RESEND_API_URL` (a test seam).
- **Sending.** `ResendMailer` posts to `/emails` with the Bearer key, JSON `from`, `to`, `subject`, `html`, `text` and an `Idempotency-Key`; 5 s per attempt, one retry (same key) only after a network error, a timeout or a 5xx. Failures become `MailDeliveryError` with a stable reason code; the provider's own error text is dropped because its test-mode refusal quotes an address.
- **Rendering.** `MailRenderer` + `formatMessage` (a small ICU subset: placeholders and plurals) render `email.<template>.*` and `email.layout.*`; HTML escaped everywhere, no images/scripts/tracking, links must be http(s), Urdu has `lang="ur" dir="rtl"`.
- **Callers.** `MailService.sendNow` never throws: it returns `delivery: sent | failed | skipped`. Used by invite create, signup (`verificationDelivery`) and verification resend; password reset keeps `queue` (background, constant 202). `MAIL_DELIVERY_FAILED` (the old 503 for a failed invite email) is no longer returned; the code stays registered.
- **Health.** `MailHealth` counts consecutive failures per instance; `GET /health/ready` shows `mail` and turns `degraded` after 3 (readiness stays 200).

Decisions the docs did not settle (change them in code if you disagree): signup and the verification resend now wait for the provider (up to about 10 s in the worst case) instead of sending in the background, because they must report `delivery`; a `@resend.dev` sender is refused in production; `MAIL_FROM_NAME` defaults to `SupportDesk AI`, `MAIL_FROM` to `onboarding@resend.dev`; the invite has no separate "resend" route (inviting the same address again replaces the pending invite and sends a new email); the test suites force the console provider because `.env` may hold real settings.

Follow-ups: send the billing reminders by email (templates exist; needs the recipients' addresses and locales, the 100-a-day cap in mind and a dedupe on the notification rows); bounce and complaint webhooks (suppression list); Urdu email texts need a native-speaker check.

## Phase 3C: Account decisions (J1, J2, J3, J4, J5, J7)
**Goal:** build the account-level decisions Abdul took on 2026-10-11 (team-alignment section J).

Scope:
- [x] J1: `tokens_valid_after` on `tenant_user` and `platform_admins`; `POST /v1/auth/logout` and `POST /v1/admin/auth/logout`; `JwtStrategy` and `PlatformJwtStrategy` reject older tokens; audit `auth.logout`
- [x] J3 + J7: `GET`/`PATCH /v1/tenants/:tenantId` (owner edits name, defaultLocale, timezone, slug); `tenants.timezone` default `Asia/Karachi`; slug rename rules (availability with suggestions, once per 30 days, old slug accepted for 30 days and reserved for 90, audit `tenant.slug_changed`)
- [x] J4 rows: nobody disables, demotes or deletes themselves (`CANNOT_MODIFY_SELF`), API-key routes verified closed to agents, consent stays owner only, one table-driven role-matrix test for the whole tenant API. **Not buildable yet (Phase 5):** the approvals list for owner and admin and the integration settings hidden from agents; when those routes are built they must be added to the matrix (an e2e test fails for any tenant route that is not in the table)
- [x] J5: `upgrade_requests` table, owner request route, platform-admin list and handle routes, mail to `PLATFORM_ADMIN_NOTIFY_EMAIL`, `PATCH /v1/admin/tenants/:id` no longer accepts `plan` or `status` (suspension moved to `POST /v1/admin/tenants/:id/subscription/suspend` and `/unsuspend`)
- [x] J2: `POST /v1/auth/login-email` and `POST /v1/auth/select-workspace` (selection token, workspace list with availability reasons, `unmatchedCount`, single-workspace shortcut), login throttling per email and per IP on both login routes with `Retry-After`, constant-time failure, password reset by email only (one email, one link, new password on every membership with that email, all sessions ended), `GET /v1/auth/slug-available` with suggestions; the old slug login keeps working
- [ ] J8 (translation keys) is deferred: not in this phase
- [x] Tests (unit, e2e, DB flows), OpenAPI, translations en and ur for every new code and text, docs

Depends on: nothing. **Done when:** the boxes above are ticked and the frontend can call logout, tenant settings and the upgrade request. (Met; J8 is deferred by Abdul, and the two Phase 5 rows of J4 wait for their features.)

Implementation status (branch `phase-3c-account`, not yet merged): everything above is built. `npm test` 1,416, `npm run test:e2e` 746, `npm run test:db` 112 (a throwaway database inside the existing Postgres container, run three times), `npm run build`, `tsc --noEmit --noUnusedLocals --noUnusedParameters`, Prettier and `oxlint` (0 errors) pass; `prisma migrate diff` from the migration files to `schema.prisma` shows no drift; the built server was started on the throwaway database and the new routes were called by hand (including a timing check of the failed login: about 80 ms for a known and for an unknown email). Four expand-only migrations (`20261013110120_phase3c_logout`, `…110600_phase3c_tenant_settings`, `…111713_phase3c_upgrade_requests`, `…112807_phase3c_email_reset`): new nullable columns (`tokens_valid_after` ×2, `tenants.slug_changed_at`, `password_resets.email`), `tenants.timezone NOT NULL DEFAULT 'Asia/Karachi'` (existing tenants get the default), `password_resets.all_workspaces boolean NOT NULL DEFAULT false`, and two new tables (`tenant_slug_aliases`; `upgrade_requests` with a CHECK on `status` and a partial unique index "one pending request per tenant" added by hand). Generated against the throwaway database and read.

How it works (rules: `CLAUDE.md` rule 14; decisions: team-alignment J1 to J5 and J7):
- **Tokens (J1).** Every staff and platform token now carries `iatMs`, the issue time in milliseconds, next to the library's whole-second `iat`. `tokens_valid_after` is one timestamp per user, set by logout; `password_changed_at` works the same way. `wasIssuedBefore` (`auth/token-freshness.ts`) compares in milliseconds when the token has `iatMs` (a login right after a logout or reset works, a token issued earlier in the same second is still refused) and falls back to whole seconds for tokens signed before this phase (valid for at most a day). Logout uses `SessionAuthGuard` (a valid token, no tenant-status check) so a user of a suspended workspace can still end their sessions. It ends EVERY session of that user ("log out everywhere"); widget tokens are not touched. Platform-admin logout is written to the application log, not to `audit_logs` (that table is per tenant and an admin has none).
- **Slugs (J3).** `SlugService` (`src/slugs/`) is the one place that decides availability: a slug is taken when a tenant has it, when a tenant gave it up less than 90 days ago (`tenant_slug_aliases.reserved_until`), or when it is one of the words we keep. Login and the slug password reset resolve an alias for 30 days (`accepted_until`). Claims on slugs (signup, rename) queue behind a transaction-level Postgres advisory lock, because the unique index on `tenants.slug` cannot see an alias created in a parallel transaction. Rename: owner only, at most once per 30 days (`SLUG_CHANGE_TOO_SOON` with `nextAllowedAt`), taken slugs answer `SLUG_TAKEN` with `suggestions`, the old slug becomes an alias, taking one of your own old slugs back removes that alias; audited as `tenant.slug_changed` with before and after.
- **Email-first login (J2).** `POST /v1/auth/login-email` compares the password with the memberships of that email and answers with only the matching ones; `POST /v1/auth/select-workspace` opens one. The selection token (`scope: "workspace-select"`, 10 minutes, a secret derived from `JWT_SECRET` with its own label) lists `tenant_user` ids only, is re-checked on every selection (user exists, active, workspace usable, no logout or password change after it was issued) and can be used again to switch workspaces until it expires. A request always runs exactly 3 bcrypt comparisons (distinct password hashes first, dummy ones to fill), so an unknown email takes as long as a known one and one request never costs more than three hashes; workspaces sharing a password share one hash. Login throttling (`LoginThrottleService`, in process memory): 60 requests per minute per IP, 5 wrong passwords per (email, IP) and 30 per IP in 15 minutes, 429 with `Retry-After`; only failures count, a correct password clears the pair, and there is no counter per email alone, so nobody can lock a victim out from another address.
- **Reset by email (J2).** `POST /v1/auth/password-reset/request` takes `{email}` (slug optional): one email, one link, one stored reset with `all_workspaces = true`; confirming gives every membership with that email the same new hash in one transaction, ends their sessions and writes `password.reset` into each workspace's own audit log. Every reset now remembers the address it was sent to and is refused if the user's email changed since (this also closes a hole in the old single-workspace flow). The per-email allowance (3 an hour) is shared by both ways in.
- **Upgrade request (J5).** The owner (verified email) asks; asking again while one is pending replaces it. Platform admins list and handle requests; the mail to `PLATFORM_ADMIN_NOTIFY_EMAIL` is `sendNow` (a failed or skipped mail never loses the request and is reported as `notification`).

Decisions the docs did not settle (taken in Phase 3C; change them in code if you disagree):
- **Selection and logout are per user.** Logging out of workspace A stamps only A's membership, so a selection token that was issued before still opens workspace B for up to 10 minutes. A person who wants everything closed logs out of each workspace (Option 2, one account per person, would fix it).
- **More than 3 different passwords for one email:** only the newest three are tried; the rest count in `unmatchedCount`. A reset by email makes them one again.
- **Disabled and suspended workspaces** are listed with a reason, and when no listed workspace is available there is no `access_token`; the slug login keeps its 403 answers.
- **Upgrade request details:** a second request replaces the pending one (no 409); plans that are not public answer 404 `PLAN_NOT_FOUND`; the same plan answers 409 `ALREADY_ON_PLAN`; any public plan different from the current one is accepted, so a Pro tenant can "request" Free (the platform team decides); an unverified owner gets 403 `EMAIL_NOT_VERIFIED` (the intent of H4 and known issue 5); at most 5 requests an hour per tenant; owners and admins may read the latest request (`GET …/billing/upgrade-request`, answers `{request}`), only the owner may ask; the admin email is always English (platform admins have no language); handling a request does NOT change the plan.
- **Suspension moved.** With `status` gone from `PATCH /v1/admin/tenants/:id`, `POST /v1/admin/tenants/:id/subscription/suspend` and `/unsuspend` were added (same events as before, same audit entries).
- **Self-protection runs first.** The sole owner who tries to disable, demote or delete themselves gets `CANNOT_MODIFY_SELF`, not `LAST_OWNER`; the last-owner rule stays as the guard for races between two owners (still tested).
- **Time zone** is validated against the runtime's tz database through `Intl` (aliases such as `asia/karachi` are accepted and stored in the canonical spelling; UTC offsets such as `+05:00` are refused).
- **Admin PATCH:** `plan`/`status` are refused with 400 `USE_SUBSCRIPTION_ROUTES` instead of being ignored silently; the admin PATCH still takes `name` and `defaultLocale` only.

## Voice-first plan (decided 2026-10-21): how the next phases fit together

**Direction (team-alignment L and M):** the product is an AI **phone receptionist**. Callers talk to Abdullah's engine; the engine saves **requests** (appointments, call-backs) that staff confirm; the backend owns tenants, plans and billing in **call minutes**, the staff screens, phone numbers and the status check the engine asks before serving a business.
**Halted (decided 2026-10-21): message operations.** Nothing is removed and everything built keeps working, but there is no new work on the chat widget (Phase 3), the widget keys, the staff chat queue with claim and reply (Phase 4), WhatsApp, or the chat-conversation limits. Chat is a secondary channel for later (Phase 7).
**Dropped:** tenant integration secrets and risky-action approvals (the engine executes no actions; each side keeps its own secrets).
**Frontend track (runs beside every phase):** after each backend phase the frontend prototype is adapted and re-verified, and its gap report refreshed. New screens: requests, phone numbers, minutes usage, call history, plan and billing with minutes.
**agents and numbers (decided 2026-10-28, L7, L8, L9):** a tenant has many agents and many phone numbers; each number belongs to exactly one agent; a default agent is created for every tenant at launch; the backend routes the call (decided) and the engine answers by the agent's settings. The workflow check of 2026-10-28 is team-alignment L9. Phase 5B now starts with the agents foundation (5B-1); the letters 5C to 5F are unchanged.
**People track (not code):** send Abdullah the answers to his eight questions (M3); he tests the two-migration-history scenario (Q2); Abdul decides the open items in Phase 5A and 5F.

## Phase 5A: Voice-first alignment
**Goal:** make everything already built consistent with a voice-first product, so later phases do not build on the old chat assumptions.

Scope:
- [x] **Plans with call minutes** (decided: Starter and Free include them). New entitlement keys `callMinutesPerPeriod`, `callMinutePeriod` (`total` or `month`) and `overageMinuteMinor`; `voice` becomes true and `channels` includes `voice` on Starter, Free, Pro and Enterprise. Seeded through an expand-only data migration after a dump. **Placeholder numbers, adjustable as data:** Starter 30 minutes in total (15 days), Free 20 minutes a month, Pro 300 minutes a month with overage PKR 25 a minute (the price already in the plan), Enterprise custom. The chat-conversation limits stay as they are (frozen).
- [x] **Env-driven plan catalogue** (instruction for this phase, 2026-10-21): the plan numbers and prices come from environment variables, not from code. `PLAN_STARTER_CALL_MINUTES`, `PLAN_FREE_CALL_MINUTES`, `PLAN_PRO_CALL_MINUTES`, `PLAN_PRO_OVERAGE_MINUTE_MINOR`, `PLAN_PRO_PRICE_MONTH_MINOR`, `PLAN_PRO_PRICE_YEAR_MINOR` (minutes 0 to 1,000,000, money in minor units 0 to 2,000,000,000; all optional, empty = unset). Validated at boot; `PlanCatalogSyncService` writes only the set ones into the `plans` table once at startup under a Postgres advisory lock and logs one line per change; the table stays the single source of truth. Documented in CLAUDE.md rule 15, README and `.env.example`.
- [x] **Overage for minutes:** the owner's on/off switch (J6, default on) applies to call minutes on plans that have an overage price; off means a hard stop (the status check answers `quota_exceeded`). The overage count and amount come from `usage_daily.call_minutes`; the 80% and 100% reminders and the billing summary show minutes. (Conversation overage stays as built for chat.)
- [x] **Engine defaults:** `ENGINE_FIRST_TOKEN_TIMEOUT_MS` 10000; the backend already sends Bearer `INTERNAL_API_TOKEN` (his new routes), the old `x-internal-key` routes and the port clash (both default 3000) are documented in the README and `docs/contracts/README.md`.
- [x] **Contracts:** update `engine-internal.openapi.yaml` and `backend-events.openapi.yaml` with what Abdullah agreed (M1: `content_key`, `provider`, token counts, idempotent claim, 10 s); write a new `backend-internal.openapi.yaml` for the routes the engine calls (status check, requests, customer upsert, number lookup); decide the event names (`record.submitted` and `record.updated` added to the receiver, M2.4).
- [x] **Mock engine:** simulate a call-shaped request (a saved request, its updates, and call-minute usage) so the backend and frontend can be built without the real engine.
- [x] **Docs:** voice flow and the new ownership split in `architecture.md`; CLAUDE.md rules; mark the chat features halted.
- [x] Remove or leave unused the `action.proposed` event and notification (approvals dropped): **left in place and marked unused** (contract, notification types, architecture, mock command `/action`).

Needs: Abdul accepts or changes the placeholder minute numbers (now with the `PLAN_*` variables or the table); Abdul's answers to M3 go to Abdullah.
**Done when:** the plans table, entitlements, status of billing screens and the contracts all describe a voice-first product, tests and docs are updated, and the mock can produce a request and minutes. (Met.)

Implementation status (branch `phase-5a-alignment`, not yet merged; it is cut from `docs/voice-first-plan`, which holds Phase 3C and the voice-first docs, neither merged either): every box above is done. `npm test` 1,585 (1,416 before), `npm run test:e2e` 761 (746), `npm run test:db` 136 (112; a throwaway database inside the existing container, run twice on a fresh one), `npm run build`, `tsc --noEmit --noUnusedLocals --noUnusedParameters`, Prettier, `oxlint` (0 errors), `prisma validate`, `prisma migrate diff` (no drift) and `npm run i18n:check` pass. The built server was started on a throwaway database with `PLAN_FREE_CALL_MINUTES` and `PLAN_PRO_PRICE_MONTH_MINOR` set: it logged one line per change, `GET /v1/plans` showed the new values, a second start with the same values logged nothing, a bad value (`12.5`) refused to start and named only the variable; `npm run widget:walkthrough` passes; a hand run of `/call` and `/call-update` through the widget produced a reference, the events were acknowledged and the billing summary showed the plan's minutes. One e2e test (login throttling, 5 s timeout) timed out once under load in the baseline run and passes alone and in every later run. Migration `20261021120000_phase5a_call_minutes` is data-only (the new entitlement keys for the four seeded plans, `voice` true, `voice` added to `channels`) plus one looser CHECK (`usage_events.kind` also allows `call`); no table or column is added, dropped or retyped, nothing already stored is changed except those plan rows; a hand-written migration because there is no schema change for `migrate dev --create-only` to see; applied from empty to a throwaway database (drift check: none) and to the local `multitenant` database after a `pg_dump`.

How it works (rules: `CLAUDE.md` rule 10 for the minutes and rule 15 for the environment variables; contracts: `docs/contracts/`):
- **Minutes.** `check('callMinutes')` asks "may one more minute be served?" and sums `usage_daily.call_minutes` over the plan's window (`total` from the day the period began, `month` = UTC calendar month). One owner switch (`overage_enabled`) governs call minutes and chat conversations: a plan has the switch when it prices either, overage applies to a unit only with that unit's price, and `past_due` is served within the allowance and never into overage. `GET …/billing` has `usage.callMinutes` (included, used, `overageMinutes`, `overageAmountMinor`, `overagePriceMinor`), `subscription.overage` has `minutePriceMinor`, `GET /v1/plans` and `GET /v1/me` carry the new entitlement keys.
- **Environment variables.** Six optional `PLAN_*` variables; boot validation refuses a bad one; `PlanCatalogSyncService` writes only the set ones into the `plans` table at startup (one transaction under an advisory lock, one log line per change, nothing logged or written when nothing changes) and the table stays the source of truth. The test setups blank the variables because `.env` may hold real ones.
- **Reminders.** `usage.minutes_threshold` (80%), `usage.minutes_overage_started` and `usage.minutes_limit_reached` (100%): only the one that fits the current state, deduped per unit and period, same hourly job.
- **Mock engine.** `/call`, `/call-update`, `simulateCall`, `simulateRequestUpdate`, `lockRecord`: a saved request with a reference such as `AP-4K7Q2`, its update (refused once locked) and the call length. The receiver acknowledges `record.submitted`, `record.updated` and `usage.call_minutes` and stores nothing until 5B and 5E. Minutes can only be written by tests, through `UsageService.recordCallMinutes`.

Decisions the docs did not settle (taken in Phase 5A; change them in code if you disagree):
- **One switch for both units**, not one per unit, and the switch exists when the plan prices either unit. The conversation behaviour is unchanged on every existing plan.
- **Minutes past the allowance are counted as overage even when the owner turned overage off** (a call that is already running is not cut off; `max(0, used − included)`, no "held for a human" for minutes). The status check of 5B stops new calls at the limit, so this only affects the call that crosses it.
- **`check('callMinutes')` asks for one more minute**, so a tenant at exactly its allowance is refused (or allowed with `overage: true`); the reminder job asks with amount 0.
- **Invoices keep their single overage count/amount pair** from the chat era; the admin types the minute overage amount into it. A `overage_minutes` column is a 5E decision together with how seconds become billed minutes (proposal: round each call up).
- **Enterprise is unlimited minutes** (null); a custom number goes through `entitlementsOverride`, which accepts the new keys.
- **Pending voice-first events are not stored in the inbox** (so a re-delivery after 5B is processed instead of answered `duplicate`) and are acknowledged only after the tenant check.
- **The status check's `unpaid` reason is reserved** in the draft contract (nobody gets it), because an unpaid Pro tenant falls to Free after the 7-day grace period and is served within its plan meanwhile; a plan without voice (only through an override) has no reason yet. Both are questions for Abdullah in the draft.
- **`voicePerMinuteMinor`** (Pro, Phase 2B) stays in the data as a legacy hint that nothing reads; `overageMinuteMinor` is the price.
- **A sync failure refuses the boot** (an operator who set a price must not run on a different one); a plan row that does not exist or has malformed entitlements is skipped with a warning.
- The plan variables were validated in `validateEnv` from the raw config rather than as typed class fields, because the class-transformer conversion would turn an empty value into 0.

## Phase 5B: agents, tenant status check and the requests workflow
**Goal:** a tenant has agents; the engine can ask whether a business and agent may be served; staff can confirm the requests the agents take. 5B-1 is new since 2026-10-28 (team-alignment L7); 5B-2 is the former 5B with the agent added.

### 5B-1 agents foundation
- [x] `agents` table (tenant, name, status `active` or `disabled`, default flag, timestamps; exactly one default per tenant) and CRUD under `/v1/tenants/:tenantId/agents` (owner and admin write, every role reads), audit entries, translated errors
- [x] A default agent is created in the signup transaction; an expand-only data migration creates one for every existing tenant (dump first)
- [x] Plan limits as entitlement keys `agents` and `phoneNumbers`, enforced when an agent is created or a number assigned; placeholders **Starter 1 agent and 0 numbers, Free 1 and 0, Pro 3 and 5, Enterprise custom** (decided 2026-10-28: Free and Starter make browser test calls only; real numbers are for Pro and Enterprise, rental included up to the limit); set from the same `PLAN_*` environment-variable mechanism as the minutes (names to follow the pattern, for example `PLAN_PRO_AGENTS`, `PLAN_PRO_PHONE_NUMBERS`)
- [x] The default agent cannot be deleted; deleting or disabling an agent with numbers is refused or needs the numbers moved first (to decide, safest: refuse) - **refused** (409 `AGENT_HAS_NUMBERS`); the check is a small injectable that answers "no numbers" until Phase 5D
- [x] Naming: "agent" means the tenant's agent everywhere; the staff role `agent` is **not renamed** (decided 2026-10-28); screens and the API keep the two apart by context (the Agents menu against the role label)
- [x] **Agent settings document and the engine's config route (L7, pull decided):** a versioned JSON settings document per agent (defaults for a new agent), owner and admin edit it, and `GET /internal/tenants/{tenantId}/agents/{agentId}/config` returns it to the engine, which calls it at the start of every call (internal-token auth, version in the answer, cacheable up to 60 s); the call ticket carries tenant id, agent id and settings version only; the field list is the engine's, validation goes through the engine (to agree with Abdullah)
- [x] Contracts: add `agentId` to `backend-internal.openapi.yaml` (status check, requests, customer upsert, the number lookup, if it is kept at all, answers `{tenantId, agentId}`), to the event data in `backend-events.openapi.yaml` and as the `X-Agent-Id` header in `engine-internal.openapi.yaml`; the mock engine accepts and returns agent ids; update the references to phase letters in code comments and CLAUDE.md known issue 15
- [x] Rows in the role-matrix test, tests incl. two-tenant isolation and limit enforcement; frontend: agent list and edit name/status (the frontend part is the frontend colleague's: see "What the frontend needs" below)
Needs: Abdul's answers on the open items of L7; Abdullah: confirm the engine becomes agent-aware (Q28), possibly with a nullable `agent_id` meaning "the tenant's default agent" during migration.
**Done when:** a new tenant has a default agent, an owner can add agents up to the plan limit, and the contracts carry the agent id. (Met.)

Implementation status (branch `phase-5b1-agents`, cut from `phase-5a-alignment`; nothing committed or merged): every box above is done. `npm test` 1,766 (1,585 before), `npm run test:e2e` 836 (761), `npm run test:db` 156 (136; a throwaway database inside the existing container, run on a fresh one), `npm run build`, `tsc --noEmit --noUnusedLocals --noUnusedParameters`, Prettier, `oxlint` (0 errors), `prisma validate` and the `prisma migrate diff` drift check, `npm run i18n:check` and a real boot of the built server (signup, the default agent in the list, the pull route 401/200/ETag, the second Starter agent refused) pass. Two migrations: `20261028100000_phase5b1_agents` (two new tables, expand-only) and `20261028100100_phase5b1_agents_data` (data only: a default agent plus settings version 1 for every existing tenant, and the plan limits). The data migration was applied to the local `multitenant` database after a `pg_dump` of `tenant_core`: 100 tenants before and after, 100 default agents and 100 settings v1 rows, none missing.

How it works (rule 16 in `CLAUDE.md`; contracts in `docs/contracts/`):
- **Agents.** Table `agents` (`active` | `disabled`, `is_default`); one default per tenant by a partial unique index, a name unique per tenant ignoring case, the name stored trimmed (1 to 80). Routes `/v1/tenants/:tenantId/agents`: list and get for every role (name, status, default flag only), create, rename or disable (one PATCH), delete for owner and admin, all audited by name and status (`agent.created|renamed|disabled|enabled|deleted`). The default agent can be renamed and disabled but not deleted. A disabled agent stays readable and editable. Disabling or deleting an agent that has phone numbers is refused (`AGENT_HAS_NUMBERS`): `AgentNumbersCheck` answers 0 until Phase 5D plugs in its count.
- **Default agent.** `AgentProvisioningService.provision` creates it (and settings v1 and the audit entry) inside the signup transaction, named after the tenant; the only other creator is `AgentsService.create` for further agents.
- **Plan limits.** Entitlement keys `agents` and `phoneNumbers` (Starter 1/0, Free 1/0, Pro 3/5, Enterprise unlimited, missing = 0). `EntitlementsService.assertCountAvailable` takes the subscription row lock, counts the tenant's agents (disabled ones too) in the transaction and refuses with 403 `PLAN_LIMIT_REACHED` and `details { limit, used, max }` (a past-due, suspended or closed tenant gets its own code and cannot add agents). `phoneNumbers` counts 0 until Phase 5D. Six new optional variables set the numbers (`PLAN_{STARTER,FREE,PRO}_AGENTS`, `PLAN_{STARTER,FREE,PRO}_PHONE_NUMBERS`, 0 to 10,000). `GET /v1/plans`, `GET /v1/me` (limits) and `GET …/billing` (`usage.agents`, `usage.phoneNumbers`) show them.
- **Settings.** Table `agent_settings` (version from 1, `document` jsonb in the engine's shape, append-only by a trigger that refuses UPDATE, deleted only with its agent). `GET …/agents/:agentId/settings`, `PUT` (a top-level patch: the keys sent replace those keys; `expectedVersion` required, a stale one is 409 `AGENT_SETTINGS_VERSION_CONFLICT` with `currentVersion`; a save that changes nothing adds no version), `GET …/versions` and `…/versions/:n`. Owner and admin only (the document holds forwarding phone numbers). `AgentSettingsValidator` is injectable: the built-in structural implementation checks keys, types, enums, the 64 KB cap, international phone numbers, at most 5 contacts, hours as `HH:MM` ranges; `collect` (what the agent collects), `capabilities` and the voice ids are the engine's and stored as they are. The hook for the engine's own validation route is documented on the class; no route that does not exist is called. Problems come back as 400 `AGENT_SETTINGS_INVALID` with `details: [{field, code, params?}]`; the codes are translated in `common` as `agent_settings.problem.<code>`. The audit entry holds version numbers only.
- **The engine's pull route.** `GET /internal/tenants/{tenantId}/agents/{agentId}/config` (outside `/v1`, not in the public OpenAPI): service token (`InternalTokenGuard`, constant-time, 503 when unconfigured), tenant AND agent checked together (one 404 for every kind of miss), `?version=`, `ETag`/304, `Cache-Control: private, max-age=60`, a disabled agent answers 200 with `status: "disabled"`, 600 pulls a minute per tenant, the body is never logged. `AgentConfigService` is the one reader; the mock engine's `simulateCall` pulls through the same service (it became `async`, takes `agentId`, defaults to the default agent, returns `agentId`, `settingsVersion` and the pulled `config`, throws `MockAgentUnavailableError` for a disabled agent), and the call events carry `agentId`.
- **Contracts.** `agentId` is in the status check, requests, customer upsert and the new config route of `backend-internal.openapi.yaml`, in the event data of `backend-events.openapi.yaml`, and `X-Agent-Id` is in `engine-internal.openapi.yaml`; the call ticket (tenant id, agent id, settings version) is described, the number lookup is marked "not needed under backend-first routing (L8), kept only as a fallback".

Decisions the docs did not settle (taken in Phase 5B-1; change them in code if you disagree):
- **Agent names are unique per tenant, ignoring case** (409 `AGENT_NAME_TAKEN`); the default agent is named after the tenant and can be renamed.
- **`businessName` in a new agent's settings is the tenant's name** (the business is what callers hear; the agent name is a dashboard label), the time zone and the language (`en`/`ur`, else `en`) are the tenant's.
- **`PUT …/settings` is a top-level patch with a required `expectedVersion`**, like the engine's own `PUT /api/agent-config`; `hours` and `collect` may be `null`. A save that changes nothing returns the current version and adds none.
- **Call forwarding may not be switched on without a contact** (the engine says the same), so the structural check includes it.
- **Deleting an agent is a hard delete** (its settings versions go with it). When Phase 5B-2 adds requests that carry an agent id, it must choose between refusing the delete of an agent that has requests and a soft delete; Phase 5D's `phone_numbers.agent_id` foreign key must be RESTRICT (the service maps the foreign-key error to `AGENT_HAS_NUMBERS`).
- **The default agent may be disabled** (nothing in L7 forbids it); the status check of 5B-2 will answer `agent_disabled`.
- **Past-due tenants cannot add agents** (they cannot grow, like seats); lowering a plan limit never deletes anything: it only refuses new agents.
- **Every agent of a tenant shares its minutes** (pooled per tenant, L7); nothing per agent is limited.

What the frontend needs (the frontend is not touched here): an **Agents** menu (list, add up to the limit, rename, enable/disable, delete; keep it apart from the staff role label `agent`), the limit and usage from `GET …/billing` (`usage.agents`) and the plan list (`entitlements.agents`, `entitlements.phoneNumbers`), a settings screen per agent for owner and admin (read, save with `expectedVersion`, reload on 409 `AGENT_SETTINGS_VERSION_CONFLICT`, show `details` per field with the `common` keys `agent_settings.problem.*`, version history), and the new error codes (`AGENT_NOT_FOUND`, `AGENT_NAME_TAKEN`, `CANNOT_DELETE_DEFAULT_AGENT`, `AGENT_HAS_NUMBERS`, `AGENT_SETTINGS_INVALID`, `AGENT_SETTINGS_VERSION_CONFLICT`, `AGENT_SETTINGS_VERSION_NOT_FOUND`; `PLAN_LIMIT_REACHED` now carries `details` for agents). The Urdu texts of the new keys were written by an AI and need a native-speaker check.

### 5B-2 Tenant status check and the requests workflow
- [ ] **Tenant status check (his B1):** `GET /internal/tenants/{tenantId}/status` (optionally `?agentId=`) → `{tenantId, agentId, serviceable, reason, plan}`, `reason` one of `suspended`, `unpaid`, `quota_exceeded`, `agent_disabled`, `unknown_tenant` or null, derived from the effective subscription, the entitlements including call minutes and the agent's status; internal-token auth; no data leak for an unknown tenant
- [ ] **Requests (his B4):** requests table (reference unique per tenant, agent id, `submissionKey` idempotency, status workflow with conditional updates, 409 `locked` once confirmed, and 409 `reference_taken` so the engine draws another reference), customer upsert by phone, internal routes (create, update details, withdraw), receiver for `record.submitted` and `record.updated`
- [ ] **Staff API** `/v1/tenants/:tenantId/requests` (list with filters incl. agent, search; detail; change status), audit entries, a notification for new requests, a live update on the dashboard stream, roles (proposal: all roles can work requests), rows in the role-matrix test
- [ ] Tests at unit, e2e and database level incl. two-tenant isolation, idempotent create and the agent dimension; the mock engine drives the whole flow
- [ ] Frontend: requests list and detail with confirm, done and cancel, filter by agent

Needs from AI: confirm the request shape and the event names (M2.4). Details: [phase-5-plan.md](phase-5-plan.md).
**Done when:** with the mock engine a call-shaped request is saved for an agent, appears on the staff screen, is confirmed, and the engine's later update is refused with `locked`.

## Phase 5C: Real-engine integration, first slice
**Goal:** prove the contract against Abdullah's real engine early, before building more on guesses.

Scope:
- [ ] Shared database agreed and tested on a throwaway database (Q1 to Q5): database `caller-ai-agent`, separate `?schema=` per project, `vector` extension created in schema `ai_engine`, `tenants.id` is text, his foreign keys on every table with `tenant_id` as a separate migration, migration order, dev compose and seed
- [ ] `ENGINE_MODE=http` against the real engine: status check, requests, events, and (as far as he has built them) the conversation routes; the shared token set privately
- [ ] Contract tests that run against both the mock and the real engine; fix every drift found; update the contract files
- [ ] Record what is still different (timeouts, missing routes) in team-alignment M

Needs from AI: his build steps 1 to 3 done (columns, idempotency table, outbox, Bearer guard); Q2 tested. **This phase waits for him; do not start before he reports ready.**
**Done when:** a request saved by the real engine appears on the staff screen and the status check is answered for a real tenant.

## Phase 5D: Phone numbers, Twilio routing and call tickets
**Goal:** a dialled number reaches the right agent of the right business (L7, L8).

Scope:
- [ ] `phone_numbers` table (E.164 unique, tenant, **agent link (exactly one agent per number)**, provider, provider id, status), plan limit `phoneNumbers`, platform-admin assignment screens/API, tenant view and re-assignment of its numbers between its own agents (owner and admin)
- [ ] **Twilio webhook on the backend (backend first, decided, L8):** public HTTPS route, provider signature check, number to (tenant, agent), checks (tenant status incl. minutes, agent active), answer to the provider that connects the audio to the engine's voice gateway with a one-minute single-use ticket carrying tenant and agent; spoken, translated message for a number with no agent, a disabled agent, a blocked tenant or no minutes; a fallback address at the provider if the backend is down
- [ ] **Dashboard test call:** a staff-authenticated route that issues a ticket for a chosen agent (the browser test call; needs the gateway's public secure WebSocket). It is the **only** call path for Free and Starter tenants and uses the tenant's minutes
- [ ] Real numbers only on plans with `phoneNumbers` above 0 (Pro, Enterprise); an attempt on Free or Starter answers a translated plan error
- [ ] End customer upserted from the caller's number; privacy rules for phone numbers (F1)
- [ ] Tests incl. unknown number, replayed ticket, another tenant's number, number with no agent, agent disabled
- [ ] Frontend: numbers screen, link a number to an agent, test call

Needs: Twilio account on the backend; Abdullah's confirmation of the routing (L8) and of the Twilio access for transfers; his public secure WebSocket for the voice gateway.
**Done when:** with Twilio test numbers a call to a business's number is routed to the linked agent of that tenant, and the caller exists as an end customer.

## Phase 5E: Call usage, billing and call history
**Goal:** minutes are counted, limited and visible.

Scope:
- [ ] Agree the usage-event shape with Abdullah (his proposal: `usage.call_minutes {conversationId, seconds, channel}` and others) and ingest it idempotently into `usage_daily`
- [ ] Enforce the minutes allowance through the status check and the entitlements; overage and reminders as in 5A
- [ ] Owner usage endpoint (calls, minutes, requests; no token counts) per tenant and per agent, and the billing summary with minutes (minutes stay pooled per tenant)
- [ ] **Minutes visible to every role (frontend gap N51, P1, decided 2026-10-28):** `GET /v1/me` (`subscription`) carries a call-minute summary for ALL roles, including the staff role `agent`: included, used and a state (`ok`, `near_limit`, `over_included` = overage running, `stopped` = hard stop, calls refused), but no prices or money amounts (those stay owner/admin in `GET …/billing`). Reason: a staff member must be able to see why the AI stopped answering or is being billed. Same derivation as `OverageService.callMinuteSummary`; document the new fields in OpenAPI; role-matrix and e2e rows
- [ ] **Minute fields on the invoice (frontend gap N46, decided 2026-10-28):** expand-only migration adds `invoices.overage_minutes` and `invoices.overage_minutes_amount_minor` (both nullable integers) next to the chat pair (`overage_count`, `overage_amount_minor`, kept while chat exists); `record-payment` and `activate` accept optional `overageMinutes` + `overageMinutesAmountMinor` (both or neither, integers, same rules as the chat pair, and a CHECK that both amounts together are at most the invoice total); the invoice view, the billing event payload and the admin subscription summary show them; the admin's billing summary suggests the figures from `usage.callMinutes` (`overageMinutes`, `overageAmountMinor`) but nothing checks what the admin types. Updates OpenAPI descriptions (they say "conversations" only today); the frontend's payment form then drops its warning
- [ ] Call history for staff (through the engine's call logs) with the rules about what is shown (no raw audio; recording consent is Phase 6)
- [ ] Frontend: usage, billing and call-history screens

Needs from AI: the usage-event shape and the call-log read route.
**Done when:** a finished call adds its minutes to the tenant's usage, and running out of minutes stops service with the right message.

## Phase 5F: Agent settings and knowledge
**Goal:** a business teaches and configures each of its agents from the dashboard (settings, checklist, forwarding contacts and knowledge are per agent, L7).

Scope (decisions first, see [phase-5-plan.md](phase-5-plan.md)):
- [ ] **Agent settings screens** (his B2, B3; decided in L7: the backend owns and versions them and the engine receives them at call start): edit name, purpose, tone, language, voice, hours, greeting, forwarding contacts and the "what the agent collects" checklist (drawn from the engine's catalogue and validation, no hard-coded field names) for each agent; the storage and the engine's config route are built in 5B-1
- [ ] **Knowledge** (his B5): the backend keeps the original file in its own storage, enforces plan size and file types, forwards the file to the engine by multipart upload, follows the ingestion job, shows the document list with status and failure codes; real `knowledgeMb` usage
- [ ] Frontend: agent settings, collect checklist and knowledge screens

Needs: Abdul's storage provider decision; Abdullah's ingest routes moved to the header-based tenant.
**Done when:** an owner uploads a document, sees it become ready, and changes the agent's name or hours and the engine uses them.

## Phase 6: Telephony go-live
**Goal:** real phone calls for real customers.

Scope:
- [ ] Twilio production setup: number purchase or porting flow and management screens
- [ ] Public secure WebSocket entry for the voice gateway with ticket-only access, as agreed with Abdullah (D4, Q26)
- [ ] Recording disclosure and consent switches, calling-hours rules (E5, F2); legal wording before real customers
- [ ] Confirmation to the customer when staff confirm a request (his B9): SMS, sender to be decided (L5)
- [ ] Idempotent handling of provider retries (C3)

Needs: Phases 5B to 5E; a Twilio account; legal review of recording and calling rules.
**Done when:** a real phone call to a business's number is answered, produces a request on the staff screen, is confirmed, the customer is told, and the minutes are billed.

## Phase 7: Deferred (nothing started, decided later)
- **Message operations (halted 2026-10-21):** new work on the chat widget, widget key rotation and wording, the staff chat queue (claim, reply, release), chat-conversation limits.
- **WhatsApp** (not planned on either side).
- **Agent productivity:** routing and SLAs, notes, tags, transfer, canned replies (H8).
- **Calendar availability** (his B10): the engine checks opening hours only today.
- **Translation keys (J8)**, the **overage spending cap**, tenant integration secrets and action approvals (revisit if the engine ever executes actions).

## Phase 8: Production hardening and launch
**Goal:** safe to run for real customers.

Scope:
- [ ] Postgres row-level security as a second isolation layer; per-service DB roles (A4)
- [ ] Tenant offboarding and end-customer erasure orchestration across both schemas (§5.6, F1); retention purges
- [ ] Refresh tokens and cookie flow if needed (G2). Login throttling is built (Phase 3C, in process memory); Phase 8 moves its counters, and every other limiter, behind Redis
- [ ] Redis + queues if running more than one instance (D5); backoff and dead-letter handling
- [ ] Observability: metrics, error tracking, alerts; load test of the chat path
- [ ] Security review (OWASP checks, dependency audit, secret rotation procedure)
- [ ] CI/CD, environments (dev/staging/prod), backups and restore test, deployment runbook

**Done when:** a staging environment passes an end-to-end acceptance script, a restore from backup has been rehearsed, and the security review has no open high findings.

**Additions for the voice product (2026-10-21):** security review of the public voice WebSocket and the ticket (replay, expiry, per-number rate limits); monitoring of failed and dropped calls; load test with concurrent calls (the engine allows 3 per tenant today); backups of the requests data; the retention purge scheduled daily (the engine has no scheduler: the backend's job calls his purge route); recording-consent compliance; paid LLM and speech terms with no training on customer data (Q25).

## Phase 9: Payment provider integration
**Goal:** self-serve payments, replacing manual recording. Do this when the first customers want to pay by card and a provider is chosen.

Scope:
- [ ] Choose the provider (depends on where the company and bank account are registered; options and availability must be checked at that time)
- [ ] `XxxProvider implements BillingProvider`: hosted checkout, customer portal, webhook endpoint with raw-body signature verification and event-id idempotency (I4)
- [ ] Map provider events to `BillingEvent`s; no change to the state machine, enforcement or tenant screens
- [ ] Reconcile provider invoices into `invoices`; failed-payment retries and the `past_due` grace period (I3)
- [ ] Per-provider test mode and a replay tool for webhooks; runbook for manual corrections

Depends on: Phase 2B and Phase 8 (production environment).

---

## How we work
1. **Branch per phase** (`phase-0-foundation`, …), small commits, one PR per coherent chunk. Never run `migrate reset` or `db push` on the shared database.
2. **Per task:** implement → tests (including a tenant-isolation test for anything touching tenant data) → `npm run lint` and `npm test` → update docs and the OpenAPI → tick the box above.
3. **Contract first:** anything the other teams consume (API shape, events, schema requests) is written in [team-alignment.md](team-alignment.md) before it is built, and the mock engine keeps us unblocked.
4. **Weekly sync with Abdullah and the frontend** to clear `Status` lines; blocking items are listed at the bottom of team-alignment.
5. **Definition of done for a phase:** exit criteria met, docs updated, demo run on the seeded tenant.

## Next three actions
1. Merge the open branches in order (`docs/voice-first-plan`, then `phase-5a-alignment`) and commit the plan changes of 2026-10-28; send Abdullah the addendum in [for-abdullah.md](for-abdullah.md) (section 8: agents, settings pulled at call start, Twilio routing, usage event, build order) together with the answers to his eight questions (team-alignment M3).
2. Abdul decides what is still open: the storage provider for knowledge originals, who sends the confirmation SMS, the price of numbers beyond a plan's limit. Abdullah confirms the engine side of Q28 and Q29 and settles the Twilio access for transfers.
3. Phase 5B-1 (agents foundation, with the settings document and the config route the engine pulls) is built on branch `phase-5b1-agents`; next is 5B-2 (status check and requests, both agent-aware); the frontend adds the agents list and the settings screen.
