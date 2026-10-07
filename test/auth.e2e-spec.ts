import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { mockTransaction, PrismaMock, prismaError } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let passwordHash: string;
  let allowStaff: () => void;

  beforeAll(async () => {
    ({ app, prisma, allowStaff } = await createTestApp());
    passwordHash = bcrypt.hashSync(PASSWORD, 4);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // Run transaction callbacks against the same mock client.
    mockTransaction(prisma);
    allowStaff();
  });

  describe('POST /v1/auth/signup', () => {
    const body = {
      tenantName: 'Acme Support',
      ownerEmail: 'owner@acme.com',
      ownerPassword: PASSWORD,
    };

    beforeEach(() => {
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

    it('creates the tenant and its owner and returns a usable token', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/signup')
        .send(body)
        .expect(201);

      expect(res.body.tenant).toMatchObject({
        id: 't1',
        slug: 'acme-support',
        plan: 'free',
        status: 'trial',
      });
      expect(res.body.owner).toMatchObject({ role: 'owner' });
      expect(res.body.owner).not.toHaveProperty('passwordHash');
      expect(prisma.tenantUser.create).toHaveBeenCalledWith(
        expect.objectContaining({ omit: { passwordHash: true } }),
      );

      // MAIL_MODE=link (development): the verification link comes back in the response
      expect(res.body.verificationLink).toMatch(
        /^http:\/\/localhost:5173\/verify-email\?token=[A-Za-z0-9_-]{43}$/,
      );
      expect(prisma.emailVerification.create).toHaveBeenCalledTimes(1);

      // the token is accepted by a guarded route (the strategy finds the new owner)
      prisma.tenantUser.findUnique.mockResolvedValue({
        role: 'owner',
        status: 'active',
        emailVerifiedAt: null,
        passwordChangedAt: null,
      });
      prisma.tenant.findUnique.mockResolvedValue({ status: 'trial' });
      prisma.tenantUser.findMany.mockResolvedValue([]);
      prisma.tenantUser.count.mockResolvedValue(0);
      await request(app.getHttpServer())
        .get('/v1/tenants/t1/users')
        .set('Authorization', `Bearer ${res.body.access_token}`)
        .expect(200);
    });

    it('ignores plan and status sent by the caller (B1)', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/signup')
        .send({ ...body, plan: 'enterprise', status: 'active', role: 'admin' })
        .expect(201);

      expect(prisma.tenant.create).toHaveBeenCalledWith({
        data: {
          name: 'Acme Support',
          slug: 'acme-support',
          defaultLocale: 'en',
        },
      });
      expect(prisma.tenantUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: 'owner' }),
        }),
      );
    });

    it('answers 409 SLUG_TAKEN when an explicit slug already exists', async () => {
      prisma.tenant.create.mockRejectedValue(prismaError('P2002'));

      const res = await request(app.getHttpServer())
        .post('/v1/auth/signup')
        .send({ ...body, tenantSlug: 'acme' })
        .expect(409);
      expect(res.body).toMatchObject({ statusCode: 409, code: 'SLUG_TAKEN' });
      expect(prisma.tenant.create).toHaveBeenCalledTimes(1);
    });

    it('retries a derived slug with a suffix when it collides', async () => {
      prisma.tenant.create
        .mockRejectedValueOnce(prismaError('P2002'))
        .mockImplementation(({ data }) =>
          Promise.resolve({ id: 't1', ...data }),
        );

      const res = await request(app.getHttpServer())
        .post('/v1/auth/signup')
        .send(body)
        .expect(201);
      expect(res.body.tenant.slug).toMatch(/^acme-support-[0-9a-f]{6}$/);
    });

    it('refuses a reserved slug', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/signup')
        .send({ ...body, tenantSlug: 'admin' })
        .expect(409);
      expect(res.body.code).toBe('SLUG_TAKEN');
      expect(prisma.tenant.create).not.toHaveBeenCalled();
    });

    it('rejects a malformed slug and a short password', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/signup')
        .send({ ...body, tenantSlug: 'Not A Slug!' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/v1/auth/signup')
        .send({ ...body, ownerPassword: 'short' })
        .expect(400);
    });
  });

  describe('POST /v1/auth/login', () => {
    const login = (over: Record<string, string> = {}) =>
      request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({
          tenantSlug: 'acme',
          email: 'owner@acme.com',
          password: PASSWORD,
          ...over,
        });

    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        slug: 'acme',
        status: 'active',
      });
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u1',
        tenantId: 't1',
        email: 'owner@acme.com',
        role: 'owner',
        status: 'active',
        passwordHash,
      });
    });

    it('logs in by tenant slug (B3) and returns a token', async () => {
      const res = await login({ tenantSlug: ' ACME ' }).expect(201);
      expect(res.body.access_token).toEqual(expect.any(String));
      expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
        where: { slug: 'acme' },
      });
      // the user lookup is scoped to the tenant the slug resolved to
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 't1', email: 'owner@acme.com' },
      });
    });

    it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
      const res = await login({ password: 'wrong-password' }).expect(401);
      expect(res.body).toMatchObject({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
      });
    });

    it('answers an unknown tenant and an unknown user exactly like a wrong password', async () => {
      const wrongPassword = await login({ password: 'wrong-password' }).expect(
        401,
      );

      prisma.tenant.findUnique.mockResolvedValue(null);
      const noTenant = await login().expect(401);

      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        status: 'active',
      });
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      const noUser = await login().expect(401);

      for (const res of [noTenant, noUser]) {
        expect(res.body.code).toBe(wrongPassword.body.code);
        expect(res.body.message).toBe(wrongPassword.body.message);
      }
    });

    it('refuses a suspended tenant with 403 TENANT_SUSPENDED (B6)', async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        slug: 'acme',
        status: 'suspended',
      });
      const res = await login().expect(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        code: 'TENANT_SUSPENDED',
      });
    });

    it('no longer accepts a tenant UUID in place of the slug', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ tenantId: 't1', email: 'owner@acme.com', password: PASSWORD })
        .expect(400);
    });
  });

  describe('POST /v1/admin/auth/login', () => {
    it('logs a platform admin in and the token carries scope "platform"', async () => {
      prisma.platformAdmin.findUnique.mockResolvedValue({
        id: 'admin-1',
        email: 'ops@example.com',
        passwordHash,
      });

      const res = await request(app.getHttpServer())
        .post('/v1/admin/auth/login')
        .send({ email: 'ops@example.com', password: PASSWORD })
        .expect(201);

      const claims = JSON.parse(
        Buffer.from(
          res.body.access_token.split('.')[1],
          'base64url',
        ).toString(),
      );
      expect(claims).toMatchObject({ sub: 'admin-1', scope: 'platform' });
      expect(claims).not.toHaveProperty('tenantId');
    });

    it('rejects bad credentials with 401 INVALID_CREDENTIALS', async () => {
      prisma.platformAdmin.findUnique.mockResolvedValue(null);
      const res = await request(app.getHttpServer())
        .post('/v1/admin/auth/login')
        .send({ email: 'ops@example.com', password: PASSWORD })
        .expect(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('does not accept a tenant staff login on the platform route', async () => {
      prisma.platformAdmin.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .post('/v1/admin/auth/login')
        .send({
          tenantSlug: 'acme',
          email: 'owner@acme.com',
          password: PASSWORD,
        })
        .expect(401);
      expect(prisma.tenantUser.findFirst).not.toHaveBeenCalled();
    });
  });
});
