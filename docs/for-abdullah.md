# For Abdullah: what the backend needs from the AI engine

From: Abdul Haseeb (backend core) · Date: 2026-10-11 · Status: **everything below is the backend's proposal; nothing has run against your real engine yet.** *Update 2026-10-21: Abdullah answered (reply of 2026-10-15 and the newer handoff); his answers, the conflicts and our decisions are in team-alignment sections L and M. Q23 is superseded. Phase 5A (same day) recorded his answers in the contract files, changed the backend's first-token timeout default to 10 s (Q14) and drafted the routes the engine will call on the backend in a NEW file, `backend-internal.openapi.yaml` (status check, requests, customer upsert by phone, number lookup; nothing implemented; its open questions are at the top of the file). Send him that file too.*

You own the AI engine (conversations, messages, retrieval, model calls, actions, voice). I own tenants, users, billing, the widget gateway and the dashboard API. This document is the one place that lists what I need you to confirm or change, in the order that blocks us. Please answer in the table at the end.

## 1. What to read (three contract files, plus this one)

| File (in `docs/contracts/` of the backend repository) | What it is |
|---|---|
| `engine-internal.openapi.yaml` | The calls the backend makes **to your engine** (conversations, the streamed reply, escalate, claim, release, resolve, human messages, counts, health). Every addition I made is marked "proposed". |
| `backend-events.openapi.yaml` | The one route the backend exposes **for your engine**: `POST /internal/events`, with the event types, payloads and the HMAC signing. |
| `README.md` | How it behaves end to end, what the backend promises about your engine, and how to run the whole thing against a **mock engine** that follows the contract, so you can see the expected behaviour before you write any code. |

## 2. How the pieces fit

```
Browser / widget ──► BACKEND (public) ──internal HTTP──► YOUR ENGINE (private network only)
Staff dashboard  ──►   tenants, auth, billing,   ◄── signed events (POST /internal/events)
                       widget gateway, notifications
                              │                                   │
                              └────────── one Postgres ───────────┘
                          schema tenant_core (mine)        schema ai_engine (yours)
```

* Browsers, WhatsApp and phone providers only talk to the backend. Your engine is reached only by the backend and is never exposed to the internet.
* **The tenant always comes from the `X-Tenant-Id` header, set by the backend from a verified credential. Please never take a tenant from a request body, a query string or message text.**
* One writer per table: I never write to `ai_engine`, you never write to `tenant_core`.

## 3. What blocks us (please answer these first)

1. **Q1 to Q4:** the shared database, separate migration histories, and the foreign key. Until these are agreed neither of us should run a migration on a shared database.
2. **Q6 to Q9:** the conversation calls and the streamed reply, because the whole widget chat depends on them.
3. **Q15 to Q17:** the events your engine sends back; without them the dashboard stream, the staff notifications and the customer's live updates stay silent.
4. **Q18 to Q20:** the columns I need on `conversations` and `messages`.

Questions Q21 to Q27 are for later phases (agent configuration, knowledge base, actions, privacy, voice). A short "agree in principle" is enough for now.

## 4. Questions

Each question says what I propose and where it is written down (`team-alignment.md` ids are in brackets, in case you read that file). Please answer **Agree**, **Change: …** or **Cannot**.

### A. Database and migrations

**Q1. One database, two schemas [A1].** Today my `.env` points to a database named `multitenant` and your compose file creates `caller-ai-agent`. Proposal: one Postgres from your `pgvector/pgvector:pg16` image, database `caller-ai-agent`, schemas `tenant_core` (mine) and `ai_engine` (yours). I switch my connection string.

**Q2. Keep migration histories apart [A2].** Both projects use Prisma. Without a `?schema=` parameter in the connection string I believe both would write to the same `public._prisma_migrations` table and each would see the other's migrations as drift. Proposal: my `DATABASE_URL` ends `?schema=tenant_core`, yours `?schema=ai_engine`. I have **not** tested this; please try it on a throwaway database: run both `prisma migrate deploy` in turn, then add one migration on each side and run `migrate dev`. Neither may ask to reset.

**Q3. Extensions and order [A3].** A compose init script creates `vector` and both schemas once, so no migration needs privileges. `tenant_core` migrations run first.

**Q4. Foreign key and delete rule [A5].** You add this in a raw SQL migration (you own `ai_engine`):

