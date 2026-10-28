# Architecture: AI Customer-Support Platform

| | |
|---|---|
| Status | Draft v0.1 (2026-10-07). Proposals are marked **Proposed** and are not agreed until the status column in [team-alignment.md](team-alignment.md) says so. |
| Owner | Abdul Haseeb: backend core (`tenant_core`, NestJS) |
| Audience | Abdullah Younas (AI engine), the frontend colleague, anyone joining |
| Companion | [team-alignment.md](team-alignment.md): open decisions, contracts, schema requests |

## 1. What we are building

A multi-tenant platform where **businesses and call centres put an AI agent in front of their customers**. **Voice-first since 2026-10-21 (team-alignment L1):** the main product is an AI **phone receptionist**. A caller dials the business's number; the agent answers from the business's own material and, when the caller wants an appointment or a call-back, saves a **request** that staff confirm on the dashboard (the AI never books, confirms or cancels anything on its own authority). Plans are measured in **call minutes** (L6). Text chat through the web widget, with a hand-over to a human agent, was built first (Phases 3 and 4) and stays possible, but it is a secondary channel and **message operations are halted** (L2): they keep working and get no new work. WhatsApp is out of scope for now, and tenant integration secrets and risky-action approvals are dropped (L3: the engine executes no actions). Business staff run everything from a dashboard.

## 2. Who owns what

| Area | Owner | Tech | Postgres schema |
|---|---|---|---|
| Identity, tenants, staff users, roles, end customers, API/widget keys, channel connections, tenant AI settings, plans and usage, gateway/public API, dashboard API, realtime fan-out | **Backend core (Abdul Haseeb)** | NestJS 12, Prisma 6 | `tenant_core` |
| Conversations, messages, LLM orchestration, retrieval (RAG), knowledge chunks and embeddings, call logs, agent actions, voice (STT/TTS) | **AI engine (Abdullah)** | Node/Express, Prisma, Gemini, pgvector | `ai_engine` |
| Dashboard UI, chat widget, admin screens | **Frontend** | TBD | none |

**One writer per table.** A service reads another service's data only through the contract in [team-alignment.md](team-alignment.md), never by writing to its tables.

### 2.1 The ownership split for the voice-first product (L4, M; Abdullah's side is not built yet)

| Duty | Backend core | AI engine |
|---|---|---|
| Who is the tenant, may it be served | tenants, plans, subscriptions, the **tenant status check** the engine asks before a call (Phase 5B) | caches the answer about 60 s and refuses or serves the call |
| Which agents a tenant has (L7) | the **`agents` table** (identity, status, default), plan limits on agents and numbers (**built in Phase 5B-1**) | keeps each agent's settings, knowledge and checklist keyed by (tenant, agent) |
| Which agent owns a dialled number | **phone numbers** (each linked to exactly one agent), the telephone provider's signature check and a short-lived call ticket carrying tenant and agent (Phase 5D, Design B, L8) | the voice gateway accepts only a valid ticket |
| The caller as a person | creates the **end customer** from the caller's number | sends the number to the customer upsert |
| What was agreed on the call | the **requests** table, the staff screen (list, confirm, done, cancel), audit, notifications (Phase 5B) | understands the call, validates and saves the request, owns the reference, may change it only while it is `requested` |
| Minutes, limits, billing | `usage_daily.call_minutes`, plan limits, overage, reminders, invoices (built in 5A, fed by the engine in 5E) | reports each finished call's length |
| Transcripts, call logs, voice, LLM, knowledge chunks | read-only views for staff (Phase 5E) | owns them (schema `ai_engine`) |
| Agent settings, knowledge originals | **the backend** stores and versions each agent's settings (`agent_settings`; the engine pulls them from `GET /internal/tenants/{tenantId}/agents/{agentId}/config` at the start of every call, L7; **built in Phase 5B-1**) and keeps the original knowledge files (storage provider undecided) | reads the settings at call start; indexes the knowledge per agent (Phase 5F) |
| Confirmation to the caller when staff confirm | proposed: the backend, by SMS (Phase 6; open) | – |

## 3. System overview

The picture is the chat shape built in Phases 3 and 4. The voice flow (a caller, the telephone provider, the call ticket) is section 5.8; the engine's calls on the backend are the draft [contracts/backend-internal.openapi.yaml](contracts/backend-internal.openapi.yaml).

```
 Customer ──(widget / WhatsApp / phone)──┐
                                         ▼
 Staff dashboard ───────────────►  BACKEND CORE  (public, NestJS)
 (Frontend)       REST + SSE        • auth, tenants, roles, plans
                                    • widget keys → tenantId
                                    • channel webhooks → tenantId
                                    • realtime fan-out to dashboard
                                         │  internal HTTP (service token)
                                         ▼
                                  AI ENGINE  (private network only)
                                    • conversations / messages
                                    • retrieval + LLM + actions
                                         │
                         ┌───────────────┴───────────────┐
                         ▼                               ▼
              Postgres (pgvector)                  Gemini, telephony,
         schema tenant_core | schema ai_engine     tenant systems (CRM, payments…)
```

