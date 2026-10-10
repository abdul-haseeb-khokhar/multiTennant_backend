import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { FakeClock } from '../src/billing/clock';
import { EntitlementsService } from '../src/billing/entitlements/entitlements.service';
import { WidgetCorsService } from '../src/widget/widget-cors.service';
import { MockEngineClient } from '../src/engine/mock-engine.client';
import { EngineClient } from '../src/engine/engine-client';
import { Gateway, installGateway } from './utils/gateway-fixtures';
import { PrismaMock } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

const KEY_A = 'wk_tenantAKey0123456789abcdefghij';
const KEY_B = 'wk_tenantBKey0123456789abcdefghij';
const ORIGIN_A = 'https://shop-a.example.com';
const ORIGIN_B = 'https://shop-b.example.com';
// A developer machine; deliberately NOT the dashboard origin (FRONTEND_URL is localhost:5173).
const LOCAL_ORIGIN = 'http://localhost:3001';
const VISITOR_1 = 'visitor-one-0123456789abcdef';
const VISITOR_2 = 'visitor-two-0123456789abcdef';

interface SseEvent {
  event: string;
  data: Record<string, any>;
}

/** Reads a text/event-stream body into events. */
function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) };
    });
}

describe('Widget gateway (e2e, mocked database, mock engine)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let clock: FakeClock;
  let engine: MockEngineClient;
  let gateway: Gateway;
  let jwt: Awaited<ReturnType<typeof createTestApp>>['jwt'];
  let platformToken: (id?: string) => string;
  let staffToken: Awaited<ReturnType<typeof createTestApp>>['staffToken'];
  let allowStaff: () => void;

  const http = () => request(app.getHttpServer());

  /** POST /v1/widget/sessions as a browser on `origin`. */
  const startSession = (
    over: Record<string, unknown> = {},
    origin: string | null = ORIGIN_A,
  ) => {
    const call = http().post('/v1/widget/sessions');
    if (origin) call.set('Origin', origin);
    return call.send({ widgetKey: KEY_A, visitorId: VISITOR_1, ...over });
  };

  const openSession = async (
    over: Record<string, unknown> = {},
    origin: string | null = ORIGIN_A,
  ) => {
    const res = await startSession(over, origin).expect(200);
    return res.body as {
      status: string;
      token: string;
      conversationId: string;
      [key: string]: any;
    };
  };

  /** POST /v1/widget/messages and read the whole event stream. */
  const send = async (
    token: string,
    content: string,
    options: { origin?: string; key?: string } = {},
  ) => {
    const call = http()
      .post('/v1/widget/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', options.origin ?? ORIGIN_A)
      .buffer(true)
      .parse((res, done) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          const json = /json/.test(String(res.headers['content-type']));
          done(null, json ? JSON.parse(body) : body);
        });
      });
    if (options.key) call.set('Idempotency-Key', options.key);
    const res = await call.send({ content });
    return {
      res,
      events:
        res.status === 200 && typeof res.body === 'string'
          ? parseSse(res.body)
          : [],
    };
  };

  const history = (token: string, origin = ORIGIN_A, query = '') =>
    http()
      .get(`/v1/widget/conversation${query}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', origin);

  const names = (events: SseEvent[]) => events.map((e) => e.event);

  /** Signs a widget token the way the server does, to build tokens the server never issued. */
  const widgetSecret = createHmac('sha256', 'e2e-test-secret-at-least-16-chars')
    .update('widget-session-token-v1')
    .digest('hex');
  const forge = (
    claims: Record<string, unknown>,
    expiresIn: number | string = 600,
  ) =>
    jwt.sign(
      { scope: 'widget', locale: 'en', ...claims },
      { secret: widgetSecret, expiresIn: expiresIn as never },
    );

  /** Changes a tenant subscription row and drops the entitlements cache, as a real change does. */
  const changeSubscription = (
    tenantId: string,
    patch: Record<string, unknown>,
  ) => {
    Object.assign(gateway.subscriptions.get(tenantId)!, patch);
    app.get(EntitlementsService).invalidate(tenantId);
  };

  beforeAll(async () => {
    // High limits here so the many calls of this file do not trip them; the rate-limit tests
    // below build their own app with small numbers.
    const big = 1_000_000;
    ({
      app,
      prisma,
      clock,
      engine,
      jwt,
      platformToken,
      staffToken,
      allowStaff,
    } = await createTestApp({
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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    engine.reset();
    allowStaff();
    gateway = installGateway(prisma, clock, {
      tenants: [
        { id: 'tenant-a', plan: 'free', defaultLocale: 'en' },
        { id: 'tenant-b', plan: 'pro', defaultLocale: 'ur' },
      ],
      keys: [
        {
          id: 'key-a',
          tenantId: 'tenant-a',
          key: KEY_A,
          allowedOrigins: [ORIGIN_A, LOCAL_ORIGIN],
        },
        {
          id: 'key-b',
          tenantId: 'tenant-b',
          key: KEY_B,
          allowedOrigins: [ORIGIN_B],
        },
      ],
    });
    app.get(WidgetCorsService).clearCache();
    for (const tenantId of ['tenant-a', 'tenant-b']) {
      app.get(EntitlementsService).invalidate(tenantId);
    }
  });

  // =============================================================================================
  describe('POST /v1/widget/sessions', () => {
    it('starts a session: customer web_<visitor>, a conversation in the engine, a counted conversation and a token', async () => {
      const res = await startSession().expect(200);
      expect(res.body).toMatchObject({
        status: 'ready',
        locale: 'en',
        defaultLocale: 'en',
        poweredBy: true,
        greeting: 'Hi! How can I help you today?',
        expiresInSeconds: 900,
      });
      expect(res.body.token).toEqual(expect.any(String));
      expect(res.headers['cache-control']).toBe('no-store');

      // B4: the end customer, per tenant, with the web_ prefix.
      expect(gateway.endCustomers).toHaveLength(1);
      expect(gateway.endCustomers[0]).toMatchObject({
        tenantId: 'tenant-a',
        externalId: `web_${VISITOR_1}`,
      });
      // The engine got the conversation for THIS tenant and THIS end customer id.
      const stored = engine.inspect('tenant-a', res.body.conversationId);
      expect(stored?.conversation).toMatchObject({
        channel: 'widget',
        endCustomerId: gateway.endCustomers[0].id,
        status: 'active',
      });
      expect(engine.inspect('tenant-b', res.body.conversationId)).toBeNull();
      // The gateway's record, and the conversation counted once.
      expect(gateway.conversations).toHaveLength(1);
      expect(gateway.usageOf('tenant-a')[0].conversations).toBe(1);
    });

    it('never takes the tenant from the request: a tenantId in the body is ignored', async () => {
      const res = await startSession({ tenantId: 'tenant-b' }).expect(200);
      expect(
        engine.inspect('tenant-a', res.body.conversationId),
      ).not.toBeNull();
      expect(engine.inspect('tenant-b', res.body.conversationId)).toBeNull();
      expect(gateway.conversations[0].tenantId).toBe('tenant-a');
    });

    it('refreshes with the same visitorId: same conversation, new token, counted once', async () => {
      const first = await openSession();
      const second = await openSession();
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.token).not.toBe(first.token);
      expect(gateway.conversations).toHaveLength(1);
      expect(gateway.endCustomers).toHaveLength(1);
      expect(gateway.usageOf('tenant-a')[0].conversations).toBe(1);
    });

    it('gives another visitor their own customer and conversation', async () => {
      const one = await openSession();
      const two = await openSession({ visitorId: VISITOR_2 });
      expect(two.conversationId).not.toBe(one.conversationId);
      expect(gateway.endCustomers).toHaveLength(2);
      expect(gateway.usageOf('tenant-a')[0].conversations).toBe(2);
    });

    it('two simultaneous first visits of the same visitor make one customer and one conversation', async () => {
      const [a, b] = await Promise.all([startSession(), startSession()]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.conversationId).toBe(b.body.conversationId);
      expect(gateway.endCustomers).toHaveLength(1);
      expect(gateway.conversations).toHaveLength(1);
      expect(engine.conversationCount('tenant-a')).toBe(1);
      expect(gateway.usageOf('tenant-a')[0].conversations).toBe(1);
    });

    it('starts a new conversation when the old one was resolved', async () => {
      const first = await openSession();
      engine.resolve('tenant-a', first.conversationId);
      const second = await openSession();
      expect(second.conversationId).not.toBe(first.conversationId);
      expect(
        gateway.conversations.find(
          (c) => c.conversationId === first.conversationId,
        )?.closedAt,
      ).not.toBeNull();
      expect(gateway.usageOf('tenant-a')[0].conversations).toBe(2);
    });

    it('speaks the visitor language, falling back to the tenant default', async () => {
      const ur = await openSession({ locale: 'ur-PK' });
      expect(ur.locale).toBe('ur');
      expect(ur.greeting).not.toBe('Hi! How can I help you today?');
      const bDefault = await http()
        .post('/v1/widget/sessions')
        .set('Origin', ORIGIN_B)
        .send({ widgetKey: KEY_B, visitorId: VISITOR_1, locale: 'fr' })
        .expect(200);
      expect(bDefault.body).toMatchObject({
        locale: 'ur',
        defaultLocale: 'ur',
      });
      expect(bDefault.body.poweredBy).toBe(false); // Pro has no label
    });

    describe('key and origin (D8)', () => {
      it('refuses a request without an Origin header', async () => {
        const res = await startSession({}, null).expect(403);
        expect(res.body).toMatchObject({
          statusCode: 403,
          code: 'ORIGIN_NOT_ALLOWED',
        });
        expect(gateway.endCustomers).toHaveLength(0);
      });

      it('refuses an origin the key does not list, including look-alikes', async () => {
        for (const origin of [
          'https://evil.example.com',
          'https://shop-a.example.com.evil.com',
          'http://shop-a.example.com',
          'https://shop-a.example.com:8443',
          ORIGIN_B,
          'null',
        ]) {
          const res = await startSession({}, origin).expect(403);
          expect(res.body.code).toBe('ORIGIN_NOT_ALLOWED');
          // No CORS permission is given to a site that is not allowed.
          expect(res.headers['access-control-allow-origin']).toBeUndefined();
        }
        expect(gateway.endCustomers).toHaveLength(0);
      });

      it("another tenant's key does not work from this tenant's origin (and vice versa)", async () => {
        await startSession({ widgetKey: KEY_B }, ORIGIN_A).expect(403);
        await startSession({ widgetKey: KEY_A }, ORIGIN_B).expect(403);
      });

      it('accepts the origin in any spelling the browser may use', async () => {
        await startSession({}, 'HTTPS://Shop-A.example.com').expect(200);
        await startSession({}, LOCAL_ORIGIN).expect(200);
      });

      it('refuses an unknown, malformed, revoked or server key the same way (401 WIDGET_KEY_INVALID)', async () => {
        gateway.apiKeys.push({
          id: 'key-s',
          tenantId: 'tenant-a',
          type: 'server',
          keyHash: gateway.sha256('wk_serverLooksLikeAWidgetKey012345'),
          allowedOrigins: [ORIGIN_A],
          revokedAt: null,
        });
        gateway.apiKeys.find((k) => k.id === 'key-a')!.revokedAt = new Date();
        for (const widgetKey of [
          KEY_A, // revoked
          'wk_neverIssued0123456789abcdefghij',
          'wk_short',
          'sk_notAWidgetKey0123456789abcdefghij',
          'wk_serverLooksLikeAWidgetKey012345',
        ]) {
          const res = await startSession({ widgetKey }).expect(401);
          expect(res.body.code).toBe('WIDGET_KEY_INVALID');
          expect(res.headers['access-control-allow-origin']).toBeUndefined();
        }
      });

      it('lets the allowed origin read the response and nobody else', async () => {
        const res = await startSession().expect(200);
        expect(res.headers['access-control-allow-origin']).toBe(ORIGIN_A);
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
        expect(res.headers.vary).toMatch(/Origin/);
        expect(res.headers['access-control-expose-headers']).toContain(
          'X-Request-Id',
        );
      });

      it('applies a changed allow-list on the very next request', async () => {
        await startSession().expect(200);
        gateway.apiKeys.find((k) => k.id === 'key-a')!.allowedOrigins = [
          'https://other.example.com',
        ];
        await startSession().expect(403);
      });
    });

    describe('input validation', () => {
      it.each([
        ['a short visitor id', { visitorId: 'short' }],
        [
          'a visitor id with spaces',
          { visitorId: 'visitor id with spaces 1234' },
        ],
        ['a visitor id over 64 characters', { visitorId: 'a'.repeat(65) }],
        ['no visitor id', { visitorId: undefined }],
        ['no widget key', { widgetKey: undefined }],
        ['a non-string key', { widgetKey: { $ne: null } }],
        ['a bad locale', { locale: 'not a locale!' }],
      ])('rejects %s with 400', async (_label, over) => {
        const res = await startSession(over as Record<string, unknown>);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      });
    });

    describe('blocked states: the customer gets a text, never an error (I5, D7)', () => {
      it.each([
        ['a suspended tenant', { status: 'suspended' }, undefined],
        ['a closed tenant', { status: 'closed' }, undefined],
        [
          'a tenant whose subscription is suspended',
          {},
          { subscriptionStatus: 'suspended' },
        ],
      ])(
        '%s -> 200 blocked, no token, no customer, no engine call',
        async (_l, tenant, sub) => {
          gateway.tenants.get('tenant-a')!.status =
            (tenant as { status?: string }).status ?? 'active';
          if (sub) {
            changeSubscription('tenant-a', { status: sub.subscriptionStatus });
          }
          const res = await startSession().expect(200);
          expect(res.body).toMatchObject({
            status: 'blocked',
            fallback: { reason: 'service_unavailable' },
          });
          expect(res.body.fallback.message).toEqual(expect.any(String));
          expect(res.body.token).toBeUndefined();
          expect(res.body.conversationId).toBeUndefined();
          // Nothing was created anywhere.
          expect(gateway.endCustomers).toHaveLength(0);
          expect(engine.conversationCount('tenant-a')).toBe(0);
          // The allowed origin may still read the explanation.
          expect(res.headers['access-control-allow-origin']).toBe(ORIGIN_A);
        },
      );

      it('the blocked text never mentions billing and is translated', async () => {
        gateway.tenants.get('tenant-a')!.status = 'suspended';
        const en = (await startSession().expect(200)).body.fallback.message;
        const ur = (await startSession({ locale: 'ur' }).expect(200)).body
          .fallback.message;
        expect(en).not.toMatch(/suspend|plan|payment|limit/i);
        expect(ur).not.toBe(en);
      });

      it('keeps answering a tenant whose payment is overdue (past_due)', async () => {
        changeSubscription('tenant-a', {
          status: 'past_due',
          planCode: 'pro',
          graceEndsAt: new Date(clock.now().getTime() + 5 * 86_400_000),
        });
        const res = await startSession().expect(200);
        expect(res.body.status).toBe('ready');
      });

      it('answers blocked ai_unavailable when the engine is down and there is no conversation yet', async () => {
        engine.setDown(true);
        const res = await startSession().expect(200);
        expect(res.body).toMatchObject({
          status: 'blocked',
          fallback: { reason: 'ai_unavailable' },
        });
        expect(res.body.token).toBeUndefined();
        expect(gateway.conversations).toHaveLength(0);
      });

      it('lets a returning visitor resume while the engine is down (the message call has its own fallback)', async () => {
        const first = await openSession();
        engine.setDown(true);
        const again = await startSession().expect(200);
        expect(again.body.status).toBe('ready');
        expect(again.body.conversationId).toBe(first.conversationId);
      });
    });

    describe('conversation limits from real usage (I5)', () => {
      it('Free allows 30 conversations a month: the 31st is "limited", still counted, still answered by a human', async () => {
        gateway.seedConversations('tenant-a', 29);
        const thirtieth = await openSession({
          visitorId: 'visitor-thirtieth-0123456',
        });
        expect(thirtieth.status).toBe('ready');
        const thirtyFirst = await openSession({
          visitorId: 'visitor-thirtyfirst-012345',
        });
        expect(thirtyFirst).toMatchObject({
          status: 'limited',
          fallback: { reason: 'limit_reached' },
        });
        expect(thirtyFirst.token).toEqual(expect.any(String));
        expect(
          gateway.conversations.find(
            (c) => c.conversationId === thirtyFirst.conversationId,
          )?.aiBlocked,
        ).toBe(true);
        // Counted although not answered by the AI.
        const total = gateway
          .usageOf('tenant-a')
          .reduce((sum, r) => sum + r.conversations, 0);
        expect(total).toBe(31);
      });

      it('a returning visitor of a limited conversation does not use up another conversation', async () => {
        gateway.seedConversations('tenant-a', 30);
        await openSession();
        await openSession();
        await openSession();
        const total = gateway
          .usageOf('tenant-a')
          .reduce((sum, r) => sum + r.conversations, 0);
        expect(total).toBe(31);
      });

      it('a resumed conversation is never blocked by the limit it started under', async () => {
        const first = await openSession();
        gateway.seedConversations('tenant-a', 100);
        const again = await openSession();
        expect(again.conversationId).toBe(first.conversationId);
        expect(again.status).toBe('ready');
      });

      it('a paid plan has its own limit and an override raises it', async () => {
        changeSubscription('tenant-a', {
          entitlementsOverride: { conversationsPerPeriod: 1 },
        });
        const first = await openSession();
        expect(first.status).toBe('ready');
        const second = await openSession({ visitorId: VISITOR_2 });
        expect(second.status).toBe('limited');
        changeSubscription('tenant-a', {
          entitlementsOverride: { conversationsPerPeriod: null },
        });
        const third = await openSession({
          visitorId: 'visitor-three-0123456789',
        });
        expect(third.status).toBe('ready');
      });
    });
  });

  // =============================================================================================
  describe('CORS for widget routes (D8)', () => {
    const preflight = (origin: string, path = '/v1/widget/sessions') =>
      http()
        .options(path)
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization, content-type');

    it('answers the preflight for an origin some widget key lists, echoing that origin only', async () => {
      const res = await preflight(ORIGIN_A).expect(204);
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN_A);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(
        res.headers['access-control-allow-headers']?.toLowerCase(),
      ).toContain('authorization');
      expect(res.headers.vary).toMatch(/Origin/);
    });

    it('works for every widget route', async () => {
      for (const path of [
        '/v1/widget/sessions',
        '/v1/widget/messages',
        '/v1/widget/conversation',
      ]) {
        const res = await preflight(ORIGIN_B, path);
        expect(res.headers['access-control-allow-origin']).toBe(ORIGIN_B);
      }
    });

    it('gives no permission to an origin no key lists, never reflects an arbitrary origin, never uses a wildcard', async () => {
      for (const origin of [
        'https://evil.example.com',
        'http://shop-a.example.com',
        'null',
      ]) {
        const res = await preflight(origin);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      }
      const withKnown = await preflight(ORIGIN_A);
      expect(withKnown.headers['access-control-allow-origin']).not.toBe('*');
    });

    it('stops allowing an origin once the only key that listed it is revoked', async () => {
      expect(
        (await preflight(ORIGIN_B)).headers['access-control-allow-origin'],
      ).toBe(ORIGIN_B);
      gateway.apiKeys.find((k) => k.id === 'key-b')!.revokedAt = new Date();
      app.get(WidgetCorsService).clearCache();
      expect(
        (await preflight(ORIGIN_B)).headers['access-control-allow-origin'],
      ).toBeUndefined();
    });

    it('does not change the dashboard policy: FRONTEND_URL on dashboard routes only, key origins on widget routes only', async () => {
      const dashboardOrigin = 'http://localhost:5173';
      const onDashboard = (origin: string) =>
        http()
          .options('/v1/me')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'GET');
      const allowed = (res: request.Response) =>
        res.headers['access-control-allow-origin'];
      expect(allowed(await onDashboard(dashboardOrigin))).toBe(dashboardOrigin);
      // A customer site is not allowed on the dashboard API: the answer names the dashboard
      // origin only (as before), never the caller, so the browser refuses it.
      expect(allowed(await onDashboard(ORIGIN_A))).toBe(dashboardOrigin);
      expect(allowed(await onDashboard(LOCAL_ORIGIN))).toBe(dashboardOrigin);
      // The dashboard origin is on no widget key, so widget routes refuse it; a listed one works.
      expect(allowed(await preflight(dashboardOrigin))).toBeUndefined();
      expect(allowed(await preflight(LOCAL_ORIGIN))).toBe(LOCAL_ORIGIN);
    });
  });

  // =============================================================================================
  describe('POST /v1/widget/messages (server-sent events)', () => {
    it('streams accepted, tokens and done, and stores the exchange for this tenant only', async () => {
      const session = await openSession();
      const { res, events } = await send(
        session.token,
        'What are your opening hours?',
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
      expect(res.headers['cache-control']).toMatch(/no-cache/);
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN_A);
      expect(names(events)[0]).toBe('accepted');
      expect(names(events).at(-1)).toBe('done');
      const text = events
        .filter((e) => e.event === 'token')
        .map((e) => e.data.text)
        .join('');
      expect(text).toContain('9:00');
      expect(events.at(-1)!.data).toMatchObject({
        aiReply: true,
        conversationStatus: 'active',
      });
      // The stored conversation belongs to tenant A.
      const stored = engine.inspect('tenant-a', session.conversationId)!;
      expect(stored.messages.map((m) => m.authorType)).toEqual([
        'customer',
        'ai',
      ]);
      expect(stored.messages[1].content).toBe(text);
    });

    it('records usage from the stream: two messages, the tokens, once', async () => {
      const session = await openSession();
      await send(session.token, 'What are your opening hours?');
      const [row] = gateway.usageOf('tenant-a');
      expect(row.messages).toBe(2);
      expect(row.tokensIn).toBeGreaterThan(0);
      expect(row.tokensOut).toBeGreaterThan(0);
      expect(
        gateway.usageEvents.filter((e) => e.kind === 'message'),
      ).toHaveLength(2);
    });

    it('is idempotent per Idempotency-Key: a retry stores and counts nothing twice', async () => {
      const session = await openSession();
      const first = await send(session.token, 'What are your opening hours?', {
        key: 'retry-key-0001',
      });
      const second = await send(session.token, 'What are your opening hours?', {
        key: 'retry-key-0001',
      });
      expect(names(second.events)).toEqual(
        expect.arrayContaining(['accepted', 'token', 'done']),
      );
      expect(second.events[0].data.messageId).toBe(
        first.events[0].data.messageId,
      );
      expect(
        engine.inspect('tenant-a', session.conversationId)!.messages,
      ).toHaveLength(2);
      expect(gateway.usageOf('tenant-a')[0].messages).toBe(2);
    });

    it('rejects a malformed Idempotency-Key with 400 before streaming', async () => {
      const session = await openSession();
      const res = await http()
        .post('/v1/widget/messages')
        .set('Authorization', `Bearer ${session.token}`)
        .set('Origin', ORIGIN_A)
        .set('Idempotency-Key', 'no spaces allowed')
        .send({ content: 'hello' });
      expect(res.status).toBe(400);
    });

    describe('length limit (F6)', () => {
      it('accepts exactly 2,000 characters and refuses 2,001 with 400 MESSAGE_TOO_LONG', async () => {
        const session = await openSession();
        const ok = await send(session.token, 'a'.repeat(2000));
        expect(ok.res.status).toBe(200);
        const tooLong = await send(session.token, 'a'.repeat(2001));
        expect(tooLong.res.status).toBe(400);
        expect(tooLong.res.headers['content-type']).toMatch(/json/); // an error, not a stream
        const body = await http()
          .post('/v1/widget/messages')
          .set('Authorization', `Bearer ${session.token}`)
          .set('Origin', ORIGIN_A)
          .send({ content: 'a'.repeat(2001) })
          .expect(400);
        expect(body.body).toMatchObject({
          statusCode: 400,
          code: 'MESSAGE_TOO_LONG',
        });
        expect(body.headers['content-type']).toMatch(/json/);
      });

      it('counts characters, not UTF-16 units (emoji and Urdu)', async () => {
        const session = await openSession();
        const emoji = '😀'.repeat(2000); // 4000 UTF-16 units, 2000 characters
        expect((await send(session.token, emoji)).res.status).toBe(200);
        const urdu = 'ا'.repeat(2000);
        expect((await send(session.token, urdu)).res.status).toBe(200);
        expect((await send(session.token, '😀'.repeat(2001))).res.status).toBe(
          400,
        );
      });

      it.each([[''], ['   '], [undefined], [42]])(
        'rejects an empty or non-text message (%j) with 400',
        async (content) => {
          const session = await openSession();
          const res = await http()
            .post('/v1/widget/messages')
            .set('Authorization', `Bearer ${session.token}`)
            .set('Origin', ORIGIN_A)
            .send({ content });
          expect(res.status).toBe(400);
          expect(res.body.code).toBe('VALIDATION_ERROR');
        },
      );
    });

    describe('escalation', () => {
      it('hands over when the engine decides to, and says so', async () => {
        const session = await openSession();
        const { events } = await send(session.token, '/escalate');
        expect(names(events)).toEqual(
          expect.arrayContaining(['accepted', 'token', 'escalated', 'done']),
        );
        const escalated = events.find((e) => e.event === 'escalated')!;
        expect(escalated.data.reason).toBe('customer_requested');
        expect(escalated.data.message).toEqual(expect.any(String));
        expect(events.at(-1)!.data.conversationStatus).toBe('escalated');
        expect(
          engine.inspect('tenant-a', session.conversationId)!.conversation,
        ).toMatchObject({
          status: 'escalated',
          escalationReason: 'customer_requested',
        });
      });

      it('a follow-up on an escalated conversation is stored, gets no AI reply, and the customer is told a colleague will reply', async () => {
        const session = await openSession();
        await send(session.token, '/escalate');
        const { events } = await send(session.token, 'Hello? Anyone there?');
        expect(names(events)).toEqual(['accepted', 'escalated', 'done']);
        expect(events.at(-1)!.data).toMatchObject({
          aiReply: false,
          conversationStatus: 'escalated',
        });
        const messages = engine.inspect(
          'tenant-a',
          session.conversationId,
        )!.messages;
        expect(messages.filter((m) => m.authorType === 'ai')).toHaveLength(1);
        expect(messages.at(-1)).toMatchObject({
          authorType: 'customer',
          content: 'Hello? Anyone there?',
        });
      });

      it('stays silent while a human handles it (no escalated notice, no AI)', async () => {
        const session = await openSession();
        engine.postHumanMessage(
          'tenant-a',
          session.conversationId,
          'user-1',
          'I am here',
        );
        const { events } = await send(session.token, 'Thanks');
        expect(names(events)).toEqual(['accepted', 'done']);
        expect(events.at(-1)!.data.conversationStatus).toBe('human_active');
      });
    });

    describe('when the plan limit is reached (I5): stored for a human, escalated, no LLM', () => {
      it('stores the message without an AI reply, escalates with limit_reached and answers with the fallback', async () => {
        gateway.seedConversations('tenant-a', 30);
        const session = await openSession();
        expect(session.status).toBe('limited');
        const spy = jest.spyOn(app.get(EngineClient), 'sendMessage');
        const { events } = await send(
          session.token,
          'I need help with my order',
        );
        expect(names(events)).toEqual(['accepted', 'fallback']);
        expect(events[1].data).toMatchObject({
          reason: 'limit_reached',
          escalated: true,
        });
        expect(events[1].data.message).toEqual(expect.any(String));
        // The model was asked not to answer (aiReply false), and nothing from it is stored.
        expect(spy.mock.calls[0][2]).toMatchObject({ aiReply: false });
        const stored = engine.inspect('tenant-a', session.conversationId)!;
        expect(stored.messages.map((m) => m.authorType)).toEqual(['customer']);
        expect(stored.conversation).toMatchObject({
          status: 'escalated',
          escalationReason: 'limit_reached',
        });
        expect(
          gateway.conversations.find(
            (c) => c.conversationId === session.conversationId,
          ),
        ).toMatchObject({
          escalationReason: 'limit_reached',
          escalationPending: false,
        });
        spy.mockRestore();
      });
    });

    describe('when the engine is down or too slow (D7)', () => {
      it('/fail: fallback ai_unavailable, and the conversation is escalated', async () => {
        const session = await openSession();
        const { events } = await send(session.token, '/fail');
        expect(names(events)).toEqual(['fallback']);
        expect(events[0].data).toMatchObject({
          reason: 'ai_unavailable',
          escalated: true,
        });
        expect(
          engine.inspect('tenant-a', session.conversationId)!.conversation,
        ).toMatchObject({
          status: 'escalated',
          escalationReason: 'ai_unavailable',
        });
      });

      it('/slow: no first token in time -> fallback after the timeout, escalated', async () => {
        const session = await openSession();
        const started = Date.now();
        const { events } = await send(session.token, '/slow');
        expect(names(events)).toEqual(['accepted', 'fallback']);
        expect(events[1].data).toMatchObject({
          reason: 'ai_unavailable',
          escalated: true,
        });
        expect(Date.now() - started).toBeLessThan(3000);
      });

      it('/broken: an error after the first words still ends in a fallback, never a dangling stream', async () => {
        const session = await openSession();
        const { events } = await send(session.token, '/broken');
        expect(names(events)).toEqual(['accepted', 'token', 'fallback']);
        expect(events.at(-1)!.data.reason).toBe('ai_unavailable');
      });

      it('engine completely down: still a fallback, and the escalation is remembered for later', async () => {
        const session = await openSession();
        engine.setDown(true);
        const { res, events } = await send(session.token, 'Hello there');
        expect(res.status).toBe(200);
        expect(names(events)).toEqual(['fallback']);
        expect(events[0].data).toMatchObject({
          reason: 'ai_unavailable',
          escalated: false,
        });
        expect(
          gateway.conversations.find(
            (c) => c.conversationId === session.conversationId,
          ),
        ).toMatchObject({
          escalationReason: 'ai_unavailable',
          escalationPending: true,
        });
      });

      it('never logs or leaks message text or the engine failure to the customer', async () => {
        const session = await openSession();
        engine.setDown(true);
        const { events } = await send(session.token, 'my secret order 12345');
        expect(JSON.stringify(events.map((e) => e.data.message))).not.toMatch(
          /secret order|mock engine|unavailable|ECONN/i,
        );
        expect(JSON.stringify(events)).not.toMatch(/secret order|mock engine/i);
      });
    });

    it('answers a conversation that no longer exists in the engine with an error event and closes it', async () => {
      const session = await openSession();
      engine.reset(); // the engine lost it
      const { events } = await send(session.token, 'hello');
      expect(events).toEqual([
        { event: 'error', data: { code: 'CONVERSATION_NOT_FOUND' } },
      ]);
      expect(
        gateway.conversations.find(
          (c) => c.conversationId === session.conversationId,
        )?.closedAt,
      ).not.toBeNull();
      // The widget starts over.
      const fresh = await openSession();
      expect(fresh.conversationId).not.toBe(session.conversationId);
    });

    it('tells the widget when the conversation was resolved meanwhile', async () => {
      const session = await openSession();
      engine.resolve('tenant-a', session.conversationId);
      const { events } = await send(session.token, 'hello');
      expect(events).toEqual([
        { event: 'error', data: { code: 'CONVERSATION_RESOLVED' } },
      ]);
    });

    it('blocks mid-session when the tenant gets suspended: fallback, and the engine is not called', async () => {
      const session = await openSession();
      gateway.tenants.get('tenant-a')!.status = 'suspended';
      const spy = jest.spyOn(app.get(EngineClient), 'sendMessage');
      const { events } = await send(session.token, 'hello');
      expect(names(events)).toEqual(['fallback']);
      expect(events[0].data).toMatchObject({
        reason: 'service_unavailable',
        escalated: false,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // =============================================================================================
  describe('GET /v1/widget/conversation', () => {
    it('returns this visitor conversation, oldest first, without internal data', async () => {
      const session = await openSession();
      await send(session.token, 'What are your opening hours?');
      engine.postHumanMessage(
        'tenant-a',
        session.conversationId,
        'staff-user-77',
        'Hello from a human',
      );
      const res = await history(session.token).expect(200);
      expect(res.body).toMatchObject({
        id: session.conversationId,
        status: 'human_active',
        total: 3,
      });
      expect(res.body.data.map((m: any) => m.authorType)).toEqual([
        'customer',
        'ai',
        'human',
      ]);
      // The staff member's identity never reaches a widget.
      expect(JSON.stringify(res.body)).not.toContain('staff-user-77');
      expect(res.body.data[0]).not.toHaveProperty('authorUserId');
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN_A);
    });

    it('pages the messages', async () => {
      const session = await openSession();
      await send(session.token, 'What are your opening hours?');
      const page = await history(
        session.token,
        ORIGIN_A,
        '?skip=1&take=1',
      ).expect(200);
      expect(page.body).toMatchObject({ skip: 1, take: 1, total: 2 });
      expect(page.body.data).toHaveLength(1);
      await history(session.token, ORIGIN_A, '?take=101').expect(400);
    });

    it('answers 503 ENGINE_UNAVAILABLE when the engine cannot be reached', async () => {
      const session = await openSession();
      engine.setDown(true);
      const res = await history(session.token).expect(503);
      expect(res.body.code).toBe('ENGINE_UNAVAILABLE');
    });

    it('is refused for a suspended tenant', async () => {
      const session = await openSession();
      gateway.tenants.get('tenant-a')!.status = 'suspended';
      const res = await history(session.token).expect(403);
      expect(res.body.code).toBe('TENANT_SUSPENDED');
    });
  });

  // =============================================================================================
  describe('tokens: widget, staff and platform tokens are not interchangeable', () => {
    it('widget routes need a token', async () => {
      await http()
        .post('/v1/widget/messages')
        .set('Origin', ORIGIN_A)
        .send({ content: 'hi' })
        .expect(401);
      await http()
        .get('/v1/widget/conversation')
        .set('Origin', ORIGIN_A)
        .expect(401);
    });

    it('refuses a staff token and a platform token on every widget route', async () => {
      const staff = staffToken({
        userId: 'owner-1',
        tenantId: 'tenant-a',
        role: 'owner',
      });
      const platform = platformToken();
      for (const token of [staff, platform]) {
        const messages = await http()
          .post('/v1/widget/messages')
          .set('Authorization', `Bearer ${token}`)
          .set('Origin', ORIGIN_A)
          .send({ content: 'hi' });
        expect(messages.status).toBe(401);
        const conversation = await history(token);
        expect(conversation.status).toBe(401);
      }
    });

    it('refuses a widget token on staff routes and on platform routes', async () => {
      const session = await openSession();
      const bearer = `Bearer ${session.token}`;
      const staffRoutes = [
        '/v1/me',
        '/v1/tenants/tenant-a/users',
        '/v1/tenants/tenant-a/customers',
        '/v1/tenants/tenant-a/api-keys',
        '/v1/tenants/tenant-a/billing',
        '/v1/tenants/tenant-a/audit-logs',
      ];
      for (const path of staffRoutes) {
        const res = await http().get(path).set('Authorization', bearer);
        expect(res.status).toBe(401);
      }
      await http()
        .get('/v1/admin/tenants')
        .set('Authorization', bearer)
        .expect(401);
    });

    it('refuses a widget-looking token signed with the staff secret, and a tampered one', async () => {
      const session = await openSession();
      const forged = jwt.sign({
        scope: 'widget',
        tenantId: 'tenant-a',
        endCustomerId: gateway.endCustomers[0].id,
        conversationId: session.conversationId,
        keyId: 'key-a',
      });
      expect((await history(forged)).status).toBe(401);

      const [h, , s] = session.token.split('.');
      const payload = Buffer.from(
        JSON.stringify({
          scope: 'widget',
          tenantId: 'tenant-b',
          endCustomerId: 'x',
          conversationId: session.conversationId,
          keyId: 'key-b',
        }),
      ).toString('base64url');
      expect((await history(`${h}.${payload}.${s}`)).status).toBe(401);
    });

    it('tells the widget an expired token expired, so it can refresh', async () => {
      const session = await openSession();
      const expired = forge(
        {
          tenantId: 'tenant-a',
          endCustomerId: gateway.endCustomers[0].id,
          conversationId: session.conversationId,
          keyId: 'key-a',
        },
        -10,
      );
      const res = await history(expired).expect(401);
      expect(res.body.code).toBe('WIDGET_TOKEN_EXPIRED');
      // Refreshing is another call to the session endpoint.
      const refreshed = await openSession();
      expect((await history(refreshed.token)).status).toBe(200);
    });

    it('a revoked key ends its sessions at the next request', async () => {
      const session = await openSession();
      gateway.apiKeys.find((k) => k.id === 'key-a')!.revokedAt = new Date();
      const res = await history(session.token).expect(401);
      expect(res.body.code).toBe('WIDGET_KEY_INVALID');
      expect((await send(session.token, 'hello')).res.body).toMatchObject({
        code: 'WIDGET_KEY_INVALID',
      });
    });

    it('the token must be used from an origin its key allows', async () => {
      const session = await openSession();
      const res = await history(session.token, ORIGIN_B).expect(403);
      expect(res.body.code).toBe('ORIGIN_NOT_ALLOWED');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      await http()
        .get('/v1/widget/conversation')
        .set('Authorization', `Bearer ${session.token}`)
        .expect(403); // no Origin at all
    });
  });

  // =============================================================================================
  describe('tenant isolation: two tenants, two visitors', () => {
    it('each visitor reaches only their own conversation, in their own tenant', async () => {
      const a1 = await openSession(); // tenant A, visitor 1
      const a2 = await openSession({ visitorId: VISITOR_2 }); // tenant A, visitor 2
      const b1 = await http()
        .post('/v1/widget/sessions')
        .set('Origin', ORIGIN_B)
        .send({ widgetKey: KEY_B, visitorId: VISITOR_1 })
        .expect(200)
        .then((res) => res.body); // tenant B, SAME visitor id as a1

      // Same visitor id in two tenants: two different customers and conversations.
      expect(b1.conversationId).not.toBe(a1.conversationId);
      expect(
        gateway.endCustomers.filter((c) => c.externalId === `web_${VISITOR_1}`),
      ).toHaveLength(2);

      await send(a1.token, 'ALPHA-ONE private text');
      await send(a2.token, 'ALPHA-TWO private text');
      await send(b1.token, 'BETA-ONE private text', { origin: ORIGIN_B });

      const read = async (token: string, origin: string) =>
        JSON.stringify((await history(token, origin).expect(200)).body);
      const seenByA1 = await read(a1.token, ORIGIN_A);
      const seenByA2 = await read(a2.token, ORIGIN_A);
      const seenByB1 = await read(b1.token, ORIGIN_B);

      expect(seenByA1).toContain('ALPHA-ONE');
      expect(seenByA1).not.toMatch(/ALPHA-TWO|BETA-ONE/);
      expect(seenByA2).toContain('ALPHA-TWO');
      expect(seenByA2).not.toMatch(/ALPHA-ONE|BETA-ONE/);
      expect(seenByB1).toContain('BETA-ONE');
      expect(seenByB1).not.toMatch(/ALPHA/);

      // The engine keeps them apart by tenant too.
      expect(engine.inspect('tenant-b', a1.conversationId)).toBeNull();
      expect(engine.inspect('tenant-a', b1.conversationId)).toBeNull();
      // And the usage is per tenant.
      expect(gateway.usageOf('tenant-a')[0].conversations).toBe(2);
      expect(gateway.usageOf('tenant-b')[0].conversations).toBe(1);
    });

    it('a validly signed token that mixes visitor 1 with the conversation of visitor 2 still reaches nothing', async () => {
      const a1 = await openSession();
      const a2 = await openSession({ visitorId: VISITOR_2 });
      void a1;
      const mixed = forge({
        tenantId: 'tenant-a',
        endCustomerId: gateway.endCustomers[0].id,
        conversationId: a2.conversationId,
        keyId: 'key-a',
      });
      const res = await history(mixed).expect(404);
      expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
      const message = await send(mixed, 'hello');
      expect(message.res.status).toBe(404);
      // Nothing was written to the conversation of visitor 2.
      expect(
        engine.inspect('tenant-a', a2.conversationId)!.messages,
      ).toHaveLength(0);
    });

    it('a signed token naming tenant B with a conversation of tenant A reaches nothing either', async () => {
      const a1 = await openSession();
      const crossed = forge({
        tenantId: 'tenant-b',
        endCustomerId: gateway.endCustomers[0].id,
        conversationId: a1.conversationId,
        keyId: 'key-b',
      });
      const res = await history(crossed, ORIGIN_B).expect(404);
      expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('the key of tenant B cannot start a session for tenant A: the tenant always comes from the key', async () => {
      const session = await http()
        .post('/v1/widget/sessions')
        .set('Origin', ORIGIN_B)
        .send({ widgetKey: KEY_B, visitorId: VISITOR_1 })
        .expect(200);
      expect(
        engine.inspect('tenant-b', session.body.conversationId),
      ).not.toBeNull();
      expect(
        engine.inspect('tenant-a', session.body.conversationId),
      ).toBeNull();
      expect(gateway.conversations[0].tenantId).toBe('tenant-b');
    });
  });

  // =============================================================================================
  describe('rate limits (F6)', () => {
    let limited: Awaited<ReturnType<typeof createTestApp>>;
    let limitedGateway: Gateway;
    const call = (path: string, body: object, token?: string, ip?: string) => {
      const req = request(limited.app.getHttpServer())
        .post(path)
        .set('Origin', ORIGIN_A);
      if (token) req.set('Authorization', `Bearer ${token}`);
      if (ip) req.set('X-Forwarded-For', ip);
      return req.send(body);
    };

    const build = async (limits: Record<string, number>) => {
      limited = await createTestApp({ widgetLimits: limits });
      limited.allowStaff();
      limitedGateway = installGateway(limited.prisma, limited.clock, {
        tenants: [{ id: 'tenant-a', plan: 'pro' }],
        keys: [
          {
            id: 'key-a',
            tenantId: 'tenant-a',
            key: KEY_A,
            allowedOrigins: [ORIGIN_A],
          },
        ],
      });
    };

    afterEach(async () => {
      await limited?.app.close();
    });

    it('limits session starts per visitor, with Retry-After, without hurting other visitors', async () => {
      await build({ sessionPerVisitor: 2 });
      const start = (visitorId: string) =>
        call('/v1/widget/sessions', { widgetKey: KEY_A, visitorId });
      await start(VISITOR_1).expect(200);
      await start(VISITOR_1).expect(200);
      const blocked = await start(VISITOR_1).expect(429);
      expect(blocked.body).toMatchObject({
        statusCode: 429,
        code: 'TOO_MANY_REQUESTS',
      });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      // The allowed origin can read the 429 (it has its CORS header) so the widget can back off.
      expect(blocked.headers['access-control-allow-origin']).toBe(ORIGIN_A);
      await start(VISITOR_2).expect(200);
      void limitedGateway;
    });

    it('limits session starts per widget key', async () => {
      await build({ sessionPerKey: 2 });
      const start = (visitorId: string) =>
        call('/v1/widget/sessions', { widgetKey: KEY_A, visitorId });
      await start(VISITOR_1).expect(200);
      await start(VISITOR_2).expect(200);
      await start('visitor-three-0123456789').expect(429);
    });

    it('limits session starts per IP before it even looks up the key', async () => {
      await build({ sessionPerIp: 2 });
      const start = () =>
        call('/v1/widget/sessions', {
          widgetKey: 'wk_unknown_unknown_unknown_1',
          visitorId: VISITOR_1,
        });
      await start().expect(401);
      await start().expect(401);
      const blocked = await start().expect(429);
      expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('limits messages per visitor, per key and per IP', async () => {
      await build({ messagePerVisitor: 2 });
      const session = (
        await call('/v1/widget/sessions', {
          widgetKey: KEY_A,
          visitorId: VISITOR_1,
        }).expect(200)
      ).body;
      const message = () =>
        call('/v1/widget/messages', { content: 'hello' }, session.token);
      await message().expect(200);
      await message().expect(200);
      const blocked = await message().expect(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      await limited.app.close();

      await build({ messagePerKey: 1 });
      const s2 = (
        await call('/v1/widget/sessions', {
          widgetKey: KEY_A,
          visitorId: VISITOR_1,
        }).expect(200)
      ).body;
      await call('/v1/widget/messages', { content: 'a' }, s2.token).expect(200);
      await call('/v1/widget/messages', { content: 'b' }, s2.token).expect(429);
      await limited.app.close();

      await build({ messagePerIp: 1 });
      const s3 = (
        await call('/v1/widget/sessions', {
          widgetKey: KEY_A,
          visitorId: VISITOR_1,
        }).expect(200)
      ).body;
      await call('/v1/widget/messages', { content: 'a' }, s3.token).expect(200);
      await call('/v1/widget/messages', { content: 'b' }, s3.token).expect(429);
    });

    it('a blocked message does not reach the engine', async () => {
      await build({ messagePerVisitor: 1 });
      const session = (
        await call('/v1/widget/sessions', {
          widgetKey: KEY_A,
          visitorId: VISITOR_1,
        }).expect(200)
      ).body;
      await call('/v1/widget/messages', { content: 'first' }, session.token);
      await call(
        '/v1/widget/messages',
        { content: 'second' },
        session.token,
      ).expect(429);
      const stored = limited.engine.inspect(
        'tenant-a',
        session.conversationId,
      )!;
      expect(
        stored.messages.filter((m) => m.authorType === 'customer'),
      ).toHaveLength(1);
    });

    it('limits history reads per visitor', async () => {
      await build({ readPerVisitor: 1 });
      const session = (
        await call('/v1/widget/sessions', {
          widgetKey: KEY_A,
          visitorId: VISITOR_1,
        }).expect(200)
      ).body;
      const read = () =>
        request(limited.app.getHttpServer())
          .get('/v1/widget/conversation')
          .set('Origin', ORIGIN_A)
          .set('Authorization', `Bearer ${session.token}`);
      await read().expect(200);
      await read().expect(429);
    });
  });

  // =============================================================================================
  describe('the staff-facing routes are untouched by widget tokens and vice versa (sanity)', () => {
    it('GET /health still works without any widget machinery', async () => {
      await http().get('/health').expect(200);
    });
  });
});
