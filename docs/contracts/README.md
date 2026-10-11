# Contracts: the AI engine and the widget gateway

| File | What it is | Status |
|---|---|---|
| [engine-internal.openapi.yaml](engine-internal.openapi.yaml) | The part of the engine's internal API the backend calls: run a chat (create conversation, send a message and stream the reply, read a conversation, escalate, health) and, since Phase 4, the staff side (list, counts, claim, release, resolve, human messages) | **Proposed by the backend (Phases 3 and 4), to be reviewed by the AI engine owner.** Everything that is not in team-alignment Appendix A yet is marked "proposed addition" in the file. |
| [backend-events.openapi.yaml](backend-events.openapi.yaml) | The one route of the backend that the engine calls: `POST /internal/events` (signature, envelope, event types and payloads, delivery rules) | **Proposed by the backend (Phase 4), to be reviewed by the AI engine owner.** Outside `/v1`, not in the public OpenAPI. |
| [../openapi.json](../openapi.json) | The public API of the backend, including `/v1/widget/*` and `/v1/tenants/:tenantId/api-keys` | Generated: `npm run openapi:export` |

The backend talks to the engine only through `EngineClient` (`src/engine/`). `ENGINE_MODE` chooses the implementation:

| `ENGINE_MODE` | What answers | When |
|---|---|---|
| `mock` (default outside production) | An in-process mock engine that follows the contract, keeps conversations in memory and streams a canned reply token by token | Development, tests, the frontend prototype |
| `http` | The real engine at `ENGINE_BASE_URL`, with `Authorization: Bearer $INTERNAL_API_TOKEN`, `X-Tenant-Id`, `X-Request-Id`, `Idempotency-Key` | Staging and production. **Production refuses to start in any other mode.** |

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
| `/slow` | The model never answers: the 5 s first-token timeout fires | `accepted`, then after ~5 s `fallback` `ai_unavailable` |
| `/broken` | A few words, then the stream fails | `token`, then `fallback` `ai_unavailable` |
| `/action` | The AI answers and proposes an action that needs approval: the engine emits `action.proposed` (owners and admins get a notification) | `token…`, `done`; no change for the customer |
| anything with "hours", "delivery", "price" | A canned answer | `token…`, `done` |

Since Phase 4 the mock also plays the staff side and pushes the events of D5 (`conversation.created|escalated|assigned|released|resolved`, `message.created`, `usage.recorded`, `action.proposed`) to the backend's receiver in process, exactly as the real engine will with `POST /internal/events`. So the dashboard, the notifications and the widget's live stream can be driven without the engine, see "Run the human hand-off" below.

The blocked and limit paths do not need the mock; they come from the tenant itself:

* **Plan limit** (`status: "limited"`, messages answered with `fallback` `limit_reached`): as a platform admin,
  `POST /v1/admin/tenants/$TENANT/subscription/change-plan` with `{"planCode":"free","entitlementsOverride":{"conversationsPerPeriod":1}}`, then start sessions with new visitor ids. A visitor with an open conversation is never stopped by the limit.
* **Blocked tenant** (`status: "blocked"`, no token): `PATCH /v1/admin/tenants/$TENANT` with `{"status":"suspended"}`. Set it back to `active` afterwards.

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
* Engine calls carry `X-Request-Id` (the request's id) and an `Idempotency-Key`; plain calls retry **once**, only when the connection broke; a reply stream waits 5 s for the first token and 30 s in total (`ENGINE_FIRST_TOKEN_TIMEOUT_MS`, `ENGINE_TOTAL_TIMEOUT_MS`); then the customer gets the `ai_unavailable` fallback and the gateway asks the engine to escalate (`POST …/escalate`, reason `ai_unavailable`). If the engine cannot be reached for that either, the escalation is remembered (`gateway_conversations.escalation_pending`) for a later phase to deliver.
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
| `action.proposed` | notification for owners and admins, `action.proposed` on the dashboard stream |

Message text travels in `message.created` only for `human` and `system` messages. Later: `action.executed`, `call.ended`, `ingestion.completed`, `ingestion.failed` (acknowledged and ignored today).

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