```sql
ALTER TABLE ai_engine.conversations
  ADD CONSTRAINT conversations_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenant_core.tenants(id) ON DELETE RESTRICT;
-- the same for messages, knowledge_chunks, call_logs, agent_actions
ALTER TABLE ai_engine.conversations
  ADD CONSTRAINT conversations_end_customer_fk
  FOREIGN KEY (end_customer_id) REFERENCES tenant_core.end_customers(id) ON DELETE SET NULL;
```

`RESTRICT`, so a stray tenant delete can never wipe conversation history. Tenant removal goes through an offboarding procedure that asks your engine to delete its data first (Q24).

**Q5. Database roles, later [A4].** Development uses the `postgres` user. In production, one role per service; yours would have read and write on `ai_engine` and `REFERENCES` on `tenant_core.tenants` and `tenant_core.end_customers`, nothing else.

### B. Calls from the backend to your engine

**Q6. Conversations.** `POST /internal/conversations` `{channel, endCustomerId}`, `GET /internal/conversations/{id}` (with paginated messages), `GET /internal/conversations` (filters `status`, `assignedUserId`, `endCustomerId`, `sort=escalatedAt`, paging) and `GET /internal/conversation-counts`. The response shapes are in the contract file. `endCustomerId` and every user id are the **backend's** ids; please store them as plain text.

**Q7. The streamed reply.** `POST /internal/conversations/{id}/messages` `{content (max 2000), externalMessageId?, aiReply?}` always answers `text/event-stream`. Order: `accepted`, then `token` (zero or more), optionally `usage`, optionally `escalated`, then `done`. A failure after the stream started is an `error` event. Repeating the call with the same `Idempotency-Key` must not store the message again nor call the model again: replay `accepted`, the stored reply as one `token`, and `done`. The backend waits 5 seconds for the first event and 30 seconds in total, then shows the customer a fallback and escalates.

**Q8. Two additions to the original table, not yet confirmed.** `POST /internal/conversations/{id}/escalate {reason, summary?}`: the backend tells the engine to escalate **without calling the model** (reasons `ai_unavailable`, `limit_reached`). And `aiReply: false` on the message call: store the message, generate no reply (used when a tenant is over its plan limit so the message still reaches a human).

**Q9. Staff calls.** `claim`, `release` (`to`: `active`, `escalated` or `resolved`; `force` only for a holder who was disabled or deleted), `resolve`, `human-messages {userId, content}` (stored as `author_type=human`). Claim must be **atomic**: only when status is `active` or `escalated` and nobody holds it; one claimant wins a race. Errors are 409 with the codes `CONVERSATION_ALREADY_CLAIMED`, `CONVERSATION_RESOLVED`, `CONVERSATION_NOT_ASSIGNED_TO_YOU`. A repeated claim with the same `Idempotency-Key` that already succeeded answers 200, not 409.

**Q10. Headers.** Every call carries `Authorization: Bearer <INTERNAL_API_TOKEN>`, `X-Tenant-Id`, `X-Request-Id` and, for commands, `Idempotency-Key`. Staff calls also carry `X-Acting-User-Id` and `X-Acting-Role` for your audit trail (never a source of the tenant).

**Q11. Silence while a human is active [C4].** While status is `human_active` the engine must not generate AI replies, and must re-check status inside the same transaction before it answers, so a message that arrives at the moment of a claim cannot get a late AI answer. A customer message in that state is stored and answered with `done` and `aiReply: false`.

**Q12. System lines.** On claim, release and resolve your engine writes a `system` message with an empty text and `contentKey` `agent.joined`, `agent.left` or `resolved.notice`. The keys belong to my `widget` translation namespace; please never send English text for these.

