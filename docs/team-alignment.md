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
**Built (Phase 3), API keys:** owner and admin create, list, read, change the origins of and revoke API keys; agents get 403 (the prototype's question G22: key prefixes and origins are hidden from agents); at most 10 active keys per tenant.
**Built (Phase 0), for the rows that exist today:** owner and admin create, change and delete users (an admin cannot touch an owner or promote anyone to owner; a tenant keeps at least one owner, else 409 `LAST_OWNER`). All roles read users, and read, create and edit customers; only owner and admin delete customers. Errors: `INSUFFICIENT_ROLE`, `OWNER_REQUIRED`. Other rows arrive with their features.
**Built (Phase 3C):** nobody disables, demotes or deletes themselves (403 `CANNOT_MODIFY_SELF`, J4); the whole matrix is one e2e table (`test/role-matrix.e2e-spec.ts`). The workspace settings (`PATCH /tenants/:tenantId`) and the upgrade request are owner-only (J3, J5).
**Built (Phase 1):** users are no longer created by owner/admin but invited (H1): admin may invite `admin`/`agent`, only an owner may invite or revoke an invite for an `owner`. "Change" now means email, role or **status** (`active`/`disabled`); an admin still cannot touch an owner. The tenant keeps at least one **active** owner (demoting, disabling or deleting the last one gives 409 `LAST_OWNER`; the check runs in a serializable transaction). Owners and admins read the audit log (H6). A password can only be set by its owner (invite, reset).
Status: ☐

### B3. How a staff member identifies their tenant at login: BE + FE
Login currently needs a `tenantId` UUID, which users do not know.
**Proposal:** add `tenants.slug` (unique); login takes `{ tenantSlug, email, password }`. The dashboard can derive the slug from a subdomain (`acme.app.example.com`) or a field.
**Built (Phase 0):** `POST /v1/auth/signup` accepts an optional `tenantSlug` (3-40 chars, `a-z 0-9 -`); when omitted it is derived from the tenant name. Taken or reserved slugs give 409 `SLUG_TAKEN`. Login takes `{ tenantSlug, email, password }`; the tenant UUID is no longer accepted.
**Built (Phase 3C):** the slug is no longer needed to log in (`POST /auth/login-email`, J2); the slug login stays for workspace links, and a slug renamed in the last 30 days still works (J3).
Status: ☐

### B4. End-customer identity per channel: BE + AI
**Built (Phase 3), widget row only:** `POST /v1/widget/sessions` upserts `web_<visitorId>` (concurrency-safe: two parallel first visits make one row) and passes the `end_customers.id` to the engine as `endCustomerId`. `visitorId` is 16 to 64 characters of `A-Za-z0-9_-`.
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
**Built (Phase 4), backend side:** the staff API and the dashboard read `status`, `assigned_user_id`, `escalated_at`, `escalation_reason`, `summary`, `resolved_at` and `resolved_by` through the engine calls proposed in `contracts/engine-internal.openapi.yaml` (the mock engine implements them; the AI side has not confirmed, J9).
Status: ☐

### C2. Who authored a message: AI
`role` stays for the LLM (`user`/`assistant`/`system`/`tool`). Add `author_type` (`customer`/`ai`/`human`/`system`/`tool`) and `author_user_id text null`. A human agent's reply is `role=assistant`, `author_type=human`, `author_user_id=<id>`, so the model and the UI both read it correctly.
**Built (Phase 4), backend side:** a staff reply is `POST …/conversations/:id/messages` → engine `human-messages` (`author_type=human`, `author_user_id`); the dashboard shows the author's name resolved from `tenant_user` (a deleted user gives `null`); system lines are `contentKey`s of the `widget` namespace (`agent.joined`, `agent.left`, `resolved.notice`), never English text.
Status: ☐

### C3. Idempotency for inbound messages: AI
WhatsApp and telephony providers retry webhooks.
**Proposal:** `messages.external_message_id text null` and `UNIQUE (tenant_id, channel, external_message_id) WHERE external_message_id IS NOT NULL`. The engine returns the existing result on a duplicate. The backend also sends an `Idempotency-Key` header on every command (D7).
Status: ☐

### C4. AI must stay silent while a human is active: AI
**Proposal:** the claim operation is atomic (`UPDATE … WHERE status IN ('active','escalated') AND assigned_user_id IS NULL`, 409 otherwise). Before generating any AI reply the engine re-checks status inside the same transaction, so a message that arrives at the moment of claim cannot produce a late AI answer.
**Built (Phase 4), backend side:** the backend claims only through the engine (atomic claim, 409 codes `CONVERSATION_ALREADY_CLAIMED|RESOLVED|NOT_ASSIGNED_TO_YOU`) and checks the assignee itself before every reply, release and resolve; the mock engine stays silent while `human_active` (tested). The real engine must do the same.
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
**Built (Phase 3):** the widget talks only to `/v1/widget/*`; the backend derives the tenant from the key/token and calls the engine through `EngineClient` (`ENGINE_MODE=mock` or `http`). The real engine has not been connected yet.
**Proposal:** browsers, phone providers and WhatsApp only talk to the **backend**. The engine listens on a private interface only. The backend authenticates the caller, derives `tenantId`, then calls the engine. This keeps staff JWTs, widget keys and provider signatures entirely on the backend, and keeps the engine free of auth logic.
Status: ☐

### D2. Service-to-service authentication: BE + AI
**Built (Phase 3):** `HttpEngineClient` sends `Authorization: Bearer $INTERNAL_API_TOKEN` (32+ characters, required for `ENGINE_MODE=http`), `X-Tenant-Id` (only from the verified widget token or key), `X-Request-Id` and `Idempotency-Key`. `X-Acting-User-Id` / `X-Acting-Role` arrive with the staff-side calls (Phase 4). Written down in `docs/contracts/engine-internal.openapi.yaml`.
**Proposal:** `Authorization: Bearer <INTERNAL_API_TOKEN>` (long random secret, one per environment, rotatable) plus headers `X-Tenant-Id`, `X-Request-Id`, and where relevant `X-Acting-User-Id` / `X-Acting-Role`. **The engine takes `tenantId` only from `X-Tenant-Id`, never from the body, a query string or message content.** The staff JWT is never forwarded and the engine does not verify it. If the engine ever must verify user tokens, we move to asymmetric (RS256/ES256) signing.
Status: ☐

### D3. Widget session token: BE
**Built (Phase 3):** JWT, 15 minutes, claims `scope=widget`, `tenantId`, `endCustomerId`, `conversationId` plus `keyId` and `locale`, a unique `jti`; signed with a secret derived from `JWT_SECRET` (a staff or platform token fails verification on widget routes and the other way round). Refresh = call `POST /v1/widget/sessions` again with the same `visitorId` (same conversation, a conversation counts once); an expired token answers `401 WIDGET_TOKEN_EXPIRED`. The key and the request Origin are re-checked on every call, so revoking the key ends its sessions.
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
**Built (Phase 4):** the receiver `POST /internal/events` (outside `/v1`, not in the public OpenAPI) verifies an HMAC-SHA256 signature over `<timestamp>.<raw body>` made with `INTERNAL_API_TOKEN` (the token itself is never sent; 5 minute window), takes the tenant from the envelope only, and is idempotent by (tenant, event id) with the effects in the same transaction; contract: `contracts/backend-events.openapi.yaml`. Dashboard stream `GET /v1/tenants/:tenantId/events` (Bearer header, or a single-use 30 second ticket from `POST …/events/ticket` for a browser `EventSource`; heartbeat, `Last-Event-ID`, 5 streams per user) and the customer stream `GET /v1/widget/events`. The fan-out is in process memory: several backend instances need Redis (Phase 8). The AI side has not confirmed names, payloads or the signing (J9).
Status: ☐

### D6. How the backend reads engine data (dashboard lists, queues): BE + AI
Writes always go through the engine API. For **reads** there are two options:
- **(a) Engine read API** (`GET /internal/conversations?…`): clean ownership, one more thing to build and paginate.
- **(b) Read-only Postgres views** owned by the engine (`ai_engine_api.v_conversations`, `v_messages`) and queried by the backend through a read-only role: fast to build, but the views become a published contract.

**Proposal:** (a) for conversation detail and messages, (b) for list/queue/search queries, with the views versioned and documented in this repo. AI to confirm they accept the views as a contract.
**Built (Phase 4), option (a) only:** the backend reads conversations and messages through the engine's HTTP API (list, counts, detail with paginated messages); no database views are used.
Status: ☐

### D7. Timeouts, retries and fallback: BE + AI
**Built (Phase 3):** 5 s to the first answer event and 30 s in total (`ENGINE_FIRST_TOKEN_TIMEOUT_MS`, `ENGINE_TOTAL_TIMEOUT_MS`), ONE retry only when the connection broke, `Idempotency-Key` on commands. On failure the customer gets `fallback` with reason `ai_unavailable` and the gateway calls the engine's `POST /internal/conversations/:id/escalate` (**a proposed addition to Appendix A: please confirm**); if the engine cannot take it the escalation is remembered (`escalation_pending`, delivered by a later phase). The fallback text comes from the `widget` namespace now and from `agent_config` in Phase 5.
**Proposal:** the backend sends `Idempotency-Key` on commands and allows 5 s to first token, 30 s total; one retry on network error only. If the engine is down or slow the customer gets a configurable fallback message ("A colleague will reply shortly"), and the conversation is marked `escalated` with reason `ai_unavailable`. Engine commands are idempotent by key.
Status: ☐

### D8. CORS and widget origins: BE
**Built (Phase 3):** exactly as proposed, plus the preflight rule the prototype asked about (G9.3): a preflight carries no key, so it is answered for any origin that some active widget key lists (never `*`, no credentials); the real response gets `Access-Control-Allow-Origin` only after the key and the origin matched for that key. Origins are exact (`scheme://host[:port]`, https, or http for localhost); wildcards are not supported; an empty list means the key works nowhere; a request without `Origin` is refused. Dashboard routes keep `FRONTEND_URL`.
CORS today allows one origin (`FRONTEND_URL`), which fits the dashboard but not a widget embedded on customer websites.
**Proposal:** dashboard routes keep `FRONTEND_URL`; widget routes allow the origins listed in the tenant's widget `api_keys.allowed_origins`.
Status: ☐

---

## E. Knowledge base, agent configuration, actions and voice

### E1. Tenant agent configuration: BE owns, AI reads (**decided 2026-10-28, L7: the backend owns it and the engine pulls it at call start; per agent; built in Phase 5B-1**)
**Built (Phase 5B-1) instead of the first proposal:** table `tenant_core.agent_settings` (one row per version of the settings of ONE agent; the document has the engine's own field list, see L7) edited from the dashboard by owner and admin. The engine fetches `GET /internal/tenants/{tenantId}/agents/{agentId}/config` (cached up to 60 s) and may ask for a specific `?version=`. The contract is `AgentConfig` in `docs/contracts/backend-internal.openapi.yaml`; the earlier chat-era draft `docs/contracts/agent-config.schema.json` is superseded and kept only as history.
Status: built (Phase 5B-1); the engine's confirmation is Q28

### E2. Knowledge ingestion and deletion: BE + AI
**Proposal:** files go to S3-compatible object storage (MinIO locally); `knowledge_sources` is the tenant-visible record with status; the engine chunks/embeds and writes `knowledge_chunks`.
Schema request (AI): `knowledge_chunks.source_id text` (= `knowledge_sources.id`), `chunk_index int`, `embedding_model text`; index `(tenant_id, source_id)`. Deleting a source = `DELETE FROM knowledge_chunks WHERE tenant_id=$1 AND source_id=$2`. The existing `source` text column stays as a human-readable label.
Status: ☐

### E3. Embedding dimension and retrieval correctness: AI
Embeddings are locked to `vector(768)` (Gemini). We record `embedding_model` so a future change can be migrated deliberately.
**Note for pgvector:** an approximate (HNSW/IVF) index combined with `WHERE tenant_id = …` can return **fewer results than requested** because filtering happens after the index scan. Options: pgvector ≥ 0.8 iterative index scans, a partial/partitioned index per large tenant, or an exact scan for small tenants. Every similarity query must still filter by `tenant_id`, with a test proving tenant B never sees tenant A's chunks.
Status: ☐

### E4. Agent actions, integration credentials and approvals: BE + AI (**superseded 2026-10-21: see L3**)
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
**Built (Phase 3), gateway side:** 2,000-character cap (400 `MESSAGE_TOO_LONG`, counted in characters), fixed-window limits per minute per IP, per widget key and per visitor (defaults in `src/widget/widget.constants.ts`: sessions 30/600/10, messages 60/1200/20, reads 120/60, preflights 120), 429 with `Retry-After`. **The counters are in process memory: per instance until Phase 8.** The CAPTCHA/turnstile option and the engine-side token caps are not built.
**Proposal:** rate limits per widget key and per IP at the gateway; maximum message length (2,000 characters) enforced on both sides; per-conversation and per-tenant daily token caps in the engine; widgets can require a lightweight challenge (CAPTCHA/turnstile) on session start if abused.
Status: ☐

### F7. Time and ids: BE + AI
Ids are text UUIDs. Timestamps are stored in UTC (Prisma `DateTime`, `timestamp(3)` without zone on both sides) and exposed as ISO-8601 strings with `Z`.
Status: ☐

---

## G. Frontend contract

### G1. Lists and pagination: BE (change affects FE)
Lists first returned a bare array. **Proposal (changing early was cheap, later it would have been a breaking change):** `GET` lists return `{ "data": [...], "total": n, "skip": 0, "take": 20 }`, default `take=20`, maximum 100.
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
**Built (Phase 3C):** the slug is optional in the request (J2); without it the link resets every workspace of that email, with it only that workspace. A reset remembers the address it was sent to and is refused after the user changed email. Login is throttled (J2).
Status: ☐

### H3. Email delivery: BE (**decided 2026-10-10: Resend**)
Invites, resets and verification need to reach a person, even though notifications themselves are in-app only.
**Decision (Abdul):** use **Resend**, behind the existing `Mailer` interface (a switch to SES, Brevo or another provider later is one new class and one setting). No sending domain exists yet, so the first stage runs in Resend's **test mode**: the shared sender `onboarding@resend.dev`, which (per third-party sources; confirm in Resend's docs) delivers only to the email address of the Resend account itself and rejects other recipients with a 403. Free plan: 3,000 emails a month, at most 100 a day, no overage (sending pauses at the cap); the paid plan is about $20 a month for 50,000. Pricing and limits come from comparison sites, not Resend; check resend.com/pricing.
**Settings (names only, values stay in `.env`, never in chat or git):**
- `MAIL_PROVIDER` = `console` (default, logs the link) | `resend`; production refuses to start with `console`.
- `RESEND_API_KEY` (secret; a send-only key from the Resend dashboard).
- `MAIL_FROM` = `onboarding@resend.dev` for now; later an address on the verified domain.
- `MAIL_FROM_NAME` = the product name shown to recipients. **Default: `SupportDesk AI` (a working name, decided 2026-10-10; still configurable).**
- `MAIL_REDIRECT_TO` = the Resend account's own email, **test stage only**: every outgoing message goes to that one address, and the subject/body header names the intended recipient so invites and resets can still be exercised. Production refuses to start with it set.
- `MAIL_MODE=link` stays a separate development switch (links also returned in API responses); it is refused in production.
**Design points for the implementation:** HTML and plain-text templates rendered from the `email.<template>.*` keys of the `notifications` namespace in the recipient's locale (Urdu right-to-left); the send failing must not break the flow (the invite or reset still exists) but must be logged without the link and visible to the caller (for example `delivery: sent | failed | skipped` in the response so the dashboard can offer "resend"); a bounded timeout and one retry; no recipient address or link in logs; a health warning when sending fails repeatedly; the 100-a-day cap makes a burst of signups fail silently, so watch the failure log and upgrade the plan when needed. Bounce and complaint webhooks (suppression list) come later.
**Moving to production mail:** buy or reuse a domain, verify it in Resend (SPF, DKIM, DMARC records), set `MAIL_FROM` to an address on it, remove `MAIL_REDIRECT_TO`.
**Built (Phase 1):** `Mailer` (abstract class, injectable) with `ConsoleMailer` bound in `MailModule`; `MailService` builds the links and, with `MAIL_MODE=link`, also returns them (invite response `link`, reset request `link`, signup `verificationLink`). `MAIL_MODE=link` makes the app refuse to start when `NODE_ENV=production`, and production also requires `FRONTEND_URL`. The message gives the recipient `locale` and a template name; a provider renders the templates (the keys are written in en and ur). **Built (Phase 4C):** `ResendMailer` and `MAIL_PROVIDER=console|resend` (production refuses `console`, `MAIL_REDIRECT_TO`, a `resend.dev` sender), `RESEND_API_KEY`, `MAIL_FROM` (default `onboarding@resend.dev`), `MAIL_FROM_NAME` (default `SupportDesk AI`), `MAIL_REDIRECT_TO` (subject `[TEST for <recipient>]` plus a marked line in the body), optional `MAIL_TIMEOUT_MS` (5 s per attempt, one retry after a network error, timeout or 5xx, never after 4xx/429). HTML and plain-text templates from the `email.*` keys in en and ur (right-to-left), HTML escaped, no tracking. A failed send never breaks the flow: invite create (`delivery`), signup (`verificationDelivery`) and verification resend (`delivery`) report `sent | failed | skipped`; the password-reset request stays a constant 202 with no delivery field. Failures are logged by template and reason code only (`test_mode_recipient`, `quota_daily`, `quota_monthly`, `rate_limited`, `auth`, `timeout`, `network`, ...); `GET /health/ready` shows `mail.status` (`degraded` after 3 failures in a row, readiness stays 200). The Resend facts in this section were checked against Resend's documentation on 2026-10-11 (the 403 test-mode refusal, the 429 quota errors, 10 requests a second, 100 a day and 3,000 a month on the free plan). **Not verified:** real delivery (needs your key; checklist in the README). **Follow-ups:** emailing the billing reminders (templates exist), bounce/complaint webhooks, native review of the Urdu email texts.
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
**Built (Phase 4):** the table has no `title_key`/`body_key` (the keys derive from `type`: `<type>.title`, `<type>.body`), plus `dedupe_key` for idempotent reminders. API: `GET …/notifications` (`?unread=true`, own rows only), `POST …/:id/read`, `POST …/read-all`; `unreadNotifications` in `GET /v1/me`; `notification.created` on the dashboard stream; 90-day purge. Created today: `conversation.escalated` (all active staff), `conversation.assigned` (the assignee, not for a plain claim), `action.proposed` (owners and admins) and the billing reminders of I8, `usage.threshold` / `usage.limit_reached`. Types and params: architecture section 5.7. Not yet: `ingestion.failed`, `invite.accepted`, `tenant.suspended`.
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
| AI conversations | 100 in total | 30 per month | 1,500 per month, extra PKR 15 each (overage on by default; the owner can switch it off for a hard stop, J6) | custom |
| Knowledge base | 20 MB | 10 MB | 500 MB | custom |
| Channels | chat | chat, "powered by" label | chat + WhatsApp | all |
| Voice | none | none | add-on, about PKR 25 per minute | custom |

Prices exclude tax; tax is a separate invoice line and its treatment needs an accountant (I7). **Update 2026-10-21 (L6): every plan now includes call minutes and voice is on; the voice row above and the conversation numbers are superseded for the voice-first product, see L6.**

**Built (Phase 2B):** table `plans` seeded with these four rows by the migration (adjust the rows, not the code). Columns as proposed plus `yearly_price_minor` (Pro: PKR 199,990 = `19999000` minor units, monthly `1999900`), `sort_order` and `active`; `price_minor` is `null` for a custom quote (Enterprise) and `interval` is `none` for plans without a billing interval (Enterprise is per contract, so an admin passes `periodEnd`). **Entitlements JSON:** `{ "seats": 3, "conversationsPerPeriod": 100, "conversationPeriod": "total" | "month", "knowledgeMb": 20, "channels": ["chat"], "voice": false, "poweredByLabel": false, "overageConversationMinor"?: 1500, "voicePerMinuteMinor"?: 2500 }`; `null` = unlimited, a missing key = the most restrictive value, `total` = since the subscription period began (Starter), Pro voice is an add-on so `voice` is false there until a per-tenant override (`subscriptions.entitlements_override`, same keys) grants it. Public list: `GET /v1/plans` (Free, Pro, Enterprise; Starter is hidden). Starter and Free values are placeholders.
**Built (Phase 5A, L6), shape after the migration `20261021120000_phase5a_call_minutes`:** every plan has `voice: true`, `channels` with `voice`, and the new keys `callMinutesPerPeriod` (null = unlimited, missing = 0), `callMinutePeriod` (`total` | `month`) and, on Pro, `overageMinuteMinor` (2500). Placeholders: Starter 30 minutes in total, Free 20 a month, Pro 300 a month, Enterprise unlimited. `voicePerMinuteMinor` (Pro, 2500) is now a legacy hint that nothing reads. **The numbers and the Pro prices can be set from environment variables** (`PLAN_STARTER_CALL_MINUTES`, `PLAN_FREE_CALL_MINUTES`, `PLAN_PRO_CALL_MINUTES`, `PLAN_PRO_OVERAGE_MINUTE_MINOR`, `PLAN_PRO_PRICE_MONTH_MINOR`, `PLAN_PRO_PRICE_YEAR_MINOR`; README "Plan numbers and prices"): at startup the set ones are written into the `plans` table, which remains the source of truth (CLAUDE.md rule 15).
Status: ☐

### I2. Starter to Free lifecycle: BE
Every new tenant starts on **Starter** with `current_period_end = signup + 15 days` (the length is `plans.duration_days`, not code). At the end it moves to **Free** automatically unless a paid plan is active. A tenant can buy Pro at any time, including during Starter. Existing tenants at deployment time start Starter from that day, not from their creation date. A platform admin can extend Starter or change any plan.

**Built (Phase 2B):** signup creates the Starter subscription in the same transaction (`current_period_end` = now + `plans.duration_days`); the migration gave every existing tenant a Starter subscription starting on the deployment day. It falls to Free by itself (on read and by the job). Admin: `extend`, `change-plan`.
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

**Built (Phase 2B), with one deliberate deviation:** the columns are not dropped (expand-contract on the shared database). `tenants.plan` and `tenants.status` stay as **denormalised mirrors** (`status` = `trial` while on Starter, `active`, `suspended`, `closed`) written only by `SubscriptionService` in the transaction of each change; the auth guard reads `status` (cheap suspended/closed check), nothing else may. Dropping them is a later, separate migration if ever wanted. The machine is exactly the diagram above, plus: `past_due` grace = 7 days from the end of the paid period (a constant, `GRACE_DAYS`); a payment on time renews from the old period end, a late one from now; a paid plan cancelled at period end shows `status: canceled` until it ends; suspending remembers the previous state and lifting restores it; `closed` is final (the event exists, the route does not yet). Pure functions in `billing/subscriptions/state-machine.ts`.
Status: ☐

### I4. Payment sources, manual now and a provider later: BE
The rest of the system never knows who took the money. Everything that changes a subscription is a normalised **BillingEvent** (`payment.succeeded`, `payment.failed`, `subscription.canceled`, `plan.changed`, …) applied by one `SubscriptionService.applyEvent()` state machine, which is idempotent and audited (H6).
- `BillingProvider` interface: `createCheckout`, `createPortalSession`, `cancel`, `handleWebhook(rawBody, headers) → BillingEvent[]`.
- `ManualProvider` (launch): a platform admin records a payment, which emits the same event a webhook would.
- Later: a `StripeProvider` or another one (provider choice depends on where the company is registered and is not decided). Adding it must not change the state machine, tables, enforcement or screens.
- Tables (`tenant_core`): `plans`, `subscriptions` (tenant, plan, status, period start/end, `cancel_at_period_end`, `provider`, `provider_customer_id`, `provider_subscription_id`), `invoices` (number, amount, currency, status, period, method, reference, `recorded_by`, `provider_invoice_id`), `billing_events` (append-only, unique per provider event id).
- Provider webhooks verify the raw-body signature and are processed once by event id. Card data never reaches our servers (hosted checkout).

**Built (Phase 2B):** `BillingProvider` (abstract class), `ManualProvider` (checkout, portal and webhooks answer 501 `NOT_IMPLEMENTED`; `cancel` is a no-op because nothing exists outside this system) and a `BillingProviders` registry. Events: `payment.succeeded`, `payment.failed`, `subscription.canceled`, `plan.changed`, `period.ended`, `period.extended` (added for the admin `extend` command), `account.closed`, `tenant.suspended`, `tenant.unsuspended`; `subscription.created` is only logged. Tables as listed plus `invoice_sequences`; `billing_events` is append-only (DB trigger) and unique per (`provider`, `provider_event_id`). Admin commands accept an optional `idempotencyKey`, stored as the tenant-scoped provider event id. Phase 9 adds a class and registers it; no other change.
Status: ☐

### I5. Entitlements and enforcement: BE (AI engine honours the result)
`EntitlementsService.check(tenantId, limit | feature)` is the single answer to "may this tenant do this?", with a short cache. It is called by the gateway (D1), the knowledge upload, seat and invite creation, and channel connection. Stable error codes (translatable, H7): `PLAN_LIMIT_REACHED`, `PLAN_FEATURE_UNAVAILABLE`, `SUBSCRIPTION_PAST_DUE`, `TENANT_SUSPENDED`.
At a limit the **end customer is never dropped**: the widget shows the tenant's configured fallback message and the conversation escalates to a human (D7). Over-limit conversations are counted but not answered by the AI.

**Built (Phase 2B):** `EntitlementsService.check(tenantId, key, amount?, options?)` returns `{ allowed, planCode, limit, used }` or `{ allowed: false, code, reason, ... }`; `assert` throws a 403 with the same code. Keys: `seats`, `conversations`, `knowledgeMb`, `voice`, `channel:<name>`. Codes: `PLAN_LIMIT_REACHED`, `PLAN_FEATURE_UNAVAILABLE`, `SUBSCRIPTION_PAST_DUE`, `TENANT_SUSPENDED`, `TENANT_CLOSED`, `NO_ACTIVE_SUBSCRIPTION`. `past_due` keeps answering customers (`conversations` still allowed) but cannot grow (seats, uploads, channels). Wired into invite creation, invite acceptance and re-enabling a user (seats = active users + pending invites, counted under the subscription row lock so parallel invites cannot overshoot). 30 s cache, dropped on every change by this instance and never kept past the next time-based transition.
**Built (Phase 3), gateway:** `conversations` is enforced from real usage (`usage_daily`) when a conversation starts; a returning visitor of an open conversation is never stopped. At the limit the conversation is still created and counted, marked `limited`, the customer's messages are stored with `aiReply:false`, the conversation escalates with `limit_reached` and the model is not called. `past_due` keeps answering customers (`allowPastDue` on the chat check) but cannot create new widget keys. A suspended or closed tenant, or a plan without chat, answers `status: "blocked"`. `knowledgeMb` still reports 0 usage until knowledge upload exists (Phase 5).
**Built (Phase 4B):** on a plan with an overage price and the owner's setting on, `check('conversations')` answers `allowed: true, overage: true` past the included amount (J6); every other key and every other plan is unchanged.
**Built (Phase 5A, L6):** the key `callMinutes` ("may one more minute be served?", from `usage_daily.call_minutes`) works like `conversations`: `past_due` is served within the limit and never starts overage, suspended and closed are denied first, overage applies only when the plan prices minutes (`overageMinuteMinor`) and the owner left the switch on. The tenant status check of Phase 5B is built on it.
Status: ☐

### I6. Manual billing API for platform admins (all audited): BE
Under `/v1/admin/tenants/:id/subscription`: `POST activate` (plan, period end or interval, amount, currency, method, reference), `POST record-payment` (renewal), `POST extend` (extend the current period, for example Starter), `POST change-plan`, `POST cancel`, plus `GET` for the subscription, invoices and billing events. Each call writes an invoice or event and an audit entry.

**Built (Phase 2B):** exactly these routes under `/v1/admin/tenants/:id/subscription`. `activate` and `record-payment` answer 201 with `{ applied, duplicate, subscription, invoice }` (a paid, sequentially numbered invoice `INV-<year>-<6 digits>`); `extend`, `change-plan` and `cancel` answer 200 and create no invoice. Errors: 409 `INVALID_SUBSCRIPTION_STATE`, 404 `PLAN_NOT_FOUND` / `TENANT_NOT_FOUND` / `SUBSCRIPTION_NOT_FOUND`, 400 validation. Payment DTO: `amountMinor` (JSON integer, 1..2,000,000,000), `currency` (`PKR`), `method` (`bank_transfer`, `cash`, `cheque`, `mobile_wallet`, `other`), optional `reference`, `interval`/`periodEnd`, `idempotencyKey`. Everything in OpenAPI (`docs/openapi.json`).
Status: ☐

### I7. Money, invoices and tax: BE
Amounts are integers in minor units plus a currency code (PKR at launch); never floats. Invoices have sequential numbers and a PDF/HTML view later. Tax is a separate line item; the applicable rate, registration and invoice wording need confirmation by an accountant before the first paid invoice.

**Built (Phase 2B), tax part still OPEN:** amounts are integers in minor units plus a currency code (`PKR`); invoices have sequential numbers per calendar year, a status (`paid` today), the period, method, reference and who recorded it. **Not decided in code:** tax lines, rates, registration numbers, invoice wording, fiscal-year numbering and the PDF/HTML view: the accountant decides these before the first paid invoice.
Status: ☐

### I8. Reminders: BE
In-app notifications (H5) and a dashboard banner: Starter ends in 7, 3 and 1 days; paid period ends in 7, 3 and 1 days; grace period started; plan limit at 80% and 100%; downgrade to Free happened; data deletion notices (I10). A daily job applies time-based transitions; request-time checks guarantee correctness if the job is late.

**Built (Phase 2B), reminders NOT built:** the job and the request-time checks are done (the job sweeps on boot and hourly in every instance, one holding an advisory lock). The notifications need H5 (Phase 4). Until then `GET /v1/me` carries `subscription` (plan, status, `currentPeriodEnd`, `daysLeft`, `graceEndsAt`, `graceDaysLeft`, `cancelAtPeriodEnd`, limits) so the frontend can show the banner.
**Built (Phase 4):** the reminders are in-app notifications for owners and admins, created idempotently by the hourly billing job: the Starter trial or a paid period ends in 7, 3 and 1 days, the grace period started, the tenant was moved to a lower plan, and 80% and 100% of the conversation allowance (one reminder per tenant, kind, threshold and period). The data-deletion notices of I10 wait for Phase 8.
**Phase 4B:** at 100% the notification is `usage.overage_started` when the plan has an overage price and overage is on, else `usage.limit_reached` (J6).
**Phase 5A:** the same three reminders for call minutes: `usage.minutes_threshold` (80%), `usage.minutes_overage_started` and `usage.minutes_limit_reached` (100%, only the one that fits the current state), deduplicated per unit and period; the Urdu texts need a native-speaker check.
Status: ☐

### I9. Abuse and cost guards: BE
No AI replies until the owner's email is verified (H4); signup rate limits per IP and per email; one Starter per organisation (matching verified email domain or company name, platform admin can override); hard caps from I1 on Starter and Free. Free-plan AI conversations are metered as carefully as paid ones because each costs LLM money.

**Phase 2B:** only the plan caps of I1 (as entitlements) exist. **Phase 3:** the caps are enforced at the gateway and the widget has rate limits (F6). Signup rate limits, one Starter per organisation and "no AI replies until the owner's email is verified" are still NOT built (the gateway does not look at `email_verified_at`; decide whether an unverified owner's widget should answer; the rest belongs to Phase 8).
Status: ☐

### I10. Data retention after a plan ends: BE (+ AI for engine data)
- Free is an ongoing plan, so a Free tenant's data stays while the account is active.
- When a paid plan ends and the tenant falls to Free, content **beyond the Free limits** (extra seats, knowledge over 10 MB, extra channels) is kept inactive and read-only for **60 days**, then deleted unless the tenant upgrades. Notices at day 30, 50 and 57, with an export offered.
- A closed or abandoned account is deleted **60 days** after closure through the offboarding procedure (architecture §5.6) across both schemas, with the same notices.
- Deletion is never silent. Legal retention (invoices, audit log) is the exception: invoices and tax records are kept for the period an accountant specifies.

**Phase 2B:** not built. After a downgrade nobody is removed: users above the new seat limit stay and only new invites, acceptances and re-enables are refused. The 60-day inactive period, the notices and the deletion are Phase 8 (with the offboarding procedure). `closed_at` is recorded on the subscription for it.
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

**Built (Phase 2B), only the consent record; export BLOCKED:** table `data_use_consents` (one row per tenant and purpose, `model_training`; no row = off) and `GET`/`PUT /v1/tenants/:tenantId/data-use`, **owner only**, default off, explicit (`enabled` must be a JSON boolean; granting needs the `termsVersion` the owner was shown), records who accepted and when, revoking keeps the row, every change is audited (`data_use.granted` / `data_use.revoked`). Nothing reads it to export or copy data and nothing may until the lawyer has reviewed the terms, the lawful basis, de-identification and voice exclusion. Which terms version is current is not decided in code: the client sends it.
Status: ☐

### I12. Self-hosted model readiness: AI + BE
Moving from an API model to our own GPUs changes our costs (mostly fixed instead of per token) but must not change what customers pay. Each assistant message already records `model`, `tokens_in`, `tokens_out` and `latency_ms` (C5); add `provider` and an `estimated_cost_micros` so we can compare API and self-hosted cost per tenant with real data before buying hardware. The AI engine should keep the model behind one interface so it can be swapped (Abdullah's decision).
Status: ☐

## J. Decisions from the frontend gap report (2026-10-10)

A frontend prototype (`D:\multiTennant_frontend`, report `GAP-REPORT.md` there) was built against the backend and found 29 gaps (G1 to G29). Already closed by Phase 2B and 3: G1 and G2 (plans endpoint, `subscription` summary in `GET /v1/me` for every role, billing readable by owner and admin), the billing error codes in G10 (translated; they still do not say *which* limit was hit), and most of G9 and G15 (widget fallbacks, per-key CORS, API keys). The rest is below. Gap ids (G..) refer to that report, not to section G of this file.

### J0. Confirmed defects, no decision needed: BE (roadmap Phase 3B)
1. Signup password has no maximum, bcrypt cuts at 72 bytes: add `@MaxLength(72)` (G23.11).
2. `passwordChangedAt` and `emailVerifiedAt` are returned to agents in the user list: show them to owner and admin only (G23.3).
3. No `trust proxy` setting: add `TRUST_PROXY` (env) so audit `ip` and the per-IP limits are right behind the frontend's proxy (G25).
4. `PATCH /me` cannot clear the name (accept `null`) (G29.1); 429 responses carry no `Retry-After` header (G29.4).
5. Undocumented fields on invite responses (`acceptedAt`, `revokedAt`) and dev-only `link` fields in OpenAPI (G23.6, G23.13); delete routes return 200 with a body while others return 204 (G23.4): pick one convention.
6. Locale fields are `en|ur` enums in the DTOs: validate against the locale registry instead (G23.5).
7. Invite preview for the accept page: `GET /v1/auth/invites/preview?token=` returning tenant name, role, email, expiry (G20).
8. Re-check G29.6 (reactivating a suspended tenant must restore its previous state; the billing state machine should already do this).
9. Fix stale text in this file (section G1 still says lists return a bare array).
**Built (Phase 3B, branch `phase-4-human-agent`):** items 1 to 9. Notes: the password limit counts BYTES (72, what bcrypt really hashes) and also applies to invite acceptance and password reset; `Retry-After` was already sent, the real gaps were that CORS did not expose it and the body had no remaining seconds (now `retryAfterSeconds`); the five DELETE routes already agreed (200 with the removed object), the convention is now tested and documented, so the frontend needs no change; reactivation (item 8) was already correct (a Starter trial returns as the trial, a past-due tenant as past due), now also covered by a database test.
Status: ☐

### J1. Logout and token revocation (G3, security): BE (**decided 2026-10-11**)
Logging out only cleared the cookie; the token stayed valid until it expired (default 1 day).
**Decision (Abdul): yes.** `POST /v1/auth/logout` sets a per-user `tokens_valid_after` timestamp; `JwtStrategy` rejects any token issued before it (next to the existing `password_changed_at` check). The same for platform admins (`POST /v1/admin/auth/logout`). Because it is one timestamp per user, **a logout ends every session of that user ("log out everywhere")**; single-device logout would need a per-token id and is not planned. Refresh tokens and shorter access tokens stay in Phase 8. Audit entry `auth.logout`; the frontend calls it from "Log out" and clears its cookie.
**Built (Phase 3C):** `POST /v1/auth/logout` (any staff role, 204) and `POST /v1/admin/auth/logout` (platform admin, 204) set `tokens_valid_after` to now on the caller's row. `JwtStrategy` and `PlatformJwtStrategy` refuse every token issued before it, next to the `password_changed_at` check. Details worth knowing: tokens now carry `iatMs` (milliseconds) so a login in the same second as the logout works while a token issued earlier in that second is still refused (older tokens without it fall back to whole seconds, at most a day); logout works even when the workspace is suspended (the old tokens must not revive on reactivation); it is audited as `auth.logout` in the tenant's log (a platform admin has no tenant: that logout goes to the application log); widget tokens are untouched; a logout of one workspace does not touch the same person's membership in another workspace (J2). **Frontend:** call it from "Log out", then drop the cookie and any selection token.
Status: built (Phase 3C)

### J2. Logging in and finding your workspace (G4): BE (**decided 2026-10-11**)
Login used to need three things (workspace slug, email, password), and a forgotten slug locked people out (a reset also asked for the slug); at signup the slug was only checked after submitting.
**Decision (Abdul): email-first login with a workspace picker, "like I told you", and solve problems as they appear.** The person types email and password; the backend checks every workspace where that email exists and answers with the workspaces whose password matched; the person clicks one and enters its dashboard. No slug is typed. The emailed "find my workspace" is dropped. The availability check stays.
**How it is built (Option 1: keep one password per workspace, the proposal I recommended; Option 2, one global account per person, stays a later possibility and the flow below is the same for it):**
- `POST /v1/auth/login-email {email, password}` returns `{selectionToken, expiresIn, workspaces: [{tenantId, slug, name, role, available, reason?}], unmatchedCount}`; when exactly one workspace is available it also returns the normal `access_token` so the frontend can skip the picker. `POST /v1/auth/select-workspace {selectionToken, tenantId}` returns the normal login answer for that workspace. The selection token (scope `workspace-select`, 10 minutes, signed with a derived secret so no other guard accepts it) lists only the memberships whose password matched; every selection re-checks that the user still exists, is active and was not logged out or re-passworded after the token was issued (J1). Suspended or closed workspaces and disabled users appear with `available: false` and a reason code (the person proved the password, so this reveals nothing new); selecting one answers the same error as today.
- Failures are generic (`INVALID_CREDENTIALS`) and take the same time whether the email exists or not (a dummy password comparison when there is no row). `unmatchedCount` is the number of other memberships of that email whose password differed: the screen says "N other workspaces use a different password, use forgot password" (shown only to someone who proved one password).
- **Login throttling becomes mandatory** (known issue 1): per normalised email and per IP, in-memory like the other limiters, 429 with `Retry-After`; also applied to the old slug login. The limiter must not let an attacker lock a victim out forever (count failures per email AND IP, and per IP alone with a higher ceiling).
- The old slug login (`POST /v1/auth/login`) keeps working (workspace-specific link, future subdomains).
- **Forgot password without a slug:** `POST /v1/auth/password-reset/request` accepts just `{email}` (slug optional); always 202; if the email exists anywhere the person gets ONE email with ONE link; confirming sets the new password on **every membership with that email** (proof of the mailbox covers them all), ends all their sessions (J1) and so removes the "different password per workspace" confusion for people who reset once. The old slug-specific request keeps resetting that single workspace.
- `GET /v1/auth/slug-available?slug=` (public, rate limited) returns `{available, suggestions[]}`; used at signup while typing and by the owner's rename (J3).
- **Known limitation of Option 1:** switching workspace later from the dashboard works for as long as the selection token lives (10 minutes); after that the person logs in again. Option 2 (one global account, memberships per workspace) would remove that and the per-workspace passwords; it is a bigger refactor of login, invites, reset and verification and is not planned now.
- **Frontend:** the login page loses the slug field and gains a picker page and a "switch workspace" menu entry.
**Built (Phase 3C), as specified, with these details and the problems found while building it:**
- Routes: `POST /v1/auth/login-email {email, password}` answers `{selectionToken, expiresIn: 600, workspaces: [{tenantId, slug, name, role, available, reason?}], unmatchedCount}` and, when exactly one listed workspace is available, also `access_token` and `workspace`; `POST /v1/auth/select-workspace {selectionToken, tenantId}` answers `{access_token, workspace}`; `GET /v1/auth/slug-available?slug=` answers `{available, suggestions[]}` (30 checks a minute per address, 429). `reason` is an error code (`ACCOUNT_DISABLED`, `TENANT_SUSPENDED`, `TENANT_CLOSED`). Errors: 401 `INVALID_CREDENTIALS` (same body and time for a wrong password and an unknown email), 401 `SELECTION_TOKEN_INVALID`, 403 `WORKSPACE_NOT_SELECTABLE`, and the slug login's 403s when selecting a disabled user or a suspended workspace. `POST /v1/auth/login` is unchanged apart from the throttle.
- Selection token: `scope: "workspace-select"`, 10 minutes, signed with a secret derived from `JWT_SECRET` (its own label, like the widget token), carries `tenant_user` ids only, rejected by the staff, platform and widget checks and rejects their tokens; selection re-checks the user, the workspace and J1 (a logout or password change of that user after the token was issued ends it); it can be used again to switch to another listed workspace until it expires.
- **Problems found, and how they were solved:** (1) *bcrypt cost and timing.* Comparing every membership would make one request cost dozens of hashes and would reveal accounts by timing. Every request now runs exactly 3 comparisons in parallel (distinct password hashes first, dummy hashes to fill); memberships that share a password share a hash, so people who reset once cost one comparison however many workspaces they have; with more than 3 different passwords the newest 3 are tried and the rest count as `unmatchedCount`. Measured: 80 ms for a known and for an unknown email. (2) *Reset by email and the hash count.* The email reset gives all memberships ONE hash (one bcrypt run, same string), which is what makes (1) cheap and ends the "different password per workspace" confusion. (3) *A reset link in an old mailbox.* A reset now stores the address it was sent to and is refused if the user's email changed afterwards (it also fixed the same hole in the old single-workspace flow). (4) *Lock-out.* The throttle has no counter per email alone, only per (email, IP) and per IP, and counts failures only (see below). (5) *Suspension.* With `status` removed from the admin PATCH (J5) there was no route left to suspend a tenant: `POST /admin/tenants/:id/subscription/suspend` and `/unsuspend` were added. (6) *Logout of a suspended workspace* must work (J1). (7) *Slug races.* A signup taking a slug while its owner gives it up could end with two holders: slug claims take a transaction-level advisory lock. (8) *Empty 200.* The "latest upgrade request" answer is wrapped as `{request}` so it is never an empty body.
- **Throttling numbers** (in process memory, per instance; Redis in Phase 8): 60 login requests a minute per IP (any outcome); 5 wrong passwords per (email, IP) in 15 minutes; 30 wrong passwords per IP in 15 minutes; 429 `TOO_MANY_REQUESTS` with `Retry-After` and `retryAfterSeconds`; a correct password clears the (email, IP) count; windows are fixed, so every block ends by itself after 15 minutes; the check runs before any lookup or bcrypt, from the IP and the typed email only. Applies to `/auth/login` and `/auth/login-email`. Set `TRUST_PROXY` or every client shares the proxy's address and its ceilings.
- **Reset without a slug:** `POST /auth/password-reset/request` takes `{email}` (`tenantSlug` optional); always 202; one email, one link; confirming sets the same new hash on every membership with that email in one transaction, ends their sessions and audits `password.reset` in each workspace's own log. The allowance of 3 emails an hour per address is shared by both ways in.
- **Known limitation (unchanged from the decision):** per-workspace passwords (Option 1). A logout of workspace A does not end a selection token that was issued earlier for workspace B (10 minutes at most). **Frontend:** the login page loses the slug field and gets the picker; "switch workspace" re-uses the selection token while it lives, then asks for the password again.
Status: built (Phase 3C)

### J3. Owner self-service for the tenant (G5): BE (**decided 2026-10-11, incl. slug rename**)
**Decision (Abdul): yes, and the owner should be able to rename the slug, with an availability check or a suggestion.** `GET` and `PATCH /v1/tenants/:tenantId` (owner edits; `GET` for all roles): `name`, `defaultLocale`, `timezone` (J7) and `slug`. Slug rename rules (my proposal for the details, confirm if you disagree): the new slug must be available (same check as J2; when taken the error carries suggestions such as `acme-support-2`); a rename is audited (`tenant.slug_changed`) and limited to once per 30 days; the old slug keeps working at login for 30 days and is **reserved for 90 days** so nobody else can take over a name your users and emails still point at; widget keys are unaffected (they do not use the slug). Closing the account stays in Phase 8 with the 60-day rules.
**Built (Phase 3C):** `GET /v1/tenants/:tenantId` (every role) and `PATCH /v1/tenants/:tenantId` (owner only) with `name`, `defaultLocale` (checked against the locale registry), `timezone` (J7) and `slug`. The answer is `{id, name, slug, defaultLocale, timezone, createdAt, slugChangedAt, slugChangeAllowedAt, previousSlugs[{slug, acceptedUntil, reservedUntil}]}` (no plan or status: those are billing). Slug rename as proposed: free (409 `SLUG_TAKEN` with `suggestions` in the body, like signup), once every 30 days (409 `SLUG_CHANGE_TOO_SOON` with `nextAllowedAt`), audited `tenant.slug_changed` (before and after) and `tenant.updated` for the other fields; the old slug keeps logging in for 30 days (also for the slug password reset) and stays reserved for 90 (new table `tenant_slug_aliases`; signup, the availability check and other workspaces' renames all refuse it); the owner can take their own old slug back. `GET /v1/me` carries `tenant.slug` and `tenant.timezone`. **Frontend:** the workspace settings page can now save; the owner's slug field should use `GET /auth/slug-available` while typing and show `suggestions` from a 409.
Status: built (Phase 3C)

### J4. Role matrix rows B2 does not decide (G22): BE (**decided 2026-10-11, consent confirmed**)
**Decision (Abdul): all rows approved.** The data-use consent (I11) is the switch where the business agrees or refuses that its customers' conversations may later be used to train our own model; default off; **owner only** because it is a legal decision on behalf of the business (confirmed). Rows: billing and usage readable by owner and admin (built); approvals list for owner and admin (when action approvals exist, Phase 5); **integration settings and API-key details hidden from agents** (API keys are owner/admin already; integrations arrive in Phase 5); data-use consent owner only (built); an owner or admin cannot reply into a conversation claimed by someone else until transfer exists (H8, built); **nobody disables, demotes or deletes themselves** (the last-owner rule stays; to be built in Phase 3C).
**Built (Phase 3C):** nobody can disable, demote or delete their own account (403 `CANNOT_MODIFY_SELF`, checked before the last-owner rule, which stays for races between two owners); API-key routes were already closed to agents and are now part of a table-driven role-matrix e2e test that covers every tenant route (a new route fails it until its row is added); the data-use consent stays owner-only (in the same matrix). **Not buildable yet:** the approvals list (owner and admin) and the hidden integration settings arrive with Phase 5 and must get their row in the matrix when they do.
Status: built (Phase 3C), the Phase 5 rows follow their features

### J5. Upgrading while payments are manual (G17): BE (**decided 2026-10-11**)
**Decision (Abdul): yes.** `POST /v1/tenants/:tenantId/billing/upgrade-request {planCode, note}` (owner) creates a row in `upgrade_requests` (tenant, requested plan, note, requested by, status `pending|handled|declined`, handled by and time); platform admins list and handle requests under `/v1/admin/upgrade-requests`; a mail goes to the address in the setting `PLATFORM_ADMIN_NOTIFY_EMAIL` (set in `.env`, never written into the docs or git; in the Resend test stage mail goes to the redirect address anyway). `PATCH /v1/admin/tenants/:id` stops accepting `plan` and `status`: the subscription routes are the only way to change a plan.
**Built (Phase 3C):** `POST /v1/tenants/:tenantId/billing/upgrade-request {planCode, note?}` (owner only, verified email, 5 an hour) creates a row in `upgrade_requests` (tenant, requested plan, note, requested by, status `pending|handled|declined`, handled by and time, the admin's note); the plan must be public and different from the current one (404 `PLAN_NOT_FOUND`, 409 `ALREADY_ON_PLAN`); a second request while one is pending **replaces** the pending one (`replacedPending: true`) instead of answering 409. `GET …/billing/upgrade-request` (owner, admin) answers `{request}` with the latest one for the "request sent" banner. Platform admins: `GET /v1/admin/upgrade-requests?status=&skip=&take=` and `POST /v1/admin/upgrade-requests/:id/handle {status: handled|declined, note?}` (409 `UPGRADE_REQUEST_ALREADY_HANDLED` the second time); handling does not change the plan (use `activate` or `change-plan`), and is audited in the tenant's log as `upgrade.handled`. The mail (`upgrade-request` template, English and Urdu texts, English is sent) goes to `PLATFORM_ADMIN_NOTIFY_EMAIL` when set; the answer's `notification` says `sent | failed | skipped | not_configured` and the request is stored whatever it says. `PATCH /v1/admin/tenants/:id` answers 400 `USE_SUBSCRIPTION_ROUTES` for `plan` or `status`; **suspension is now `POST /v1/admin/tenants/:id/subscription/suspend` and `/unsuspend`**. The frontend prototype's tenant page sends `status` for the suspend button (and its `update` type still allows `plan`/`status`): it must move to the new routes.
Status: built (Phase 3C)

### J6. Conversation limit and overage (G18): BE (**decided 2026-10-10**)
**Decision (Abdul):** on plans that have an overage price (Pro: PKR 15 per extra conversation, I1) it is the tenant's choice, **on by default**. With overage **on**, the AI keeps answering after the included conversations are used up and every extra conversation is billed at the plan's price. With overage **switched off** in the settings, the limit is a **hard stop** like running out of credit: the customer gets the fallback and the conversation escalates with `limit_reached` (this is what is built today for every plan). Free and Starter have no overage price, so they always stop hard and show no setting.
**How it is built (Phase 4B, built):**
- A per-tenant billing setting `overageEnabled` (default true) on the subscription, changed by the **owner only** (audited as `billing.overage_changed`), read by everyone through `GET /v1/me` and `GET …/billing`.
- `EntitlementsService.check('conversations')` returns allowed with `overage: true` past the included amount when the setting is on and the plan has `overageConversationMinor`; otherwise it denies with `PLAN_LIMIT_REACHED` as today.
- The overage count of a period is `max(0, conversations used − included)`, derived from `usage_daily` (a conversation counts once, as before); the billing summary shows included, used, overage count and the amount in minor units.
- Invoicing while payments are manual: a platform admin sees the overage count and amount per period (admin subscription `GET`) and records one payment that includes it; the period-end invoice line is added by the admin command. A provider later bills it as metered usage (Phase 9).
- Notifications (H5, I8): 80% and 100% of the included amount, and "overage started" when it is on, "limit reached, AI stopped" when it is off.
- **Recommended, not yet decided:** an optional monthly **spending cap** for overage (owner sets a maximum extra amount; at the cap the tenant falls back to the hard stop), so a traffic spike cannot create a surprise invoice. Tokens stay internal and are not shown to tenants (cost leakage).
- The frontend needs one switch on the billing screen (owner only) with a clear warning about the extra charges.

**Built (Phase 4B):** `subscriptions.overage_enabled` (default true); `PATCH /v1/tenants/:tenantId/billing/settings` `{ "overageEnabled": boolean }` (owner only; 409 `OVERAGE_NOT_AVAILABLE` on a plan without an overage price; audited as `billing.overage_changed`). The summary in `GET /v1/me`, `GET …/billing` and the admin `GET` has `overage: { available, enabled, priceMinor, currency }` (show the switch only when `available`); `GET …/billing` and the admin `GET` also have `usage.conversations` (period, included, used, overageCount, overageAmountMinor, overagePriceMinor) and invoices carry `overageCount` / `overageAmountMinor`. `record-payment` and `activate` accept the same two optional fields (both or neither). `check('conversations')` allows past the included amount with `overage: true`; `past_due` never starts overage. The count is `max(0, used − included − conversations held for a human)`, so conversations the AI never answered (started at the limit while overage was off) are not billed. Notifications: `usage.overage_started` at 100% when overage applies, `usage.limit_reached` when the AI stops; switching the setting does not re-send anything. A change reaches other instances within 30 s.
**Phase 5A (L6):** the same switch now also governs call minutes (see L6): the plan "has the switch" when it prices extra minutes or extra conversations, and overage applies to a unit only with that unit's own price. `GET …/billing` has `usage.callMinutes` and the summary `overage.minutePriceMinor`.
**Still open (for Abdul):** the optional monthly spending cap (recommended above, not built); whether the first extra conversation or the 100% mark should trigger "overage started" (built: the 100% mark).
Status: ☐

### J7. Tenant time zone (G13, G19): BE (**decided 2026-10-11**)
**Decision (Abdul): yes.** `tenants.timezone` (IANA name), default `Asia/Karachi`, set by the owner through J3. Working hours (agent config, Phase 5), the audit display and reminder wording use it; stored timestamps stay UTC.
**Built (Phase 3C):** `tenants.timezone` (text, `NOT NULL DEFAULT 'Asia/Karachi'`; existing tenants got the default), set by the owner through `PATCH /v1/tenants/:tenantId`, validated as an IANA name against the runtime's tz database (case-insensitive input, stored canonical; offsets such as `+05:00` are refused), shown in `GET /v1/tenants/:tenantId` and `GET /v1/me`. Nothing else uses it yet (working hours arrive with agent config in Phase 5).
Status: built (Phase 3C)

### J8. Frontend translation keys (G21): BE + FE (**deferred by Abdul 2026-10-11; he asked for the two options to be explained, option A (backend serves everything) or B (backend serves only what it produces) is still to be chosen**)
The frontend needed 624 keys the backend files do not have (41% have Urdu, written by an AI).
**Proposal:** move them into the backend files as a new `app` namespace (flat dot keys, same format), add the 13 missing `errors.*` and `widget.human.label`, offer `GET /v1/i18n/:locale` returning all namespaces with one ETag, then get a native Urdu review. Prototype-only keys (`app.dev.*`, `app.mock.*`) stay in the frontend.
Status: ☐

### J9. Questions for the AI engine owner (Abdullah): AI
Everything the backend knows about the engine is *our proposal* in [contracts/engine-internal.openapi.yaml](contracts/engine-internal.openapi.yaml); the backend has never run against the real engine. Please confirm or change:
1. Create-conversation and send-message calls and the streamed reply format (SSE events).
2. Two additions not yet in Appendix A: `POST /internal/conversations/:id/escalate {reason, summary?}` and `aiReply: false` on the message call (store the message, generate no reply: used when a tenant hits its plan limit).
3. Request headers: service token (`Authorization: Bearer`), `X-Tenant-Id`, `X-Request-Id`, `Idempotency-Key`.
4. Conversation and message response shapes for the dashboard (G7), including who resolves the assignee's name, and the error codes for already-claimed, resolved and wrong-assignee conversations.
5. Event names and payloads the engine sends back (`conversation.escalated`, `usage.recorded`, `ingestion.*`, `action.proposed`, …), signed as in D5 (G6).
6. `end_customer_id` on conversations (B5) and the other column requests in C1, C2, C5.
7. Agent-config schema (G13) and knowledge-base limits, status values and failure codes (G14).
**All of J9, the contract questions and the columns and later-phase items are now collected, de-duplicated and renumbered Q1 to Q27 in [for-abdullah.md](for-abdullah.md): send him that file (plus the three files in `contracts/`), not this one.** The Phase 4 questions are numbered 6 to 11 under "Open questions for the AI engine owner (Phase 4)" in [contracts/README.md](contracts/README.md): the staff calls and their 409 codes, the extra conversation fields and `X-Acting-*` headers, the system lines, the event receiver with its HMAC signing, and silence while `human_active`. Items 4 and 5 above are now concrete proposals in `contracts/engine-internal.openapi.yaml` and `contracts/backend-events.openapi.yaml`.
Status: ☐

## L. Product direction: voice-first (decided 2026-10-21)

Context: Abdullah's two documents (section M) describe the engine as an AI receptionist whose main channel is the **telephone**; text chat is an internal test surface and he deleted his own browser widget on purpose. Abdul decided on 2026-10-21 to follow that direction.

### L1. The product is voice-first: BE + AI (**decided 2026-10-21**)
The platform's main product is an AI agent that answers a business's phone calls from the business's own material and takes appointment and call-back **requests** that staff confirm. Text chat stays possible but is secondary. Engine rule that never changes: the AI never books, confirms or cancels anything on its own authority; it saves a request as `requested` and a person confirms it.
Status: decided

### L2. Message operations are halted: BE (**decided 2026-10-21**)
**Decision (Abdul): halt the message operations for now.** Everything already built keeps working and nothing is removed, but there is **no new work** on: the chat widget gateway, widget API keys and the widget live stream (Phase 3); the staff chat queue with claim, reply, release and resolve and its notifications (Phase 4); widget key rotation (K7); widget wording from settings (K8); WhatsApp; chat-conversation limits. They move to the deferred list (Phase 7). The widget stays useful for demos and tests.
Status: decided

### L3. Dropped from Phase 5: BE (**decided 2026-10-21**)
**Tenant integration secrets (K3, E4) and risky-action approvals (K4, E4; for-abdullah Q23) are dropped for now.** The engine executes no actions (its flag `TOOL_EXECUTION_AVAILABLE` is false) and Abdullah's decided approach (his B6) is that each side keeps its own secrets: only the internal key and the event-signing secret are shared. Revisit both when real tool execution exists. E4 and Q23 are superseded by this decision.
Status: decided

### L4. New backend priorities, in order: BE (**decided 2026-10-21**; the engine side of each needs Abdullah's confirmation, section M)
1. **Tenant status check (his B1).** `GET /internal/tenants/{tenantId}/status` returns `{tenantId, serviceable, reason, plan}` with `reason` one of `suspended`, `unpaid`, `quota_exceeded`, `unknown_tenant` or null; derived from the effective subscription and entitlements; the engine caches it about 60 seconds and answers its own caller 403, 429 or 404 accordingly.
2. **Requests workflow (his B4).** Tables for requests (appointment or call-back; reference unique per tenant; status `requested`, `confirmed`, `done`, `cancelled`; data validated by the engine; summary; scheduled time kept as the business's wall-clock string; idempotent creation by `(tenant, submissionKey)`). Internal routes the engine calls: create (201, or 200 for a repeated key), update details, withdraw, and customer upsert by phone. Rules: the engine may change a request only while it is `requested` (otherwise 409 `locked`); status moves `requested → confirmed | cancelled`, `confirmed → done | cancelled | requested`, `done → confirmed`, `cancelled → requested`, with a conditional update on the status that was read. A staff API and screen under `/v1/tenants/:tenantId/requests` (list with filters, detail, change status), audit entries, and notifications from the engine's `record.submitted` and `record.updated` events.
3. **Phone numbers and call tickets (his B11, our Q26).** A table mapping each dialled number (E.164) to a tenant; a platform-admin way to assign a number (purchase and porting come later); `GET /internal/numbers/{e164}` returns the tenant; the Twilio webhook signature is verified, then the backend signs a short-lived single-use ticket so the telephone provider connects straight to the engine's voice gateway (which needs a public secure WebSocket endpoint). The backend keeps the Twilio account keys. The end customer is created from the caller's number.
4. **Call usage and billing (his B8).** Agree the usage-event shape with Abdullah, add **call minutes** to the plan entitlements and `usage_daily`, a usage endpoint for owners (conversations, messages, call minutes; no token counts, K5), and a call-history view.
5. **Agent settings and knowledge (his B2, B3, B5).** Settings ownership is decided (L7: the backend owns them, the engine pulls them at call start). Knowledge: the backend keeps the original uploaded file in its own storage, enforces plan limits and file types, forwards the file to the engine by multipart upload, and follows the ingestion job's progress.
Status: decided (order and scope); items 1 and 2 (status check, requests) are BUILT in Phase 5B-2 against the mock engine and the draft contract; details open with Abdullah

### L5. Questions this direction opens: BE + AI
- Who sends the confirmation to the customer when staff confirm a request (his B9)? Proposal: the backend, triggered by its own `confirmed` transition (it holds the number, the provider account and the billing); the channel is SMS only because WhatsApp is deferred. Open.
- Calendar availability (his B10): later, the engine checks opening hours only today.
- Call recording consent and calling-hours rules (F2): legal wording needed before real customers.
- What "hand over to a human" means on a phone call: his `escalation` setting holds an email and phone number; the chat-style claim and reply of Phase 4 does not apply to a live call.
- WhatsApp is out of scope for now (Abdul, 2026-10-21).
Status: open

### L6. Plans include call minutes: BE (**decided 2026-10-21; numbers are placeholders**)
**Decision (Abdul): Starter and Free include call minutes.** All plans get voice turned on. New entitlement keys `callMinutesPerPeriod`, `callMinutePeriod` (`total` or `month`) and `overageMinuteMinor`. **Placeholder numbers (adjustable as data in the `plans` table, to be confirmed against real call costs once calls exist):** Starter 30 minutes in total (15 days), Free 20 minutes a month, Pro 300 minutes a month with overage PKR 25 a minute (the price already in the plan), Enterprise custom. The owner's overage switch (J6, default on, owner can switch off for a hard stop) is proposed to apply to call minutes on plans with an overage price; the conversation overage stays as built for chat. The prices in I1 were set for chat and must be revisited once call costs are measured. Built in Phase 5A.
**Built (Phase 5A, branch `phase-5a-alignment`):** entitlement keys, data migration (placeholders), the owner's switch for minutes, `usage.callMinutes` in the billing summary, the three minute reminders, `GET /v1/plans` with minutes and the price per extra minute, and the **plan numbers and Pro prices from environment variables** (Abdul's instruction for this phase). Decisions Phase 5A took that the text above did not settle: (1) one switch for both units (a plan has it when it prices either); (2) `past_due` is served within the allowance, never into overage, like chat; (3) minutes served past the allowance are counted as overage even if the owner turned overage off, because a call that is already running is not cut off; (4) the invoice keeps its single overage count/amount pair from the chat era, so the minute overage amount is typed into it by the admin and the count is ambiguous (**decided 2026-10-28 by Abdul: the invoice gets its own minute fields, `overage_minutes` and `overage_minutes_amount_minor`, built in 5E**; also decided: `GET /v1/me` carries a price-free call-minute summary for every role, frontend gap N51, built in 5E); (5) how the engine's seconds become billed minutes (proposal: round each call up to the whole minute) is decided in 5E; (6) Enterprise has unlimited minutes (null).
Status: built (placeholders); the minutes-overage proposal and the Pro numbers are for Abdul to confirm

### L7. Agents and phone numbers: BE + AI (**decided 2026-10-28; settings, delivery, routing and plan rules confirmed the same day**)
**The model (Abdul):** there is **one engine**, one shared brain, and it answers every call. An **agent** is the tenant's own setup that the brain uses for a call: its knowledge, hours, greeting, voice, language, what it collects, and who it forwards calls to. ("Agent" means the **tenant's agent**, not a separate AI: the AI is always the one engine.) **A tenant can have many agents and many phone numbers. Each number is linked to exactly one agent, and one agent can have many numbers.** Minutes and billing stay pooled per tenant.
**Decisions:**
- **The backend owns each agent's settings and the engine PULLS them at the start of every call (decided).** This settles Q21 in favour of Abdullah's handoff duties B2 and B3: the backend stores and versions the settings; the engine keeps no per-agent copy (a short cache keyed by version only). The call ticket carries only the tenant id, the agent id and the settings version; the engine fetches `GET /internal/tenants/{tenantId}/agents/{agentId}/config` at call start (cached up to 60 s). Reason: the settings contain forwarding phone numbers, which must not travel through the telephone provider's servers or logs. If the backend is briefly unreachable the engine may serve from the copy it holds for that version.
- **Knowledge cannot travel with a call:** documents are turned into searchable vectors once. So the knowledge stays in the engine, but is stored and searched **per agent** (`agent_id` on knowledge sources and chunks; retrieval filters by tenant and agent). Call logs and requests carry `agent_id` too.
- **The list of settings fields is the engine's** (business name, purpose, tone, timezone, UI language, reply language, hours, forwarding contacts, abilities, voices, and the "what the agent collects" checklist with its catalogue and validation). The backend stores the document as JSON, does not hard-code the checklist fields, and validates on save through the engine's validation (to agree with Abdullah).
- **Launch with one default agent per tenant**, created in the signup transaction (and backfilled for existing tenants), so the product works as before; more agents are a screen and a plan limit. Every route, ticket, request, event and call log carries `agentId` from day one.
- **Naming (decided):** "agent" means the tenant's agent. The staff role `agent` (owner, admin, agent) is **not renamed**; screens and the API keep the two apart by context (the Agents menu against the role label).
- **Who owns what:** the backend owns the agent's identity (`agents` table: id, tenant, name, status `active` or `disabled`, default flag), its settings and the number-to-agent link; the engine owns the brain, the knowledge index, call logs and the conversation.
- **Plan limits and numbers (decided):** new entitlement keys `agents` and `phoneNumbers`, set from the same environment-variable mechanism as the minutes. **Placeholders: Starter 1 agent and 0 numbers, Free 1 and 0, Pro 3 and 5, Enterprise custom.** **Free and Starter make browser test calls only; real phone numbers are for Pro and Enterprise**, and the rental of a number is included in the plan up to its limit. Test calls use the tenant's call minutes. Open: the price of numbers beyond a plan's limit (an add-on, later).
- **Edge cases:** a number with no agent, a disabled agent, a suspended tenant or no minutes left: the caller hears a short translated message and no minutes are billed.
**What the engine must change (to be confirmed by Abdullah, Q28):** read the settings from the backend at call start (his `getAgentConfig()` seam already exists) instead of from its own table; knowledge sources, chunks, call logs, conversations and requests carry `agent_id`; retrieval filters by agent as well as tenant; routes accept `X-Agent-Id`; events carry `agentId`.
**Built (Phase 5B-1, branch `phase-5b1-agents`):** tables `agents` and `agent_settings` (versions, append-only), staff routes `/v1/tenants/:tenantId/agents` (every role reads name and status; owner and admin create, rename, disable, delete and edit the settings), a default agent for every tenant (signup, and a data migration for the 100 tenants of the local database), the entitlement keys `agents` and `phoneNumbers` (Starter 1/0, Free 1/0, Pro 3/5, Enterprise unlimited; `PLAN_{STARTER,FREE,PRO}_AGENTS` and `PLAN_{STARTER,FREE,PRO}_PHONE_NUMBERS`), and **the engine's pull route** `GET /internal/tenants/{tenantId}/agents/{agentId}/config` (service token, `?version=`, ETag/304, 60 s cache, a disabled agent answers `status: "disabled"`). The backend validates only the STRUCTURE of the settings on save (`AgentSettingsValidator`); `collect`, `capabilities` and the voice ids are stored as they are, because the field list and the deeper validation are the engine's. Decisions taken that this text did not settle: names are unique per tenant ignoring case; a new agent's `businessName` is the tenant's name; a settings save is a top-level patch with a required `expectedVersion`; deleting an agent is a hard delete; the default agent can be disabled but not deleted; an agent with phone numbers cannot be disabled or deleted (the check answers "no numbers" until Phase 5D). Details: [backend-roadmap.md](backend-roadmap.md) Phase 5B-1.
**Decisions of 2026-10-29 (Abdul, taken while building Phase 5B-2; built):** (1) `expectedVersion` stays **required** on `PUT …/agents/:agentId/settings`. (2) The **default agent may be disabled** (it still cannot be deleted); the status check then answers `agent_disabled` for it. (3) An agent that has **requests cannot be deleted**: 409 `AGENT_HAS_REQUESTS` (translated en and ur), through the injectable `AgentRequestsCheck` like `AGENT_HAS_NUMBERS`; the agent can be disabled instead and its requests stay on the staff screen. Consequence: `requests.agent_id` is a RESTRICT foreign key (composite with the tenant), so a request saved at the very moment of a delete still blocks it (the service maps the foreign-key error to the same code).
Open for Abdullah (unchanged, Q28): is the engine agent-aware (`agent_id` on knowledge, calls and requests, `X-Agent-Id`, `agentId` in events, a nullable `agent_id` meaning the default agent meanwhile)? Will it offer the validation route the settings save could call? Which of the document's fields does it really read (the contract file lists the ones from `agent_configs`)?
Status: decided (Abdul); built in Phase 5B-1; the engine side is to be confirmed by Abdullah

### L8. Twilio routing: BE + AI (**decided 2026-10-28: the backend first; Abdullah to confirm**)
The call comes to the number, the number belongs to an agent, the call is sent to the engine, and the engine answers by that agent's settings. **Decided (Abdul): the backend receives the telephone provider's call webhook first** ("Design B"). The backend receives it on a public HTTPS address, verifies the signature, looks up number to (tenant, agent), checks the tenant and the agent may be served (plan, suspended, minutes left, agent active), and answers the provider with instructions to connect the audio to the engine's voice gateway with a **one-minute single-use ticket that carries the tenant id, the agent id and the settings version**. The gateway verifies the ticket as it does today for browser calls, then pulls the settings (L7). The backend keeps the Twilio account credentials. Abdullah's code and handoff describe the opposite design (the engine verifies the signature and asks us for the lookup); his reply already agreed to ours.
Still to settle with him:
- **Call forwarding needs Twilio access** (to redirect a live call to a person). Options: a separate revocable Twilio API key for the engine, used only for transfers, or the engine asks the backend to place the transfer.
- **Dashboard test call:** a staff-authenticated route that issues a ticket for a chosen agent, so an owner can test an agent in the browser without a phone number (his console does this today). It is the **only** call path for Free and Starter tenants (L7). The voice gateway needs a public secure WebSocket address.
Status: decided on our side; Abdullah to confirm and to settle the transfer access

### L9. Workflow check, end to end (2026-10-28, updated with the decisions of the same day)
| # | Step | Who | State today | Gap or decision |
|---|---|---|---|---|
| 1 | A business signs up (tenant, owner, verification, 15-day Starter) | backend | built (Phases 0 to 3C); **the default agent is created in the signup transaction and existing tenants are backfilled (5B-1, built)** | - |
| 2 | The owner edits an agent: name, purpose, tone, language, voice, hours, greeting, checklist, forwarding contacts | **backend stores and versions the settings** (L7); the engine pulls them at call start | the engine has one setting per tenant in its own table | engine reads from the backend (Q28); **backend settings document, versions and config route built (5B-1)**; editing screens (5F) |
| 3 | The owner adds knowledge to an agent | backend keeps the original, engine embeds per agent | engine uploads per tenant; Cloudinary optional | per agent (Q28); storage provider open; real size limit (5F) |
| 4 | A Pro or Enterprise business gets numbers and links each to one agent; Free and Starter have no numbers | backend (platform admin first, purchase later) | nothing | `phone_numbers` with an agent link and the plan limit (5D); extra-number pricing open (Phase 6) |
| 5 | A call arrives: provider, **backend first** (signature, number, tenant and agent, checks, ticket), engine gateway, settings pulled | backend then engine | only browser tickets exist | public webhook and secure WebSocket; spoken message for unassigned, disabled or blocked; provider fallback if the backend is down (5D) |
| 6 | The engine answers by the agent's settings and knowledge; may forward the call to a person | engine | built for browser calls; transfer simulated | Twilio access for transfers (L8); recording consent (Phase 6) |
| 7 | A request is taken, saved in the backend, staff notified, staff confirm or cancel, customer told | engine, backend | the engine has stand-ins; **the backend has the table, the engine's routes, the staff API, the notification and the live update (5B-2, built against the mock engine; Abdullah has confirmed none of it)** | the engine must call our routes instead of its stand-ins (Q28 to Q31); SMS sender open (Phase 6) |
| 8 | Before a call: may this business and agent be served? After it the minutes are reported, counted, limited, billed | engine asks and reports, backend answers and counts | **the status check is built (5B-2: suspended, minutes with overage, past due, agent disabled, unknown tenant or agent)**; counting built (5A); no usage event yet | event shape; each call rounded up to whole minutes (proposal); per agent breakdown (5E) |
| 9 | Staff review requests, call history, usage per agent and per number | backend screens, engine logs | nothing | roles for transcripts (personal data); 5E and 5F |
| 10 | Billing: plan, minutes, agents, numbers; manual payments; invoices | backend | built; **the agents limit is enforced and `phoneNumbers` exists as a key (5B-1, built)**; numbers are counted from 5D | the number limit is enforced when numbers exist (5D) |
| 11 | The platform admin manages tenants, numbers, subscriptions | backend | built except numbers | admin number screens (5D) |
| 12 | A Free or Starter owner (and any owner) tests an agent in the browser | backend ticket, public gateway | the engine console does it | the staff test-call route (5D), counted in the tenant's minutes |
| 13 | Retention purge, erasure per agent or tenant, monitoring | both | not built | Phase 8; the engine has no scheduler |
**Still open after the decisions of 2026-10-28:** (a) the engine's confirmation of Q28 and Q29 and the Twilio access for transfers; (b) the price of numbers beyond a plan's limit; (c) the storage provider for knowledge originals; (d) who sends the confirmation SMS; (e) who may read transcripts; (f) ~~the `agentId` on every draft contract~~ (done in 5B-1).
Status: findings recorded; the phases below close them

---

## M. Abdullah's answers (reply of 2026-10-15 and handoff of about 2026-10-21)

Two files from Abdullah (engine commit `bea913b` for the reply): `reply-to-abdul-haseeb.md` (answers to Q1 to Q27) and `handoff-to-backend.md` (his view of who owns what, duties B1 to B12). **None of the contract is implemented in the engine yet**; he will not start the first three build steps until Q1 to Q5 are settled and tested on a throwaway database. Where the two files disagree, the handoff is newer (it mentions a migration dated 2026-10-20) and wins.

### M1. His answers
| Q | Answer | What changes for us |
|---|---|---|
| Q1, Q2, Q5 | Agree | He will test the two-migration-history scenario on a throwaway database before anyone migrates |
| Q3 | Agree, with a change | Create the `vector` extension **in schema `ai_engine`** (`CREATE EXTENSION IF NOT EXISTS vector SCHEMA ai_engine`), not in `public`; A3's init script must be changed |
| Q4 | Agree, with changes | `tenants.id` must be `text`; the foreign key covers **every** table with `tenant_id` (not five); separate raw-SQL migration after our table exists; his test scripts need real tenant rows |
| Q6, Q7 | Agree, with changes | New `/internal/*` routes; his base URL is port 3000 (ours is also 3000); streaming adapter; token counts and an idempotency table to build; 2,000 characters on the new routes |
| Q8, Q9 | Agree | `escalate`, `aiReply: false`, atomic claim with the 409 codes |
| Q10 | Agree for new routes, change for old | New routes: Bearer `INTERNAL_API_TOKEN` plus `X-Tenant-Id`. Old `/api/*` routes use `?tenantId=` and `x-internal-key`; he converts only those our backend calls |
| Q11 | Agree, with a technical limit | Tokens already streamed cannot be recalled; no AI message is stored or counted after a claim |
| Q12 | Agree, one column added | `content_key` on messages |
| Q13 | Partly | First: `customer_requested`, `outside_hours`, `ai_unavailable`, `limit_reached`. Later after evaluation: `low_confidence`, `sentiment`, `topic`, `failed_action` |
| Q14 | **Change** | First-token timeout default **10 s** until a faster model (free-tier Gemini takes 3.5 to 10 s; Groq about 1 s); 30 s total is fine |
| Q15 to Q17 | Agree | Signed events from a database outbox, retries with the same id |
| Q18 to Q20 | Agree | Plus `provider` and `content_key` on messages |
| Q21 | **Change** | Agent configuration stays **in his schema**; plan-derived values come from us (hybrid). The newer handoff says the backend stores and versions it: unresolved |
| Q22 | Agree, with changes | His own `source_id` stays; ours goes into `external_source_id`; replacement keyed by source id; stable failure codes; asks which storage |
| Q23 | Agree in principle | No actions exist; **superseded by L3** |
| Q24 | Agree, open point | The engine has no scheduler: someone must call a purge route daily |
| Q25 | Agree | No training export; hosted model providers' free tiers may use submitted content, so production needs paid no-training terms |
| Q26 | Agree for voice | Backend verifies the Twilio signature, maps the number, signs a ticket; the voice gateway needs a public secure WebSocket. WhatsApp is not planned on his side |
| Q27 | Agree | Embeddings are Gemini-only, 768 dimensions, not swappable |

### M2. Where our plan and his documents conflict
1. **Product shape.** Ours was chat support with human takeover; his is a phone receptionist taking requests (resolved by L1).
2. **Who owns the agent settings** (Q21 against his B2): decided 2026-10-28 (L7): the backend owns and versions them, the engine pulls them at call start.
3. **Integration secrets and risky actions** (resolved by L3).
4. **Events.** His real events today are `record.submitted` and `record.updated`; our receiver expects `conversation.*`, `message.created`, `usage.recorded`, `action.proposed`. To reconcile. **Phase 5A:** the receiver acknowledged `record.submitted`, `record.updated` and (proposed) `usage.call_minutes`; **Phase 5B-2:** `record.submitted` and `record.updated` are now HANDLED (they never create or change a request, the engine's calls to our routes do; the event makes sure the team was notified, once-only) and only `usage.call_minutes` is still acknowledged until Phase 5E; the chat events stay; `action.proposed` is marked unused (L3). Payload fields of the three are PROPOSED in `backend-events.openapi.yaml` (ids and the reference only) and wait for Abdullah.
5. **Names and numbers:** his `x-internal-key` and `INTERNAL_API_KEY` against our Bearer `INTERNAL_API_TOKEN`; both services default to port 3000; first-token timeout 10 s against our 5 s. **Phase 5A:** the timeout default is now 10 s; the port clash and the two header styles are documented (README, docs/contracts/README.md) and the backend sends only the Bearer form.
6. **Files.** His handoff: the backend stores the original and forwards it by multipart. His reply asked about a storage key. Resolution proposed: multipart, no `storageKey`.
7. **Small inconsistencies in his documents:** unit-test counts (327 against 446) and languages (the reply still mentions Italian; the handoff says only English and Urdu). The handoff is newer.
8. **Added by Phase 5B-2 (2026-10-29), all waiting for Abdullah (for-abdullah Q30 d to g):** (a) **Error shape:** his errors are `{error}`, ours `{statusCode, code, message}`; the internal routes follow ours (his `locked` is 409 `REQUEST_LOCKED`, his `reference_taken` is 409 `REQUEST_REFERENCE_TAKEN`). (b) **Reference collisions:** he draws the reference, we keep it unique per tenant and answer 409 so he draws another and repeats with the same `submissionKey`. (c) **Source of truth for a request:** the engine's calls to our routes, not the `record.*` events (his handoff left "details in the event?" open). (d) **Status check:** two reasons and one field of ours (`agent_disabled`, `unknown_agent`, `overage`), and an answer cache of at most 10 s instead of about 60. (e) **Ids:** `recordId` in his events is the id our create call returns, and the caller's end customer is created by us (`PUT …/customers/by-phone`), not by his `customers` stand-in.

### M3. His questions back to us (status: open; recommended answers, not yet sent to him)
1. **`tenant_core.tenants.id` type:** `text` (a UUID stored as text). Fact, no decision needed.
2. **Which old `/api/*` routes will the backend call:** proposal: knowledge (upload, list, delete, retry, job progress) and, depending on Q21, agent settings and the collect checklist. Open until the scope is final.
3. **Object storage for knowledge originals:** Abdul to decide the provider (the backend keeps the originals); the engine receives the file by multipart.
4. **Q21 hybrid:** settled on the backend side by L7 (2026-10-28): the backend owns and versions the agent settings and the engine receives them at the start of each call; Abdullah to confirm.
5. **10 s first-token timeout:** recommended yes (the backend's `ENGINE_FIRST_TOKEN_TIMEOUT_MS` default changes to 10000). **Done in Phase 5A** (still to be told to him as part of the answers).
6. **Who triggers the daily retention purge:** recommended the backend, from its hourly job, calling his purge route once a day.
7. **Who creates end customers for voice callers:** the backend, from the caller's number (L4.3).
8. **"Zero late tokens" guarantee in the claim race:** recommended no; it matters for streamed chat, not for phone calls.
Status: open

### M4. What Phase 5A did with Abdullah's answers (2026-10-21)
- **Contracts updated:** `engine-internal.openapi.yaml` records what he agreed in M1 (message fields `contentKey`, `provider`, token counts and latency; the idempotent claim answers 200; 10 s to the first token; 2,000 characters; `conversation.released.to` only `active` or `escalated`) and marks what is still a proposal; `backend-events.openapi.yaml` lists the voice-first events; the NEW `backend-internal.openapi.yaml` drafts the routes he will call on us (status check, requests create/update/withdraw, customer upsert by phone, number lookup). **He has not seen the draft and none of it is implemented on either side.**
- **Questions the draft adds for him** (top of `backend-internal.openapi.yaml`): which `reason` a tenant without voice or with an overdue payment gets (`unpaid` is reserved); whether a status cached for about 60 s may overshoot the minute allowance a little; the request body and whether `record.submitted` should carry details; the caller's number as the end customer's identity (F1); who calls the daily retention purge.
- **Still open for Abdul** (after the decisions of 2026-10-28): the storage provider for knowledge originals, who sends the SMS confirmation (L5), the price of numbers beyond a plan's limit, the overage spending cap, tax wording and the legal review of training data.
Status: contracts written, waiting for him

---

## Appendix A: Proposed engine internal API (called by the backend)

**Phase 3 wrote the subset the gateway uses as an OpenAPI file: [contracts/engine-internal.openapi.yaml](contracts/engine-internal.openapi.yaml)** (create conversation, get conversation with messages, send a message with the streamed reply, health) and added two things to it that this table does not have yet, for the AI owner to confirm: `POST /internal/conversations/:id/escalate` `{ reason, summary? }` (the backend tells the engine to escalate without calling the model: `limit_reached`, `ai_unavailable`) and `aiReply: false` on the message call (store a message, generate no reply). The rest of the table (human messages, claim, release, knowledge, actions, erasure) is unchanged and not yet in the file.

All calls carry `Authorization`, `X-Tenant-Id`, `X-Request-Id` (D2) and, for commands, `Idempotency-Key`; staff calls also carry `X-Acting-User-Id` and `X-Acting-Role`.

**Phase 4 wrote the staff side into the contract file** (all marked "proposed addition", none confirmed by the AI side): `GET /internal/conversations` (list with `status`, `assignedUserId`, `endCustomerId`, `sort=escalatedAt`, paging), `GET /internal/conversation-counts`, `claim`, `release` (with `escalated` and `force`), `resolve` and `human-messages`, and the conversation fields `assignedUserId`, `escalatedAt`, `summary`, `resolvedAt`, `resolvedBy`.

| Method and path | Purpose |
|---|---|
| `POST /internal/conversations` | `{ channel, endCustomerId }` → conversation |
| `GET /internal/conversations/:id` | detail with messages (paginated) |
| `POST /internal/conversations/:id/messages` | customer message → stored, AI reply **streamed** (SSE) if `active` |
| `POST /internal/conversations/:id/human-messages` | `{ userId, content }` → stored as `author_type=human` |
| `POST /internal/conversations/:id/claim` | `{ userId }` → 200 / 409 |
| `POST /internal/conversations/:id/release` | `{ userId, to: "active" \| "escalated" \| "resolved", force?, reason? }` (`force` only for a holder who was disabled or deleted) |
| `POST /internal/knowledge/ingest` | `{ sourceId, storageKey, type }` |
| `DELETE /internal/knowledge/:sourceId` | remove chunks |
| `POST /internal/actions/:id/approve` and `/reject` | `{ userId }` |
| `DELETE /internal/customers/:endCustomerId/data` | erasure (F1) |
| `DELETE /internal/tenants/:id/data` | offboarding (§5.6) |
| `GET /health` | liveness |

Engine → backend: `POST /internal/events` (D5; **built in Phase 4**, contract in [contracts/backend-events.openapi.yaml](contracts/backend-events.openapi.yaml)), `GET /internal/tenants/:id/agent-config`, `GET /internal/tenants/:id/integrations/:kind` (E4: superseded by L3, not to be built). **Voice-first (2026-10-21):** the routes the engine calls to ask or command the backend (tenant status check, requests, customer upsert by phone, number lookup) are the DRAFT [contracts/backend-internal.openapi.yaml](contracts/backend-internal.openapi.yaml), built in Phases 5B and 5D.

## Appendix B: Proposed backend public API for FE (`/v1`)

| Area | Routes |
|---|---|
| Auth | `POST /auth/signup`, `POST /auth/login`, `GET/PATCH /me` (built), `POST /auth/verify-email`, `POST /auth/verify-email/resend` (H4, built); **built (Phase 3C):** `POST /auth/logout` (J1), `POST /auth/login-email`, `POST /auth/select-workspace`, `GET /auth/slug-available` (J2) |
| Tenant | **Built (Phase 3C):** `GET /tenants/:tenantId` (all roles), `PATCH /tenants/:tenantId` (owner: name, defaultLocale, timezone, slug; J3, J7); usage: `GET /tenants/:tenantId/usage` (Phase 5) |
| Users | `GET /tenants/:tenantId/users`, `GET/PATCH/DELETE …/users/:id` (no create: invites, H1) |
| Customers | CRUD `/tenants/:tenantId/customers`; **built (Phase 4):** `GET …/customers/:id/conversations` |
| Conversations | **Built (Phase 4):** `GET /tenants/:tenantId/conversations?status=&assignedTo=&customerId=&sort=`, `GET …/counts`, `GET …/:id` (messages paginated), `POST …/:id/claim`, `…/release`, `…/resolve`, `…/messages`; the customer view is `GET …/customers/:id/conversations` |
| Actions | `GET …/actions?status=proposed`, `POST …/actions/:id/approve`, `POST …/actions/:id/reject` |
| Knowledge | `POST …/knowledge` (upload), `GET …/knowledge`, `DELETE …/knowledge/:id` |
| Agent config | `GET/PUT /tenants/:tenantId/agent-config` |
| Integrations | `PUT/DELETE /tenants/:tenantId/integrations/:kind` (write-only secrets) |
| API keys | **Built (Phase 3):** `POST`, `GET`, `GET :id`, `PATCH :id` (name, origins), `DELETE :id` (revoke) on `/tenants/:tenantId/api-keys`; rotation is Phase 5 |
| Realtime | **Built (Phase 4):** `GET /tenants/:tenantId/events` (SSE; Bearer header or `?ticket=`), `POST …/events/ticket`; the customer side is `GET /widget/events` |
| Widget | **Built (Phase 3):** `POST /widget/sessions`, `POST /widget/messages` (answers `text/event-stream`; there is no separate stream route), `GET /widget/conversation` |
| Platform admin | `/admin/auth/login`, `/admin/auth/logout` (J1), `/admin/tenants…`, **built (Phase 3C):** `/admin/upgrade-requests` (list) and `/admin/upgrade-requests/:id/handle` (J5), `/admin/tenants/:id/subscription/suspend` and `/unsuspend` |
| Invites | `POST/GET /tenants/:tenantId/invites`, `DELETE …/:id`, `POST /auth/invites/accept` (H1); **built (Phase 3B):** `GET /auth/invites/preview?token=` |
| Password reset | `POST /auth/password-reset/request` (`{email}`, slug optional since Phase 3C), `POST /auth/password-reset/confirm` (H2, J2) |
| Notifications | **Built (Phase 4):** `GET /tenants/:tenantId/notifications` (`?unread=true`), `POST …/:id/read`, `POST …/read-all` (H5); unread count in `GET /me` |
| Audit log | `GET /tenants/:tenantId/audit-logs` (H6) |
| Billing | `GET /plans` (public), `GET /tenants/:tenantId/billing` (owner/admin), `GET/PUT /tenants/:tenantId/data-use` (owner), `/admin/tenants/:id/subscription` + `activate`, `record-payment`, `extend`, `change-plan`, `cancel` (I1-I6, I11; built in Phase 2B); **built (Phase 3C):** `POST/GET /tenants/:tenantId/billing/upgrade-request` (J5), `…/subscription/suspend` and `/unsuspend` |
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
J0 ☐  J1 ☐  J2 ☐  J3 ☐  J4 ☐  J5 ☐  J6 ☐  J7 ☐  J8 ☐  J9 ☐
```
Blocking items for the next sprint: **A1, A2, A5, B5, C1, C2, D1, D2**.
