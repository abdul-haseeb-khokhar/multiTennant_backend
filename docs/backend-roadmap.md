# Backend Roadmap (backend core)

Owner: Abdul Haseeb · Status: draft v0.1 (2026-10-07) · Design: [architecture.md](architecture.md) · Open decisions: [team-alignment.md](team-alignment.md) (ids like A2, H1 refer to it)

Size: **S** ≈ days · **M** ≈ 1–2 weeks · **L** ≈ 2+ weeks (rough, solo, includes tests). Re-estimate at the start of each phase.

## Overview

| # | Phase | Size | Needs from others | Unblocks |
|---|---|---|---|---|
| 0 | Foundation and hardening | M | nothing | FE (OpenAPI, stable errors/pagination) |
| 1 | Account and team management | M | nothing (H3 mail provider can follow) | FE (auth, invite, audit, language screens) |
| 2 | Shared infrastructure and engine contract | S–M | AI: A1–A6, D2, schema requests | everything that talks to the engine |
| 2B | Billing foundation (plans, subscriptions, entitlements, manual payments) | M | nothing (can run beside 2); **built**, reminders wait for H5 | Phase 3 enforcement, FE billing screens |
| 3 | Gateway and widget entry (**built**, mock engine only) | M | AI: B5, D1–D3, engine create/message API; Phase 2B | FE widget, first end-to-end chat |
| 3B | Frontend gap-report fixes (confirmed defects, section J of team-alignment) | S | nothing; decisions J1–J8 from Abdul | FE (correct, safe API) |
| 4 | Human-agent flow and notifications | L | AI: C1–C4, D5, D6 | FE dashboard conversations |
| 4C | Mail provider: Resend, test mode (H3, decided) | S | Resend account and API key from Abdul | invites, resets and verification reach a real inbox |
| 4B | Pro overage setting and optional spending cap (J6, decided) | S | nothing; follows Phase 4 | FE billing switch |
| 3C | Account decisions: logout and revocation, owner self-service and slug rename, upgrade request, time zone (J1, J3, J4, J5, J7; J2 and J8 after Abdul answers) | M | nothing | FE (logout, settings, upgrade request) |
| 5 | Tenant configuration, knowledge, actions, usage | L | AI: E1–E4 | AI personalisation, plan limits |
| 6 | Channels: WhatsApp and voice | L | AI: D4, E5; provider accounts | phone/WhatsApp customers |
| 7 | Human-agent productivity (deferred) | M | product decision | team efficiency |
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

Decisions J1–J8 (logout and revocation, slug discovery, owner self-service, role rows, upgrade request, conversation unit, time zone, translation keys) become further items here once Abdul answers.

Implementation status (branch `phase-4-human-agent`, built before Phase 4, **no migration**, committed and pushed, not merged): every box is done and has a test (`test/phase3b.e2e-spec.ts`, unit specs next to the code, one database test for the reactivation). Not handled from the gap report (they need decisions or are bigger): G3 logout (J1), G4 slug discovery (J2), G5 owner self-service (J3), G12 ownership rules, G13/G19 time zone and audit gaps, G17 upgrade request (J5), G21 translation keys (J8), G23.2 / .7 / .8 / .9 / .10 / .12, G24 search and sort on lists, G29.2 / .3 / .5 / .9 / .10.
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

Implementation status (branch `phase-4-human-agent`, committed and pushed in 4fe79f3, no pull request or merge yet): everything above is built and tested against the **mock engine and a contract-faithful fake server only**; no real engine exists, and the engine owner has confirmed none of the new calls or events. Checks: `npm test` 1046, `npm run test:e2e` 413, `npm run test:db` 88 (a throwaway database, run several times), build, `tsc --noUnusedLocals`, Prettier and `oxlint` (0 errors) pass; `npm run handoff:walkthrough` was run against a live server on real Postgres. Migration `20261010100000_phase4_handoff` is additive only (tables `notifications`, `engine_events`, `stream_tickets`, two columns and an index on `gateway_conversations`); it was generated against a throwaway database, read, and applied to the local `multitenant` database after a `pg_dump` of `tenant_core`.

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