**Q13. Escalation reasons.** `customer_requested`, `low_confidence`, `failed_action`, `sentiment`, `topic`, `outside_hours`, `ai_unavailable`, `limit_reached`, `other`. You decide **when** to escalate (from the tenant's agent configuration, Q21); the backend never second-guesses it.

**Q14. Timeouts and retries [D7].** *(Answered: 10 seconds to the first event until a faster model; the backend default is 10 s since Phase 5A.)* First event within 5 seconds, 30 seconds in total; the backend retries once, only when the connection broke, using the same `Idempotency-Key`. Is that realistic for your model and retrieval?

### C. Events from your engine to the backend

**Q15. The receiver.** `POST /internal/events` on the backend (private network only). Signed with HMAC-SHA256 over `<timestamp>.<raw body>` using the shared `INTERNAL_API_TOKEN`; headers `X-Engine-Timestamp` (unix seconds) and `X-Engine-Signature: sha256=<hex>`; 5 minute window; the token itself is never sent. Body: `{id, type, tenantId, occurredAt, data}`.

**Q16. Event types and payloads.** `conversation.created`, `conversation.escalated {conversationId, reason, summary?}`, `conversation.assigned {conversationId, assignedUserId, assignedByUserId}`, `conversation.released {conversationId, to, previousUserId?}`, `conversation.resolved {conversationId, resolvedBy}`, `message.created {conversationId, messageId, authorType, content only for human and system messages}`, `usage.recorded {conversationId, messageId, tokensIn, tokensOut, model}` (one per assistant message) and `action.proposed {actionId}`. Later: `action.executed`, `call.ended`, `ingestion.completed`, `ingestion.failed`. Unknown types are acknowledged and ignored, so you can add types before I learn them.

**Q17. Delivery rules.** `tenantId` of the envelope is the only tenant I use. Event `id` is unique per event; retry on any non-2xx answer and on timeouts (a retry after a lost answer is a no-op: I answer 200 `duplicate`). Order is not guaranteed across retries.

### D. Columns I need on your tables [B5, C1, C2, C3, C5]

**Q18. `conversations`.** Add `end_customer_id text null` (index on `tenant_id, end_customer_id`), `assigned_user_id text null`, `escalated_at`, `escalation_reason text null`, `resolved_at`, `resolved_by` (`ai`/`human`/`customer`/`system`), `summary text null` (a short handoff note you write on escalation), `last_message_at`. Status values: `active` (the AI answers), `escalated` (waiting for a human), `human_active` (a human is handling it), `resolved`.

**Q19. `messages`.** Add `author_type` (`customer`/`ai`/`human`/`system`/`tool`), `author_user_id text null`, `external_message_id text null` with `UNIQUE (tenant_id, channel, external_message_id) WHERE external_message_id IS NOT NULL` (providers retry webhooks), and on assistant messages `model`, `tokens_in`, `tokens_out`, `latency_ms`. `role` stays for the model; a human's reply is `role=assistant`, `author_type=human`.

**Q20. Queue index.** `(tenant_id, status, last_message_at desc)` for the staff queue.

### E. Later phases (a first reaction is enough now)

**Q21. Agent configuration [E1].** The backend stores a versioned configuration per tenant (persona, tone, languages, greeting, fallback and handoff texts, working hours with a time zone, escalation rules, allowed actions with limits, retention days). You fetch it with `GET /internal/tenants/{id}/agent-config` (cached up to 60 seconds). We write the JSON schema together; please tell me what you need in it.

**Q22. Knowledge base [E2, E3].** Files go to object storage; the backend keeps a record with a status. You chunk, embed and write `knowledge_chunks`; I ask for `source_id text` (the backend's id for the source), `chunk_index`, `embedding_model`, and an index on `(tenant_id, source_id)`. Deleting a source means deleting its chunks by `tenant_id` and `source_id`. `POST /internal/knowledge/ingest {sourceId, storageKey, type}` and `DELETE /internal/knowledge/{sourceId}`, with `ingestion.completed` / `ingestion.failed` events carrying a **failure code** (never raw text). A note on pgvector: an approximate index combined with `WHERE tenant_id = …` can return fewer results than requested, so please test with several tenants and make sure tenant B can never see tenant A's chunks.

**Q23. Actions and credentials [E4].** Tenants' integration credentials are stored encrypted by the backend; you fetch them per execution (`GET /internal/tenants/{id}/integrations/{kind}`) and never put them in a model prompt or a log. `agent_actions` gets `message_id`, `status` (`proposed`/`approved`/`executed`/`failed`/`rejected`), `approved_by_user_id`, `executed_at`. Actions above a tenant's limit stop at `proposed` until an owner or admin approves (`POST /internal/actions/{id}/approve` and `/reject`). Please validate action parameters against the tenant's policy in code, not by trusting the model.

**Q24. Erasure and offboarding [F1].** `DELETE /internal/customers/{endCustomerId}/data` (conversations, messages, call logs, recordings) and `DELETE /internal/tenants/{id}/data`. The backend calls these before it removes its own rows. Per-tenant retention in days: do you run the daily purge?

**Q25. Training data.** A tenant consent exists (default off, owner only), but **no training export may be built** until a lawyer has reviewed it. Please do not read conversations for training purposes.

**Q26. WhatsApp and voice [D4, E5].** Webhooks land on the backend, which verifies the provider signature, maps the number to a tenant and forwards to you. For real-time voice audio, routing through the backend adds a hop: would you prefer that the backend issues a short signed token and the telephony provider connects straight to your media endpoint? Also `call_logs` additions: `provider_call_id`, `direction`, `from_number`, `to_number`, `status`, `ended_at`, and a `conversation_id` that is always set.

**Q27. Self-hosted model later [I12].** If we move from an API model to our own GPUs, nothing the customers pay changes, but I want cost per tenant. Please record `provider` and an estimated cost next to `model` and tokens, and keep the model behind one interface so it can be swapped.

## 5. Rules I ask your engine to follow

1. Every query on tenant data includes `tenant_id`, and there is a test showing tenant B never reads tenant A's rows or chunks.
2. Tenant only from `X-Tenant-Id`.
3. No message text, tokens or keys in logs; no raw error text from the model or a provider reaches a customer.
4. Messages longer than 2,000 characters are refused (the backend enforces it too).
5. The shared `INTERNAL_API_TOKEN` (32 or more characters) is given to you privately and never goes into git, a document or a chat.

## 6. See the expected behaviour first

If you have the backend repository, you can run everything on the mock engine, which follows the contract:

```bash
npm install
cp .env.example .env     # fill in DATABASE_URL and JWT_SECRET; ENGINE_MODE=mock is the default
npx prisma migrate deploy
MAIL_MODE=link npm run start:dev
npm run widget:walkthrough     # a visitor chats, is answered, is escalated
npm run handoff:walkthrough    # escalate, notify, claim, reply, release, resolve, with the live streams
```

`docs/contracts/README.md` explains each step and shows the exact event streams.

## 7. Your answers

Please copy this table into your reply.

| Q | Answer (Agree / Change: … / Cannot) | Note |
|---|---|---|
| Q1 | | |
| Q2 | | |
| Q3 | | |
| Q4 | | |
| Q5 | | |
| Q6 | | |
| Q7 | | |
| Q8 | | |
| Q9 | | |
| Q10 | | |
| Q11 | | |
| Q12 | | |
| Q13 | | |
| Q14 | | |
| Q15 | | |
| Q16 | | |
| Q17 | | |
| Q18 | | |
| Q19 | | |
| Q20 | | |
| Q21 | | |
| Q22 | | |
| Q23 | | |
| Q24 | | |
| Q25 | | |
| Q26 | | |
| Q27 | | |

When the blocking items (Q1 to Q20) are answered, I switch the backend from the mock to your engine (`ENGINE_MODE=http`, `ENGINE_BASE_URL`, `INTERNAL_API_TOKEN`) and we run the same walkthroughs against it together.

## 8. Addendum 2026-10-28: agents, Twilio routing, usage and build order

After reading your repository and your two answer files, Abdul decided how agents and numbers work and what the backend wants first. Everything here is a proposal for you to confirm or change. Answer in the same style (Agree, Change: …, Cannot).

**Q28. Agents (the tenant's setups) and the settings.** *(Update: the backend side of the settings and the pull route is built since Phase 5B-1 and works against our mock engine; its contract is `AgentConfig` and `GET /internal/tenants/{tenantId}/agents/{agentId}/config` in `docs/contracts/backend-internal.openapi.yaml`, with `?version=`, ETag/304 and `status: "disabled"` for a disabled agent. The backend checks only the structure of the document on save and stores `collect` as it is; tell us which fields of your `agent_configs` you really read and whether you offer a validation route.)* You have one engine, the one shared brain, and it answers every call. An **agent** is the tenant's own setup that the brain uses: its knowledge, hours, greeting, voice, language, what it collects, and who it forwards calls to. (Not a separate AI: one engine, many agents.) A tenant has many agents and many phone numbers; each number is linked to exactly one agent; an agent can have many numbers. Minutes and billing stay pooled per tenant. **Abdul's decision: the backend owns each agent's settings and sends them to the engine at the start of every call**, so the engine does not keep per-agent settings. Proposal: the call ticket carries tenant id, agent id and the settings version; your `getAgentConfig()` seam fetches `GET /internal/tenants/{tenantId}/agents/{agentId}/config` at call start (cached up to 60 s, versioned), because the settings include forwarding phone numbers that should not travel in a ticket or URL. The field list stays yours (your catalogue and validation; the backend stores the JSON and validates on save through you; please offer the validation route you mentioned). **Knowledge cannot travel with a call**, so it stays in your database but per agent: `agent_id` on `knowledge_sources` and `knowledge_chunks`, retrieval filtered by tenant and agent; `conversations`, `call_logs` and `records` carry `agent_id`; your routes accept `X-Agent-Id`; events carry `agentId`; the number lookup returns `{tenantId, agentId}`. Launch with one default agent per tenant. Questions: how large is that change for you? Can `agent_id` be nullable at first, meaning "the tenant's default agent", until the backend supplies the ids? Abdul decided on **pull** (the settings fetch above); please confirm. A browser test call from the dashboard also uses this fetch.

**Q29. Twilio routing.** Your code and handoff say the engine verifies the Twilio webhook signature and asks us for the number lookup; your reply agreed that the backend verifies it and signs a ticket. Abdul **decided** on the second, the backend first: the backend receives the webhook on a public HTTPS address, verifies the signature (it holds the Twilio account credentials), finds (tenant, agent), checks the tenant and agent may be served, and tells Twilio to connect the audio to your voice gateway with a one-minute single-use ticket carrying tenant and agent, exactly like your browser tickets today. Questions: (a) can the Twilio transport read that ticket from the stream's start message (a custom parameter) and verify it as now? (b) **Call forwarding needs Twilio access** to redirect a live call: do you prefer a separate revocable Twilio API key for the engine used only for transfers, or that the engine asks the backend to place the transfer? (c) The voice gateway needs a public secure WebSocket address; what will it be? (d) The same ticket route will also serve a staff "test call" from the dashboard (your console does this today). It is the **only** call path for Free and Starter tenants, who get no real phone number; Pro and Enterprise get numbers.

**Q30. Requests and usage.** (a) `reference` is drawn by the engine; the backend must keep it unique per tenant, so a clash answers 409 `reference_taken` and the engine draws another one (you already retry four times). (b) The finished-call event: `usage.call_minutes {callId, conversationId, agentId, seconds}` sent once when the call ends; the backend proposes to round each call **up** to whole billed minutes; a call that is running when the allowance ends is not cut off. (c) Requests carry `agentId`; customers stay per tenant (found by phone) because one caller may call several agents. **(Update 2026-10-29: the status check, the customer upsert and the requests are BUILT in the backend (Phase 5B-2) against our mock engine and the draft contract `docs/contracts/backend-internal.openapi.yaml`; nothing below is agreed until you answer.)** (d) The status check `GET /internal/tenants/{tenantId}/status?agentId=` answers your four reasons plus two of ours, `agent_disabled` and `unknown_agent` (an agent id that does not exist or is another tenant's: one answer), and a field `overage` (true when the call is served only because extra minutes are billed). Will your engine treat an unknown `reason` as "not serviceable, 403"? We ask you to keep an answer **at most 10 seconds** (`Cache-Control: private, max-age=10`), not the 60 your handoff says, so a suspension is felt quickly; is that acceptable? (e) Our internal routes answer errors as `{statusCode, code, message}` (for example `REQUEST_LOCKED`, `REQUEST_REFERENCE_TAKEN`, `AGENT_NOT_FOUND`), yours are `{error}`; you read the status code and `code`, you do not show our `message` to a caller. OK? (f) **Source of truth for a request: your calls to `POST …/requests`, `PATCH …/requests/{reference}`, `POST …/requests/{reference}/withdraw` and `PUT …/customers/by-phone`; the `record.*` events only make sure the team was told** (they carry the backend's `recordId`, the id that the create call returns, and the `reference`). Is that how you will send them (create first, then the event)? (g) The create is idempotent by `submissionKey` (a repeat is 200 `created: false` with the same request, even when the body differs); on 409 `REQUEST_REFERENCE_TAKEN` draw another reference and repeat with the SAME `submissionKey`. Once a person confirmed a request, your update or withdraw is 409 `REQUEST_LOCKED`.

**Q31. Which routes first** (your open question). The backend's answer, since message operations (chat widget, staff chat queue, conversation claim and release) are halted: (1) the Bearer guard and the tenant and agent from headers (`X-Tenant-Id`, `X-Agent-Id`) on every route the backend calls; (2) the signed events from the outbox: `record.submitted`, `record.updated`, `handoff.*`, `usage.call_minutes`; (3) the agent-aware settings, collect checklist, knowledge upload and call-history routes the backend will call, moved to those headers; (4) the `agent_id` migration; (5) the conversation, claim and release routes of `engine-internal.openapi.yaml` **last** (they are chat-only and halted). Your `/api/chat` test surface can stay as it is.

| Q | Answer (Agree / Change: … / Cannot) | Note |
|---|---|---|
| Q28 | | |
| Q29 | | |
| Q30 | | |
| Q31 | | |
