# Team Alignment: decisions, contracts and schema requests

Read [architecture.md](architecture.md) first. This file lists every point the two services (and the frontend) must agree on before building further. Each item has a **Proposal**. Fill in **Status** with `Agreed`, `Changed: <what>` or `Question: <what>`, and who answered.

Legend: **BE** = backend core (Abdul Haseeb) · **AI** = AI engine (Abdullah) · **FE** = frontend

---

## A. Infrastructure and database

### A1. One database, two schemas: BE + AI
Today the BE `.env` points to `localhost:5432/multitenant` and the AI compose file creates `caller-ai-agent`, so we are on **different databases**.
**Proposal:** one shared Postgres using the AI compose image (`pgvector/pgvector:pg16`), database `caller-ai-agent`; BE switches its `DATABASE_URL`. Schemas: `tenant_core` (BE) and `ai_engine` (AI).
**Fallback:** two separate databases. This is cleaner for ownership but makes the foreign key in A5 impossible.
Status: ☐

### A2. Keep migration histories apart: BE + AI
Both projects are Prisma. Neither URL has a `?schema=` parameter, so both would (we believe) record migrations in the same `public._prisma_migrations` table, and each would see the other's migrations as drift and may try to reset the database.
**Proposal:** BE uses `…/caller-ai-agent?schema=tenant_core`, AI uses `…?schema=ai_engine`, so each project gets its own history table.
**Verify before anyone migrates** (on a throwaway database):
1. Create an empty DB; run BE `prisma migrate deploy`, then AI `prisma migrate deploy`.
2. Confirm there is one `_prisma_migrations` table in each schema (not one in `public`).
3. Add a migration on each side and run `migrate dev` on both. Neither may ask to reset.

`multiSchema` is, we believe, generally available since Prisma 6.13, and BE already uses `schemas` / `@@schema` without the preview flag. AI keeps its flag if its Prisma version needs it; nothing to change in BE.
Status: ☐

### A3. Extensions, schemas and migration order: BE + AI
**Proposal:** a compose init script owns the one-time setup so no migration needs privileges:
```sql
-- infra/init/00-init.sql  (mounted at /docker-entrypoint-initdb.d/)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS tenant_core;
CREATE SCHEMA IF NOT EXISTS ai_engine;
```
Order rule: **`tenant_core` migrations run before `ai_engine` migrations** (the AI foreign key needs `tenant_core.tenants`). CI and the README spell this out.
Status: ☐

### A4. Database roles: BE + AI
**Proposal:** local dev uses the `postgres` superuser. Production uses a role per service: `be_app` (read/write `tenant_core`, no access to `ai_engine` tables except the read-only views in D6) and `ai_app` (read/write `ai_engine`, `REFERENCES` on `tenant_core.tenants` and `tenant_core.end_customers`, nothing else).
Status: ☐

### A5. Cross-schema foreign key and delete rule: AI owns the migration
**Proposal:** AI adds, in a raw SQL migration (the table exists now):
```sql
ALTER TABLE ai_engine.conversations
  ADD CONSTRAINT conversations_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenant_core.tenants(id) ON DELETE RESTRICT;
-- same for messages, knowledge_chunks, call_logs, agent_actions
ALTER TABLE ai_engine.conversations
  ADD CONSTRAINT conversations_end_customer_fk
  FOREIGN KEY (end_customer_id) REFERENCES tenant_core.end_customers(id) ON DELETE SET NULL;
```
`RESTRICT` (not `CASCADE`) so a stray tenant delete can never wipe conversation history. Removal goes through the offboarding procedure (architecture §5.6).
Status: ☐

### A6. Shared dev environment: BE
**Proposal:** one `docker-compose.yml` plus `infra/init/00-init.sql` in the BE repo (or a small shared infra repo), and a seed script that creates a **demo tenant with a fixed UUID**, one owner, one agent and a few end customers, so both sides test against the same data. Also add Redis later (D5) and MinIO (E2).
Status: ☐

