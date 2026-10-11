/**
 * Walks the whole human hand-off (Phase 4) against a RUNNING backend that uses the mock engine
 * (ENGINE_MODE=mock, the default outside production) and MAIL_MODE=link (invite links in the
 * response). It plays three people at once: a customer in the widget, an agent and a colleague in
 * the dashboard, and the owner.
 *
 *   customer asks -> the AI answers -> the customer asks for a human -> the team gets a live event
 *   and a notification -> the agent claims (a colleague is too late) -> the agent replies and the
 *   customer sees it in the widget stream -> the agent hands back and the AI answers again -> the AI
 *   proposes an action and the owner is notified -> the colleague claims and resolves -> the widget
 *   is told -> the audit log shows who did what.
 *
 *   MAIL_MODE=link npm run start:dev                   # in one terminal
 *   npm run handoff:walkthrough                        # in another
 *
 * Settings (environment): BASE_URL (default http://localhost:3000) and WIDGET_ORIGIN (the website
 * the widget runs on, default http://localhost:3001). It leaves a throwaway tenant behind (tenants
 * cannot be deleted), so point it at a development database only.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readSse } from '../src/engine/sse-parser';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);
const ORIGIN = process.env.WIDGET_ORIGIN ?? 'http://localhost:3001';
const PASSWORD = 'correct-horse-battery';

type Json = Record<string, any>;
interface Seen {
  event: string;
  data: Json;
}

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

/** Reads a server-sent event stream in the background; `seen` fills up as events arrive. */
function listen(label: string, url: string, headers: Record<string, string>) {
  const seen: Seen[] = [];
  const controller = new AbortController();
  void (async () => {
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok || !res.body) {
        console.error(`${label}: stream refused with HTTP ${res.status}`);
        process.exit(1);
      }
      for await (const raw of readSse(res.body)) {
        const data = raw.data ? (JSON.parse(raw.data) as Json) : {};
        seen.push({ event: raw.event, data });
        if (raw.event !== 'ready') {
          console.log(`  [${label}] ${raw.event} ${JSON.stringify(data)}`);
        }
      }
    } catch {
      // closed by us
    }
  })();
  return {
    seen,
    close: () => controller.abort(),
    async waitFor(predicate: (e: Seen) => boolean, what: string, ms = 4000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const found = seen.find(predicate);
        if (found) {
          check(true, what);
          return found;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      check(false, `${what} (nothing arrived within ${ms} ms)`);
      throw new Error('unreachable');
    },
  };
}

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
  const events: Seen[] = [];
  let reply = '';
  if (res.ok && res.body) {
    for await (const raw of readSse(res.body)) {
      const data = JSON.parse(raw.data) as Json;
      events.push({ event: raw.event, data });
      if (raw.event === 'token') reply += data.text;
    }
  }
  console.log(`assistant> ${reply || '(no AI reply)'}`);
  return events;
}

