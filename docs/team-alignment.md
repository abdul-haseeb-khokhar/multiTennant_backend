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
**Built (Phase 0):** as proposed. `/v1/admin/tenants` has list, get, patch (name, plan, status) and delete; there is no create route. Platform admins are created from a shell with `npm run platform-admin:create`.
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
**Built (Phase 0), for the rows that exist today:** owner and admin create, change and delete users (an admin cannot touch an owner or promote anyone to owner; a tenant keeps at least one owner, else 409 `LAST_OWNER`). All roles read users, and read, create and edit customers; only owner and admin delete customers. Errors: `INSUFFICIENT_ROLE`, `OWNER_REQUIRED`. Other rows arrive with their features.
**Built (Phase 1):** users are no longer created by owner/admin but invited (H1): admin may invite `admin`/`agent`, only an owner may invite or revoke an invite for an `owner`. "Change" now means email, role or **status** (`active`/`disabled`); an admin still cannot touch an owner. The tenant keeps at least one **active** owner (demoting, disabling or deleting the last one gives 409 `LAST_OWNER`; the check runs in a serializable transaction). Owners and admins read the audit log (H6). A password can only be set by its owner (invite, reset).
Status: ☐

### B3. How a staff member identifies their tenant at login: BE + FE
Login currently needs a `tenantId` UUID, which users do not know.
**Proposal:** add `tenants.slug` (unique); login takes `{ tenantSlug, email, password }`. The dashboard can derive the slug from a subdomain (`acme.app.example.com`) or a field.
**Built (Phase 0):** `POST /v1/auth/signup` accepts an optional `tenantSlug` (3-40 chars, `a-z 0-9 -`); when omitted it is derived from the tenant name. Taken or reserved slugs give 409 `SLUG_TAKEN`. Login takes `{ tenantSlug, email, password }`; the tenant UUID is no longer accepted.
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
**Built (Phase 0), suspended only:** the staff guard answers 403 `TENANT_SUSPENDED` for a suspended tenant, and so does login. Soft delete and plan limits come later (Phase 3 and 5).
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
**Built (Phase 0):** `X-Request-Id` accepted or generated and echoed on every response and error body; one JSON access-log line per request with `requestId`, `tenantId`, `userId`, path (no query string), status and duration; `GET /health` (liveness) and `GET /health/ready` (database). `conversationId` and `endCustomerId` fields arrive with the gateway.
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
**Built (Phase 0):** body is `{ statusCode, code, message }`, plus `details` (list of strings) for validation errors and `requestId`. `/health` and `/health/ready` are the only unversioned routes. OpenAPI: `/docs` (UI), `/docs-json`, and a static copy in `docs/openapi.json`. The current codes are in `src/common/errors/error-codes.ts`; the frontend should map each to `errors.<code>`.
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
**Built (Phase 0):** as proposed, for users, customers and admin tenants. `take` above 100, or a negative `skip`, returns 400 `VALIDATION_ERROR` instead of being clamped. Lists are ordered by `createdAt`, then `id`, so paging is stable. **FE: please review this one.**
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
**Built (Phase 1):** as proposed, with these details. `POST /v1/tenants/:tenantId/invites` `{ email, role? }` (role defaults to `agent`), `GET` (pending only, paged), `DELETE …/:id` (revoke; only an owner may revoke an owner invite). Inviting an address that already has a pending invite replaces it (the old link stops working, so this is also "resend"); inviting an existing user gives 409 `EMAIL_TAKEN`. `POST /v1/auth/invites/accept` `{ token, password (8-72 chars), name? }` returns `{ access_token, user }`; bad, used, revoked or expired tokens give 400 `INVITE_INVALID`. The emailed link points at the frontend page `{FRONTEND_URL}/accept-invite?token=…` (**FE: please build that page; it posts the token back**). `POST /tenants/:tenantId/users` is **removed**; `PATCH …/users/:id` takes `{ email?, role?, status? }` only (a new address must be verified again). `staff_invites.invited_by` is a plain column (no foreign key) so deleting the inviter is not blocked.
Status: ☐

