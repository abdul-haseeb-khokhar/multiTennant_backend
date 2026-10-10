import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { hashToken } from '../src/common/tokens/tokens';
import { FakeClock } from '../src/billing/clock';
import { installBilling } from './utils/billing-fixtures';
import { mockTransaction, PrismaMock, prismaError } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

type Role = 'owner' | 'admin' | 'agent';

/** Pulls the `token` query parameter out of a link returned by MAIL_MODE=link. */
const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;

describe('Team management, account recovery, audit and i18n (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let staffToken: Awaited<ReturnType<typeof createTestApp>>['staffToken'];
  let allowStaff: () => void;
  let clock: FakeClock;

  const as = (
    role: Role,
    record: Parameters<typeof staffToken>[1] = {},
    tenantId = 'tenant-a',
  ) => `Bearer ${staffToken({ userId: `${role}-1`, tenantId, role }, record)}`;

  beforeAll(async () => {
    ({ app, prisma, staffToken, allowStaff, clock } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    allowStaff();
    mockTransaction(prisma);
    prisma.tenant.findUnique.mockResolvedValue({
      status: 'active',
      defaultLocale: 'en',
    });
  });

  describe('invitations (H1)', () => {
    beforeEach(() => {
      // Starter: 3 seats, one used by the owner.
      installBilling(prisma, clock, { subscription: { tenantId: 'tenant-a' } });
      prisma.tenantUser.count.mockResolvedValue(1);
      prisma.staffInvite.count.mockResolvedValue(0);
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      // like Prisma with `omit: { tokenHash: true }`
      prisma.staffInvite.create.mockImplementation(
        ({ data: { tokenHash: _omitted, ...data } }) =>
          Promise.resolve({ id: 'inv-1', createdAt: new Date(), ...data }),
      );
    });

    it('an owner invites an agent; the link comes back in link mode and only its hash is stored', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/tenants/tenant-a/invites')
        .set('Authorization', as('owner'))
        .send({ email: ' New.Agent@Acme.com ', role: 'agent' })
        .expect(201);

      expect(res.body).toMatchObject({
        id: 'inv-1',
        tenantId: 'tenant-a',
        email: 'new.agent@acme.com',
        role: 'agent',
        invitedBy: 'owner-1',
      });
      expect(res.body.link).toMatch(
        /^http:\/\/localhost:5173\/accept-invite\?token=[A-Za-z0-9_-]{43}$/,
      );
      const stored = prisma.staffInvite.create.mock.calls[0][0].data;
      expect(stored.tokenHash).toBe(hashToken(tokenFrom(res.body.link)));
      expect(JSON.stringify(res.body)).not.toContain(stored.tokenHash);
      expect(res.body).not.toHaveProperty('tokenHash');
    });

    it('an admin may invite admin and agent, not an owner', async () => {
      for (const role of ['admin', 'agent']) {
        await request(app.getHttpServer())
          .post('/v1/tenants/tenant-a/invites')
          .set('Authorization', as('admin'))
          .send({ email: `${role}@acme.com`, role })
          .expect(201);
      }
      const res = await request(app.getHttpServer())
        .post('/v1/tenants/tenant-a/invites')
        .set('Authorization', as('admin'))
        .send({ email: 'boss@acme.com', role: 'owner' })
        .expect(403);
      expect(res.body.code).toBe('OWNER_REQUIRED');
      expect(prisma.staffInvite.create).toHaveBeenCalledTimes(2);

      await request(app.getHttpServer())
        .post('/v1/tenants/tenant-a/invites')
        .set('Authorization', as('owner'))
        .send({ email: 'boss@acme.com', role: 'owner' })
        .expect(201);
    });

    it('an owner with an unverified email cannot invite staff (H4)', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/tenants/tenant-a/invites')
        .set('Authorization', as('owner', { emailVerified: false }))
        .send({ email: 'a@acme.com' })
        .expect(403);
      expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
      expect(prisma.staffInvite.create).not.toHaveBeenCalled();
    });

    it('validates the body and refuses a bad role', async () => {
      await request(app.getHttpServer())
        .post('/v1/tenants/tenant-a/invites')
        .set('Authorization', as('owner'))
        .send({ email: 'not-an-email' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/v1/tenants/tenant-a/invites')
        .set('Authorization', as('owner'))
        .send({ email: 'a@acme.com', role: 'root' })
        .expect(400);
    });

    it('lists pending invites of the tenant in the standard envelope, never with a token hash', async () => {
      prisma.staffInvite.findMany.mockResolvedValue([
        { id: 'inv-1', email: 'a@acme.com' },
      ]);
      prisma.staffInvite.count.mockResolvedValue(1);
      const res = await request(app.getHttpServer())
        .get('/v1/tenants/tenant-a/invites')
        .set('Authorization', as('admin'))
        .expect(200);
      expect(res.body).toEqual({
        data: [{ id: 'inv-1', email: 'a@acme.com' }],
        total: 1,
        skip: 0,
        take: 20,
      });
      expect(prisma.staffInvite.findMany.mock.calls[0][0]).toMatchObject({
        where: expect.objectContaining({ tenantId: 'tenant-a' }),
        omit: { tokenHash: true },
      });
    });

    it('revokes a pending invite and records invite.revoked with the request id', async () => {
      prisma.staffInvite.findFirst.mockResolvedValue({ role: 'agent' });
      prisma.staffInvite.update.mockResolvedValue({
        id: 'inv-1',
        email: 'a@acme.com',
        role: 'agent',
      });
      const res = await request(app.getHttpServer())
        .delete('/v1/tenants/tenant-a/invites/inv-1')
        .set('Authorization', as('admin'))
        .expect(200);

      expect(res.body.id).toBe('inv-1');
      expect(prisma.staffInvite.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'inv-1',
            tenantId: 'tenant-a',
          }),
        }),
      );
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-a',
        actorUserId: 'admin-1',
        actorRole: 'admin',
        action: 'invite.revoked',
        targetType: 'invite',
        targetId: 'inv-1',
        requestId: res.headers['x-request-id'],
      });
    });

    it('404 INVITE_NOT_FOUND when revoking an invite that is not pending in this tenant', async () => {
      prisma.staffInvite.findFirst.mockResolvedValue(null);
      const res = await request(app.getHttpServer())
        .delete('/v1/tenants/tenant-a/invites/someone-elses')
        .set('Authorization', as('admin'))
        .expect(404);
      expect(res.body.code).toBe('INVITE_NOT_FOUND');
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    describe('POST /v1/auth/invites/accept', () => {
      const invite = (over: Record<string, unknown> = {}) => ({
        id: 'inv-1',
        tenantId: 'tenant-a',
        email: 'new@acme.com',
        role: 'agent',
        acceptedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 3600_000),
        tenant: { status: 'active' },
        ...over,
      });

      it('is public: the invitee sets their own password, becomes verified and gets a working token', async () => {
        prisma.staffInvite.findUnique.mockResolvedValue(invite());
        prisma.staffInvite.updateMany.mockResolvedValue({ count: 1 });
        prisma.tenantUser.create.mockImplementation(
          ({ data: { passwordHash: _hash, ...data } }) =>
            Promise.resolve({ id: 'new-user', ...data }),
        );

        const res = await request(app.getHttpServer())
          .post('/v1/auth/invites/accept')
          .send({
            token: 'invite-token',
            password: 'my-own-password',
            name: 'Sana',
          })
          .expect(201);

        expect(prisma.staffInvite.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { tokenHash: hashToken('invite-token') },
          }),
        );
        expect(res.body.user).toMatchObject({
          id: 'new-user',
          tenantId: 'tenant-a',
          email: 'new@acme.com',
          role: 'agent',
          name: 'Sana',
        });
        expect(res.body.user).not.toHaveProperty('passwordHash');
        const created = prisma.tenantUser.create.mock.calls[0][0].data;
        expect(created.emailVerifiedAt).toBeInstanceOf(Date);
        expect(created.passwordHash).not.toBe('my-own-password');
        expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
          action: 'invite.accepted',
          tenantId: 'tenant-a',
          actorUserId: 'new-user',
        });
        expect(res.body.access_token).toEqual(expect.any(String));
      });

      it('400 INVITE_INVALID for an unknown, used, revoked or expired token', async () => {
        for (const found of [
          null,
          invite({ acceptedAt: new Date() }),
          invite({ revokedAt: new Date() }),
          invite({ expiresAt: new Date(Date.now() - 1000) }),
        ]) {
          prisma.staffInvite.findUnique.mockResolvedValue(found);
          const res = await request(app.getHttpServer())
            .post('/v1/auth/invites/accept')
            .send({ token: 't', password: 'my-own-password' })
            .expect(400);
          expect(res.body.code).toBe('INVITE_INVALID');
        }
        expect(prisma.tenantUser.create).not.toHaveBeenCalled();
      });

      it('validates the password (8 to 72 characters)', async () => {
        await request(app.getHttpServer())
          .post('/v1/auth/invites/accept')
          .send({ token: 't', password: 'short' })
          .expect(400);
        await request(app.getHttpServer())
          .post('/v1/auth/invites/accept')
          .send({ token: 't', password: 'x'.repeat(73) })
          .expect(400);
      });

      it('409 EMAIL_TAKEN when the address got an account meanwhile', async () => {
        prisma.staffInvite.findUnique.mockResolvedValue(invite());
        prisma.staffInvite.updateMany.mockResolvedValue({ count: 1 });
        prisma.tenantUser.create.mockRejectedValue(prismaError('P2002'));
        const res = await request(app.getHttpServer())
          .post('/v1/auth/invites/accept')
          .send({ token: 't', password: 'my-own-password' })
          .expect(409);
        expect(res.body.code).toBe('EMAIL_TAKEN');
      });
    });
  });

  describe('user changes take effect immediately (H2)', () => {
    const url = '/v1/tenants/tenant-a/users';

    it('a disabled user is refused on the next request with 401 ACCOUNT_DISABLED', async () => {
      const res = await request(app.getHttpServer())
        .get(url)
        .set('Authorization', as('agent', { status: 'disabled' }))
        .expect(401);
      expect(res.body.code).toBe('ACCOUNT_DISABLED');
      expect(prisma.tenantUser.findMany).not.toHaveBeenCalled();
    });

    it('a deleted user is refused with 401', async () => {
      const token = as('agent');
      prisma.tenantUser.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .get(url)
        .set('Authorization', token)
        .expect(401);
    });

    it('a token issued before the last password change is refused; one issued after is accepted', async () => {
      const changedAt = new Date();
      const second = Math.floor(changedAt.getTime() / 1000);
      prisma.tenantUser.findMany.mockResolvedValue([]);
      prisma.tenantUser.count.mockResolvedValue(0);

      const stale = `Bearer ${staffToken(
        { userId: 'agent-1', tenantId: 'tenant-a', role: 'agent' },
        { passwordChangedAt: changedAt },
        second - 60,
      )}`;
      await request(app.getHttpServer())
        .get(url)
        .set('Authorization', stale)
        .expect(401);

      const fresh = `Bearer ${staffToken(
        { userId: 'agent-1', tenantId: 'tenant-a', role: 'agent' },
        { passwordChangedAt: changedAt },
        second,
      )}`;
      await request(app.getHttpServer())
        .get(url)
        .set('Authorization', fresh)
        .expect(200);
    });

    it('a demoted user loses the powers of the role in their old token', async () => {
      // the token still says owner, the database already says agent
      const token = `Bearer ${staffToken(
        { userId: 'demoted-1', tenantId: 'tenant-a', role: 'owner' },
        { role: 'agent' },
      )}`;
      const res = await request(app.getHttpServer())
        .post('/v1/tenants/tenant-a/invites')
        .set('Authorization', token)
        .send({ email: 'x@acme.com' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('a role change is written to the audit log in the same transaction, with before and after', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u1',
        tenantId: 'tenant-a',
        email: 'u1@acme.com',
        role: 'agent',
        status: 'active',
      });
      prisma.tenantUser.update.mockResolvedValue({
        id: 'u1',
        tenantId: 'tenant-a',
        email: 'u1@acme.com',
        role: 'admin',
        status: 'active',
      });

      const res = await request(app.getHttpServer())
        .patch(`${url}/u1`)
        .set('Authorization', as('owner'))
        .send({ role: 'admin' })
        .expect(200);

      expect(res.body.role).toBe('admin');
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable',
      });
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-a',
        actorUserId: 'owner-1',
        actorRole: 'owner',
        action: 'user.role_changed',
        targetType: 'user',
        targetId: 'u1',
        before: { role: 'agent' },
        after: { role: 'admin' },
        requestId: res.headers['x-request-id'],
      });
    });

    it('disabling and deleting a user are audited too', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u1',
        tenantId: 'tenant-a',
        role: 'agent',
        status: 'active',
      });
      prisma.tenantUser.update.mockResolvedValue({
        id: 'u1',
        tenantId: 'tenant-a',
        role: 'agent',
        status: 'disabled',
      });
      await request(app.getHttpServer())
        .patch(`${url}/u1`)
        .set('Authorization', as('admin'))
        .send({ status: 'disabled' })
        .expect(200);

      prisma.tenantUser.delete.mockResolvedValue({
        id: 'u1',
        tenantId: 'tenant-a',
        role: 'agent',
        status: 'disabled',
      });
      await request(app.getHttpServer())
        .delete(`${url}/u1`)
        .set('Authorization', as('admin'))
        .expect(200);

      const actions = prisma.auditLog.create.mock.calls.map(
        ([arg]) => arg.data.action,
      );
      expect(actions).toEqual(['user.disabled', 'user.deleted']);
    });

    it("rejects a password or an unknown status in PATCH (no way to set another person's password)", async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u1',
        tenantId: 'tenant-a',
        role: 'agent',
        status: 'active',
      });
      prisma.tenantUser.update.mockResolvedValue({ id: 'u1' });
      await request(app.getHttpServer())
        .patch(`${url}/u1`)
        .set('Authorization', as('admin'))
        .send({ status: 'banned' })
        .expect(400);

      await request(app.getHttpServer())
        .patch(`${url}/u1`)
        .set('Authorization', as('admin'))
        .send({ password: 'hacked-password' })
        .expect(200);
      const data = prisma.tenantUser.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('passwordHash');
      expect(data).not.toHaveProperty('password');
    });
  });

  describe('password reset (H2)', () => {
    const body = { tenantSlug: 'Acme', email: 'Agent@Acme.com' };

    it('answers 202 for a known account and, with the same status, for an unknown one', async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 'tenant-a',
        status: 'active',
        defaultLocale: 'en',
      });
      prisma.tenantUser.findFirst.mockResolvedValueOnce({
        id: 'u1',
        status: 'active',
        locale: null,
      });
      const known = await request(app.getHttpServer())
        .post('/v1/auth/password-reset/request')
        .send({ ...body, email: 'known@acme.com' })
        .expect(202);
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-a', email: 'known@acme.com' },
        }),
      );
      // dev link mode only: the link of a real account
      expect(known.body.link).toContain('/reset-password?token=');
      expect(prisma.passwordReset.create).toHaveBeenCalledTimes(1);

      prisma.tenantUser.findFirst.mockResolvedValueOnce(null);
      const unknown = await request(app.getHttpServer())
        .post('/v1/auth/password-reset/request')
        .send({ ...body, email: 'nobody@acme.com' })
        .expect(202);
      expect(unknown.body).toEqual({});
      expect(prisma.passwordReset.create).toHaveBeenCalledTimes(1);
    });

    it('looks the tenant up by its lower-cased slug', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .post('/v1/auth/password-reset/request')
        .send({ ...body, email: 'slug-case@acme.com' })
        .expect(202);
      expect(prisma.tenant.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { slug: 'acme' } }),
      );
    });

    it('validates the request body', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/password-reset/request')
        .send({ tenantSlug: 'acme', email: 'nope' })
        .expect(400);
    });

    it('is throttled per IP with 429 TOO_MANY_REQUESTS', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await request(app.getHttpServer())
          .post('/v1/auth/password-reset/request')
          .set('X-Forwarded-For', `203.0.113.${i}`)
          .send({ tenantSlug: 'acme', email: `throttle${i}@acme.com` });
        statuses.push(res.status);
      }
      // All requests come from one address (a spoofed X-Forwarded-For is not trusted), so the
      // per-IP limit of 10 per hour trips; earlier tests in this file used part of the budget.
      expect(statuses).toContain(429);
      const limited = await request(app.getHttpServer())
        .post('/v1/auth/password-reset/request')
        .send({ tenantSlug: 'acme', email: 'one-more@acme.com' })
        .expect(429);
      expect(limited.body.code).toBe('TOO_MANY_REQUESTS');
    });

    describe('confirm', () => {
      const reset = (over: Record<string, unknown> = {}) => ({
        id: 'r1',
        userId: 'u1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: {
          id: 'u1',
          tenantId: 'tenant-a',
          role: 'agent',
          status: 'active',
        },
        ...over,
      });

      it('204 and sets password_changed_at, audits password.reset', async () => {
        prisma.passwordReset.findUnique.mockResolvedValue(reset());
        prisma.passwordReset.updateMany.mockResolvedValue({ count: 1 });
        await request(app.getHttpServer())
          .post('/v1/auth/password-reset/confirm')
          .send({ token: 'tok', password: 'a-brand-new-password' })
          .expect(204);
        expect(
          prisma.tenantUser.update.mock.calls[0][0].data.passwordChangedAt,
        ).toBeInstanceOf(Date);
        expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
          tenantId: 'tenant-a',
          action: 'password.reset',
          actorUserId: 'u1',
        });
      });

      it('400 RESET_TOKEN_INVALID for an unknown, used or expired token', async () => {
        for (const found of [
          null,
          reset({ usedAt: new Date() }),
          reset({ expiresAt: new Date(Date.now() - 1) }),
        ]) {
          prisma.passwordReset.findUnique.mockResolvedValue(found);
          const res = await request(app.getHttpServer())
            .post('/v1/auth/password-reset/confirm')
            .send({ token: 'tok', password: 'a-brand-new-password' })
            .expect(400);
          expect(res.body.code).toBe('RESET_TOKEN_INVALID');
        }
        expect(prisma.tenantUser.update).not.toHaveBeenCalled();
      });

      it('validates the new password', async () => {
        await request(app.getHttpServer())
          .post('/v1/auth/password-reset/confirm')
          .send({ token: 'tok', password: 'short' })
          .expect(400);
      });
    });
  });

  describe('email verification (H4)', () => {
    it('POST /v1/auth/verify-email is public and answers 204', async () => {
      prisma.emailVerification.findUnique.mockResolvedValue({
        id: 'v1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: { id: 'u1', tenantId: 'tenant-a' },
      });
      prisma.emailVerification.updateMany.mockResolvedValue({ count: 1 });
      await request(app.getHttpServer())
        .post('/v1/auth/verify-email')
        .send({ token: 'tok' })
        .expect(204);
      expect(prisma.tenantUser.update).toHaveBeenCalledWith({
        where: { id: 'u1', tenantId: 'tenant-a' },
        data: { emailVerifiedAt: expect.any(Date) },
      });
    });

    it('400 VERIFICATION_TOKEN_INVALID for an unknown token', async () => {
      prisma.emailVerification.findUnique.mockResolvedValue(null);
      const res = await request(app.getHttpServer())
        .post('/v1/auth/verify-email')
        .send({ token: 'tok' })
        .expect(400);
      expect(res.body.code).toBe('VERIFICATION_TOKEN_INVALID');
    });

    it('resend needs a signed-in user and returns 202 (link in link mode)', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/verify-email/resend')
        .expect(401);

      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'owner-1',
        email: 'owner@acme.com',
        locale: null,
        emailVerifiedAt: null,
        tenant: { defaultLocale: 'en' },
      });
      const res = await request(app.getHttpServer())
        .post('/v1/auth/verify-email/resend')
        .set('Authorization', as('owner', { emailVerified: false }))
        .expect(202);
      expect(res.body.link).toContain('/verify-email?token=');
    });
  });

  describe('audit log (H6)', () => {
    const url = '/v1/tenants/tenant-a/audit-logs';

    beforeEach(() => {
      prisma.auditLog.findMany.mockResolvedValue([
        { id: 'l1', action: 'user.deleted' },
      ]);
      prisma.auditLog.count.mockResolvedValue(1);
    });

    it('owners and admins read it in the standard envelope, scoped to their tenant', async () => {
      for (const role of ['owner', 'admin'] as const) {
        const res = await request(app.getHttpServer())
          .get(url)
          .set('Authorization', as(role))
          .expect(200);
        expect(res.body).toEqual({
          data: [{ id: 'l1', action: 'user.deleted' }],
          total: 1,
          skip: 0,
          take: 20,
        });
      }
      expect(prisma.auditLog.findMany.mock.calls[0][0].where).toEqual({
        tenantId: 'tenant-a',
      });
    });

    it('filters by actor, action, from and to', async () => {
      await request(app.getHttpServer())
        .get(
          `${url}?actor=u1&action=user.deleted&from=2026-10-01T00:00:00Z&to=2026-10-07T00:00:00Z&take=5`,
        )
        .set('Authorization', as('owner'))
        .expect(200);
      expect(prisma.auditLog.findMany.mock.calls[0][0]).toMatchObject({
        where: {
          tenantId: 'tenant-a',
          actorUserId: 'u1',
          action: 'user.deleted',
          createdAt: {
            gte: new Date('2026-10-01T00:00:00Z'),
            lte: new Date('2026-10-07T00:00:00Z'),
          },
        },
        take: 5,
      });
    });

    it('400 for an unparsable date and for take above 100', async () => {
      await request(app.getHttpServer())
        .get(`${url}?from=yesterday`)
        .set('Authorization', as('owner'))
        .expect(400);
      await request(app.getHttpServer())
        .get(`${url}?take=101`)
        .set('Authorization', as('owner'))
        .expect(400);
    });

    it('agents are refused (403 INSUFFICIENT_ROLE) and nothing is read', async () => {
      const res = await request(app.getHttpServer())
        .get(url)
        .set('Authorization', as('agent'))
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    it("a token of another tenant gets 403 TENANT_MISMATCH, never that tenant's entries", async () => {
      const res = await request(app.getHttpServer())
        .get(url)
        .set('Authorization', as('owner', {}, 'tenant-b'))
        .expect(403);
      expect(res.body.code).toBe('TENANT_MISMATCH');
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    it('401 without a token, and there is no write route', async () => {
      await request(app.getHttpServer()).get(url).expect(401);
      for (const method of ['post', 'patch', 'put', 'delete'] as const) {
        const res = await request(app.getHttpServer())
          [method](`${url}/l1`)
          .set('Authorization', as('owner'));
        expect(res.status).toBe(404);
      }
    });
  });

  describe('GET /v1/me', () => {
    const dbUser = {
      id: 'agent-1',
      email: 'agent@acme.com',
      name: 'Sana',
      role: 'agent',
      emailVerifiedAt: new Date('2026-10-01'),
      locale: null,
      tenant: {
        id: 'tenant-a',
        name: 'Acme',
        slug: 'acme',
        plan: 'pro',
        status: 'active',
        defaultLocale: 'ur',
      },
    };

    it('returns the profile, role, tenant and effective locale for any role', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(dbUser);
      for (const role of ['owner', 'admin', 'agent'] as const) {
        const res = await request(app.getHttpServer())
          .get('/v1/me')
          .set('Authorization', as(role))
          .expect(200);
        expect(res.body).toMatchObject({
          user: { email: 'agent@acme.com', emailVerified: true },
          tenant: { slug: 'acme', plan: 'pro', status: 'active' },
          locale: 'ur',
        });
        expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
      }
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'owner-1', tenantId: 'tenant-a' },
        }),
      );
    });

    it('401 without a token', async () => {
      await request(app.getHttpServer()).get('/v1/me').expect(401);
    });

    it('PATCH changes name and language; an unsupported language is a 400', async () => {
      prisma.tenantUser.update.mockResolvedValue({});
      prisma.tenantUser.findFirst.mockResolvedValue({
        ...dbUser,
        locale: 'en',
      });
      const res = await request(app.getHttpServer())
        .patch('/v1/me')
        .set('Authorization', as('agent'))
        .send({ locale: 'en', name: 'Sana M' })
        .expect(200);
      expect(res.body.locale).toBe('en');
      expect(prisma.tenantUser.update).toHaveBeenCalledWith({
        where: { id: 'agent-1', tenantId: 'tenant-a' },
        data: { name: 'Sana M', locale: 'en' },
      });
      await request(app.getHttpServer())
        .patch('/v1/me')
        .set('Authorization', as('agent'))
        .send({ locale: 'fr' })
        .expect(400);
    });
  });

  describe('i18n (H7)', () => {
    it('GET /v1/i18n/locales is public and lists en (ltr) and ur (rtl)', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/i18n/locales')
        .expect(200);
      expect(res.body).toEqual([
        { code: 'en', name: 'English', dir: 'ltr' },
        { code: 'ur', name: 'اردو', dir: 'rtl' },
      ]);
      expect(res.headers['cache-control']).toMatch(/public/);
    });

    it('serves a namespace without auth, with ETag and Cache-Control', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/i18n/ur/errors')
        .expect(200);
      expect(res.body.INVALID_CREDENTIALS).toEqual(expect.any(String));
      expect(res.body.INVALID_CREDENTIALS).not.toBe(
        (await request(app.getHttpServer()).get('/v1/i18n/en/errors')).body
          .INVALID_CREDENTIALS,
      );
      expect(res.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
      expect(res.headers['cache-control']).toMatch(/public, max-age=\d+/);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('answers 304 to a matching If-None-Match, and 200 to a stale one', async () => {
      const first = await request(app.getHttpServer()).get(
        '/v1/i18n/en/common',
      );
      const etag = first.headers.etag;
      const again = await request(app.getHttpServer())
        .get('/v1/i18n/en/common')
        .set('If-None-Match', etag)
        .expect(304);
      expect(again.text).toBe('');
      await request(app.getHttpServer())
        .get('/v1/i18n/en/common')
        .set('If-None-Match', '"stale"')
        .expect(200);
    });

    it('serves every namespace for every launch locale', async () => {
      for (const locale of ['en', 'ur']) {
        for (const ns of ['common', 'errors', 'notifications', 'widget']) {
          await request(app.getHttpServer())
            .get(`/v1/i18n/${locale}/${ns}`)
            .expect(200);
        }
      }
    });

    it('an error code the API returns can be translated: errors.<code> exists in ur', async () => {
      const login = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ tenantSlug: 'acme', email: 'a@b.co', password: 'x' });
      const { body: ur } = await request(app.getHttpServer()).get(
        '/v1/i18n/ur/errors',
      );
      expect(typeof ur[login.body.code]).toBe('string');
    });

    it('404 LOCALE_NOT_FOUND and NAMESPACE_NOT_FOUND', async () => {
      const locale = await request(app.getHttpServer())
        .get('/v1/i18n/fr/common')
        .expect(404);
      expect(locale.body.code).toBe('LOCALE_NOT_FOUND');
      const namespace = await request(app.getHttpServer())
        .get('/v1/i18n/en/secrets')
        .expect(404);
      expect(namespace.body.code).toBe('NAMESPACE_NOT_FOUND');
    });
  });

  describe('OpenAPI', () => {
    it('documents the Phase 1 routes', async () => {
      const res = await request(app.getHttpServer())
        .get('/docs-json')
        .expect(200);
      const paths = Object.keys(res.body.paths);
      for (const path of [
        '/v1/tenants/{tenantId}/invites',
        '/v1/tenants/{tenantId}/invites/{id}',
        '/v1/auth/invites/accept',
        '/v1/auth/password-reset/request',
        '/v1/auth/password-reset/confirm',
        '/v1/auth/verify-email',
        '/v1/auth/verify-email/resend',
        '/v1/tenants/{tenantId}/audit-logs',
        '/v1/i18n/locales',
        '/v1/i18n/{locale}/{namespace}',
        '/v1/me',
      ]) {
        expect(paths).toContain(path);
      }
      expect(res.body.paths['/v1/tenants/{tenantId}/users']).not.toHaveProperty(
        'post',
      );
    });
  });
});