Principles:
1. **`tenant_id` on every row and in every `where`.** The tenant is always derived from a verified credential (JWT, widget key, provider webhook), never from request content.
2. **Browsers and phone providers talk only to the backend.** The engine is reachable only from the backend (service token, private network).
3. **The engine never decides who a tenant is**; it receives `tenantId` from the backend and applies it.
4. **LLM calls are slow and fail.** Always timeouts, retries, a graceful fallback, and automatic escalation when the AI is unavailable.
5. **Ids are text UUIDs, timestamps are UTC, APIs use ISO-8601.**

## 4. Data model

### 4.1 `tenant_core` (backend). Exists today
| Table | Columns | Notes |
|---|---|---|
| `tenants` | id, name, slug (unique), plan (`free`/`pro`/`enterprise`), status (`trial`/`active`/`suspended`), default_locale, timezone (IANA name, default `Asia/Karachi`, J7), slug_changed_at?, created_at | the owner edits name, language, time zone and slug through `PATCH /v1/tenants/:tenantId` (J3) |
| `tenant_slug_aliases` | id, tenant_id, slug (unique), accepted_until, reserved_until, created_at | slugs a tenant gave up (J3): accepted at login for 30 days, reserved for 90; **built (Phase 3C)** |
| `upgrade_requests` | id, tenant_id, requested_plan_code, note?, requested_by, status (`pending`/`handled`/`declined`), handled_by?, handled_at?, handled_note?, created_at, updated_at | the owner's request for a plan while payments are manual (J5); at most one pending per tenant (partial unique index); `requested_by` and `handled_by` have no FK; **built (Phase 3C)** |
| `platform_admins` | id, email (unique), password_hash, tokens_valid_after?, created_at | our own staff; created with `npm run platform-admin:create` |
| `tenant_user` | id, tenant_id, email (lower-case, CHECK constraint), name?, password_hash, role (`owner`/`admin`/`agent`), status (`active`/`disabled`), email_verified_at?, password_changed_at?, tokens_valid_after? (logout, J1), locale?, created_at | unique (tenant_id, email), FK RESTRICT |
| `end_customers` | id, tenant_id, external_id, name?, locale?, metadata jsonb?, created_at | unique (tenant_id, external_id), FK RESTRICT |
| `staff_invites` | id, tenant_id, email, role, token_hash (unique), expires_at (7 days), invited_by?, accepted_at?, revoked_at?, created_at | invitation flow (H1); `invited_by` has no FK |
| `password_resets` | id, user_id, token_hash (unique), expires_at (1 hour), used_at?, email? (the address the link was sent to), all_workspaces (J2), created_at | self-service reset (H2); removed with the user (cascade) |
| `email_verifications` | id, user_id, token_hash (unique), expires_at (24 hours), used_at?, created_at | email verification (H4); removed with the user (cascade) |
| `audit_logs` | id, tenant_id, actor_user_id?, actor_role?, action, target_type?, target_id?, before jsonb?, after jsonb?, ip?, user_agent?, request_id?, created_at | append-only (a trigger refuses UPDATE/DELETE); `actor_user_id` has no FK and holds a `platform_admins` id when `actor_role` is `platform_admin` (H6) |
| `agents` | id, tenant_id, name (1 to 80, trimmed, unique per tenant ignoring case), status (`active`/`disabled`), is_default (exactly one true per tenant: partial unique index), created_by?, created_at, updated_at | the tenant's own setup the one engine uses for a call (L7); **built (Phase 5B-1)**; FK RESTRICT; `created_by` has no FK |
| `agent_settings` | id, tenant_id, agent_id, version (from 1), document jsonb (the engine's shape; may hold forwarding phone numbers), created_by?, created_at | one row per version, append-only (a trigger refuses UPDATE), unique (agent_id, version), composite FK (tenant_id, agent_id) to `agents` so a row cannot name another tenant's agent, deleted only with its agent (cascade); **built (Phase 5B-1)** |

### 4.2 `tenant_core`: **Proposed** additions
| Table / change | Purpose |
|---|---|
| `tenants.deleted_at`, `updated_at` | Soft delete (`tenants.slug`, `platform_admins`, the staff-lifecycle tables and the locale columns are built, see 4.1) |
| `api_keys` (tenant_id, type `widget`/`server`, name, key_prefix, key_hash, allowed_origins[], last_used_at, revoked_at, created_by) | Resolve a public widget key to a tenant, with per-tenant origin allow-list. **Built (Phase 3)** |
| `gateway_conversations` (tenant_id, conversation_id, end_customer_id, channel, ai_blocked, escalation_reason, escalation_pending, escalation_attempts, escalation_last_attempt_at, closed_at) | What the gateway knows about a conversation it started: resume for a returning visitor, "AI may not answer" (plan limit), an escalation not yet delivered. **Built (Phase 3)** |
| `usage_events` (tenant_id, kind, ref_id, day) | Dedupe ledger so `usage_daily` counts a conversation, a message or (since Phase 5A) a call once; `kind` is `conversation`, `message` or `call`. **Built (Phase 3, 5A)** |
| `channel_connections` (tenant_id, channel, provider, external_account_id, credentials_ref, status) | Map a WhatsApp number or phone number to a tenant for inbound webhooks |
| ~~`agent_configs` (tenant_id, version, config jsonb)~~ | Replaced by `agents` + `agent_settings` (4.1, per agent, Phase 5B-1) |
| `tenant_integrations` (tenant_id, kind, credentials_encrypted) | Credentials for the tenant's own systems that agent actions call |
| `knowledge_sources` (tenant_id, name, type, storage_key, status, error, created_at) | Uploaded docs/URLs and their ingestion state (chunks live in `ai_engine`) |
| `usage_daily` (tenant_id, day, conversations, messages, tokens_in, tokens_out, call_minutes) | Plan limits and billing. **Built (Phase 3)**, written only by `UsageService` |
| `notifications` (id, tenant_id, user_id, type, params jsonb, link, dedupe_key, read_at, created_at) | In-app notifications (H5). **Built (Phase 4)**: one row per recipient; no text is stored, the frontend renders `<type>.title` / `<type>.body` of the `notifications` namespace with `params` (5.7); unique (tenant, user, dedupe_key) makes reminders idempotent; removed with the user; purged after 90 days |
| `engine_events` (id, tenant_id, event_id, type, occurred_at, received_at) | Inbox of the events the engine pushed (D5). **Built (Phase 4)**: unique (tenant, event id) makes delivery idempotent; ids and types only, never message text; purged after 30 days |
| `stream_tickets` (id, tenant_id, user_id, token_hash, expires_at, used_at, created_at) | Single-use 30 second tickets that open the dashboard event stream from a browser `EventSource`. **Built (Phase 4)**; only the hash is stored |

Billing (section I, **built in Phase 2B**): `plans`, `subscriptions`, `invoices`, `invoice_sequences`, `billing_events` (append-only) and `data_use_consents`; `tenants.plan` / `tenants.status` stay as denormalised mirrors of the subscription (only `SubscriptionService` writes them). Starter (hidden, 15 days) falls back to Free; Pro and Enterprise are paid; payments are recorded manually at launch behind a `BillingProvider` interface so a payment provider can be added later without rework. Amounts are integer minor units plus currency (PKR). **Overage (J6, built in Phase 4B):** `subscriptions.overage_enabled` (default true) is the owner's choice on plans that have an overage price (Pro, `overageConversationMinor`); past the included conversations the AI keeps answering and each extra conversation is billed, or, switched off, it stops hard (fallback and `limit_reached` escalation). The overage count is derived, never stored: `max(0, conversations used − included − conversations held for a human)` from `usage_daily` and `gateway_conversations.ai_blocked`; invoices only carry the count and amount the admin recorded (`overage_count`, `overage_amount_minor`).

**Call minutes (L6, built in Phase 5A).** Every plan includes voice and a call-minute allowance: the entitlements `callMinutesPerPeriod`, `callMinutePeriod` (`total` for Starter, `month` otherwise) and, on Pro, the price `overageMinuteMinor` (placeholders: Starter 30 minutes in total, Free 20 a month, Pro 300 a month at PKR 25 an extra minute, Enterprise unlimited). The same owner switch (`overage_enabled`) governs both units: on, calls continue past the included minutes and each extra minute is billed; off, a hard stop (the status check of Phase 5B answers `quota_exceeded`). Minutes are summed from `usage_daily.call_minutes`, written once per call through `usage_events` (kind `call`); the engine's call-usage event is ingested in Phase 5E. The plan numbers and Pro prices can be set from **environment variables** (`PLAN_*`, README "Plan numbers and prices"): at startup `PlanCatalogSyncService` writes the variables that are set into the `plans` table, which stays the one source of truth.

**Agents and their limits (L7, built in Phase 5B-1).** The entitlements `agents` (the tenant's agents, disabled ones included) and `phoneNumbers` (real numbers; 0 = browser test calls only) sit beside the other limits: Starter 1 and 0, Free 1 and 0, Pro 3 and 5, Enterprise unlimited, a missing key means 0; they can be set from `PLAN_*_AGENTS` and `PLAN_*_PHONE_NUMBERS`. Creating an agent takes the subscription row lock and counts inside the transaction (`EntitlementsService.assertCountAvailable`), so two simultaneous creations cannot both take the last slot. The settings of an agent are a versioned JSON document in the engine's own shape; the backend checks only its structure (the engine owns the field list in depth, and `collect` is stored as it is) and the engine reads the current version at the start of every call, so a new version applies to the next call.

Translations are files, not tables: `src/lang/<locale>/<namespace>.json`, served at `/v1/i18n/...` (H7, built).

### 4.3 `ai_engine` (Abdullah). Exists today
`conversations`, `messages`, `knowledge_chunks` (`vector(768)`), `call_logs`, `agent_actions`; `tenant_id` is a plain indexed column, with the foreign key to `tenant_core.tenants(id)` added as raw SQL.

### 4.4 `ai_engine`: **Requested** additions
Details and reasoning are in [team-alignment.md](team-alignment.md) (C and E sections). Summary:

| Table | Add |
|---|---|
| `conversations` | `end_customer_id`, `assigned_user_id`, `escalated_at`, `escalation_reason`, `resolved_at`, `resolved_by`, `summary`, `last_message_at`; status becomes `active` / `escalated` / `human_active` / `resolved` |
| `messages` | `author_type` (`customer`/`ai`/`human`/`system`/`tool`), `author_user_id`, `external_message_id` (idempotency), `model`, `tokens_in`, `tokens_out`, `latency_ms` |
| `knowledge_chunks` | `source_id`, `chunk_index`, `embedding_model` |
| `call_logs` | `provider_call_id`, `direction`, `from_number`, `to_number`, `status`, `ended_at` |
| `agent_actions` | `message_id`, `status` (`proposed`/`approved`/`executed`/`failed`/`rejected`), `approved_by_user_id`, `executed_at` |

## 5. Key flows

### 5.1 Staff sign-up and login (exists)
`POST /v1/auth/signup` creates tenant plus owner in one transaction (the tenant `slug` is the caller's or derived from the name) and returns a JWT. `POST /v1/auth/login` takes `tenantSlug`, email and password and returns a JWT with `sub`, `tenantId`, `role`, `scope: "tenant"`. Tenant-scoped routes are `/v1/tenants/:tenantId/...` and the guard rejects a token whose `tenantId` differs from the URL (403 `TENANT_MISMATCH`) or whose tenant is suspended (403 `TENANT_SUSPENDED`). Platform admins log in at `POST /v1/admin/auth/login` and get a token with `scope: "platform"` for `/v1/admin/...`.

**Phase 3C (built):** *Email-first login (J2).* `POST /v1/auth/login-email {email, password}` checks the password against the memberships of that email (exactly 3 bcrypt comparisons per request, distinct hashes first) and returns the workspaces whose password matched, `unmatchedCount`, and a 10-minute `selectionToken` (`scope: "workspace-select"`, a secret derived from `JWT_SECRET`, user ids only); with exactly one available workspace it also returns the `access_token`. `POST /v1/auth/select-workspace {selectionToken, tenantId}` re-checks the user, the workspace and J1 and returns the normal access token; the same token can open another listed workspace until it expires. `POST /v1/auth/login` (slug) stays. Both are throttled in process memory (60 requests a minute per IP; 5 wrong passwords per email and IP and 30 per IP in 15 minutes; 429 with `Retry-After`). *Logout (J1).* `POST /v1/auth/logout` and `POST /v1/admin/auth/logout` stamp `tokens_valid_after`; every token issued before it (tokens carry `iatMs`, milliseconds) is refused, so a logout ends all sessions of that user and a login right after it works. *Password reset (J2).* `POST /v1/auth/password-reset/request {email}` (slug optional) sends one link; confirming sets one new hash on every membership with that email and ends their sessions. *Workspace address (J3).* `GET /v1/auth/slug-available?slug=` and the owner's rename (`PATCH /v1/tenants/:tenantId`): the old slug stays an alias (login 30 days, reserved 90), at most one rename every 30 days. *Upgrade request (J5).* The owner posts `…/billing/upgrade-request`; a platform admin is emailed (`PLATFORM_ADMIN_NOTIFY_EMAIL`), lists the requests at `/v1/admin/upgrade-requests`, activates the plan through the subscription routes and marks the request handled.

### 5.2 Customer chat from the widget (**Built in Phase 3 against the mock engine; the real engine is not connected yet; HALTED since 2026-10-21 (L2): works, no new work**)
1. The widget loads with the tenant's public `widgetKey` and a locally stored `visitorId`.
2. `POST /v1/widget/sessions` → backend validates key and `Origin`, checks tenant status and plan, upserts the `EndCustomer` (`externalId = web_<visitorId>`), asks the engine to create a conversation (or resumes the visitor's open one), and returns a short-lived **widget token** (`scope: widget`, `tenantId`, `endCustomerId`, `conversationId`, plus the `keyId`, re-checked on every call). A blocked tenant, a plan without chat or an engine that is down answers `status: "blocked"` with a fallback text instead of a token.
3. `POST /v1/widget/messages` with the widget token → backend forwards to the engine with the service token. The engine stores the message; if the conversation is `active` it retrieves context, calls the LLM and **streams** the reply back (SSE). The backend relays it to the widget as `text/event-stream` (what happens later in the conversation, a staff reply for example, reaches the widget through `GET /v1/widget/events`, 5.3). Over the plan limit the message is stored without an AI reply and escalated; if the engine is down or slow the customer gets a fallback and the conversation is escalated (`ai_unavailable`). Details: `docs/contracts/README.md`.
4. If the engine decides to escalate it sets status `escalated`, stores `escalation_reason` and `summary`, and emits `conversation.escalated`. The backend turns that event into notifications for the team and a live event for the dashboard queue (5.3). An escalation the gateway itself could not hand to the engine is retried by `EscalationRetryService` (10 attempts with a growing wait, then the flag stays).

### 5.3 Human takeover (**Built in Phase 4 against the mock engine; the engine calls and events are proposals the engine owner has not confirmed; the staff chat queue is HALTED since 2026-10-21 (L2): works, no new work. On a phone call "a human" means the escalation contact in the agent settings, not this queue (L5)**)
The conversations live in the engine; the backend reaches them only through `EngineClient` and adds the customer, the staff names, the role rules and the audit trail.
1. The engine escalates (`conversation.escalated` event, or the backend tells it to: plan limit, engine failure). `POST /internal/events` (HMAC-signed, outside `/v1`) hands the event to `EngineEventsService`, which in ONE transaction records the event id (idempotent), creates a notification for every active staff member, and after the commit sends `conversation.escalated` + `notification.created` to the dashboard stream and `status: escalated` to the customer's widget stream.
2. The agent sees the queue (`GET …/conversations?status=escalated&sort=escalatedAt`, counts for the badge) and clicks **Claim** (`POST …/:id/claim`). The engine does an **atomic** update (`status IN ('active','escalated') AND assigned_user_id IS NULL`) → `human_active`; the loser of a race gets 409 `CONVERSATION_ALREADY_CLAIMED`. The engine writes the system line `agent.joined` and emits `conversation.assigned`.
3. While `human_active` the engine **does not generate AI replies** (C4); it only stores messages. **Only the assignee may reply, release or resolve**, whatever their role (J4: no transfer yet, so an owner or admin cannot reply into a colleague's conversation): 409 `CONVERSATION_NOT_ASSIGNED_TO_YOU`. A reply (`POST …/:id/messages`, 2,000 characters) goes backend → engine (`author_type=human`) → `message.created` event → the customer's widget stream (`message` event with the text and no staff identity). `GET /v1/widget/conversation` keeps working as the polling fallback.
4. **Release** (`to: active`, the AI answers again; `to: escalated`, back in the queue) or **resolve** (closes it; the customer's next message starts a new conversation) writes `agent.left` / `resolved.notice`, emits `conversation.released` / `conversation.resolved` and tells the widget the new status. Claim, release and resolve are audited; message text never is.
5. A user who is disabled or deleted can no longer release their chats: `ConversationsService.releaseHeldBy` sends them back to the queue (`force` release, audited, best effort).
Live delivery is in the memory of one process (`RealtimeHub`): several instances need Redis (Phase 8). Dashboard stream: `GET /v1/tenants/:tenantId/events` with a Bearer header (a server-side proxy) or a single-use `?ticket=` for direct browser use; events carry ids only, the UI refetches. Customer stream: `GET /v1/widget/events` with the widget token (read it with `fetch`, not `EventSource`).

### 5.4 Inbound WhatsApp (**Deferred**; voice is 5.8)
WhatsApp is out of scope for now (decided 2026-10-21, not planned on the engine side either). The design stays as proposed: provider webhook → backend verifies the signature → resolves the tenant via `channel_connections.external_account_id` → upserts the `EndCustomer` → forwards to the engine like a widget message.

### 5.5 Knowledge ingestion (**Proposed**)
Dashboard uploads a file → backend stores it in object storage, creates `knowledge_sources` (`pending`) → calls the engine `ingest` → the engine chunks, embeds (Gemini, 768 dims) and writes `knowledge_chunks` with `source_id` → it emits `ingestion.completed` or `ingestion.failed` → backend updates `knowledge_sources.status`. Deleting a source deletes its chunks by `source_id`.

### 5.6 Tenant offboarding / data deletion (**Proposed**)
Default is **soft delete** (`status=suspended`, `deleted_at`). Hard delete is a backend-run procedure: engine `DELETE /internal/tenants/:id/data` first (conversations, messages, chunks, logs, actions), then `tenant_core` rows (customers, users, config, tenant). The FKs are `RESTRICT`, so the order matters. The same pattern serves end-customer erasure requests.

### 5.7 Notifications (**Built in Phase 4**)
Rows in `notifications` hold no text. The frontend renders `<type>.title` and `<type>.body` of the `notifications` namespace (`GET /v1/i18n/:locale/notifications`, ICU messages) with the row's `params`, in the reader's language, and opens `link` (an app-relative path). Reading, marking read and counting are always scoped to the tenant AND the caller (`GET/POST /v1/tenants/:tenantId/notifications…`, `unreadNotifications` in `GET /v1/me`); `notification.created` arrives live on the dashboard stream of that user only. Types, recipients and params (the source is `src/notifications/notification-types.ts`; a unit test checks that every type has en and ur texts using only the params below):

| Type | Who | Params |
|---|---|---|
| `conversation.escalated` | every active staff member | `conversationId`, `customer` (name, or a short label such as `web_ab12cd…`), `channel`, `reason` |
| `conversation.assigned` | the assignee, when somebody else assigned it (a plain claim sends nothing) | `conversationId`, `customer`, `channel` |
| `action.proposed` | active owners and admins. **Unused since 2026-10-21** (L3), kept so an engine that still sends it is handled | `actionId`, `action`, `conversationId?`, `customer?` |
| `billing.trial_ending` | owners and admins, at 7, 3 and 1 days left | `daysLeft`, `endsAt`, `threshold` |
| `billing.period_ending` | owners and admins, at 7, 3 and 1 days left | `daysLeft`, `endsAt`, `plan`, `cancelAtPeriodEnd`, `threshold` |
| `billing.grace_started` | owners and admins, once per overdue period | `plan`, `graceEndsAt`, `graceDaysLeft` |
| `billing.downgraded` | owners and admins, once per downgrade | `fromPlan`, `toPlan`, `reason` |
| `usage.threshold` | owners and admins, 80% of the conversations once per period | `metric`, `percent`, `used`, `limit`, `period` |
| `usage.limit_reached` | owners and admins, 100% once per period, when the AI stops (no overage price, or overage switched off) | `metric`, `percent`, `used`, `limit`, `period` |
| `usage.overage_started` | owners and admins, 100% once per period, when the plan has an overage price and overage is on (the AI keeps answering; extras are billed) | `metric`, `percent`, `used`, `limit`, `period`, `priceMinor`, `price`, `currency` |
| `usage.minutes_threshold` | owners and admins, 80% of the call minutes once per period (Phase 5A) | `metric` (`callMinutes`), `percent`, `used`, `limit`, `period` |
| `usage.minutes_overage_started` | owners and admins, 100% of the call minutes once per period, when the plan has a price per extra minute and overage is on (calls are still answered; extras are billed) | `metric`, `percent`, `used`, `limit`, `period`, `priceMinor`, `price`, `currency` |
| `usage.minutes_limit_reached` | owners and admins, 100% of the call minutes once per period, when calls stop being answered (no minute price, overage off, or a payment overdue) | `metric`, `percent`, `used`, `limit`, `period` |

Event-driven rows are created in the event's transaction. Billing reminders are created by the hourly billing job (`BillingRemindersService`), idempotent through the `dedupe_key` (kind, threshold and period), so any number of sweeps or instances create each reminder once. Retention: 90 days (housekeeping in the same job). Data-deletion notices (I10) are Phase 8.

### 5.8 A phone call (voice-first; **Proposed, not built**: Phases 5B-2 to 5E and 6; the settings pull is built, 5B-1)

```
 Caller ──dials the business's number──► Telephone provider (Twilio)
                                              │ webhook
                                              ▼
 BACKEND  verifies the provider's signature → number → (tenant, agent) (phone_numbers.agent_id) → end customer from the caller's number
          → tenant and agent checks (plan, suspended?, minutes left?, agent active?) → signs a ONE-MINUTE SINGLE-USE call ticket
            (tenant + agent)
                                              │ the provider connects the call to the engine's public secure WebSocket with the ticket
                                              ▼
 ENGINE   voice gateway accepts the ticket only → PULLS the agent's settings from the backend (versioned, cached) → speech → model → speech; answers from the agent's knowledge
          → saves a REQUEST (appointment / call-back) with a reference  ──► backend: POST …/requests, event record.submitted
          → reports the call length  ──► backend: event usage.call_minutes
                                              │
 STAFF    dashboard (backend API): sees the request, confirms / completes / cancels it (the engine may change it only
          while it is "requested", otherwise 409 locked); the customer is told by SMS (Phase 6, sender open)
```

1. **Before the call is served** the engine asks `GET /internal/tenants/{tenantId}/status` (cached about 60 s): `serviceable`, `reason` (`suspended`, `unpaid`, `quota_exceeded`, `unknown_tenant`), `plan`. The backend derives it from the effective subscription and the entitlements (`voice`, `callMinutes`). With overage on, a tenant past its included minutes is still serviceable and each extra minute is billed; with it off the answer is `quota_exceeded`. Because of the cache, a limit can be overshot by calls that start inside the window (soft limit).
2. **After the call** the length arrives as `usage.call_minutes`; the backend counts it once per call into `usage_daily.call_minutes` (Phase 5E) and the 80% and 100% reminders follow (`usage.minutes_*`, built).
3. **Privacy:** the caller's number is personal data of a third party (F1): shown to staff, never logged, never in a URL; recording needs consent and calling-hours rules before real customers (Phase 6, F2).
4. **Agents (L7).** A tenant has many agents and many numbers; each number belongs to exactly one agent, an agent can have many numbers; minutes are pooled per tenant; every request, call log and event carries the agent. The backend owns each agent's settings and the engine **pulls** them at the start of every call (the ticket carries only tenant id, agent id and settings version); knowledge stays in the engine, per agent. **Free and Starter tenants have no real numbers: they test an agent with browser test calls, which use their minutes; Pro and Enterprise get numbers.** A number with no agent, a disabled agent, a blocked tenant or no minutes left plays a short translated message and bills nothing. Open: Twilio access for call transfers (L8).
5. **Until the real engine exists** the mock engine plays a call (`/call`, `/call-update`; docs/contracts/README.md) and the backend acknowledges the engine's `record.*` and `usage.call_minutes` events without acting on them.

The routes in this flow are drafted in [contracts/backend-internal.openapi.yaml](contracts/backend-internal.openapi.yaml); none exists yet, and Abdullah has not seen the draft.

## 6. Backend as built today

| Module | Routes | Auth |
|---|---|---|
| `auth` | `POST /v1/auth/signup`, `POST /v1/auth/login`, `POST /v1/auth/login-email`, `POST /v1/auth/select-workspace`, `GET /v1/auth/slug-available?slug=` (rate limited), `POST /v1/admin/auth/login`, `POST /v1/auth/password-reset/request` (`{email}`, slug optional) and `/confirm`, `POST /v1/auth/verify-email`, `GET /v1/auth/invites/preview?token=` (rate limited), `POST /v1/auth/invites/accept` | public |
| `auth` (signed in) | `POST /v1/auth/verify-email/resend`, `POST /v1/auth/logout` (J1; works while the workspace is suspended), `POST /v1/admin/auth/logout` (platform token) | staff JWT / platform token |
| `tenants` (own workspace) | `GET /v1/tenants/:tenantId` (all roles), `PATCH /v1/tenants/:tenantId` (owner: name, defaultLocale, timezone, slug; J3, J7) | JWT + tenant match |
| `me` | `GET/PATCH /v1/me` | staff JWT (any role) |
| `invites` | `POST/GET /v1/tenants/:tenantId/invites`, `DELETE …/:id` | JWT + tenant match + owner/admin (create also needs a verified email) |
| `audit` | `GET /v1/tenants/:tenantId/audit-logs` | JWT + tenant match + owner/admin |
| `i18n` | `GET /v1/i18n/locales`, `GET /v1/i18n/:locale/:namespace` | public, cacheable |
| `tenants` (platform) | `GET /v1/admin/tenants`, `GET/PATCH/DELETE /v1/admin/tenants/:id` (no create: signup is the only way in; PATCH takes name and defaultLocale, `plan`/`status` answer 400 `USE_SUBSCRIPTION_ROUTES`) | platform-admin token |
| `tenant-users` | `GET /v1/tenants/:tenantId/users`, `GET/PATCH/DELETE …/:id` (people join by invite, so no create) | JWT + tenant match + role (B2) |
| `end-customers` | CRUD `/v1/tenants/:tenantId/customers` | JWT + tenant match + role (B2) |
| `billing` | `GET /v1/plans` (public), `GET /v1/tenants/:tenantId/billing` (plan, usage with `usage.callMinutes` and `usage.conversations`, overage figures, invoices), `PATCH /v1/tenants/:tenantId/billing/settings` (`{overageEnabled}`, owner only), `/v1/admin/tenants/:id/subscription` (+ `activate`, `record-payment` with optional `overageCount`/`overageAmountMinor`, `extend`, `change-plan`, `cancel`, and since Phase 3C `suspend` / `unsuspend`), `POST/GET /v1/tenants/:tenantId/billing/upgrade-request` (owner asks, owner and admin read), `GET /v1/admin/upgrade-requests` and `POST /v1/admin/upgrade-requests/:id/handle` | public / JWT owner+admin (settings and the request: owner) / platform-admin token |
| `data-use` | `GET/PUT /v1/tenants/:tenantId/data-use` (model-training consent, default off) | JWT + tenant match + owner |
| `api-keys` | `POST/GET /v1/tenants/:tenantId/api-keys`, `GET/PATCH/DELETE …/:id` (Phase 3) | JWT + tenant match + owner/admin |
| `agents` | `GET /v1/tenants/:tenantId/agents` (+ `/:agentId`; every role: name, status, default flag), `POST` and `PATCH/DELETE …/:agentId` (owner/admin; the default agent cannot be deleted, an agent with numbers cannot be disabled or deleted), `GET/PUT …/:agentId/settings` and `GET …/settings/versions`, `…/versions/:n` (owner/admin; the settings can hold forwarding phone numbers) (Phase 5B-1) | JWT + tenant match + role |
| `agents` (engine) | `GET /internal/tenants/{tenantId}/agents/{agentId}/config` (**outside `/v1`**, not in the public OpenAPI; `?version=`, ETag/304, `Cache-Control: private, max-age=60`; Phase 5B-1) | `Authorization: Bearer <INTERNAL_API_TOKEN>`, private network only |
| `widget` | `POST /v1/widget/sessions` (public: widget key + Origin), `POST /v1/widget/messages` (SSE), `GET /v1/widget/conversation`, `GET /v1/widget/events` (SSE, Phase 4) | widget token (a staff or platform token is refused) + key + Origin |
| `conversations` | `GET /v1/tenants/:tenantId/conversations` (+ `/counts`, `/:id`), `POST …/:id/claim`, `/release`, `/resolve`, `/messages`; `GET …/customers/:id/conversations` (Phase 4) | JWT + tenant match; every role reads and works; reply/release/resolve only for the assignee |
| `notifications` | `GET /v1/tenants/:tenantId/notifications` (`?unread=true`), `POST …/:id/read`, `POST …/read-all` (Phase 4) | JWT + tenant match; every role, own rows only |
| `realtime` | `GET /v1/tenants/:tenantId/events` (SSE), `POST …/events/ticket` (Phase 4) | JWT (Bearer header) or a single-use ticket; every role |
| `events` | `POST /internal/events` (**outside `/v1`**, not in the public OpenAPI; Phase 4) | HMAC signature with `INTERNAL_API_TOKEN`, private network only |
| `health` | `GET /health`, `GET /health/ready` (unversioned; ready also reports the mail provider: `mail.status` `ok`, `degraded` after 3 failed deliveries in a row, or `not_configured` for the console mailer; a warning only, readiness stays 200) | public |

Global `ValidationPipe` (whitelist + transform), `/v1` prefix, error body `{statusCode, code, message}` (plus `details` for validation and `requestId`), list envelope `{data,total,skip,take}`, request-id middleware and JSON logs, CORS limited to `FRONTEND_URL` for dashboard routes (it exposes `X-Request-Id` and `Retry-After`; 429 bodies also carry `retryAfterSeconds`) and to the origins of the widget key for `/v1/widget/*`, OpenAPI at `/docs`, `PrismaModule` is global. On every staff request `JwtStrategy` also loads the user (role, status, verification, `password_changed_at`), so disabling, demoting, deleting or resetting a password takes effect immediately. Emailed links (invite, reset, verification) go through `MailService` and the injectable `Mailer`, chosen by `MAIL_PROVIDER`: `ConsoleMailer` (logs, development) or `ResendMailer` (H3, Phase 4C: HTTPS to Resend, `MailRenderer` renders HTML and plain text from the `email.*` keys in the recipient's language, right-to-left for Urdu). A failed send never breaks the request; the answers of invite create, signup and verification resend carry `delivery: sent | failed | skipped`, the password-reset request stays a constant 202. Known defects are listed in `CLAUDE.md`.

## 7. Roadmap (backend)

Full plan with scope checklists, dependencies and exit criteria: [backend-roadmap.md](backend-roadmap.md).

| Phase | Name |
|---|---|
| 0 | Foundation and hardening |
| 1 | Account and team management (invites, reset, audit log, i18n) |
| 2 | Shared infrastructure and engine contract (runs in parallel with 1) |
| 3 | Gateway and widget entry (built; halted by L2) |
| 4 | Human-agent flow and notifications (built; the staff chat queue is halted by L2) |
| 5 | Replaced on 2026-10-21 by the voice-first phases 5A to 5F below (the old "tenant configuration, knowledge, actions and usage" block lost its actions and integration secrets, L3) |
| 6 | Telephony go-live: numbers, recording consent, SMS confirmation (WhatsApp deferred) |
| 7 | Deferred: chat and widget work, WhatsApp, agent productivity (routing, SLAs, notes, transfer), calendar availability, spending cap |
| 8 | Production hardening and launch |
| 2B | Billing foundation: plans, Starter→Free, entitlements, manual payments (section I) |
| 3C | Account decisions: logout, email-first login, owner self-service and slug rename, upgrade request, time zone (J1 to J5, J7) |
| 5A | Voice-first alignment: call minutes in the plans, minute overage, plan numbers from environment variables, contracts, mock phone call (**built**, branch `phase-5a-alignment`) |
| 5B | Tenant status check and the requests workflow |
| 5C | Real-engine integration, first slice |
| 5D | Phone numbers and call tickets |
| 5E | Call usage, billing and call history |
| 5F | Agent settings and knowledge |
| 9 | Payment provider integration |

## 8. Out of scope for now
Chat attachments (text chat only), email as a customer channel, push notifications and emailed billing reminders (in-app only; the billing email templates exist but are not sent), conversation analytics (owned by the AI engine; the backend keeps plan usage metering only), routing rules/SLAs and agent tooling such as notes, tags and canned replies (deferred), card/payment-provider integration (Phase 9; manual billing is in Phase 2B), SSO/SAML, multi-region, mobile apps. See H8 and section I in [team-alignment.md](team-alignment.md).