### H2. Password reset and disabled/changed credentials: BE
**Proposal:** `POST /v1/auth/password-reset/request` `{ tenantSlug, email }` always answers 202 (no account enumeration); `POST /v1/auth/password-reset/confirm` `{ token, password }`. Reset tokens: hashed, single use, 1 hour. Throttled per IP and per email.
Add `tenant_user.status` (`active`/`disabled`) and `password_changed_at`; `JwtStrategy.validate` rejects tokens issued before `password_changed_at` and for disabled users. This costs one lookup per request and makes "remove access now" real.
**Built (Phase 1):** `POST /v1/auth/password-reset/request` answers 202 whether or not the account exists (with `MAIL_MODE=link` the body carries `link` for a real account only, a development convenience); throttled at 10 requests per IP per hour (429 `TOO_MANY_REQUESTS`) and 3 per tenant+email per hour (further ones are silently ignored). Counters are in process memory, so they are per instance until Phase 8. `POST …/confirm` `{ token, password }` answers 204; a bad token gives 400 `RESET_TOKEN_INVALID`; it sets `password_changed_at`. `JwtStrategy.validate` now loads the user on every request: a deleted user gives 401, a disabled user 401 `ACCOUNT_DISABLED` (login gives 403 `ACCOUNT_DISABLED` after the password checked out), a token whose `iat` second is earlier than `password_changed_at` gives 401, and **`role` for authorisation comes from the database, not the token**, so a demotion is immediate. The frontend page is `{FRONTEND_URL}/reset-password?token=…`.
Status: ☐

### H3. Email delivery: BE (**needs a decision from Abdul**)
Invites, resets and verification need to reach a person, even though notifications themselves are in-app only.
**Proposal:** a `Mailer` interface with two implementations: `ConsoleMailer` (logs the link; used in dev) and a real provider (SMTP, SES or Resend) chosen later. Until a provider is chosen, the invite and reset-request responses can also return the link to the owner/admin to pass on manually (flag `MAIL_MODE=link`), and that mode is **disabled in production**.
Open: which provider and sender domain.
**Built (Phase 1):** `Mailer` (abstract class, injectable) with `ConsoleMailer` bound in `MailModule`; `MailService` builds the links and, with `MAIL_MODE=link`, also returns them (invite response `link`, reset request `link`, signup `verificationLink`). `MAIL_MODE=link` makes the app refuse to start when `NODE_ENV=production`, and production also requires `FRONTEND_URL`. Still open: the provider and sender domain. The message gives the recipient `locale` and a template name; a provider renders the `email.<template>.*` keys of the `notifications` namespace (already written in en and ur).
Status: ☐

