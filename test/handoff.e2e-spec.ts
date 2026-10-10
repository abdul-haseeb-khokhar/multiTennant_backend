import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FakeClock } from '../src/billing/clock';
import { MockEngineClient } from '../src/engine/mock-engine.client';
import { Handoff, installHandoff } from './utils/handoff-fixtures';
import { PrismaMock } from './utils/prisma-mock';
import { SseStream, openStream } from './utils/sse-client';
import { createTestApp } from './utils/test-app';

const KEY_A = 'wk_tenantAKey0123456789abcdefghij';
const KEY_B = 'wk_tenantBKey0123456789abcdefghij';
const ORIGIN_A = 'https://shop-a.example.com';
const ORIGIN_B = 'https://shop-b.example.com';
const VISITOR_1 = 'visitor-one-0123456789abcdef';
const VISITOR_2 = 'visitor-two-0123456789abcdef';

const USERS = {
  'owner-a': { tenantId: 'tenant-a', role: 'owner' },
  'admin-a': { tenantId: 'tenant-a', role: 'admin' },
  'agent-a1': { tenantId: 'tenant-a', role: 'agent' },
  'agent-a2': { tenantId: 'tenant-a', role: 'agent' },
  'agent-b': { tenantId: 'tenant-b', role: 'agent' },
} as const;
type UserId = keyof typeof USERS;

interface SseEvent {
  event: string;
  data: Record<string, any>;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1] ?? 'message',
      data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}'),
    }));
}

