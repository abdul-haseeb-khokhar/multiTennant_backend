import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Phase 3C (J1 logout, J2 email-first login, J3 slug rename, J4 self-protection, J5 upgrade
 * requests, J7 time zone) against a real Postgres: the SQL the mocked suites cannot see (the
 * partial unique index, CHECK constraints, advisory-lock serialisation, millisecond timestamps)
 * and the flows end to end over HTTP.
 */
describe('Account decisions (real database, Phase 3C)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = () => request(app.getHttpServer());
  const run = randomBytes(4).toString('hex');
  const password = 'correct-horse-battery';
  const otherPassword = 'another-horse-staple-1';
  const bearer = (token: string) => `Bearer ${token}`;
  const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const DAY = 86_400_000;

  async function signup(name: string, ownerEmail: string, slug?: string) {
    const res = await http()
      .post('/v1/auth/signup')
      .send({
        tenantName: `${name} ${run}`,
        ownerEmail,
        ownerPassword: password,
        ...(slug && { tenantSlug: slug }),
      })
      .expect(201);
    await http()
      .post('/v1/auth/verify-email')
      .send({ token: tokenFrom(res.body.verificationLink) })
      .expect(204);
    // Roles and requests are the subject here, not seats: an unlimited plan keeps Starter's limit out of the way.
    await prisma.subscription.update({
      where: { tenantId: res.body.tenant.id },
      data: { planCode: 'enterprise', currentPeriodEnd: null },
    });
    return {
      tenantId: res.body.tenant.id as string,
      slug: res.body.tenant.slug as string,
      ownerId: res.body.owner.id as string,
      email: ownerEmail,
      token: res.body.access_token as string,
    };
  }

  const login = (slug: string, email: string, pass = password) =>
    http()
      .post('/v1/auth/login')
      .send({ tenantSlug: slug, email, password: pass });
  const loginEmail = (email: string, pass = password) =>
    http().post('/v1/auth/login-email').send({ email, password: pass });
  const settings = (t: { tenantId: string; token: string }) =>
    http()
      .get(`/v1/tenants/${t.tenantId}`)
      .set('Authorization', bearer(t.token));
  const rename = (t: { tenantId: string; token: string }, slug: string) =>
    http()
      .patch(`/v1/tenants/${t.tenantId}`)
      .set('Authorization', bearer(t.token))
      .send({ slug });

  async function platformAdminToken() {
    const email = `ops.${randomBytes(3).toString('hex')}.${run}@example.com`;
    await prisma.platformAdmin.create({
      data: { email, passwordHash: await bcrypt.hash('ops-password-123', 4) },
    });
    const res = await http()
      .post('/v1/admin/auth/login')
      .send({ email, password: 'ops-password-123' })
      .expect(201);
    return res.body.access_token as string;
  }

  /** Invites `email` into `tenant` and has them accept with their own password. */
  async function joinWith(
    tenant: { tenantId: string; token: string },
    email: string,
    pass: string,
    role = 'agent',
  ) {
    const invite = await http()
      .post(`/v1/tenants/${tenant.tenantId}/invites`)
      .set('Authorization', bearer(tenant.token))
      .send({ email, role })
      .expect(201);
    const accepted = await http()
      .post('/v1/auth/invites/accept')
      .send({ token: tokenFrom(invite.body.link), password: pass })
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
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------------------------

  describe('J1: logout ends every session of the user', () => {
    it('stamps tokens_valid_after in the database, kills ALL earlier tokens, audits it, and a login in the same second works', async () => {
      const acme = await signup('Logout', `lo.${run}@x.com`);
      const laptop = acme.token;
      const phone = (await login(acme.slug, acme.email).expect(201)).body
        .access_token as string;
      await settings({ ...acme, token: laptop }).expect(200);
      await settings({ ...acme, token: phone }).expect(200);

      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer(laptop))
        .expect(204);

      const stored = await prisma.tenantUser.findUniqueOrThrow({
        where: { id: acme.ownerId },
        select: { tokensValidAfter: true },
      });
      expect(stored.tokensValidAfter).toBeInstanceOf(Date);
      await settings({ ...acme, token: laptop }).expect(401);
      await settings({ ...acme, token: phone }).expect(401);

      // right away, in the same second: bcrypt and the round trip are slower than a millisecond
      const fresh = await login(acme.slug, acme.email).expect(201);
      await settings({ ...acme, token: fresh.body.access_token }).expect(200);

      const entries = await prisma.auditLog.findMany({
        where: { tenantId: acme.tenantId, action: 'auth.logout' },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actorUserId: acme.ownerId,
        targetId: acme.ownerId,
        actorRole: 'owner',
      });
    });

    it('does not touch other users or other tenants', async () => {
      const a = await signup('LogoutA', `la.${run}@x.com`);
      const b = await signup('LogoutB', `lb.${run}@x.com`);
      const colleague = await joinWith(a, `col.${run}@x.com`, password);
      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer(a.token))
        .expect(204);
      await settings({ ...a, token: colleague.token }).expect(200);
      await settings(b).expect(200);
    });

    it('works for a platform admin, and only for that admin', async () => {
      const first = await platformAdminToken();
      const second = await platformAdminToken();
      await http()
        .post('/v1/admin/auth/logout')
        .set('Authorization', bearer(first))
        .expect(204);
      await http()
        .get('/v1/admin/tenants')
        .set('Authorization', bearer(first))
        .expect(401);
      await http()
        .get('/v1/admin/tenants')
        .set('Authorization', bearer(second))
        .expect(200);
    });

    it('works for a suspended workspace (so old tokens do not revive on reactivation)', async () => {
      const t = await signup('LogoutFrozen', `lf.${run}@x.com`);
      const admin = await platformAdminToken();
      await http()
        .post(`/v1/admin/tenants/${t.tenantId}/subscription/suspend`)
        .set('Authorization', bearer(admin))
        .send({})
        .expect(200);
      await settings(t).expect(403);
      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer(t.token))
        .expect(204);
      await http()
        .post(`/v1/admin/tenants/${t.tenantId}/subscription/unsuspend`)
        .set('Authorization', bearer(admin))
        .send({})
        .expect(200);
      await settings(t).expect(401);
    });
  });

  // ---------------------------------------------------------------------------------------

  describe('J3 and J7: the owner edits the workspace, renames the slug; time zone', () => {
    it('a new workspace has the Asia/Karachi time zone (the column default), every role reads it, only the owner changes it', async () => {
      const t = await signup('Zone', `zone.${run}@x.com`);
      const agent = await joinWith(t, `zone.agent.${run}@x.com`, password);

      const read = await settings(t).expect(200);
      expect(read.body).toMatchObject({
        id: t.tenantId,
        slug: t.slug,
        timezone: 'Asia/Karachi',
        defaultLocale: 'en',
        slugChangedAt: null,
        slugChangeAllowedAt: null,
        previousSlugs: [],
      });
      await settings({ ...t, token: agent.token }).expect(200);

      await http()
        .patch(`/v1/tenants/${t.tenantId}`)
        .set('Authorization', bearer(agent.token))
        .send({ timezone: 'Europe/London' })
        .expect(403);
      const changed = await http()
        .patch(`/v1/tenants/${t.tenantId}`)
        .set('Authorization', bearer(t.token))
        .send({
          timezone: 'europe/london',
          name: 'Zone Ltd',
          defaultLocale: 'ur',
        })
        .expect(200);
      expect(changed.body).toMatchObject({
        timezone: 'Europe/London',
        name: 'Zone Ltd',
        defaultLocale: 'ur',
      });
      const me = await http()
        .get('/v1/me')
        .set('Authorization', bearer(t.token))
        .expect(200);
      expect(me.body.tenant).toMatchObject({
        slug: t.slug,
        timezone: 'Europe/London',
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { tenantId: t.tenantId, action: 'tenant.updated' },
      });
      expect(audit.before).toMatchObject({ timezone: 'Asia/Karachi' });
      expect(audit.after).toMatchObject({ timezone: 'Europe/London' });
      await http()
        .patch(`/v1/tenants/${t.tenantId}`)
        .set('Authorization', bearer(t.token))
        .send({ timezone: 'Mars/Base' })
        .expect(400);
    });

    it('the whole slug life: rename, old slug logs in for 30 days and is reserved for 90, once per 30 days, audited', async () => {
      const old = `ren-${run}`;
      const t = await signup('Rename', `ren.${run}@x.com`, old);
      const next = `renamed-${run}`;

      const res = await rename(t, next).expect(200);
      expect(res.body.slug).toBe(next);
      expect(res.body.previousSlugs).toHaveLength(1);

      // the alias row: accepted for 30 days, reserved for 90
      const alias = await prisma.tenantSlugAlias.findUniqueOrThrow({
        where: { slug: old },
      });
      expect(alias.tenantId).toBe(t.tenantId);
      expect(
        (alias.acceptedUntil.getTime() - Date.now()) / DAY,
      ).toBeGreaterThan(29.9);
      expect((alias.acceptedUntil.getTime() - Date.now()) / DAY).toBeLessThan(
        30.1,
      );
      expect(
        (alias.reservedUntil.getTime() - Date.now()) / DAY,
      ).toBeGreaterThan(89.9);
      expect((alias.reservedUntil.getTime() - Date.now()) / DAY).toBeLessThan(
        90.1,
      );

      // both slugs log in, and into the same workspace
      for (const slug of [next, old]) {
        const ok = await login(slug, t.email).expect(201);
        await settings({ ...t, token: ok.body.access_token }).expect(200);
      }
      await http()
        .post('/v1/auth/password-reset/request')
        .send({ tenantSlug: old, email: t.email })
        .expect(202);

      // taken for everybody else: signup, the availability check, another workspace's rename
      const signupAttempt = await http()
        .post('/v1/auth/signup')
        .send({
          tenantName: `Squatter ${run}`,
          ownerEmail: `sq.${run}@x.com`,
          ownerPassword: password,
          tenantSlug: old,
        })
        .expect(409);
      expect(signupAttempt.body.code).toBe('SLUG_TAKEN');
      expect(signupAttempt.body.suggestions.length).toBeGreaterThan(0);
      const probe = await http()
        .get('/v1/auth/slug-available')
        .query({ slug: old })
        .expect(200);
      expect(probe.body.available).toBe(false);
      const other = await signup('RenameOther', `reno.${run}@x.com`);
      const stolen = await rename(other, old).expect(409);
      expect(stolen.body.code).toBe('SLUG_TAKEN');

      // once per 30 days
      const tooSoon = await rename(t, `again-${run}`).expect(409);
      expect(tooSoon.body.code).toBe('SLUG_CHANGE_TOO_SOON');
      expect(
        new Date(tooSoon.body.nextAllowedAt).getTime() - Date.now(),
      ).toBeGreaterThan(29.9 * DAY);

      // audited, with the slugs only (no secrets)
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { tenantId: t.tenantId, action: 'tenant.slug_changed' },
      });
      expect(entry.before).toEqual({ slug: old });
      expect(entry.after).toEqual({ slug: next });

      // day 31: the old slug no longer logs in, but is still reserved; the owner may rename again
      await prisma.tenant.update({
        where: { id: t.tenantId },
        data: { slugChangedAt: new Date(Date.now() - 31 * DAY) },
      });
      await prisma.tenantSlugAlias.update({
        where: { slug: old },
        data: { acceptedUntil: new Date(Date.now() - DAY) },
      });
      const gone = await login(old, t.email).expect(401);
      expect(gone.body.code).toBe('INVALID_CREDENTIALS');
      await login(next, t.email).expect(201);
      expect(
        (await http().get('/v1/auth/slug-available').query({ slug: old })).body
          .available,
      ).toBe(false);

      // day 91: free for anyone
      await prisma.tenantSlugAlias.update({
        where: { slug: old },
        data: { reservedUntil: new Date(Date.now() - DAY) },
      });
      expect(
        (await http().get('/v1/auth/slug-available').query({ slug: old })).body
          .available,
      ).toBe(true);
      await rename(other, old).expect(200);
    });

    it('the owner takes an old slug of their own back: the alias goes away', async () => {
      const old = `back-${run}`;
      const t = await signup('Back', `back.${run}@x.com`, old);
      await rename(t, `forth-${run}`).expect(200);
      await prisma.tenant.update({
        where: { id: t.tenantId },
        data: { slugChangedAt: new Date(Date.now() - 31 * DAY) },
      });
      await rename(t, old).expect(200);
      expect(
        await prisma.tenantSlugAlias.findUnique({ where: { slug: old } }),
      ).toBeNull();
      expect(
        await prisma.tenantSlugAlias.findUnique({
          where: { slug: `forth-${run}` },
        }),
      ).not.toBeNull();
    });

    it('two workspaces renaming to the same free slug at the same moment: exactly one wins', async () => {
      const a = await signup('RaceA', `ra.${run}@x.com`);
      const b = await signup('RaceB', `rb.${run}@x.com`);
      const wanted = `race-${run}`;
      const results = await Promise.all([rename(a, wanted), rename(b, wanted)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const holders = await prisma.tenant.count({ where: { slug: wanted } });
      expect(holders).toBe(1);
    });

    it('a rename racing a signup for the same slug: one of them gets it, never both', async () => {
      const a = await signup('RaceC', `rc.${run}@x.com`);
      const wanted = `race-signup-${run}`;
      const results = await Promise.all([
        rename(a, wanted),
        http()
          .post('/v1/auth/signup')
          .send({
            tenantName: `RaceD ${run}`,
            ownerEmail: `rd.${run}@x.com`,
            ownerPassword: password,
            tenantSlug: wanted,
          }),
      ]);
      const wins = results.filter((r) => r.status === 200 || r.status === 201);
      expect(wins).toHaveLength(1);
      expect(await prisma.tenant.count({ where: { slug: wanted } })).toBe(1);
    });

    it('a slug given up while another signup takes the old one at the same moment cannot end up with two owners', async () => {
      const old = `swap-${run}`;
      const t = await signup('Swap', `swap.${run}@x.com`, old);
      const results = await Promise.all([
        rename(t, `swapped-${run}`),
        http()
          .post('/v1/auth/signup')
          .send({
            tenantName: `Swap2 ${run}`,
            ownerEmail: `swap2.${run}@x.com`,
            ownerPassword: password,
            tenantSlug: old,
          }),
      ]);
      // the signup either fails (the slug was still held, or already reserved) or comes first
      // and then the rename is refused; whatever the order, the slug has one owner
      expect(
        await prisma.tenant.count({ where: { slug: old } }),
      ).toBeLessThanOrEqual(1);
      const reservedFor = await prisma.tenantSlugAlias.count({
        where: { slug: old },
      });
      const heldNow = await prisma.tenant.count({ where: { slug: old } });
      expect(heldNow + reservedFor).toBe(1);
      expect(results.some((r) => r.status >= 500)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------------------

  describe('J4: nobody disables, demotes or deletes themselves', () => {
    it('refused for owner and admin, on real rows; colleagues can still be changed', async () => {
      const t = await signup('Self', `self.${run}@x.com`);
      const second = await joinWith(t, `self2.${run}@x.com`, password, 'owner');
      const admin = await joinWith(
        t,
        `selfadmin.${run}@x.com`,
        password,
        'admin',
      );

      for (const [id, token, body] of [
        [t.ownerId, t.token, { status: 'disabled' }],
        [t.ownerId, t.token, { role: 'admin' }],
        [admin.id, admin.token, { role: 'agent' }],
        [admin.id, admin.token, { status: 'disabled' }],
      ] as const) {
        const res = await http()
          .patch(`/v1/tenants/${t.tenantId}/users/${id}`)
          .set('Authorization', bearer(token))
          .send(body)
          .expect(403);
        expect(res.body.code).toBe('CANNOT_MODIFY_SELF');
      }
      for (const [id, token] of [
        [t.ownerId, t.token],
        [admin.id, admin.token],
      ] as const) {
        const res = await http()
          .delete(`/v1/tenants/${t.tenantId}/users/${id}`)
          .set('Authorization', bearer(token))
          .expect(403);
        expect(res.body.code).toBe('CANNOT_MODIFY_SELF');
      }
      expect(
        await prisma.tenantUser.count({
          where: { tenantId: t.tenantId, status: 'active' },
        }),
      ).toBe(3);

      // a second owner can demote the first: not "themselves"
      await http()
        .patch(`/v1/tenants/${t.tenantId}/users/${t.ownerId}`)
        .set('Authorization', bearer(second.token))
        .send({ role: 'admin' })
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------------------------

  describe('J5: upgrade requests', () => {
    it('ask, replace, handle: one pending row per workspace, enforced by the database too', async () => {
      const t = await signup('Upgrade', `up.${run}@x.com`);
      await prisma.subscription.update({
        where: { tenantId: t.tenantId },
        data: {
          planCode: 'starter',
          currentPeriodEnd: new Date(Date.now() + 10 * DAY),
        },
      });
      const admin = await platformAdminToken();

      const first = await http()
        .post(`/v1/tenants/${t.tenantId}/billing/upgrade-request`)
        .set('Authorization', bearer(t.token))
        .send({ planCode: 'pro', note: 'we need more' })
        .expect(201);
      expect(first.body).toMatchObject({
        status: 'pending',
        replacedPending: false,
        // the test mailer is the console one: nothing is sent, and the answer says so
        notification: 'skipped',
      });

      const second = await http()
        .post(`/v1/tenants/${t.tenantId}/billing/upgrade-request`)
        .set('Authorization', bearer(t.token))
        .send({ planCode: 'enterprise' })
        .expect(201);
      expect(second.body).toMatchObject({
        id: first.body.id,
        requestedPlanCode: 'enterprise',
        replacedPending: true,
      });
      expect(
        await prisma.upgradeRequest.count({
          where: { tenantId: t.tenantId, status: 'pending' },
        }),
      ).toBe(1);

      // the partial unique index and the CHECK constraint, directly
      await expect(
        prisma.upgradeRequest.create({
          data: {
            tenantId: t.tenantId,
            requestedPlanCode: 'pro',
            requestedBy: t.ownerId,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        prisma.$executeRaw`UPDATE tenant_core.upgrade_requests SET status = 'bogus' WHERE id = ${first.body.id}`,
      ).rejects.toThrow();
      await expect(
        prisma.upgradeRequest.create({
          data: {
            tenantId: t.tenantId,
            requestedPlanCode: 'no-such-plan',
            requestedBy: t.ownerId,
            status: 'handled',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });

      // the platform side
      const list = await http()
        .get('/v1/admin/upgrade-requests?status=pending')
        .set('Authorization', bearer(admin))
        .expect(200);
      const mine = list.body.data.find(
        (r: { id: string }) => r.id === first.body.id,
      );
      expect(mine).toMatchObject({
        tenant: { id: t.tenantId, slug: t.slug },
        currentPlanCode: 'starter',
        requestedPlanCode: 'enterprise',
        requestedByEmail: t.email,
      });

      const handled = await http()
        .post(`/v1/admin/upgrade-requests/${first.body.id}/handle`)
        .set('Authorization', bearer(admin))
        .send({ status: 'handled', note: 'activated Enterprise' })
        .expect(200);
      expect(handled.body).toMatchObject({
        status: 'handled',
        handledNote: 'activated Enterprise',
      });
      const again = await http()
        .post(`/v1/admin/upgrade-requests/${first.body.id}/handle`)
        .set('Authorization', bearer(admin))
        .send({ status: 'declined' })
        .expect(409);
      expect(again.body.code).toBe('UPGRADE_REQUEST_ALREADY_HANDLED');

      // the handling is in THAT tenant's audit log, by the platform admin
      const audit = await http()
        .get(`/v1/tenants/${t.tenantId}/audit-logs?action=upgrade.handled`)
        .set('Authorization', bearer(t.token))
        .expect(200);
      expect(audit.body.data[0]).toMatchObject({
        actorRole: 'platform_admin',
        targetId: first.body.id,
      });

      // after it was handled the owner can ask again: a new pending row
      const third = await http()
        .post(`/v1/tenants/${t.tenantId}/billing/upgrade-request`)
        .set('Authorization', bearer(t.token))
        .send({ planCode: 'pro' })
        .expect(201);
      expect(third.body.id).not.toBe(first.body.id);
      expect(third.body.replacedPending).toBe(false);
      const latest = await http()
        .get(`/v1/tenants/${t.tenantId}/billing/upgrade-request`)
        .set('Authorization', bearer(t.token))
        .expect(200);
      expect(latest.body.request.id).toBe(third.body.id);
    });

    it("refuses what it should: another tenant, an agent, a hidden plan, the current plan; one tenant never sees another's requests", async () => {
      const a = await signup('UpA', `upa.${run}@x.com`);
      const b = await signup('UpB', `upb.${run}@x.com`);
      const agent = await joinWith(a, `upa.agent.${run}@x.com`, password);
      await http()
        .post(`/v1/tenants/${a.tenantId}/billing/upgrade-request`)
        .set('Authorization', bearer(agent.token))
        .send({ planCode: 'pro' })
        .expect(403);
      await http()
        .post(`/v1/tenants/${a.tenantId}/billing/upgrade-request`)
        .set('Authorization', bearer(b.token))
        .send({ planCode: 'pro' })
        .expect(403);
      const hidden = await http()
        .post(`/v1/tenants/${a.tenantId}/billing/upgrade-request`)
        .set('Authorization', bearer(a.token))
        .send({ planCode: 'starter' })
        .expect(404);
      expect(hidden.body.code).toBe('PLAN_NOT_FOUND');
      const same = await http()
        .post(`/v1/tenants/${a.tenantId}/billing/upgrade-request`)
        .set('Authorization', bearer(a.token))
        .send({ planCode: 'enterprise' })
        .expect(409);
      expect(same.body.code).toBe('ALREADY_ON_PLAN');

      await http()
        .post(`/v1/tenants/${a.tenantId}/billing/upgrade-request`)
        .set('Authorization', bearer(a.token))
        .send({ planCode: 'pro' })
        .expect(201);
      const bView = await http()
        .get(`/v1/tenants/${b.tenantId}/billing/upgrade-request`)
        .set('Authorization', bearer(b.token))
        .expect(200);
      expect(bView.body).toEqual({ request: null });
      await http()
        .get('/v1/admin/upgrade-requests')
        .set('Authorization', bearer(a.token))
        .expect(401);
    });

    it('PATCH /v1/admin/tenants/:id no longer takes plan or status', async () => {
      const t = await signup('PatchGone', `pg.${run}@x.com`);
      const admin = await platformAdminToken();
      const res = await http()
        .patch(`/v1/admin/tenants/${t.tenantId}`)
        .set('Authorization', bearer(admin))
        .send({ plan: 'free' })
        .expect(400);
      expect(res.body.code).toBe('USE_SUBSCRIPTION_ROUTES');
      const row = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: t.tenantId },
      });
      expect(row.planCode).toBe('enterprise');
    });
  });

  // ---------------------------------------------------------------------------------------

  describe('J2: email-first login, picker, reset by email', () => {
    it('the whole journey for a person with two workspaces and two passwords', async () => {
      const person = `person.${run}@x.com`;
      const acme = await signup('Pick Acme', person);
      const beta = await signup('Pick Beta', `beta.owner.${run}@x.com`);
      const joined = await joinWith(beta, person, otherPassword, 'admin');
      expect(joined.id).toBeDefined();

      // password one: only Acme matches, and it is the single way in
      const one = await loginEmail(person).expect(201);
      expect(one.body.workspaces).toHaveLength(1);
      expect(one.body).toMatchObject({
        unmatchedCount: 1,
        workspace: { slug: acme.slug },
      });
      await settings({ ...acme, token: one.body.access_token }).expect(200);
      expect(JSON.stringify(one.body)).not.toContain(beta.slug);

      // password two: only Beta
      const two = await loginEmail(person, otherPassword).expect(201);
      expect(two.body.workspaces.map((w: { slug: string }) => w.slug)).toEqual([
        beta.slug,
      ]);

      // one reset by email: ONE link, both memberships get the same new password
      const ask = await http()
        .post('/v1/auth/password-reset/request')
        .send({ email: person })
        .expect(202);
      expect(
        await prisma.passwordReset.count({ where: { email: person } }),
      ).toBe(1);
      await sleep(5);
      const newPassword = 'a-brand-new-password-9';
      await http()
        .post('/v1/auth/password-reset/confirm')
        .send({ token: tokenFrom(ask.body.link), password: newPassword })
        .expect(204);

      const rows = await prisma.tenantUser.findMany({
        where: { email: person },
      });
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.passwordHash)).size).toBe(1);
      expect(await bcrypt.compare(newPassword, rows[0].passwordHash)).toBe(
        true,
      );
      // their sessions ended
      await settings({ ...acme, token: one.body.access_token }).expect(401);
      await settings({ ...beta, token: joined.token }).expect(401);
      // and others were not touched
      expect(
        await bcrypt.compare(
          password,
          (
            await prisma.tenantUser.findUniqueOrThrow({
              where: { id: beta.ownerId },
            })
          ).passwordHash,
        ),
      ).toBe(true);

      const both = await loginEmail(person, newPassword).expect(201);
      expect(both.body.unmatchedCount).toBe(0);
      expect(
        both.body.workspaces.map((w: { slug: string }) => w.slug).sort(),
      ).toEqual([acme.slug, beta.slug].sort());
      expect(both.body).not.toHaveProperty('access_token');

      // pick one; switch to the other with the same token
      const inAcme = await http()
        .post('/v1/auth/select-workspace')
        .send({
          selectionToken: both.body.selectionToken,
          tenantId: acme.tenantId,
        })
        .expect(201);
      await settings({ ...acme, token: inAcme.body.access_token }).expect(200);
      const inBeta = await http()
        .post('/v1/auth/select-workspace')
        .send({
          selectionToken: both.body.selectionToken,
          tenantId: beta.tenantId,
        })
        .expect(201);
      await settings({ ...beta, token: inBeta.body.access_token }).expect(200);
      expect(inBeta.body.workspace.role).toBe('admin');

      // a workspace of someone else cannot be opened with this token
      const outsider = await signup('Pick Outsider', `outsider.${run}@x.com`);
      const denied = await http()
        .post('/v1/auth/select-workspace')
        .send({
          selectionToken: both.body.selectionToken,
          tenantId: outsider.tenantId,
        })
        .expect(403);
      expect(denied.body.code).toBe('WORKSPACE_NOT_SELECTABLE');

      // a logout in Acme ends the picker's proof for Acme only
      await sleep(5);
      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer(inAcme.body.access_token))
        .expect(204);
      const stale = await http()
        .post('/v1/auth/select-workspace')
        .send({
          selectionToken: both.body.selectionToken,
          tenantId: acme.tenantId,
        })
        .expect(401);
      expect(stale.body.code).toBe('SELECTION_TOKEN_INVALID');
      await http()
        .post('/v1/auth/select-workspace')
        .send({
          selectionToken: both.body.selectionToken,
          tenantId: beta.tenantId,
        })
        .expect(201);
    });

    it('a suspended workspace is listed with its reason, and selecting it gives the same error as the slug login', async () => {
      const person = `frozen.${run}@x.com`;
      const live = await signup('Live Co', person);
      const frozen = await signup('Frozen Co', `frozen.owner.${run}@x.com`);
      await joinWith(frozen, person, password, 'agent');
      const admin = await platformAdminToken();
      await http()
        .post(`/v1/admin/tenants/${frozen.tenantId}/subscription/suspend`)
        .set('Authorization', bearer(admin))
        .send({})
        .expect(200);

      const res = await loginEmail(person).expect(201);
      expect(res.body.workspaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug: live.slug, available: true }),
          expect.objectContaining({
            slug: frozen.slug,
            available: false,
            reason: 'TENANT_SUSPENDED',
          }),
        ]),
      );
      // one available among the two: the access token comes along
      expect(res.body.workspace.slug).toBe(live.slug);
      const picked = await http()
        .post('/v1/auth/select-workspace')
        .send({
          selectionToken: res.body.selectionToken,
          tenantId: frozen.tenantId,
        })
        .expect(403);
      expect(picked.body.code).toBe('TENANT_SUSPENDED');
      const slugLogin = await login(frozen.slug, person).expect(403);
      expect(slugLogin.body.code).toBe('TENANT_SUSPENDED');
    });

    it('wrong password and unknown email are one 401; the limiter blocks the sixth wrong password with Retry-After and a right one clears the count', async () => {
      const person = `throttle.${run}@x.com`;
      await signup('Throttle', person);
      const unknown = await loginEmail(
        `ghost.${run}@x.com`,
        'whatever-password',
      ).expect(401);
      const wrong = await loginEmail(person, 'wrong-password-1').expect(401);
      expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
      expect(wrong.body.message).toBe(unknown.body.message);

      for (let i = 0; i < 3; i++) {
        await loginEmail(person, 'wrong-password-2').expect(401);
      }
      // 4 wrong so far (one above + 3), a correct login clears them
      await loginEmail(person).expect(201);
      for (let i = 0; i < 5; i++) {
        await loginEmail(person, 'wrong-password-3').expect(401);
      }
      const blocked = await loginEmail(person).expect(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.body.code).toBe('TOO_MANY_REQUESTS');
    });

    it('ten parallel selections of the same token all work and the database stays consistent', async () => {
      const person = `par.${run}@x.com`;
      const t = await signup('Parallel', person);
      const res = await loginEmail(person).expect(201);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          http().post('/v1/auth/select-workspace').send({
            selectionToken: res.body.selectionToken,
            tenantId: t.tenantId,
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    });

    it('the reset link of one workspace (slug flow) changes only that workspace', async () => {
      const person = `single.${run}@x.com`;
      const a = await signup('Single A', person);
      const b = await signup('Single B', `single.b.${run}@x.com`);
      await joinWith(b, person, password, 'agent');
      const ask = await http()
        .post('/v1/auth/password-reset/request')
        .send({ tenantSlug: a.slug, email: person })
        .expect(202);
      await http()
        .post('/v1/auth/password-reset/confirm')
        .send({ token: tokenFrom(ask.body.link), password: 'only-for-a-1234' })
        .expect(204);
      await login(a.slug, person, 'only-for-a-1234').expect(201);
      await login(b.slug, person, password).expect(201);
    });

    it('slug-available needs no login, is exact about format and says nothing else', async () => {
      const t = await signup('Probe', `probe.${run}@x.com`);
      const taken = await http()
        .get('/v1/auth/slug-available')
        .query({ slug: t.slug })
        .expect(200);
      expect(taken.body.available).toBe(false);
      expect(taken.body.suggestions.length).toBeGreaterThan(0);
      expect(Object.keys(taken.body).sort()).toEqual([
        'available',
        'suggestions',
      ]);
      const free = await http()
        .get('/v1/auth/slug-available')
        .query({ slug: `free-${run}` })
        .expect(200);
      expect(free.body).toEqual({ available: true, suggestions: [] });
      const bad = await http()
        .get('/v1/auth/slug-available')
        .query({ slug: 'admin' })
        .expect(200);
      expect(bad.body.available).toBe(false);
    });
  });
});
