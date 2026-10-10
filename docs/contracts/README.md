# Contracts: the AI engine and the widget gateway

| File | What it is | Status |
|---|---|---|
| [engine-internal.openapi.yaml](engine-internal.openapi.yaml) | The part of the engine's internal API the backend calls to run a chat (create conversation, send a message and stream the reply, read a conversation, escalate, health) | **Proposed by the backend (Phase 3), to be reviewed by the AI engine owner.** Two calls are not in team-alignment Appendix A yet and are marked "proposed addition" in the file. |
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
| anything with "hours", "delivery", "price" | A canned answer | `token…`, `done` |

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

**History** (`GET /v1/widget/conversation?skip=&take=`): `{ id, status, data: [{ id, authorType: customer|ai|human|system, content, contentKey?, createdAt }], total, skip, take }`, oldest first. System lines such as "an agent joined" arrive as `contentKey` (a key of the `widget` namespace), not English text. No staff identities.

**CORS**: only the origins on the widget key may read these responses; the preflight is answered for origins that some active widget key lists, and the real answer carries `Access-Control-Allow-Origin` only after the key and origin matched. There are no cookies and no `*`. Dashboard routes keep `FRONTEND_URL`.

**Texts**: the widget namespace (`GET /v1/i18n/:locale/widget`) has `greeting.default`, `persona.default`, `fallback.service_unavailable|limit_reached|ai_unavailable`, `escalated.notice`, `human.label`, `error.*`; the API already returns the right text for greetings and fallbacks, in the visitor's language. The Urdu text was written by an AI and needs a native speaker's review (`CLAUDE.md`). Per-tenant wording (greeting, fallback message) comes from `agent_config` in Phase 5; the code has one hook for it (`WidgetSettingsProvider`).

## What the gateway promises about the engine

* The engine receives `X-Tenant-Id` from the verified widget token only, never from the browser's body, URL or message text. A conversation id from another tenant answers 404 (tested with two tenants and two visitors).
* Engine calls carry `X-Request-Id` (the request's id) and an `Idempotency-Key`; plain calls retry **once**, only when the connection broke; a reply stream waits 5 s for the first token and 30 s in total (`ENGINE_FIRST_TOKEN_TIMEOUT_MS`, `ENGINE_TOTAL_TIMEOUT_MS`); then the customer gets the `ai_unavailable` fallback and the gateway asks the engine to escalate (`POST …/escalate`, reason `ai_unavailable`). If the engine cannot be reached for that either, the escalation is remembered (`gateway_conversations.escalation_pending`) for a later phase to deliver.
* Over the plan limit the gateway stores the message with `aiReply: false` and escalates with `limit_reached`; **the model is not called**. A suspended or closed tenant makes no engine call at all.
* Message text is never logged. Engine error details never reach a customer.

## Events the backend relies on (receiver built in Phase 4)

`POST /internal/events` is **not** built yet. These names are fixed now so the engine can implement against them:
`conversation.created`, `conversation.escalated`, `conversation.resolved`, `message.created`, `usage.recorded` (`{ conversationId, messageId, tokensIn, tokensOut, model }`), plus the later `action.proposed`, `action.executed`, `call.ended`, `ingestion.completed`, `ingestion.failed` (D5). The gateway already counts usage from the reply stream, keyed by conversation id and message id (`usage_events`), so a later `usage.recorded` for the same message is a no-op.

## Open questions for the AI engine owner

1. `POST /internal/conversations/{id}/escalate` and the `aiReply` flag on `…/messages` are the two additions to Appendix A (D7 says the conversation is "marked escalated with reason ai_unavailable" but not who does it, and I5 needs a message to be stored without a reply). Acceptable?
2. Does the stream really `accepted` → `token`* → `usage` → `escalated`? → `done`, with the assistant message id in `usage` and `done`? The backend counts usage from them.
3. Idempotent replay of a message (same `Idempotency-Key`): the contract says the stored reply comes back as one `token` event plus `done`. Confirm.
4. Reasons: the backend sets `ai_unavailable` and `limit_reached`; the frontend prototype used `plan_limit` for the second, which should be `limit_reached`.
5. System lines (agent joined / left) must come as `contentKey`, not English text.