describe('Phase 4: human takeover, live streams and notifications (e2e, mocked database, mock engine)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let clock: FakeClock;
  let engine: MockEngineClient;
  let staffToken: Awaited<ReturnType<typeof createTestApp>>['staffToken'];
  let platformToken: (id?: string) => string;
  let allowStaff: () => void;
  let h: Handoff;
  let base: string;
  const opened: SseStream[] = [];

  const http = () => request(app.getHttpServer());
  const as = (id: UserId) =>
    `Bearer ${staffToken({ userId: id, ...USERS[id] })}`;
  const url = (tenant: string, path = '') =>
    `/v1/tenants/${tenant}/conversations${path}`;

  beforeAll(async () => {
    const big = 1_000_000;
    ({ app, prisma, clock, engine, staffToken, platformToken, allowStaff } =
      await createTestApp({
        widgetLimits: {
          sessionPerIp: big,
          sessionPerKey: big,
          sessionPerVisitor: big,
          messagePerIp: big,
          messagePerKey: big,
          messagePerVisitor: big,
          readPerIp: big,
          readPerVisitor: big,
          preflightPerIp: big,
        },
      }));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    engine.reset();
    allowStaff();
    h = installHandoff(prisma, clock, {
      tenants: [
        { id: 'tenant-a', plan: 'pro' },
        { id: 'tenant-b', plan: 'pro' },
      ],
      keys: [
        {
          id: 'key-a',
          tenantId: 'tenant-a',
          key: KEY_A,
          allowedOrigins: [ORIGIN_A],
        },
        {
          id: 'key-b',
          tenantId: 'tenant-b',
          key: KEY_B,
          allowedOrigins: [ORIGIN_B],
        },
      ],
      users: [
        {
          id: 'owner-a',
          tenantId: 'tenant-a',
          role: 'owner',
          name: 'Olivia Owner',
        },
        {
          id: 'admin-a',
          tenantId: 'tenant-a',
          role: 'admin',
          name: 'Adam Admin',
        },
        {
          id: 'agent-a1',
          tenantId: 'tenant-a',
          role: 'agent',
          name: 'Hina Agent',
        },
        { id: 'agent-a2', tenantId: 'tenant-a', role: 'agent', name: null },
        {
          id: 'gone-a',
          tenantId: 'tenant-a',
          role: 'agent',
          status: 'disabled',
        },
        { id: 'agent-b', tenantId: 'tenant-b', role: 'agent', name: 'Bilal' },
      ],
    });
  });

  afterEach(() => {
    while (opened.length) opened.pop()!.close();
  });

  // ---- customer side helpers -----------------------------------------------------------------

  const startSession = async (
    visitorId = VISITOR_1,
    key = KEY_A,
    origin = ORIGIN_A,
  ) => {
    const res = await http()
      .post('/v1/widget/sessions')
      .set('Origin', origin)
      .send({ widgetKey: key, visitorId })
      .expect(200);
    return res.body as {
      token: string;
      conversationId: string;
      status: string;
    };
  };

  const say = async (token: string, content: string, origin = ORIGIN_A) => {
    const res = await http()
      .post('/v1/widget/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', origin)
      .buffer(true)
      .parse((r, done) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (chunk: string) => (body += chunk));
        r.on('end', () => done(null, body));
      })
      .send({ content });
    await engine.flushEvents();
    return { status: res.status, events: parseSse(String(res.body)) };
  };

  /** A conversation that is waiting for a human in tenant A. */
  const escalated = async (visitorId = VISITOR_1) => {
    const session = await startSession(visitorId);
    await say(session.token, '/escalate');
    return session;
  };

  const claim = (user: UserId, id: string, tenant = 'tenant-a') =>
    http()
      .post(url(tenant, `/${id}/claim`))
      .set('Authorization', as(user));

  const staffStream = (user: UserId, tenant = 'tenant-a', query = '') =>
    openStream(`${base}/v1/tenants/${tenant}/events${query}`, {
      Authorization: as(user),
    }).then((stream) => {
      opened.push(stream);
      return stream;
    });

  const widgetStream = (token: string, extra: Record<string, string> = {}) =>
    openStream(`${base}/v1/widget/events`, {
      Authorization: `Bearer ${token}`,
      Origin: ORIGIN_A,
      ...extra,
    }).then((stream) => {
      opened.push(stream);
      return stream;
    });

  // ===========================================================================================

  describe('the staff conversation API', () => {
    it('lists the queue with the customer, sorted by how long they have waited, to every role', async () => {
      const first = await escalated(VISITOR_1);
      await new Promise((r) => setTimeout(r, 5));
      const second = await escalated(VISITOR_2);
      for (const user of ['owner-a', 'admin-a', 'agent-a1'] as UserId[]) {
        const res = await http()
          .get(`${url('tenant-a')}?status=escalated&sort=escalatedAt`)
          .set('Authorization', as(user))
          .expect(200);
        expect(res.body).toMatchObject({ total: 2, skip: 0, take: 20 });
        expect(res.body.data.map((c: any) => c.id)).toEqual([
          first.conversationId,
          second.conversationId,
        ]);
        expect(res.body.data[0]).toMatchObject({
          status: 'escalated',
          channel: 'widget',
          assignedUserId: null,
          assignedUserName: null,
          escalationReason: 'customer_requested',
          summary: 'The customer asked for a human.',
          customer: { name: null, channel: 'widget' },
        });
        // the visitor id is that visitor's secret: only a short label reaches the dashboard
        expect(res.body.data[0].customer.externalId).toMatch(/^web_.{6}…$/);
        expect(JSON.stringify(res.body)).not.toContain(VISITOR_1);
      }
    });

    it('counts the conversations per status and mine', async () => {
      const mine = await escalated(VISITOR_1);
      await escalated(VISITOR_2);
      await claim('agent-a1', mine.conversationId).expect(200);
      const res = await http()
        .get(url('tenant-a', '/counts'))
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(res.body).toEqual({
        counts: { active: 0, escalated: 1, human_active: 1, resolved: 0 },
        assignedToMe: 1,
      });
      const other = await http()
        .get(url('tenant-a', '/counts'))
        .set('Authorization', as('agent-a2'))
        .expect(200);
      expect(other.body.assignedToMe).toBe(0);
    });

    it('filters by assignee ("me" or a user id)', async () => {
      const a = await escalated(VISITOR_1);
      await escalated(VISITOR_2);
      await claim('agent-a1', a.conversationId).expect(200);
      const mine = await http()
        .get(`${url('tenant-a')}?assignedTo=me`)
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(mine.body.data.map((c: any) => c.id)).toEqual([a.conversationId]);
      expect(mine.body.data[0]).toMatchObject({
        assignedUserId: 'agent-a1',
        assignedUserName: 'Hina Agent',
      });
      const nobody = await http()
        .get(`${url('tenant-a')}?assignedTo=me`)
        .set('Authorization', as('agent-a2'))
        .expect(200);
      expect(nobody.body.total).toBe(0);
      const byId = await http()
        .get(
          `${url('tenant-a')}?assignedTo=11111111-1111-4111-8111-111111111111`,
        )
        .set('Authorization', as('owner-a'))
        .expect(200);
      expect(byId.body.total).toBe(0);
      await http()
        .get(`${url('tenant-a')}?assignedTo=not-a-user`)
        .set('Authorization', as('owner-a'))
        .expect(400);
      await http()
        .get(`${url('tenant-a')}?status=bogus`)
        .set('Authorization', as('owner-a'))
        .expect(400);
    });

    it('shows one conversation with its messages: names, system lines as keys, paginated', async () => {
      const { conversationId, token } = await escalated();
      await claim('agent-a1', conversationId).expect(200);
      await http()
        .post(url('tenant-a', `/${conversationId}/messages`))
        .set('Authorization', as('agent-a1'))
        .send({ content: 'Hello, I can help' })
        .expect(201);
      await say(token, 'Thanks!');
      const res = await http()
        .get(url('tenant-a', `/${conversationId}`))
        .set('Authorization', as('agent-a2'))
        .expect(200);
      expect(res.body.conversation).toMatchObject({
        id: conversationId,
        status: 'human_active',
        assignedUserName: 'Hina Agent',
      });
      expect(
        res.body.messages.data.map((m: any) => [
          m.authorType,
          m.authorName,
          m.contentKey,
          m.content,
        ]),
      ).toEqual([
        ['customer', null, null, '/escalate'],
        ['ai', null, null, expect.any(String)],
        ['system', null, 'agent.joined', ''],
        ['human', 'Hina Agent', null, 'Hello, I can help'],
        ['customer', null, null, 'Thanks!'],
      ]);
      expect(res.body.messages).toMatchObject({ total: 5, skip: 0, take: 50 });
      const page = await http()
        .get(`${url('tenant-a', `/${conversationId}`)}?skip=3&take=1`)
        .set('Authorization', as('agent-a2'))
        .expect(200);
      expect(page.body.messages.data.map((m: any) => m.content)).toEqual([
        'Hello, I can help',
      ]);
    });

    it('the customer view lists the conversations of one customer', async () => {
      const { conversationId } = await escalated();
      const list = await http()
        .get(url('tenant-a'))
        .set('Authorization', as('agent-a1'))
        .expect(200);
      const customerId = list.body.data[0].endCustomerId;
      const res = await http()
        .get(`/v1/tenants/tenant-a/customers/${customerId}/conversations`)
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(res.body.data.map((c: any) => c.id)).toEqual([conversationId]);
      // a customer id that does not exist in this tenant
      const missing = await http()
        .get('/v1/tenants/tenant-a/customers/ec-of-nobody/conversations')
        .set('Authorization', as('agent-a1'))
        .expect(404);
      expect(missing.body.code).toBe('CUSTOMER_NOT_FOUND');
    });

    describe('tenant isolation', () => {
      it("tenant B sees none of tenant A's conversations and cannot touch them", async () => {
        const { conversationId } = await escalated();
        const list = await http()
          .get(url('tenant-b'))
          .set('Authorization', as('agent-b'))
          .expect(200);
        expect(list.body.total).toBe(0);
        for (const call of [
          http().get(url('tenant-b', `/${conversationId}`)),
          http().post(url('tenant-b', `/${conversationId}/claim`)),
          http().post(url('tenant-b', `/${conversationId}/release`)),
          http().post(url('tenant-b', `/${conversationId}/resolve`)),
          http()
            .post(url('tenant-b', `/${conversationId}/messages`))
            .send({ content: 'x' }),
        ]) {
          const res = await call.set('Authorization', as('agent-b'));
          expect(res.status).toBe(404);
          expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
        }
        // still waiting, untouched
        expect(
          engine.inspect('tenant-a', conversationId)?.conversation.status,
        ).toBe('escalated');
        const counts = await http()
          .get(url('tenant-b', '/counts'))
          .set('Authorization', as('agent-b'))
          .expect(200);
        expect(counts.body.counts.escalated).toBe(0);
      });

      it("a token of tenant B on tenant A's URL is a 403 TENANT_MISMATCH", async () => {
        const { conversationId } = await escalated();
        const res = await http()
          .get(url('tenant-a', `/${conversationId}`))
          .set('Authorization', as('agent-b'))
          .expect(403);
        expect(res.body.code).toBe('TENANT_MISMATCH');
        await http()
          .get('/v1/tenants/tenant-a/customers/x/conversations')
          .set('Authorization', as('agent-b'))
          .expect(403);
      });

      it("a customer id of tenant B is a 404 in tenant A's customer view", async () => {
        const other = await startSession(VISITOR_2, KEY_B, ORIGIN_B);
        await say(other.token, '/escalate', ORIGIN_B);
        const list = await http()
          .get(url('tenant-b'))
          .set('Authorization', as('agent-b'))
          .expect(200);
        const customerOfB = list.body.data[0].endCustomerId;
        await http()
          .get(`/v1/tenants/tenant-a/customers/${customerOfB}/conversations`)
          .set('Authorization', as('agent-a1'))
          .expect(404);
      });
    });

    it('needs a staff token: none, a widget token and a platform token are all refused', async () => {
      await http().get(url('tenant-a')).expect(401);
      const session = await startSession();
      await http()
        .get(url('tenant-a'))
        .set('Authorization', `Bearer ${session.token}`)
        .expect(401);
      await http()
        .get(url('tenant-a'))
        .set('Authorization', `Bearer ${platformToken()}`)
        .expect(401);
    });

    describe('claiming', () => {
      it('takes the conversation: it becomes human_active and the AI stays silent', async () => {
        const { conversationId, token } = await escalated();
        const res = await claim('agent-a1', conversationId).expect(200);
        expect(res.body).toMatchObject({
          status: 'human_active',
          assignedUserId: 'agent-a1',
          assignedUserName: 'Hina Agent',
        });
        const reply = await say(token, 'Is anyone there?');
        expect(reply.events.at(-1)).toMatchObject({
          event: 'done',
          data: { aiReply: false, conversationStatus: 'human_active' },
        });
      });

      it('a second claim is 409 CONVERSATION_ALREADY_CLAIMED, whoever the second person is', async () => {
        const { conversationId } = await escalated();
        await claim('agent-a1', conversationId).expect(200);
        for (const user of ['agent-a2', 'admin-a', 'owner-a'] as UserId[]) {
          const res = await claim(user, conversationId).expect(409);
          expect(res.body.code).toBe('CONVERSATION_ALREADY_CLAIMED');
        }
        // the holder claiming again is a harmless repeat
        await claim('agent-a1', conversationId).expect(200);
        expect(
          h.audit.filter((entry) => entry.action === 'conversation.claimed'),
        ).toHaveLength(1);
      });

      it('lets exactly one of several simultaneous claimants win', async () => {
        const { conversationId } = await escalated();
        const results = await Promise.all(
          (['agent-a1', 'agent-a2', 'admin-a', 'owner-a'] as UserId[]).map(
            (u) => claim(u, conversationId),
          ),
        );
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        const losers = results.filter((r) => r.status === 409);
        expect(losers).toHaveLength(3);
        for (const loser of losers) {
          expect(loser.body.code).toBe('CONVERSATION_ALREADY_CLAIMED');
        }
        const winner = results.find((r) => r.status === 200)!.body
          .assignedUserId;
        expect(
          engine.inspect('tenant-a', conversationId)?.conversation
            .assignedUserId,
        ).toBe(winner);
        expect(
          engine.eventsOf('tenant-a', 'conversation.assigned'),
        ).toHaveLength(1);
      });

      it('a resolved conversation cannot be claimed (409 CONVERSATION_RESOLVED)', async () => {
        const { conversationId } = await escalated();
        engine.resolve('tenant-a', conversationId);
        const res = await claim('agent-a1', conversationId).expect(409);
        expect(res.body.code).toBe('CONVERSATION_RESOLVED');
      });

      it('an unknown conversation is a 404', async () => {
        const res = await claim('agent-a1', 'no-such-conversation').expect(404);
        expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
      });
    });

    describe('replying, releasing and resolving belong to the person who holds it', () => {
      const act = (
        user: UserId,
        id: string,
        what: 'reply' | 'release' | 'resolve',
      ) => {
        const path = what === 'reply' ? `/${id}/messages` : `/${id}/${what}`;
        const call = http()
          .post(url('tenant-a', path))
          .set('Authorization', as(user));
        return what === 'reply'
          ? call.send({ content: 'Hello' })
          : call.send({});
      };

      it.each(['reply', 'release', 'resolve'] as const)(
        '%s: not even an owner or admin may act on a colleague’s conversation (409 CONVERSATION_NOT_ASSIGNED_TO_YOU)',
        async (what) => {
          const { conversationId } = await escalated();
          await claim('agent-a1', conversationId).expect(200);
          for (const user of ['owner-a', 'admin-a', 'agent-a2'] as UserId[]) {
            const res = await act(user, conversationId, what);
            expect([user, res.status, res.body.code]).toEqual([
              user,
              409,
              'CONVERSATION_NOT_ASSIGNED_TO_YOU',
            ]);
          }
          expect(
            engine.inspect('tenant-a', conversationId)?.conversation
              .assignedUserId,
          ).toBe('agent-a1');
        },
      );

      it.each(['reply', 'release', 'resolve'] as const)(
        '%s: nobody can act on a conversation that nobody holds yet',
        async (what) => {
          const { conversationId } = await escalated();
          const res = await act('agent-a1', conversationId, what);
          expect(res.status).toBe(409);
          expect(res.body.code).toBe('CONVERSATION_NOT_ASSIGNED_TO_YOU');
        },
      );

      it('the holder can reply (201), and the reply is stored as a human message of theirs', async () => {
        const { conversationId } = await escalated();
        await claim('agent-a1', conversationId).expect(200);
        const res = await act('agent-a1', conversationId, 'reply').expect(201);
        expect(res.body).toMatchObject({
          authorType: 'human',
          authorUserId: 'agent-a1',
          authorName: 'Hina Agent',
          content: 'Hello',
        });
        const stored = engine
          .inspect('tenant-a', conversationId)!
          .messages.at(-1)!;
        expect(stored).toMatchObject({
          authorType: 'human',
          authorUserId: 'agent-a1',
        });
      });

      it('an owner may reply into a conversation they claimed themselves', async () => {
        const { conversationId } = await escalated();
        await claim('owner-a', conversationId).expect(200);
        await act('owner-a', conversationId, 'reply').expect(201);
      });

      it('a reply is limited to 2,000 characters (400 MESSAGE_TOO_LONG) and cannot be empty', async () => {
        const { conversationId } = await escalated();
        await claim('agent-a1', conversationId).expect(200);
        const post = (content: unknown) =>
          http()
            .post(url('tenant-a', `/${conversationId}/messages`))
            .set('Authorization', as('agent-a1'))
            .send({ content });
        await post('a'.repeat(2000)).expect(201);
        const long = await post('a'.repeat(2001)).expect(400);
        expect(long.body.code).toBe('MESSAGE_TOO_LONG');
        await post('   ').expect(400);
        await post('').expect(400);
        await post(42).expect(400);
      });

      it('release gives it back to the AI by default, or to the queue; the customer is then answered by the AI again', async () => {
        const { conversationId, token } = await escalated();
        await claim('agent-a1', conversationId).expect(200);
        const released = await act(
          'agent-a1',
          conversationId,
          'release',
        ).expect(200);
        expect(released.body).toMatchObject({
          status: 'active',
          assignedUserId: null,
        });
        const answer = await say(token, 'What are your opening hours?');
        expect(answer.events.at(-1)).toMatchObject({
          event: 'done',
          data: { aiReply: true, conversationStatus: 'active' },
        });
        // and back to the queue
        await say(token, '/escalate');
        await claim('agent-a2', conversationId).expect(200);
        const queued = await http()
          .post(url('tenant-a', `/${conversationId}/release`))
          .set('Authorization', as('agent-a2'))
          .send({ to: 'escalated' })
          .expect(200);
        expect(queued.body).toMatchObject({
          status: 'escalated',
          assignedUserId: null,
        });
        await http()
          .post(url('tenant-a', `/${conversationId}/release`))
          .set('Authorization', as('agent-a2'))
          .send({ to: 'resolved' })
          .expect(400);
      });

      it('resolve closes it for good: no replies, no claims, and the customer starts a new conversation', async () => {
        const { conversationId, token } = await escalated();
        await claim('agent-a1', conversationId).expect(200);
        const resolved = await act(
          'agent-a1',
          conversationId,
          'resolve',
        ).expect(200);
        expect(resolved.body).toMatchObject({
          status: 'resolved',
          resolvedBy: 'human',
          assignedUserId: null,
        });
        expect(resolved.body.resolvedAt).toEqual(expect.any(String));
        for (const what of ['reply', 'release', 'resolve'] as const) {
          const res = await act('agent-a1', conversationId, what);
          expect([what, res.status, res.body.code]).toEqual([
            what,
            409,
            'CONVERSATION_RESOLVED',
          ]);
        }
        await claim('agent-a2', conversationId).expect(409);
        const after = await say(token, 'Hello again');
        expect(after.events.at(-1)).toMatchObject({
          event: 'error',
          data: { code: 'CONVERSATION_RESOLVED' },
        });
        const fresh = await startSession();
        expect(fresh.conversationId).not.toBe(conversationId);
      });

      it('a repeated command with the same Idempotency-Key is safe', async () => {
        const { conversationId } = await escalated();
        await claim('agent-a1', conversationId).expect(200);
        const send = () =>
          http()
            .post(url('tenant-a', `/${conversationId}/messages`))
            .set('Authorization', as('agent-a1'))
            .set('Idempotency-Key', 'reply-key-0001')
            .send({ content: 'Only once' });
        const first = await send().expect(201);
        const second = await send().expect(201);
        expect(second.body.id).toBe(first.body.id);
        const humans = engine
          .inspect('tenant-a', conversationId)!
          .messages.filter((m) => m.authorType === 'human');
        expect(humans).toHaveLength(1);
        await http()
          .post(url('tenant-a', `/${conversationId}/claim`))
          .set('Authorization', as('agent-a1'))
          .set('Idempotency-Key', 'no')
          .expect(400);
      });
    });

    describe('audit', () => {
      it('records claimed, released and resolved with who did it, and never the message text', async () => {
        const { conversationId } = await escalated();
        await claim('agent-a1', conversationId).expect(200);
        await http()
          .post(url('tenant-a', `/${conversationId}/messages`))
          .set('Authorization', as('agent-a1'))
          .send({ content: 'SECRET-REPLY-TEXT' })
          .expect(201);
        await http()
          .post(url('tenant-a', `/${conversationId}/release`))
          .set('Authorization', as('agent-a1'))
          .send({})
          .expect(200);
        await claim('agent-a2', conversationId).expect(200);
        await http()
          .post(url('tenant-a', `/${conversationId}/resolve`))
          .set('Authorization', as('agent-a2'))
          .expect(200);
        const entries = h.audit.filter((e) => e.targetType === 'conversation');
        expect(
          entries.map((e) => [
            e.action,
            e.actorUserId,
            e.actorRole,
            e.tenantId,
            e.targetId,
          ]),
        ).toEqual([
          [
            'conversation.claimed',
            'agent-a1',
            'agent',
            'tenant-a',
            conversationId,
          ],
          [
            'conversation.released',
            'agent-a1',
            'agent',
            'tenant-a',
            conversationId,
          ],
          [
            'conversation.claimed',
            'agent-a2',
            'agent',
            'tenant-a',
            conversationId,
          ],
          [
            'conversation.resolved',
            'agent-a2',
            'agent',
            'tenant-a',
            conversationId,
          ],
        ]);
        expect(JSON.stringify(entries)).not.toContain('SECRET-REPLY-TEXT');
        expect(entries[0].requestId).toEqual(expect.any(String));
      });
    });

    describe('a team member who is disabled or deleted', () => {
      beforeEach(() => {
        prisma.tenantUser.update.mockImplementation(({ where, data }: any) => {
          const user = h.userById(where.id);
          Object.assign(user!, data);
          return Promise.resolve({ ...user });
        });
        prisma.tenantUser.delete.mockImplementation(({ where }: any) => {
          const index = h.users.findIndex((u) => u.id === where.id);
          const [user] = h.users.splice(index, 1);
          return Promise.resolve(user);
        });
      });

      it('disabling the holder puts their conversations back in the queue and audits it', async () => {
        const a = await escalated(VISITOR_1);
        const b = await escalated(VISITOR_2);
        await claim('agent-a1', a.conversationId).expect(200);
        await claim('agent-a1', b.conversationId).expect(200);
        const res = await http()
          .patch('/v1/tenants/tenant-a/users/agent-a1')
          .set('Authorization', as('admin-a'))
          .send({ status: 'disabled' })
          .expect(200);
        expect(res.body.status).toBe('disabled');
        for (const id of [a.conversationId, b.conversationId]) {
          expect(engine.inspect('tenant-a', id)?.conversation).toMatchObject({
            status: 'escalated',
            assignedUserId: null,
          });
        }
        const released = h.audit.filter(
          (e) =>
            e.action === 'conversation.released' &&
            e.after?.reason === 'assignee_disabled',
        );
        expect(released).toHaveLength(2);
        expect(released[0]).toMatchObject({
          actorUserId: 'admin-a',
          actorRole: 'admin',
        });
        // someone else can pick it up now
        await claim('agent-a2', a.conversationId).expect(200);
      });

      it('deleting the holder does the same', async () => {
        const a = await escalated();
        await claim('agent-a1', a.conversationId).expect(200);
        await http()
          .delete('/v1/tenants/tenant-a/users/agent-a1')
          .set('Authorization', as('owner-a'))
          .expect(200);
        expect(
          engine.inspect('tenant-a', a.conversationId)?.conversation,
        ).toMatchObject({
          status: 'escalated',
          assignedUserId: null,
        });
        const list = await http()
          .get(url('tenant-a'))
          .set('Authorization', as('owner-a'))
          .expect(200);
        // the deleted user's name is gone, not an error
        expect(list.body.data[0].assignedUserName).toBeNull();
      });

      it('disabling someone who holds nothing, or changing a role, leaves other conversations alone', async () => {
        const a = await escalated();
        await claim('agent-a1', a.conversationId).expect(200);
        await http()
          .patch('/v1/tenants/tenant-a/users/agent-a2')
          .set('Authorization', as('admin-a'))
          .send({ status: 'disabled' })
          .expect(200);
        expect(
          engine.inspect('tenant-a', a.conversationId)?.conversation
            .assignedUserId,
        ).toBe('agent-a1');
      });

      it('a failing engine does not undo or fail the user change', async () => {
        const a = await escalated();
        await claim('agent-a1', a.conversationId).expect(200);
        engine.setDown(true);
        await http()
          .patch('/v1/tenants/tenant-a/users/agent-a1')
          .set('Authorization', as('admin-a'))
          .send({ status: 'disabled' })
          .expect(200);
        engine.setDown(false);
        expect(h.userById('agent-a1')!.status).toBe('disabled');
        // still held: staff must release it (a known limitation while the engine was down)
        expect(
          engine.inspect('tenant-a', a.conversationId)?.conversation
            .assignedUserId,
        ).toBe('agent-a1');
      });
    });
  });

  // ===========================================================================================

  describe('the dashboard stream (D5)', () => {
    it('answers 401 without a token or a ticket, and ignores a token in the query string', async () => {
      const none = await openStream(`${base}/v1/tenants/tenant-a/events`);
      expect(none.status).toBe(401);
      const raw = as('agent-a1').slice('Bearer '.length);
      for (const query of [
        `?access_token=${raw}`,
        `?token=${raw}`,
        `?ticket=${raw}`,
      ]) {
        const stream = await openStream(
          `${base}/v1/tenants/tenant-a/events${query}`,
        );
        expect([query.split('=')[0], stream.status]).toEqual([
          query.split('=')[0],
          401,
        ]);
      }
    });

    it('refuses a token of another tenant (403 TENANT_MISMATCH) and a suspended tenant (403)', async () => {
      const wrong = await staffStream('agent-b', 'tenant-a');
      expect(wrong.status).toBe(403);
      expect(wrong.body.code).toBe('TENANT_MISMATCH');
      h.gateway.tenants.get('tenant-a')!.status = 'suspended';
      const suspended = await staffStream('agent-a1');
      expect(suspended.status).toBe(403);
      expect(suspended.body.code).toBe('TENANT_SUSPENDED');
    });

    it('streams the events of the hand-off to every role, with ids only', async () => {
      const streams = await Promise.all(
        (['owner-a', 'admin-a', 'agent-a1'] as UserId[]).map((u) =>
          staffStream(u),
        ),
      );
      for (const stream of streams) {
        expect(stream.status).toBe(200);
        expect(stream.headers['content-type']).toContain('text/event-stream');
        await stream.waitFor((e) => e.event === 'ready');
      }
      const { conversationId } = await escalated();
      for (const stream of streams) {
        const event = await stream.waitFor(
          (e) => e.event === 'conversation.escalated',
        );
        expect(event.data).toEqual({
          conversationId,
          reason: 'customer_requested',
        });
        expect(event.id).toMatch(/^[0-9a-f]+-\d+$/);
      }
      await claim('agent-a1', conversationId).expect(200);
      const assigned = await streams[2].waitFor(
        (e) => e.event === 'conversation.assigned',
      );
      expect(assigned.data).toEqual({
        conversationId,
        assignedUserId: 'agent-a1',
      });
      await http()
        .post(url('tenant-a', `/${conversationId}/messages`))
        .set('Authorization', as('agent-a1'))
        .send({ content: 'PRIVATE REPLY TEXT' })
        .expect(201);
      await engine.flushEvents();
      await streams[0].waitFor(
        (e) => e.event === 'message.created' && e.data.authorType === 'human',
      );
      for (const stream of streams) {
        // no message text on the dashboard stream: the UI refetches by id
        expect(stream.raw).not.toContain('PRIVATE REPLY TEXT');
      }
    });

    it("never shows tenant B's events to tenant A", async () => {
      const a = await staffStream('agent-a1', 'tenant-a');
      const b = await staffStream('agent-b', 'tenant-b');
      await a.waitFor((e) => e.event === 'ready');
      await b.waitFor((e) => e.event === 'ready');
      const session = await startSession(VISITOR_2, KEY_B, ORIGIN_B);
      await say(session.token, '/escalate', ORIGIN_B);
      await b.waitFor((e) => e.event === 'conversation.escalated');
      await new Promise((r) => setTimeout(r, 50));
      expect(
        a.events.filter((e) => e.event.startsWith('conversation.')),
      ).toEqual([]);
    });

    it('resumes with Last-Event-ID (header or query) and asks for a resync when the id is stale', async () => {
      const first = await staffStream('agent-a1');
      await first.waitFor((e) => e.event === 'ready');
      const { conversationId } = await escalated();
      const seen = await first.waitFor(
        (e) => e.event === 'conversation.escalated',
      );
      first.close();

      await claim('agent-a1', conversationId).expect(200);
      await engine.flushEvents();
      const viaHeader = await openStream(`${base}/v1/tenants/tenant-a/events`, {
        Authorization: as('agent-a1'),
        'Last-Event-ID': seen.id!,
      });
      opened.push(viaHeader);
      await viaHeader.waitFor((e) => e.event === 'conversation.assigned');
      expect(
        viaHeader.events.filter((e) => e.event === 'conversation.escalated'),
      ).toEqual([]);

      const viaQuery = await openStream(
        `${base}/v1/tenants/tenant-a/events?lastEventId=${seen.id}`,
        { Authorization: as('agent-a1') },
      );
      opened.push(viaQuery);
      await viaQuery.waitFor((e) => e.event === 'conversation.assigned');

      const stale = await openStream(`${base}/v1/tenants/tenant-a/events`, {
        Authorization: as('agent-a1'),
        'Last-Event-ID': 'deadbeef-1',
      });
      opened.push(stale);
      await stale.waitFor((e) => e.event === 'resync');
    });

    it('is readable from the dashboard origin only (CORS), also with a ticket', async () => {
      const ticket = (
        await http()
          .post('/v1/tenants/tenant-a/events/ticket')
          .set('Authorization', as('agent-a1'))
          .expect(200)
      ).body.ticket as string;
      const stream = await openStream(
        `${base}/v1/tenants/tenant-a/events?ticket=${ticket}`,
        { Origin: 'http://localhost:5173' },
      );
      opened.push(stream);
      expect(stream.status).toBe(200);
      expect(stream.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173',
      );
      const other = await openStream(`${base}/v1/tenants/tenant-a/events`, {
        Authorization: as('agent-a1'),
        Origin: 'https://evil.example.com',
      });
      opened.push(other);
      // always the one dashboard origin, never the caller's: a page on another site cannot read it
      expect(other.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173',
      );
      expect(other.headers['access-control-allow-origin']).not.toBe(
        'https://evil.example.com',
      );
    });

    describe('tickets for a browser EventSource', () => {
      const ticketOf = async (user: UserId, tenant = 'tenant-a') => {
        const res = await http()
          .post(`/v1/tenants/${tenant}/events/ticket`)
          .set('Authorization', as(user))
          .expect(200);
        return res.body as { ticket: string; expiresInSeconds: number };
      };

      it('works once: the second use is a 401', async () => {
        const { ticket, expiresInSeconds } = await ticketOf('agent-a1');
        expect(expiresInSeconds).toBe(30);
        const first = await openStream(
          `${base}/v1/tenants/tenant-a/events?ticket=${ticket}`,
        );
        opened.push(first);
        expect(first.status).toBe(200);
        await first.waitFor((e) => e.event === 'ready');
        const second = await openStream(
          `${base}/v1/tenants/tenant-a/events?ticket=${ticket}`,
        );
        expect(second.status).toBe(401);
      });

      it('stops working after 30 seconds', async () => {
        const { ticket } = await ticketOf('agent-a1');
        clock.advanceMs(31_000);
        const late = await openStream(
          `${base}/v1/tenants/tenant-a/events?ticket=${ticket}`,
        );
        expect(late.status).toBe(401);
      });

      it('is bound to the tenant it was issued for', async () => {
        const { ticket } = await ticketOf('agent-a1');
        const wrong = await openStream(
          `${base}/v1/tenants/tenant-b/events?ticket=${ticket}`,
        );
        expect(wrong.status).toBe(401);
        // and was not used up by the failed attempt
        const right = await openStream(
          `${base}/v1/tenants/tenant-a/events?ticket=${ticket}`,
        );
        opened.push(right);
        expect(right.status).toBe(200);
      });

      it('needs the normal Authorization header to be issued (a ticket cannot mint a ticket)', async () => {
        await http().post('/v1/tenants/tenant-a/events/ticket').expect(401);
        await http()
          .post('/v1/tenants/tenant-a/events/ticket')
          .set('Authorization', as('agent-b'))
          .expect(403);
        const { ticket } = await ticketOf('agent-a1');
        await http()
          .post(`/v1/tenants/tenant-a/events/ticket?ticket=${ticket}`)
          .expect(401);
      });

      it('is refused for a user who was disabled after asking for it', async () => {
        const { ticket } = await ticketOf('agent-a2');
        h.userById('agent-a2')!.status = 'disabled';
        const stream = await openStream(
          `${base}/v1/tenants/tenant-a/events?ticket=${ticket}`,
        );
        expect(stream.status).toBe(401);
        expect(stream.body.code).toBe('ACCOUNT_DISABLED');
      });

      it('only the hash of the ticket is stored', async () => {
        const { ticket } = await ticketOf('agent-a1');
        expect(JSON.stringify(h.tickets)).not.toContain(ticket);
        expect(h.tickets[0]).toMatchObject({
          tenantId: 'tenant-a',
          userId: 'agent-a1',
        });
      });

      it('is limited per user (429 with Retry-After)', async () => {
        let last: request.Response | undefined;
        for (let i = 0; i < 31; i++) {
          last = await http()
            .post('/v1/tenants/tenant-a/events/ticket')
            .set('Authorization', as('agent-a2'));
        }
        expect(last!.status).toBe(429);
        expect(last!.headers['retry-after']).toBeDefined();
      });
    });

    it('allows five streams per user: a sixth closes the oldest', async () => {
      const streams: SseStream[] = [];
      for (let i = 0; i < 6; i++) {
        const stream = await staffStream('agent-a2');
        await stream.waitFor((e) => e.event === 'ready');
        streams.push(stream);
      }
      const closed = await streams[0].waitFor((e) => e.event === 'closed');
      expect(closed.data).toEqual({ reason: 'limit' });
      await streams[0].closed;
      expect(
        streams[5].events.find((e) => e.event === 'closed'),
      ).toBeUndefined();
    });
  });

  // ===========================================================================================

  describe('the customer’s live stream', () => {
    it('needs a widget token for the right origin; staff and platform tokens are refused', async () => {
      const session = await startSession();
      const none = await openStream(`${base}/v1/widget/events`, {
        Origin: ORIGIN_A,
      });
      expect(none.status).toBe(401);
      const staff = await openStream(`${base}/v1/widget/events`, {
        Authorization: as('agent-a1'),
        Origin: ORIGIN_A,
      });
      expect(staff.status).toBe(401);
      const wrongOrigin = await openStream(`${base}/v1/widget/events`, {
        Authorization: `Bearer ${session.token}`,
        Origin: 'https://evil.example.com',
      });
      expect(wrongOrigin.status).toBe(403);
      expect(wrongOrigin.body.code).toBe('ORIGIN_NOT_ALLOWED');
      const noOrigin = await openStream(`${base}/v1/widget/events`, {
        Authorization: `Bearer ${session.token}`,
      });
      expect(noOrigin.status).toBe(403);
    });

    it('answers the preflight of a fetch that resumes with Last-Event-ID', async () => {
      await startSession();
      const res = await http()
        .options('/v1/widget/events')
        .set('Origin', ORIGIN_A)
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'authorization,last-event-id')
        .expect(204);
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN_A);
      expect(res.headers['access-control-allow-headers']).toMatch(
        /Last-Event-ID/i,
      );
    });

    it('is allowed for the origin of the key, with CORS for that origin only', async () => {
      const session = await startSession();
      const stream = await widgetStream(session.token);
      expect(stream.status).toBe(200);
      expect(stream.headers['access-control-allow-origin']).toBe(ORIGIN_A);
      await stream.waitFor((e) => e.event === 'ready');
    });

    it('a revoked key ends the visitor’s access at once', async () => {
      const session = await startSession();
      h.gateway.apiKeys.find((k) => k.id === 'key-a')!.revokedAt = new Date();
      const stream = await widgetStream(session.token);
      expect(stream.status).toBe(401);
      expect(stream.body.code).toBe('WIDGET_KEY_INVALID');
    });

    it('a visitor can only stream their own conversation (the id comes from the token)', async () => {
      const mine = await startSession(VISITOR_1);
      const other = await startSession(VISITOR_2);
      const stream = await widgetStream(mine.token);
      await stream.waitFor((e) => e.event === 'ready');
      await say(other.token, '/escalate');
      await claim('agent-a1', other.conversationId).expect(200);
      await engine.flushEvents();
      await new Promise((r) => setTimeout(r, 50));
      expect(
        stream.events.filter(
          (e) => e.event === 'status' || e.event === 'message',
        ),
      ).toEqual([]);
    });

    it("a suspended tenant's chat is closed (403 TENANT_SUSPENDED)", async () => {
      const session = await startSession();
      h.gateway.tenants.get('tenant-a')!.status = 'suspended';
      const stream = await widgetStream(session.token);
      expect(stream.status).toBe(403);
      expect(stream.body.code).toBe('TENANT_SUSPENDED');
    });
  });

  // ===========================================================================================

  describe('the whole hand-off, on the mock engine', () => {
    it('customer asks -> escalation -> notification -> claim -> human reply reaches the widget -> release -> AI resumes -> resolve', async () => {
      // an agent has the dashboard open; the visitor has the widget open
      const dashboard = await staffStream('agent-a1');
      const session = await startSession();
      const widget = await widgetStream(session.token);
      await Promise.all([
        dashboard.waitFor((e) => e.event === 'ready'),
        widget.waitFor((e) => e.event === 'ready'),
      ]);

      // 1. the customer asks a question, the AI answers
      const hours = await say(session.token, 'What are your opening hours?');
      expect(hours.events.map((e) => e.event)).toEqual(
        expect.arrayContaining(['accepted', 'token', 'done']),
      );
      expect(hours.events.at(-1)?.data).toMatchObject({ aiReply: true });

      // 2. the customer asks for a human: the AI hands over
      const handoff = await say(session.token, 'I want to talk to a human');
      expect(handoff.events.map((e) => e.event)).toContain('escalated');
      expect(handoff.events.at(-1)?.data).toMatchObject({
        conversationStatus: 'escalated',
      });

      // 3. the team is told: live event, and one notification for every ACTIVE member
      await dashboard.waitFor((e) => e.event === 'conversation.escalated');
      const bell = await dashboard.waitFor(
        (e) => e.event === 'notification.created',
      );
      expect(bell.data).toMatchObject({ type: 'conversation.escalated' });
      expect(h.notifications.map((n) => n.userId).sort()).toEqual(
        ['admin-a', 'agent-a1', 'agent-a2', 'owner-a'].sort(),
      );
      expect(h.notifications[0]).toMatchObject({
        tenantId: 'tenant-a',
        type: 'conversation.escalated',
        link: `/conversations/${session.conversationId}`,
        params: {
          conversationId: session.conversationId,
          channel: 'widget',
          reason: 'customer_requested',
        },
        readAt: null,
      });
      await widget.waitFor(
        (e) => e.event === 'status' && e.data.status === 'escalated',
      );

      const mine = await http()
        .get('/v1/tenants/tenant-a/notifications?unread=true')
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(mine.body.total).toBe(1);
      expect(mine.body.data[0]).toMatchObject({
        id: bell.data.notificationId,
        type: 'conversation.escalated',
      });

      // 4. the agent finds it in the queue and takes it; a colleague is too late
      const queue = await http()
        .get(`${url('tenant-a')}?status=escalated&sort=escalatedAt`)
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(queue.body.data.map((c: any) => c.id)).toEqual([
        session.conversationId,
      ]);
      await claim('agent-a1', session.conversationId).expect(200);
      await claim('agent-a2', session.conversationId).expect(409);
      await widget.waitFor(
        (e) => e.event === 'status' && e.data.status === 'human_active',
      );
      const joined = await widget.waitFor(
        (e) => e.event === 'message' && e.data.contentKey === 'agent.joined',
      );
      expect(joined.data).toMatchObject({ authorType: 'system', content: '' });

      // 5. the agent replies and the customer sees it without sending anything
      await http()
        .post(url('tenant-a', `/${session.conversationId}/messages`))
        .set('Authorization', as('agent-a1'))
        .send({ content: 'Hello, this is Hina. How can I help?' })
        .expect(201);
      await engine.flushEvents();
      const reply = await widget.waitFor(
        (e) => e.event === 'message' && e.data.authorType === 'human',
      );
      expect(reply.data).toMatchObject({
        content: 'Hello, this is Hina. How can I help?',
        contentKey: null,
      });
      // the customer is never told who the person is
      expect(JSON.stringify(reply.data)).not.toMatch(
        /agent-a1|Hina Agent|userId/,
      );
      // polling still works and shows the same
      const history = await http()
        .get('/v1/widget/conversation')
        .set('Authorization', `Bearer ${session.token}`)
        .set('Origin', ORIGIN_A)
        .expect(200);
      expect(
        history.body.data
          .filter((m: any) => m.authorType !== 'ai')
          .map((m: any) => [m.authorType, m.contentKey, m.content]),
      ).toEqual(
        expect.arrayContaining([
          ['system', 'agent.joined', ''],
          ['human', null, 'Hello, this is Hina. How can I help?'],
        ]),
      );
      expect(history.body.status).toBe('human_active');
      expect(JSON.stringify(history.body)).not.toMatch(/agent-a1|Hina Agent/);

      // 6. the customer answers; the AI stays silent while a human is active (C4)
      const during = await say(session.token, 'My order number is 4711');
      expect(during.events.at(-1)?.data).toMatchObject({
        aiReply: false,
        conversationStatus: 'human_active',
      });

      // 7. the agent hands back: the AI resumes
      await http()
        .post(url('tenant-a', `/${session.conversationId}/release`))
        .set('Authorization', as('agent-a1'))
        .send({})
        .expect(200);
      await engine.flushEvents();
      await widget.waitFor(
        (e) => e.event === 'message' && e.data.contentKey === 'agent.left',
      );
      await widget.waitFor(
        (e) => e.event === 'status' && e.data.status === 'active',
      );
      const resumed = await say(session.token, 'What is the delivery time?');
      expect(resumed.events.at(-1)?.data).toMatchObject({
        aiReply: true,
        conversationStatus: 'active',
      });

      // 8. a second round: the agent resolves
      await say(session.token, '/escalate');
      await claim('agent-a2', session.conversationId).expect(200);
      await http()
        .post(url('tenant-a', `/${session.conversationId}/resolve`))
        .set('Authorization', as('agent-a2'))
        .expect(200);
      await engine.flushEvents();
      await widget.waitFor(
        (e) => e.event === 'status' && e.data.status === 'resolved',
      );
      await widget.waitFor(
        (e) => e.event === 'message' && e.data.contentKey === 'resolved.notice',
      );
      await dashboard.waitFor((e) => e.event === 'conversation.resolved');

      // 9. the customer's next message starts a fresh conversation
      const next = await say(session.token, 'One more thing');
      expect(next.events.at(-1)).toMatchObject({
        event: 'error',
        data: { code: 'CONVERSATION_RESOLVED' },
      });
      const fresh = await startSession();
      expect(fresh.conversationId).not.toBe(session.conversationId);

      // usage was counted once per conversation and per message, whichever path reported it
      const usage = h.gateway.usageOf('tenant-a');
      expect(usage.reduce((sum, r) => sum + r.conversations, 0)).toBe(2);
      const countedMessages = h.gateway.usageEvents.filter(
        (e) => e.kind === 'message',
      );
      expect(new Set(countedMessages.map((e) => e.refId)).size).toBe(
        countedMessages.length,
      );
    });
  });
});
