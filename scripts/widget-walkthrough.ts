/**
 * Walks the whole widget flow against a RUNNING backend that uses the mock engine
 * (ENGINE_MODE=mock, the default outside production):
 *
 *   sign up a throwaway tenant -> create a widget key -> start a session -> send a message and
 *   read the streamed reply -> force an escalation -> force an engine failure and a slow engine ->
 *   (with platform-admin credentials) hit the conversation limit and suspend the tenant.
 *
 *   npm run start:dev                                  # in one terminal
 *   npm run widget:walkthrough                         # in another
 *
 * Settings (environment): BASE_URL (default http://localhost:3000), WIDGET_ORIGIN (the website the
 * widget runs on, default http://localhost:3001), and optionally PLATFORM_ADMIN_EMAIL and
 * PLATFORM_ADMIN_PASSWORD for the limit and suspension steps. It leaves a tenant behind (tenants
 * cannot be deleted), so point it at a development database only.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readSse } from '../src/engine/sse-parser';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);
const ORIGIN = process.env.WIDGET_ORIGIN ?? 'http://localhost:3001';
const ADMIN_EMAIL = process.env.PLATFORM_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD;

type Json = Record<string, any>;

async function api(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; origin?: string } = {},
) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token && { Authorization: `Bearer ${options.token}` }),
      ...(options.origin && { Origin: options.origin }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    // not JSON
  }
  return { status: res.status, json };
}

function step(title: string) {
  console.log(`\n=== ${title}`);
}

function check(condition: unknown, what: string) {
  if (!condition) {
    console.error(`FAILED: ${what}`);
    process.exit(1);
  }
  console.log(`ok: ${what}`);
}

/** Sends one customer message and prints the streamed events as they arrive. */
async function say(token: string, content: string) {
  console.log(`\ncustomer> ${content}`);
  const res = await fetch(`${BASE}/v1/widget/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: ORIGIN,
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok || !res.body) {
    console.log(`HTTP ${res.status} ${await res.text()}`);
    return {
      status: res.status,
      events: [] as { event: string; data: Json }[],
    };
  }
  const events: { event: string; data: Json }[] = [];
  process.stdout.write('assistant> ');
  for await (const raw of readSse(res.body)) {
    const data = JSON.parse(raw.data) as Json;
    events.push({ event: raw.event, data });
    if (raw.event === 'token') process.stdout.write(data.text);
    else if (raw.event !== 'accepted') {
      process.stdout.write(`\n  [${raw.event}] ${JSON.stringify(data)}`);
    }
  }
  process.stdout.write('\n');
  return { status: res.status, events };
}

async function main() {
  const run = randomBytes(3).toString('hex');
  const visitor = (n: number) =>
    `walkthrough-${run}-visitor-${n}`.padEnd(24, '0');

  step('1. Sign up a throwaway tenant and create a widget key');
  const signup = await api('POST', '/v1/auth/signup', {
    body: {
      tenantName: `Walkthrough ${run}`,
      ownerEmail: `walkthrough.${run}@example.test`,
      ownerPassword: 'correct-horse-battery',
    },
  });
  check(signup.status === 201, 'tenant created');
  const tenantId = signup.json.tenant.id as string;
  const owner = signup.json.access_token as string;
  const key = await api('POST', `/v1/tenants/${tenantId}/api-keys`, {
    token: owner,
    body: { name: 'Walkthrough site', allowedOrigins: [ORIGIN] },
  });
  check(
    key.status === 201 && key.json.key,
    `widget key created (${key.json.keyPrefix}…)`,
  );
  const widgetKey = key.json.key as string;

  const start = (visitorId: string, origin = ORIGIN) =>
    api('POST', '/v1/widget/sessions', {
      origin,
      body: { widgetKey, visitorId },
    });

  step('2. The wrong website is refused, the right one gets a session');
  const wrong = await start(visitor(0), 'https://evil.example.com');
  check(
    wrong.status === 403 && wrong.json.code === 'ORIGIN_NOT_ALLOWED',
    'wrong origin -> 403 ORIGIN_NOT_ALLOWED',
  );
  const first = await start(visitor(1));
  check(first.status === 200 && first.json.status === 'ready', 'session ready');
  console.log(`greeting: ${first.json.greeting}`);
  const token = first.json.token as string;

  step('3. A message and its streamed reply');
  const reply = await say(token, 'What are your opening hours?');
  check(reply.events[0]?.event === 'accepted', 'accepted first');
  check(reply.events.at(-1)?.event === 'done', 'done last');

  step('4. Forced escalation (/escalate), then a follow-up');
  const escalation = await say(token, '/escalate');
  check(
    escalation.events.some((e) => e.event === 'escalated'),
    'escalated event',
  );
  const followUp = await say(token, 'Is anyone there?');
  check(
    followUp.events.some((e) => e.event === 'escalated'),
    'follow-up says a colleague will reply, no AI answer',
  );

  step(
    '5. Engine failure (/fail) and a model that never answers (/slow, waits ~5 s)',
  );
  const second = (await start(visitor(2))).json;
  const failing = await say(second.token, '/fail');
  check(
    failing.events.at(-1)?.data.reason === 'ai_unavailable',
    'fail -> fallback ai_unavailable',
  );
  const third = (await start(visitor(3))).json;
  const slow = await say(third.token, '/slow');
  check(
    slow.events.at(-1)?.data.reason === 'ai_unavailable',
    'slow -> fallback ai_unavailable',
  );

  step('6. History of the first visitor');
  const history = await fetch(`${BASE}/v1/widget/conversation`, {
    headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN },
  });
  const messages = ((await history.json()) as Json).data as Json[];
  check(
    history.status === 200 && messages.length >= 4,
    `history has ${messages.length} messages`,
  );

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log(
      '\n(set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD to also run the plan-limit and suspended-tenant steps)',
    );
    return;
  }
  const login = await api('POST', '/v1/admin/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  check(login.status === 201, 'platform admin signed in');
  const admin = login.json.access_token as string;

  step(
    '7. Plan limit: allow 1 conversation, then the next visitor is "limited"',
  );
  const change = await api(
    'POST',
    `/v1/admin/tenants/${tenantId}/subscription/change-plan`,
    {
      token: admin,
      body: {
        planCode: 'free',
        entitlementsOverride: { conversationsPerPeriod: 1 },
      },
    },
  );
  check(change.status === 200, 'plan changed with a conversation limit of 1');
  const limited = await start(visitor(4));
  check(limited.json.status === 'limited', 'new visitor -> status "limited"');
  const stored = await say(limited.json.token, 'I need help with my order');
  check(
    stored.events.at(-1)?.data.reason === 'limit_reached',
    'message -> fallback limit_reached (no AI)',
  );
  const resumed = await start(visitor(1));
  check(
    resumed.json.status === 'ready',
    'a visitor with an existing conversation is not stopped',
  );

  step('8. Suspended tenant: blocked state, no token');
  const suspend = await api('PATCH', `/v1/admin/tenants/${tenantId}`, {
    token: admin,
    body: { status: 'suspended' },
  });
  check(suspend.status === 200, 'tenant suspended');
  const blocked = await start(visitor(5));
  check(
    blocked.status === 200 &&
      blocked.json.status === 'blocked' &&
      !blocked.json.token,
    'session -> blocked, no token',
  );
  console.log(`fallback: ${blocked.json.fallback.message}`);
  await api('PATCH', `/v1/admin/tenants/${tenantId}`, {
    token: admin,
    body: { status: 'active' },
  });

  console.log('\nWalkthrough complete.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
