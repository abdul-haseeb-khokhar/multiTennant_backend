import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FakeClock } from '../src/billing/clock';
import { signEngineEvent } from '../src/events/engine-event-signature';
import { MockEngineClient } from '../src/engine/mock-engine.client';
import { Handoff, installHandoff } from './utils/handoff-fixtures';
import { PrismaMock } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

const SECRET = 'e2e-internal-token-0123456789abcdef-xyz';
const KEY_A = 'wk_tenantAKey0123456789abcdefghij';
const ORIGIN_A = 'https://shop-a.example.com';

const USERS = {
  'owner-a': { tenantId: 'tenant-a', role: 'owner' },
  'admin-a': { tenantId: 'tenant-a', role: 'admin' },
  'agent-a1': { tenantId: 'tenant-a', role: 'agent' },
  'agent-a2': { tenantId: 'tenant-a', role: 'agent' },
  'agent-b': { tenantId: 'tenant-b', role: 'agent' },
} as const;
type UserId = keyof typeof USERS;

describe('Engine events, notifications and OpenAPI (e2e, mocked database)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let clock: FakeClock;
  let engine: MockEngineClient;
  let staffToken: Awaited<ReturnType<typeof createTestApp>>['staffToken'];
  let allowStaff: () => void;
  let h: Handoff;

  const http = () => request(app.getHttpServer());
  const as = (id: UserId) =>
    `Bearer ${staffToken({ userId: id, ...USERS[id] })}`;

  beforeAll(async () => {
    ({ app, prisma, clock, engine, staffToken, allowStaff } =
      await createTestApp());
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
      ],
      users: [
        { id: 'owner-a', tenantId: 'tenant-a', role: 'owner' },
        { id: 'admin-a', tenantId: 'tenant-a', role: 'admin' },
        { id: 'agent-a1', tenantId: 'tenant-a', role: 'agent' },
        { id: 'agent-a2', tenantId: 'tenant-a', role: 'agent' },
        {
          id: 'off-a',
          tenantId: 'tenant-a',
          role: 'agent',
          status: 'disabled',
        },
        { id: 'agent-b', tenantId: 'tenant-b', role: 'agent' },
      ],
    });
  });

  // ===========================================================================================

  describe('POST /internal/events (the engine pushes what happened)', () => {
    let sequence = 0;
    const envelope = (
      type: string,
      data: Record<string, unknown>,
      over: Record<string, unknown> = {},
    ) => ({
      id: `evt-${(sequence += 1)}`,
      type,
      tenantId: 'tenant-a',
      occurredAt: '2026-10-10T10:00:00.000Z',
      data,
      ...over,
    });

    /** A delivery signed the way the engine must sign it. */
    const deliver = (
      body: unknown,
      options: {
        secret?: string;
        timestamp?: number;
        tamper?: string;
        headers?: Record<string, string>;
      } = {},
    ) => {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const timestamp = String(
        options.timestamp ?? Math.floor(clock.now().getTime() / 1000),
      );
      return http()
        .post('/internal/events')
        .set('Content-Type', 'application/json')
        .set('X-Engine-Timestamp', timestamp)
        .set(
          'X-Engine-Signature',
          signEngineEvent(options.secret ?? SECRET, timestamp, raw),
        )
        .set(options.headers ?? {})
        .send(options.tamper ?? raw);
    };

    it('accepts a signed event and applies it (usage.recorded counts the message once)', async () => {
      const event = envelope('usage.recorded', {
        conversationId: 'c1',
        messageId: 'm1',
        tokensIn: 10,
        tokensOut: 20,
      });
      const res = await deliver(event).expect(200);
      expect(res.body).toEqual({ status: 'processed' });
      expect(h.gateway.usageOf('tenant-a')[0]).toMatchObject({
        messages: 1,
        tokensIn: 10,
        tokensOut: 20,
      });
      expect(h.engineEvents).toHaveLength(1);
      expect(h.engineEvents[0]).toMatchObject({
        tenantId: 'tenant-a',
        eventId: event.id,
        type: 'usage.recorded',
      });
    });

    it('is idempotent: the same event id again changes nothing', async () => {
      const event = envelope('usage.recorded', {
        messageId: 'm1',
        tokensIn: 5,
        tokensOut: 5,
      });
      expect((await deliver(event).expect(200)).body.status).toBe('processed');
      expect((await deliver(event).expect(200)).body.status).toBe('duplicate');
      expect((await deliver(event).expect(200)).body.status).toBe('duplicate');
      expect(h.gateway.usageOf('tenant-a')[0].messages).toBe(1);
      expect(h.engineEvents).toHaveLength(1);
    });

    it('a message already counted from the reply stream is not counted again (a different event id)', async () => {
      await deliver(
        envelope('usage.recorded', {
          messageId: 'm7',
          tokensIn: 1,
          tokensOut: 1,
        }),
      ).expect(200);
      await deliver(
        envelope('usage.recorded', {
          messageId: 'm7',
          tokensIn: 1,
          tokensOut: 1,
        }),
      ).expect(200);
      expect(h.gateway.usageOf('tenant-a')[0].messages).toBe(1);
    });

    it('takes the tenant ONLY from the envelope, never from the payload', async () => {
      await deliver(
        envelope('usage.recorded', {
          messageId: 'm8',
          tokensIn: 1,
          tokensOut: 1,
          tenantId: 'tenant-b',
        }),
      ).expect(200);
      expect(h.gateway.usageOf('tenant-a')).toHaveLength(1);
      expect(h.gateway.usageOf('tenant-b')).toHaveLength(0);
    });

    it('an event for a tenant that does not exist is a 404 and nothing is stored', async () => {
      const res = await deliver(
        envelope(
          'usage.recorded',
          { messageId: 'm9' },
          { tenantId: 'no-such-tenant' },
        ),
      ).expect(404);
      expect(res.body.code).toBe('TENANT_NOT_FOUND');
      expect(h.engineEvents).toHaveLength(0);
    });

    it('an unknown event type is acknowledged and ignored', async () => {
      const res = await deliver(
        envelope('ingestion.completed', { sourceId: 's1' }),
      ).expect(200);
      expect(res.body).toEqual({ status: 'ignored' });
      expect(h.notifications).toHaveLength(0);
    });

    describe('authentication (a signature over the exact body; the token is never sent)', () => {
      const event = () =>
        envelope('usage.recorded', {
          messageId: 'mx',
          tokensIn: 1,
          tokensOut: 1,
        });

      it.each([
        ['a wrong secret', { secret: 'x'.repeat(40) }],
        [
          'a stale timestamp',
          { timestamp: Math.floor(Date.now() / 1000) - 3600 },
        ],
        [
          'a body changed after signing',
          { tamper: JSON.stringify({ tampered: true }) },
        ],
      ])('refuses %s with 401', async (_name, options) => {
        const res = await deliver(event(), options as never).expect(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
        expect(h.engineEvents).toHaveLength(0);
        expect(h.gateway.usageOf('tenant-a')).toHaveLength(0);
      });

      it('refuses a request without signature headers, and one that only carries the bearer token', async () => {
        await http().post('/internal/events').send(event()).expect(401);
        await http()
          .post('/internal/events')
          .set('Authorization', `Bearer ${SECRET}`)
          .send(event())
          .expect(401);
        await http()
          .post('/internal/events')
          .set('X-Engine-Signature', 'sha256=abc')
          .send(event())
          .expect(401);
      });

      it('refuses a staff token, a platform token and a widget token', async () => {
        await http()
          .post('/internal/events')
          .set('Authorization', as('owner-a'))
          .send(event())
          .expect(401);
      });

      it('every refusal looks the same', async () => {
        const bodies = new Set<string>();
        for (const options of [{ secret: 'y'.repeat(40) }, { timestamp: 1 }]) {
          const res = await deliver(event(), options).expect(401);
          const { requestId: _r, ...rest } = res.body;
          bodies.add(JSON.stringify(rest));
        }
        const res = await http()
          .post('/internal/events')
          .send(event())
          .expect(401);
        const { requestId: _r, ...rest } = res.body;
        bodies.add(JSON.stringify(rest));
        expect(bodies.size).toBe(1);
      });
    });

    describe('the envelope is validated', () => {
      it.each([
        ['no id', { id: undefined }],
        ['no tenantId', { tenantId: undefined }],
        ['a type that is not a name', { type: 'Not A Type!' }],
        ['a bad time', { occurredAt: 'yesterday' }],
        ['data that is not an object', { data: 'text' }],
        ['data that is a list', { data: [1, 2] }],
        ['an id of 101 characters', { id: 'x'.repeat(101) }],
      ])('refuses %s with 400', async (_name, over) => {
        const res = await deliver(
          envelope('usage.recorded', { messageId: 'm' }, over),
        ).expect(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(h.engineEvents).toHaveLength(0);
      });

      it('refuses a known event whose required id is missing', async () => {
        const res = await deliver(
          envelope('conversation.escalated', {}),
        ).expect(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      });

      it('refuses broken JSON', async () => {
        await deliver('{not json').expect(400);
      });
    });

    it('lives outside /v1: /v1/internal/events does not exist, GET is not allowed, and it is not in the public API document', async () => {
      await http().post('/v1/internal/events').send({}).expect(404);
      await http().get('/internal/events').expect(404);
      const doc = (await http().get('/docs-json').expect(200)).body;
      expect(Object.keys(doc.paths).some((p) => p.includes('internal'))).toBe(
        false,
      );
    });

    it('conversation.escalated notifies the active staff and clears an escalation the gateway could not deliver', async () => {
      const session = (
        await http()
          .post('/v1/widget/sessions')
          .set('Origin', ORIGIN_A)
          .send({ widgetKey: KEY_A, visitorId: 'visitor-one-0123456789abcdef' })
          .expect(200)
      ).body;
      h.gateway.conversations.find(
        (c) => c.conversationId === session.conversationId,
      )!.escalationPending = true;
      await deliver(
        envelope('conversation.escalated', {
          conversationId: session.conversationId,
          reason: 'ai_unavailable',
        }),
      ).expect(200);
      expect(h.notifications.map((n) => n.userId).sort()).toEqual(
        ['admin-a', 'agent-a1', 'agent-a2', 'owner-a'].sort(),
      );
      expect(h.notifications.every((n) => n.tenantId === 'tenant-a')).toBe(
        true,
      );
      expect(
        h.gateway.conversations.find(
          (c) => c.conversationId === session.conversationId,
        )!.escalationPending,
      ).toBe(false);
    });

    it('conversation.assigned notifies the assignee only when somebody else assigned it', async () => {
      await deliver(
        envelope('conversation.assigned', {
          conversationId: 'c1',
          assignedUserId: 'agent-a1',
          assignedByUserId: 'agent-a1',
        }),
      ).expect(200);
      expect(h.notifications).toHaveLength(0);
      await deliver(
        envelope('conversation.assigned', {
          conversationId: 'c1',
          assignedUserId: 'agent-a1',
          assignedByUserId: 'admin-a',
        }),
      ).expect(200);
      expect(h.notifications.map((n) => [n.userId, n.type])).toEqual([
        ['agent-a1', 'conversation.assigned'],
      ]);
    });

    it('an assignee of another tenant (or a disabled user) gets nothing', async () => {
      await deliver(
        envelope('conversation.assigned', {
          conversationId: 'c1',
          assignedUserId: 'agent-b',
          assignedByUserId: 'admin-a',
        }),
      ).expect(200);
      await deliver(
        envelope('conversation.assigned', {
          conversationId: 'c1',
          assignedUserId: 'off-a',
          assignedByUserId: 'admin-a',
        }),
      ).expect(200);
      expect(h.notifications).toHaveLength(0);
    });

    it('action.proposed notifies owners and admins only', async () => {
      await deliver(
        envelope('action.proposed', {
          actionId: 'act-1',
          action: 'refund',
          conversationId: 'c1',
        }),
      ).expect(200);
      expect(h.notifications.map((n) => n.userId).sort()).toEqual([
        'admin-a',
        'owner-a',
      ]);
      expect(h.notifications[0]).toMatchObject({
        type: 'action.proposed',
        params: expect.objectContaining({
          actionId: 'act-1',
          action: 'refund',
        }),
      });
    });

    it('delivers events one after the other from the mock engine through the same code path', async () => {
      const session = (
        await http()
          .post('/v1/widget/sessions')
          .set('Origin', ORIGIN_A)
          .send({ widgetKey: KEY_A, visitorId: 'visitor-two-0123456789abcdef' })
          .expect(200)
      ).body;
      await http()
        .post('/v1/widget/messages')
        .set('Authorization', `Bearer ${session.token}`)
        .set('Origin', ORIGIN_A)
        .send({ content: '/action refund please' })
        .expect(200);
      await engine.flushEvents();
      // the mock produced usage.recorded and action.proposed, and the receiver applied them
      expect(h.engineEvents.map((e) => e.type)).toEqual(
        expect.arrayContaining([
          'conversation.created',
          'message.created',
          'usage.recorded',
          'action.proposed',
        ]),
      );
      expect(
        h.notifications
          .filter((n) => n.type === 'action.proposed')
          .map((n) => n.userId)
          .sort(),
      ).toEqual(['admin-a', 'owner-a']);
    });
  });

  // ===========================================================================================

  describe('the notification API (H5)', () => {
    const seed = async () => {
      // three notifications for agent-a1 (one read), one for agent-a2, one in tenant B
      for (const [i, userId] of [
        'agent-a1',
        'agent-a1',
        'agent-a1',
        'agent-a2',
      ].entries()) {
        h.notifications.push({
          id: `n${i + 1}`,
          tenantId: 'tenant-a',
          userId,
          type: 'conversation.escalated',
          params: { conversationId: `c${i + 1}`, customer: 'web_abcdef…' },
          link: `/conversations/c${i + 1}`,
          dedupeKey: null,
          readAt: i === 0 ? new Date('2026-10-09') : null,
          createdAt: new Date(Date.UTC(2026, 9, 10, 8, i)),
        });
      }
      h.notifications.push({
        id: 'nb1',
        tenantId: 'tenant-b',
        userId: 'agent-b',
        type: 'conversation.escalated',
        params: {},
        link: null,
        dedupeKey: null,
        readAt: null,
        createdAt: new Date('2026-10-10'),
      });
    };

    it.each(['owner-a', 'admin-a', 'agent-a1'] as UserId[])(
      '%s can read their own list',
      async (user) => {
        await seed();
        const res = await http()
          .get('/v1/tenants/tenant-a/notifications')
          .set('Authorization', as(user))
          .expect(200);
        expect(res.body).toMatchObject({ skip: 0, take: 20 });
        // only the agent has notifications in this seed: everyone gets their OWN list
        expect(res.body.total).toBe(user === 'agent-a1' ? 3 : 0);
      },
    );

    it('lists only MY notifications, newest first, without internal columns', async () => {
      await seed();
      const res = await http()
        .get('/v1/tenants/tenant-a/notifications')
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(res.body.total).toBe(3);
      expect(res.body.data.map((n: any) => n.id)).toEqual(['n3', 'n2', 'n1']);
      expect(Object.keys(res.body.data[0]).sort()).toEqual([
        'createdAt',
        'id',
        'link',
        'params',
        'readAt',
        'type',
      ]);
      expect(res.body.data[0]).toMatchObject({
        type: 'conversation.escalated',
        link: '/conversations/c3',
        params: { conversationId: 'c3', customer: 'web_abcdef…' },
        readAt: null,
      });
      const other = await http()
        .get('/v1/tenants/tenant-a/notifications')
        .set('Authorization', as('agent-a2'))
        .expect(200);
      expect(other.body.data.map((n: any) => n.id)).toEqual(['n4']);
      const owner = await http()
        .get('/v1/tenants/tenant-a/notifications')
        .set('Authorization', as('owner-a'))
        .expect(200);
      expect(owner.body.total).toBe(0);
    });

    it('?unread=true returns the unread ones and their count as total; paging works', async () => {
      await seed();
      const unread = await http()
        .get('/v1/tenants/tenant-a/notifications?unread=true')
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(unread.body.total).toBe(2);
      expect(unread.body.data.map((n: any) => n.id)).toEqual(['n3', 'n2']);
      const page = await http()
        .get('/v1/tenants/tenant-a/notifications?skip=1&take=1')
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(page.body).toMatchObject({ total: 3, skip: 1, take: 1 });
      expect(page.body.data.map((n: any) => n.id)).toEqual(['n2']);
      await http()
        .get('/v1/tenants/tenant-a/notifications?unread=maybe')
        .set('Authorization', as('agent-a1'))
        .expect(400);
      await http()
        .get('/v1/tenants/tenant-a/notifications?take=101')
        .set('Authorization', as('agent-a1'))
        .expect(400);
    });

    it('marks one read, idempotently, keeping the first read time', async () => {
      await seed();
      const first = await http()
        .post('/v1/tenants/tenant-a/notifications/n2/read')
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(first.body.id).toBe('n2');
      expect(first.body.readAt).toEqual(expect.any(String));
      clock.advanceMs(60_000);
      const again = await http()
        .post('/v1/tenants/tenant-a/notifications/n2/read')
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(again.body.readAt).toBe(first.body.readAt);
      const alreadyRead = await http()
        .post('/v1/tenants/tenant-a/notifications/n1/read')
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(alreadyRead.body.readAt).toBe('2026-10-09T00:00:00.000Z');
    });

    it("someone else's notification, and another tenant's, are a 404 and stay unread", async () => {
      await seed();
      for (const id of ['n4', 'nb1', 'no-such-id']) {
        const res = await http()
          .post(`/v1/tenants/tenant-a/notifications/${id}/read`)
          .set('Authorization', as('agent-a1'))
          .expect(404);
        expect(res.body.code).toBe('NOTIFICATION_NOT_FOUND');
      }
      expect(h.notifications.find((n) => n.id === 'n4')!.readAt).toBeNull();
      expect(h.notifications.find((n) => n.id === 'nb1')!.readAt).toBeNull();
      // an owner cannot read an agent's either
      await http()
        .post('/v1/tenants/tenant-a/notifications/n3/read')
        .set('Authorization', as('owner-a'))
        .expect(404);
    });

    it('read-all marks only my unread ones, and a repeat changes nothing', async () => {
      await seed();
      const first = await http()
        .post('/v1/tenants/tenant-a/notifications/read-all')
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(first.body).toEqual({ updated: 2 });
      const second = await http()
        .post('/v1/tenants/tenant-a/notifications/read-all')
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(second.body).toEqual({ updated: 0 });
      expect(h.notificationsOf('agent-a2')[0].readAt).toBeNull();
      expect(h.notifications.find((n) => n.id === 'nb1')!.readAt).toBeNull();
    });

    it('needs a staff token for the right tenant', async () => {
      await http().get('/v1/tenants/tenant-a/notifications').expect(401);
      await http()
        .get('/v1/tenants/tenant-a/notifications')
        .set('Authorization', as('agent-b'))
        .expect(403);
      await http()
        .post('/v1/tenants/tenant-a/notifications/read-all')
        .set('Authorization', as('agent-b'))
        .expect(403);
    });

    it('GET /v1/me carries my unread count', async () => {
      await seed();
      prisma.tenantUser.findFirst.mockImplementationOnce(() =>
        Promise.resolve({
          id: 'agent-a1',
          email: 'agent-a1@example.test',
          name: null,
          role: 'agent',
          emailVerifiedAt: new Date('2026-01-01'),
          locale: null,
          tenant: {
            id: 'tenant-a',
            name: 'Acme',
            slug: 'acme',
            plan: 'pro',
            status: 'active',
            defaultLocale: 'en',
          },
        }),
      );
      const me = await http()
        .get('/v1/me')
        .set('Authorization', as('agent-a1'))
        .expect(200);
      expect(me.body.unreadNotifications).toBe(2);
    });
  });

  // ===========================================================================================

  describe('OpenAPI', () => {
    it('documents the Phase 4 routes for the frontend', async () => {
      const doc = (await http().get('/docs-json').expect(200)).body;
      const paths = Object.keys(doc.paths);
      expect(paths).toEqual(
        expect.arrayContaining([
          '/v1/tenants/{tenantId}/conversations',
          '/v1/tenants/{tenantId}/conversations/counts',
          '/v1/tenants/{tenantId}/conversations/{id}',
          '/v1/tenants/{tenantId}/conversations/{id}/claim',
          '/v1/tenants/{tenantId}/conversations/{id}/release',
          '/v1/tenants/{tenantId}/conversations/{id}/resolve',
          '/v1/tenants/{tenantId}/conversations/{id}/messages',
          '/v1/tenants/{tenantId}/customers/{id}/conversations',
          '/v1/tenants/{tenantId}/notifications',
          '/v1/tenants/{tenantId}/notifications/read-all',
          '/v1/tenants/{tenantId}/notifications/{id}/read',
          '/v1/tenants/{tenantId}/events',
          '/v1/tenants/{tenantId}/events/ticket',
          '/v1/widget/events',
        ]),
      );
      expect(
        doc.paths['/v1/tenants/{tenantId}/events'].get.responses['200'].content,
      ).toHaveProperty('text/event-stream');
      expect(
        doc.paths['/v1/widget/events'].get.responses['200'].content,
      ).toHaveProperty('text/event-stream');
      expect(
        doc.components.schemas.Me.properties.unreadNotifications,
      ).toMatchObject({
        type: 'number',
      });
    });

    it('every new staff route states who may use it, in the same way (JWT + roles)', async () => {
      const doc = (await http().get('/docs-json').expect(200)).body;
      for (const [path, item] of Object.entries<any>(doc.paths)) {
        if (
          !/\/(conversations|notifications|events)/.test(path) ||
          path.includes('/widget/')
        )
          continue;
        for (const [method, operation] of Object.entries<any>(item)) {
          expect([path, method, JSON.stringify(operation.security)]).toEqual([
            path,
            method,
            JSON.stringify([{ bearer: [] }]),
          ]);
        }
      }
    });
  });
});
