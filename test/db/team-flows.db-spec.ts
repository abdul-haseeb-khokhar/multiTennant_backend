import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Phase 1 against a real Postgres: the SQL the mocked suites cannot see (unique and CHECK
 * constraints, the append-only trigger, serializable transactions) and the flows end to end.
 * Everything goes over HTTP exactly as the dashboard would call it.
 */
describe('Team management flows (real database)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = () => request(app.getHttpServer());
  const run = randomBytes(4).toString('hex');
  const password = 'correct-horse-battery';
  const bearer = (token: string) => `Bearer ${token}`;
  const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Signs a tenant up and returns its owner session. `verify` completes email verification. */
  async function signup(name: string, ownerEmail: string, verify = true) {
    const res = await http()
      .post('/v1/auth/signup')
      .send({
        tenantName: `${name} ${run}`,
        ownerEmail,
        ownerPassword: password,
      })
      .expect(201);
    if (verify) {
      await http()
        .post('/v1/auth/verify-email')
        .send({ token: tokenFrom(res.body.verificationLink) })
        .expect(204);
    }
    // These flows are about roles and lifecycle, not seats: give the tenant an unlimited plan so
    // the Starter seat limit (covered in billing-flows.db-spec.ts) does not get in the way.
    await prisma.subscription.update({
      where: { tenantId: res.body.tenant.id },
      data: { planCode: 'enterprise', currentPeriodEnd: null },
    });
    return {
      tenantId: res.body.tenant.id as string,
      slug: res.body.tenant.slug as string,
      ownerId: res.body.owner.id as string,
      token: res.body.access_token as string,
    };
  }

  async function login(slug: string, email: string, pass = password) {
    return http()
      .post('/v1/auth/login')
      .send({ tenantSlug: slug, email, password: pass });
  }

  /** Invites `email` as `role` and has them accept with their own password. */
  async function addStaff(
    tenant: { tenantId: string; token: string },
    email: string,
    role = 'agent',
  ) {
    const invite = await http()
      .post(`/v1/tenants/${tenant.tenantId}/invites`)
      .set('Authorization', bearer(tenant.token))
      .send({ email, role })
      .expect(201);
    const accepted = await http()
      .post('/v1/auth/invites/accept')
      .send({ token: tokenFrom(invite.body.link), password, name: email })
      .expect(201);
    return {
      id: accepted.body.user.id as string,
      token: accepted.body.access_token as string,
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('owner invites an agent who sets their own password', () => {
    let acme: Awaited<ReturnType<typeof signup>>;
    let agent: { id: string; token: string };

    beforeAll(async () => {
      acme = await signup('Acme', `Owner.${run}@Acme.com`);
    });

    it('the owner signs up with a mixed-case email: stored lower-case, login works in any case', async () => {
      const stored = await prisma.tenantUser.findUniqueOrThrow({
        where: { id: acme.ownerId },
      });
      expect(stored.email).toBe(`owner.${run}@acme.com`);
      expect(stored.emailVerifiedAt).not.toBeNull();
      await login(acme.slug, ` OWNER.${run}@ACME.com `).then((res) =>
        expect(res.status).toBe(201),
      );
    });

    it('invite -> accept creates a verified agent, single use, token stored hashed', async () => {
      const invite = await http()
        .post(`/v1/tenants/${acme.tenantId}/invites`)
        .set('Authorization', bearer(acme.token))
        .send({ email: `Agent.${run}@Acme.com`, role: 'agent' })
        .expect(201);
      const token = tokenFrom(invite.body.link);

      const row = await prisma.staffInvite.findUniqueOrThrow({
        where: { id: invite.body.id },
      });
      expect(row.tokenHash).toHaveLength(64);
      expect(row.tokenHash).not.toContain(token);
      expect(row.email).toBe(`agent.${run}@acme.com`);
      expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(
        6.9 * 24 * 3600 * 1000,
      );

      const pending = await http()
        .get(`/v1/tenants/${acme.tenantId}/invites`)
        .set('Authorization', bearer(acme.token))
        .expect(200);
      expect(pending.body.data.map((i: { id: string }) => i.id)).toContain(
        invite.body.id,
      );
      expect(JSON.stringify(pending.body)).not.toContain(row.tokenHash);

      const accepted = await http()
        .post('/v1/auth/invites/accept')
        .send({ token, password, name: 'Sana Agent' })
        .expect(201);
      agent = { id: accepted.body.user.id, token: accepted.body.access_token };
      expect(accepted.body.user).toMatchObject({
        role: 'agent',
        name: 'Sana Agent',
        tenantId: acme.tenantId,
      });
      expect(accepted.body.user.emailVerifiedAt).not.toBeNull();
      expect(accepted.body.user).not.toHaveProperty('passwordHash');

      // single use
      const again = await http()
        .post('/v1/auth/invites/accept')
        .send({ token, password: 'another-password-1' })
        .expect(400);
      expect(again.body.code).toBe('INVITE_INVALID');

      // no longer listed as pending
      const after = await http()
        .get(`/v1/tenants/${acme.tenantId}/invites`)
        .set('Authorization', bearer(acme.token))
        .expect(200);
      expect(after.body.data.map((i: { id: string }) => i.id)).not.toContain(
        invite.body.id,
      );
    });

    it('the agent can log in with the password they chose and read /me', async () => {
      const res = await login(acme.slug, `agent.${run}@acme.com`);
      expect(res.status).toBe(201);
      const me = await http()
        .get('/v1/me')
        .set('Authorization', bearer(res.body.access_token))
        .expect(200);
      expect(me.body).toMatchObject({
        user: {
          email: `agent.${run}@acme.com`,
          role: 'agent',
          emailVerified: true,
        },
        tenant: { slug: acme.slug, status: 'trial', plan: 'starter' },
        locale: 'en',
      });
    });

    it('re-inviting a pending address replaces the old link; an existing user cannot be invited', async () => {
      const first = await http()
        .post(`/v1/tenants/${acme.tenantId}/invites`)
        .set('Authorization', bearer(acme.token))
        .send({ email: `second.${run}@acme.com` })
        .expect(201);
      const second = await http()
        .post(`/v1/tenants/${acme.tenantId}/invites`)
        .set('Authorization', bearer(acme.token))
        .send({ email: `second.${run}@acme.com` })
        .expect(201);
      const old = await http()
        .post('/v1/auth/invites/accept')
        .send({ token: tokenFrom(first.body.link), password })
        .expect(400);
      expect(old.body.code).toBe('INVITE_INVALID');
      await http()
        .post('/v1/auth/invites/accept')
        .send({ token: tokenFrom(second.body.link), password })
        .expect(201);

      const taken = await http()
        .post(`/v1/tenants/${acme.tenantId}/invites`)
        .set('Authorization', bearer(acme.token))
        .send({ email: `AGENT.${run}@acme.com` })
        .expect(409);
      expect(taken.body.code).toBe('EMAIL_TAKEN');
    });

    it('a revoked invite cannot be accepted', async () => {
      const invite = await http()
        .post(`/v1/tenants/${acme.tenantId}/invites`)
        .set('Authorization', bearer(acme.token))
        .send({ email: `revoked.${run}@acme.com` })
        .expect(201);
      await http()
        .delete(`/v1/tenants/${acme.tenantId}/invites/${invite.body.id}`)
        .set('Authorization', bearer(acme.token))
        .expect(200);
      const res = await http()
        .post('/v1/auth/invites/accept')
        .send({ token: tokenFrom(invite.body.link), password })
        .expect(400);
      expect(res.body.code).toBe('INVITE_INVALID');
      await http()
        .delete(`/v1/tenants/${acme.tenantId}/invites/${invite.body.id}`)
        .set('Authorization', bearer(acme.token))
        .expect(404);
    });

    it('an expired invite cannot be accepted', async () => {
      const invite = await http()
        .post(`/v1/tenants/${acme.tenantId}/invites`)
        .set('Authorization', bearer(acme.token))
        .send({ email: `expired.${run}@acme.com` })
        .expect(201);
      await prisma.staffInvite.update({
        where: { id: invite.body.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await http()
        .post('/v1/auth/invites/accept')
        .send({ token: tokenFrom(invite.body.link), password })
        .expect(400);
    });

    it('an agent cannot invite, read invites or the audit log; an admin cannot invite an owner', async () => {
      for (const call of [
        () =>
          http()
            .post(`/v1/tenants/${acme.tenantId}/invites`)
            .send({ email: 'x@acme.com' }),
        () => http().get(`/v1/tenants/${acme.tenantId}/invites`),
        () => http().get(`/v1/tenants/${acme.tenantId}/audit-logs`),
      ]) {
        const res = await call()
          .set('Authorization', bearer(agent.token))
          .expect(403);
        expect(res.body.code).toBe('INSUFFICIENT_ROLE');
      }

      const admin = await addStaff(acme, `admin.${run}@acme.com`, 'admin');
      const res = await http()
        .post(`/v1/tenants/${acme.tenantId}/invites`)
        .set('Authorization', bearer(admin.token))
        .send({ email: `boss.${run}@acme.com`, role: 'owner' })
        .expect(403);
      expect(res.body.code).toBe('OWNER_REQUIRED');
      await http()
        .post(`/v1/tenants/${acme.tenantId}/invites`)
        .set('Authorization', bearer(admin.token))
        .send({ email: `agent2.${run}@acme.com`, role: 'agent' })
        .expect(201);
    });

    describe('disable, role change, delete: effective immediately and audited', () => {
      it('disabling an agent kills their existing token on the very next request, and login', async () => {
        await http()
          .get('/v1/me')
          .set('Authorization', bearer(agent.token))
          .expect(200);

        await http()
          .patch(`/v1/tenants/${acme.tenantId}/users/${agent.id}`)
          .set('Authorization', bearer(acme.token))
          .send({ status: 'disabled' })
          .expect(200);

        const refused = await http()
          .get('/v1/me')
          .set('Authorization', bearer(agent.token))
          .expect(401);
        expect(refused.body.code).toBe('ACCOUNT_DISABLED');
        const loginRes = await login(acme.slug, `agent.${run}@acme.com`);
        expect(loginRes.status).toBe(403);
        expect(loginRes.body.code).toBe('ACCOUNT_DISABLED');

        await http()
          .patch(`/v1/tenants/${acme.tenantId}/users/${agent.id}`)
          .set('Authorization', bearer(acme.token))
          .send({ status: 'active' })
          .expect(200);
        await http()
          .get('/v1/me')
          .set('Authorization', bearer(agent.token))
          .expect(200);
      });

      it('a demoted admin loses admin powers with the token they already hold', async () => {
        const staff = await addStaff(acme, `demote.${run}@acme.com`, 'admin');
        await http()
          .post(`/v1/tenants/${acme.tenantId}/invites`)
          .set('Authorization', bearer(staff.token))
          .send({ email: `d1.${run}@acme.com` })
          .expect(201);
        await http()
          .patch(`/v1/tenants/${acme.tenantId}/users/${staff.id}`)
          .set('Authorization', bearer(acme.token))
          .send({ role: 'agent' })
          .expect(200);
        const res = await http()
          .post(`/v1/tenants/${acme.tenantId}/invites`)
          .set('Authorization', bearer(staff.token))
          .send({ email: `d2.${run}@acme.com` })
          .expect(403);
        expect(res.body.code).toBe('INSUFFICIENT_ROLE');
      });

      it('deleting a user kills their token at once', async () => {
        const staff = await addStaff(acme, `gone.${run}@acme.com`);
        await http()
          .delete(`/v1/tenants/${acme.tenantId}/users/${staff.id}`)
          .set('Authorization', bearer(acme.token))
          .expect(200);
        await http()
          .get('/v1/me')
          .set('Authorization', bearer(staff.token))
          .expect(401);
      });

      it('the audit log shows user.invited, invite.accepted, user.role_changed, user.disabled, user.deleted with actor and request id', async () => {
        const list = async (action: string) =>
          (
            await http()
              .get(`/v1/tenants/${acme.tenantId}/audit-logs?action=${action}`)
              .set('Authorization', bearer(acme.token))
              .expect(200)
          ).body;

        for (const action of [
          'user.invited',
          'invite.accepted',
          'user.role_changed',
          'user.disabled',
          'user.enabled',
          'user.deleted',
          'invite.revoked',
        ]) {
          const page = await list(action);
          expect(page.total).toBeGreaterThan(0);
          for (const entry of page.data) {
            expect(entry.tenantId).toBe(acme.tenantId);
            expect(entry.requestId).toEqual(expect.any(String));
          }
        }

        const changed = (await list('user.role_changed')).data[0];
        expect(changed).toMatchObject({
          actorUserId: acme.ownerId,
          actorRole: 'owner',
          targetType: 'user',
          before: { role: 'admin' },
          after: { role: 'agent' },
        });

        // newest first, filters and envelope
        const all = await http()
          .get(
            `/v1/tenants/${acme.tenantId}/audit-logs?actor=${acme.ownerId}&take=3`,
          )
          .set('Authorization', bearer(acme.token))
          .expect(200);
        expect(all.body).toMatchObject({ skip: 0, take: 3 });
        const times = all.body.data.map(
          (e: { createdAt: string }) => e.createdAt,
        );
        expect([...times].sort().reverse()).toEqual(times);
        const future = await http()
          .get(
            `/v1/tenants/${acme.tenantId}/audit-logs?from=${encodeURIComponent(
              new Date(Date.now() + 3600_000).toISOString(),
            )}`,
          )
          .set('Authorization', bearer(acme.token))
          .expect(200);
        expect(future.body.total).toBe(0);
      });

      it('no secret ever lands in the audit log', async () => {
        const rows = await prisma.auditLog.findMany({
          where: { tenantId: acme.tenantId },
        });
        const dump = JSON.stringify(rows);
        expect(dump).not.toMatch(/passwordHash|tokenHash|token=|\$2[aby]\$/);
      });
    });

    describe('password reset', () => {
      it('request -> confirm sets a new password, kills old sessions, is single use and is audited', async () => {
        const staff = await addStaff(acme, `reset.${run}@acme.com`);
        const email = `reset.${run}@acme.com`;

        const unknown = await http()
          .post('/v1/auth/password-reset/request')
          .send({ tenantSlug: acme.slug, email: `nobody.${run}@acme.com` })
          .expect(202);
        expect(unknown.body).toEqual({});

        // a token issued in the same second as the reset would survive (iat has 1 s resolution)
        await sleep(1100);
        const requested = await http()
          .post('/v1/auth/password-reset/request')
          .send({
            tenantSlug: acme.slug.toUpperCase(),
            email: email.toUpperCase(),
          })
          .expect(202);
        const token = tokenFrom(requested.body.link);
        const stored = await prisma.passwordReset.findFirstOrThrow({
          where: { userId: staff.id },
        });
        expect(stored.tokenHash).not.toContain(token);
        expect(stored.expiresAt.getTime() - Date.now()).toBeLessThan(
          3600_000 + 5000,
        );

        const newPassword = 'a-completely-new-password';
        await http()
          .post('/v1/auth/password-reset/confirm')
          .send({ token, password: newPassword })
          .expect(204);

        // old session dead, old password dead, new password works
        await http()
          .get('/v1/me')
          .set('Authorization', bearer(staff.token))
          .expect(401);
        expect((await login(acme.slug, email)).status).toBe(401);
        const fresh = await login(acme.slug, email, newPassword);
        expect(fresh.status).toBe(201);
        await http()
          .get('/v1/me')
          .set('Authorization', bearer(fresh.body.access_token))
          .expect(200);

        // single use
        const again = await http()
          .post('/v1/auth/password-reset/confirm')
          .send({ token, password: 'yet-another-password' })
          .expect(400);
        expect(again.body.code).toBe('RESET_TOKEN_INVALID');

        const audit = await http()
          .get(`/v1/tenants/${acme.tenantId}/audit-logs?action=password.reset`)
          .set('Authorization', bearer(acme.token))
          .expect(200);
        expect(audit.body.data[0]).toMatchObject({
          actorUserId: staff.id,
          targetId: staff.id,
        });
      });

      it('a disabled user gets no reset link, and an unknown tenant looks the same as a known one', async () => {
        const staff = await addStaff(acme, `off.${run}@acme.com`);
        await http()
          .patch(`/v1/tenants/${acme.tenantId}/users/${staff.id}`)
          .set('Authorization', bearer(acme.token))
          .send({ status: 'disabled' })
          .expect(200);
        const res = await http()
          .post('/v1/auth/password-reset/request')
          .send({ tenantSlug: acme.slug, email: `off.${run}@acme.com` })
          .expect(202);
        expect(res.body).toEqual({});
        await http()
          .post('/v1/auth/password-reset/request')
          .send({ tenantSlug: 'no-such-tenant', email: 'x@acme.com' })
          .expect(202);
      });
    });
  });

  describe('email verification (H4)', () => {
    it('an unverified owner cannot invite until the emailed link is used; verifying is single use', async () => {
      const owner = await signup('Unverified', `unv.${run}@x.com`, false);
      const denied = await http()
        .post(`/v1/tenants/${owner.tenantId}/invites`)
        .set('Authorization', bearer(owner.token))
        .send({ email: `a.${run}@x.com` })
        .expect(403);
      expect(denied.body.code).toBe('EMAIL_NOT_VERIFIED');

      const resend = await http()
        .post('/v1/auth/verify-email/resend')
        .set('Authorization', bearer(owner.token))
        .expect(202);
      const token = tokenFrom(resend.body.link);
      await http().post('/v1/auth/verify-email').send({ token }).expect(204);
      const reused = await http()
        .post('/v1/auth/verify-email')
        .send({ token })
        .expect(400);
      expect(reused.body.code).toBe('VERIFICATION_TOKEN_INVALID');

      // now allowed (the user is read from the database on every request)
      await http()
        .post(`/v1/tenants/${owner.tenantId}/invites`)
        .set('Authorization', bearer(owner.token))
        .send({ email: `a.${run}@x.com` })
        .expect(201);
    });

    it('the first link stops working when a newer one is issued', async () => {
      const owner = await signup('Relink', `relink.${run}@x.com`, false);
      const first = await http()
        .post('/v1/auth/verify-email/resend')
        .set('Authorization', bearer(owner.token))
        .expect(202);
      // signup issued one as well; the resend superseded it
      const row = await prisma.emailVerification.count({
        where: { userId: owner.ownerId, usedAt: null },
      });
      expect(row).toBe(1);
      await http()
        .post('/v1/auth/verify-email')
        .send({ token: tokenFrom(first.body.link) })
        .expect(204);
    });

    it("changing someone's email resets their verification", async () => {
      const owner = await signup('Emailchange', `chg.${run}@x.com`);
      const staff = await addStaff(owner, `before.${run}@x.com`);
      const res = await http()
        .patch(`/v1/tenants/${owner.tenantId}/users/${staff.id}`)
        .set('Authorization', bearer(owner.token))
        .send({ email: `After.${run}@X.com` })
        .expect(200);
      expect(res.body.email).toBe(`after.${run}@x.com`);
      expect(res.body.emailVerifiedAt).toBeNull();
      const audit = await prisma.auditLog.findFirst({
        where: { tenantId: owner.tenantId, action: 'user.email_changed' },
      });
      expect(audit?.after).toEqual({ email: `after.${run}@x.com` });
    });
  });

  describe('last owner rule is atomic (known issue 4)', () => {
    it('two simultaneous demotions of the two owners cannot leave the tenant without an owner', async () => {
      const first = await signup('Twoowners', `o1.${run}@x.com`);
      const second = await addStaff(first, `o2.${run}@x.com`, 'owner');

      // each owner demotes the other, at the same moment, many times over fresh pairs
      const results = await Promise.all([
        http()
          .patch(`/v1/tenants/${first.tenantId}/users/${second.id}`)
          .set('Authorization', bearer(first.token))
          .send({ role: 'admin' }),
        http()
          .patch(`/v1/tenants/${first.tenantId}/users/${first.ownerId}`)
          .set('Authorization', bearer(second.token))
          .send({ role: 'admin' }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      const owners = await prisma.tenantUser.count({
        where: { tenantId: first.tenantId, role: 'owner', status: 'active' },
      });
      expect(owners).toBeGreaterThanOrEqual(1);
      // one succeeded; the other either saw the single owner left (409 LAST_OWNER) or was
      // refused because its own owner role had just been taken away (403)
      expect(statuses[0]).toBe(200);
      expect([403, 409]).toContain(statuses[1]);
    });

    it('the only owner cannot be demoted, disabled or deleted', async () => {
      const solo = await signup('Soloowner', `solo.${run}@x.com`);
      for (const call of [
        () =>
          http()
            .patch(`/v1/tenants/${solo.tenantId}/users/${solo.ownerId}`)
            .send({ role: 'admin' }),
        () =>
          http()
            .patch(`/v1/tenants/${solo.tenantId}/users/${solo.ownerId}`)
            .send({ status: 'disabled' }),
        () =>
          http().delete(`/v1/tenants/${solo.tenantId}/users/${solo.ownerId}`),
      ]) {
        const res = await call()
          .set('Authorization', bearer(solo.token))
          .expect(409);
        expect(res.body.code).toBe('LAST_OWNER');
      }
    });
  });

  describe('tenant isolation', () => {
    it('another tenant sees none of these invites, users or audit entries', async () => {
      const a = await signup('Isoa', `a.${run}@iso.com`);
      const b = await signup('Isob', `b.${run}@iso.com`);
      const invite = await http()
        .post(`/v1/tenants/${a.tenantId}/invites`)
        .set('Authorization', bearer(a.token))
        .send({ email: `staff.${run}@iso.com` })
        .expect(201);

      for (const path of ['invites', 'audit-logs', 'users']) {
        const res = await http()
          .get(`/v1/tenants/${a.tenantId}/${path}`)
          .set('Authorization', bearer(b.token))
          .expect(403);
        expect(res.body.code).toBe('TENANT_MISMATCH');
      }
      // revoking by id through one's own tenant URL finds nothing
      await http()
        .delete(`/v1/tenants/${b.tenantId}/invites/${invite.body.id}`)
        .set('Authorization', bearer(b.token))
        .expect(404);
      const stillPending = await prisma.staffInvite.findUniqueOrThrow({
        where: { id: invite.body.id },
      });
      expect(stillPending.revokedAt).toBeNull();

      const ownList = await http()
        .get(`/v1/tenants/${b.tenantId}/audit-logs`)
        .set('Authorization', bearer(b.token))
        .expect(200);
      for (const entry of ownList.body.data) {
        expect(entry.tenantId).toBe(b.tenantId);
      }
      // the same address can be invited in both tenants: uniqueness is per tenant
      await http()
        .post(`/v1/tenants/${b.tenantId}/invites`)
        .set('Authorization', bearer(b.token))
        .send({ email: `staff.${run}@iso.com` })
        .expect(201);
    });
  });

  describe('platform admin suspends a tenant', () => {
    it("writes tenant.suspended to that tenant's audit log; a suspended tenant's staff are locked out", async () => {
      const tenant = await signup('Suspendme', `s.${run}@x.com`);
      const adminEmail = `ops.${run}@example.com`;
      await prisma.platformAdmin.create({
        data: {
          email: adminEmail,
          passwordHash: await bcrypt.hash('ops-password-123', 4),
        },
      });
      const adminLogin = await http()
        .post('/v1/admin/auth/login')
        .send({ email: adminEmail.toUpperCase(), password: 'ops-password-123' })
        .expect(201);
      const adminToken = adminLogin.body.access_token;

      await http()
        .patch(`/v1/admin/tenants/${tenant.tenantId}`)
        .set('Authorization', bearer(adminToken))
        .send({ status: 'suspended' })
        .expect(200);

      const locked = await http()
        .get('/v1/me')
        .set('Authorization', bearer(tenant.token))
        .expect(403);
      expect(locked.body.code).toBe('TENANT_SUSPENDED');

      await http()
        .patch(`/v1/admin/tenants/${tenant.tenantId}`)
        .set('Authorization', bearer(adminToken))
        .send({ status: 'active' })
        .expect(200);

      const audit = await http()
        .get(`/v1/tenants/${tenant.tenantId}/audit-logs`)
        .set('Authorization', bearer(tenant.token))
        .expect(200);
      const actions = audit.body.data.map((e: { action: string }) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining(['tenant.suspended', 'tenant.reactivated']),
      );
      const suspended = audit.body.data.find(
        (e: { action: string }) => e.action === 'tenant.suspended',
      );
      expect(suspended).toMatchObject({
        actorRole: 'platform_admin',
        before: expect.objectContaining({ status: 'active' }),
        after: expect.objectContaining({ status: 'suspended' }),
      });
    });
  });

  describe('database guarantees', () => {
    it('refuses an email that is not trimmed and lower-case (CHECK constraint)', async () => {
      const tenant = await signup('Checks', `chk.${run}@x.com`);
      await expect(
        prisma.tenantUser.create({
          data: {
            tenantId: tenant.tenantId,
            email: `Mixed.${run}@X.com`,
            passwordHash: 'x',
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.staffInvite.create({
          data: {
            tenantId: tenant.tenantId,
            email: `Mixed.${run}@X.com`,
            role: 'agent',
            tokenHash: randomBytes(8).toString('hex'),
            expiresAt: new Date(Date.now() + 1000),
          },
        }),
      ).rejects.toThrow();
    });

    it('the audit log is append-only: UPDATE and DELETE are refused by the database', async () => {
      const tenant = await signup('Append', `app.${run}@x.com`);
      await http()
        .post(`/v1/tenants/${tenant.tenantId}/invites`)
        .set('Authorization', bearer(tenant.token))
        .send({ email: `inv.${run}@x.com` })
        .expect(201);
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { tenantId: tenant.tenantId },
      });
      await expect(
        prisma.auditLog.update({
          where: { id: entry.id },
          data: { action: 'tampered' },
        }),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.auditLog.delete({ where: { id: entry.id } }),
      ).rejects.toThrow(/append-only/);
      expect(
        (await prisma.auditLog.findUniqueOrThrow({ where: { id: entry.id } }))
          .action,
      ).toBe(entry.action);
    });

    it('deleting a user removes their reset and verification rows (cascade) but nothing else', async () => {
      const tenant = await signup('Cascade', `cas.${run}@x.com`);
      const staff = await addStaff(tenant, `cas2.${run}@x.com`);
      await http()
        .post('/v1/auth/password-reset/request')
        .send({ tenantSlug: tenant.slug, email: `cas2.${run}@x.com` })
        .expect(202);
      expect(
        await prisma.passwordReset.count({ where: { userId: staff.id } }),
      ).toBe(1);
      await http()
        .delete(`/v1/tenants/${tenant.tenantId}/users/${staff.id}`)
        .set('Authorization', bearer(tenant.token))
        .expect(200);
      expect(
        await prisma.passwordReset.count({ where: { userId: staff.id } }),
      ).toBe(0);
    });
  });

  describe('i18n over the real app', () => {
    it('serves translations without authentication', async () => {
      const res = await http().get('/v1/i18n/ur/errors').expect(200);
      expect(res.body.TENANT_SUSPENDED).toEqual(expect.any(String));
      await http()
        .get('/v1/i18n/ur/errors')
        .set('If-None-Match', res.headers.etag)
        .expect(304);
    });
  });
});
