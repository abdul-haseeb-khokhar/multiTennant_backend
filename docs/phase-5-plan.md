# Phase 5 plan: voice-first backend core

Status: **reshaped 2026-10-21, nothing built.** Owner: Abdul Haseeb. This replaces the first version of this file (2026-10-14), which assumed a chat product with integration secrets and action approvals. Sources: [team-alignment.md](team-alignment.md) sections L (the decision) and M (Abdullah's answers), [backend-roadmap.md](backend-roadmap.md) Phase 5, and Abdullah's two files `reply-to-abdul-haseeb.md` and `handoff-to-backend.md`.

## 1. What changed and why

Abdullah's engine is an AI **phone receptionist**: it answers calls from the business's own material and **takes appointment and call-back requests that staff confirm**. It never books, confirms or cancels anything itself and it executes no actions. On 2026-10-21 Abdul decided:

- the product is voice-first (L1); text chat stays secondary;
- the widget (Phase 3) is frozen: no new work (L2);
- tenant integration secrets and risky-action approvals are dropped (L3);
- the next backend priorities are the tenant status check, the requests workflow and phone numbers (L4).

## 2. Order of work (one session per block is fine)

| Block | Scope | Needs from Abdullah |
|---|---|---|
| 5a | Tenant status check: `GET /internal/tenants/{tenantId}/status` | answer to M3.5 (timeout) only |
| 5b | Requests workflow: tables, internal routes, staff API and screen, audit, notifications, `record.*` event receiver | confirm the request shape and the event names (M2.4) |
| 5c | Phone numbers: number to tenant table, `GET /internal/numbers/{e164}`, Twilio signature check, call ticket, end customer from the caller number | the ticket design (Q26), the voice gateway's public endpoint |
| 5d | Call usage and billing: usage-event shape, call minutes in entitlements and `usage_daily`, owner usage endpoint, call history | the usage-event shape (his B8) |
| 5e | Agent settings and knowledge | **the ownership decision (M3.4)** and the storage choice (M3.3) |

Do 5a to 5d first; 5e waits for the decisions below.

## 3. Block details

**5a Tenant status check (his B1).** Returns `{tenantId, serviceable, reason, plan}`. `reason` is `suspended`, `unpaid`, `quota_exceeded`, `unknown_tenant` or null. Derived from the effective subscription and the entitlements (suspended or closed tenant, `past_due` after the grace period, over the plan's limits). Authenticated with the internal token. The engine caches the answer about 60 seconds and answers its own caller 403, 429 or 404. Tests: each reason, caching headers, no data leak for an unknown tenant.

**5b Requests workflow (his B4).**
- A request: `reference` (unique per tenant, produced by the engine, for example `AP-4K7Q2`), `type` (`appointment` or `callback`), `status` (`requested`, `confirmed`, `done`, `cancelled`), `channel`, `language`, `data` (already validated by the engine), `summary`, `scheduledLocal` (the business's wall-clock time as a string on purpose), `timezone`, `configVersion`, `conversationId`, `submissionKey`, the end customer, and timestamps.
- Engine routes (service token): create (201, or 200 with `created: false` for a repeated `(tenant, submissionKey)`), update details, withdraw, and customer upsert by phone. **The engine may change a request only while it is `requested`**; otherwise 409 `locked`.
- Status moves: `requested` to `confirmed` or `cancelled`; `confirmed` to `done`, `cancelled` or back to `requested`; `done` to `confirmed`; `cancelled` to `requested`. Each is a conditional update on the status that was read.
- Staff side: `/v1/tenants/:tenantId/requests` list (status, type, date, search), detail, change status; all roles can work requests (to confirm with Abdul); audit entries (`request.confirmed` and so on); a notification for new requests; live update on the dashboard stream.
- Events from the engine: `record.submitted` and `record.updated` carry ids and references only (open question: should they carry the details?).

**5c Phone numbers (his B11, our Q26).**
- `phone_numbers` (tenant, E.164 unique, provider, provider id, status). Assigned by a platform admin first; buying and porting numbers comes in Phase 6.
- `GET /internal/numbers/{e164}` returns `{tenantId}`, used by the engine after it verifies the Twilio webhook signature, so the tenant is never taken from what the caller supplies.
- Ticket: the backend verifies the Twilio signature, maps the number, signs a one-minute single-use ticket, and the telephone provider connects to the engine's voice gateway with it (the gateway needs a public secure WebSocket; everything else stays private).
- The end customer is upserted from the caller's number.

**5d Call usage and billing (his B8).** Agree the shape first (his proposal: `usage.call_minutes {conversationId, seconds, channel}`, `usage.chat_message`, `usage.record_created`, `usage.embedding_texts`). Add call minutes to the plan entitlements and to `usage_daily`; the owner usage page shows conversations, messages and call minutes (no token counts); the status check returns `quota_exceeded` when the minutes are used up.

**5e Agent settings and knowledge (his B2, B3, B5).**
- Settings: either the backend stores and versions them (his handoff) or only plan-derived values come from the backend while persona and prompts stay in his table (his reply). **Open, Abdul to decide.** The earlier draft [contracts/agent-config.schema.json](contracts/agent-config.schema.json) is **on hold** until then, because his real fields differ (business name, purpose, tone, timezone, hours, escalation, capabilities, voices, and a "what the agent collects" checklist with services and staff lists).
- Knowledge (decided in his handoff, matches our K2): the backend keeps the **original file** in its own storage, checks plan limits and file types, forwards the file to the engine by multipart upload, and follows the ingestion job. Files only (PDF, DOCX, TXT, MD, CSV); no web-address fetching for now. The storage provider is Abdul's choice (open).

## 4. Dropped or frozen (do not build)

| Item | Why |
|---|---|
| Tenant integration secrets and the encryption key (K3) | The engine executes no actions; each side keeps its own secrets (his B6) |
| Risky-action approvals (K4, Q23) | Same reason |
| Widget key rotation, widget wording from settings (K7, K8) | Widget work is frozen (L2) |
| WhatsApp | Out of scope for now |

## 5. Decisions Abdul still has to make

1. **Agent settings ownership** (M3.4): backend stores them, or hybrid.
2. **Storage provider** for knowledge originals (M3.3).
3. **Who sends the customer confirmation** when staff confirm a request, and by which channel (his B9, L5).
4. Whether Phase 4's staff chat features also freeze (L2 assumption).
5. Answers to Abdullah's eight questions (M3), starting with the recommended ones.
6. Staff roles for the requests screen (proposal: all roles can work requests).

## 6. Rules for the build session

Tenant isolation on every query; stable translated error codes (en and ur); no secrets or caller details in logs; the database is shared (no reset, no `db push`; dump first, expand-only migrations generated against a throwaway database); the mail provider stays on `console` while testing by hand; tests at unit, e2e and database level including two-tenant isolation, role denial and idempotent create; extend the mock engine so the whole flow works without the real engine; keep every `.md` file updated, then check for duplicated headings.