async function main() {
  const run = randomBytes(3).toString('hex');
  const visitorId = `walkthrough-${run}-visitor`.padEnd(24, '0');

  step('1. A tenant with an owner and two staff members');
  const signup = await api('POST', '/v1/auth/signup', {
    body: {
      tenantName: `Handoff ${run}`,
      ownerEmail: `owner.${run}@example.test`,
      ownerPassword: PASSWORD,
    },
  });
  check(signup.status === 201, 'tenant created');
  const tenantId = signup.json.tenant.id as string;
  const owner = signup.json.access_token as string;
  const verify = new URL(signup.json.verificationLink).searchParams.get(
    'token',
  );
  await api('POST', '/v1/auth/verify-email', { body: { token: verify } });

  const hire = async (name: string) => {
    const invite = await api('POST', `/v1/tenants/${tenantId}/invites`, {
      token: owner,
      body: { email: `${name}.${run}@example.test`, role: 'agent' },
    });
    check(invite.status === 201 && invite.json.link, `${name} invited`);
    const token = new URL(invite.json.link).searchParams.get('token');
    const accepted = await api('POST', '/v1/auth/invites/accept', {
      body: { token, password: PASSWORD, name },
    });
    check(accepted.status === 201, `${name} joined`);
    return {
      id: accepted.json.user.id as string,
      token: accepted.json.access_token as string,
      name,
    };
  };
  const hina = await hire('Hina');
  const bilal = await hire('Bilal');

  step('2. The widget key and the customer’s session');
  const key = await api('POST', `/v1/tenants/${tenantId}/api-keys`, {
    token: owner,
    body: { name: 'Demo site', allowedOrigins: [ORIGIN] },
  });
  check(key.status === 201, 'widget key created');
  const session = await api('POST', '/v1/widget/sessions', {
    origin: ORIGIN,
    body: { widgetKey: key.json.key, visitorId },
  });
  check(session.json.status === 'ready', 'session ready');
  const customerToken = session.json.token as string;
  const conversationId = session.json.conversationId as string;

  step(
    '3. Hina opens the dashboard stream (with a ticket, like a browser) and the widget listens',
  );
  const ticket = await api('POST', `/v1/tenants/${tenantId}/events/ticket`, {
    token: hina.token,
  });
  check(ticket.status === 200, 'single-use ticket issued (30 s)');
  const dashboard = listen(
    'dashboard',
    `${BASE}/v1/tenants/${tenantId}/events?ticket=${ticket.json.ticket}`,
    {},
  );
  const reuse = await fetch(
    `${BASE}/v1/tenants/${tenantId}/events?ticket=${ticket.json.ticket}`,
  );
  check(reuse.status === 401, 'the same ticket a second time -> 401');
  const owners = listen('owner', `${BASE}/v1/tenants/${tenantId}/events`, {
    Authorization: `Bearer ${owner}`,
  });
  const widget = listen('widget', `${BASE}/v1/widget/events`, {
    Authorization: `Bearer ${customerToken}`,
    Origin: ORIGIN,
  });
  await dashboard.waitFor((e) => e.event === 'ready', 'dashboard stream open');
  await widget.waitFor((e) => e.event === 'ready', 'widget stream open');

  step(
    '4. The customer asks, the AI answers, then the customer asks for a human',
  );
  const hours = await say(customerToken, 'What are your opening hours?');
  check(hours.at(-1)?.data.aiReply === true, 'the AI answered');
  const handoff = await say(customerToken, 'I want to talk to a human');
  check(
    handoff.some((e) => e.event === 'escalated'),
    'the conversation was escalated',
  );

  step('5. The team is told: live event and in-app notification');
  await dashboard.waitFor(
    (e) => e.event === 'conversation.escalated',
    'live event: conversation.escalated',
  );
  await dashboard.waitFor(
    (e) => e.event === 'notification.created',
    'live event: notification.created',
  );
  const bell = await api(
    'GET',
    `/v1/tenants/${tenantId}/notifications?unread=true`,
    { token: hina.token },
  );
  check(bell.json.total === 1, 'Hina has 1 unread notification');
  console.log(`  ${JSON.stringify(bell.json.data[0])}`);
  const me = await api('GET', '/v1/me', { token: hina.token });
  check(
    me.json.unreadNotifications === 1,
    'GET /v1/me carries unreadNotifications: 1',
  );
  const queue = await api(
    'GET',
    `/v1/tenants/${tenantId}/conversations?status=escalated&sort=escalatedAt`,
    { token: hina.token },
  );
  check(
    queue.json.data[0]?.id === conversationId,
    'the conversation is first in the queue',
  );
  console.log(
    `  customer: ${JSON.stringify(queue.json.data[0].customer)}; summary: ${queue.json.data[0].summary}`,
  );

  step('6. Hina claims it; Bilal is too late; the owner may not reply into it');
  const claimUrl = `/v1/tenants/${tenantId}/conversations/${conversationId}`;
  const claimed = await api('POST', `${claimUrl}/claim`, { token: hina.token });
  check(
    claimed.status === 200 && claimed.json.assignedUserName === 'Hina',
    'Hina claimed it',
  );
  const late = await api('POST', `${claimUrl}/claim`, { token: bilal.token });
  check(
    late.status === 409 && late.json.code === 'CONVERSATION_ALREADY_CLAIMED',
    'Bilal -> 409 CONVERSATION_ALREADY_CLAIMED',
  );
  const intruder = await api('POST', `${claimUrl}/messages`, {
    token: owner,
    body: { content: 'I am the owner' },
  });
  check(
    intruder.status === 409 &&
      intruder.json.code === 'CONVERSATION_NOT_ASSIGNED_TO_YOU',
    'the owner -> 409 CONVERSATION_NOT_ASSIGNED_TO_YOU',
  );
  await widget.waitFor(
    (e) => e.event === 'message' && e.data.contentKey === 'agent.joined',
    'the widget shows "an agent joined"',
  );

  step('7. Hina replies; the customer sees it without sending anything');
  const reply = await api('POST', `${claimUrl}/messages`, {
    token: hina.token,
    body: { content: 'Hi, this is Hina. How can I help?' },
  });
  check(reply.status === 201, 'reply stored');
  await widget.waitFor(
    (e) => e.event === 'message' && e.data.authorType === 'human',
    'the widget received the human reply',
  );
  const during = await say(customerToken, 'My order number is 4711');
  check(
    during.at(-1)?.data.aiReply === false,
    'the AI stays silent while a human is active',
  );

  step(
    '8. Hina hands back: the AI resumes; the AI proposes an action and the owner is notified',
  );
  const released = await api('POST', `${claimUrl}/release`, {
    token: hina.token,
    body: {},
  });
  check(
    released.status === 200 && released.json.status === 'active',
    'released to the AI',
  );
  await widget.waitFor(
    (e) => e.event === 'status' && e.data.status === 'active',
    'the widget is told the AI is back',
  );
  const resumed = await say(customerToken, 'What is the delivery time?');
  check(resumed.at(-1)?.data.aiReply === true, 'the AI answered again');
  await say(customerToken, '/action please refund my order');
  await owners.waitFor(
    (e) => e.event === 'action.proposed',
    'live event: action.proposed (owners and admins)',
  );
  const ownerBell = await api(
    'GET',
    `/v1/tenants/${tenantId}/notifications?unread=true`,
    { token: owner },
  );
  check(
    ownerBell.json.data.some((n: Json) => n.type === 'action.proposed'),
    'the owner has an action.proposed notification',
  );

  step('9. A second escalation: Bilal claims and resolves');
  await say(customerToken, '/escalate');
  const again = await api('POST', `${claimUrl}/claim`, { token: bilal.token });
  check(again.status === 200, 'Bilal claimed it');
  const resolved = await api('POST', `${claimUrl}/resolve`, {
    token: bilal.token,
  });
  check(
    resolved.status === 200 && resolved.json.status === 'resolved',
    'resolved',
  );
  await widget.waitFor(
    (e) => e.event === 'status' && e.data.status === 'resolved',
    'the widget is told it is resolved',
  );
  const next = await say(customerToken, 'One more question');
  check(
    next.some(
      (e) => e.event === 'error' && e.data.code === 'CONVERSATION_RESOLVED',
    ),
    'a message to a resolved conversation -> CONVERSATION_RESOLVED (start a new session)',
  );

  step('10. The audit log');
  const audit = await api('GET', `/v1/tenants/${tenantId}/audit-logs?take=50`, {
    token: owner,
  });
  const lines = (audit.json.data as Json[])
    .filter((e) => e.targetType === 'conversation')
    .reverse()
    .map(
      (e) => `${e.action} by ${e.actorUserId === hina.id ? 'Hina' : 'Bilal'}`,
    );
  console.log(`  ${lines.join('\n  ')}`);
  check(
    lines.join('|') ===
      'conversation.claimed by Hina|conversation.released by Hina|conversation.claimed by Bilal|conversation.resolved by Bilal',
    'claim, release, claim, resolve are audited (no message text)',
  );

  dashboard.close();
  owners.close();
  widget.close();
  console.log('\nHand-off walkthrough finished: every step passed.');
}

main().catch((error: Error) => {
  console.error(error);
  process.exit(1);
});
