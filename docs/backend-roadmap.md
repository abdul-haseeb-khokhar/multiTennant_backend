# Backend Roadmap (backend core)

Owner: Abdul Haseeb · Status: draft v0.1 (2026-10-07) · Design: [architecture.md](architecture.md) · Open decisions: [team-alignment.md](team-alignment.md) (ids like A2, H1 refer to it)

Size: **S** ≈ days · **M** ≈ 1–2 weeks · **L** ≈ 2+ weeks (rough, solo, includes tests). Re-estimate at the start of each phase.

## Overview

| # | Phase | Size | Needs from others | Unblocks |
|---|---|---|---|---|
| 0 | Foundation and hardening | M | nothing | FE (OpenAPI, stable errors/pagination) |
| 1 | Account and team management | M | nothing (H3 mail provider can follow) | FE (auth, invite, audit, language screens) |
| 2 | Shared infrastructure and engine contract | S–M | AI: A1–A6, D2, schema requests | everything that talks to the engine |
| 3 | Gateway and widget entry | M | AI: B5, D1–D3, engine create/message API | FE widget, first end-to-end chat |
| 4 | Human-agent flow and notifications | L | AI: C1–C4, D5, D6 | FE dashboard conversations |
| 5 | Tenant configuration, knowledge, actions, usage | L | AI: E1–E4 | AI personalisation, plan limits |
| 6 | Channels: WhatsApp and voice | L | AI: D4, E5; provider accounts | phone/WhatsApp customers |
| 7 | Human-agent productivity (deferred) | M | product decision | team efficiency |
| 8 | Production hardening and launch | L | all above | go-live |

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

Implementation status (branch `phase-0-foundation`, not committed): all items are built; `npm test` (127), `npm run test:e2e` (67), `npm run build` and a full `tsc --noEmit` pass locally. Caveats, details in `CLAUDE.md` known issues 6, 8 and 9: the e2e suite uses **mocked Prisma** (the database-backed check is the CI `migrations` job), the new migration is **not applied** anywhere yet, the CI workflow has **not run yet**, and `oxlint` could not run on the build machine (blocked native binary), so lint is unverified locally. The static OpenAPI document is `docs/openapi.json` (served live at `/docs`).

Depends on: nothing. Decisions needed: B1, B2, B3, F5, G1 (all backend-owned; frontend should review G1).
**Done when:** known issues 1–9 in `CLAUDE.md` are closed, CI is green, and the OpenAPI document is published for the frontend.

## Phase 1: Account and team management
**Goal:** a real staff lifecycle, an audit trail and translations.

Scope:
- [ ] Invitations: `staff_invites`, send/list/revoke/accept; remove password from user-create (H1)
- [ ] Password reset, `tenant_user.status`, `password_changed_at` check (H2)
- [ ] `Mailer` interface with a console implementation, `MAIL_MODE=link` for dev (H3); provider integration once chosen
- [ ] Email verification (H4)
- [ ] Audit log: table, `@Audit` decorator/interceptor, query endpoint (H6)
- [ ] i18n: `src/lang/<locale>/<ns>.json`, `GET /v1/i18n/locales` and `/:locale/:namespace`, ETag, `en` fallback, missing-key check script, `nest-cli.json` assets, `locale` columns (H7)
- [ ] `GET /me` (profile, role, tenant, locale)

Depends on: Phase 0. Decision needed: H3 (mail provider).
**Done when:** an owner can invite an agent who sets their own password, reset flows work end to end, role changes appear in the audit log, and the frontend can load `en` and `ur`.

## Phase 2: Shared infrastructure and engine contract
**Goal:** both services run on one database and agree on the contract.

Scope:
- [ ] Agree A1–A6 with Abdullah; `docker-compose.yml` + `infra/init/00-init.sql`; switch `DATABASE_URL` and add `?schema=tenant_core` (A1, A2, A3)
- [ ] **Verify A2** (migration histories stay separate) on a throwaway database before anyone migrates
- [ ] Seed script: demo tenant with a fixed UUID, owner, agent, a few customers (A6)
- [ ] Write the engine internal API as an OpenAPI file in `docs/contracts/` (Appendix A) and the agent-config schema (E1); both sides review
- [ ] Backend `EngineClient`: service token, request id, `Idempotency-Key`, timeouts and retry policy (D2, D7), plus a **mock engine** so backend work never waits for AI
- [ ] README: how to start everything from scratch, migration order

Depends on: AI answers to A1–A6 and D2; the AI side adds `end_customer_id` and the foreign keys (A5, B5).
**Done when:** a fresh clone brings up Postgres, runs both migration sets in order, seeds data, and the backend can call the mock engine and the real one.

## Phase 3: Gateway and widget entry
**Goal:** the first end-to-end conversation: a visitor chats through the widget and gets an AI answer.

Scope:
- [ ] `api_keys` (widget/server), per-key allowed origins, per-tenant CORS for widget routes (D8)
- [ ] `POST /v1/widget/sessions`: validate key and origin, check tenant status/plan, upsert `EndCustomer` per channel rules (B4), create the conversation in the engine, issue a widget token (D3)
- [ ] `POST /v1/widget/messages` and the streamed reply (SSE) relayed from the engine (D1)
- [ ] Fallback and auto-escalation when the engine is down (D7)
- [ ] Rate limiting per key/IP, message length cap (F6)
- [ ] `usage.recorded` handling and `usage_daily` (basis for plan limits, enforced in Phase 5)

Depends on: Phase 2; engine endpoints for create/message; B4, B5, C3.
**Done when:** the frontend widget completes a full chat against the real engine, and a suspended tenant or wrong origin is refused.

## Phase 4: Human-agent flow and notifications
**Goal:** staff see escalated conversations, take over, reply and hand back, with live updates.

Scope:
- [ ] Conversation read endpoints for the dashboard: list/queue/detail, filters by status and assignee (D6: engine API and/or read-only views)
- [ ] Claim, release, resolve, human reply, relayed to the customer channel (C1–C4, C2)
- [ ] `POST /internal/events` receiver (signed) and dashboard SSE stream (D5)
- [ ] In-app notifications: table, creation from events, read/unread API, `notification.created` over SSE, retention purge (H5)
- [ ] Customer view: `GET …/customers/:id/conversations`
- [ ] Role checks on every action; audit entries for claim/release/resolve

Depends on: Phase 3; C1–C4, D5, D6 and the engine's claim/human-message endpoints.
**Done when:** the demo scenario works: AI escalates → agent is notified → claims → replies → customer sees it → agent hands back → AI resumes.

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