---

## B. Identity and tenancy

### B1. Platform admin and the open `/tenants` routes: BE
`/tenants` currently has no authentication: anyone can list, edit or delete any tenant.
**Proposal:** move to `/v1/admin/tenants`, guarded by a separate **platform-admin** identity (own table `platform_admins`, own login `POST /v1/admin/auth/login`, token claim `scope: "platform"`). Tenants are created only through `POST /auth/signup` (plan and status are not caller-settable).
Status: ☐

### B2. Roles: BE (FE and AI review)
**Proposal:**
| Capability | owner | admin | agent |
|---|---|---|---|
| Delete tenant, change plan/billing | ✓ | | |
| Invite, disable, delete users and change roles (H1); only owners can invite or change owners | ✓ | ✓ (not owners) | |
| View the staff audit log (H6) | ✓ | ✓ | |
| Agent config, knowledge base, integrations, API keys | ✓ | ✓ | read-only |
| See all conversations and customers | ✓ | ✓ | ✓ |
| Claim, reply, release, resolve conversations | ✓ | ✓ | ✓ |
| Approve high-risk AI actions (E4) | ✓ | ✓ | |

Enforced by a `RolesGuard` on the backend; the engine receives the acting `userId` and `role` for audit only.
Status: ☐

### B3. How a staff member identifies their tenant at login: BE + FE
Login currently needs a `tenantId` UUID, which users do not know.
**Proposal:** add `tenants.slug` (unique); login takes `{ tenantSlug, email, password }`. The dashboard can derive the slug from a subdomain (`acme.app.example.com`) or a field.
Status: ☐

### B4. End-customer identity per channel: BE + AI
End customers are `EndCustomer(tenantId, externalId)`; the pair is unique.
**Proposal:**
| Channel | `externalId` | Notes |
|---|---|---|
| widget | `web_<visitorId>` (random UUID kept in the browser) | anonymous; later identification can merge into a known customer |
| WhatsApp | E.164 phone number | phone is personal data (F1) |
| voice | caller number E.164 (or `anon_<callId>` if withheld) | |
| tenant-supplied | the tenant's own customer id | via a server API key |

The backend does the upsert and passes `endCustomerId` to the engine. Merging an anonymous visitor into an identified customer is a later feature; the engine must therefore always reference `end_customer_id`, never copy contact details.
Status: ☐

### B5. Link conversations to end customers: AI (schema), BE (resolver)
`ai_engine.conversations` has no customer reference.
**Proposal:** add `end_customer_id text null` with an index on `(tenant_id, end_customer_id)` (FK in A5). A tenant's agents can then see "all conversations with this customer".
Status: ☐

### B6. Tenant status and plan enforcement: BE
**Proposal:** the backend gateway rejects work for `suspended` or soft-deleted tenants (403) and enforces plan limits (monthly messages, KB size, seats) from `usage_daily`. The engine does not check plans; it trusts the gateway. It does cost-protection itself (F6).
Status: ☐

---

## C. Conversation model (changes in the `ai_engine` schema)

### C1. Status and handoff columns: AI
**Proposal:** `conversations.status` ∈ `active` (AI answers) · `escalated` (waiting for a human) · `human_active` (a human is handling it) · `resolved`. Add:
`assigned_user_id text null`, `escalated_at`, `escalation_reason text null`, `resolved_at`, `resolved_by` (`ai`/`human`/`customer`/`system`), `summary text null` (engine writes a short handoff summary on escalation), `last_message_at`.
Index for the staff queue: `(tenant_id, status, last_message_at desc)`.
Status: ☐

### C2. Who authored a message: AI
`role` stays for the LLM (`user`/`assistant`/`system`/`tool`). Add `author_type` (`customer`/`ai`/`human`/`system`/`tool`) and `author_user_id text null`. A human agent's reply is `role=assistant`, `author_type=human`, `author_user_id=<id>`, so the model and the UI both read it correctly.
Status: ☐

