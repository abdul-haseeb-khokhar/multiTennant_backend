# Contracts: the AI engine, the widget gateway and the voice-first calls

| File | What it is | Status |
|---|---|---|
| [engine-internal.openapi.yaml](engine-internal.openapi.yaml) | The part of the engine's internal API the backend calls: run a chat (create conversation, send a message and stream the reply, read a conversation, escalate, health) and, since Phase 4, the staff side (list, counts, claim, release, resolve, human messages) | **Proposed by the backend (Phases 3 and 4); Phase 5A recorded what Abdullah agreed (M1: message fields `contentKey`, `provider`, token counts and latency, idempotent claim answers 200, 10 s to the first token, 2,000 characters, `conversation.released.to` only `active` or `escalated`).** Nothing is built on his side yet. Everything that is not in team-alignment Appendix A yet is marked "proposed addition" in the file. Chat is halted (L2): no new work. |
| [backend-events.openapi.yaml](backend-events.openapi.yaml) | The route the engine calls to PUSH events: `POST /internal/events` (signature, envelope, event types and payloads, delivery rules). Since Phase 5A it also lists the voice-first events `record.submitted`, `record.updated` and `usage.call_minutes` (all with `agentId` since Phase 5B-1) | **Proposed by the backend (Phase 4), to be reviewed by the AI engine owner.** `record.submitted` and `record.updated` are HANDLED since Phase 5B-2 (the team notification and the live update, once-only; the request itself arrives through the routes of the next file); `usage.call_minutes` is only acknowledged (200 `ignored`) until
| [backend-internal.openapi.yaml](backend-internal.openapi.yaml) | The routes the engine calls to ASK or COMMAND the backend: agent list and settings pull, tenant status check, requests (create, update, withdraw), customer upsert by phone, number lookup | **BUILT except the number lookup (agent config 5B-1, status check and requests 5B-2, agent list and the `order` type 5B-3; the lookup is Phase 5D and is the route the engine calls on every inbound call, engine first). Everything is a proposal that Abdullah has not seen; the table "What Abdullah must adapt to" below compares every field with his hand-off.** The number lookup is marked NOT BUILT; the open questions are at the top of the file. |
| [../openapi.json](../openapi.json) | The public API of the backend, including `/v1/widget/*` and `/v1/tenants/:tenantId/api-keys` | Generated: `npm run openapi:export` |

The backend talks to the engine only through `EngineClient` (`src/engine/`). `ENGINE_MODE` chooses the implementation:

| `ENGINE_MODE` | What answers | When |
|---|---|---|
| `mock` (default outside production) | An in-process mock engine that follows the contract, keeps conversations in memory and streams a canned reply token by token | Development, tests, the frontend prototype |
| `http` | The real engine at `ENGINE_BASE_URL`, with `Authorization: Bearer $INTERNAL_API_TOKEN`, `X-Tenant-Id`, `X-Request-Id`, `Idempotency-Key` | Staging and production. **Production refuses to start in any other mode.** |

### Running the backend beside the real engine (port and header)

* **Port clash.** The backend (`PORT`) and the engine both default to port **3000**. On one machine give one of them another port: `PORT=3100` for the backend, and `ENGINE_BASE_URL` is where the backend looks for the engine.
* **Authentication header.** The backend sends `Authorization: Bearer <INTERNAL_API_TOKEN>` and `X-Tenant-Id` on every engine call. The engine's NEW `/internal/*` routes accept that (agreed, team-alignment M1 Q10). Its OLDER `/api/*` routes use `?tenantId=` and the header `x-internal-key` (his `INTERNAL_API_KEY`); he converts only the routes this backend calls. The backend never sends `x-internal-key`.
* **The same token signs the events** the engine pushes to `POST /internal/events` (HMAC, the token itself is never sent).

The mock is tested with the very same behaviour suite as the HTTP client (`src/engine/engine-client.contract.spec.ts`), and the HTTP client is tested against a real socket server that speaks the contract (`test/utils/fake-engine-server.ts`), so the mock is a faithful stand-in as long as that suite passes.

## Run the whole chat without the real engine

You need the backend and its database (see the main README / `CLAUDE.md`), nothing else.

```bash
# one terminal: the backend, mock engine, links returned in API responses (development only)
MAIL_MODE=link npm run start:dev          # ENGINE_MODE defaults to mock

# another terminal: a scripted walk through every path (creates a throwaway tenant)
WIDGET_ORIGIN=http://localhost:3001 npm run widget:walkthrough
# with PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD set it also covers the plan limit and a suspended tenant
```

The same thing by hand with `curl` (`-N` keeps curl from buffering the stream). Replace the origin with the website your widget runs on; it must match what you put in `allowedOrigins`. **Every widget call needs an `Origin` header** (a browser sends it by itself; curl needs `-H`):

```bash
API=http://localhost:3000
ORIGIN=http://localhost:3001

# 1. a tenant and its owner (the response has access_token and tenant.id)
curl -s $API/v1/auth/signup -H 'Content-Type: application/json' \
  -d '{"tenantName":"Demo Shop","ownerEmail":"owner@demo.test","ownerPassword":"correct-horse-battery"}'
OWNER=<access_token>   TENANT=<tenant.id>

# 2. a widget key that works from $ORIGIN (the full key is shown ONCE)
curl -s $API/v1/tenants/$TENANT/api-keys -H "Authorization: Bearer $OWNER" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Website\",\"allowedOrigins\":[\"$ORIGIN\"]}"
KEY=<key>

# 3. the widget starts a session (what the browser does on page load)
curl -s $API/v1/widget/sessions -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -d "{\"widgetKey\":\"$KEY\",\"visitorId\":\"$(uuidgen)\"}"
TOKEN=<token>

# 4. a message and the streamed reply
curl -N $API/v1/widget/messages -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content":"What are your opening hours?"}'
#   event: accepted   data: {"messageId":"…"}
#   event: token      data: {"text":"We "}   … one per word …
#   event: done       data: {"messageId":"…","aiReply":true,"conversationStatus":"active"}

# 5. force an escalation: the engine hands over, then stays silent (C4)
curl -N $API/v1/widget/messages -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content":"/escalate"}'
#   … event: escalated  data: {"message":"A colleague will reply to you shortly.","reason":"customer_requested"}
curl -N $API/v1/widget/messages -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content":"Hello? Anyone there?"}'
#   event: accepted → event: escalated → event: done  (aiReply:false, no AI text)

# 6. history of this visitor
curl -s $API/v1/widget/conversation -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN"
```