### H4. Email verification: BE
**Proposal:** `tenant_user.email_verified_at`. Signup sends a verification link; an unverified owner can use the trial but cannot invite staff or move to a paid plan. A user who accepts an **emailed** invite is verified at once (they proved access to the address). Lower priority than H1–H2.
**Built (Phase 1):** signup issues a 24-hour link (`{FRONTEND_URL}/verify-email?token=…`); `POST /v1/auth/verify-email` `{ token }` answers 204; `POST /v1/auth/verify-email/resend` (signed in) sends a new one and retires older ones. `EmailVerifiedGuard` (403 `EMAIL_NOT_VERIFIED`) protects `POST …/invites`; **there is no plan-change route for tenants yet, so the same guard must be put on it when it exists (Phase 5)**. Existing users were not backfilled as verified: they verify through the resend route. Changing a user's email resets verification and sends a new link.
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
**Built (Phase 1):** the table, `@Audit(action, { targetType, snapshot })` + `AuditInterceptor` (used for `invite.revoked`), and `AuditService.record(entry, tx?)` for entries written in the same transaction as the change (used for everything else). Recorded now: `user.invited`, `invite.accepted`, `invite.revoked`, `user.role_changed`, `user.disabled`, `user.enabled`, `user.email_changed`, `user.deleted`, `password.reset`, `tenant.suspended`, `tenant.reactivated`. Keys named like `password`, `token`, `secret`, `hash`, `link` are stripped from `before`/`after` at any depth. A database trigger refuses UPDATE and DELETE (so a 12-month retention purge and tenant offboarding must run as a privileged step that drops the trigger first); per-service DB roles stay in Phase 8. `actor_user_id` has no foreign key: for platform-admin actions it holds the `platform_admins` id and `actor_role` is `platform_admin`. The list is newest first with the `{data,total,skip,take}` envelope; `from`/`to` are ISO-8601 instants.
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
**Built (Phase 1):** as proposed. Files are flat key/value JSON (`src/lang/<locale>/<namespace>.json`); `GET /v1/i18n/locales` and `GET /v1/i18n/:locale/:namespace` are public, send a strong `ETag` and `Cache-Control: public, max-age=300, stale-while-revalidate=3600`, answer 304 to `If-None-Match`, and fill missing keys from `en`. Unknown locale or namespace gives 404 `LOCALE_NOT_FOUND` / `NAMESPACE_NOT_FOUND`. The `errors` namespace has one key per API `code` (a unit test fails when a new `ErrorCode` has no translation). `npm run i18n:check` warns about missing and extra keys (CI runs it as a warning). Columns: `tenants.default_locale` (default `en`, set at signup or by a platform admin), `tenant_user.locale` and `end_customers.locale` (nullable). `GET/PATCH /v1/me` shows and changes the user's own `name` and `locale`; the effective language is the user's, else the tenant default. The Urdu text was written by Claude and has been reviewed and accepted by Abdul; new keys still need a native-speaker check. Locale names and direction live in `src/i18n/locales.ts`.
Status: ☐

### H8. Deliberately deferred or owned elsewhere
| Topic | Decision |
|---|---|
| Attachments (images/files in chat) | Out of scope: text chat only for now |
| Email as a customer channel | Out of scope |
| Conversation analytics (resolution rate, escalation rate, satisfaction) | **AI engine owns** it. The backend keeps only usage metering for plans (`usage_daily`) |
| Routing rules and SLAs | Deferred. **Owner: backend + frontend** (who gets an escalated conversation, queue, timers, alerts all depend on staff data). The AI engine only decides *when* to escalate (C6). For now agents claim from one shared queue and `escalated_at` gives waiting time |
| Agent tooling (internal notes, tags, canned replies, transfer) | Deferred, undecided. **Owner: backend + frontend**; tables would live in `tenant_core` with a plain `conversation_id` column (no FK). Transfer = reassign via the engine's assign/claim API. **AI-assisted extras** (suggested draft replies, auto-tags, sentiment) would be owned by the AI engine, also deferred |
| Billing and payments | **Specified in section I**: manual payments now, payment provider later behind one interface |
Status: ☐

---

## I. Plans, trial, billing and use of customer data (backend)

Decided by Abdul on 2026-10-07: Starter (hidden, 15 days) falls back to Free; Free is a small but usable plan; currency is PKR and the starting prices below are accepted; data is kept 60 days where the rules in I10 allow it; payments are manual at first. Every number in a table below is a starting value stored as data in the `plans` table, adjustable without code changes.

### I1. Plan catalogue (data-driven): BE
Plans are rows with `code`, `name`, `visibility` (`public` | `hidden`), `price_minor`, `currency`, `interval` (`month` | `year` | `none`), `duration_days` (null = no end), `fallback_plan_code`, `entitlements` JSON and `provider_price_ids` JSON. The pricing page lists only `public` plans.

| | Starter (hidden) | Free (public) | Pro (public) | Enterprise (public) |
|---|---|---|---|---|
| Price (excl. tax) | not sold, granted at signup | PKR 0 | PKR 19,999 per month, PKR 199,990 per year (10 months) | custom quote, set by a platform admin |
| Duration | 15 days, then falls back to Free | no end | per period | per contract |
| Staff seats | 3 | 1 | 10 | custom |
| AI conversations | 100 in total | 30 per month | 1,500 per month, extra PKR 15 each | custom |
| Knowledge base | 20 MB | 10 MB | 500 MB | custom |
| Channels | chat | chat, "powered by" label | chat + WhatsApp | all |
| Voice | none | none | add-on, about PKR 25 per minute | custom |