### C3. Idempotency for inbound messages: AI
WhatsApp and telephony providers retry webhooks.
**Proposal:** `messages.external_message_id text null` and `UNIQUE (tenant_id, channel, external_message_id) WHERE external_message_id IS NOT NULL`. The engine returns the existing result on a duplicate. The backend also sends an `Idempotency-Key` header on every command (D7).
Status: ☐

### C4. AI must stay silent while a human is active: AI
**Proposal:** the claim operation is atomic (`UPDATE … WHERE status IN ('active','escalated') AND assigned_user_id IS NULL`, 409 otherwise). Before generating any AI reply the engine re-checks status inside the same transaction, so a message that arrives at the moment of claim cannot produce a late AI answer.
Status: ☐

### C5. Usage fields: AI
Add to assistant messages: `model`, `tokens_in`, `tokens_out`, `latency_ms`. The engine also reports usage events (D5) so the backend can maintain `usage_daily`.
Status: ☐

### C6. Escalation rules: AI decides, BE configures
**Proposal:** the engine decides when to escalate using the tenant's `agent_config.escalation` (customer asks for a human, low confidence, N failed attempts, sentiment, topic keywords, failed action, outside working hours). It stores `escalation_reason` and emits `conversation.escalated`. The backend never second-guesses the decision.
Status: ☐

---

## D. Gateway, authentication and realtime

### D1. Gateway pattern: BE + AI
**Proposal:** browsers, phone providers and WhatsApp only talk to the **backend**. The engine listens on a private interface only. The backend authenticates the caller, derives `tenantId`, then calls the engine. This keeps staff JWTs, widget keys and provider signatures entirely on the backend, and keeps the engine free of auth logic.
Status: ☐

### D2. Service-to-service authentication: BE + AI
**Proposal:** `Authorization: Bearer <INTERNAL_API_TOKEN>` (long random secret, one per environment, rotatable) plus headers `X-Tenant-Id`, `X-Request-Id`, and where relevant `X-Acting-User-Id` / `X-Acting-Role`. **The engine takes `tenantId` only from `X-Tenant-Id`, never from the body, a query string or message content.** The staff JWT is never forwarded and the engine does not verify it. If the engine ever must verify user tokens, we move to asymmetric (RS256/ES256) signing.
Status: ☐

### D3. Widget session token: BE
**Proposal:** short-lived JWT (15 min, refreshable while the page is open), claims `scope=widget`, `tenantId`, `endCustomerId`, `conversationId`. It only permits sending and reading messages in that one conversation.
Status: ☐

### D4. Inbound webhooks and voice media: BE + AI
**Proposal:** all provider webhooks (WhatsApp, telephony) land on the backend, which verifies the provider's signature, maps the destination number to a tenant via `channel_connections`, and forwards to the engine.
**Open:** real-time voice streams audio over WebSocket (e.g. Twilio Media Streams). Routing audio through the backend adds a hop and latency. Options: (a) proxy through the backend, (b) the backend issues a short-lived signed token and the provider connects straight to the engine's media endpoint. AI to advise on latency needs; (b) is likely for voice, (a) for everything else.
Status: ☐

### D5. Realtime and async events: BE + AI
Customer-bound replies are **streamed in the HTTP response** (SSE) from the engine to the backend to the widget. Asynchronous events need a push path.
**Proposal (v1):** the engine calls `POST /internal/events` on the backend with a signed body (HMAC, same token family as D2). Event types: `conversation.created`, `conversation.escalated`, `conversation.resolved`, `message.created`, `action.proposed`, `action.executed`, `call.ended`, `ingestion.completed`, `ingestion.failed`, `usage.recorded`.
The backend fans out to the dashboard over SSE (`GET /v1/tenants/:tenantId/events`). When we run more than one backend instance we add Redis pub/sub (and BullMQ for retries).
Status: ☐

