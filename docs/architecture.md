# Architecture: AI Customer-Support Platform

| | |
|---|---|
| Status | Draft v0.1 (2026-10-07). Proposals are marked **Proposed** and are not agreed until the status column in [team-alignment.md](team-alignment.md) says so. |
| Owner | Abdul Haseeb: backend core (`tenant_core`, NestJS) |
| Audience | Abdullah Younas (AI engine), the frontend colleague, anyone joining |
| Companion | [team-alignment.md](team-alignment.md): open decisions, contracts, schema requests |

## 1. What we are building

A multi-tenant platform where **businesses and call centres put an AI agent in front of their customers**. The agent answers questions from the tenant's own knowledge base, can take approved actions (refund, booking, record update), and **hands over to a human agent** when it should. Customers reach it through a web widget, WhatsApp and phone calls. Business staff run it from a dashboard.

## 2. Who owns what

| Area | Owner | Tech | Postgres schema |
|---|---|---|---|
| Identity, tenants, staff users, roles, end customers, API/widget keys, channel connections, tenant AI settings, plans and usage, gateway/public API, dashboard API, realtime fan-out | **Backend core (Abdul Haseeb)** | NestJS 12, Prisma 6 | `tenant_core` |
| Conversations, messages, LLM orchestration, retrieval (RAG), knowledge chunks and embeddings, call logs, agent actions, voice (STT/TTS) | **AI engine (Abdullah)** | Node/Express, Prisma, Gemini, pgvector | `ai_engine` |
| Dashboard UI, chat widget, admin screens | **Frontend** | TBD | none |

**One writer per table.** A service reads another service's data only through the contract in [team-alignment.md](team-alignment.md), never by writing to its tables.

## 3. System overview

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
| `tenants` | id, name, slug (unique), plan (`free`/`pro`/`enterprise`), status (`trial`/`active`/`suspended`), default_locale, created_at | |
| `platform_admins` | id, email (unique), password_hash, created_at | our own staff; created with `npm run platform-admin:create` |
| `tenant_user` | id, tenant_id, email (lower-case, CHECK constraint), name?, password_hash, role (`owner`/`admin`/`agent`), status (`active`/`disabled`), email_verified_at?, password_changed_at?, locale?, created_at | unique (tenant_id, email), FK RESTRICT |
| `end_customers` | id, tenant_id, external_id, name?, locale?, metadata jsonb?, created_at | unique (tenant_id, external_id), FK RESTRICT |
| `staff_invites` | id, tenant_id, email, role, token_hash (unique), expires_at (7 days), invited_by?, accepted_at?, revoked_at?, created_at | invitation flow (H1); `invited_by` has no FK |
| `password_resets` | id, user_id, token_hash (unique), expires_at (1 hour), used_at?, created_at | self-service reset (H2); removed with the user (cascade) |
| `email_verifications` | id, user_id, token_hash (unique), expires_at (24 hours), used_at?, created_at | email verification (H4); removed with the user (cascade) |
| `audit_logs` | id, tenant_id, actor_user_id?, actor_role?, action, target_type?, target_id?, before jsonb?, after jsonb?, ip?, user_agent?, request_id?, created_at | append-only (a trigger refuses UPDATE/DELETE); `actor_user_id` has no FK and holds a `platform_admins` id when `actor_role` is `platform_admin` (H6) |

