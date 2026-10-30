import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { EngineClient } from '../../src/engine/engine-client';
import type { MockEngineClient } from '../../src/engine/mock-engine.client';
import { signEngineEvent } from '../../src/events/engine-event-signature';
import { PrismaService } from '../../src/prisma/prisma.service';
import { UsageService } from '../../src/usage/usage.service';

/**
 * Requests and the tenant status check (Phase 5B-2) against a real Postgres: the constraints the Prisma
 * schema cannot express, the composite foreign keys, the conditional updates under real concurrency,
 * idempotent creation, the status check on real subscriptions and call-minute rows, search with real
 * SQL, notifications and the whole mock-engine flow (call, request, notification, staff confirms, the
 * engine's later update is refused with locked).
 */
describe('Requests and the status check (real database, Phase 5B-2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let usage: UsageService;
  let engine: MockEngineClient;

  const http = () => request(app.getHttpServer());
  const run = randomBytes(4).toString('hex');
  const password = 'correct-horse-battery';
  const bearer = (token: string) => `Bearer ${token}`;
  const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;
  const service = () => `Bearer ${process.env.INTERNAL_API_TOKEN}`;
  let counter = 0;
  const phone = () => `+9230${String(1000000 + ++counter).padStart(8, '0')}`;

  interface T {
    tenantId: string;
    name: string;
    token: string;
    agentId: string;
  }

  async function signup(name: string, plan = 'pro'): Promise<T> {
    const email = `${name.toLowerCase().replace(/\W/g, '')}.${run}@requests.test`;
    const res = await http()
      .post('/v1/auth/signup')
      .send({
        tenantName: `${name} ${run}`,
        ownerEmail: email,
        ownerPassword: password,
      })
      .expect(201);
    await http()
      .post('/v1/auth/verify-email')
      .send({ token: tokenFrom(res.body.verificationLink) })
      .expect(204);
    if (plan !== 'starter') {
      await prisma.subscription.update({
        where: { tenantId: res.body.tenant.id },
        data: { planCode: plan, currentPeriodEnd: null },
      });
    }
    const agent = await prisma.agent.findFirstOrThrow({
      where: { tenantId: res.body.tenant.id, isDefault: true },
    });
    return {
      tenantId: res.body.tenant.id,
      name: res.body.tenant.name,
      token: res.body.access_token,
      agentId: agent.id,
    };
  }

  /** A staff user without going through the invite flow; returns a token the guards accept. */
  async function staffMember(
    t: T,
    role: 'admin' | 'agent',
    status: 'active' | 'disabled' = 'active',
  ) {
    const user = await prisma.tenantUser.create({
      data: {
        tenantId: t.tenantId,
        email: `${role}.${randomBytes(4).toString('hex')}.${run}@requests.test`,
        passwordHash: 'x',
        role,
        status,
        emailVerifiedAt: new Date(),
      },
    });
    const token = jwt.sign({
      sub: user.id,
      tenantId: t.tenantId,
      role,
      scope: 'tenant',
      iatMs: Date.now(),
    });
    return { id: user.id, token };
  }

  const putCustomer = (
    t: { tenantId: string },
    body: Record<string, unknown>,
  ) =>
    http()
      .put(`/internal/tenants/${t.tenantId}/customers/by-phone`)
      .set('Authorization', service())
      .send(body);
  let keySeq = 0;
  /** Saves a request through the engine's routes, the way the engine does. */
  async function saveRequest(
    t: T,
    over: Record<string, unknown> = {},
    callerPhone = phone(),
    callerName = 'Ahmed Khan',
  ) {
    const customer = await putCustomer(t, {
      phone: callerPhone,
      name: callerName,
    });
    const n = ++keySeq;
    const res = await http()
      .post(`/internal/tenants/${t.tenantId}/requests`)
      .set('Authorization', service())
      .send({
        reference: `AP-${randomBytes(3).toString('hex').toUpperCase()}`,
        type: 'appointment',
        submissionKey: `key-${run}-${n}`,
        endCustomerId: customer.body.endCustomerId,
        summary: `${callerName} wants a check-up`,
        scheduledLocal: '2026-11-05 15:30',
        data: { service: 'check-up', secret: `for ${callerName}` },
        ...over,
      });
    return { res, customerId: customer.body.endCustomerId as string };
  }

  const staffUrl = (t: T, path = '') =>
    `/v1/tenants/${t.tenantId}/requests${path}`;
  const move = (
    t: T,
    id: string,
    status: string,
    token = t.token,
    extra: object = {},
  ) =>
    http()
      .patch(staffUrl(t, `/${id}/status`))
      .set('Authorization', bearer(token))
      .send({ status, ...extra });
  const statusOf = (tenantId: string, agentId?: string) =>
    http()
      .get(
        `/internal/tenants/${tenantId}/status${agentId ? `?agentId=${agentId}` : ''}`,
      )
      .set('Authorization', service());
  const sqlFails = async (sql: string, ...params: unknown[]) => {
    try {
      await prisma.$executeRawUnsafe(sql, ...params);
    } catch (error) {
      return String((error as Error).message);
    }
    return null;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    // Listen once: with parallel requests supertest would otherwise close the shared server.
    await app.listen(0);
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    usage = app.get(UsageService);
    engine = app.get(EngineClient) as unknown as MockEngineClient;
  });

  afterAll(async () => {
    await app.close();
  });

  // =============================================================================================
  describe('constraints and keys', () => {
    let a: T;
    let b: T;
    let customerA: string;
    let customerB: string;

    const insert = (
      t: { tenantId: string },
      agentId: string,
      customerId: string | null,
      over: Record<string, string | number | null> = {},
    ) => {
      const row = {
        reference: `CHK-${randomBytes(3).toString('hex').toUpperCase()}`,
        type: 'appointment',
        status: 'requested',
        submission_key: `chk-${randomBytes(4).toString('hex')}`,
        cancelled_by: null,
        details: '{}',
        ...over,
      };
      return sqlFails(
        `INSERT INTO "tenant_core"."requests"
           ("id","tenant_id","agent_id","end_customer_id","reference","type","status","submission_key","cancelled_by","details","updated_at")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,now())`,
        randomBytes(8).toString('hex'),
        t.tenantId,
        agentId,
        customerId,
        row.reference,
        row.type,
        row.status,
        row.submission_key,
        row.cancelled_by,
        row.details,
      );
    };

    beforeAll(async () => {
      a = await signup('ConstraintsA');
      b = await signup('ConstraintsB');
      customerA = (await putCustomer(a, { phone: phone() }).expect(201)).body
        .endCustomerId;
      customerB = (await putCustomer(b, { phone: phone() }).expect(201)).body
        .endCustomerId;
    });

    it('accepts a valid row', async () => {
      expect(await insert(a, a.agentId, customerA)).toBeNull();
    });

    it.each([
      ['a lower-case reference', { reference: 'ap-lower1' }],
      ['a reference with spaces', { reference: 'AP 4K7Q2' }],
      ['a too short reference', { reference: 'A1' }],
      ['an unknown type', { type: 'refund' }],
      ['an unknown status', { status: 'pending' }],
      [
        'cancelled_by on a request that is not cancelled',
        { cancelled_by: 'staff' },
      ],
      [
        'a made-up cancelled_by',
        { status: 'cancelled', cancelled_by: 'robot' },
      ],
      ['details that are not an object', { details: '[1,2]' }],
      [
        'details over the safety cap',
        { details: JSON.stringify({ x: 'y'.repeat(33_000) }) },
      ],
      ['an empty submission key', { submission_key: '' }],
    ])('refuses %s (CHECK constraint)', async (_name, over) => {
      const message = await insert(a, a.agentId, customerA, over);
      expect(message).toMatch(/check constraint|violates/i);
    });

    it.each([
      ['appointment', 'AP-4K7Q2'],
      ['callback', 'CB-MN3P9'],
      ['order', 'OR-7HW2X'],
    ])(
      'accepts a %s with the engine reference %s (type CHECK widened in Phase 5B-3)',
      async (type, reference) => {
        expect(
          await insert(a, a.agentId, customerA, {
            type,
            reference:
              reference + '-' + randomBytes(2).toString('hex').toUpperCase(),
          }),
        ).toBeNull();
      },
    );

    it('accepts cancelled_by while the request is cancelled', async () => {
      expect(
        await insert(a, a.agentId, customerA, {
          status: 'cancelled',
          cancelled_by: 'caller',
        }),
      ).toBeNull();
    });

    it('a reference and a submission key are unique per tenant, and may repeat across tenants', async () => {
      expect(
        await insert(a, a.agentId, customerA, {
          reference: 'DUP-1',
          submission_key: 'dup-a',
        }),
      ).toBeNull();
      expect(
        await insert(a, a.agentId, customerA, {
          reference: 'DUP-1',
          submission_key: 'dup-b',
        }),
      ).toMatch(/23505|already exists/i);
      expect(
        await insert(a, a.agentId, customerA, {
          reference: 'DUP-2',
          submission_key: 'dup-a',
        }),
      ).toMatch(/23505|already exists/i);
      expect(
        await insert(b, b.agentId, customerB, {
          reference: 'DUP-1',
          submission_key: 'dup-a',
        }),
      ).toBeNull();
    });

    it("a request cannot name another tenant's agent or another tenant's customer (composite foreign keys)", async () => {
      expect(await insert(a, b.agentId, customerA)).toMatch(/foreign key/i);
      expect(await insert(a, a.agentId, customerB)).toMatch(/foreign key/i);
      expect(await insert(b, a.agentId, customerB)).toMatch(/foreign key/i);
    });

    it('a request without a customer is allowed (an erased customer, F1), and the tenant foreign key still holds', async () => {
      expect(await insert(a, a.agentId, null)).toBeNull();
      expect(
        await insert({ tenantId: 'no-such-tenant' }, a.agentId, null),
      ).toMatch(/foreign key/i);
    });

    it('an agent that has requests cannot be deleted at the database level (RESTRICT)', async () => {
      const night = await prisma.agent.create({
        data: { tenantId: a.tenantId, name: `Night ${run}` },
      });
      expect(await insert(a, night.id, customerA)).toBeNull();
      expect(
        await sqlFails(
          `DELETE FROM "tenant_core"."agents" WHERE "id" = $1`,
          night.id,
        ),
      ).toMatch(/foreign key/i);
    });

    it('a customer that has requests cannot be deleted (RESTRICT)', async () => {
      expect(
        await sqlFails(
          `DELETE FROM "tenant_core"."end_customers" WHERE "id" = $1`,
          customerA,
        ),
      ).toMatch(/foreign key/i);
    });

    it('end_customers (tenant_id, id) is unique, the target of the composite key', async () => {
      const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'tenant_core' AND tablename = 'end_customers' AND indexname = 'end_customers_tenant_id_id_key'`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  // =============================================================================================
  describe('the engine routes on real rows', () => {
    let t: T;
    let other: T;
    beforeAll(async () => {
      t = await signup('Engine');
      other = await signup('EngineOther');
    });

    it('saves a request with the collected document, the settings version and the default agent', async () => {
      const { res } = await saveRequest(t, {
        configVersion: 4,
        conversationId: 'c-1',
      });
      expect(res.status).toBe(201);
      const row = await prisma.customerRequest.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row).toMatchObject({
        tenantId: t.tenantId,
        agentId: t.agentId,
        status: 'requested',
        source: 'call',
        channel: 'voice',
        configVersion: 4,
        conversationId: 'c-1',
        details: { service: 'check-up', secret: 'for Ahmed Khan' },
      });
    });

    it('ten parallel saves of the same call are ONE request: one 201, nine 200s with the same id', async () => {
      const customer = await putCustomer(t, { phone: phone() }).expect(201);
      const key = `parallel-${run}`;
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          http()
            .post(`/internal/tenants/${t.tenantId}/requests`)
            .set('Authorization', service())
            .send({
              reference: 'PAR-00001',
              type: 'callback',
              submissionKey: key,
              endCustomerId: customer.body.endCustomerId,
              summary: 'parallel',
            }),
        ),
      );
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 200, 200, 200, 200, 200, 200, 200, 200, 201,
      ]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(results.filter((r) => r.body.created).length).toBe(1);
      expect(
        await prisma.customerRequest.count({
          where: { tenantId: t.tenantId, submissionKey: key },
        }),
      ).toBe(1);
      // one notification per active staff member, not ten
      expect(
        await prisma.notification.count({
          where: {
            tenantId: t.tenantId,
            type: 'request.submitted',
            dedupeKey: `request:${results[0].body.id}:submitted`,
          },
        }),
      ).toBe(1);
    });

    it('parallel saves of DIFFERENT calls with the same reference: one wins, the rest are 409 REQUEST_REFERENCE_TAKEN', async () => {
      const customer = await putCustomer(t, { phone: phone() }).expect(201);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_v, i) =>
          http()
            .post(`/internal/tenants/${t.tenantId}/requests`)
            .set('Authorization', service())
            .send({
              reference: 'CLASH-0001',
              type: 'callback',
              submissionKey: `clash-${run}-${i}`,
              endCustomerId: customer.body.endCustomerId,
              summary: 'clash',
            }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const refused = results.filter((r) => r.status === 409);
      expect(refused).toHaveLength(5);
      expect(
        refused.every((r) => r.body.code === 'REQUEST_REFERENCE_TAKEN'),
      ).toBe(true);
    });

    it('the same reference may be used by another tenant', async () => {
      const customer = await putCustomer(other, { phone: phone() }).expect(201);
      await http()
        .post(`/internal/tenants/${other.tenantId}/requests`)
        .set('Authorization', service())
        .send({
          reference: 'CLASH-0001',
          type: 'callback',
          submissionKey: `clash-other-${run}`,
          endCustomerId: customer.body.endCustomerId,
          summary: 'fine',
        })
        .expect(201);
    });

    it("another tenant's agent and customer are refused, nothing is saved", async () => {
      const foreignCustomer = await putCustomer(other, {
        phone: phone(),
      }).expect(201);
      const before = await prisma.customerRequest.count({
        where: { tenantId: t.tenantId },
      });
      const asCustomer = await http()
        .post(`/internal/tenants/${t.tenantId}/requests`)
        .set('Authorization', service())
        .send({
          reference: 'X-1111',
          type: 'callback',
          submissionKey: `foreign-c-${run}`,
          endCustomerId: foreignCustomer.body.endCustomerId,
          summary: 's',
        })
        .expect(404);
      expect(asCustomer.body.code).toBe('CUSTOMER_NOT_FOUND');
      const own = await putCustomer(t, { phone: phone() }).expect(201);
      const asAgent = await http()
        .post(`/internal/tenants/${t.tenantId}/requests`)
        .set('Authorization', service())
        .send({
          reference: 'X-2222',
          type: 'callback',
          submissionKey: `foreign-a-${run}`,
          endCustomerId: own.body.endCustomerId,
          agentId: other.agentId,
          summary: 's',
        })
        .expect(404);
      expect(asAgent.body.code).toBe('AGENT_NOT_FOUND');
      expect(
        await prisma.customerRequest.count({ where: { tenantId: t.tenantId } }),
      ).toBe(before);
    });

    it('the customer upsert is parallel-safe: ten simultaneous calls for one number make one customer', async () => {
      const number = phone();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          putCustomer(t, { phone: number, name: 'Sara' }),
        ),
      );
      expect(new Set(results.map((r) => r.body.endCustomerId)).size).toBe(1);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(
        await prisma.endCustomer.count({
          where: { tenantId: t.tenantId, externalId: `phone_${number}` },
        }),
      ).toBe(1);
    });

    it('the engine may change a request while it is requested and withdraw it; a confirmed one is locked', async () => {
      const { res } = await saveRequest(t);
      await http()
        .patch(`/internal/tenants/${t.tenantId}/requests/${res.body.reference}`)
        .set('Authorization', service())
        .send({ summary: 'Moved to Friday', data: { service: 'cleaning' } })
        .expect(200);
      expect(
        await prisma.customerRequest.findUniqueOrThrow({
          where: { id: res.body.id },
        }),
      ).toMatchObject({
        summary: 'Moved to Friday',
        details: { service: 'cleaning' },
      });

      await move(t, res.body.id, 'confirmed').expect(200);
      const locked = await http()
        .patch(`/internal/tenants/${t.tenantId}/requests/${res.body.reference}`)
        .set('Authorization', service())
        .send({ summary: 'too late' })
        .expect(409);
      expect(locked.body.code).toBe('REQUEST_LOCKED');
      await http()
        .post(
          `/internal/tenants/${t.tenantId}/requests/${res.body.reference}/withdraw`,
        )
        .set('Authorization', service())
        .expect(409);
      expect(
        (
          await prisma.customerRequest.findUniqueOrThrow({
            where: { id: res.body.id },
          })
        ).summary,
      ).toBe('Moved to Friday');
    });

    it('a request cannot be reached with the reference of another tenant', async () => {
      const { res } = await saveRequest(t);
      await http()
        .patch(
          `/internal/tenants/${other.tenantId}/requests/${res.body.reference}`,
        )
        .set('Authorization', service())
        .send({ summary: 'x' })
        .expect(404);
      await http()
        .post(
          `/internal/tenants/${other.tenantId}/requests/${res.body.reference}/withdraw`,
        )
        .set('Authorization', service())
        .expect(404);
    });
  });

  // =============================================================================================
  describe('races between the engine and staff, and between two staff members', () => {
    let t: T;
    let colleague: { id: string; token: string };
    beforeAll(async () => {
      t = await signup('Races');
      colleague = await staffMember(t, 'agent');
    });

    it('two people confirming one request at the same moment: exactly one wins, one audit entry, 20 times', async () => {
      for (let i = 0; i < 20; i++) {
        const { res } = await saveRequest(t);
        const [one, two] = await Promise.all([
          move(t, res.body.id, 'confirmed', t.token, {
            expectedStatus: 'requested',
          }),
          move(t, res.body.id, 'confirmed', colleague.token, {
            expectedStatus: 'requested',
          }),
        ]);
        expect([one.status, two.status].sort((x, y) => x - y)).toEqual([
          200, 409,
        ]);
        const loser = one.status === 409 ? one : two;
        expect(loser.body.code).toBe('REQUEST_STATUS_CONFLICT');
        expect(
          await prisma.auditLog.count({
            where: {
              tenantId: t.tenantId,
              targetId: res.body.id,
              action: 'request.confirmed',
            },
          }),
        ).toBe(1);
      }
    }, 120_000);

    it("confirm against cancel at the same moment: one wins, the final status is the winner's", async () => {
      for (let i = 0; i < 10; i++) {
        const { res } = await saveRequest(t);
        const [confirm, cancel] = await Promise.all([
          move(t, res.body.id, 'confirmed', t.token, {
            expectedStatus: 'requested',
          }),
          move(t, res.body.id, 'cancelled', colleague.token, {
            expectedStatus: 'requested',
          }),
        ]);
        expect([confirm.status, cancel.status].sort((x, y) => x - y)).toEqual([
          200, 409,
        ]);
        const row = await prisma.customerRequest.findUniqueOrThrow({
          where: { id: res.body.id },
        });
        expect(row.status).toBe(
          confirm.status === 200 ? 'confirmed' : 'cancelled',
        );
        expect(row.cancelledBy).toBe(confirm.status === 200 ? null : 'staff');
      }
    }, 120_000);

    it('the engine updating while staff confirm: the update lands only if it came first, never after the confirmation (20 times)', async () => {
      for (let i = 0; i < 20; i++) {
        const { res } = await saveRequest(t);
        const [engineWrite, staffWrite] = await Promise.all([
          http()
            .patch(
              `/internal/tenants/${t.tenantId}/requests/${res.body.reference}`,
            )
            .set('Authorization', service())
            .send({ summary: 'engine edit' }),
          move(t, res.body.id, 'confirmed'),
        ]);
        expect(staffWrite.status).toBe(200);
        expect([200, 409]).toContain(engineWrite.status);
        const row = await prisma.customerRequest.findUniqueOrThrow({
          where: { id: res.body.id },
        });
        expect(row.status).toBe('confirmed');
        // The engine's edit is on the row exactly when the engine was told it worked.
        expect(row.summary === 'engine edit').toBe(engineWrite.status === 200);
        if (engineWrite.status === 409) {
          expect(engineWrite.body.code).toBe('REQUEST_LOCKED');
        }
      }
    }, 120_000);

    it('the full workflow on real rows, with the audit trail', async () => {
      const { res } = await saveRequest(t);
      await move(t, res.body.id, 'confirmed').expect(200);
      await move(t, res.body.id, 'done').expect(200);
      await move(t, res.body.id, 'requested').expect(409); // done -> requested is not a move
      await move(t, res.body.id, 'confirmed').expect(200);
      await move(t, res.body.id, 'cancelled').expect(200);
      await move(t, res.body.id, 'requested').expect(200);
      const audit = await prisma.auditLog.findMany({
        where: { tenantId: t.tenantId, targetId: res.body.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((a) => a.action)).toEqual([
        'request.confirmed',
        'request.done',
        'request.confirmed',
        'request.cancelled',
        'request.reopened',
      ]);
      const text = JSON.stringify(audit.map((a) => [a.before, a.after]));
      for (const secret of ['Ahmed', 'check-up', '+9230']) {
        expect(text).not.toContain(secret);
      }
    });
  });

  // =============================================================================================
  describe('the staff API on real SQL', () => {
    let t: T;
    let other: T;
    let agentRole: { id: string; token: string };
    let ahmed: string;
    let sara: string;
    const ahmedPhone = '+923331112223';
    const saraPhone = '+923334445556';
    beforeAll(async () => {
      t = await signup('Staff');
      other = await signup('StaffOther');
      agentRole = await staffMember(t, 'agent');
      ahmed = (
        await saveRequest(
          t,
          { reference: 'AP-AHMED1', type: 'appointment' },
          ahmedPhone,
          'Ahmed Khan',
        )
      ).res.body.id;
      sara = (
        await saveRequest(
          t,
          { reference: 'CB-SARA22', type: 'callback' },
          saraPhone,
          'Sara Ali',
        )
      ).res.body.id;
      await saveRequest(
        other,
        { reference: 'AP-AHMED1' },
        ahmedPhone,
        'Ahmed Khan',
      );
    });

    const list = (query = '', token = t.token) =>
      http().get(staffUrl(t, query)).set('Authorization', bearer(token));

    it('lists newest first with the agent and the customer, to every role, without the details', async () => {
      for (const token of [t.token, agentRole.token]) {
        const res = await list('', token).expect(200);
        expect(res.body).toMatchObject({ total: 2, skip: 0, take: 20 });
        expect(res.body.data.map((r: any) => r.id)).toEqual([sara, ahmed]);
        expect(res.body.data[1]).toMatchObject({
          agent: { id: t.agentId },
          customer: { name: 'Ahmed Khan', phone: ahmedPhone },
        });
        expect(res.body.data[1]).not.toHaveProperty('details');
      }
    });

    it('searches by reference, name and phone number (case-insensitive SQL) and never crosses a tenant', async () => {
      const ids = async (q: string) =>
        (await list(`?q=${encodeURIComponent(q)}`).expect(200)).body.data.map(
          (r: any) => r.id,
        );
      expect(await ids('ap-ahmed')).toEqual([ahmed]);
      expect(await ids('SARA')).toEqual([sara]);
      expect(await ids('khan')).toEqual([ahmed]);
      expect(await ids('333 111 2223')).toEqual([ahmed]);
      expect(await ids(saraPhone)).toEqual([sara]);
      expect(await ids('nobody')).toEqual([]);
      // the other tenant also has an AP-AHMED1 for the same number: still one hit here
      expect(await ids('AHMED1')).toEqual([ahmed]);
    });

    it('filters by status, type, agent and date, and counts', async () => {
      await move(t, ahmed, 'confirmed').expect(200);
      expect(
        (await list('?status=confirmed').expect(200)).body.data.map(
          (r: any) => r.id,
        ),
      ).toEqual([ahmed]);
      expect(
        (await list('?type=callback').expect(200)).body.data.map(
          (r: any) => r.id,
        ),
      ).toEqual([sara]);
      expect((await list(`?agentId=${t.agentId}`).expect(200)).body.total).toBe(
        2,
      );
      expect(
        (await list(`?agentId=${other.agentId}`).expect(200)).body.total,
      ).toBe(0);
      expect(
        (await list('?from=2999-01-01T00:00:00Z').expect(200)).body.total,
      ).toBe(0);
      expect(
        (await list('?to=2000-01-01T00:00:00Z').expect(200)).body.total,
      ).toBe(0);
      const counts = await http()
        .get(staffUrl(t, '/counts'))
        .set('Authorization', bearer(agentRole.token))
        .expect(200);
      expect(counts.body).toEqual({
        requested: 1,
        confirmed: 1,
        done: 0,
        cancelled: 0,
        total: 2,
      });
      await move(t, ahmed, 'requested').expect(200);
    });

    it("two tenants never see or change each other's requests", async () => {
      const theirs = await list('', other.token);
      expect(theirs.status).toBe(403); // a token of another tenant on this URL
      const otherList = await http()
        .get(staffUrl(other))
        .set('Authorization', bearer(other.token))
        .expect(200);
      expect(otherList.body.total).toBe(1);
      expect(otherList.body.data.map((r: any) => r.id)).not.toContain(ahmed);
      await http()
        .get(staffUrl(other, `/${ahmed}`))
        .set('Authorization', bearer(other.token))
        .expect(404);
      await http()
        .patch(staffUrl(other, `/${ahmed}/status`))
        .set('Authorization', bearer(other.token))
        .send({ status: 'confirmed' })
        .expect(404);
      expect(
        (
          await prisma.customerRequest.findUniqueOrThrow({
            where: { id: ahmed },
          })
        ).status,
      ).toBe('requested');
    });

    it('the detail has the collected document, and a note is stored (and kept out of the audit log)', async () => {
      const res = await move(t, sara, 'confirmed', agentRole.token, {
        note: 'call Sara on 0333',
      }).expect(200);
      expect(res.body).toMatchObject({
        note: 'call Sara on 0333',
        statusChangedBy: agentRole.id,
        details: { service: 'check-up' },
      });
      const entries = await prisma.auditLog.findMany({
        where: { tenantId: t.tenantId, targetId: sara },
      });
      expect(JSON.stringify(entries)).not.toContain('0333');
      await move(t, sara, 'requested').expect(200);
    });

    it('a delete of an agent with requests is refused (AGENT_HAS_REQUESTS); disabling it is allowed; one without requests can go', async () => {
      const withRequests = await http()
        .post(`/v1/tenants/${t.tenantId}/agents`)
        .set('Authorization', bearer(t.token))
        .send({ name: `Evening ${run}` })
        .expect(201);
      await saveRequest(t, { agentId: withRequests.body.id });
      const refused = await http()
        .delete(`/v1/tenants/${t.tenantId}/agents/${withRequests.body.id}`)
        .set('Authorization', bearer(t.token))
        .expect(409);
      expect(refused.body.code).toBe('AGENT_HAS_REQUESTS');
      await http()
        .patch(`/v1/tenants/${t.tenantId}/agents/${withRequests.body.id}`)
        .set('Authorization', bearer(t.token))
        .send({ status: 'disabled' })
        .expect(200);
      expect(
        await prisma.agent.count({
          where: { id: withRequests.body.id, tenantId: t.tenantId },
        }),
      ).toBe(1);
      const empty = await http()
        .post(`/v1/tenants/${t.tenantId}/agents`)
        .set('Authorization', bearer(t.token))
        .send({ name: `Spare ${run}` })
        .expect(201);
      await http()
        .delete(`/v1/tenants/${t.tenantId}/agents/${empty.body.id}`)
        .set('Authorization', bearer(t.token))
        .expect(200);
    });

    it('the default agent still cannot be deleted, requests or not', async () => {
      const res = await http()
        .delete(`/v1/tenants/${t.tenantId}/agents/${t.agentId}`)
        .set('Authorization', bearer(t.token))
        .expect(409);
      expect(res.body.code).toBe('CANNOT_DELETE_DEFAULT_AGENT');
    });

    it('a request saved while the delete runs still blocks it (foreign key backstop maps to AGENT_HAS_REQUESTS)', async () => {
      const spare = await http()
        .post(`/v1/tenants/${t.tenantId}/agents`)
        .set('Authorization', bearer(t.token))
        .send({ name: `Racing ${run}` })
        .expect(201);
      const results = await Promise.all([
        saveRequest(t, { agentId: spare.body.id }),
        http()
          .delete(`/v1/tenants/${t.tenantId}/agents/${spare.body.id}`)
          .set('Authorization', bearer(t.token)),
      ]);
      const saved = results[0].res;
      const deleted = results[1] as request.Response;
      // Either the delete won (the save then finds no agent: 404) or the save won (the delete is a 409).
      if (deleted.status === 200) {
        expect(saved.status).toBe(404);
      } else {
        expect(saved.status).toBe(201);
        expect(deleted.status).toBe(409);
        expect(deleted.body.code).toBe('AGENT_HAS_REQUESTS');
      }
    }, 60_000);
  });

  // =============================================================================================
  describe("notifications and the engine's event", () => {
    it("a new request notifies every ACTIVE staff member once; the engine's own event adds nothing", async () => {
      const t = await signup('Notify');
      const admin = await staffMember(t, 'admin');
      const off = await staffMember(t, 'agent', 'disabled');
      const { res } = await saveRequest(t);
      const rows = await prisma.notification.findMany({
        where: { tenantId: t.tenantId, type: 'request.submitted' },
      });
      expect(
        rows.map((r) => r.userId).sort((x, y) => x.localeCompare(y)),
      ).toEqual(
        [
          (
            await prisma.tenantUser.findFirstOrThrow({
              where: { tenantId: t.tenantId, role: 'owner' },
            })
          ).id,
          admin.id,
        ].sort((x, y) => x.localeCompare(y)),
      );
      expect(rows.some((r) => r.userId === off.id)).toBe(false);
      expect(rows[0]).toMatchObject({
        link: `/requests/${res.body.id}`,
        params: {
          requestId: res.body.id,
          reference: res.body.reference,
          requestType: 'appointment',
        },
      });
      expect(JSON.stringify(rows)).not.toContain('Ahmed');

      // The engine also reports it as an event: processed, recorded in the inbox, no second notification.
      const event = {
        id: `evt-${run}-1`,
        type: 'record.submitted',
        tenantId: t.tenantId,
        occurredAt: new Date().toISOString(),
        data: { recordId: res.body.id, reference: res.body.reference },
      };
      const raw = JSON.stringify(event);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const deliver = () =>
        http()
          .post('/internal/events')
          .set('Content-Type', 'application/json')
          .set('X-Engine-Timestamp', timestamp)
          .set(
            'X-Engine-Signature',
            signEngineEvent(process.env.INTERNAL_API_TOKEN!, timestamp, raw),
          )
          .send(raw);
      expect((await deliver().expect(200)).body).toEqual({
        status: 'processed',
      });
      expect((await deliver().expect(200)).body).toEqual({
        status: 'duplicate',
      });
      expect(
        await prisma.notification.count({
          where: { tenantId: t.tenantId, type: 'request.submitted' },
        }),
      ).toBe(2);
      expect(
        await prisma.engineEvent.count({
          where: { tenantId: t.tenantId, eventId: event.id },
        }),
      ).toBe(1);
    });

    it("an event naming another tenant's request has no effect on this tenant", async () => {
      const a = await signup('EventA');
      const b = await signup('EventB');
      const { res } = await saveRequest(b);
      const event = {
        id: `evt-${run}-x`,
        type: 'record.updated',
        tenantId: a.tenantId,
        occurredAt: new Date().toISOString(),
        data: { recordId: res.body.id },
      };
      const raw = JSON.stringify(event);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const delivered = await http()
        .post('/internal/events')
        .set('Content-Type', 'application/json')
        .set('X-Engine-Timestamp', timestamp)
        .set(
          'X-Engine-Signature',
          signEngineEvent(process.env.INTERNAL_API_TOKEN!, timestamp, raw),
        )
        .send(raw)
        .expect(200);
      expect(delivered.body).toEqual({ status: 'processed' });
      expect(
        await prisma.notification.count({
          where: { tenantId: a.tenantId, type: 'request.submitted' },
        }),
      ).toBe(0);
    });
  });

  // =============================================================================================
  describe('the status check on real subscriptions and call-minute rows', () => {
    it('Starter: within the allowance, then quota_exceeded at it (no minute price, so a hard stop)', async () => {
      const t = await signup('StatusStarter', 'starter');
      expect((await statusOf(t.tenantId).expect(200)).body).toMatchObject({
        serviceable: true,
        plan: 'starter',
        agentId: t.agentId,
        overage: false,
      });
      await usage.recordCallMinutes(t.tenantId, {
        callId: `c-${run}-1`,
        minutes: 29,
      });
      expect((await statusOf(t.tenantId).expect(200)).body.serviceable).toBe(
        true,
      );
      await usage.recordCallMinutes(t.tenantId, {
        callId: `c-${run}-2`,
        minutes: 1,
      });
      expect((await statusOf(t.tenantId).expect(200)).body).toMatchObject({
        serviceable: false,
        reason: 'quota_exceeded',
      });
    });

    it('Pro at its allowance: overage on keeps serving (flagged), the owner switching it off stops it', async () => {
      const t = await signup('StatusPro', 'pro');
      await usage.recordCallMinutes(t.tenantId, {
        callId: `c-${run}-3`,
        minutes: 300,
      });
      expect((await statusOf(t.tenantId).expect(200)).body).toMatchObject({
        serviceable: true,
        overage: true,
      });
      await http()
        .patch(`/v1/tenants/${t.tenantId}/billing/settings`)
        .set('Authorization', bearer(t.token))
        .send({ overageEnabled: false })
        .expect(200);
      expect((await statusOf(t.tenantId).expect(200)).body).toMatchObject({
        serviceable: false,
        reason: 'quota_exceeded',
        overage: false,
      });
    });

    it('suspended and closed tenants are suspended; unsuspending serves again (live, no cache)', async () => {
      const t = await signup('StatusSuspend', 'pro');
      await prisma.subscription.update({
        where: { tenantId: t.tenantId },
        data: { status: 'suspended' },
      });
      expect((await statusOf(t.tenantId).expect(200)).body).toMatchObject({
        serviceable: false,
        reason: 'suspended',
        agentId: null,
      });
      await prisma.subscription.update({
        where: { tenantId: t.tenantId },
        data: { status: 'closed' },
      });
      expect((await statusOf(t.tenantId).expect(200)).body.reason).toBe(
        'suspended',
      );
      await prisma.subscription.update({
        where: { tenantId: t.tenantId },
        data: { status: 'active' },
      });
      expect((await statusOf(t.tenantId).expect(200)).body.serviceable).toBe(
        true,
      );
    });

    it('past due: served within the allowance, and at it NOT pushed into overage', async () => {
      const t = await signup('StatusPastDue', 'pro');
      await prisma.subscription.update({
        where: { tenantId: t.tenantId },
        data: {
          status: 'past_due',
          graceEndsAt: new Date(Date.now() + 5 * 86_400_000),
        },
      });
      expect((await statusOf(t.tenantId).expect(200)).body).toMatchObject({
        serviceable: true,
        overage: false,
      });
      await usage.recordCallMinutes(t.tenantId, {
        callId: `c-${run}-4`,
        minutes: 300,
      });
      expect((await statusOf(t.tenantId).expect(200)).body).toMatchObject({
        serviceable: false,
        reason: 'quota_exceeded',
      });
    });

    it('a disabled agent, an agent of another tenant and an unknown tenant', async () => {
      const t = await signup('StatusAgents', 'pro');
      const other = await signup('StatusAgentsOther', 'pro');
      const night = await http()
        .post(`/v1/tenants/${t.tenantId}/agents`)
        .set('Authorization', bearer(t.token))
        .send({ name: `Night ${run}` })
        .expect(201);
      await http()
        .patch(`/v1/tenants/${t.tenantId}/agents/${night.body.id}`)
        .set('Authorization', bearer(t.token))
        .send({ status: 'disabled' })
        .expect(200);
      expect(
        (await statusOf(t.tenantId, night.body.id).expect(200)).body,
      ).toMatchObject({
        serviceable: false,
        reason: 'agent_disabled',
        agentId: night.body.id,
      });
      // the default agent can be disabled too (decided 2026-10-29)
      await http()
        .patch(`/v1/tenants/${t.tenantId}/agents/${t.agentId}`)
        .set('Authorization', bearer(t.token))
        .send({ status: 'disabled' })
        .expect(200);
      expect((await statusOf(t.tenantId).expect(200)).body.reason).toBe(
        'agent_disabled',
      );

      const foreign = (await statusOf(t.tenantId, other.agentId).expect(200))
        .body;
      const missing = (await statusOf(t.tenantId, 'nope').expect(200)).body;
      expect(foreign).toEqual(missing);
      expect(foreign.reason).toBe('unknown_agent');

      expect((await statusOf('no-such-tenant').expect(200)).body).toEqual({
        tenantId: 'no-such-tenant',
        agentId: null,
        serviceable: false,
        reason: 'unknown_tenant',
        plan: null,
        overage: false,
      });
    });
  });

  // =============================================================================================
  describe('the whole flow with the mock engine on real Postgres', () => {
    it("call -> request -> notification -> staff screen -> confirm -> the engine's later update is refused (locked)", async () => {
      const t = await signup('Flow');
      const callerPhone = phone();
      const call = await engine.simulateCall(t.tenantId, {
        phone: callerPhone,
        name: 'Ahmed Khan',
      });
      await engine.flushEvents();

      const list = await http()
        .get(staffUrl(t))
        .set('Authorization', bearer(t.token))
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        id: call.recordId,
        reference: call.reference,
        status: 'requested',
        agent: { id: t.agentId },
        customer: { name: 'Ahmed Khan', phone: callerPhone },
      });
      expect(
        await prisma.notification.count({
          where: { tenantId: t.tenantId, type: 'request.submitted' },
        }),
      ).toBe(1);
      expect(
        (
          await prisma.engineEvent.findMany({ where: { tenantId: t.tenantId } })
        ).map((e) => e.type),
      ).toEqual(expect.arrayContaining(['record.submitted']));

      await expect(
        engine.simulateRequestUpdate(t.tenantId, call.reference, {
          summary: 'Friday please',
        }),
      ).resolves.toBe(true);
      await move(t, call.recordId, 'confirmed').expect(200);
      await expect(
        engine.simulateRequestUpdate(t.tenantId, call.reference, {
          summary: 'too late',
        }),
      ).resolves.toBe(false);
      expect(
        (
          await prisma.customerRequest.findUniqueOrThrow({
            where: { id: call.recordId },
          })
        ).summary,
      ).toBe('Friday please');
    });

    it('a caller with no number (an email-only request) becomes a customer of their own and the request is saved and listed without a phone', async () => {
      const t = await signup('NoPhone');
      const first = await putCustomer(t, { name: 'Sara' }).expect(201);
      const second = await putCustomer(t, { name: 'Sara' }).expect(201);
      expect(second.body.endCustomerId).not.toBe(first.body.endCustomerId);
      const saved = await http()
        .post(`/internal/tenants/${t.tenantId}/requests`)
        .set('Authorization', service())
        .send({
          reference: 'CB-NOPH2',
          type: 'callback',
          submissionKey: `nophone-${run}`,
          endCustomerId: first.body.endCustomerId,
          summary: 'Call-back by email',
          data: { email: 'sara@example.test' },
        })
        .expect(201);
      const detail = await http()
        .get(`${staffUrl(t)}/${saved.body.id}`)
        .set('Authorization', bearer(t.token))
        .expect(200);
      expect(detail.body.customer).toMatchObject({
        name: 'Sara',
        phone: null,
      });
    });

    it('an order call: the mock saves type order with an OR- reference and its dishes in details; staff find it by type, confirm it, and the engine is locked out', async () => {
      const t = await signup('FlowOrder');
      const call = await engine.simulateCall(t.tenantId, {
        type: 'order',
        phone: phone(),
        name: 'Bilal Raza',
      });
      await engine.flushEvents();
      expect(call.reference).toMatch(/^OR-/);

      const byType = await http()
        .get(`${staffUrl(t)}?type=order`)
        .set('Authorization', bearer(t.token))
        .expect(200);
      expect(byType.body.data.map((r: { id: string }) => r.id)).toEqual([
        call.recordId,
      ]);
      const detail = await http()
        .get(`${staffUrl(t)}/${call.recordId}`)
        .set('Authorization', bearer(t.token))
        .expect(200);
      expect(detail.body).toMatchObject({
        type: 'order',
        details: { order_type: 'pickup', order_items: [{ qty: 2 }] },
      });
      expect(
        await prisma.notification.findFirstOrThrow({
          where: { tenantId: t.tenantId, type: 'request.submitted' },
        }),
      ).toMatchObject({ params: { requestType: 'order' } });

      await move(t, call.recordId, 'confirmed').expect(200);
      await expect(
        engine.simulateRequestUpdate(t.tenantId, call.reference, {
          summary: 'too late',
        }),
      ).resolves.toBe(false);
    });

    it('a tenant out of minutes takes no call and saves nothing', async () => {
      const t = await signup('FlowQuota', 'free');
      await usage.recordCallMinutes(t.tenantId, {
        callId: `c-${run}-5`,
        minutes: 20,
      });
      await expect(engine.simulateCall(t.tenantId)).rejects.toMatchObject({
        reason: 'quota_exceeded',
      });
      expect(
        await prisma.customerRequest.count({ where: { tenantId: t.tenantId } }),
      ).toBe(0);
    });
  });
});