### Forcing behaviour from the chat box (mock engine only)

The mock reacts to the customer message. With the real engine these are ordinary words.

| Type this | What the mock does | What the widget receives |
|---|---|---|
| `/escalate`, or any message asking for a human ("I want an agent", "مجھے انسان سے بات کرنی ہے") | Replies with a handover text and escalates (`customer_requested`) | `token…`, `escalated`, `done` (`conversationStatus: "escalated"`); later messages: `escalated`, `done` with `aiReply:false` |
| `/fail` | The engine is unreachable (nothing is stored) | `fallback` with `reason: "ai_unavailable"`, the conversation is escalated by the gateway |
| `/slow` | The model never answers: the first-token timeout fires (`ENGINE_FIRST_TOKEN_TIMEOUT_MS`, 10 s by default since Phase 5A) | `accepted`, then after the timeout `fallback` `ai_unavailable` |
| `/broken` | A few words, then the stream fails | `token`, then `fallback` `ai_unavailable` |
| `/action` | The AI answers and proposes an action that needs approval: the engine emits `action.proposed` (owners and admins get a notification). **Unused by the product since L3** (approvals dropped); kept for the receiver tests | `token…`, `done`; no change for the customer |
| `/call` | **Voice-first (Phase 5A).** Simulates one finished phone call of this tenant: the engine saves a request with a reference such as `AP-4K7Q2` and reports the call length | `token…` naming the reference, `done`; the events `conversation.created` (channel `voice`), `record.submitted` and `usage.call_minutes` (185 seconds) go to the receiver |
| `/call-update` | Simulates the engine changing the details of the latest saved request while it is still `requested` | `token…` naming the reference, `done`; the event `record.updated`; after a person confirmed the request (on the staff screen, or `lockRecord` in a test of the bare mock) the mock explains and changes nothing, like the real `locked` answer |
| `/order` | **Phase 5B-3.** Like `/call`, but the saved request is an **order**: reference `OR-…`, the dishes and pickup in `data` (no prices); everything else (notification, staff screen, `locked`) is the same | `token…` naming the reference, `done`; `record.submitted` carries `type: order` |
| anything with "hours", "delivery", "price" | A canned answer | `token…`, `done` |

Since Phase 4 the mock also plays the staff side and pushes the events of D5 (`conversation.created|escalated|assigned|released|resolved`, `message.created`, `usage.recorded`, `action.proposed`) to the backend's receiver in process, exactly as the real engine will with `POST /internal/events`. So the dashboard, the notifications and the widget's live stream can be driven without the engine, see "Run the human hand-off" below.

### Agents and the settings pull (Phase 5B-1)

