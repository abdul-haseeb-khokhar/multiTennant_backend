import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { EntitlementsService } from '../../src/billing/entitlements/entitlements.service';
import { EngineClient } from '../../src/engine/engine-client';
import { MockEngineClient } from '../../src/engine/mock-engine.client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { UsageService } from '../../src/usage/usage.service';
import { WidgetCorsService } from '../../src/widget/widget-cors.service';
import { WIDGET_LIMITS } from '../../src/widget/widget.constants';

/**
 * Phase 3 against a real Postgres: the migration's tables and constraints, the SQL the mocked
 * suites cannot see (the atomic usage upsert, the ON CONFLICT dedupe ledger, the GIN origin
 * lookup, unique keys under parallel requests) and the widget flow end to end over HTTP with the
 * mock engine. Everything the dashboard does goes through the real API.
 */
describe('Gateway flows (real database, mock engine)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let engine: MockEngineClient;

  const http = () => request(app.getHttpServer());
  const run = randomBytes(4).toString('hex');
  const password = 'correct-horse-battery';
  const bearer = (token: string) => `Bearer ${token}`;
  const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;
  const ORIGIN = `https://shop-${run}.example.com`;
  const OTHER_ORIGIN = `https://other-${run}.example.com`;
  let counter = 0;

  type Tenant = Awaited<ReturnType<typeof signup>>;

  async function signup(name: string) {
    counter += 1;
    const res = await http()
      .post('/v1/auth/signup')
      .send({
        tenantName: `${name} ${run}-${counter}`,
        ownerEmail: `owner.${counter}.${run}@gateway.test`,
        ownerPassword: password,
      })
      .expect(201);
    await http()
      .post('/v1/auth/verify-email')
      .send({ token: tokenFrom(res.body.verificationLink) })
      .expect(204);
    return {
      tenantId: res.body.tenant.id as string,
      token: res.body.access_token as string,
    };
  }

  /** Creates a widget key through the dashboard API, as an owner would. */
  async function widgetKey(tenant: Tenant, origins = [ORIGIN]) {
    const res = await http()
      .post(`/v1/tenants/${tenant.tenantId}/api-keys`)
      .set('Authorization', bearer(tenant.token))
      .send({ name: 'Website', allowedOrigins: origins })
      .expect(201);
    return { id: res.body.id as string, key: res.body.key as string };
  }

  const visitor = (n: number) => `visitor-${run}-${n}`.padEnd(24, '0');

  const session = (key: string, visitorId: string, origin = ORIGIN) =>
    http()
      .post('/v1/widget/sessions')
      .set('Origin', origin)
      .send({ widgetKey: key, visitorId });

  const open = async (key: string, visitorId: string, origin = ORIGIN) =>
    (await session(key, visitorId, origin).expect(200)).body as {
      status: string;
      token: string;
      conversationId: string;
      fallback?: { reason: string };
    };

  const sendMessage = async (
    token: string,
    content: string,
    origin = ORIGIN,
  ) => {
    const res = await http()
      .post('/v1/widget/messages')
      .set('Authorization', bearer(token))
      .set('Origin', origin)
      .buffer(true)
      .parse((r, done) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (chunk: string) => (body += chunk));
        r.on('end', () => done(null, body));
      })
      .send({ content });
    const events = String(res.body)
      .split('\n\n')
      .filter((b) => b.trim())
      .map((b) => /^event: (.*)$/m.exec(b)?.[1]);
    return { res, events };
  };

  const rows = <T>(sql: string, ...params: unknown[]) =>
    prisma.$queryRawUnsafe<T[]>(sql, ...params);

  const usageOf = async (tenantId: string) =>
    (
      await rows<{
        conversations: number;
        messages: number;
        tokens_in: number;
      }>(
        `SELECT COALESCE(SUM(conversations),0)::int AS conversations,
                COALESCE(SUM(messages),0)::int AS messages,
                COALESCE(SUM(tokens_in),0)::int AS tokens_in
           FROM "tenant_core"."usage_daily" WHERE "tenant_id" = $1`,
        tenantId,
      )
    )[0];

  beforeAll(async () => {
    const big = 1_000_000;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WIDGET_LIMITS)
      .useValue({
        windowMs: 60_000,
        sessionPerIp: big,
        sessionPerKey: big,
        sessionPerVisitor: big,
        messagePerIp: big,
        messagePerKey: big,
        messagePerVisitor: big,
        readPerIp: big,
        readPerVisitor: big,
        preflightPerIp: big,
      })
      .compile();
    app = moduleRef.createNestApplication({
      logger: false,
      rawBody: true,
    });
    configureApp(app);
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    engine = app.get(EngineClient) as MockEngineClient;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('migration 20261008100000_phase3_gateway', () => {
    it('created the four tables with their unique keys and indexes', async () => {
      const tables = await rows<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'tenant_core'
            AND table_name IN ('api_keys','usage_daily','usage_events','gateway_conversations')`,
      );
      expect(tables.map((t) => t.table_name).sort()).toEqual([
        'api_keys',
        'gateway_conversations',
        'usage_daily',
        'usage_events',
      ]);
      const indexes = await rows<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'tenant_core'
           AND tablename IN ('api_keys','usage_events','gateway_conversations')`,
      );
      const defs = indexes.map((i) => i.indexdef).join('\n');
      expect(defs).toMatch(/UNIQUE INDEX .*api_keys.*\(key_hash\)/);
      expect(defs).toMatch(/USING gin \(allowed_origins\)/);
      expect(defs).toMatch(
        /UNIQUE INDEX .*usage_events.*\(tenant_id, kind, ref_id\)/,
      );
      expect(defs).toMatch(
        /UNIQUE INDEX .*gateway_conversations.*\(tenant_id, conversation_id\)/,
      );
    });

    it('refuses bad values through CHECK constraints', async () => {
      const t = await signup('Checks');
      const insertKey = (type: string, origins: string[]) =>
        prisma.apiKey.create({
          data: {
            tenantId: t.tenantId,
            type,
            name: 'x',
            keyPrefix: 'wk_x',
            keyHash: randomBytes(16).toString('hex'),
            allowedOrigins: origins,
          },
        });
      await expect(insertKey('admin', [])).rejects.toThrow(
        /api_keys_type_check/,
      );
      await expect(
        insertKey(
          'widget',
          Array.from({ length: 21 }, (_, i) => `https://s${i}.example.com`),
        ),
      ).rejects.toThrow(/api_keys_origins_check/);
      await expect(
        insertKey('widget', ['https://ok.example.com']),
      ).resolves.toBeDefined();

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "tenant_core"."usage_daily" (tenant_id, day, messages) VALUES ($1, CURRENT_DATE, -1)`,
          t.tenantId,
        ),
      ).rejects.toThrow(/usage_daily_counters_check/);
      await expect(
        prisma.usageEvent.create({
          data: {
            tenantId: t.tenantId,
            kind: 'call',
            refId: 'x',
            day: new Date(),
          },
        }),
      ).rejects.toThrow(/usage_events_kind_check/);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "tenant_core"."gateway_conversations" (id, tenant_id, conversation_id, end_customer_id, channel)
           VALUES (gen_random_uuid()::text, $1, 'c1', 'nope', 'sms')`,
          t.tenantId,
        ),
      ).rejects.toThrow();
    });

    it('keeps tenants RESTRICTed while they own keys, and cascades gateway rows with their end customer', async () => {
      const t = await signup('Restrict');
      const { key } = await widgetKey(t);
      await expect(
        prisma.tenant.delete({ where: { id: t.tenantId } }),
      ).rejects.toThrow();

      const opened = await open(key, visitor(1));
      const customer = await prisma.endCustomer.findFirstOrThrow({
        where: { tenantId: t.tenantId },
      });
      expect(
        await prisma.gatewayConversation.count({
          where: { tenantId: t.tenantId },
        }),
      ).toBe(1);
      await prisma.endCustomer.delete({ where: { id: customer.id } });
      expect(
        await prisma.gatewayConversation.count({
          where: { tenantId: t.tenantId },
        }),
      ).toBe(0);
      void opened;
    });
  });

  describe('API keys through the dashboard API', () => {
    it('stores only the hash, audits create/update/revoke without the key, and hides everything from other tenants', async () => {
      const a = await signup('KeysA');
      const b = await signup('KeysB');
      const created = await http()
        .post(`/v1/tenants/${a.tenantId}/api-keys`)
        .set('Authorization', bearer(a.token))
        .send({ name: 'Site', allowedOrigins: [ORIGIN] })
        .expect(201);
      const stored = await prisma.apiKey.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(created.body.key);

      await http()
        .patch(`/v1/tenants/${a.tenantId}/api-keys/${created.body.id}`)
        .set('Authorization', bearer(a.token))
        .send({ allowedOrigins: [ORIGIN, OTHER_ORIGIN] })
        .expect(200);
      await http()
        .delete(`/v1/tenants/${a.tenantId}/api-keys/${created.body.id}`)
        .set('Authorization', bearer(a.token))
        .expect(200);

      const audit = await rows<{
        action: string;
        before: unknown;
        after: unknown;
      }>(
        `SELECT action, before, after FROM "tenant_core"."audit_logs"
          WHERE "tenant_id" = $1 AND action LIKE 'apikey.%' ORDER BY created_at, id`,
        a.tenantId,
      );
      expect(audit.map((r) => r.action)).toEqual([
        'apikey.created',
        'apikey.updated',
        'apikey.revoked',
      ]);
      expect(JSON.stringify(audit)).not.toContain(created.body.key);

      // Tenant B sees none of it, on either URL.
      await http()
        .get(`/v1/tenants/${a.tenantId}/api-keys`)
        .set('Authorization', bearer(b.token))
        .expect(403);
      const own = await http()
        .get(`/v1/tenants/${b.tenantId}/api-keys?includeRevoked=true`)
        .set('Authorization', bearer(b.token))
        .expect(200);
      expect(own.body.total).toBe(0);
    });
  });

  describe('widget session and chat, end to end', () => {
    it('session -> streamed reply -> history -> forced escalation, with usage in usage_daily', async () => {
      const t = await signup('Flow');
      const { key } = await widgetKey(t);
      const opened = await open(key, visitor(1));
      expect(opened.status).toBe('ready');

      const customer = await prisma.endCustomer.findFirstOrThrow({
        where: { tenantId: t.tenantId },
      });
      expect(customer.externalId).toBe(`web_${visitor(1)}`);

      const reply = await sendMessage(
        opened.token,
        'What are your opening hours?',
      );
      expect(reply.res.status).toBe(200);
      expect(reply.events[0]).toBe('accepted');
      expect(reply.events.at(-1)).toBe('done');

      const history = await http()
        .get('/v1/widget/conversation')
        .set('Authorization', bearer(opened.token))
        .set('Origin', ORIGIN)
        .expect(200);
      expect(
        history.body.data.map((m: { authorType: string }) => m.authorType),
      ).toEqual(['customer', 'ai']);

      const escalated = await sendMessage(opened.token, '/escalate');
      expect(escalated.events).toContain('escalated');

      const usage = await usageOf(t.tenantId);
      expect(usage.conversations).toBe(1);
      expect(usage.messages).toBe(4); // two customer messages, two AI replies
      expect(usage.tokens_in).toBeGreaterThan(0);
    });

    it('the real SQL: parallel session starts of one new visitor make one customer, one conversation, one count (many rounds)', async () => {
      const t = await signup('Parallel');
      const { key } = await widgetKey(t);
      const rounds = 10;
      for (let round = 0; round < rounds; round++) {
        const results = await Promise.all(
          Array.from({ length: 8 }, () => session(key, visitor(700 + round))),
        );
        for (const res of results) expect(res.status).toBe(200);
        expect(new Set(results.map((r) => r.body.conversationId)).size).toBe(1);
      }
      expect(
        await prisma.endCustomer.count({ where: { tenantId: t.tenantId } }),
      ).toBe(rounds);
      expect(
        await prisma.gatewayConversation.count({
          where: { tenantId: t.tenantId },
        }),
      ).toBe(rounds);
      expect((await usageOf(t.tenantId)).conversations).toBe(rounds);
      expect(engine.conversationCount(t.tenantId)).toBe(rounds);
    });

    it('the real SQL: many visitors starting at once add up exactly in usage_daily (atomic upsert)', async () => {
      const t = await signup('Counting');
      await prisma.subscription.update({
        where: { tenantId: t.tenantId },
        data: { planCode: 'enterprise', currentPeriodEnd: null },
      });
      app.get(EntitlementsService).invalidate(t.tenantId);
      const { key } = await widgetKey(t);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => session(key, visitor(100 + i))),
      );
      for (const res of results) expect(res.status).toBe(200);
      expect((await usageOf(t.tenantId)).conversations).toBe(12);
      const days = await rows<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "tenant_core"."usage_daily" WHERE "tenant_id" = $1`,
        t.tenantId,
      );
      expect(days[0].n).toBe(1);
    });

    it('UsageService counts one message id once, even when reported in parallel', async () => {
      const t = await signup('Dedupe');
      const usage = app.get(UsageService);
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          usage.recordMessage(t.tenantId, {
            messageId: 'msg-dedupe-1',
            tokensIn: 10,
            tokensOut: 5,
          }),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const counted = await usageOf(t.tenantId);
      expect(counted).toMatchObject({ messages: 1, tokens_in: 10 });
      // Another tenant may use the same message id.
      const other = await signup('Dedupe2');
      expect(
        await usage.recordMessage(other.tenantId, {
          messageId: 'msg-dedupe-1',
        }),
      ).toBe(true);
    });
  });

  describe('conversationsPerPeriod from real usage (I5)', () => {
    it('allows exactly the limit, then answers "limited" and sends the messages to a human', async () => {
      const t = await signup('Limit');
      await prisma.subscription.update({
        where: { tenantId: t.tenantId },
        data: { entitlementsOverride: { conversationsPerPeriod: 2 } },
      });
      app.get(EntitlementsService).invalidate(t.tenantId);
      const { key } = await widgetKey(t);

      expect((await open(key, visitor(21))).status).toBe('ready');
      expect((await open(key, visitor(22))).status).toBe('ready');
      const third = await open(key, visitor(23));
      expect(third).toMatchObject({
        status: 'limited',
        fallback: { reason: 'limit_reached' },
      });
      // Counted, although not answered by the AI.
      expect((await usageOf(t.tenantId)).conversations).toBe(3);

      const spy = jest.spyOn(engine, 'sendMessage');
      const { events } = await sendMessage(third.token, 'Please help me');
      expect(events).toEqual(['accepted', 'fallback']);
      expect(spy.mock.calls[0][2]).toMatchObject({ aiReply: false });
      spy.mockRestore();
      const stored = engine.inspect(t.tenantId, third.conversationId)!;
      expect(stored.conversation).toMatchObject({
        status: 'escalated',
        escalationReason: 'limit_reached',
      });
      expect(stored.messages.map((m) => m.authorType)).toEqual(['customer']);

      // A returning visitor of an answered conversation is not stopped by the limit.
      expect((await open(key, visitor(21))).status).toBe('ready');
      expect((await usageOf(t.tenantId)).conversations).toBe(3);
    });
  });

  describe('blocked states with the real subscription', () => {
    it('a platform-suspended tenant gets the blocked state, a lifted suspension chats again', async () => {
      const t = await signup('Suspend');
      const { key } = await widgetKey(t);
      await open(key, visitor(31));

      const adminEmail = `ops.${run}@gateway.test`;
      await prisma.platformAdmin.create({
        data: {
          email: adminEmail,
          passwordHash: await hash('ops-password-123'),
        },
      });
      const login = await http()
        .post('/v1/admin/auth/login')
        .send({ email: adminEmail, password: 'ops-password-123' })
        .expect(201);
      const admin = bearer(login.body.access_token);

      await http()
        .patch(`/v1/admin/tenants/${t.tenantId}`)
        .set('Authorization', admin)
        .send({ status: 'suspended' })
        .expect(200);
      const blocked = await session(key, visitor(31)).expect(200);
      expect(blocked.body).toMatchObject({
        status: 'blocked',
        fallback: { reason: 'service_unavailable' },
      });
      expect(blocked.body.token).toBeUndefined();

      await http()
        .patch(`/v1/admin/tenants/${t.tenantId}`)
        .set('Authorization', admin)
        .send({ status: 'active' })
        .expect(200);
      expect((await session(key, visitor(31)).expect(200)).body.status).toBe(
        'ready',
      );
    });
  });

  describe('CORS origin lookup (GIN-indexed array search)', () => {
    it('allows a preflight for an origin some active key lists, and stops when the key is revoked', async () => {
      const t = await signup('Cors');
      const origin = `https://cors-${run}.example.com`;
      const { id } = await widgetKey(t, [origin]);
      const preflight = (o: string) =>
        http()
          .options('/v1/widget/sessions')
          .set('Origin', o)
          .set('Access-Control-Request-Method', 'POST');

      app.get(WidgetCorsService).clearCache();
      expect(
        (await preflight(origin)).headers['access-control-allow-origin'],
      ).toBe(origin);
      expect(
        (await preflight('https://nobody.example.com')).headers[
          'access-control-allow-origin'
        ],
      ).toBeUndefined();

      await http()
        .delete(`/v1/tenants/${t.tenantId}/api-keys/${id}`)
        .set('Authorization', bearer(t.token))
        .expect(200);
      app.get(WidgetCorsService).clearCache();
      expect(
        (await preflight(origin)).headers['access-control-allow-origin'],
      ).toBeUndefined();
    });
  });

  describe('tenant isolation: two tenants, two visitors, real rows', () => {
    it('each visitor reaches only their own conversation; the same visitor id in two tenants is two customers', async () => {
      const a = await signup('IsoA');
      const b = await signup('IsoB');
      const keyA = await widgetKey(a);
      const keyB = await widgetKey(b);

      const a1 = await open(keyA.key, visitor(41));
      const a2 = await open(keyA.key, visitor(42));
      const b1 = await open(keyB.key, visitor(41)); // same visitor id, other tenant
      await sendMessage(a1.token, 'ALPHA-ONE secret');
      await sendMessage(b1.token, 'BETA-ONE secret');

      const read = async (token: string) =>
        JSON.stringify(
          (
            await http()
              .get('/v1/widget/conversation')
              .set('Authorization', bearer(token))
              .set('Origin', ORIGIN)
              .expect(200)
          ).body,
        );
      expect(await read(a1.token)).toContain('ALPHA-ONE');
      expect(await read(a1.token)).not.toContain('BETA-ONE');
      expect(await read(b1.token)).toContain('BETA-ONE');
      expect(await read(b1.token)).not.toContain('ALPHA-ONE');
      expect(await read(a2.token)).not.toMatch(/ALPHA-ONE|BETA-ONE/);

      const customers = await rows<{ tenant_id: string }>(
        `SELECT tenant_id FROM "tenant_core"."end_customers" WHERE external_id = $1`,
        `web_${visitor(41)}`,
      );
      expect(customers.map((c) => c.tenant_id).sort()).toEqual(
        [a.tenantId, b.tenantId].sort(),
      );
      expect(engine.inspect(b.tenantId, a1.conversationId)).toBeNull();
    });

    it('widget, staff and platform tokens are not interchangeable on the real stack', async () => {
      const t = await signup('Tokens');
      const { key } = await widgetKey(t);
      const opened = await open(key, visitor(51));
      await http()
        .get('/v1/me')
        .set('Authorization', bearer(opened.token))
        .expect(401);
      await http()
        .get(`/v1/tenants/${t.tenantId}/api-keys`)
        .set('Authorization', bearer(opened.token))
        .expect(401);
      await http()
        .get('/v1/widget/conversation')
        .set('Authorization', bearer(t.token))
        .set('Origin', ORIGIN)
        .expect(401);
    });
  });
});

async function hash(password: string) {
  const bcrypt = await import('bcrypt');
  return bcrypt.hash(password, 4);
}
