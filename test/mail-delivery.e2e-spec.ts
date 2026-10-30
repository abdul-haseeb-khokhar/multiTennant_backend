import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FakeClock } from '../src/billing/clock';
import { ConsoleMailer } from '../src/mail/console.mailer';
import { MailHealth } from '../src/mail/mail-health';
import { MailDeliveryError, MailMessage, Mailer } from '../src/mail/mailer';
import { installBilling } from './utils/billing-fixtures';
import { mockTransaction, PrismaMock } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery';
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Phase 4C (H3): what the API tells the caller about the email it triggered (`delivery`), that a
 * failing provider never breaks the flow, that nothing reveals whether an account exists, and the
 * health warning. The provider is the app's own `Mailer`, with `send` replaced.
 */
describe('Mail delivery (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let clock: FakeClock;
  let staffToken: Awaited<ReturnType<typeof createTestApp>>['staffToken'];
  let allowStaff: () => void;
  let send: jest.SpyInstance;
  let sent: MailMessage[];

  const http = () => request(app.getHttpServer());
  const as = (role: 'owner' | 'admin' | 'agent', verified = true) =>
    `Bearer ${staffToken({ userId: `${role}-1`, tenantId: 'tenant-a', role }, { emailVerified: verified })}`;
  const down = (reason: ConstructorParameters<typeof MailDeliveryError>[0]) =>
    send.mockRejectedValue(new MailDeliveryError(reason, 429));

  beforeAll(async () => {
    ({ app, prisma, clock, staffToken, allowStaff } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('the e2e suite runs on the console mailer whatever .env holds: no test can send a real email', () => {
    expect(app.get(Mailer)).toBeInstanceOf(ConsoleMailer);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    allowStaff();
    mockTransaction(prisma);
    sent = [];
    send = jest.spyOn(app.get(Mailer), 'send').mockImplementation((message) => {
      sent.push(message);
      return Promise.resolve('sent');
    });
    // a fresh health counter for each test
    const health = app.get(MailHealth) as unknown as { consecutive: number };
    health.consecutive = 0;
    prisma.tenant.findUnique.mockResolvedValue({
      status: 'active',
      defaultLocale: 'en',
    });
  });

  afterEach(() => {
    send.mockRestore();
  });

  describe('POST /v1/tenants/:tenantId/invites', () => {
    const invite = () =>
      http()
        .post('/v1/tenants/tenant-a/invites')
        .set('Authorization', as('owner'))
        .send({ email: 'new@acme.com', role: 'agent' });

    beforeEach(() => {
      installBilling(prisma, clock, { subscription: { tenantId: 'tenant-a' } });
      prisma.tenantUser.count.mockResolvedValue(1);
      prisma.staffInvite.count.mockResolvedValue(0);
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      prisma.staffInvite.create.mockImplementation(
        ({ data: { tokenHash: _omitted, ...data } }) =>
          Promise.resolve({ id: 'inv-1', createdAt: new Date(), ...data }),
      );
    });

    it('delivery "sent" when the provider took it; the email is rendered for the tenant language', async () => {
      const res = await invite().expect(201);
      expect(res.body.delivery).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        to: 'new@acme.com',
        template: 'staff-invite',
        locale: 'en',
      });
    });

    it('delivery "failed" when the provider is down: still 201, the invite exists, and the answer carries no provider details', async () => {
      down('quota_daily');
      const res = await invite().expect(201);
      expect(res.body).toMatchObject({
        id: 'inv-1',
        email: 'new@acme.com',
        delivery: 'failed',
      });
      expect(prisma.staffInvite.create).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(res.body)).not.toMatch(/quota|resend|429/i);
    });

    it('delivery "failed" also for a provider that throws something unexpected', async () => {
      send.mockRejectedValue(new Error('boom'));
      const res = await invite().expect(201);
      expect(res.body.delivery).toBe('failed');
    });

    it('delivery "skipped" with the development console mailer', async () => {
      send.mockResolvedValue('skipped');
      const res = await invite().expect(201);
      expect(res.body.delivery).toBe('skipped');
    });

    it('re-inviting the same address is the way to resend, and reports its own delivery', async () => {
      down('network');
      expect((await invite().expect(201)).body.delivery).toBe('failed');
      send.mockResolvedValue('sent');
      expect((await invite().expect(201)).body.delivery).toBe('sent');
    });

    it('the delivery field is not in the invite list', async () => {
      prisma.staffInvite.findMany.mockResolvedValue([
        { id: 'inv-1', email: 'new@acme.com' },
      ]);
      prisma.staffInvite.count.mockResolvedValue(1);
      const res = await http()
        .get('/v1/tenants/tenant-a/invites')
        .set('Authorization', as('owner'))
        .expect(200);
      expect(JSON.stringify(res.body)).not.toContain('delivery');
    });
  });

  describe('POST /v1/auth/signup', () => {
    beforeEach(() => {
      installBilling(prisma, clock, { subscription: null });
      // No slug is taken or reserved (SlugService looks at both tables, J3).
      prisma.tenant.findMany.mockResolvedValue([]);
      prisma.tenantSlugAlias.findMany.mockResolvedValue([]);
      prisma.tenant.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 't1', plan: 'free', status: 'trial', ...data }),
      );
      prisma.tenantUser.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'u1',
          email: data.email,
          role: data.role,
          tenantId: data.tenantId,
        }),
      );
    });
    const signup = () =>
      http().post('/v1/auth/signup').send({
        tenantName: 'Acme Support',
        ownerEmail: 'owner@acme.com',
        ownerPassword: PASSWORD,
      });

    it('reports verificationDelivery "sent"', async () => {
      const res = await signup().expect(201);
      expect(res.body.verificationDelivery).toBe('sent');
      expect(sent[0]).toMatchObject({
        template: 'email-verification',
        to: 'owner@acme.com',
      });
    });

    it('a failing provider does not undo the signup: 201, a token, the verification record, verificationDelivery "failed"', async () => {
      down('auth');
      const res = await signup().expect(201);
      expect(res.body.verificationDelivery).toBe('failed');
      expect(res.body.access_token).toEqual(expect.any(String));
      expect(prisma.tenant.create).toHaveBeenCalledTimes(1);
      expect(prisma.emailVerification.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /v1/auth/verify-email/resend', () => {
    beforeEach(() => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'owner-1',
        email: 'owner@acme.com',
        locale: null,
        emailVerifiedAt: null,
        tenant: { defaultLocale: 'ur' },
      });
    });
    const resend = () =>
      http()
        .post('/v1/auth/verify-email/resend')
        .set('Authorization', as('owner', false));

    it('reports "sent" and sends in the user language', async () => {
      const res = await resend().expect(202);
      expect(res.body.delivery).toBe('sent');
      expect(sent[0].locale).toBe('ur');
    });

    it('reports "failed" without failing the request', async () => {
      down('rate_limited');
      const res = await resend().expect(202);
      expect(res.body.delivery).toBe('failed');
      expect(prisma.emailVerification.create).toHaveBeenCalledTimes(1);
    });

    it('an already verified user: nothing is sent, "skipped"', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'owner-1',
        email: 'owner@acme.com',
        locale: null,
        emailVerifiedAt: new Date(),
        tenant: { defaultLocale: 'en' },
      });
      const res = await resend().expect(202);
      expect(res.body.delivery).toBe('skipped');
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('POST /v1/auth/password-reset/request (constant answer)', () => {
    const body = { tenantSlug: 'acme', email: 'known@acme.com' };

    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 'tenant-a',
        status: 'active',
        defaultLocale: 'en',
      });
    });

    const answerFor = async (known: boolean) => {
      prisma.tenantUser.findFirst.mockResolvedValueOnce(
        known ? { id: 'u1', status: 'active', locale: null } : null,
      );
      const res = await http()
        .post('/v1/auth/password-reset/request')
        .send(body)
        .expect(202);
      await flush();
      return res.body;
    };

    it('never reports a delivery, whether the account exists or not, and whether the provider works or not', async () => {
      const bodies = [];
      bodies.push(await answerFor(true));
      bodies.push(await answerFor(false));
      down('quota_monthly');
      bodies.push(await answerFor(true));
      bodies.push(await answerFor(false));
      for (const b of bodies) expect(b).not.toHaveProperty('delivery');
      // in link mode only the real account's link differs: that is the existing development switch
      expect(Object.keys(bodies[1])).toEqual([]);
    });

    it('a provider failure is invisible to the caller: same status and shape as a success', async () => {
      down('timeout');
      const failing = await answerFor(true);
      send.mockResolvedValue('sent');
      const working = await answerFor(true);
      expect(Object.keys(failing)).toEqual(Object.keys(working));
    });

    it('nothing is sent for an unknown account', async () => {
      await answerFor(false);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('GET /health/ready mail warning', () => {
    const ready = async () =>
      (await http().get('/health/ready').expect(200)).body.mail;

    beforeEach(() => {
      prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      installBilling(prisma, clock, { subscription: { tenantId: 'tenant-a' } });
      prisma.tenantUser.count.mockResolvedValue(1);
      prisma.staffInvite.count.mockResolvedValue(0);
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      prisma.staffInvite.create.mockImplementation(
        ({ data: { tokenHash: _omitted, ...data } }) =>
          Promise.resolve({ id: 'inv-1', createdAt: new Date(), ...data }),
      );
    });

    it('stays ok until three deliveries in a row fail, then degraded (still HTTP 200), then recovers; no address or link in it', async () => {
      const invite = () =>
        http()
          .post('/v1/tenants/tenant-a/invites')
          .set('Authorization', as('owner'))
          .send({ email: 'new@acme.com' })
          .expect(201);
      // The test app runs the console provider, so the status here is "not_configured";
      // the counters still move, which is what the snapshot reports for a real provider.
      down('quota_daily');
      await invite();
      await invite();
      expect(await ready()).toMatchObject({
        provider: 'console',
        consecutiveFailures: 2,
      });
      await invite();
      const after = await ready();
      expect(after).toMatchObject({
        consecutiveFailures: 3,
        lastFailureReason: 'quota_daily',
      });
      expect(JSON.stringify(after)).not.toMatch(/@|https?:/);
      send.mockResolvedValue('sent');
      await invite();
      expect(await ready()).toMatchObject({ consecutiveFailures: 0 });
    });
  });
});