Implementation status (branch `phase-4b-4c`, stacked on `phase-4-human-agent`, nothing committed or pushed): built and tested on the mock engine and real Postgres. Migration `20261011092433_phase4b_overage` is expand-only (`subscriptions.overage_enabled boolean not null default true`; `invoices.overage_count` and `overage_amount_minor`, both nullable, with a CHECK that the amount is at most the invoice total); generated against a throwaway database, read, drift-checked.

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

Implementation status (branch `phase-4b-4c`, nothing committed or pushed): built and tested against a **fake Resend HTTP server**; the build session never read or printed `RESEND_API_KEY`, and the test suites now force the console provider. No migration. The Resend API facts (error names, the 403 test-mode refusal, 429 quota errors, the Bearer key, the `Idempotency-Key` header, 100 a day / 3,000 a month on the free plan, 10 requests a second per team) were checked against Resend's official documentation on 2026-10-11 (resend.com/docs/api-reference/errors, …/emails/send-email, …/knowledge-base/resend-sending-limits). One thing the pages do not say: what the free plan does at its cap; the code treats a 429 `daily_quota_exceeded` / `monthly_quota_exceeded` as the signal.

How it works (rule 13 of `CLAUDE.md`):
- **Selection.** `MAIL_PROVIDER=console|resend` picks the `Mailer` in `MailModule`; production refuses `console`, `MAIL_REDIRECT_TO`, a `@resend.dev` sender and `RESEND_API_URL` (a test seam).
- **Sending.** `ResendMailer` posts to `/emails` with the Bearer key, JSON `from`, `to`, `subject`, `html`, `text` and an `Idempotency-Key`; 5 s per attempt, one retry (same key) only after a network error, a timeout or a 5xx. Failures become `MailDeliveryError` with a stable reason code; the provider's own error text is dropped because its test-mode refusal quotes an address.
- **Rendering.** `MailRenderer` + `formatMessage` (a small ICU subset: placeholders and plurals) render `email.<template>.*` and `email.layout.*`; HTML escaped everywhere, no images/scripts/tracking, links must be http(s), Urdu has `lang="ur" dir="rtl"`.
- **Callers.** `MailService.sendNow` never throws: it returns `delivery: sent | failed | skipped`. Used by invite create, signup (`verificationDelivery`) and verification resend; password reset keeps `queue` (background, constant 202). `MAIL_DELIVERY_FAILED` (the old 503 for a failed invite email) is no longer returned; the code stays registered.
- **Health.** `MailHealth` counts consecutive failures per instance; `GET /health/ready` shows `mail` and turns `degraded` after 3 (readiness stays 200).

Decisions the docs did not settle (change them in code if you disagree): signup and the verification resend now wait for the provider (up to about 10 s in the worst case) instead of sending in the background, because they must report `delivery`; a `@resend.dev` sender is refused in production; `MAIL_FROM_NAME` defaults to `SupportDesk AI`, `MAIL_FROM` to `onboarding@resend.dev`; the invite has no separate "resend" route (inviting the same address again replaces the pending invite and sends a new email); the test suites force the console provider because `.env` may hold real settings.

