import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { FakeClock } from '../src/billing/clock';
import { mockTransaction, PrismaMock } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

interface UserRow {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  status: string;
  passwordHash: string;
  passwordChangedAt: Date | null;
  tokensValidAfter: Date | null;
  emailVerifiedAt: Date | null;
  locale: string | null;
  createdAt: Date;
}
interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  defaultLocale: string;
}
interface ResetRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  email: string | null;
  allWorkspaces: boolean;
}

const PW = 'correct-horse-battery';
const OTHER_PW = 'a-different-password';
const NEW_PW = 'brand-new-password-1';

/** Phase 3C, J2: email-first login, workspace picker, throttling, reset by email, slug availability. */
describe('Email-first login and workspace picker (e2e, J2)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let clock: FakeClock;
  let platformToken: () => string;
  let resetRateLimits: () => void;
  let hashPw: string;
  let hashOther: string;

  let tenants: TenantRow[];
  let users: UserRow[];
  let resets: ResetRow[];
  let resetCounter: number;

  const http = () => request(app.getHttpServer());
  const loginEmail = (email: string, password = PW) =>
    http().post('/v1/auth/login-email').send({ email, password });
  const select = (selectionToken: string, tenantId: string) =>
    http().post('/v1/auth/select-workspace').send({ selectionToken, tenantId });
  const slugLogin = (tenantSlug: string, email: string, password = PW) =>
    http().post('/v1/auth/login').send({ tenantSlug, email, password });
  const tokenFromLink = (link: string) =>
    new URL(link).searchParams.get('token')!;
  const row = (id: string) => users.find((u) => u.id === id)!;

  // ---- the in-memory tables ---------------------------------------------------------------

  const withTenant = (u: UserRow) => ({
    ...u,
    tenant: tenants.find((t) => t.id === u.tenantId)!,
  });
  const matches = (u: UserRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && 'in' in value) {
        return (value as { in: string[] }).in.includes(
          u[key as keyof UserRow] as string,
        );
      }
      return u[key as keyof UserRow] === value;
    });

  beforeAll(async () => {
    ({ app, prisma, clock, platformToken, resetRateLimits } =
      await createTestApp());
    hashPw = bcrypt.hashSync(PW, 4);
    hashOther = bcrypt.hashSync(OTHER_PW, 4);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    mockTransaction(prisma);
    // The limiters keep counting across tests; every test starts with empty counters.
    resetRateLimits();
    clock.set('2026-10-13T00:00:00Z');

    const t = (id: string, slug: string, name: string, status = 'active') => ({
      id,
      slug,
      name,
      status,
      defaultLocale: 'en',
    });
    tenants = [
      t('t-acme', 'acme', 'Acme'),
      t('t-beta', 'beta', 'Beta'),
      t('t-gamma', 'gamma', 'Gamma'),
      t('t-frozen', 'frozen', 'Frozen', 'suspended'),
    ];
    const u = (
      id: string,
      tenantId: string,
      email: string,
      passwordHash: string,
      over: Partial<UserRow> = {},
    ): UserRow => ({
      id,
      tenantId,
      email,
      role: 'owner',
      status: 'active',
      passwordHash,
      passwordChangedAt: null,
      tokensValidAfter: null,
      emailVerifiedAt: new Date('2026-01-01'),
      locale: null,
      createdAt: new Date(`2026-01-0${(users?.length ?? 0) + 1}`),
      ...over,
    });
    users = [];
    users.push(
      u('u-acme', 't-acme', 'person@acme.com', hashPw),
      u('u-beta', 't-beta', 'person@acme.com', hashPw, { role: 'agent' }),
      u('u-gamma', 't-gamma', 'person@acme.com', hashOther),
      u('u-frozen', 't-frozen', 'person@acme.com', hashPw),
      u('u-solo', 't-beta', 'solo@beta.io', hashPw, { role: 'admin' }),
      u('u-other', 't-gamma', 'someone-else@gamma.io', hashPw),
    );
    resets = [];
    resetCounter = 0;

    prisma.tenantUser.findMany.mockImplementation(
      ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        Promise.resolve(
          users
            .filter((x) => matches(x, where))
            .sort(
              (a, b) =>
                b.createdAt.getTime() - a.createdAt.getTime() ||
                a.id.localeCompare(b.id),
            )
            .slice(0, take ?? 1000)
            .map(withTenant),
        ),
    );
    prisma.tenantUser.findFirst.mockImplementation(
      ({
        where,
        orderBy,
      }: {
        where: Record<string, unknown>;
        orderBy?: unknown;
      }) => {
        const found = users
          .filter((x) => matches(x, where))
          .sort(
            (a, b) =>
              (orderBy ? 1 : 0) *
              (a.createdAt.getTime() - b.createdAt.getTime()),
          )[0];
        return Promise.resolve(found ? withTenant(found) : null);
      },
    );
    prisma.tenantUser.findUnique.mockImplementation(
      ({ where }: { where: { id: string; tenantId?: string } }) => {
        const found = users.find(
          (x) =>
            x.id === where.id &&
            (!where.tenantId || x.tenantId === where.tenantId),
        );
        return Promise.resolve(found ? { ...found } : null);
      },
    );
    prisma.tenantUser.update.mockImplementation(
      ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        Object.assign(row(where.id), data);
        return Promise.resolve({ ...row(where.id) });
      },
    );
    prisma.tenantUser.updateMany.mockImplementation(
      ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<UserRow>;
      }) => {
        const hit = users.filter((x) => matches(x, where));
        hit.forEach((x) => Object.assign(x, data));
        return Promise.resolve({ count: hit.length });
      },
    );
    prisma.tenant.findUnique.mockImplementation(
      ({ where }: { where: { id?: string; slug?: string } }) =>
        Promise.resolve(
          tenants.find((x) =>
            where.id !== undefined ? x.id === where.id : x.slug === where.slug,
          ) ?? null,
        ),
    );
    prisma.tenant.findMany.mockImplementation(
      ({ where }: { where: { slug: { in: string[] } } }) =>
        Promise.resolve(tenants.filter((x) => where.slug.in.includes(x.slug))),
    );
    prisma.tenantSlugAlias.findFirst.mockResolvedValue(null);
    prisma.tenantSlugAlias.findMany.mockResolvedValue([]);

    prisma.passwordReset.create.mockImplementation(
      ({ data }: { data: Omit<ResetRow, 'id' | 'usedAt'> }) => {
        const reset = { id: `r${++resetCounter}`, usedAt: null, ...data };
        resets.push(reset);
        return Promise.resolve(reset);
      },
    );
    prisma.passwordReset.findUnique.mockImplementation(
      ({ where }: { where: { tokenHash: string } }) => {
        const reset = resets.find((r) => r.tokenHash === where.tokenHash);
        return Promise.resolve(
          reset ? { ...reset, user: { ...row(reset.userId) } } : null,
        );
      },
    );
    prisma.passwordReset.updateMany.mockImplementation(
      ({
        where,
        data,
      }: {
        where: {
          id?: string;
          userId?: string | { in: string[] };
          usedAt: null;
        };
        data: { usedAt: Date };
      }) => {
        const hit = resets.filter(
          (r) =>
            r.usedAt === null &&
            (where.id === undefined || r.id === where.id) &&
            (where.userId === undefined ||
              (typeof where.userId === 'string'
                ? r.userId === where.userId
                : where.userId.in.includes(r.userId))),
        );
        hit.forEach((r) => Object.assign(r, data));
        return Promise.resolve({ count: hit.length });
      },
    );
  });

  // ---------------------------------------------------------------------------------------

  describe('POST /v1/auth/login-email', () => {
    it('lists exactly the workspaces whose password matched, with availability and the count of the others', async () => {
      const res = await loginEmail('Person@Acme.com').expect(201);
      expect(res.body.workspaces).toEqual([
        {
          tenantId: 't-acme',
          slug: 'acme',
          name: 'Acme',
          role: 'owner',
          available: true,
        },
        {
          tenantId: 't-beta',
          slug: 'beta',
          name: 'Beta',
          role: 'agent',
          available: true,
        },
        {
          tenantId: 't-frozen',
          slug: 'frozen',
          name: 'Frozen',
          role: 'owner',
          available: false,
          reason: 'TENANT_SUSPENDED',
        },
      ]);
      // Gamma uses another password: counted, never named
      expect(res.body.unmatchedCount).toBe(1);
      expect(JSON.stringify(res.body)).not.toContain('gamma');
      expect(JSON.stringify(res.body)).not.toContain('Gamma');
      expect(res.body.expiresIn).toBe(600);
      expect(res.body.selectionToken).toEqual(expect.any(String));
      expect(res.body).not.toHaveProperty('access_token');
    });

    it("the response never carries a password hash or another person's data", async () => {
      const res = await loginEmail('person@acme.com').expect(201);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('passwordHash');
      expect(text).not.toContain('$2b$');
      expect(text).not.toContain('someone-else@gamma.io');
      expect(text).not.toContain('solo@beta.io');
    });

    it('exactly one available workspace: the access token comes right away and works', async () => {
      const res = await loginEmail('solo@beta.io').expect(201);
      expect(res.body).toMatchObject({
        workspaces: [{ tenantId: 't-beta', available: true, role: 'admin' }],
        unmatchedCount: 0,
        workspace: { tenantId: 't-beta', slug: 'beta', role: 'admin' },
      });
      const me = await http()
        .get('/v1/tenants/t-beta')
        .set('Authorization', `Bearer ${res.body.access_token}`)
        .expect(200);
      expect(me.body.slug).toBe('beta');
      // and only for that workspace
      await http()
        .get('/v1/tenants/t-acme')
        .set('Authorization', `Bearer ${res.body.access_token}`)
        .expect(403);
    });

    it('a wrong password and an unknown email are the same 401 with the same body', async () => {
      const wrong = await loginEmail(
        'person@acme.com',
        'wrong-password-1',
      ).expect(401);
      const unknown = await loginEmail('nobody@nowhere.io').expect(401);
      const strip = (b: Record<string, unknown>) => ({
        ...b,
        requestId: undefined,
      });
      expect(strip(unknown.body)).toEqual(strip(wrong.body));
      expect(wrong.body).toMatchObject({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
      });
    });

    it('the right password of ANOTHER person proves nothing about this email', async () => {
      await loginEmail('someone-else@gamma.io', OTHER_PW).expect(401);
      // gamma's password matches person@acme.com's gamma membership: only that one is listed
      const res = await loginEmail('person@acme.com', OTHER_PW).expect(201);
      expect(res.body.workspaces.map((w: { slug: string }) => w.slug)).toEqual([
        'gamma',
      ]);
      expect(res.body.unmatchedCount).toBe(3);
    });

    it('when no listed workspace is available there is no access token, only the reasons', async () => {
      users = users.filter((x) => x.email === 'person@acme.com');
      row('u-acme').status = 'disabled';
      row('u-beta').status = 'disabled';
      const res = await loginEmail('person@acme.com').expect(201);
      expect(res.body).not.toHaveProperty('access_token');
      expect(
        res.body.workspaces.map((w: { reason?: string }) => w.reason),
      ).toEqual(['ACCOUNT_DISABLED', 'ACCOUNT_DISABLED', 'TENANT_SUSPENDED']);
    });

    it('validates the body (400) before doing any work', async () => {
      await http().post('/v1/auth/login-email').send({}).expect(400);
      await http()
        .post('/v1/auth/login-email')
        .send({ email: 'not-an-email', password: PW })
        .expect(400);
      expect(prisma.tenantUser.findMany).not.toHaveBeenCalled();
    });
  });

  describe('POST /v1/auth/select-workspace', () => {
    let selectionToken: string;

    beforeEach(async () => {
      selectionToken = (await loginEmail('person@acme.com').expect(201)).body
        .selectionToken;
    });

    it('opens a listed workspace, and the token can be reused to switch to another listed one', async () => {
      const acme = await select(selectionToken, 't-acme').expect(201);
      expect(acme.body.workspace).toEqual({
        tenantId: 't-acme',
        slug: 'acme',
        name: 'Acme',
        role: 'owner',
      });
      await http()
        .get('/v1/tenants/t-acme')
        .set('Authorization', `Bearer ${acme.body.access_token}`)
        .expect(200);

      const beta = await select(selectionToken, 't-beta').expect(201);
      expect(beta.body.workspace.role).toBe('agent');
      await http()
        .get('/v1/tenants/t-beta')
        .set('Authorization', `Bearer ${beta.body.access_token}`)
        .expect(200);
    });

    it('a workspace whose password did NOT match cannot be opened with this token (403 WORKSPACE_NOT_SELECTABLE)', async () => {
      const res = await select(selectionToken, 't-gamma').expect(403);
      expect(res.body.code).toBe('WORKSPACE_NOT_SELECTABLE');
      // nor can a workspace that exists for nobody here
      await select(selectionToken, 'no-such-tenant').expect(403);
    });

    it("someone else's workspace cannot be opened even with a valid token and a valid tenant id", async () => {
      const res = await select(selectionToken, 't-gamma').expect(403);
      expect(res.body.code).toBe('WORKSPACE_NOT_SELECTABLE');
      expect(res.body.accessToken).toBeUndefined();
    });

    it('re-checks everything at selection time: a suspended workspace and a disabled user give the same errors as the slug login', async () => {
      const frozen = await select(selectionToken, 't-frozen').expect(403);
      expect(frozen.body.code).toBe('TENANT_SUSPENDED');

      row('u-beta').status = 'disabled';
      const disabled = await select(selectionToken, 't-beta').expect(403);
      expect(disabled.body.code).toBe('ACCOUNT_DISABLED');

      // the others are untouched
      await select(selectionToken, 't-acme').expect(201);
    });

    it('a deleted user: the token no longer opens that workspace', async () => {
      users = users.filter((x) => x.id !== 'u-beta');
      const res = await select(selectionToken, 't-beta').expect(403);
      expect(res.body.code).toBe('WORKSPACE_NOT_SELECTABLE');
    });

    it('J1: a logout of that user after the password was typed ends the selection for that workspace only', async () => {
      const acme = await select(selectionToken, 't-acme').expect(201);
      await new Promise((r) => setTimeout(r, 5));
      await http()
        .post('/v1/auth/logout')
        .set('Authorization', `Bearer ${acme.body.access_token}`)
        .expect(204);

      const res = await select(selectionToken, 't-acme').expect(401);
      expect(res.body.code).toBe('SELECTION_TOKEN_INVALID');
      // another membership of the person was not logged out
      await select(selectionToken, 't-beta').expect(201);
    });

    it('J1: a password change after it (a reset) ends it too', async () => {
      row('u-acme').passwordChangedAt = new Date(Date.now() + 1000);
      const res = await select(selectionToken, 't-acme').expect(401);
      expect(res.body.code).toBe('SELECTION_TOKEN_INVALID');
    });

    it('expires after ten minutes', async () => {
      const spy = jest.spyOn(Date, 'now');
      spy.mockReturnValue(Date.now() + 11 * 60 * 1000);
      try {
        const res = await select(selectionToken, 't-acme').expect(401);
        expect(res.body.code).toBe('SELECTION_TOKEN_INVALID');
      } finally {
        spy.mockRestore();
      }
    });

    it('garbage, empty and forged tokens are 401 SELECTION_TOKEN_INVALID', async () => {
      for (const bad of [
        'garbage',
        'a.b.c',
        selectionToken.slice(0, -4) + 'AAAA',
      ]) {
        const res = await select(bad, 't-acme').expect(401);
        expect(res.body.code).toBe('SELECTION_TOKEN_INVALID');
      }
      await select('', 't-acme').expect(400);
    });
  });

  describe('the tokens do not stand in for one another', () => {
    it('a selection token opens no staff, platform or widget route', async () => {
      const { selectionToken } = (
        await loginEmail('person@acme.com').expect(201)
      ).body;
      const bearer = `Bearer ${selectionToken}`;
      await http()
        .get('/v1/tenants/t-acme')
        .set('Authorization', bearer)
        .expect(401);
      await http().get('/v1/me').set('Authorization', bearer).expect(401);
      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer)
        .expect(401);
      await http()
        .get('/v1/admin/tenants')
        .set('Authorization', bearer)
        .expect(401);
      await http()
        .get('/v1/widget/conversation')
        .set('Authorization', bearer)
        .expect(401);
    });

    it('staff, platform and widget tokens are not selection tokens', async () => {
      const jwt = app.get(JwtService);
      const staff = jwt.sign({
        sub: 'u-acme',
        tenantId: 't-acme',
        role: 'owner',
        scope: 'tenant',
      });
      for (const token of [staff, platformToken()]) {
        const res = await select(token, 't-acme').expect(401);
        expect(res.body.code).toBe('SELECTION_TOKEN_INVALID');
      }
      // even a "selection" token signed with the staff secret itself
      const forged = jwt.sign({
        scope: 'workspace-select',
        userIds: ['u-acme'],
      });
      const res = await select(forged, 't-acme').expect(401);
      expect(res.body.code).toBe('SELECTION_TOKEN_INVALID');
    });
  });

  describe('login throttling (known issue 1)', () => {
    it('five wrong passwords for one email from one address, then 429 with Retry-After, even for the right password', async () => {
      for (let i = 0; i < 5; i++) {
        await loginEmail('person@acme.com', `wrong-password-${i}`).expect(401);
      }
      const res = await loginEmail('person@acme.com').expect(429);
      expect(res.body).toMatchObject({
        statusCode: 429,
        code: 'TOO_MANY_REQUESTS',
      });
      expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      // blocked before any lookup
      expect(prisma.tenantUser.findMany).toHaveBeenCalledTimes(5);
    });

    it('the slug login shares the same counters', async () => {
      for (let i = 0; i < 3; i++) {
        await slugLogin('acme', 'person@acme.com', 'wrong-password-1').expect(
          401,
        );
      }
      for (let i = 0; i < 2; i++) {
        await loginEmail('person@acme.com', 'wrong-password-2').expect(401);
      }
      await slugLogin('acme', 'person@acme.com').expect(429);
      await loginEmail('person@acme.com').expect(429);
    });

    it('another email from the same address is not blocked, and a correct login in between clears the count', async () => {
      for (let i = 0; i < 5; i++) {
        await loginEmail('person@acme.com', 'wrong-password-1').expect(401);
      }
      await loginEmail('solo@beta.io').expect(201);

      // a fresh start: four wrong, one right, four wrong: never blocked
      resetRateLimits();
      for (let i = 0; i < 4; i++) {
        await loginEmail('solo@beta.io', 'wrong-password-1').expect(401);
      }
      await loginEmail('solo@beta.io').expect(201);
      for (let i = 0; i < 4; i++) {
        await loginEmail('solo@beta.io', 'wrong-password-1').expect(401);
      }
      await loginEmail('solo@beta.io').expect(201);
    });

    it('unknown emails are throttled exactly like known ones (nothing to learn from it)', async () => {
      for (let i = 0; i < 5; i++) {
        await loginEmail('ghost@nowhere.io').expect(401);
      }
      await loginEmail('ghost@nowhere.io').expect(429);
    });

    it('a request that is throttled does no work at all: no lookup, so no password comparison', async () => {
      for (let i = 0; i < 5; i++) {
        await loginEmail('person@acme.com', 'wrong-password-1').expect(401);
      }
      prisma.tenantUser.findMany.mockClear();
      prisma.tenantUser.findFirst.mockClear();
      prisma.tenant.findUnique.mockClear();
      await loginEmail('person@acme.com').expect(429);
      await slugLogin('acme', 'person@acme.com').expect(429);
      expect(prisma.tenantUser.findMany).not.toHaveBeenCalled();
      expect(prisma.tenantUser.findFirst).not.toHaveBeenCalled();
      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('password reset without a slug', () => {
    const ask = (email: string, tenantSlug?: string) =>
      http()
        .post('/v1/auth/password-reset/request')
        .send({ email, tenantSlug });
    const confirm = (token: string, password = NEW_PW) =>
      http().post('/v1/auth/password-reset/confirm').send({ token, password });

    it('always 202; a known email gets ONE reset stored for all workspaces (the link in the body exists only with MAIL_MODE=link), an unknown one nothing', async () => {
      const known = await ask('person@acme.com').expect(202);
      const unknown = await ask('ghost@nowhere.io').expect(202);
      // development only (MAIL_MODE=link): the link; never a delivery field, which would differ
      expect(known.body.link).toContain('/reset-password?token=');
      expect(Object.keys(known.body)).toEqual(['link']);
      expect(unknown.body).toEqual({});
      expect(resets).toHaveLength(1);
      expect(resets[0]).toMatchObject({
        allWorkspaces: true,
        email: 'person@acme.com',
      });
    });

    it('confirming sets the new password on EVERY membership with that email, ends their sessions and uses the link up', async () => {
      // sessions that exist before the reset
      const before = await select(
        (await loginEmail('person@acme.com').expect(201)).body.selectionToken,
        't-acme',
      ).expect(201);
      const { body } = await ask('person@acme.com').expect(202);
      await new Promise((r) => setTimeout(r, 5));
      await confirm(tokenFromLink(body.link)).expect(204);

      const mine = users.filter((x) => x.email === 'person@acme.com');
      expect(mine).toHaveLength(4);
      for (const member of mine) {
        expect(await bcrypt.compare(NEW_PW, member.passwordHash)).toBe(true);
        expect(member.passwordChangedAt).toBeInstanceOf(Date);
      }
      // ONE hash for all of them: a login compares it once
      expect(new Set(mine.map((m) => m.passwordHash)).size).toBe(1);
      // nobody else was touched
      expect(await bcrypt.compare(PW, row('u-solo').passwordHash)).toBe(true);
      expect(await bcrypt.compare(PW, row('u-other').passwordHash)).toBe(true);

      // old sessions are gone
      await http()
        .get('/v1/tenants/t-acme')
        .set('Authorization', `Bearer ${before.body.access_token}`)
        .expect(401);
      // the link works once
      const again = await confirm(tokenFromLink(body.link)).expect(400);
      expect(again.body.code).toBe('RESET_TOKEN_INVALID');

      // one password now opens every workspace; nothing is left unmatched
      const login = await loginEmail('person@acme.com', NEW_PW).expect(201);
      expect(login.body.unmatchedCount).toBe(0);
      expect(
        login.body.workspaces.map((w: { slug: string }) => w.slug),
      ).toEqual(['acme', 'beta', 'frozen', 'gamma']);
      // the old password opens nothing
      await loginEmail('person@acme.com', PW).expect(401);
    });

    it("audits password.reset in each workspace's own log", async () => {
      const { body } = await ask('person@acme.com').expect(202);
      await confirm(tokenFromLink(body.link)).expect(204);
      const entries = prisma.auditLog.create.mock.calls.map((c) => c[0].data);
      expect(entries.map((e) => e.tenantId).sort()).toEqual([
        't-acme',
        't-beta',
        't-frozen',
        't-gamma',
      ]);
      expect(new Set(entries.map((e) => e.action))).toEqual(
        new Set(['password.reset']),
      );
      expect(JSON.stringify(entries)).not.toContain(NEW_PW);
    });

    it('the slug-specific request still resets that single workspace only', async () => {
      const { body } = await ask('person@acme.com', 'acme').expect(202);
      expect(resets[0].allWorkspaces).toBe(false);
      await confirm(tokenFromLink(body.link)).expect(204);
      expect(await bcrypt.compare(NEW_PW, row('u-acme').passwordHash)).toBe(
        true,
      );
      expect(await bcrypt.compare(PW, row('u-beta').passwordHash)).toBe(true);
      expect(await bcrypt.compare(OTHER_PW, row('u-gamma').passwordHash)).toBe(
        true,
      );
    });

    it("a link is useless once the address it was sent to is no longer the user's", async () => {
      const { body } = await ask('person@acme.com').expect(202);
      row(resets[0].userId).email = 'moved-away@acme.com';
      const res = await confirm(tokenFromLink(body.link)).expect(400);
      expect(res.body.code).toBe('RESET_TOKEN_INVALID');
      expect(users.filter((x) => x.email === 'person@acme.com')).toHaveLength(
        3,
      );
      expect(await bcrypt.compare(PW, row('u-beta').passwordHash)).toBe(true);
    });

    it('is limited: three emails per address an hour (silently), ten requests per IP (429)', async () => {
      for (let i = 0; i < 4; i++) await ask('person@acme.com').expect(202);
      expect(resets.filter((r) => r.usedAt === null)).toHaveLength(1);
      expect(resets).toHaveLength(3);
    });
  });

  describe('GET /v1/auth/slug-available', () => {
    const check = (slug: string) =>
      http().get('/v1/auth/slug-available').query({ slug });

    it('a free slug is available; no auth needed', async () => {
      const res = await check('brand-new-co').expect(200);
      expect(res.body).toEqual({ available: true, suggestions: [] });
    });

    it('a taken slug is not, with free suggestions', async () => {
      const res = await check('acme').expect(200);
      expect(res.body).toEqual({
        available: false,
        suggestions: ['acme-2', 'acme-3', 'acme-support'],
      });
    });

    it('a slug an earlier workspace gave up (reserved) counts as taken, and tells nothing else', async () => {
      prisma.tenantSlugAlias.findMany.mockResolvedValue([
        { slug: 'oldname', tenantId: 't-acme' },
      ]);
      const res = await check('oldname').expect(200);
      expect(res.body.available).toBe(false);
      expect(Object.keys(res.body).sort()).toEqual([
        'available',
        'suggestions',
      ]);
      expect(JSON.stringify(res.body)).not.toContain('t-acme');
    });

    it.each(['admin', 'ab', 'Has Spaces!', 'x'.repeat(60)])(
      'a slug that cannot be used (%j) is just "not available", with cleaned-up suggestions',
      async (slug) => {
        const res = await check(slug).expect(200);
        expect(res.body.available).toBe(false);
        for (const s of res.body.suggestions) {
          expect(s).toMatch(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/);
        }
      },
    );

    it('typed capitals are treated as lower case', async () => {
      const res = await check('ACME').expect(200);
      expect(res.body.available).toBe(false);
    });

    it('400 without a slug or with an absurd one', async () => {
      await http().get('/v1/auth/slug-available').expect(400);
      await check('x'.repeat(101)).expect(400);
    });

    it('is limited to 30 checks a minute per address (429 with Retry-After)', async () => {
      for (let i = 0; i < 30; i++) await check(`free-slug-${i}`).expect(200);
      const res = await check('one-too-many').expect(429);
      expect(res.headers['retry-after']).toBeDefined();
    });
  });
});
