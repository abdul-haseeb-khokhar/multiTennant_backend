import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mockTransaction, PrismaMock, prismaError } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

describe('Platform admin routes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let platformToken: (id?: string) => string;
  let allowStaff: () => void;
  let staffToken: (u: {
    userId: string;
    tenantId: string;
    role: string;
  }) => string;

  const asAdmin = () => `Bearer ${platformToken()}`;

  beforeAll(async () => {
    ({ app, prisma, platformToken, staffToken, allowStaff } =
      await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    allowStaff();
    mockTransaction(prisma);
    prisma.platformAdmin.findUnique.mockResolvedValue({ id: 'admin-1' });
  });

  it('401 without a token', async () => {
    await request(app.getHttpServer()).get('/v1/admin/tenants').expect(401);
    await request(app.getHttpServer())
      .patch('/v1/admin/tenants/t1')
      .send({ status: 'active' })
      .expect(401);
    await request(app.getHttpServer())
      .delete('/v1/admin/tenants/t1')
      .expect(401);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.tenant.delete).not.toHaveBeenCalled();
  });

  it('401 for a tenant owner token, whatever the tenant', async () => {
    const owner = staffToken({ userId: 'u1', tenantId: 't1', role: 'owner' });
    await request(app.getHttpServer())
      .get('/v1/admin/tenants')
      .set('Authorization', `Bearer ${owner}`)
      .expect(401);
  });

  it('401 once the platform admin has been deleted', async () => {
    prisma.platformAdmin.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get('/v1/admin/tenants')
      .set('Authorization', asAdmin())
      .expect(401);
  });

  it('there is no way to create a tenant here (signup is the only door)', async () => {
    await request(app.getHttpServer())
      .post('/v1/admin/tenants')
      .set('Authorization', asAdmin())
      .send({ name: 'X', plan: 'enterprise', status: 'active' })
      .expect(404);
  });

  it('GET /:id returns a tenant, 404 TENANT_NOT_FOUND otherwise', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ id: 't1', name: 'Acme' });
    await request(app.getHttpServer())
      .get('/v1/admin/tenants/t1')
      .set('Authorization', asAdmin())
      .expect(200);

    prisma.tenant.findUnique.mockResolvedValueOnce(null);
    const res = await request(app.getHttpServer())
      .get('/v1/admin/tenants/nope')
      .set('Authorization', asAdmin())
      .expect(404);
    expect(res.body.code).toBe('TENANT_NOT_FOUND');
  });

  it('PATCH changes plan and status (suspending a tenant)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 't1', status: 'active' });
    prisma.tenant.update.mockResolvedValue({
      id: 't1',
      plan: 'pro',
      status: 'suspended',
    });
    const res = await request(app.getHttpServer())
      .patch('/v1/admin/tenants/t1')
      .set('Authorization', asAdmin())
      .send({ plan: 'pro', status: 'suspended' })
      .expect(200);
    expect(res.body).toMatchObject({ plan: 'pro', status: 'suspended' });
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: {
        name: undefined,
        plan: 'pro',
        status: 'suspended',
        defaultLocale: undefined,
      },
    });
  });

  it("suspending a tenant is written to that tenant's audit log with the platform admin as actor (H6)", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 't1', status: 'active' });
    prisma.tenant.update.mockResolvedValue({ id: 't1', status: 'suspended' });
    await request(app.getHttpServer())
      .patch('/v1/admin/tenants/t1')
      .set('Authorization', asAdmin())
      .send({ status: 'suspended' })
      .expect(200);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenantId: 't1',
      actorUserId: 'admin-1',
      actorRole: 'platform_admin',
      action: 'tenant.suspended',
      before: { status: 'active' },
      after: { status: 'suspended' },
      requestId: expect.any(String),
    });
  });

  it('PATCH rejects an unknown plan or status', async () => {
    await request(app.getHttpServer())
      .patch('/v1/admin/tenants/t1')
      .set('Authorization', asAdmin())
      .send({ plan: 'platinum' })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/v1/admin/tenants/t1')
      .set('Authorization', asAdmin())
      .send({ status: 'deleted' })
      .expect(400);
  });

  it('PATCH answers 404 TENANT_NOT_FOUND on P2025', async () => {
    prisma.tenant.update.mockRejectedValue(prismaError('P2025'));
    const res = await request(app.getHttpServer())
      .patch('/v1/admin/tenants/nope')
      .set('Authorization', asAdmin())
      .send({ name: 'x' })
      .expect(404);
    expect(res.body.code).toBe('TENANT_NOT_FOUND');
  });

  it('DELETE answers 409 TENANT_HAS_DEPENDENCIES when users or customers still reference the tenant', async () => {
    prisma.tenant.delete.mockRejectedValue(prismaError('P2003'));
    const res = await request(app.getHttpServer())
      .delete('/v1/admin/tenants/t1')
      .set('Authorization', asAdmin())
      .expect(409);
    expect(res.body.code).toBe('TENANT_HAS_DEPENDENCIES');
  });
});