### D6. How the backend reads engine data (dashboard lists, queues): BE + AI
Writes always go through the engine API. For **reads** there are two options:
- **(a) Engine read API** (`GET /internal/conversations?…`): clean ownership, one more thing to build and paginate.
- **(b) Read-only Postgres views** owned by the engine (`ai_engine_api.v_conversations`, `v_messages`) and queried by the backend through a read-only role: fast to build, but the views become a published contract.

**Proposal:** (a) for conversation detail and messages, (b) for list/queue/search queries, with the views versioned and documented in this repo. AI to confirm they accept the views as a contract.
Status: ☐

### D7. Timeouts, retries and fallback: BE + AI
**Proposal:** the backend sends `Idempotency-Key` on commands and allows 5 s to first token, 30 s total; one retry on network error only. If the engine is down or slow the customer gets a configurable fallback message ("A colleague will reply shortly"), and the conversation is marked `escalated` with reason `ai_unavailable`. Engine commands are idempotent by key.
Status: ☐

### D8. CORS and widget origins: BE
CORS today allows one origin (`FRONTEND_URL`), which fits the dashboard but not a widget embedded on customer websites.
**Proposal:** dashboard routes keep `FRONTEND_URL`; widget routes allow the origins listed in the tenant's widget `api_keys.allowed_origins`.
Status: ☐

---

## E. Knowledge base, agent configuration, actions and voice

### E1. Tenant agent configuration: BE owns, AI reads
**Proposal:** table `tenant_core.agent_configs` (versioned JSON: persona, tone, languages, greeting, fallback message, working hours, escalation rules, allowed actions with limits, handoff message). Edited from the dashboard. The engine fetches `GET /internal/tenants/:id/agent-config` (cached ≤ 60 s) and may ask for a specific `version`. A published config schema lives in `docs/contracts/agent-config.schema.json` (to be written jointly).
Status: ☐

### E2. Knowledge ingestion and deletion: BE + AI
**Proposal:** files go to S3-compatible object storage (MinIO locally); `knowledge_sources` is the tenant-visible record with status; the engine chunks/embeds and writes `knowledge_chunks`.
Schema request (AI): `knowledge_chunks.source_id text` (= `knowledge_sources.id`), `chunk_index int`, `embedding_model text`; index `(tenant_id, source_id)`. Deleting a source = `DELETE FROM knowledge_chunks WHERE tenant_id=$1 AND source_id=$2`. The existing `source` text column stays as a human-readable label.
Status: ☐

### E3. Embedding dimension and retrieval correctness: AI
Embeddings are locked to `vector(768)` (Gemini). We record `embedding_model` so a future change can be migrated deliberately.
**Note for pgvector:** an approximate (HNSW/IVF) index combined with `WHERE tenant_id = …` can return **fewer results than requested** because filtering happens after the index scan. Options: pgvector ≥ 0.8 iterative index scans, a partial/partitioned index per large tenant, or an exact scan for small tenants. Every similarity query must still filter by `tenant_id`, with a test proving tenant B never sees tenant A's chunks.
Status: ☐

### E4. Agent actions, integration credentials and approvals: BE + AI
Agent actions (refunds, bookings) touch the tenant's real systems.
**Proposal:**
- Tenant integration credentials are stored by the **backend**, encrypted at rest (AES-256-GCM, key from environment/KMS), in `tenant_integrations`. The engine fetches them per execution through the internal API and **never places them in LLM context or logs**.
- Which actions an agent may take, and limits (e.g. refunds ≤ 50), come from `agent_config.allowedActions`.
- Add to `agent_actions`: `message_id`, `status` (`proposed`/`approved`/`executed`/`failed`/`rejected`), `approved_by_user_id`, `executed_at`. Actions above the tenant's limit stop at `proposed` and need an `owner` or `admin` to approve in the dashboard; `payload` stays structured JSON.
- Treat customer text as untrusted input (prompt injection): the engine must validate action parameters against the policy in code, not trust the model.
Status: ☐