A call belongs to an **agent** (the tenant's own setup; team-alignment L7). `simulateCall` is `async` since Phase 5B-1: it first PULLS the settings of the agent that takes the call through the same service the engine's route uses (`AgentConfigService`), so what a test sees is what `GET /internal/tenants/{tenantId}/agents/{agentId}/config` returns. `engine.simulateCall(tenantId, { agentId?, phone?, name? })` takes the tenant's default agent when none is named and returns `agentId`, `settingsVersion` and the pulled `config` next to the reference; `conversation.created`, `record.submitted`, `record.updated` and `usage.call_minutes` carry `agentId` in `data`. A disabled agent takes no call (`MockAgentUnavailableError`; the `/call` chat command answers that the agent is not available) and an agent of another tenant fails like an unknown one (`MockCallRefusedError` with reason `unknown_agent`, since the status check of Phase 5B-2 runs first; without the backend connected it is `AGENT_NOT_FOUND`). Edit the settings with `PUT /v1/tenants/:tenantId/agents/:agentId/settings` and the next simulated call is served with the new `settingsVersion`. Try the real pull route by hand (the token is `INTERNAL_API_TOKEN`; never paste a real one into a shared place):

```bash
curl -i $API/internal/tenants/$TENANT/agents/$AGENT/config -H "Authorization: Bearer $INTERNAL_API_TOKEN"
#   200  ETag: "…"  Cache-Control: private, max-age=60  {"tenantId":…,"agentId":…,"version":1,"status":"active","config":{…}}
curl -i $API/internal/tenants/$TENANT/agents/$AGENT/config -H "Authorization: Bearer $INTERNAL_API_TOKEN" -H 'If-None-Match: "…"'   # 304
curl -i $API/internal/tenants/$TENANT/agents -H "Authorization: Bearer $INTERNAL_API_TOKEN"   # 200 {"agents":[{"agentId":…,"name":…,"status":"active","isDefault":true}]}, default first (Phase 5B-3)
```

### Simulate a phone call (voice-first, Phase 5A)

The product is an AI phone receptionist (L1): a caller talks to the engine, the engine saves a **request** (an appointment, a call-back or, since Phase 5B-3, an order) with a short reference, and staff confirm it. None of that exists in the real engine yet, so the mock plays it, for the frontend prototype and for Phases 5B and 5E:

```bash
# in any mock chat (the widget walkthrough above): send /call, then /call-update
curl -N $API/v1/widget/messages -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content":"/call"}'
#   event: token  data: {"text":"Thank you for calling. I saved your request AP-4K7Q2. …"}
```

In a test (or a script that builds the app) call the mock directly: `engine.simulateCall(tenantId, { type: 'appointment' | 'callback' | 'order', seconds, phone?, name?, data? })` returns `{ conversationId, recordId, endCustomerId, reference, seconds, … }`; `await engine.simulateRequestUpdate(tenantId, reference, { summary })` and `await engine.simulateRequestWithdraw(tenantId, reference)` (both `async` since Phase 5B-2, `true` when the backend accepted the change, `false` for `locked`: a person confirmed it, the update changes nothing and sends nothing, exactly as the real route answers 409 `REQUEST_LOCKED`); `engine.recordsOf(tenantId)` and `engine.inspectRecord(tenantId, reference)` read what the engine holds (another tenant's reference does not exist for you). **Since Phase 5B-2 the application wires the mock to the backend** (`engine.setBackend`, done by `MockEngineBackendBridge`): a simulated call first asks the tenant status check (a suspended tenant, one out of minutes, a disabled or foreign agent take no call: `MockCallRefusedError` / `MockAgentUnavailableError`), then upserts the caller by `phone` (a made-up `+92…` number when none is given) as an end customer of the tenant and saves the request IN THE BACKEND through the same services as the internal routes, so the request is on the staff screen (`GET /v1/tenants/:tenantId/requests`), the team is notified and the engine's later update is refused once staff confirmed it. A bare `new MockEngineClient()` (the unit tests of the mock) keeps its own in-memory requests and `engine.lockRecord(tenantId, reference, 'confirmed')` plays "a person confirmed it" there.

What the mock sends to the backend's receiver, in this order: `conversation.created` (channel `voice`), `record.submitted` `{recordId, reference, type, conversationId, endCustomerId, channel}`, `usage.call_minutes` `{conversationId, seconds, channel}`; later `record.updated` `{recordId, reference, type, conversationId, revision}`. **Since Phase 5B-2 the backend handles `record.submitted` and `record.updated` (it makes sure the team was told; the request already arrived through the routes) and still acknowledges `usage.call_minutes` (200 `ignored`) until Phase 5E counts the minutes.** Until then the minutes of a tenant can only be written by tests, through `UsageService.recordCallMinutes`. `record.updated` also carries `status: "cancelled"` when the caller withdrew the request. The payload fields are proposals (ids and the reference only, never what the caller said); the event names come from Abdullah's documents.

The blocked and limit paths do not need the mock; they come from the tenant itself:

* **Plan limit** (`status: "limited"`, messages answered with `fallback` `limit_reached`): as a platform admin,
  `POST /v1/admin/tenants/$TENANT/subscription/change-plan` with `{"planCode":"free","entitlementsOverride":{"conversationsPerPeriod":1}}`, then start sessions with new visitor ids. A visitor with an open conversation is never stopped by the limit.
* **Overage** (Pro, J6): with `change-plan` to `pro` and `{"conversationsPerPeriod":1}` as `entitlementsOverride`, new visitors keep getting `status: "ready"` past the limit (overage is on by default). As the tenant owner `PATCH /v1/tenants/$TENANT/billing/settings` with `{"overageEnabled":false}` turns that back into the `limited` path above; nothing changes in the engine contract (the engine is simply not told about the extra conversations, the backend decides).
* **Blocked tenant** (`status: "blocked"`, no token): `POST /v1/admin/tenants/$TENANT/subscription/suspend` with `{}` (before Phase 3C this was `PATCH /v1/admin/tenants/$TENANT` with `{"status":"suspended"}`, which now answers 400). Lift it afterwards with `POST …/subscription/unsuspend`.

## What the widget needs to know

**Session** (`POST /v1/widget/sessions`, body `{ widgetKey, visitorId, locale? }`, no token):

* `visitorId`: create once with `crypto.randomUUID()` and keep it in `localStorage`. It identifies the visitor (`web_<visitorId>`, B4). Whoever knows it can resume that visitor's chat, so never log it or put it in a URL.
* The answer has `status`:
  * `ready`: chat. Use `token` as `Authorization: Bearer` for the other two routes. It lasts 15 minutes (`expiresInSeconds`); **call the session endpoint again with the same `visitorId` before it ends** to get a new one for the same conversation (a conversation counts once, however often you refresh). On `401 WIDGET_TOKEN_EXPIRED` do the same.
  * `limited`: the conversation exists but the AI will not answer it (plan limit). Messages still reach a human. Show `fallback.message`.
  * `blocked`: no chat (tenant suspended or closed, no chat in the plan, or the assistant is down and there is no conversation yet). **HTTP 200 with no token.** Show `fallback.message`.
* Also in the answer: `greeting`, `personaName`, `locale` (render in this language), `defaultLocale`, `poweredBy` (show the "Powered by" label), `conversationId`.
* Errors: `401 WIDGET_KEY_INVALID` (unknown, revoked or not a widget key; the three look the same), `403 ORIGIN_NOT_ALLOWED` (the page's origin is not on the key's list, or there is no `Origin` header), `400 VALIDATION_ERROR`, `429 TOO_MANY_REQUESTS` with `Retry-After`.

**Sending a message** (`POST /v1/widget/messages`, body `{ content }` up to 2,000 characters, widget token). The response is `text/event-stream`. A POST cannot use `EventSource`; read it with `fetch`:

```js
const res = await fetch(`${API}/v1/widget/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
  body: JSON.stringify({ content }),
});
if (!res.ok) { /* an ordinary JSON error: { statusCode, code, message } */ }
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
let buffer = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += value;
  for (let end; (end = buffer.indexOf('\n\n')) !== -1; ) {
    const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    const event = /^event: (.*)$/m.exec(block)?.[1];
    const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}');
    // handle(event, data)
  }
}
```

| Event | `data` | Meaning |
|---|---|---|
| `accepted` | `{ messageId }` | The message is stored. |
| `token` | `{ text }` | Next piece of the reply; concatenate. |
| `escalated` | `{ message, reason? }` | A human was asked to take over (or is already waiting). Show `message`. |
| `fallback` | `{ reason, message, escalated }` | The AI did not answer. `reason`: `service_unavailable`, `limit_reached` or `ai_unavailable`. Show `message`; it is already translated. This ends the stream. |
| `done` | `{ messageId, aiReply, conversationStatus }` | The reply is complete. `aiReply:false` means no AI text (a human is handling it). |
| `error` | `{ code }` | `CONVERSATION_NOT_FOUND` or `CONVERSATION_RESOLVED`: call the session endpoint for a new conversation, then resend. |

Every stream ends with `done`, `fallback` or `error`. A failure **before** the stream starts is a normal JSON error: `400 MESSAGE_TOO_LONG` / `VALIDATION_ERROR`, `401`, `403 ORIGIN_NOT_ALLOWED`, `404 CONVERSATION_NOT_FOUND`, `429`. Sending the same `Idempotency-Key` again (8 to 100 characters of `A-Za-z0-9_-`) replays the result and does not store, answer or count the message twice. Show a customer message only after `accepted`, or keep it locally and resend with the same key after a network error.

**History** (`GET /v1/widget/conversation?skip=&take=`): `{ id, status, data: [{ id, authorType: customer|ai|human|system, content, contentKey?, createdAt }], total, skip, take }`, oldest first. System lines such as "an agent joined" arrive as `contentKey` (a key of the `widget` namespace: `agent.joined`, `agent.left`, `resolved.notice`), not English text. No staff identities.

**Live events while the customer is idle** (Phase 4, `GET /v1/widget/events`): the same widget token, `Authorization` header and `Origin` as the other calls, so read it with `fetch` and a stream reader like the message stream (an `EventSource` cannot send the header). It carries what happens in the customer's conversation without a message from them:

| Event | `data` | Meaning |
|---|---|---|
| `ready` | `{ heartbeatSeconds, tokenExpiresInSeconds }` | The stream is open. |
| `message` | `{ id, authorType: "human" or "system", content, contentKey, createdAt }` | A staff reply (text, no identity; label it with `human.label`) or a system line (empty `content`, `contentKey` such as `agent.joined`). Show it once, by `id`. |
| `status` | `{ status: "active" or "escalated" or "human_active" or "resolved" }` | The conversation changed. `escalated`: show `status.waiting_colleague`; `resolved`: show `resolved.notice` and start a new session on the next message. |
| `resync` | `{}` | Your `Last-Event-ID` is too old or from before a restart: re-read `GET /v1/widget/conversation`. |
| `closed` | `{ reason }` | `expired` (the 15 minute token ended: call the session endpoint, reconnect with the new token and the last event id), `revoked` (key revoked or chat switched off), `limit` (a fourth stream of the same conversation replaced this one). |

Every data event has an `id`: send the last one as `Last-Event-ID` when reconnecting (the last 100 events are kept; the CORS preflight allows that header). The AI's own replies and the customer's messages are NOT sent here: they come through the message stream. A `: ping` comment arrives every 25 seconds. The history route stays the fallback for a widget that cannot hold a stream. Errors before the stream starts are ordinary JSON: 401, 403 `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED`, 404 `CONVERSATION_NOT_FOUND`, 429.

**CORS**: only the origins on the widget key may read these responses; the preflight is answered for origins that some active widget key lists, and the real answer carries `Access-Control-Allow-Origin` only after the key and origin matched. There are no cookies and no `*`. Dashboard routes keep `FRONTEND_URL`.

**Texts**: the widget namespace (`GET /v1/i18n/:locale/widget`) has `greeting.default`, `persona.default`, `fallback.service_unavailable|limit_reached|ai_unavailable`, `escalated.notice`, `human.label`, `agent.joined`, `agent.left`, `resolved.notice`, `status.waiting_colleague`, `status.chat_unavailable`, `error.*`; the API already returns the right text for greetings and fallbacks, in the visitor's language. The Urdu text was written by an AI and needs a native speaker's review (`CLAUDE.md`). Per-tenant wording (greeting, fallback message) comes from `agent_config` in Phase 5; the code has one hook for it (`WidgetSettingsProvider`).

## What the gateway promises about the engine

* The engine receives `X-Tenant-Id` from the verified widget token only, never from the browser's body, URL or message text. A conversation id from another tenant answers 404 (tested with two tenants and two visitors).
* Engine calls carry `X-Request-Id` (the request's id) and an `Idempotency-Key`; plain calls retry **once**, only when the connection broke; a reply stream waits 10 s for the first token (5 s until Phase 5A; the engine owner asked for 10 s while he uses a free-tier model that needs 3.5 to 10 s to start) and 30 s in total (`ENGINE_FIRST_TOKEN_TIMEOUT_MS`, `ENGINE_TOTAL_TIMEOUT_MS`); then the customer gets the `ai_unavailable` fallback and the gateway asks the engine to escalate (`POST …/escalate`, reason `ai_unavailable`). If the engine cannot be reached for that either, the escalation is remembered (`gateway_conversations.escalation_pending`) for a later phase to deliver.
* Over the plan limit the gateway stores the message with `aiReply: false` and escalates with `limit_reached`; **the model is not called**. A suspended or closed tenant makes no engine call at all.
* Message text is never logged. Engine error details never reach a customer.

## Events the backend receives (built in Phase 4)

`POST /internal/events` is built; the full contract is [backend-events.openapi.yaml](backend-events.openapi.yaml). In short: the engine signs each delivery with HMAC-SHA256 over `<timestamp>.<raw body>` using the shared `INTERNAL_API_TOKEN` (headers `X-Engine-Timestamp`, `X-Engine-Signature: sha256=<hex>`, 5 minute window; the token itself is never sent), posts the envelope `{ id, type, tenantId, occurredAt, data }`, and retries on any non-2xx answer. The backend takes the tenant ONLY from the envelope (404 `TENANT_NOT_FOUND` for an unknown one), is idempotent by `(tenantId, id)` (200 `duplicate` the second time), acknowledges and ignores types it does not know (200 `ignored`), and applies a delivery completely or not at all.

| Event | What the backend does |
|---|---|
| `conversation.created` | acknowledged (the gateway counts conversations when it starts them) |
| `conversation.escalated` | notification for every active staff member, `conversation.escalated` on the dashboard stream, `status` on the widget stream, clears `escalation_pending` |
| `conversation.assigned` | `conversation.assigned` on the dashboard stream, `status: human_active` for the customer; a notification for the assignee unless `assignedByUserId` equals `assignedUserId` |
| `conversation.released` | `conversation.released` for the dashboard, `status` (`active` or `escalated`) for the customer |
| `conversation.resolved` | `conversation.resolved` for the dashboard, `status: resolved` for the customer |
| `message.created` | `message.created` (ids) for the dashboard; for the customer only a `human` message (with `content`) or a `system` line (with `contentKey`) |
| `usage.recorded` | counted once per message id in `usage_daily` (the gateway may have counted it from the reply stream already) |
| `action.proposed` | notification for owners and admins, `action.proposed` on the dashboard stream. **Unused since 2026-10-21** (L3: approvals dropped, the engine executes no actions) |
| `record.submitted` (voice-first) | **handled since Phase 5B-2**: the request is found under the ENVELOPE tenant by `recordId` (the id the create call returned) or `reference`; every active staff member gets one `request.submitted` notification and the dashboard one `request.created` message (both once-only, so the route and the event never double up). Never creates a request; an unknown request is processed without effect; neither id nor reference is a 400 |
| `record.updated` (voice-first) | **handled since Phase 5B-2**: a live `request.updated` (the backend's own status) on the dashboard stream; no notification |
| `handoff.requested`, `handoff.unavailable` (voice-first) | **acknowledged and ignored** (200 `ignored`, nothing notified; stored once in the inbox, logged by type and tenant only). No new feature in Phase 5B-3 |
| `usage.call_minutes` (voice-first, Phase 5A) | **acknowledged only** until Phase 5E counts the minutes into `usage_daily.call_minutes` |

Message text travels in `message.created` only for `human` and `system` messages. Later: `action.executed`, `call.ended`, `ingestion.completed`, `ingestion.failed` (acknowledged and ignored today). The routes the engine calls to ask or command the backend are in [backend-internal.openapi.yaml](backend-internal.openapi.yaml): all built (agent config 5B-1, status check, requests, customer upsert 5B-2) except the number lookup, none confirmed by the engine owner.

## What Abdullah must adapt to (Phase 5B-3, 2026-10-29)

Every field in his hand-off (`docs/handoff-to-backend.md` in his repository, B1, B2, B4, B7, B11 and section 4) and in his code (`standins/records.js`, `customers.js`, `tenant/config.js`, `handoff/config.js`, `voice/greeting.js`, `voice/closing.js`, `agent-config/route.js`, `telephony/routing.js`) was compared with the three contract files and with what the backend really accepts. **Nothing here is confirmed by him; the shapes of our side are proposals (team-alignment N2.2: where his hand-off says its own shapes are "my proposal and yours to correct", ours stand).** Four kinds of difference:

* **OK**: he sends it as it is and the backend accepts it.
* **Fixed in 5B-3**: the backend would have refused or silently dropped what he sends; our side was changed (capability gap).
* **He adapts**: a difference of shape or name that N2.2 settles in our favour; the backend builds no compatibility route.
* **Open**: not built or not decided.

### 1. Conventions of every route

| Topic | His hand-off and code | Backend (built) | Verdict |
|---|---|---|---|
| Authentication | header `x-internal-key` (`INTERNAL_API_KEY`) | `Authorization: Bearer <INTERNAL_API_TOKEN>` (constant-time; 401 wrong, 503 not configured) | He adapts (N2.2; his Q10 answer already agreed Bearer for the new routes) |
| Tenant | `?tenantId=` in the query, or a `tenantId` field in a body | In the path: `/internal/tenants/{tenantId}/…`. A `tenantId` in a body is ignored; the tenant is never taken from content | He adapts |
| Errors | `{ "error": "<translated text>" }` | `{ statusCode, code, message }` with stable upper-case codes. His `locked` is 409 `REQUEST_LOCKED`; his `reference_taken` is 409 `REQUEST_REFERENCE_TAKEN`; misses are 404 `…_NOT_FOUND`; limits 429 with `Retry-After` | He adapts (reads status and `code`; `message` is never shown to a caller) |
| Success bodies | update and withdraw answer `{ "ok": true }`; the customer upsert `{ "id" }`; create `{ id, reference, created }` | create/update/withdraw answer `{ id, agentId, reference, type, status, created }` (create is a superset of his); the customer upsert `{ endCustomerId, created }`; there is no `ok` field | He adapts (status code is the signal) |
| Request address | `PATCH /internal/records/{id}`, `POST …/{id}/withdraw` by the engine's own record id | by **reference** (`…/requests/{reference}`), any letter case; the `id` our create returns is the id in his events | He adapts |
| Agent ids | his `agent_configs.id` | the backend's `agentId` (from `GET …/agents`); an id of the other side is a 404 `AGENT_NOT_FOUND` | He adapts |
| Idempotency | `submissionKey` on create | same; `Idempotency-Key` on update and withdraw is accepted and ignored (both are idempotent by nature) | OK |
| Ports | his console 3000, voice gateway 3001 | backend default 3000 | Run one elsewhere (`PORT`, `ENGINE_BASE_URL`) |

### 2. Requests: `POST /internal/tenants/{tenantId}/requests` (his B4 `POST /internal/records`)

| Field he sends | Backend | Verdict |
|---|---|---|
| `reference` (`AP-`, `CB-`, `OR-`, five characters of `ABCDEFGHJKMNPQRSTUVWXYZ23456789`; `RQ-` fallback) | required, 3 to 40 letters, digits and hyphens, stored upper case, unique per tenant (the database CHECK accepts all his prefixes) | OK |
| `type` `appointment`, `callback`, `order` | all three | **Fixed in 5B-3** (`order` was refused) |
| `status` | not accepted: a request is always created `requested` (L1) | OK (he does not send it) |
| `channel` `chat`, `voice`, "`whatsapp` later" | `voice` and `chat`; `whatsapp` is refused with 400 until he sends it and the database allows it | Open (a later migration) |
| `language` | string up to 16 characters, null allowed | OK |
| `data` (the collected values; an order: `order_items`, `order_type`, `address`, `notes`, no prices) | any JSON object up to 16 KB, stored as it is, never logged, not searchable | OK |
| `summary` | required string up to 1,000 characters (an empty string is fine) | OK |
| `scheduledLocal` (`2026-10-22T17:00`) | string up to 64 or null; kept as a string, no zone arithmetic | OK |
| `timezone`, `configVersion`, `conversationId` | up to 64 characters, integer 0 or more, up to 200 characters; null allowed for all | OK |
| `submissionKey` (his draft id) | 1 to 200 characters, idempotent per tenant, also under parallel calls | OK |
| `agentId` (null = default agent) | optional, null or absent = the tenant's default agent | OK |
| `tenantId` in the body | ignored (the path decides) | OK |
| (his record points at his own customer row) | needs **`endCustomerId`** from the customer upsert below | He adapts: upsert first, then create |

`PATCH …/requests/{reference}` takes `data`, `summary`, `scheduledLocal` as he sends them (at least one; `scheduledLocal: null` clears it); `POST …/requests/{reference}/withdraw` takes an optional `reason`. Both are 409 `REQUEST_LOCKED` once a person acted, a conditional write that a staff confirmation at the same moment wins.

### 3. Customer: `PUT /internal/tenants/{tenantId}/customers/by-phone` (his `PUT /internal/customers/by-phone/{phone}`)

| Field | Backend | Verdict |
|---|---|---|
| `phone` (in his path) | in the **body**, E.164, never in a URL (personal data); optional | **Fixed in 5B-3**: with no number (his email-only request) the caller becomes a customer of their own (`call_<uuid>`), 201 every time, never merged |
| `name` | filled in only when the customer has none yet (a staff member may have corrected it); his rule is "the newest name wins" | He adapts (difference on purpose) |
| `email` | accepted and ignored: an end customer has no email column; the address stays in the request's `data` | Open (does the product want a customer email? question for Abdul) |
| (not in his body) `locale`, `agentId` | optional: language (only when empty) and the agent whose call it is | OK |
| answer | `{ endCustomerId, created }`, 201 or 200 | He adapts |

### 4. Tenant status check: `GET /internal/tenants/{tenantId}/status?agentId=` (his B1)

| Topic | His | Backend | Verdict |
|---|---|---|---|
| Answer | `{ tenantId, serviceable, reason, plan }` | the same four plus `agentId` and `overage` | OK (a superset) |
| `reason` | `suspended`, `unpaid`, `quota_exceeded`, `unknown_tenant` | those, plus `agent_disabled` and `unknown_agent`; `unpaid` is reserved and never answered | He adapts: treat an unknown reason as "not serviceable" (question) |
| Unknown tenant | maps to his 404 | normal 200 with `reason: unknown_tenant` (nothing leaks, cacheable) | He maps (as he does) |
| Cache | about 60 seconds | `Cache-Control: private, max-age=10`; answered live | Question to him |
| Agent | none | optional `?agentId=`; default = the tenant's default agent | OK |

### 5. Agents and settings: `GET /internal/tenants/{tenantId}/agents` and `…/agents/{agentId}/config` (his B2)

| Topic | His | Backend | Verdict |
|---|---|---|---|
| Agent list | `{ agents: [{ agentId, name, status, isDefault }] }`, default first | exactly that (built in 5B-3); an unknown tenant is 404 `TENANT_NOT_FOUND` | OK |
| Status words | `active`, `archived` | `active`, `disabled` | He maps |
| Default agent | cannot be archived | may be **disabled**, never deleted (Abdul, 2026-10-29) | Question to him |
| Config answer | `{ config: {…, agentId, name, status, isDefault}, version }`; no `agentId` means the default agent | `{ tenantId, agentId, version, status, config }`; identity fields are beside the document and in the list; the default agent's id comes from the list | He adapts |
| Caching | 60 s in-process | `Cache-Control: private, max-age=60`, `ETag`, 304; `?version=n` pins a past version | OK |
| Disabled agent | refused where it would answer a caller | 200 with `status: "disabled"` (and its settings) so he can play his own "not available" line | He adapts |

**The settings document** (what staff save through the backend and what the pull returns). The engine owns the field list, so the backend checks structure only and **keeps every key it does not know exactly as sent** (top level and inside `escalation`), inside a 64 KB limit:

| Field | His limits | Backend check | Verdict |
|---|---|---|---|
| `businessName`, `purpose`, `tone`, `replyLanguage`, `uiLocale` | 120, 2,000, four tones, `en`/`ur`, `en`/`ur` | the same | OK (his `uiLocale` is one per tenant, on the default agent; the backend stores one per agent document: question) |
| `timezone` | any string | a real IANA name (`UTC` and `Asia/Karachi` pass) | OK for his values; a non-IANA string is refused |
| `hours` | `{ mon: [["09:00","17:00"]], … }` | the same, at most 5 ranges a day, no overlap, end after start; null allowed | OK |
| `escalation` `enabled`, `contacts` (5, text 60), `whenCallerAsks`, `afterMisses` 1 to 4, `topics` (10, 40), `outsideHours` | as his `handoff/config.js` | the same; a phone must be international (`+…` or `00…`), his code also accepts a Pakistani local number (`0300…`) and stores `+92…`; every document that comes **from** him is already international | OK; a dashboard must send international numbers |
| `escalation.announce` `{ en?, ur? }` | 200 characters, placeholders `{name}`, `{role}` | an object with `en`/`ur` strings up to 200 | **Fixed in 5B-3** (was refused as an unknown key) |
| unknown keys inside `escalation` | n/a | kept as sent | **Fixed in 5B-3** |
| `capabilities`, `voices` | his catalogue and voice ids | object shape only (50 and 10 entries); ids unchecked | OK (his validation stays his) |
| `greeting` `{ en?, ur? }` | 400 characters each, `{business}` only | object with `en`/`ur` strings up to 400, trimmed, empty dropped; the placeholder rule is his | **Fixed in 5B-3** |
| `recordCalls`, `autoEndCalls` | booleans | booleans | **Fixed in 5B-3** |
| `endCallDelaySeconds` | integer 2 to 10 | the same | **Fixed in 5B-3** |
| `profileSummary` | string up to 1,200 or null; a price is refused | string up to 1,200 or null; the price rule is his | **Fixed in 5B-3** |
| `profileSummarySources` | `[{ id, title, hash }]`, up to 10, recorded by the engine, never taken from a client | the same shape and limit; stored as sent | **Fixed in 5B-3** (who writes it, since the dashboard saves through the backend, is a 5F question) |
| `collect`, `collectVersion` | his checklist document and its version | `collect` opaque (depth 12, 20,000 nodes); `collectVersion` is just a kept unknown key, the backend does not count it | OK; open for 5F (who bumps it) |
| `exists`, `tenantId`, `updatedAt`, `summaryStatus` (his read answer extras) | not settings | never part of a stored document unless a client sends them (then kept as unknown keys) | OK |

New agents get the minimal document (no engine fields): his own defaults apply when a key is missing (built-in greeting, recording off, call ends by itself after 3 seconds).

### 6. Events: `POST /internal/events` (his B7)

| Event | His payload | Backend | Verdict |
|---|---|---|---|
| Envelope | `{ id, type, tenantId, occurredAt, data }` | the same; HMAC over `<timestamp>.<raw body>` with `INTERNAL_API_TOKEN` | OK; the signing scheme is ours (he builds the sender) |
| `record.submitted` | `{ recordId, recordType, reference, agentId, conversationId }` | handled: finds the request under the envelope tenant by `recordId`, else by `reference`; extra fields and nulls ignored | OK (**fixed in 5B-3**: an id that is no request of ours used to make the event a silent no-op) |
| `record.updated` | `{ recordId, status, detailsChanged? }` | handled: a live update with the backend's own status | OK |
| `handoff.requested`, `handoff.unavailable` | `{ conversationId, agentId, channel, reason, contactId }` | **acknowledged and ignored**: not a handled type, so the delivery is stored once in the inbox, logged by type and tenant only and answered 200 `ignored`; nothing is notified | OK (no new feature; a later phase may use them for call history) |
| `usage.call_minutes` | proposed `{ conversationId, seconds, channel }` | acknowledged, not stored until Phase 5E; we will ask for `callId` and `agentId` too | Open (5E) |
| delivery | outbox, retries with backoff on non-2xx, same id | idempotent by `(tenant, id)`, 200 `duplicate` the second time | OK |

### 7. Numbers and the telephone call (his B11): NOT BUILT, Phase 5D

| Topic | His | Backend (contract only) | Verdict |
|---|---|---|---|
| Who answers the provider | the engine (signed webhook, number lookup, one-minute ticket, audio) | the same (engine first, L8 revised 2026-10-29); **the backend signs no ticket** | OK |
| Lookup | `GET /internal/numbers/{e164}` → `{ tenantId, agentId \| null, numberId, status: active \| released }`, 404 for a number never held | exactly that, called on every inbound call (`+` sent as `%2B`); refusals stay his; the status check is a separate call | Contract written, route built in 5D |
| His refusal reasons | `invalid_number`, `unknown`, `released`, `unassigned`, `agent_archived`, `tenant_unserviceable` | derived by him from the answer: 404, `status: released`, `agentId: null`, the agent's status (`disabled` = `archived`) and the status check | OK |
| Dashboard test call | `POST /api/voice/session?agentId=` (one-minute browser ticket) | the backend calls it with the service credential and returns the ticket to the browser | Question: his route is an OLD one (`x-internal-key`, `?tenantId=`); will he accept Bearer plus `X-Tenant-Id`? |
| Twilio account | the engine needs `TWILIO_AUTH_TOKEN` and `TWILIO_ACCOUNT_SID`; one account per engine assumed | the backend's account buys numbers (same account) | Accepted exception (L8) |

### What the backend changed because of this comparison

1. The settings validator no longer refuses an unknown top-level or `escalation` key (kept verbatim) and checks the seven new fields with his own limits.
2. `order` is a request type (CHECK constraint widened by `20261029200000_phase5b3_order_requests`, notification text in English and Urdu, mock engine `/order` and `simulateCall({ type: 'order' })`).
3. `GET /internal/tenants/{tenantId}/agents` exists.
4. The customer upsert takes no `phone`: a caller with no number becomes a customer of their own.
5. `record.*` events fall back to the reference when the id is not ours.
6. The contract files say what they should: the real `record.*` payloads (`recordType`, no `reference` on `record.updated`), `handoff.*`, the number lookup as the engine's call on every inbound call, no backend-signed ticket.

## Run the human hand-off (Phase 4)

```bash
MAIL_MODE=link npm run start:dev        # one terminal (ENGINE_MODE defaults to mock)
npm run handoff:walkthrough              # another: signs up a throwaway tenant, two agents and a customer, then walks
                                         # ask -> AI answers -> /escalate -> live event + notification -> claim (a colleague is too late)
                                         # -> reply reaches the widget stream -> release -> AI resumes -> /action -> resolve -> audit log
