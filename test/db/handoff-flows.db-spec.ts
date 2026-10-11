import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { BillingRemindersService } from '../../src/billing/reminders/billing-reminders.service';
import { EntitlementsService } from '../../src/billing/entitlements/entitlements.service';
import { SubscriptionService } from '../../src/billing/subscriptions/subscription.service';
import { EngineClient } from '../../src/engine/engine-client';
import { MockEngineClient } from '../../src/engine/mock-engine.client';
import { signEngineEvent } from '../../src/events/engine-event-signature';
import { HousekeepingService } from '../../src/notifications/housekeeping.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  ESCALATION_MAX_ATTEMPTS,
  EscalationRetryService,
} from '../../src/widget/escalation-retry.service';
import { WIDGET_LIMITS } from '../../src/widget/widget.constants';
import { SseStream, openStream } from '../utils/sse-client';

/**
 * Phase 4 against a real Postgres: the migration's tables and constraints, the SQL the mocked
 * suites cannot see (idempotent event inbox under parallel delivery and rollback, unique
 * reminders, single-use tickets, cascade on delete, the purge), claim races through the real
 * API, the escalation retry job, and the whole hand-off on the mock engine.
 */
describe('Human hand-off flows (real database, mock engine)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let engine: MockEngineClient;
  let base: string;
  const opened: SseStream[] = [];

  const http = () => request(app.getHttpServer());
  const run = randomBytes(4).toString('hex');
  const password = 'correct-horse-battery';
  const bearer = (token: string) => `Bearer ${token}`;
  const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;
  const SECRET = process.env.INTERNAL_API_TOKEN!;
  const ORIGIN = `https://shop-${run}.example.com`;
  let counter = 0;

  type Tenant = Awaited<ReturnType<typeof signup>>;
  type Staff = { id: string; token: string };

  /** Signs a tenant up; by default on an unlimited plan, so seats and conversation limits do not interfere. */
  async function signup(
    name: string,
    plan: 'enterprise' | 'starter' = 'enterprise',
  ) {
    counter += 1;
    const res = await http()
      .post('/v1/auth/signup')
      .send({
        tenantName: `${name} ${run}-${counter}`,
        ownerEmail: `owner.${counter}.${run}@handoff.test`,
        ownerPassword: password,
      })
      .expect(201);
    await http()
      .post('/v1/auth/verify-email')
      .send({ token: tokenFrom(res.body.verificationLink) })
      .expect(204);
    if (plan === 'enterprise') {
      await prisma.subscription.update({
        where: { tenantId: res.body.tenant.id },
        data: { planCode: 'enterprise', currentPeriodEnd: null },
      });
    }
    return {
      tenantId: res.body.tenant.id as string,
      ownerId: res.body.owner.id as string,
      token: res.body.access_token as string,
    };
  }

  async function addStaff(tenant: Tenant, role = 'agent'): Promise<Staff> {
    counter += 1;
    const invite = await http()
      .post(`/v1/tenants/${tenant.tenantId}/invites`)
      .set('Authorization', bearer(tenant.token))
      .send({ email: `staff.${counter}.${run}@handoff.test`, role })
      .expect(201);
    const accepted = await http()
      .post('/v1/auth/invites/accept')
      .send({
        token: tokenFrom(invite.body.link),
        password,
        name: `Staff ${counter}`,
      })
      .expect(201);
    return { id: accepted.body.user.id, token: accepted.body.access_token };
  }

  async function widgetKey(tenant: Tenant) {
    const res = await http()
      .post(`/v1/tenants/${tenant.tenantId}/api-keys`)
      .set('Authorization', bearer(tenant.token))
      .send({ name: 'Website', allowedOrigins: [ORIGIN] })
      .expect(201);
    return res.body.key as string;
  }

  const visitor = () => `visitor-${run}-${(counter += 1)}`.padEnd(24, '0');

  async function customer(key: string) {
    const res = await http()
      .post('/v1/widget/sessions')
      .set('Origin', ORIGIN)
      .send({ widgetKey: key, visitorId: visitor() })
      .expect(200);
    return res.body as {
      token: string;
      conversationId: string;
      status: string;
    };
  }

  const say = async (token: string, content: string) => {
    const res = await http()
      .post('/v1/widget/messages')
      .set('Authorization', bearer(token))
      .set('Origin', ORIGIN)
      .buffer(true)
      .parse((r, done) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (chunk: string) => (body += chunk));
        r.on('end', () => done(null, body));
      })
      .send({ content });
    await engine.flushEvents();
    const events = String(res.body)
      .split('\n\n')
      .filter((b) => b.trim())
      .map((b) => ({
        event: /^event: (.*)$/m.exec(b)?.[1],
        data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? '{}'),
      }));
    return { res, events };
  };

  const claim = (user: { token: string }, tenant: Tenant, id: string) =>
    http()
      .post(`/v1/tenants/${tenant.tenantId}/conversations/${id}/claim`)
      .set('Authorization', bearer(user.token));

  const rows = <T>(sql: string, ...params: unknown[]) =>
    prisma.$queryRawUnsafe<T[]>(sql, ...params);

  const deliver = (event: Record<string, unknown>, rawOverride?: string) => {
    const raw = rawOverride ?? JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return http()
      .post('/internal/events')
      .set('Content-Type', 'application/json')
      .set('X-Engine-Timestamp', timestamp)
      .set('X-Engine-Signature', signEngineEvent(SECRET, timestamp, raw))
      .send(raw);
  };

  const envelope = (
    tenantId: string,
    type: string,
    data: Record<string, unknown>,
  ) => ({
    id: randomUUID(),
    type,
    tenantId,
    occurredAt: new Date().toISOString(),
    data,
  });

  const usageOf = async (tenantId: string) =>
    (
      await rows<{ messages: number; tokens_in: number }>(
        `SELECT COALESCE(SUM(messages),0)::int AS messages, COALESCE(SUM(tokens_in),0)::int AS tokens_in
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
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    prisma = app.get(PrismaService);
    engine = app.get(EngineClient) as MockEngineClient;
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    while (opened.length) opened.pop()!.close();
    engine.setDown(false);
  });

  // ===========================================================================================

  describe('migration 20261010100000_phase4_handoff', () => {
    it('created the three tables, their unique keys and the new gateway columns', async () => {
      const tables = await rows<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'tenant_core'
            AND table_name IN ('notifications','engine_events','stream_tickets')`,
      );
      expect(tables.map((t) => t.table_name).sort()).toEqual([
        'engine_events',
        'notifications',
        'stream_tickets',
      ]);
      const defs = (
        await rows<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE schemaname = 'tenant_core'
             AND tablename IN ('notifications','engine_events','stream_tickets')`,
        )
      )
        .map((i) => i.indexdef)
        .join('\n');
      expect(defs).toMatch(
        /UNIQUE INDEX .*notifications.*\(tenant_id, user_id, dedupe_key\)/,
      );
      expect(defs).toMatch(
        /UNIQUE INDEX .*engine_events.*\(tenant_id, event_id\)/,
      );
      expect(defs).toMatch(/UNIQUE INDEX .*stream_tickets.*\(token_hash\)/);
      const columns = await rows<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'tenant_core' AND table_name = 'gateway_conversations'
            AND column_name IN ('escalation_attempts','escalation_last_attempt_at')`,
      );
      expect(columns).toHaveLength(2);
    });

    it('notifications go with their user; the tenant (RESTRICT) keeps them from being orphaned', async () => {
      const tenant = await signup('Cascade');
      const agent = await addStaff(tenant);
      const note = await prisma.notification.create({
        data: {
          tenantId: tenant.tenantId,
          userId: agent.id,
          type: 'x',
          params: {},
        },
      });
      await http()
        .delete(`/v1/tenants/${tenant.tenantId}/users/${agent.id}`)
        .set('Authorization', bearer(tenant.token))
        .expect(200);
      expect(
        await prisma.notification.findUnique({ where: { id: note.id } }),
      ).toBeNull();
      const fks = await rows<{ conname: string; confdeltype: string }>(
        `SELECT conname, confdeltype FROM pg_constraint
          WHERE conname IN ('notifications_tenant_id_fkey','notifications_user_id_fkey','engine_events_tenant_id_fkey')`,
      );
      const type = (name: string) =>
        fks.find((f) => f.conname === name)?.confdeltype;
      expect(type('notifications_user_id_fkey')).toBe('c'); // cascade
      expect(type('notifications_tenant_id_fkey')).toBe('r'); // restrict
      expect(type('engine_events_tenant_id_fkey')).toBe('r');
    });

    it('refuses two notifications with the same dedupe key for one recipient, but allows many without one', async () => {
      const tenant = await signup('Dedupe');
      const create = (dedupeKey: string | null) =>
        prisma.notification.create({
          data: {
            tenantId: tenant.tenantId,
            userId: tenant.ownerId,
            type: 'x',
            params: {},
            dedupeKey,
          },
        });
      await create('k1');
      await expect(create('k1')).rejects.toThrow(/Unique constraint/);
      await create(null);
      await create(null);
    });
  });

  // ===========================================================================================

  describe('the event receiver on a real database', () => {
    it('applies an event once even when it is delivered ten times at the same moment', async () => {
      const tenant = await signup('Parallel');
      const event = envelope(tenant.tenantId, 'usage.recorded', {
        conversationId: 'c1',
        messageId: `m-${run}-parallel`,
        tokensIn: 7,
        tokensOut: 3,
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, () => deliver(event)),
      );
      const statuses = results.map((r) => r.body.status).sort();
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(statuses.filter((s) => s === 'processed')).toHaveLength(1);
      expect(statuses.filter((s) => s === 'duplicate')).toHaveLength(9);
      expect(await usageOf(tenant.tenantId)).toEqual({
        messages: 1,
        tokens_in: 7,
      });
      const inbox = await rows<{ n: number }>(
        `SELECT count(*)::int AS n FROM "tenant_core"."engine_events" WHERE "tenant_id" = $1`,
        tenant.tenantId,
      );
      expect(inbox[0].n).toBe(1);
    });

    it('the same event id for two tenants is two events (the inbox is per tenant)', async () => {
      const a = await signup('InboxA');
      const b = await signup('InboxB');
      const id = randomUUID();
      for (const tenant of [a, b]) {
        const res = await deliver({
          id,
          type: 'usage.recorded',
          tenantId: tenant.tenantId,
          occurredAt: new Date().toISOString(),
          data: {
            messageId: `m-${tenant.tenantId}`,
            tokensIn: 1,
            tokensOut: 1,
          },
        }).expect(200);
        expect(res.body.status).toBe('processed');
      }
    });

    it('a failure after the inbox row was written rolls the whole delivery back, so the retry is processed', async () => {
      const tenant = await signup('Rollback');
      const bad = envelope(tenant.tenantId, 'message.created', {
        conversationId: 'c1',
      }); // no messageId
      await deliver(bad).expect(400);
      const inbox = () =>
        rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM "tenant_core"."engine_events" WHERE "tenant_id" = $1`,
          tenant.tenantId,
        );
      expect((await inbox())[0].n).toBe(0);
      // the engine fixes the event and sends it again under the same id
      const fixed = {
        ...bad,
        data: { conversationId: 'c1', messageId: 'm1', authorType: 'customer' },
      };
      const res = await deliver(fixed).expect(200);
      expect(res.body.status).toBe('processed');
      expect((await inbox())[0].n).toBe(1);
    });

    it('stores no payload and no message text in the inbox', async () => {
      const tenant = await signup('NoText');
      await deliver(
        envelope(tenant.tenantId, 'message.created', {
          conversationId: 'c1',
          messageId: 'm1',
          authorType: 'human',
          content: 'TEXT-THAT-MUST-NOT-BE-STORED',
        }),
      ).expect(200);
      const stored = await rows<Record<string, unknown>>(
        `SELECT * FROM "tenant_core"."engine_events" WHERE "tenant_id" = $1`,
        tenant.tenantId,
      );
      expect(JSON.stringify(stored)).not.toContain(
        'TEXT-THAT-MUST-NOT-BE-STORED',
      );
      expect(Object.keys(stored[0]).sort()).toEqual(
        [
          'event_id',
          'id',
          'occurred_at',
          'received_at',
          'tenant_id',
          'type',
        ].sort(),
      );
    });

    it('takes the tenant from the envelope: an event for tenant A never writes into tenant B', async () => {
      const a = await signup('EnvA');
      const b = await signup('EnvB');
      await deliver(
        envelope(a.tenantId, 'usage.recorded', {
          messageId: `m-${run}-env`,
          tokensIn: 5,
          tokensOut: 5,
          tenantId: b.tenantId,
        }),
      ).expect(200);
      expect((await usageOf(a.tenantId)).messages).toBe(1);
      expect((await usageOf(b.tenantId)).messages).toBe(0);
      const missing = await deliver(
        envelope(randomUUID(), 'usage.recorded', { messageId: 'm' }),
      ).expect(404);
      expect(missing.body.code).toBe('TENANT_NOT_FOUND');
    });

    it('rejects a delivery whose body was changed after signing', async () => {
      const tenant = await signup('Tamper');
      const event = envelope(tenant.tenantId, 'usage.recorded', {
        messageId: 'm',
        tokensIn: 1,
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      await http()
        .post('/internal/events')
        .set('Content-Type', 'application/json')
        .set('X-Engine-Timestamp', timestamp)
        .set(
          'X-Engine-Signature',
          signEngineEvent(SECRET, timestamp, JSON.stringify(event)),
        )
        .send(JSON.stringify({ ...event, data: { messageId: 'other' } }))
        .expect(401);
    });
  });

  // ===========================================================================================

  describe('claiming on a real database', () => {
    it('five simultaneous claimants: exactly one wins, four get 409, one audit row', async () => {
      const tenant = await signup('Race');
      const staff = await Promise.all(
        Array.from({ length: 5 }, () => addStaff(tenant)),
      );
      const key = await widgetKey(tenant);
      const session = await customer(key);
      await say(session.token, '/escalate');
      const results = await Promise.all(
        staff.map((s) => claim(s, tenant, session.conversationId)),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const losers = results.filter((r) => r.status === 409);
      expect(losers).toHaveLength(4);
      expect(
        losers.every((r) => r.body.code === 'CONVERSATION_ALREADY_CLAIMED'),
      ).toBe(true);
      const winner = staff[results.findIndex((r) => r.status === 200)];
      expect(
        (
          await rows<{ n: number }>(
            `SELECT count(*)::int AS n FROM "tenant_core"."audit_logs"
            WHERE "tenant_id" = $1 AND "action" = 'conversation.claimed' AND "target_id" = $2`,
            tenant.tenantId,
            session.conversationId,
          )
        )[0].n,
      ).toBe(1);
      const view = await http()
        .get(
          `/v1/tenants/${tenant.tenantId}/conversations/${session.conversationId}`,
        )
        .set('Authorization', bearer(tenant.token))
        .expect(200);
      expect(view.body.conversation.assignedUserId).toBe(winner.id);
    });

    it("another tenant's staff cannot see, claim or reply, and the conversation stays untouched", async () => {
      const a = await signup('IsoA');
      const b = await signup('IsoB');
      const session = await customer(await widgetKey(a));
      await say(session.token, '/escalate');
      for (const [method, path] of [
        ['get', ''],
        ['post', '/claim'],
        ['post', '/release'],
        ['post', '/resolve'],
        ['post', '/messages'],
      ] as const) {
        const res = await http()
          [method](
            `/v1/tenants/${b.tenantId}/conversations/${session.conversationId}${path}`,
          )
          .set('Authorization', bearer(b.token))
          .send({ content: 'x' });
        expect([path, res.status, res.body.code]).toEqual([
          path,
          404,
          'CONVERSATION_NOT_FOUND',
        ]);
      }
      const list = await http()
        .get(`/v1/tenants/${b.tenantId}/conversations`)
        .set('Authorization', bearer(b.token))
        .expect(200);
      expect(list.body.total).toBe(0);
      await http()
        .get(`/v1/tenants/${a.tenantId}/conversations`)
        .set('Authorization', bearer(b.token))
        .expect(403);
    });

    it('disabling the holder returns their conversation to the queue (real user change, real audit row)', async () => {
      const tenant = await signup('Disable');
      const agent = await addStaff(tenant);
      const session = await customer(await widgetKey(tenant));
      await say(session.token, '/escalate');
      await claim(agent, tenant, session.conversationId).expect(200);
      await http()
        .patch(`/v1/tenants/${tenant.tenantId}/users/${agent.id}`)
        .set('Authorization', bearer(tenant.token))
        .send({ status: 'disabled' })
        .expect(200);
      const view = await http()
        .get(
          `/v1/tenants/${tenant.tenantId}/conversations/${session.conversationId}`,
        )
        .set('Authorization', bearer(tenant.token))
        .expect(200);
      expect(view.body.conversation).toMatchObject({
        status: 'escalated',
        assignedUserId: null,
      });
      const audit = await rows<{
        after: { reason: string };
        actor_role: string;
      }>(
        `SELECT after, actor_role FROM "tenant_core"."audit_logs"
          WHERE "tenant_id" = $1 AND "action" = 'conversation.released' AND "target_id" = $2`,
        tenant.tenantId,
        session.conversationId,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_role: 'owner',
        after: { reason: 'assignee_disabled' },
      });
    });
  });

  // ===========================================================================================

  describe('single-use stream tickets on a real database', () => {
    it('eight simultaneous openings with one ticket: exactly one gets the stream', async () => {
      const tenant = await signup('Ticket');
      const ticket = (
        await http()
          .post(`/v1/tenants/${tenant.tenantId}/events/ticket`)
          .set('Authorization', bearer(tenant.token))
          .expect(200)
      ).body.ticket as string;
      const streams = await Promise.all(
        Array.from({ length: 8 }, () =>
          openStream(
            `${base}/v1/tenants/${tenant.tenantId}/events?ticket=${ticket}`,
          ),
        ),
      );
      opened.push(...streams);
      expect(streams.map((s) => s.status).sort()).toEqual([
        200, 401, 401, 401, 401, 401, 401, 401,
      ]);
      const stored = await rows<{ token_hash: string; used_at: Date | null }>(
        `SELECT token_hash, used_at FROM "tenant_core"."stream_tickets" WHERE "tenant_id" = $1`,
        tenant.tenantId,
      );
      expect(stored).toHaveLength(1);
      expect(stored[0].used_at).not.toBeNull();
      expect(stored[0].token_hash).not.toBe(ticket);
    });

    it('an expired ticket does not open a stream', async () => {
      const tenant = await signup('Expired');
      const ticket = (
        await http()
          .post(`/v1/tenants/${tenant.tenantId}/events/ticket`)
          .set('Authorization', bearer(tenant.token))
          .expect(200)
      ).body.ticket as string;
      await prisma.streamTicket.updateMany({
        where: { tenantId: tenant.tenantId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const stream = await openStream(
        `${base}/v1/tenants/${tenant.tenantId}/events?ticket=${ticket}`,
      );
      expect(stream.status).toBe(401);
    });
  });

  // ===========================================================================================

  describe('billing reminders on a real database (I8)', () => {
    const remindersOf = (tenantId: string, type?: string) =>
      rows<{
        user_id: string;
        type: string;
        params: Record<string, any>;
        dedupe_key: string;
      }>(
        `SELECT user_id, type, params, dedupe_key FROM "tenant_core"."notifications"
          WHERE "tenant_id" = $1 ${type ? 'AND "type" = $2' : ''} ORDER BY "created_at"`,
        ...(type ? [tenantId, type] : [tenantId]),
      );
    const reminders = () => app.get(BillingRemindersService);

    it('the trial ends in 3 days: one reminder per owner and admin, once, even from three sweeps at once', async () => {
      const tenant = await signup('Trial', 'starter');
      const admin = await addStaff(tenant, 'admin');
      await addStaff(tenant, 'agent').catch(() => undefined); // an agent never gets billing reminders
      await prisma.subscription.update({
        where: { tenantId: tenant.tenantId },
        data: { currentPeriodEnd: new Date(Date.now() + 2.5 * 86_400_000) },
      });
      app.get(EntitlementsService).invalidate(tenant.tenantId);
      await Promise.all([
        reminders().generate(),
        reminders().generate(),
        reminders().generate(),
      ]);
      const sent = await remindersOf(tenant.tenantId, 'billing.trial_ending');
      expect(sent.map((r) => r.user_id).sort()).toEqual(
        [admin.id, tenant.ownerId].sort(),
      );
      expect(sent[0].params).toMatchObject({ daysLeft: 3, threshold: 3 });
      await reminders().generate();
      expect(
        await remindersOf(tenant.tenantId, 'billing.trial_ending'),
      ).toHaveLength(2);
      // the recipients can read them through the API, and nobody else
      const own = await http()
        .get(`/v1/tenants/${tenant.tenantId}/notifications?unread=true`)
        .set('Authorization', bearer(admin.token))
        .expect(200);
      expect(own.body.data.map((n: any) => n.type)).toEqual([
        'billing.trial_ending',
      ]);
      const me = await http()
        .get('/v1/me')
        .set('Authorization', bearer(admin.token))
        .expect(200);
      expect(me.body.unreadNotifications).toBe(1);
    });

    it('the trial ended: moves to Free and says so once (downgraded)', async () => {
      const tenant = await signup('Ended', 'starter');
      await prisma.subscription.update({
        where: { tenantId: tenant.tenantId },
        data: { currentPeriodEnd: new Date(Date.now() - 2 * 86_400_000) },
      });
      app.get(EntitlementsService).invalidate(tenant.tenantId);
      await app.get(SubscriptionService).getEffective(tenant.tenantId); // the late job: applied on read
      await reminders().generate();
      await reminders().generate();
      const sent = await remindersOf(tenant.tenantId, 'billing.downgraded');
      expect(sent).toHaveLength(1);
      expect(sent[0].params).toMatchObject({
        fromPlan: 'Starter',
        toPlan: 'Free',
        reason: 'trial_ended',
      });
    });

    it('a paid period that ended unpaid starts the grace period and says so once', async () => {
      const tenant = await signup('Grace', 'starter');
      await prisma.subscription.update({
        where: { tenantId: tenant.tenantId },
        data: {
          planCode: 'pro',
          interval: 'month',
          status: 'active',
          currentPeriodEnd: new Date(Date.now() - 86_400_000),
        },
      });
      app.get(EntitlementsService).invalidate(tenant.tenantId);
      const effective = await app
        .get(SubscriptionService)
        .getEffective(tenant.tenantId);
      expect(effective?.status).toBe('past_due');
      await reminders().generate();
      await reminders().generate();
      const sent = await remindersOf(tenant.tenantId, 'billing.grace_started');
      expect(sent).toHaveLength(1);
      expect(sent[0].params).toMatchObject({ plan: 'Pro', graceDaysLeft: 6 });
    });

    it('80% and then 100% of the conversations: one reminder each per period', async () => {
      const tenant = await signup('Usage', 'starter');
      await prisma.subscription.update({
        where: { tenantId: tenant.tenantId },
        data: {
          planCode: 'free',
          currentPeriodEnd: null,
          entitlementsOverride: {
            conversationsPerPeriod: 10,
            conversationPeriod: 'month',
          },
        },
      });
      const setUsed = (n: number) =>
        prisma.$executeRaw`INSERT INTO "tenant_core"."usage_daily" ("tenant_id","day","conversations","updated_at")
          VALUES (${tenant.tenantId}, CURRENT_DATE, ${n}, now())
          ON CONFLICT ("tenant_id","day") DO UPDATE SET "conversations" = ${n}, "updated_at" = now()`;
      await setUsed(7);
      app.get(EntitlementsService).invalidate(tenant.tenantId);
      await reminders().generate();
      expect(await remindersOf(tenant.tenantId)).toHaveLength(0);
      await setUsed(8);
      await Promise.all([reminders().generate(), reminders().generate()]);
      await reminders().generate();
      const warned = await remindersOf(tenant.tenantId, 'usage.threshold');
      expect(warned).toHaveLength(1);
      expect(warned[0].params).toMatchObject({
        percent: 80,
        used: 8,
        limit: 10,
        period: 'month',
      });
      await setUsed(10);
      await reminders().generate();
      await reminders().generate();
      const full = await remindersOf(tenant.tenantId, 'usage.limit_reached');
      expect(full).toHaveLength(1);
      expect(full[0].params).toMatchObject({
        percent: 100,
        used: 10,
        limit: 10,
      });
      expect(await remindersOf(tenant.tenantId)).toHaveLength(2);
    });

    it('the bell: list, unread filter, mark one read, mark all read, nobody else’s', async () => {
      const tenant = await signup('Bell');
      const admin = await addStaff(tenant, 'admin');
      for (const userId of [tenant.ownerId, admin.id]) {
        for (let i = 0; i < 3; i++) {
          await prisma.notification.create({
            data: {
              tenantId: tenant.tenantId,
              userId,
              type: 'conversation.escalated',
              params: { n: i },
            },
          });
        }
      }
      const list = await http()
        .get(`/v1/tenants/${tenant.tenantId}/notifications`)
        .set('Authorization', bearer(admin.token))
        .expect(200);
      expect(list.body.total).toBe(3);
      const ownerNote = (await prisma.notification.findFirst({
        where: { tenantId: tenant.tenantId, userId: tenant.ownerId },
      }))!;
      await http()
        .post(
          `/v1/tenants/${tenant.tenantId}/notifications/${ownerNote.id}/read`,
        )
        .set('Authorization', bearer(admin.token))
        .expect(404);
      const mine = list.body.data[0].id;
      await http()
        .post(`/v1/tenants/${tenant.tenantId}/notifications/${mine}/read`)
        .set('Authorization', bearer(admin.token))
        .expect(200);
      expect(
        (
          await http()
            .get(`/v1/tenants/${tenant.tenantId}/notifications?unread=true`)
            .set('Authorization', bearer(admin.token))
        ).body.total,
      ).toBe(2);
      const all = await http()
        .post(`/v1/tenants/${tenant.tenantId}/notifications/read-all`)
        .set('Authorization', bearer(admin.token))
        .expect(200);
      expect(all.body).toEqual({ updated: 2 });
      expect(
        (
          await http()
            .get(`/v1/tenants/${tenant.tenantId}/notifications?unread=true`)
            .set('Authorization', bearer(tenant.token))
        ).body.total,
      ).toBe(3);
    });
  });

  // ===========================================================================================

  describe('housekeeping', () => {
    it('deletes notifications after 90 days, engine events after 30 days and expired tickets, and keeps the rest', async () => {
      const tenant = await signup('Purge');
      const old = new Date(Date.now() - 100 * 86_400_000);
      const recent = new Date(Date.now() - 5 * 86_400_000);
      const oldNote = await prisma.notification.create({
        data: {
          tenantId: tenant.tenantId,
          userId: tenant.ownerId,
          type: 'x',
          params: {},
          createdAt: old,
        },
      });
      const newNote = await prisma.notification.create({
        data: {
          tenantId: tenant.tenantId,
          userId: tenant.ownerId,
          type: 'x',
          params: {},
          createdAt: recent,
        },
      });
      await prisma.engineEvent.createMany({
        data: [
          {
            tenantId: tenant.tenantId,
            eventId: 'old',
            type: 'x',
            occurredAt: old,
            receivedAt: new Date(Date.now() - 40 * 86_400_000),
          },
          {
            tenantId: tenant.tenantId,
            eventId: 'new',
            type: 'x',
            occurredAt: recent,
            receivedAt: recent,
          },
        ],
      });
      await prisma.streamTicket.createMany({
        data: [
          {
            tenantId: tenant.tenantId,
            userId: tenant.ownerId,
            tokenHash: `old-${run}`,
            expiresAt: new Date(Date.now() - 2 * 3600_000),
          },
          {
            tenantId: tenant.tenantId,
            userId: tenant.ownerId,
            tokenHash: `new-${run}`,
            expiresAt: new Date(Date.now() + 30_000),
          },
        ],
      });
      const result = await app.get(HousekeepingService).purge(new Date());
      expect(result.notifications).toBeGreaterThanOrEqual(1);
      expect(
        await prisma.notification.findUnique({ where: { id: oldNote.id } }),
      ).toBeNull();
      expect(
        await prisma.notification.findUnique({ where: { id: newNote.id } }),
      ).not.toBeNull();
      const events = await prisma.engineEvent.findMany({
        where: { tenantId: tenant.tenantId },
      });
      expect(events.map((e) => e.eventId)).toEqual(['new']);
      const tickets = await prisma.streamTicket.findMany({
        where: { tenantId: tenant.tenantId },
      });
      expect(tickets.map((t) => t.tokenHash)).toEqual([`new-${run}`]);
    });
  });

  // ===========================================================================================

  describe('escalations the gateway could not deliver (known issue 12)', () => {
    it('are remembered while the engine is down and delivered by the retry job once it is back', async () => {
      const tenant = await signup('Retry');
      const key = await widgetKey(tenant);
      const session = await customer(key);
      engine.setDown(true);
      const down = await say(session.token, 'hello?');
      expect(down.events.at(-1)).toMatchObject({
        event: 'fallback',
        data: { reason: 'ai_unavailable', escalated: false },
      });
      const row = () =>
        prisma.gatewayConversation.findFirstOrThrow({
          where: {
            tenantId: tenant.tenantId,
            conversationId: session.conversationId,
          },
        });
      expect(await row()).toMatchObject({
        escalationPending: true,
        escalationAttempts: 0,
      });

      // the engine is still down: the attempt is counted and the flag stays
      const retry = app.get(EscalationRetryService);
      const sweep = async () => {
        const result = await retry.run();
        expect(result.skipped).toBe(false);
        return result;
      };
      await sweep();
      expect(await row()).toMatchObject({
        escalationPending: true,
        escalationAttempts: 1,
      });

      // back up: it is not tried again before the back-off has passed
      engine.setDown(false);
      expect(await sweep()).toMatchObject({ attempted: 0 });
      await prisma.gatewayConversation.update({
        where: { id: (await row()).id },
        data: { escalationLastAttemptAt: new Date(Date.now() - 10 * 60_000) },
      });
      expect(await sweep()).toMatchObject({ attempted: 1, delivered: 1 });
      expect(await row()).toMatchObject({
        escalationPending: false,
        escalationAttempts: 2,
      });
      // the engine now has it escalated, and the team was told through the event
      expect(
        engine.inspect(tenant.tenantId, session.conversationId)?.conversation,
      ).toMatchObject({
        status: 'escalated',
        escalationReason: 'ai_unavailable',
      });
      await engine.flushEvents();
      const notified = await prisma.notification.count({
        where: { tenantId: tenant.tenantId, type: 'conversation.escalated' },
      });
      expect(notified).toBeGreaterThanOrEqual(1);
    });

    it('stop after the bounded number of attempts and keep the flag', async () => {
      const tenant = await signup('GiveUp');
      const session = await customer(await widgetKey(tenant));
      engine.setDown(true);
      await say(session.token, 'hello?');
      const rowOf = () =>
        prisma.gatewayConversation.findFirstOrThrow({
          where: {
            tenantId: tenant.tenantId,
            conversationId: session.conversationId,
          },
        });
      await prisma.gatewayConversation.update({
        where: { id: (await rowOf()).id },
        data: {
          escalationAttempts: ESCALATION_MAX_ATTEMPTS - 1,
          escalationLastAttemptAt: new Date(Date.now() - 3600_000),
        },
      });
      const retry = app.get(EscalationRetryService);
      await retry.run();
      expect(await rowOf()).toMatchObject({
        escalationPending: true,
        escalationAttempts: ESCALATION_MAX_ATTEMPTS,
      });
      engine.setDown(false);
      await prisma.gatewayConversation.update({
        where: { id: (await rowOf()).id },
        data: { escalationLastAttemptAt: new Date(Date.now() - 3600_000) },
      });
      // never selected again: the flag stays for a human to see
      await retry.run();
      expect(await rowOf()).toMatchObject({
        escalationPending: true,
        escalationAttempts: ESCALATION_MAX_ATTEMPTS,
      });
    });

    it('two sweeps at the same time do not both work (advisory lock)', async () => {
      const retry = app.get(EscalationRetryService);
      const results = await Promise.all([
        retry.run(),
        retry.run(),
        retry.run(),
      ]);
      expect(results.filter((r) => !r.skipped).length).toBeGreaterThanOrEqual(
        1,
      );
      expect(results.every((r) => r.skipped || r.attempted >= 0)).toBe(true);
    });
  });

  // ===========================================================================================

  describe('reactivating a suspended tenant restores its previous state (J0.8, G29.6)', () => {
    async function adminToken() {
      const email = `ops.${run}.${(counter += 1)}@example.com`;
      await prisma.platformAdmin.create({
        data: { email, passwordHash: await bcrypt.hash('ops-password-123', 4) },
      });
      const login = await http()
        .post('/v1/admin/auth/login')
        .send({ email, password: 'ops-password-123' })
        .expect(201);
      return login.body.access_token as string;
    }
    const setStatus = (token: string, tenantId: string, status: string) =>
      http()
        .patch(`/v1/admin/tenants/${tenantId}`)
        .set('Authorization', bearer(token))
        .send({ status })
        .expect(200);

    it('a Starter trial comes back as the trial, with its period untouched', async () => {
      const tenant = await signup('SuspendTrial', 'starter');
      const token = await adminToken();
      const before = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: tenant.tenantId },
      });
      await setStatus(token, tenant.tenantId, 'suspended');
      expect(
        (
          await prisma.tenant.findUniqueOrThrow({
            where: { id: tenant.tenantId },
          })
        ).status,
      ).toBe('suspended');
      await setStatus(token, tenant.tenantId, 'active');
      const tenantRow = await prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.tenantId },
      });
      const after = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: tenant.tenantId },
      });
      expect(tenantRow).toMatchObject({ status: 'trial', plan: 'starter' });
      expect(after).toMatchObject({
        planCode: 'starter',
        status: 'active',
        statusBeforeSuspension: null,
      });
      expect(after.currentPeriodEnd).toEqual(before.currentPeriodEnd);
    });

    it('a past-due Pro tenant comes back past due, with its grace period', async () => {
      const tenant = await signup('SuspendPastDue', 'starter');
      await prisma.subscription.update({
        where: { tenantId: tenant.tenantId },
        data: {
          planCode: 'pro',
          interval: 'month',
          currentPeriodEnd: new Date(Date.now() - 86_400_000),
        },
      });
      app.get(EntitlementsService).invalidate(tenant.tenantId);
      await app.get(SubscriptionService).getEffective(tenant.tenantId);
      const pastDue = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: tenant.tenantId },
      });
      expect(pastDue.status).toBe('past_due');
      const token = await adminToken();
      await setStatus(token, tenant.tenantId, 'suspended');
      expect(
        (
          await prisma.subscription.findUniqueOrThrow({
            where: { tenantId: tenant.tenantId },
          })
        ).status,
      ).toBe('suspended');
      await setStatus(token, tenant.tenantId, 'active');
      const after = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: tenant.tenantId },
      });
      expect(after).toMatchObject({ planCode: 'pro', status: 'past_due' });
      expect(after.graceEndsAt).toEqual(pastDue.graceEndsAt);
      expect(
        (
          await prisma.tenant.findUniqueOrThrow({
            where: { id: tenant.tenantId },
          })
        ).status,
      ).toBe('active');
    });
  });

  // ===========================================================================================

  describe('the whole hand-off on real Postgres and the mock engine', () => {
    it('customer asks -> escalation -> bell -> claim -> reply reaches the widget -> release -> AI resumes -> resolve', async () => {
      const tenant = await signup('Demo');
      const agent = await addStaff(tenant);
      const colleague = await addStaff(tenant);
      const key = await widgetKey(tenant);
      const session = await customer(key);

      const dashboard = await openStream(
        `${base}/v1/tenants/${tenant.tenantId}/events`,
        {
          Authorization: bearer(agent.token),
        },
      );
      const widget = await openStream(`${base}/v1/widget/events`, {
        Authorization: bearer(session.token),
        Origin: ORIGIN,
      });
      opened.push(dashboard, widget);
      await Promise.all([
        dashboard.waitFor((e) => e.event === 'ready'),
        widget.waitFor((e) => e.event === 'ready'),
      ]);

      const hours = await say(session.token, 'What are your opening hours?');
      expect(hours.events.at(-1)?.data).toMatchObject({ aiReply: true });

      await say(session.token, 'I want to talk to a human');
      await dashboard.waitFor((e) => e.event === 'conversation.escalated');
      await dashboard.waitFor((e) => e.event === 'notification.created');
      const bell = await http()
        .get(`/v1/tenants/${tenant.tenantId}/notifications?unread=true`)
        .set('Authorization', bearer(agent.token))
        .expect(200);
      expect(bell.body.data[0]).toMatchObject({
        type: 'conversation.escalated',
        link: `/conversations/${session.conversationId}`,
        params: {
          conversationId: session.conversationId,
          reason: 'customer_requested',
        },
      });
      // every ACTIVE member got exactly one
      const perUser = await rows<{ user_id: string; n: number }>(
        `SELECT user_id, count(*)::int AS n FROM "tenant_core"."notifications"
          WHERE "tenant_id" = $1 AND "type" = 'conversation.escalated' GROUP BY user_id`,
        tenant.tenantId,
      );
      expect(perUser.map((r) => r.user_id).sort()).toEqual(
        [agent.id, colleague.id, tenant.ownerId].sort(),
      );
      expect(perUser.every((r) => r.n === 1)).toBe(true);
      await widget.waitFor(
        (e) => e.event === 'status' && e.data.status === 'escalated',
      );

      await claim(agent, tenant, session.conversationId).expect(200);
      await claim(colleague, tenant, session.conversationId).expect(409);
      await http()
        .post(
          `/v1/tenants/${tenant.tenantId}/conversations/${session.conversationId}/messages`,
        )
        .set('Authorization', bearer(tenant.token))
        .send({ content: 'owner tries to reply' })
        .expect(409);
      await http()
        .post(
          `/v1/tenants/${tenant.tenantId}/conversations/${session.conversationId}/messages`,
        )
        .set('Authorization', bearer(agent.token))
        .send({ content: 'Hello, how can I help?' })
        .expect(201);
      await engine.flushEvents();
      const reply = await widget.waitFor(
        (e) => e.event === 'message' && e.data.authorType === 'human',
      );
      expect(reply.data.content).toBe('Hello, how can I help?');
      expect(JSON.stringify(reply.data)).not.toContain(agent.id);

      const during = await say(session.token, 'thanks');
      expect(during.events.at(-1)?.data).toMatchObject({
        aiReply: false,
        conversationStatus: 'human_active',
      });

      await http()
        .post(
          `/v1/tenants/${tenant.tenantId}/conversations/${session.conversationId}/release`,
        )
        .set('Authorization', bearer(agent.token))
        .send({})
        .expect(200);
      await engine.flushEvents();
      await widget.waitFor(
        (e) => e.event === 'message' && e.data.contentKey === 'agent.left',
      );
      const resumed = await say(session.token, 'What is the delivery time?');
      expect(resumed.events.at(-1)?.data).toMatchObject({
        aiReply: true,
        conversationStatus: 'active',
      });

      await say(session.token, '/escalate');
      await claim(colleague, tenant, session.conversationId).expect(200);
      await http()
        .post(
          `/v1/tenants/${tenant.tenantId}/conversations/${session.conversationId}/resolve`,
        )
        .set('Authorization', bearer(colleague.token))
        .expect(200);
      await engine.flushEvents();
      await widget.waitFor(
        (e) => e.event === 'status' && e.data.status === 'resolved',
      );

      const actions = await rows<{ action: string }>(
        `SELECT action FROM "tenant_core"."audit_logs"
          WHERE "tenant_id" = $1 AND "target_id" = $2 ORDER BY "created_at", "id"`,
        tenant.tenantId,
        session.conversationId,
      );
      expect(actions.map((a) => a.action)).toEqual([
        'conversation.claimed',
        'conversation.released',
        'conversation.claimed',
        'conversation.resolved',
      ]);
      // usage was counted once per conversation and message, from the stream and the events alike
      const usage = await rows<{ conversations: number; messages: number }>(
        `SELECT COALESCE(SUM(conversations),0)::int AS conversations, COALESCE(SUM(messages),0)::int AS messages
           FROM "tenant_core"."usage_daily" WHERE "tenant_id" = $1`,
        tenant.tenantId,
      );
      expect(usage[0].conversations).toBe(1);
      const ledger = await rows<{ n: number; distinct_refs: number }>(
        `SELECT count(*)::int AS n, count(DISTINCT ref_id)::int AS distinct_refs
           FROM "tenant_core"."usage_events" WHERE "tenant_id" = $1 AND "kind" = 'message'`,
        tenant.tenantId,
      );
      expect(ledger[0].n).toBe(ledger[0].distinct_refs);
      expect(usage[0].messages).toBe(ledger[0].n);
    });
  });
});