### E5. Voice details: AI (BE for provider connection)
**Proposal:** telephony provider TBD (Twilio is the default assumption). `call_logs` gains `provider_call_id`, `direction`, `from_number`, `to_number`, `status`, `ended_at` and a `conversation_id` that is always set. Recordings are stored in object storage; only the URL stays in the table. A tenant setting controls whether recording is enabled and whether a consent announcement plays.
Status: ☐

---

## F. Compliance, security and operations

### F1. Personal data, retention and erasure: BE + AI
**Proposal:**
- Per-tenant retention (days) in `agent_config`; the engine runs a daily purge of messages, recordings and logs older than that.
- Erasure of one end customer: backend calls the engine `DELETE /internal/customers/:endCustomerId/data` (conversations, messages, call logs, recordings), then removes the `EndCustomer` row.
- Redact obvious sensitive data (card numbers, national ids) before sending text to the LLM and before storing it where practical.
- `end_customers.metadata` and `externalId` may contain personal data; treat them accordingly in logs.
Status: ☐

### F2. Call recording consent: BE + AI
Recording laws differ by country. **Proposal:** recording is off by default, enabled per tenant, and a consent announcement is configurable. The product owner decides the legal wording; engineering provides the switches.
Status: ☐

### F3. Observability: BE + AI
**Proposal:** `X-Request-Id` created at the gateway, propagated to the engine and included in every log line; JSON logs with `tenantId`, `conversationId`, `endCustomerId`; `GET /health` on both services; error tracking later.
Status: ☐

### F4. Secrets and environment variables: BE + AI
| Variable | Used by |
|---|---|
| `DATABASE_URL` (with `?schema=`) | both, different values |
| `INTERNAL_API_TOKEN` | both (same value) |
| `JWT_SECRET`, `JWT_EXPIRES_IN`, `FRONTEND_URL`, `PORT` | BE |
| `GEMINI_API_KEY`, `EMBEDDING_MODEL` | AI |
| `ENGINE_BASE_URL`, `BACKEND_BASE_URL` | BE, AI |
| `INTEGRATIONS_ENCRYPTION_KEY` | BE |
| `S3_*` | BE (uploads), AI (reads) |

Real values are never committed; each repo has a `.env.example` listing names only.
Status: ☐

### F5. API conventions and versioning: BE
**Proposal:** all public routes under `/v1`; OpenAPI published via `@nestjs/swagger` at `/docs`; error body `{ "statusCode", "code", "message" }` where `code` is a stable machine string (`TENANT_SUSPENDED`, `PLAN_LIMIT_REACHED`, …). The engine follows the same error shape.
Status: ☐

### F6. Abuse and cost protection: BE + AI
**Proposal:** rate limits per widget key and per IP at the gateway; maximum message length (2,000 characters) enforced on both sides; per-conversation and per-tenant daily token caps in the engine; widgets can require a lightweight challenge (CAPTCHA/turnstile) on session start if abused.
Status: ☐

### F7. Time and ids: BE + AI
Ids are text UUIDs. Timestamps are stored in UTC (Prisma `DateTime`, `timestamp(3)` without zone on both sides) and exposed as ISO-8601 strings with `Z`.
Status: ☐

---

## G. Frontend contract

### G1. Lists and pagination: BE (change affects FE)
Lists currently return a bare array. **Proposal (changing now is cheap, later it is a breaking change):** `GET` lists return `{ "data": [...], "total": n, "skip": 0, "take": 20 }`, default `take=20`, maximum 100.
Status: ☐

### G2. Dashboard authentication: BE + FE
**Proposal:** staff login returns an access token (current behaviour, `Authorization: Bearer`). Later: 15-minute access token plus refresh token in an `httpOnly` cookie; avoid long-lived tokens in `localStorage`. FE to say which flow it needs.
Status: ☐