### 4.2 `tenant_core`: **Proposed** additions
| Table / change | Purpose |
|---|---|
| `tenants.deleted_at`, `updated_at` | Soft delete (`tenants.slug`, `platform_admins`, the staff-lifecycle tables and the locale columns are built, see 4.1) |
| `api_keys` (tenant_id, type `widget`/`server`, key_prefix, key_hash, allowed_origins[], revoked_at) | Resolve a public widget key to a tenant, with per-tenant origin allow-list |
| `channel_connections` (tenant_id, channel, provider, external_account_id, credentials_ref, status) | Map a WhatsApp number or phone number to a tenant for inbound webhooks |
| `agent_configs` (tenant_id, version, config jsonb) | Persona, tone, language, greeting, escalation rules, working hours, allowed actions |
| `tenant_integrations` (tenant_id, kind, credentials_encrypted) | Credentials for the tenant's own systems that agent actions call |
| `knowledge_sources` (tenant_id, name, type, storage_key, status, error, created_at) | Uploaded docs/URLs and their ingestion state (chunks live in `ai_engine`) |
| `usage_daily` (tenant_id, day, messages, tokens_in, tokens_out, call_minutes) | Plan limits and billing |
| `notifications` (tenant_id, user_id, type, title_key, body_key, params, link, read_at) | In-app notifications, stored as translation keys (H5) |

Billing (section I, **built in Phase 2B**): `plans`, `subscriptions`, `invoices`, `invoice_sequences`, `billing_events` (append-only) and `data_use_consents`; `tenants.plan` / `tenants.status` stay as denormalised mirrors of the subscription (only `SubscriptionService` writes them). Starter (hidden, 15 days) falls back to Free; Pro and Enterprise are paid; payments are recorded manually at launch behind a `BillingProvider` interface so a payment provider can be added later without rework. Amounts are integer minor units plus currency (PKR).

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

### 5.2 Customer chat from the widget (**Proposed**)
1. The widget loads with the tenant's public `widgetKey` and a locally stored `visitorId`.
2. `POST /v1/widget/sessions` → backend validates key and `Origin`, checks tenant status and plan, upserts the `EndCustomer` (`externalId = visitorId`), asks the engine to create a conversation, and returns a short-lived **widget token** (`scope: widget`, `tenantId`, `endCustomerId`, `conversationId`).
3. `POST /v1/widget/messages` with the widget token → backend forwards to the engine with the service token. The engine stores the message; if the conversation is `active` it retrieves context, calls the LLM and **streams** the reply back (SSE). The backend relays it to the widget and publishes it to the dashboard.
4. If the engine decides to escalate it sets status `escalated`, stores `escalation_reason` and `summary`, and emits `conversation.escalated`. The backend pushes it to the dashboard queue.

### 5.3 Human takeover (**Proposed**)
1. Agent opens the escalated conversation and clicks **Claim** → backend calls the engine `claim`.
2. The engine performs an **atomic** update (`status IN ('active','escalated') AND assigned_user_id IS NULL`) → `human_active`; a second claimant gets 409.
3. While `human_active` the engine **does not generate AI replies**; it only stores messages. Human replies go backend → engine (`author_type=human`) → relayed to the customer's channel.
4. **Release** returns the conversation to `active` (AI resumes) or marks it `resolved`.

### 5.4 Inbound WhatsApp / voice (**Proposed**)
Provider webhook → backend verifies the provider signature → resolves tenant via `channel_connections.external_account_id` → upserts the `EndCustomer` (`externalId` = E.164 phone number) → forwards to the engine like a widget message. Real-time voice audio may bypass the backend (see D4 in team-alignment).

### 5.5 Knowledge ingestion (**Proposed**)
Dashboard uploads a file → backend stores it in object storage, creates `knowledge_sources` (`pending`) → calls the engine `ingest` → the engine chunks, embeds (Gemini, 768 dims) and writes `knowledge_chunks` with `source_id` → it emits `ingestion.completed` or `ingestion.failed` → backend updates `knowledge_sources.status`. Deleting a source deletes its chunks by `source_id`.

### 5.6 Tenant offboarding / data deletion (**Proposed**)
Default is **soft delete** (`status=suspended`, `deleted_at`). Hard delete is a backend-run procedure: engine `DELETE /internal/tenants/:id/data` first (conversations, messages, chunks, logs, actions), then `tenant_core` rows (customers, users, config, tenant). The FKs are `RESTRICT`, so the order matters. The same pattern serves end-customer erasure requests.