Prices exclude tax; tax is a separate invoice line and its treatment needs an accountant (I7).
Status: ☐

### I2. Starter to Free lifecycle: BE
Every new tenant starts on **Starter** with `current_period_end = signup + 15 days` (the length is `plans.duration_days`, not code). At the end it moves to **Free** automatically unless a paid plan is active. A tenant can buy Pro at any time, including during Starter. Existing tenants at deployment time start Starter from that day, not from their creation date. A platform admin can extend Starter or change any plan.
Status: ☐

### I3. Subscription state machine: BE
`subscriptions.status`: `active` (includes Starter and Free), `past_due` (a paid period ended without renewal), `canceled` (ends at period end), `closed` (account closed), `suspended` (set by a platform admin).
```
Starter ─15 days─► Free ─payment─► Pro/Enterprise (active)
Starter ─payment──────────────────► Pro (active)
Pro active ─period ends, no renewal─► past_due ─7 days grace─► Free
Pro active ─cancel─► canceled (keeps Pro until period end) ─► Free
any ─admin─► suspended        any ─owner/admin request─► closed
```
`tenants.status` (`trial`/`active`/`suspended`) is replaced by this state; `tenants.plan` becomes derived from the subscription, and the existing `trial` and `free` values are migrated accordingly.
Status: ☐

### I4. Payment sources, manual now and a provider later: BE
The rest of the system never knows who took the money. Everything that changes a subscription is a normalised **BillingEvent** (`payment.succeeded`, `payment.failed`, `subscription.canceled`, `plan.changed`, …) applied by one `SubscriptionService.applyEvent()` state machine, which is idempotent and audited (H6).
- `BillingProvider` interface: `createCheckout`, `createPortalSession`, `cancel`, `handleWebhook(rawBody, headers) → BillingEvent[]`.
- `ManualProvider` (launch): a platform admin records a payment, which emits the same event a webhook would.
- Later: a `StripeProvider` or another one (provider choice depends on where the company is registered and is not decided). Adding it must not change the state machine, tables, enforcement or screens.
- Tables (`tenant_core`): `plans`, `subscriptions` (tenant, plan, status, period start/end, `cancel_at_period_end`, `provider`, `provider_customer_id`, `provider_subscription_id`), `invoices` (number, amount, currency, status, period, method, reference, `recorded_by`, `provider_invoice_id`), `billing_events` (append-only, unique per provider event id).
- Provider webhooks verify the raw-body signature and are processed once by event id. Card data never reaches our servers (hosted checkout).
Status: ☐

### I5. Entitlements and enforcement: BE (AI engine honours the result)
`EntitlementsService.check(tenantId, limit | feature)` is the single answer to "may this tenant do this?", with a short cache. It is called by the gateway (D1), the knowledge upload, seat and invite creation, and channel connection. Stable error codes (translatable, H7): `PLAN_LIMIT_REACHED`, `PLAN_FEATURE_UNAVAILABLE`, `SUBSCRIPTION_PAST_DUE`, `TENANT_SUSPENDED`.
At a limit the **end customer is never dropped**: the widget shows the tenant's configured fallback message and the conversation escalates to a human (D7). Over-limit conversations are counted but not answered by the AI.
Status: ☐

### I6. Manual billing API for platform admins (all audited): BE
Under `/v1/admin/tenants/:id/subscription`: `POST activate` (plan, period end or interval, amount, currency, method, reference), `POST record-payment` (renewal), `POST extend` (extend the current period, for example Starter), `POST change-plan`, `POST cancel`, plus `GET` for the subscription, invoices and billing events. Each call writes an invoice or event and an audit entry.
Status: ☐

### I7. Money, invoices and tax: BE
Amounts are integers in minor units plus a currency code (PKR at launch); never floats. Invoices have sequential numbers and a PDF/HTML view later. Tax is a separate line item; the applicable rate, registration and invoice wording need confirmation by an accountant before the first paid invoice.
Status: ☐

