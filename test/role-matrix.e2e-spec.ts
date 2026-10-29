import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mockTransaction, PrismaMock } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

type Role = 'owner' | 'admin' | 'agent';
const ALL: Role[] = ['owner', 'admin', 'agent'];
const OWNER_ADMIN: Role[] = ['owner', 'admin'];
const OWNER: Role[] = ['owner'];

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/**
 * The role matrix of the tenant API (B2, J4), as one table. For every row, each role that is not
 * listed must get exactly 403 INSUFFICIENT_ROLE, and nothing is read or written for it; each role
 * that is listed must get past the role check (whatever the handler then says about our empty
 * mocks). A new route fails the "every route is in the table" test until it is added here, so the
 * matrix cannot silently drift from the controllers.
 */
const MATRIX: Array<[Method, string, Role[], string?]> = [
  // people
  ['get', '/users', ALL],
  ['get', '/users/u1', ALL],
  ['patch', '/users/u1', OWNER_ADMIN],
  ['delete', '/users/u1', OWNER_ADMIN],
  ['post', '/invites', OWNER_ADMIN],
  ['get', '/invites', OWNER_ADMIN],
  ['delete', '/invites/i1', OWNER_ADMIN],
  ['get', '/audit-logs', OWNER_ADMIN],
  // keys: details hidden from agents
  ['post', '/api-keys', OWNER_ADMIN],
  ['get', '/api-keys', OWNER_ADMIN],
  ['get', '/api-keys/k1', OWNER_ADMIN],
  ['patch', '/api-keys/k1', OWNER_ADMIN],
  ['delete', '/api-keys/k1', OWNER_ADMIN],
  // money and legal choices
  ['get', '/billing', OWNER_ADMIN],
  ['patch', '/billing/settings', OWNER],
  ['post', '/billing/upgrade-request', OWNER],
  ['get', '/billing/upgrade-request', OWNER_ADMIN],
  ['get', '/data-use', OWNER],
  ['put', '/data-use', OWNER],
  // the workspace itself (J3)
  ['get', '', ALL],
  ['patch', '', OWNER],
  // customers
  ['post', '/customers', ALL],
  ['get', '/customers', ALL],
  ['get', '/customers/c1', ALL],
  ['get', '/customers/c1/conversations', ALL],
  ['patch', '/customers/c1', ALL],
  ['delete', '/customers/c1', OWNER_ADMIN],
  // conversations and notifications: everyone works the queue
  ['get', '/conversations', ALL],
  ['get', '/conversations/counts', ALL],
  ['get', '/conversations/x1', ALL],
  ['post', '/conversations/x1/claim', ALL],
  ['post', '/conversations/x1/release', ALL],
  ['post', '/conversations/x1/resolve', ALL],
  ['post', '/conversations/x1/messages', ALL],
  ['get', '/notifications', ALL],
  ['post', '/notifications/read-all', ALL],
  ['post', '/notifications/n1/read', ALL],
  ['post', '/events/ticket', ALL],
  // agents (L7): every role sees name and status, owner/admin change them; the settings hold
  // forwarding phone numbers, so owner/admin only
  ['get', '/agents', ALL],
  ['post', '/agents', OWNER_ADMIN],
  ['get', '/agents/g1', ALL],
  ['patch', '/agents/g1', OWNER_ADMIN],
  ['delete', '/agents/g1', OWNER_ADMIN],
  ['get', '/agents/g1/settings', OWNER_ADMIN],
  ['put', '/agents/g1/settings', OWNER_ADMIN],
  ['get', '/agents/g1/settings/versions', OWNER_ADMIN],
  ['get', '/agents/g1/settings/versions/v1', OWNER_ADMIN],
  // requests the AI took on calls (Phase 5B-2): everyone works them, the staff role agent included
  ['get', '/requests', ALL],
  ['get', '/requests/counts', ALL],
  ['get', '/requests/q1', ALL],
  ['patch', '/requests/q1/status', ALL],
];

