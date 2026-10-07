import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';
import { PrismaMock } from './utils/prisma-mock';

describe('API conventions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let platformToken: () => string;
  let staffToken: (u: {
    userId: string;
    tenantId: string;
    role: string;
  }) => string;

  beforeAll(async () => {
    ({ app, prisma, platformToken, staffToken } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('health (F3)', () => {
    it('GET /health is unversioned and needs no auth', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('GET /health/ready checks the database', async () => {
      prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);
      expect(res.body).toEqual({ status: 'ok', database: 'up' });
    });

    it('GET /health/ready answers 503 SERVICE_UNAVAILABLE when the database is down', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(res.body).toMatchObject({
        statusCode: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
    });
  });

  describe('request id (F3)', () => {
    it('generates an X-Request-Id and includes it in error bodies', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/nope')
        .expect(404);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    it('keeps a safe caller-supplied id', async () => {
      const res = await request(app.getHttpServer())
        .get('/health')
        .set('X-Request-Id', 'trace-abc_123');
      expect(res.headers['x-request-id']).toBe('trace-abc_123');
    });

    it('replaces an unsafe caller-supplied id', async () => {
      const res = await request(app.getHttpServer())
        .get('/health')
        .set('X-Request-Id', 'bad id with spaces');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('routing (F5)', () => {
    it('serves the API under /v1 only', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({})
        .expect(404);
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({})
        .expect(400);
    });

    it('no longer exposes the old unauthenticated /tenants routes', async () => {
      await request(app.getHttpServer()).get('/tenants').expect(404);
      await request(app.getHttpServer()).delete('/tenants/some-id').expect(404);
    });

    it('GET / is gone (no Hello World)', async () => {
      await request(app.getHttpServer()).get('/').expect(404);
    });
  });

  describe('error body (F5)', () => {
    it('validation errors are { statusCode, code, message, details }', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/signup')
        .send({
          tenantName: 'Acme',
          ownerEmail: 'not-an-email',
          ownerPassword: 'short',
        })
        .expect(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
      });
      expect(res.body.details.length).toBeGreaterThanOrEqual(2);
    });

    it('unexpected errors become a generic 500 INTERNAL_ERROR without internals', async () => {
      prisma.tenant.findUnique.mockRejectedValue(new Error('secret db detail'));
      const token = staffToken({ userId: 'u1', tenantId: 't1', role: 'owner' });
      const res = await request(app.getHttpServer())
        .get('/v1/tenants/t1/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(500);
      expect(res.body).toMatchObject({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(JSON.stringify(res.body)).not.toContain('secret db detail');
    });
  });

  describe('pagination (G1)', () => {
    const tenant = 't1';
    const owner = () =>
      staffToken({ userId: 'u1', tenantId: tenant, role: 'owner' });

    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue({ status: 'active' });
      prisma.tenantUser.findMany.mockResolvedValue([]);
      prisma.tenantUser.count.mockResolvedValue(0);
    });

    it('lists come back as { data, total, skip, take } with take defaulting to 20', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([
        { id: 'u1', tenantId: tenant },
      ]);
      prisma.tenantUser.count.mockResolvedValue(41);

      const res = await request(app.getHttpServer())
        .get(`/v1/tenants/${tenant}/users`)
        .set('Authorization', `Bearer ${owner()}`)
        .expect(200);

      expect(res.body).toEqual({
        data: [{ id: 'u1', tenantId: tenant }],
        total: 41,
        skip: 0,
        take: 20,
      });
      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: tenant },
          skip: 0,
          take: 20,
        }),
      );
    });

    it('honours skip and take up to 100', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/tenants/${tenant}/users?skip=40&take=100`)
        .set('Authorization', `Bearer ${owner()}`)
        .expect(200);
      expect(res.body).toMatchObject({ skip: 40, take: 100 });
    });

    it('rejects take above 100 and a negative skip', async () => {
      const auth = { Authorization: `Bearer ${owner()}` };
      await request(app.getHttpServer())
        .get(`/v1/tenants/${tenant}/users?take=101`)
        .set(auth)
        .expect(400);
      await request(app.getHttpServer())
        .get(`/v1/tenants/${tenant}/users?skip=-1`)
        .set(auth)
        .expect(400);
    });

    it('platform tenant list uses the same envelope', async () => {
      prisma.platformAdmin.findUnique.mockResolvedValue({ id: 'admin-1' });
      prisma.tenant.findMany.mockResolvedValue([{ id: 't1' }]);
      prisma.tenant.count.mockResolvedValue(1);

      const res = await request(app.getHttpServer())
        .get('/v1/admin/tenants')
        .set('Authorization', `Bearer ${platformToken()}`)
        .expect(200);
      expect(res.body).toEqual({
        data: [{ id: 't1' }],
        total: 1,
        skip: 0,
        take: 20,
      });
    });
  });

  describe('CORS', () => {
    it('allows the configured dashboard origin only', async () => {
      const allowed = await request(app.getHttpServer())
        .get('/health')
        .set('Origin', 'http://localhost:5173');
      expect(allowed.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173',
      );

      const other = await request(app.getHttpServer())
        .get('/health')
        .set('Origin', 'https://evil.example');
      // The header always names the configured origin, so a browser on any other origin refuses.
      expect(other.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173',
      );
    });
  });

  describe('OpenAPI', () => {
    it('serves the document at /docs-json and the UI at /docs', async () => {
      const res = await request(app.getHttpServer())
        .get('/docs-json')
        .expect(200);
      const paths = Object.keys(res.body.paths);
      expect(paths).toEqual(
        expect.arrayContaining([
          '/v1/auth/login',
          '/v1/auth/signup',
          '/v1/admin/auth/login',
          '/v1/admin/tenants',
          '/v1/tenants/{tenantId}/users',
          '/v1/tenants/{tenantId}/users/{id}',
          '/v1/tenants/{tenantId}/customers',
          '/health',
        ]),
      );
      expect(paths.some((p) => p.startsWith('/tenants'))).toBe(false);
      expect(res.body.components.securitySchemes).toHaveProperty('bearer');

      await request(app.getHttpServer()).get('/docs').expect(200);
    });
  });
});