### I8. Reminders: BE
In-app notifications (H5) and a dashboard banner: Starter ends in 7, 3 and 1 days; paid period ends in 7, 3 and 1 days; grace period started; plan limit at 80% and 100%; downgrade to Free happened; data deletion notices (I10). A daily job applies time-based transitions; request-time checks guarantee correctness if the job is late.
Status: ☐

### I9. Abuse and cost guards: BE
No AI replies until the owner's email is verified (H4); signup rate limits per IP and per email; one Starter per organisation (matching verified email domain or company name, platform admin can override); hard caps from I1 on Starter and Free. Free-plan AI conversations are metered as carefully as paid ones because each costs LLM money.
Status: ☐

### I10. Data retention after a plan ends: BE (+ AI for engine data)
- Free is an ongoing plan, so a Free tenant's data stays while the account is active.
- When a paid plan ends and the tenant falls to Free, content **beyond the Free limits** (extra seats, knowledge over 10 MB, extra channels) is kept inactive and read-only for **60 days**, then deleted unless the tenant upgrades. Notices at day 30, 50 and 57, with an export offered.
- A closed or abandoned account is deleted **60 days** after closure through the offboarding procedure (architecture §5.6) across both schemas, with the same notices.
- Deletion is never silent. Legal retention (invoices, audit log) is the exception: invoices and tax records are kept for the period an accountant specifies.
Status: ☐

### I11. Using customer conversations to train our own model: BE + AI (**blocks any training use; needs legal review**)
We intend to train our own model later. Customer conversations contain personal data about **third parties** (the tenants' own customers) that we hold on the tenants' behalf. Using that data for our own training is a different purpose from running the service, and generally needs a clear legal basis: an explicit clause in the terms or data-processing agreement, and in many jurisdictions consent. Keeping data "for some future use not yet defined" is not a safe basis, and retention beyond I10 must be tied to a stated purpose. This is not legal advice; a lawyer must review before launch (Pakistan's data-protection rules and any foreign customers' rules, such as the GDPR, can apply).
**Proposal (privacy-by-design, so training stays possible later):**
- Table `data_use_consents` (tenant_id, purpose `model_training`, status, terms version, accepted_by, accepted_at, revoked_at). **Default is off.** Consent is explicit, per tenant, revocable, and recorded; it is not hidden in a pre-ticked box. An optional benefit, such as extra Free-plan quota for opting in, is a business decision for the owner.
- Only consenting tenants' data may enter a training dataset; the AI engine's export job filters by consent at export time.
- Datasets contain **de-identified** text (names, phones, emails, ids and card numbers removed, free-text checked), are stored separately from live data with access control, and carry the source tenant id so revocation and erasure can be honoured for future exports.
- Voice recordings are excluded unless separately consented, because voice is biometric-adjacent and its rules are stricter.
- Be honest about erasure: a model that has already been trained cannot "unlearn" one tenant's data, so only de-identified, consented data is used.
- Retention for training data is its own stated period in the terms; it does not extend I10 for non-consenting tenants.
Status: ☐

### I12. Self-hosted model readiness: AI + BE
Moving from an API model to our own GPUs changes our costs (mostly fixed instead of per token) but must not change what customers pay. Each assistant message already records `model`, `tokens_in`, `tokens_out` and `latency_ms` (C5); add `provider` and an `estimated_cost_micros` so we can compare API and self-hosted cost per tenant with real data before buying hardware. The AI engine should keep the model behind one interface so it can be swapped (Abdullah's decision).
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
| Auth | `POST /auth/signup`, `POST /auth/login`, `GET/PATCH /me` (built), `POST /auth/verify-email`, `POST /auth/verify-email/resend` (H4, built) |
| Tenant | `GET/PATCH /tenants/:tenantId` (own tenant), usage: `GET /tenants/:tenantId/usage` |
| Users | `GET /tenants/:tenantId/users`, `GET/PATCH/DELETE …/users/:id` (no create: invites, H1) |
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
I1 ☐  I2 ☐  I3 ☐  I4 ☐  I5 ☐  I6 ☐  I7 ☐  I8 ☐  I9 ☐  I10 ☐  I11 ☐  I12 ☐
```
Blocking items for the next sprint: **A1, A2, A5, B5, C1, C2, D1, D2**.