### G3. Endpoints the dashboard will use: BE builds, FE reviews
See Appendix B. FE can start from the OpenAPI document and a mock server.
Status: ☐

### G4. Widget delivery: FE + BE
**Proposal:** a single script tag `<script src=".../widget.js" data-widget-key="…">`; replies stream over SSE; the widget keeps `visitorId` in `localStorage` and the widget token in memory.
Status: ☐

---

## H. Staff lifecycle, notifications, audit log and languages (backend)

### H1. Staff invitations: BE (FE builds the screens)
An owner or admin never sets another person's password. They invite by email and role; the invitee sets their own password.
**Proposal:**
- Table `staff_invites` (tenant_id, email, role, token_hash, expires_at (7 days), invited_by, accepted_at, revoked_at). The token is 32 random bytes, stored **hashed**, single use.
- `POST /v1/tenants/:tenantId/invites` `{ email, role }` creates it; `GET` lists pending; `DELETE …/:id` revokes. An admin can invite `admin`/`agent`; only an owner can invite `owner`.
- `POST /v1/auth/invites/accept` `{ token, password, name? }` creates the `tenant_user` and returns a JWT.
- The current `POST /tenants/:tenantId/users` (which takes a password) is replaced by invites; `PATCH` keeps role/status changes only, never another user's password.
Status: ☐

### H2. Password reset and disabled/changed credentials: BE
**Proposal:** `POST /v1/auth/password-reset/request` `{ tenantSlug, email }` always answers 202 (no account enumeration); `POST /v1/auth/password-reset/confirm` `{ token, password }`. Reset tokens: hashed, single use, 1 hour. Throttled per IP and per email.
Add `tenant_user.status` (`active`/`disabled`) and `password_changed_at`; `JwtStrategy.validate` rejects tokens issued before `password_changed_at` and for disabled users. This costs one lookup per request and makes "remove access now" real.
Status: ☐

### H3. Email delivery: BE (**needs a decision from Abdul**)
Invites, resets and verification need to reach a person, even though notifications themselves are in-app only.
**Proposal:** a `Mailer` interface with two implementations: `ConsoleMailer` (logs the link; used in dev) and a real provider (SMTP, SES or Resend) chosen later. Until a provider is chosen, the invite and reset-request responses can also return the link to the owner/admin to pass on manually (flag `MAIL_MODE=link`), and that mode is **disabled in production**.
Open: which provider and sender domain.
Status: ☐

### H4. Email verification: BE
**Proposal:** `tenant_user.email_verified_at`. Signup sends a verification link; an unverified owner can use the trial but cannot invite staff or move to a paid plan. A user who accepts an **emailed** invite is verified at once (they proved access to the address). Lower priority than H1–H2.
Status: ☐

### H5. In-app notifications: BE (FE shows them)
Notifications are shown in the app only (no push, no email).
**Proposal:**
- Table `notifications` (id, tenant_id, user_id, type, title_key, body_key, params jsonb, link, read_at, created_at); one row per recipient (staff teams are small), purged after 90 days. Text is stored as **translation keys plus params** so it renders in each user's language (H7).
- Created by the backend from engine events (D5) and its own events: `conversation.escalated` (all agents), `conversation.assigned` (assignee), `action.proposed` (owners/admins), `ingestion.failed`, `invite.accepted`, `usage.threshold` (80% and 100% of plan limit).
- API: `GET /v1/tenants/:tenantId/notifications?unread=true`, `POST …/:id/read`, `POST …/read-all`; unread count in `GET /me`; live delivery over the existing SSE stream as `notification.created`.
Status: ☐

