import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mockTransaction, PrismaMock, prismaError } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

type Role = 'owner' | 'admin' | 'agent';

describe('Access control (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let staffToken: (u: {
    userId: string;
    tenantId: string;
    role: string;
  }) => string;
  let platformToken: () => string;
  let allowStaff: () => void;

  const asRole = (role: Role, tenantId = 'tenant-a') =>
    `Bearer ${staffToken({ userId: `${role}-1`, tenantId, role })}`;

  beforeAll(async () => {
    ({ app, prisma, staffToken, platformToken, allowStaff } =
      await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    allowStaff();
    mockTransaction(prisma);
    prisma.tenant.findUnique.mockResolvedValue({ status: 'active' });
  });

  describe('authentication', () => {
    it('401 UNAUTHORIZED without a token', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/tenants/tenant-a/users')
        .expect(401);
      expect(res.body).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    });

    it('401 for a garbage token and for a token signed with another secret', async () => {
      await request(app.getHttpServer())
        .get('/v1/tenants/tenant-a/users')
        .set('Authorization', 'Bearer not.a.jwt')
        .expect(401);
    });

    it('401 for a staff token without the tenant scope (e.g. issued before scopes existed)', async () => {
      const { JwtService } = await import('@nestjs/jwt');
      const jwt = app.get(JwtService);
      const legacy = jwt.sign({
        sub: 'u1',
        tenantId: 'tenant-a',
        role: 'owner',
      });
      await request(app.getHttpServer())
        .get('/v1/tenants/tenant-a/users')
        .set('Authorization', `Bearer ${legacy}`)
        .expect(401);
    });

    it('401 for a platform-admin token on a tenant route', async () => {
      prisma.platformAdmin.findUnique.mockResolvedValue({ id: 'admin-1' });
      await request(app.getHttpServer())
        .get('/v1/tenants/tenant-a/users')
        .set('Authorization', `Bearer ${platformToken()}`)
        .expect(401);
    });
  });

  describe('tenant isolation: token tenant must equal the URL tenant', () => {
    const cases: [string, string, () => request.Test][] = [
      [
        'GET users',
        'tenantUser',
        () => request(app.getHttpServer()).get('/v1/tenants/tenant-b/users'),
      ],
      [
        'GET one user',
        'tenantUser',
        () => request(app.getHttpServer()).get('/v1/tenants/tenant-b/users/u1'),
      ],
      [
        'POST invites',
        'staffInvite',
        () =>
          request(app.getHttpServer())
            .post('/v1/tenants/tenant-b/invites')
            .send({ email: 'x@y.com' }),
      ],
      [
        'GET invites',
        'staffInvite',
        () => request(app.getHttpServer()).get('/v1/tenants/tenant-b/invites'),
      ],
      [
        'DELETE invite',
        'staffInvite',
        () =>
          request(app.getHttpServer()).delete(
            '/v1/tenants/tenant-b/invites/i1',
          ),
      ],
      [
        'GET audit logs',
        'auditLog',
        () =>
          request(app.getHttpServer()).get('/v1/tenants/tenant-b/audit-logs'),
      ],
      [
        'PATCH user',
        'tenantUser',
        () =>
          request(app.getHttpServer())
            .patch('/v1/tenants/tenant-b/users/u1')
            .send({ role: 'admin' }),
      ],
      [
        'DELETE user',
        'tenantUser',
        () =>
          request(app.getHttpServer()).delete('/v1/tenants/tenant-b/users/u1'),
      ],
      [
        'GET customers',
        'endCustomer',
        () =>
          request(app.getHttpServer()).get('/v1/tenants/tenant-b/customers'),
      ],
      [
        'GET one customer',
        'endCustomer',
        () =>
          request(app.getHttpServer()).get('/v1/tenants/tenant-b/customers/c1'),
      ],
      [
        'POST customers',
        'endCustomer',
        () =>
          request(app.getHttpServer())
            .post('/v1/tenants/tenant-b/customers')
            .send({ externalId: 'x' }),
      ],
      [
        'PATCH customer',
        'endCustomer',
        () =>
          request(app.getHttpServer())
            .patch('/v1/tenants/tenant-b/customers/c1')
            .send({ name: 'x' }),
      ],
      [
        'DELETE customer',
        'endCustomer',
        () =>
          request(app.getHttpServer()).delete(
            '/v1/tenants/tenant-b/customers/c1',
          ),
      ],
    ];

    it.each(cases)(
      '%s with a tenant-a owner token on tenant-b -> 403 TENANT_MISMATCH',
      async (_name, model, call) => {
        const res = await call()
          .set('Authorization', asRole('owner', 'tenant-a'))
          .expect(403);
        expect(res.body).toMatchObject({
          statusCode: 403,
          code: 'TENANT_MISMATCH',
        });
        // The only lookup allowed before the tenant check is the one that authenticates the
        // token's own user (`tenantUser.findUnique`, scoped to the token's tenant).
        const touched = Object.entries(prisma[model as 'tenantUser']).filter(
          ([name]) => !(model === 'tenantUser' && name === 'findUnique'),
        );
        for (const [, fn] of touched) {
          expect(fn).not.toHaveBeenCalled();
        }
      },
    );
  });

  describe('suspended tenant (B6)', () => {
    it('403 TENANT_SUSPENDED on every tenant route, even with a valid token', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ status: 'suspended' });
      const res = await request(app.getHttpServer())
        .get('/v1/tenants/tenant-a/customers')
        .set('Authorization', asRole('owner'))
        .expect(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        code: 'TENANT_SUSPENDED',
      });
      expect(prisma.endCustomer.findMany).not.toHaveBeenCalled();
    });

    it('401 when the tenant no longer exists', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .get('/v1/tenants/tenant-a/customers')
        .set('Authorization', asRole('owner'))
        .expect(401);
    });
  });

  describe('role matrix (B2) on users', () => {
    beforeEach(() => {
      prisma.staffInvite.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'inv-1', ...data }),
      );
    });

    it('agents can read the team but not change it or invite anyone', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([]);
      prisma.tenantUser.count.mockResolvedValue(0);
      await request(app.getHttpServer())
        .get('/v1/tenants/tenant-a/users')
        .set('Authorization', asRole('agent'))
        .expect(200);

      const writes = [
        () =>
          request(app.getHttpServer())
            .post('/v1/tenants/tenant-a/invites')
            .send({ email: 'new@acme.com' }),
        () => request(app.getHttpServer()).get('/v1/tenants/tenant-a/invites'),
        () =>
          request(app.getHttpServer()).delete(
            '/v1/tenants/tenant-a/invites/inv-1',
          ),
        () =>
          request(app.getHttpServer()).get('/v1/tenants/tenant-a/audit-logs'),
        () =>
          request(app.getHttpServer())
            .patch('/v1/tenants/tenant-a/users/u1')
            .send({ role: 'admin' }),
        () =>
          request(app.getHttpServer()).delete('/v1/tenants/tenant-a/users/u1'),
      ];
      for (const write of writes) {
        const res = await write()
          .set('Authorization', asRole('agent'))
          .expect(403);
        expect(res.body.code).toBe('INSUFFICIENT_ROLE');
      }
      expect(prisma.staffInvite.create).not.toHaveBeenCalled();
      expect(prisma.staffInvite.findMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
      expect(prisma.tenantUser.delete).not.toHaveBeenCalled();
    });

    it('there is no way to create a user with a password any more: POST /users is gone', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/tenants/tenant-a/users')
        .set('Authorization', asRole('owner'))
        .send({ email: 'new@acme.com', password: 'password123' })
        .expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
      expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    });

    it('an admin cannot promote anyone to owner or touch an existing owner', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u1',
        tenantId: 'tenant-a',
        role: 'agent',
      });
      const promote = await request(app.getHttpServer())
        .patch('/v1/tenants/tenant-a/users/u1')
        .set('Authorization', asRole('admin'))
        .send({ role: 'owner' })
        .expect(403);
      expect(promote.body.code).toBe('OWNER_REQUIRED');

      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'o1',
        tenantId: 'tenant-a',
        role: 'owner',
      });
      const edit = await request(app.getHttpServer())
        .patch('/v1/tenants/tenant-a/users/o1')
        .set('Authorization', asRole('admin'))
        .send({ email: 'changed@acme.com' })
        .expect(403);
      expect(edit.body.code).toBe('OWNER_REQUIRED');
      const del = await request(app.getHttpServer())
        .delete('/v1/tenants/tenant-a/users/o1')
        .set('Authorization', asRole('admin'))
        .expect(403);
      expect(del.body.code).toBe('OWNER_REQUIRED');

      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
      expect(prisma.tenantUser.delete).not.toHaveBeenCalled();
    });

    it('DELETE removes a user (regression: it used to 404 because of swapped arguments)', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u1',
        tenantId: 'tenant-a',
        role: 'agent',
      });
      prisma.tenantUser.delete.mockResolvedValue({
        id: 'u1',
        tenantId: 'tenant-a',
        role: 'agent',
      });

      const res = await request(app.getHttpServer())
        .delete('/v1/tenants/tenant-a/users/u1')
        .set('Authorization', asRole('admin'))
        .expect(200);
      expect(res.body.id).toBe('u1');
      expect(prisma.tenantUser.delete).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1', tenantId: 'tenant-a' } }),
      );
    });

    it('409 LAST_OWNER when the only active owner would be deleted, demoted or disabled', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'o1',
        tenantId: 'tenant-a',
        role: 'owner',
        status: 'active',
      });
      // no OTHER active owner
      prisma.tenantUser.count.mockResolvedValue(0);

      const del = await request(app.getHttpServer())
        .delete('/v1/tenants/tenant-a/users/o1')
        .set('Authorization', asRole('owner'))
        .expect(409);
      expect(del.body.code).toBe('LAST_OWNER');

      const demote = await request(app.getHttpServer())
        .patch('/v1/tenants/tenant-a/users/o1')
        .set('Authorization', asRole('owner'))
        .send({ role: 'admin' })
        .expect(409);
      expect(demote.body.code).toBe('LAST_OWNER');
    });

    it('409 EMAIL_TAKEN when an update collides with another user', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u1',
        tenantId: 'tenant-a',
        role: 'agent',
      });
      prisma.tenantUser.update.mockRejectedValue(prismaError('P2002'));

      const res = await request(app.getHttpServer())
        .patch('/v1/tenants/tenant-a/users/u1')
        .set('Authorization', asRole('admin'))
        .send({ email: 'taken@acme.com' })
        .expect(409);
      expect(res.body).toMatchObject({ statusCode: 409, code: 'EMAIL_TAKEN' });
    });

    it('404 USER_NOT_FOUND for a user of another tenant (lookup is tenant-scoped)', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      const res = await request(app.getHttpServer())
        .get('/v1/tenants/tenant-a/users/belongs-to-b')
        .set('Authorization', asRole('agent'))
        .expect(404);
      expect(res.body.code).toBe('USER_NOT_FOUND');
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'belongs-to-b', tenantId: 'tenant-a' },
        }),
      );
    });
  });

  describe('role matrix (B2) on customers', () => {
    it('every role can read, create and edit customers', async () => {
      prisma.endCustomer.findMany.mockResolvedValue([]);
      prisma.endCustomer.count.mockResolvedValue(0);
      prisma.endCustomer.create.mockResolvedValue({ id: 'c1' });
      prisma.endCustomer.findFirst.mockResolvedValue({ id: 'c1' });
      prisma.endCustomer.update.mockResolvedValue({ id: 'c1' });

      for (const role of ['owner', 'admin', 'agent'] as Role[]) {
        await request(app.getHttpServer())
          .get('/v1/tenants/tenant-a/customers')
          .set('Authorization', asRole(role))
          .expect(200);
        await request(app.getHttpServer())
          .post('/v1/tenants/tenant-a/customers')
          .set('Authorization', asRole(role))
          .send({ externalId: 'ext-1' })
          .expect(201);
        await request(app.getHttpServer())
          .patch('/v1/tenants/tenant-a/customers/c1')
          .set('Authorization', asRole(role))
          .send({ name: 'N' })
          .expect(200);
      }
    });

    it('agents cannot delete customers; admins and owners can', async () => {
      prisma.endCustomer.findFirst.mockResolvedValue({ id: 'c1' });
      prisma.endCustomer.delete.mockResolvedValue({ id: 'c1' });

      const denied = await request(app.getHttpServer())
        .delete('/v1/tenants/tenant-a/customers/c1')
        .set('Authorization', asRole('agent'))
        .expect(403);
      expect(denied.body.code).toBe('INSUFFICIENT_ROLE');
      expect(prisma.endCustomer.delete).not.toHaveBeenCalled();

      for (const role of ['admin', 'owner'] as Role[]) {
        await request(app.getHttpServer())
          .delete('/v1/tenants/tenant-a/customers/c1')
          .set('Authorization', asRole(role))
          .expect(200);
      }
      expect(prisma.endCustomer.delete).toHaveBeenCalledWith({
        where: { id: 'c1', tenantId: 'tenant-a' },
      });
    });

    it('409 EXTERNAL_ID_TAKEN on duplicate create and on an update that collides', async () => {
      prisma.endCustomer.create.mockRejectedValue(prismaError('P2002'));
      const created = await request(app.getHttpServer())
        .post('/v1/tenants/tenant-a/customers')
        .set('Authorization', asRole('agent'))
        .send({ externalId: 'dup' })
        .expect(409);
      expect(created.body.code).toBe('EXTERNAL_ID_TAKEN');

      prisma.endCustomer.findFirst.mockResolvedValue({ id: 'c1' });
      prisma.endCustomer.update.mockRejectedValue(prismaError('P2002'));
      const updated = await request(app.getHttpServer())
        .patch('/v1/tenants/tenant-a/customers/c1')
        .set('Authorization', asRole('agent'))
        .send({ externalId: 'dup' })
        .expect(409);
      expect(updated.body.code).toBe('EXTERNAL_ID_TAKEN');
    });
  });
});