describe('Role matrix (e2e, B2 and J4)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let staffToken: (u: {
    userId: string;
    tenantId: string;
    role: string;
  }) => string;
  let allowStaff: () => void;

  const as = (role: Role, tenantId = 'tenant-a') =>
    `Bearer ${staffToken({ userId: `${role}-1`, tenantId, role })}`;
  const url = (path: string) => `/v1/tenants/tenant-a${path}`;

  beforeAll(async () => {
    ({ app, prisma, staffToken, allowStaff } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    allowStaff();
    mockTransaction(prisma);
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-a',
      status: 'active',
    });
  });

  const call = (method: Method, path: string, token: string) =>
    request(app.getHttpServer())[method](url(path)).set('Authorization', token);

  describe.each(MATRIX)('%s /tenants/:tenantId%s', (method, path, allowed) => {
    const denied = ALL.filter((role) => !allowed.includes(role));
    if (denied.length === 0) {
      it('every role may use it (nothing to refuse)', () => {
        expect(allowed).toEqual(ALL);
      });
    }

    // `it.each` refuses an empty table, so a row everyone may use has no refusal test.
    const refusals: Role[] = denied;
    const itRefuses =
      (refusals.length > 0 ? it.each(refusals) : null) ?? (() => undefined);
    itRefuses(
      '%s is refused with 403 INSUFFICIENT_ROLE',
      async (role: Role) => {
        const writesBefore = prisma.auditLog.create.mock.calls.length;
        const res = await call(method, path, as(role)).send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('INSUFFICIENT_ROLE');
        // Refused at the door: no tenant data was touched for them. (The strategy's own lookup of
        // the user, tenantUser.findUnique, is the one allowed read.)
        for (const model of [
          'tenantUser',
          'staffInvite',
          'apiKey',
          'subscription',
          'dataUseConsent',
          'endCustomer',
          'upgradeRequest',
          'agent',
          'agentSettings',
          'customerRequest',
        ] as const) {
          for (const [name, fn] of Object.entries(prisma[model])) {
            if (model === 'tenantUser' && name === 'findUnique') continue;
            expect(fn).not.toHaveBeenCalled();
          }
        }
        expect(prisma.auditLog.create.mock.calls.length).toBe(writesBefore);
      },
    );

    it.each(allowed)('%s gets past the role check', async (role) => {
      const res = await call(method, path, as(role)).send({});
      expect(res.body?.code).not.toBe('INSUFFICIENT_ROLE');
      expect(res.status).not.toBe(401);
    });

    it('is closed to anonymous callers (401) and to other tenants (403 TENANT_MISMATCH)', async () => {
      await request(app.getHttpServer())
        [method](url(path))
        .send({})
        .expect(401);
      const res = await call(method, path, as('owner', 'tenant-b')).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TENANT_MISMATCH');
    });
  });

  it('every tenant-scoped route of the application is in the table (a new route must state who may use it)', () => {
    const routes: string[] = [];
    // Express keeps its routes in the router stack of the underlying instance (v5: `router`).
    const instance = app.getHttpAdapter().getInstance() as {
      router?: { stack: RouterLayer[] };
      _router?: { stack: RouterLayer[] };
    };
    const stack = (instance.router ?? instance._router)!.stack;
    for (const layer of stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        routes.push(`${method} ${layer.route.path}`);
      }
    }
    expect(routes.length).toBeGreaterThan(40); // the enumeration itself works
    const tenantRoutes = routes
      .filter((r) => r.includes('/v1/tenants/:tenantId'))
      .map((r) => r.replace('/v1/tenants/:tenantId', ''));

    expect(tenantRoutes.length).toBeGreaterThan(30);

    const known = MATRIX.map(([method, path]) => {
      // the table uses concrete ids; compare by shape
      const shape = path
        .replace(/\/(u1|i1|k1|c1|x1|n1|g1|v1|q1)(?=\/|$)/g, '/:id')
        .replace(/\/:id/g, '/:id');
      return `${method} ${shape}`;
    });
    const normalise = (r: string) => r.replace(/\/:[A-Za-z]+/g, '/:id');
    // Routes that are not role-gated by design: the SSE streams use their own ticket flow, and are
    // listed here so a new one is a conscious choice.
    const exempt = new Set(['get /events']);
    const missing = tenantRoutes
      .map(normalise)
      .filter((r) => !exempt.has(r) && !known.map(normalise).includes(r));
    expect(missing).toEqual([]);
  });

  describe('nobody disables, demotes or deletes themselves (J4)', () => {
    const own = (role: Role) => `/v1/tenants/tenant-a/users/${role}-1`;

    it.each(ALL.filter((r) => r !== 'agent'))(
      '%s: DELETE own account is 403 CANNOT_MODIFY_SELF and nothing is touched',
      async (role) => {
        const res = await request(app.getHttpServer())
          .delete(own(role))
          .set('Authorization', as(role))
          .expect(403);
        expect(res.body.code).toBe('CANNOT_MODIFY_SELF');
        expect(prisma.tenantUser.delete).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['owner', { status: 'disabled' }],
      ['admin', { status: 'disabled' }],
      ['owner', { role: 'admin' }],
      ['owner', { role: 'agent' }],
      ['admin', { role: 'agent' }],
    ] as Array<[Role, object]>)(
      '%s: PATCH own account with %j is 403 CANNOT_MODIFY_SELF',
      async (role, body) => {
        prisma.tenantUser.findFirst.mockResolvedValue({
          id: `${role}-1`,
          tenantId: 'tenant-a',
          role,
          status: 'active',
        });
        prisma.tenantUser.count.mockResolvedValue(5);
        const res = await request(app.getHttpServer())
          .patch(own(role))
          .set('Authorization', as(role))
          .send(body)
          .expect(403);
        expect(res.body.code).toBe('CANNOT_MODIFY_SELF');
        expect(prisma.tenantUser.update).not.toHaveBeenCalled();
      },
    );

    it("a colleague's account is a different story: an owner may disable an admin", async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'admin-9',
        tenantId: 'tenant-a',
        role: 'admin',
        status: 'active',
      });
      prisma.tenantUser.update.mockResolvedValue({
        id: 'admin-9',
        tenantId: 'tenant-a',
        role: 'admin',
        status: 'disabled',
      });
      await request(app.getHttpServer())
        .patch('/v1/tenants/tenant-a/users/admin-9')
        .set('Authorization', as('owner'))
        .send({ status: 'disabled' })
        .expect(200);
    });
  });
});