## 6. Backend as built today

| Module | Routes | Auth |
|---|---|---|
| `auth` | `POST /v1/auth/signup`, `POST /v1/auth/login`, `POST /v1/admin/auth/login`, `POST /v1/auth/password-reset/request` and `/confirm`, `POST /v1/auth/verify-email`, `POST /v1/auth/invites/accept` | public |
| `auth` (signed in) | `POST /v1/auth/verify-email/resend` | staff JWT |
| `me` | `GET/PATCH /v1/me` | staff JWT (any role) |
| `invites` | `POST/GET /v1/tenants/:tenantId/invites`, `DELETE …/:id` | JWT + tenant match + owner/admin (create also needs a verified email) |
| `audit` | `GET /v1/tenants/:tenantId/audit-logs` | JWT + tenant match + owner/admin |
| `i18n` | `GET /v1/i18n/locales`, `GET /v1/i18n/:locale/:namespace` | public, cacheable |
| `tenants` | `GET /v1/admin/tenants`, `GET/PATCH/DELETE /v1/admin/tenants/:id` (no create: signup is the only way in) | platform-admin token |
| `tenant-users` | `GET /v1/tenants/:tenantId/users`, `GET/PATCH/DELETE …/:id` (people join by invite, so no create) | JWT + tenant match + role (B2) |
| `end-customers` | CRUD `/v1/tenants/:tenantId/customers` | JWT + tenant match + role (B2) |
| `billing` | `GET /v1/plans` (public), `GET /v1/tenants/:tenantId/billing`, `/v1/admin/tenants/:id/subscription` (+ `activate`, `record-payment`, `extend`, `change-plan`, `cancel`) | public / JWT owner+admin / platform-admin token |
| `data-use` | `GET/PUT /v1/tenants/:tenantId/data-use` (model-training consent, default off) | JWT + tenant match + owner |
| `health` | `GET /health`, `GET /health/ready` (unversioned) | public |

Global `ValidationPipe` (whitelist + transform), `/v1` prefix, error body `{statusCode, code, message}` (plus `details` for validation and `requestId`), list envelope `{data,total,skip,take}`, request-id middleware and JSON logs, CORS limited to `FRONTEND_URL`, OpenAPI at `/docs`, `PrismaModule` is global. On every staff request `JwtStrategy` also loads the user (role, status, verification, `password_changed_at`), so disabling, demoting, deleting or resetting a password takes effect immediately. Emailed links (invite, reset, verification) go through `MailService` and the injectable `Mailer` (console implementation until a provider is chosen, H3). Known defects are listed in `CLAUDE.md`.

## 7. Roadmap (backend)

Full plan with scope checklists, dependencies and exit criteria: [backend-roadmap.md](backend-roadmap.md).

| Phase | Name |
|---|---|
| 0 | Foundation and hardening |
| 1 | Account and team management (invites, reset, audit log, i18n) |
| 2 | Shared infrastructure and engine contract (runs in parallel with 1) |
| 3 | Gateway and widget entry |
| 4 | Human-agent flow and notifications |
| 5 | Tenant configuration, knowledge, actions and usage |
| 6 | Channels: WhatsApp and voice |
| 7 | Human-agent productivity: routing, SLAs, notes, transfer (deferred) |
| 8 | Production hardening and launch |
| 2B | Billing foundation: plans, Starter→Free, entitlements, manual payments (section I) |
| 9 | Payment provider integration |

## 8. Out of scope for now
Chat attachments (text chat only), email as a customer channel, push/email notifications (in-app only), conversation analytics (owned by the AI engine; the backend keeps plan usage metering only), routing rules/SLAs and agent tooling such as notes, tags and canned replies (deferred), card/payment-provider integration (Phase 9; manual billing is in Phase 2B), SSO/SAML, multi-region, mobile apps. See H8 and section I in [team-alignment.md](team-alignment.md).