Follow-ups: send the billing reminders by email (templates exist; needs the recipients' addresses and locales, the 100-a-day cap in mind and a dedupe on the notification rows); bounce and complaint webhooks (suppression list); Urdu email texts need a native-speaker check.

## Phase 3C: Account decisions (J1, J3, J4, J5, J7)
**Goal:** build the account-level decisions Abdul took on 2026-10-11 (team-alignment section J).

Scope:
- [ ] J1: `tokens_valid_after` on `tenant_user` and `platform_admins`; `POST /v1/auth/logout` and `POST /v1/admin/auth/logout`; `JwtStrategy` and `PlatformJwtStrategy` reject older tokens; audit `auth.logout`
- [ ] J3 + J7: `GET`/`PATCH /v1/tenants/:tenantId` (owner edits name, defaultLocale, timezone, slug); `tenants.timezone` default `Asia/Karachi`; slug rename rules (availability with suggestions, once per 30 days, old slug accepted for 30 days and reserved for 90, audit `tenant.slug_changed`)
- [ ] J4 rows: approvals list for owner and admin, integration and API-key details hidden from agents, nobody disables, demotes or deletes themselves (consent row stays owner only)
- [ ] J5: `upgrade_requests` table, owner request route, platform-admin list and handle routes, mail to `PLATFORM_ADMIN_NOTIFY_EMAIL`, `PATCH /v1/admin/tenants/:id` no longer accepts `plan` or `status`
- [ ] J2 (workspace discovery) and J8 (translation keys) once Abdul has answered
- [ ] Tests (unit, e2e, DB flows), OpenAPI, translations en and ur for every new code and text, docs

Depends on: nothing. **Done when:** the boxes above are ticked and the frontend can call logout, tenant settings and the upgrade request.

## Phase 5: Tenant configuration, knowledge, actions and usage
**Goal:** tenants configure their AI, load knowledge, approve risky actions, and are held to plan limits.

Scope:
- [ ] `agent_configs` with versioning and the internal read endpoint for the engine (E1)
- [ ] Knowledge: upload to S3/MinIO, `knowledge_sources` status, trigger and track ingestion, delete by source (E2)
- [ ] `tenant_integrations` with encrypted credentials and the internal fetch endpoint (E4)
- [ ] Action approval API (list proposed, approve, reject) and notifications (E4, H5)
- [ ] Plan limits: monthly messages, KB size, seats, enforced at the gateway with `PLAN_LIMIT_REACHED`; usage endpoint (B6)
- [ ] API-key management screens' endpoints (create, rotate, revoke)

Depends on: Phase 4; E1–E4 and the engine's ingest/approve endpoints.
**Done when:** a tenant uploads a document, the AI answers from it, a high-value action waits for approval, and exceeding the plan limit is blocked cleanly.

## Phase 6: Channels: WhatsApp and voice
**Goal:** reach customers by WhatsApp and phone.

Scope:
- [ ] `channel_connections`, provider signature verification, number → tenant mapping (D4)
- [ ] WhatsApp webhooks (inbound, delivery status, outbound replies, session-window rules)
- [ ] Voice: telephony webhooks, call start/end, recording settings and consent switches (E5, F2); media-stream routing as agreed in D4
- [ ] Idempotent handling of provider retries (C3)

Depends on: Phase 4; D4, E5; provider accounts and approved WhatsApp business setup (lead time, start early).
**Done when:** a WhatsApp message and a phone call each produce a conversation visible in the dashboard with correct tenant and customer.

## Phase 7: Human-agent productivity (deferred)
**Goal:** make a team of agents efficient. Do this only after real usage shows the need; owner is backend + frontend (H8).

Scope (pick from):
- [ ] Routing rules (round-robin, least busy, skills) and working hours
- [ ] SLA timers, breach highlighting and alerts through in-app notifications
- [ ] Internal notes, transfer between agents, tags, canned replies (tables in `tenant_core`, plain `conversation_id`)

Depends on: Phase 4; a product decision. AI-assisted extras (suggested replies, auto-tags) belong to the AI engine.

## Phase 8: Production hardening and launch
**Goal:** safe to run for real customers.

Scope:
- [ ] Postgres row-level security as a second isolation layer; per-service DB roles (A4)
- [ ] Tenant offboarding and end-customer erasure orchestration across both schemas (§5.6, F1); retention purges
- [ ] Refresh tokens and cookie flow if needed (G2); login throttling
- [ ] Redis + queues if running more than one instance (D5); backoff and dead-letter handling
- [ ] Observability: metrics, error tracking, alerts; load test of the chat path
- [ ] Security review (OWASP checks, dependency audit, secret rotation procedure)
- [ ] CI/CD, environments (dev/staging/prod), backups and restore test, deployment runbook

**Done when:** a staging environment passes an end-to-end acceptance script, a restore from backup has been rehearsed, and the security review has no open high findings.

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
1. Commit the docs and the `main.ts` CORS change on a branch, then send [team-alignment.md](team-alignment.md) to Abdullah and the frontend colleague.
2. Start Phase 0 in the order listed (security first: `/tenants` lock-down, then roles, then the delete bug).
3. While waiting for answers, run Phase 1 and prepare the throwaway-database check for A2.