### H6. Staff audit log: BE
Distinct from `ai_engine.agent_actions`, which records what the AI did.
**Proposal:** append-only `audit_logs` (id, tenant_id, actor_user_id, actor_role, action, target_type, target_id, before jsonb, after jsonb, ip, user_agent, request_id, created_at). Actions include `user.invited`, `user.role_changed`, `user.disabled`, `user.deleted`, `config.updated`, `knowledge.deleted`, `apikey.created`, `apikey.revoked`, `integration.updated`, `action.approved`, `tenant.suspended`. Secrets are never stored in `before`/`after`. The application role has INSERT and SELECT only. Visible to `owner` and `admin` at `GET /v1/tenants/:tenantId/audit-logs?actor=&action=&from=&to=`; retained at least 12 months. Implemented with a `@Audit('user.deleted')` decorator and interceptor.
Status: ☐

### H7. Languages (i18n): BE serves, FE consumes
**Proposal (Abdul's design, with refinements):**
- Files live in `src/lang/<locale>/<namespace>.json`, for example `src/lang/en/common.json` and `src/lang/ur/common.json`. Locale codes are BCP-47 (`en`, `ur`, …). Namespaces: `common`, `errors`, `notifications`, `widget`.
- Each file is key/value. **Keys are stable ids** (`conversation.status.escalated`), not English sentences, so rewording English never breaks other languages. `en` is the source of truth. Placeholders and plurals use ICU syntax (`"{count, plural, one {# new message} other {# new messages}}"`).
- API (public, cacheable, no auth, because the embedded widget needs it): `GET /v1/i18n/locales` → `[{ code, name, dir: "ltr"|"rtl" }]` (Urdu is `rtl`); `GET /v1/i18n/:locale/:namespace` → the JSON, with `ETag` and `Cache-Control`. A missing key falls back to `en`.
- Errors: every API error already carries a stable `code` (F5); the frontend translates it through `errors.<code>`. The backend `message` stays English for logs.
- Which language applies: `tenants.default_locale`, `tenant_user.locale` (dashboard), `end_customers.locale` (nullable), widget uses the browser language falling back to the tenant default. Languages the AI may reply in are `agent_config.languages` (E1). The reply language itself is the AI engine's job.
- Tenant-specific wording (the greeting, fallback message, handoff text) belongs in `agent_config`, **not** in these files.
- A script checks in CI that every locale has all `en` keys (a warning, not a failure). Launch locales: `en`, `ur`.
- Build note: `nest build` only compiles TypeScript, so `src/lang/**/*.json` must be listed under `assets` in `nest-cli.json`.
Status: ☐

### H8. Deliberately deferred or owned elsewhere
| Topic | Decision |
|---|---|
| Attachments (images/files in chat) | Out of scope: text chat only for now |
| Email as a customer channel | Out of scope |
| Conversation analytics (resolution rate, escalation rate, satisfaction) | **AI engine owns** it. The backend keeps only usage metering for plans (`usage_daily`) |
| Routing rules and SLAs | Deferred. **Owner: backend + frontend** (who gets an escalated conversation, queue, timers, alerts all depend on staff data). The AI engine only decides *when* to escalate (C6). For now agents claim from one shared queue and `escalated_at` gives waiting time |
| Agent tooling (internal notes, tags, canned replies, transfer) | Deferred, undecided. **Owner: backend + frontend**; tables would live in `tenant_core` with a plain `conversation_id` column (no FK). Transfer = reassign via the engine's assign/claim API. **AI-assisted extras** (suggested draft replies, auto-tags, sentiment) would be owned by the AI engine, also deferred |
| Billing and payments | Out of scope |
Status: ☐

---

## Appendix A: Proposed engine internal API (called by the backend)

All calls carry `Authorization`, `X-Tenant-Id`, `X-Request-Id` (D2) and, for commands, `Idempotency-Key`.

| Method and path | Purpose |
|---|---|
| `POST /internal/conversations` | `{ channel, endCustomerId }` → conversation |
| `GET /internal/conversations/:id` | detail with messages (paginated) |
| `POST /internal/conversations/:id/messages` | customer message → stored, AI reply **streamed** (SSE) if `active` |
| `POST /internal/conversations/:id/human-messages` | `{ userId, content }` → stored as `author_type=human` |
| `POST /internal/conversations/:id/claim` | `{ userId }` → 200 / 409 |
| `POST /internal/conversations/:id/release` | `{ to: "active" \| "resolved" }` |
| `POST /internal/knowledge/ingest` | `{ sourceId, storageKey, type }` |
| `DELETE /internal/knowledge/:sourceId` | remove chunks |
| `POST /internal/actions/:id/approve` and `/reject` | `{ userId }` |
| `DELETE /internal/customers/:endCustomerId/data` | erasure (F1) |
| `DELETE /internal/tenants/:id/data` | offboarding (§5.6) |
| `GET /health` | liveness |

Engine → backend: `POST /internal/events` (D5), `GET /internal/tenants/:id/agent-config`, `GET /internal/tenants/:id/integrations/:kind` (E4).

## Appendix B: Proposed backend public API for FE (`/v1`)

| Area | Routes |
|---|---|
| Auth | `POST /auth/signup`, `POST /auth/login`, `GET /me` |
| Tenant | `GET/PATCH /tenants/:tenantId` (own tenant), usage: `GET /tenants/:tenantId/usage` |
| Users | CRUD `/tenants/:tenantId/users` |
| Customers | CRUD `/tenants/:tenantId/customers`, `GET …/customers/:id/conversations` |
| Conversations | `GET /tenants/:tenantId/conversations?status=&assignedTo=`, `GET …/:id`, `POST …/:id/claim`, `POST …/:id/messages`, `POST …/:id/release`, `POST …/:id/resolve` |
| Actions | `GET …/actions?status=proposed`, `POST …/actions/:id/approve`, `POST …/actions/:id/reject` |
| Knowledge | `POST …/knowledge` (upload), `GET …/knowledge`, `DELETE …/knowledge/:id` |
| Agent config | `GET/PUT /tenants/:tenantId/agent-config` |
| Integrations | `PUT/DELETE /tenants/:tenantId/integrations/:kind` (write-only secrets) |
| API keys | CRUD `/tenants/:tenantId/api-keys` |
| Realtime | `GET /tenants/:tenantId/events` (SSE) |
| Widget | `POST /widget/sessions`, `POST /widget/messages`, `GET /widget/messages/stream` |
| Platform admin | `/admin/auth/login`, `/admin/tenants…` |
| Invites | `POST/GET /tenants/:tenantId/invites`, `DELETE …/:id`, `POST /auth/invites/accept` (H1) |
| Password reset | `POST /auth/password-reset/request`, `POST /auth/password-reset/confirm` (H2) |
| Notifications | `GET /tenants/:tenantId/notifications`, `POST …/:id/read`, `POST …/read-all` (H5) |
| Audit log | `GET /tenants/:tenantId/audit-logs` (H6) |
| Languages | `GET /i18n/locales`, `GET /i18n/:locale/:namespace` (H7, public) |

## Appendix C: Response checklist (copy into your reply)

```
A1 ☐  A2 ☐  A3 ☐  A4 ☐  A5 ☐  A6 ☐
B1 ☐  B2 ☐  B3 ☐  B4 ☐  B5 ☐  B6 ☐
C1 ☐  C2 ☐  C3 ☐  C4 ☐  C5 ☐  C6 ☐
D1 ☐  D2 ☐  D3 ☐  D4 ☐  D5 ☐  D6 ☐  D7 ☐  D8 ☐
E1 ☐  E2 ☐  E3 ☐  E4 ☐  E5 ☐
F1 ☐  F2 ☐  F3 ☐  F4 ☐  F5 ☐  F6 ☐  F7 ☐
G1 ☐  G2 ☐  G3 ☐  G4 ☐
H1 ☐  H2 ☐  H3 ☐  H4 ☐  H5 ☐  H6 ☐  H7 ☐  H8 ☐
```
Blocking items for the next sprint: **A1, A2, A5, B5, C1, C2, D1, D2**.