```

By hand, with a staff token `$AGENT` for tenant `$TENANT` and the customer's widget token `$TOKEN` (see above):

```bash
# the customer asks for a human (any message with "human", "agent", "representative" or "/escalate")
curl -N $API/v1/widget/messages -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"content":"I want a human"}'

# the dashboard stream (-N: no buffering); use a ticket from a browser, see below
curl -N $API/v1/tenants/$TENANT/events -H "Authorization: Bearer $AGENT"
#   event: conversation.escalated   data: {"conversationId":"…","reason":"customer_requested"}
#   event: notification.created     data: {"notificationId":"…","type":"conversation.escalated"}

# the customer's live stream (read this one with fetch in a browser; curl shows the same)
curl -N $API/v1/widget/events -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN"

# the queue, the notification, then take it, answer it, hand it back
curl -s "$API/v1/tenants/$TENANT/conversations?status=escalated&sort=escalatedAt" -H "Authorization: Bearer $AGENT"
curl -s "$API/v1/tenants/$TENANT/notifications?unread=true" -H "Authorization: Bearer $AGENT"
curl -s -X POST $API/v1/tenants/$TENANT/conversations/$CONV/claim -H "Authorization: Bearer $AGENT"
curl -s -X POST $API/v1/tenants/$TENANT/conversations/$CONV/messages -H "Authorization: Bearer $AGENT" -H 'Content-Type: application/json' -d '{"content":"Hi, how can I help?"}'
curl -s -X POST $API/v1/tenants/$TENANT/conversations/$CONV/release -H "Authorization: Bearer $AGENT" -H 'Content-Type: application/json' -d '{}'
```

## What the dashboard needs to know (Phase 4)

* **Conversations** (`/v1/tenants/:tenantId/conversations`, every role): list (`status` comma-separated, `assignedTo=me|<userId>`, `customerId`, `sort=escalatedAt` for the queue, `{data,total,skip,take}`), `counts` (`{ counts: {active, escalated, human_active, resolved}, assignedToMe }`), `:id` (conversation + paginated messages, default 50), `claim`, `release` (`{ to: "active" | "escalated" }`), `resolve`, `messages` (`{ content }`, 2,000 characters). A conversation is `{ id, endCustomerId, customer: { name, externalId, channel }, channel, status, assignedUserId, assignedUserName, escalatedAt, escalationReason, summary, lastMessageAt, resolvedAt, resolvedBy, createdAt }`; a message is `{ id, authorType, authorUserId, authorName, content, contentKey, createdAt }` (system lines have an empty `content` and a `contentKey` of the widget namespace, translate it). `customer.externalId` of an anonymous visitor is shortened (`web_ab12cd…`); show "Website visitor" plus that when `name` is null. Errors: 404 `CONVERSATION_NOT_FOUND` (also another tenant's), 409 `CONVERSATION_ALREADY_CLAIMED`, `CONVERSATION_NOT_ASSIGNED_TO_YOU` (reply, release and resolve are for the person who holds it, whatever their role), `CONVERSATION_RESOLVED`, 400 `MESSAGE_TOO_LONG`. Commands accept an optional `Idempotency-Key`. The customer view is `GET …/customers/:id/conversations`.
* **Live stream** `GET /v1/tenants/:tenantId/events`: events `conversation.escalated|assigned|released|resolved` `{conversationId}`, `message.created` `{conversationId, messageId, authorType}`, `action.proposed` `{actionId}`, `notification.created` `{notificationId, type}` (only on that user's own streams), plus `ready`, `resync` (reload your lists) and `closed` `{reason}`. Authenticate with the `Authorization` header (from the server-side proxy) or, from a browser `EventSource`, `POST …/events/ticket` then `?ticket=` (single use, 30 seconds: ask for a new one for EVERY connection and reconnect). Resume with `Last-Event-ID` (or `?lastEventId=`); 5 streams per user; a stream ends after an hour or when the user is disabled.
* **Notifications** (`/v1/tenants/:tenantId/notifications`, own rows only): `?unread=true`, `POST :id/read`, `POST read-all`; the unread count is `unreadNotifications` in `GET /v1/me`. Render `<type>.title` / `<type>.body` of the `notifications` namespace with `params`; the params of every type are in docs/architecture.md section 5.7.
* Other changes of Phase 3B: signup password at most 72 bytes; `GET /v1/auth/invites/preview?token=` for the accept page; 429 answers carry `Retry-After` (header, readable through CORS) and `retryAfterSeconds`; locale fields accept any code of `GET /v1/i18n/locales`; agents no longer see `passwordChangedAt` / `emailVerifiedAt` in the user list; `PATCH /v1/me` accepts `name: null`; all DELETE routes answer 200 with the removed object (unchanged).

## Open questions for the AI engine owner (Phase 3)

1. `POST /internal/conversations/{id}/escalate` and the `aiReply` flag on `…/messages` are the two additions to Appendix A (D7 says the conversation is "marked escalated with reason ai_unavailable" but not who does it, and I5 needs a message to be stored without a reply). Acceptable?
2. Does the stream really `accepted` → `token`* → `usage` → `escalated`? → `done`, with the assistant message id in `usage` and `done`? The backend counts usage from them.
3. Idempotent replay of a message (same `Idempotency-Key`): the contract says the stored reply comes back as one `token` event plus `done`. Confirm.
4. Reasons: the backend sets `ai_unavailable` and `limit_reached`; the frontend prototype used `plan_limit` for the second, which should be `limit_reached`.
5. System lines (agent joined / left) must come as `contentKey`, not English text.

## Open questions for the AI engine owner (Phase 4)

All of the following are the backend's proposals (see J9 in team-alignment); please confirm or change:

6. **Staff calls** (`engine-internal.openapi.yaml`): `GET /internal/conversations` (filters `status` comma-separated, `assignedUserId`, `endCustomerId`, `sort=escalatedAt` oldest first, pagination), `GET /internal/conversation-counts`, `POST …/claim`, `…/release` (`to`: `active`, `escalated`, `resolved`; `force` only for a holder who was disabled or deleted), `…/resolve`, `…/human-messages`. Release to `resolved` and `resolve` are the same; the backend uses `resolve`.
7. **Atomic claim and the 409 codes** `CONVERSATION_ALREADY_CLAIMED`, `CONVERSATION_RESOLVED`, `CONVERSATION_NOT_ASSIGNED_TO_YOU`: the backend checks the rules itself first and again with the engine's answer, so the engine must enforce them atomically (one claimant wins a race) and answer 409 with these codes. The same `Idempotency-Key` on a claim that already succeeded should answer 200, not 409.
8. **Extra conversation fields** the dashboard needs: `assignedUserId`, `escalatedAt`, `summary`, `resolvedAt`, `resolvedBy` (C1), and the `X-Acting-User-Id` / `X-Acting-Role` headers on staff calls (for your audit; never a source of the tenant).
9. **System lines**: the engine writes `agent.joined` on claim, `agent.left` on release and `resolved.notice` on resolve as `system` messages with `contentKey` (keys of the backend's `widget` namespace) and an empty text.
10. **The event receiver** (`backend-events.openapi.yaml`): HMAC signing over `<timestamp>.<raw body>` (instead of sending the token), the envelope, retries on non-2xx, and the event types and payloads above, including `conversation.released`, `message.created` carrying `content` only for `human` and `system` messages, and `usage.recorded` per assistant message. Without these events the dashboard stream, the notifications and the customer's live stream stay silent.
11. **While `human_active` the engine must not generate AI replies** and must re-check the status in the same transaction before it answers (C4); a customer message in that state is stored and answered with `done` and `aiReply: false`.
