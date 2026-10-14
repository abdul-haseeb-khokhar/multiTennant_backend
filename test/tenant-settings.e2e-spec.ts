import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { FakeClock } from '../src/billing/clock';
import { mockTransaction, PrismaMock } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

type Role = 'owner' | 'admin' | 'agent';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  defaultLocale: string;
  timezone: string;
  slugChangedAt: Date | null;
  createdAt: Date;
}
interface AliasRow {
  id: string;
  tenantId: string;
  slug: string;
  acceptedUntil: Date;
  reservedUntil: Date;
  createdAt: Date;
}

/** Phase 3C, J3 + J7: the owner edits the workspace, renames its slug; J4 self-protection. */
describe('Tenant settings, slug rename and time zone (e2e, J3, J7)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let clock: FakeClock;
  let staffToken: (u: {
    userId: string;
    tenantId: string;
    role: string;
  }) => string;
  let allowStaff: () => void;
  let passwordHash: string;

  let tenants: TenantRow[];
  let aliases: AliasRow[];
  let nextId: number;

  const http = () => request(app.getHttpServer());
  const as = (role: Role, tenantId = 'tenant-a') =>
    `Bearer ${staffToken({ userId: `${role}-1`, tenantId, role })}`;
  const tenant = (id: string) => tenants.find((t) => t.id === id)!;
  const auditActions = () =>
    prisma.auditLog.create.mock.calls.map((c) => c[0].data.action);

  beforeAll(async () => {
    ({ app, prisma, clock, staffToken, allowStaff } = await createTestApp());
    passwordHash = bcrypt.hashSync('correct-horse-battery', 4);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    allowStaff();
    mockTransaction(prisma);
    clock.set('2026-10-13T00:00:00Z');
    nextId = 1;
    const base = {
      status: 'active',
      plan: 'pro',
      defaultLocale: 'en',
      timezone: 'Asia/Karachi',
      slugChangedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    tenants = [
      { id: 'tenant-a', name: 'Acme', slug: 'acme', ...base },
      { id: 'tenant-b', name: 'Beta', slug: 'beta', ...base },
    ];
    aliases = [];

    // An in-memory stand-in for the tables the settings and login use.
    prisma.tenant.findUnique.mockImplementation(
      ({ where }: { where: { id?: string; slug?: string } }) => {
        const row = tenants.find((t) =>
          where.id !== undefined ? t.id === where.id : t.slug === where.slug,
        );
        // a copy, like a database row: a later update must not change what was read
        return Promise.resolve(row ? { ...row } : null);
      },
    );
    prisma.tenant.findMany.mockImplementation(
      ({ where }: { where: { slug: { in: string[] } } }) =>
        Promise.resolve(tenants.filter((t) => where.slug.in.includes(t.slug))),
    );
    prisma.tenant.update.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<TenantRow>;
      }) => {
        Object.assign(tenant(where.id), data);
        return Promise.resolve(tenant(where.id));
      },
    );
    prisma.tenantSlugAlias.findMany.mockImplementation(
      ({
        where,
        orderBy,
        select,
      }: {
        where: {
          tenantId?: string;
          slug?: { in: string[] };
          reservedUntil: { gt: Date };
        };
        orderBy?: unknown;
        select?: Record<string, boolean>;
      }) =>
        Promise.resolve(
          aliases
            .filter(
              (a) =>
                a.reservedUntil > where.reservedUntil.gt &&
                (!where.tenantId || a.tenantId === where.tenantId) &&
                (!where.slug || where.slug.in.includes(a.slug)),
            )
            .sort(
              (x, y) =>
                (orderBy ? -1 : 1) *
                (x.createdAt.getTime() - y.createdAt.getTime()),
            )
            // like Prisma: only the selected columns come back
            .map((a) =>
              select
                ? Object.fromEntries(
                    Object.entries(a).filter(([key]) => select[key]),
                  )
                : a,
            ),
        ),
    );
    prisma.tenantSlugAlias.findFirst.mockImplementation(
      ({ where }: { where: { slug: string; acceptedUntil: { gt: Date } } }) => {
        const alias = aliases.find(
          (a) =>
            a.slug === where.slug && a.acceptedUntil > where.acceptedUntil.gt,
        );
        return Promise.resolve(
          alias ? { ...alias, tenant: tenant(alias.tenantId) } : null,
        );
      },
    );
    prisma.tenantSlugAlias.deleteMany.mockImplementation(
      ({ where }: { where: { tenantId: string; slug: string } }) => {
        const before = aliases.length;
        aliases = aliases.filter(
          (a) => !(a.tenantId === where.tenantId && a.slug === where.slug),
        );
        return Promise.resolve({ count: before - aliases.length });
      },
    );
    prisma.tenantSlugAlias.create.mockImplementation(
      ({ data }: { data: Omit<AliasRow, 'id' | 'createdAt'> }) => {
        const row = {
          id: `alias-${nextId++}`,
          createdAt: clock.now(),
          ...data,
        };
        aliases.push(row);
        return Promise.resolve(row);
      },
    );
    prisma.$executeRaw.mockResolvedValue(1);
  });

  describe('GET /v1/tenants/:tenantId', () => {
    it.each(['owner', 'admin', 'agent'] as Role[])(
      'every role (%s) reads the settings of its own workspace',
      async (role) => {
        const res = await http()
          .get('/v1/tenants/tenant-a')
          .set('Authorization', as(role))
          .expect(200);
        expect(res.body).toEqual({
          id: 'tenant-a',
          name: 'Acme',
          slug: 'acme',
          defaultLocale: 'en',
          timezone: 'Asia/Karachi',
          createdAt: '2026-01-01T00:00:00.000Z',
          slugChangedAt: null,
          slugChangeAllowedAt: null,
          previousSlugs: [],
        });
      },
    );

    it("403 TENANT_MISMATCH for another tenant's settings, and nothing is read", async () => {
      const res = await http()
        .get('/v1/tenants/tenant-b')
        .set('Authorization', as('owner', 'tenant-a'))
        .expect(403);
      expect(res.body.code).toBe('TENANT_MISMATCH');
      expect(prisma.tenantSlugAlias.findMany).not.toHaveBeenCalled();
    });

    it('401 without a token', async () => {
      await http().get('/v1/tenants/tenant-a').expect(401);
    });
  });

  describe('PATCH /v1/tenants/:tenantId: who may', () => {
    it.each(['admin', 'agent'] as Role[])(
      '%s gets 403 INSUFFICIENT_ROLE and nothing changes',
      async (role) => {
        const res = await http()
          .patch('/v1/tenants/tenant-a')
          .set('Authorization', as(role))
          .send({ name: 'Hijacked', slug: 'hijacked' })
          .expect(403);
        expect(res.body.code).toBe('INSUFFICIENT_ROLE');
        expect(tenant('tenant-a')).toMatchObject({
          name: 'Acme',
          slug: 'acme',
        });
        expect(prisma.tenant.update).not.toHaveBeenCalled();
      },
    );

    it('an owner cannot touch another tenant (403 TENANT_MISMATCH), whatever the body says', async () => {
      const res = await http()
        .patch('/v1/tenants/tenant-b')
        .set('Authorization', as('owner', 'tenant-a'))
        .send({ name: 'Hijacked' })
        .expect(403);
      expect(res.body.code).toBe('TENANT_MISMATCH');
      expect(tenant('tenant-b').name).toBe('Beta');
    });

    it('the tenant always comes from the token: an id in the body is ignored', async () => {
      await http()
        .patch('/v1/tenants/tenant-a')
        .set('Authorization', as('owner'))
        .send({ id: 'tenant-b', tenantId: 'tenant-b', name: 'Renamed' })
        .expect(200);
      expect(tenant('tenant-a').name).toBe('Renamed');
      expect(tenant('tenant-b').name).toBe('Beta');
    });

    it('plan and status cannot be changed here (mass assignment)', async () => {
      await http()
        .patch('/v1/tenants/tenant-a')
        .set('Authorization', as('owner'))
        .send({ name: 'Acme 2', plan: 'enterprise', status: 'suspended' })
        .expect(200);
      expect(tenant('tenant-a')).toMatchObject({
        name: 'Acme 2',
        plan: 'pro',
        status: 'active',
      });
      expect(prisma.tenant.update.mock.calls[0][0].data).toEqual({
        name: 'Acme 2',
      });
    });
  });

  describe('PATCH: name, language and time zone', () => {
    it('saves them, answers with the new settings and audits tenant.updated with before and after', async () => {
      const res = await http()
        .patch('/v1/tenants/tenant-a')
        .set('Authorization', as('owner'))
        .send({
          name: '  Acme Ltd ',
          defaultLocale: 'ur',
          timezone: 'europe/london',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        name: 'Acme Ltd',
        defaultLocale: 'ur',
        timezone: 'Europe/London',
      });
      expect(auditActions()).toEqual(['tenant.updated']);
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-a',
        actorUserId: 'owner-1',
        actorRole: 'owner',
        before: {
          name: 'Acme',
          defaultLocale: 'en',
          timezone: 'Asia/Karachi',
        },
        after: {
          name: 'Acme Ltd',
          defaultLocale: 'ur',
          timezone: 'Europe/London',
        },
      });
    });

    it.each([
      ['an unknown time zone', { timezone: 'Mars/Base' }],
      ['a UTC offset instead of a zone', { timezone: '+05:00' }],
      ['an unknown language', { defaultLocale: 'xx' }],
      ['an empty name', { name: '   ' }],
      ['a name that is too long', { name: 'x'.repeat(101) }],
      ['a malformed slug', { slug: 'Not A Slug!' }],
      ['a slug that is too short', { slug: 'ab' }],
    ])('400 VALIDATION_ERROR for %s', async (_name, body) => {
      const res = await http()
        .patch('/v1/tenants/tenant-a')
        .set('Authorization', as('owner'))
        .send(body)
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('an empty body changes nothing', async () => {
      await http()
        .patch('/v1/tenants/tenant-a')
        .set('Authorization', as('owner'))
        .send({})
        .expect(200);
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('PATCH: slug rename (J3)', () => {
    const rename = (slug: string, role: Role = 'owner') =>
      http()
        .patch('/v1/tenants/tenant-a')
        .set('Authorization', as(role))
        .send({ slug });

    it('renames, answers with the new slug and keeps the old one as a 30 + 90 day alias, audited with before and after', async () => {
      const res = await rename('acme-support').expect(200);
      expect(res.body).toMatchObject({
        slug: 'acme-support',
        slugChangedAt: '2026-10-13T00:00:00.000Z',
        slugChangeAllowedAt: '2026-11-12T00:00:00.000Z',
      });
      expect(res.body.previousSlugs).toEqual([
        {
          slug: 'acme',
          acceptedUntil: '2026-11-12T00:00:00.000Z',
          reservedUntil: '2027-01-11T00:00:00.000Z',
        },
      ]);
      expect(auditActions()).toEqual(['tenant.slug_changed']);
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-a',
        actorUserId: 'owner-1',
        before: { slug: 'acme' },
        after: { slug: 'acme-support' },
      });
    });

    it('409 SLUG_TAKEN with suggestions when another tenant has the slug', async () => {
      const res = await rename('beta').expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        code: 'SLUG_TAKEN',
        suggestions: ['beta-2', 'beta-3', 'beta-support'],
      });
      expect(tenant('tenant-a').slug).toBe('acme');
      expect(aliases).toHaveLength(0);
    });

    it('409 SLUG_TAKEN for a word we keep (admin, api, www, ...)', async () => {
      const res = await rename('admin').expect(409);
      expect(res.body.code).toBe('SLUG_TAKEN');
      expect(res.body.suggestions.length).toBeGreaterThan(0);
    });

    it('a second rename within 30 days is 409 SLUG_CHANGE_TOO_SOON with the date', async () => {
      await rename('acme-support').expect(200);
      clock.advanceDays(10);
      const res = await rename('acme-help').expect(409);
      expect(res.body).toMatchObject({
        code: 'SLUG_CHANGE_TOO_SOON',
        nextAllowedAt: '2026-11-12T00:00:00.000Z',
      });
      expect(tenant('tenant-a').slug).toBe('acme-support');

      clock.advanceDays(20); // day 30: allowed again
      await rename('acme-help').expect(200);
      expect(tenant('tenant-a').slug).toBe('acme-help');
    });

    it('while an old slug is reserved (90 days) nobody else can rename to it, the old owner can take it back', async () => {
      await rename('acme-support').expect(200);

      // beta wants the name acme just gave up
      const res = await http()
        .patch('/v1/tenants/tenant-b')
        .set('Authorization', as('owner', 'tenant-b'))
        .send({ slug: 'acme' })
        .expect(409);
      expect(res.body.code).toBe('SLUG_TAKEN');
      expect(tenant('tenant-b').slug).toBe('beta');

      // acme itself may take it back after the 30-day wait: the alias goes away
      clock.advanceDays(31);
      await rename('acme').expect(200);
      expect(tenant('tenant-a').slug).toBe('acme');
      expect(aliases.map((a) => a.slug)).toEqual(['acme-support']);
    });

    it('after 90 days the old slug is free for anyone', async () => {
      await rename('acme-support').expect(200);
      clock.advanceDays(91);
      await http()
        .patch('/v1/tenants/tenant-b')
        .set('Authorization', as('owner', 'tenant-b'))
        .send({ slug: 'acme' })
        .expect(200);
      expect(tenant('tenant-b').slug).toBe('acme');
    });

    it('the lock is taken before availability is decided (claims on slugs queue up)', async () => {
      await rename('acme-support').expect(200);
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('renaming to the current slug is a no-op, not a conflict', async () => {
      await rename('acme').expect(200);
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect(aliases).toHaveLength(0);
    });
  });

  describe('the old slug at login (J3)', () => {
    const login = (tenantSlug: string) =>
      http().post('/v1/auth/login').send({
        tenantSlug,
        email: 'owner@acme.com',
        password: 'correct-horse-battery',
      });

    beforeEach(() => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'owner-1',
        tenantId: 'tenant-a',
        role: 'owner',
        status: 'active',
        passwordHash,
      });
    });

    it('works with the new slug and, for 30 days, with the old one; then it stops', async () => {
      await http()
        .patch('/v1/tenants/tenant-a')
        .set('Authorization', as('owner'))
        .send({ slug: 'acme-support' })
        .expect(200);

      for (const slug of ['acme-support', 'acme']) {
        const res = await login(slug).expect(201);
        expect(res.body.access_token).toEqual(expect.any(String));
      }
      expect(prisma.tenantUser.findFirst).toHaveBeenLastCalledWith({
        where: { tenantId: 'tenant-a', email: 'owner@acme.com' },
      });

      clock.advanceDays(29);
      await login('acme').expect(201);
      clock.advanceDays(2); // day 31: the alias is only a reservation now
      const res = await login('acme').expect(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
      await login('acme-support').expect(201);
    });

    it('an alias never logs into another tenant: the user lookup is scoped to the alias tenant', async () => {
      aliases.push({
        id: 'alias-x',
        tenantId: 'tenant-b',
        slug: 'old-beta',
        acceptedUntil: new Date('2026-12-01T00:00:00Z'),
        reservedUntil: new Date('2027-02-01T00:00:00Z'),
        createdAt: new Date('2026-10-01T00:00:00Z'),
      });
      await login('old-beta').expect(201);
      expect(prisma.tenantUser.findFirst).toHaveBeenLastCalledWith({
        where: { tenantId: 'tenant-b', email: 'owner@acme.com' },
      });
    });
  });

  describe('GET /v1/me carries the slug and the time zone', () => {
    it('shows both in the tenant part', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'owner-1',
        email: 'owner@acme.com',
        name: null,
        role: 'owner',
        emailVerifiedAt: new Date('2026-01-01'),
        locale: null,
        tenant: {
          id: 'tenant-a',
          name: 'Acme',
          slug: 'acme',
          plan: 'pro',
          status: 'active',
          defaultLocale: 'en',
          timezone: 'Asia/Karachi',
        },
      });
      prisma.notification.count.mockResolvedValue(0);
      prisma.subscription.findUnique.mockResolvedValue(null);
      const res = await http()
        .get('/v1/me')
        .set('Authorization', as('owner'))
        .expect(200);
      expect(res.body.tenant).toMatchObject({
        slug: 'acme',
        timezone: 'Asia/Karachi',
      });
      expect(
        prisma.tenantUser.findFirst.mock.calls[0][0].select.tenant,
      ).toEqual({
        select: expect.objectContaining({ slug: true, timezone: true }),
      });
    });
  });
});
