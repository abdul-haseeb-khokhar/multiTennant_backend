import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { hashToken } from '../src/common/tokens/tokens';
import { PREVIEW_LIMIT_PER_IP } from '../src/invites/invites.service';
import { WidgetCorsService } from '../src/widget/widget-cors.service';
import { mockTransaction, PrismaMock } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

type Role = 'owner' | 'admin' | 'agent';

/** Phase 3B: the defects the frontend prototype found (team-alignment J0). */
describe('Phase 3B: frontend gap-report fixes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let staffToken: Awaited<ReturnType<typeof createTestApp>>['staffToken'];
  let allowStaff: () => void;

  const http = () => request(app.getHttpServer());
  const as = (role: Role) =>
    `Bearer ${staffToken({ userId: `${role}-1`, tenantId: 'tenant-a', role })}`;

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
      status: 'active',
      defaultLocale: 'en',
    });
  });

  describe('passwords are limited to what bcrypt hashes (G23.11)', () => {
    const signup = (ownerPassword: string, extra: object = {}) =>
      http()
        .post('/v1/auth/signup')
        .send({
          tenantName: 'Acme',
          ownerEmail: 'owner@acme.com',
          ownerPassword,
          ...extra,
        });

    it('refuses a 100-character signup password before anything is written', async () => {
      const res = await signup('p'.repeat(100)).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details.join()).toMatch(/ownerPassword/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses 73 characters and a password longer than 72 BYTES', async () => {
      await signup('p'.repeat(73)).expect(400);
      await signup('é'.repeat(37)).expect(400);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not stop at the password rule for 72 characters (it reaches the database layer)', async () => {
      prisma.$transaction.mockRejectedValue(new Error('stop here'));
      await signup('p'.repeat(72)).expect(500);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('a locale outside the registry is refused, any registry locale passes validation', async () => {
      await signup('a-long-enough-password', { locale: 'fr' }).expect(400);
      prisma.$transaction.mockRejectedValue(new Error('stop here'));
      await signup('a-long-enough-password', { locale: 'ur' }).expect(500);
    });
  });

  describe('the user list hides account-security fields from agents (G23.3)', () => {
    const user = {
      id: 'u1',
      tenantId: 'tenant-a',
      email: 'u1@acme.com',
      role: 'agent',
      status: 'active',
      locale: null,
      createdAt: new Date('2026-10-01'),
    };

    it.each([
      ['agent', true],
      ['admin', false],
      ['owner', false],
    ] as const)('%s: security columns omitted = %s', async (role, hidden) => {
      prisma.tenantUser.findMany.mockResolvedValue([user]);
      prisma.tenantUser.count.mockResolvedValue(1);
      prisma.tenantUser.findFirst.mockResolvedValue(user);
      const expected = hidden
        ? { passwordHash: true, passwordChangedAt: true, emailVerifiedAt: true }
        : { passwordHash: true };

      await http()
        .get('/v1/tenants/tenant-a/users')
        .set('Authorization', as(role))
        .expect(200);
      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-a' },
          omit: expected,
        }),
      );

      await http()
        .get('/v1/tenants/tenant-a/users/u1')
        .set('Authorization', as(role))
        .expect(200);
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ omit: expected }),
      );
    });
  });

  describe('PATCH /v1/me accepts a null name (G29.1)', () => {
    const me = {
      id: 'agent-1',
      email: 'agent@acme.com',
      name: null,
      role: 'agent',
      emailVerifiedAt: new Date('2026-10-01'),
      locale: null,
      tenant: {
        id: 'tenant-a',
        name: 'Acme',
        slug: 'acme',
        plan: 'pro',
        status: 'active',
        defaultLocale: 'en',
      },
    };

    it('null clears the name; an empty string is still refused', async () => {
      prisma.tenantUser.update.mockResolvedValue({});
      prisma.tenantUser.findFirst.mockResolvedValue(me);
      const res = await http()
        .patch('/v1/me')
        .set('Authorization', as('agent'))
        .send({ name: null })
        .expect(200);
      expect(res.body.user.name).toBeNull();
      expect(prisma.tenantUser.update).toHaveBeenCalledWith({
        where: { id: 'agent-1', tenantId: 'tenant-a' },
        data: { name: null, locale: undefined },
      });
      await http()
        .patch('/v1/me')
        .set('Authorization', as('agent'))
        .send({ name: '' })
        .expect(400);
    });

    it('an unsupported locale is refused, null clears the language', async () => {
      prisma.tenantUser.update.mockResolvedValue({});
      prisma.tenantUser.findFirst.mockResolvedValue(me);
      await http()
        .patch('/v1/me')
        .set('Authorization', as('agent'))
        .send({ locale: 'xx' })
        .expect(400);
      await http()
        .patch('/v1/me')
        .set('Authorization', as('agent'))
        .send({ locale: null })
        .expect(200);
      expect(prisma.tenantUser.update).toHaveBeenCalledWith({
        where: { id: 'agent-1', tenantId: 'tenant-a' },
        data: { name: undefined, locale: null },
      });
    });
  });

  describe('invite preview for the accept page (G20)', () => {
    const token = 'tok-' + 'a'.repeat(40);
    const invite = (over: Record<string, unknown> = {}) => ({
      id: 'inv-1',
      tenantId: 'tenant-a',
      email: 'new@acme.com',
      role: 'admin',
      expiresAt: new Date(Date.now() + 86_400_000),
      acceptedAt: null,
      revokedAt: null,
      tenant: { name: 'Acme Support', status: 'active' },
      ...over,
    });

    it('is public and returns only tenant name, role, email and expiry', async () => {
      const row = invite();
      prisma.staffInvite.findUnique.mockResolvedValue(row);
      const res = await http()
        .get(`/v1/auth/invites/preview?token=${token}`)
        .expect(200);
      expect(res.body).toEqual({
        tenantName: 'Acme Support',
        role: 'admin',
        email: 'new@acme.com',
        expiresAt: row.expiresAt.toISOString(),
      });
      expect(prisma.staffInvite.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: hashToken(token) } }),
      );
    });

    it('unknown, used, revoked and expired tokens all give the identical 400 INVITE_INVALID', async () => {
      const bodies: string[] = [];
      for (const row of [
        null,
        invite({ acceptedAt: new Date() }),
        invite({ revokedAt: new Date() }),
        invite({ expiresAt: new Date(Date.now() - 1000) }),
      ]) {
        prisma.staffInvite.findUnique.mockResolvedValue(row);
        const res = await http()
          .get(`/v1/auth/invites/preview?token=${token}`)
          .expect(400);
        const { requestId: _ignored, ...rest } = res.body;
        bodies.push(JSON.stringify(rest));
      }
      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0])).toMatchObject({ code: 'INVITE_INVALID' });
    });

    it('needs a token', async () => {
      await http().get('/v1/auth/invites/preview').expect(400);
      await http().get('/v1/auth/invites/preview?token=').expect(400);
    });

    // Keep this one last in the block: it uses up the preview budget of the test client's address.
    it('is rate limited per IP with Retry-After in the header and the body, readable by the dashboard origin', async () => {
      prisma.staffInvite.findUnique.mockResolvedValue(null);
      let blocked: request.Response | undefined;
      for (let i = 0; i < PREVIEW_LIMIT_PER_IP + 1; i++) {
        const res = await http()
          .get(`/v1/auth/invites/preview?token=${token}`)
          .set('Origin', 'http://localhost:5173');
        if (res.status === 429) blocked = res;
      }
      expect(blocked).toBeDefined();
      expect(blocked!.body).toMatchObject({
        statusCode: 429,
        code: 'TOO_MANY_REQUESTS',
        retryAfterSeconds: expect.any(Number),
      });
      expect(Number(blocked!.headers['retry-after'])).toBe(
        blocked!.body.retryAfterSeconds,
      );
      expect(blocked!.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173',
      );
      // G29.4: a browser may only read Retry-After if CORS exposes it.
      expect(blocked!.headers['access-control-expose-headers']).toContain(
        'Retry-After',
      );
    });
  });

  describe('OpenAPI (G23.4, G23.5, G23.6, G23.13)', () => {
    let doc: any;
    beforeAll(async () => {
      doc = (await http().get('/docs-json').expect(200)).body;
    });

    it('every DELETE answers 200 with the removed object: one convention', () => {
      const deletes = Object.entries(doc.paths).filter(
        ([, item]: [string, any]) => item.delete,
      );
      expect(deletes.map(([path]) => path).sort()).toEqual([
        '/v1/admin/tenants/{id}',
        '/v1/tenants/{tenantId}/api-keys/{id}',
        '/v1/tenants/{tenantId}/customers/{id}',
        '/v1/tenants/{tenantId}/invites/{id}',
        '/v1/tenants/{tenantId}/users/{id}',
      ]);
      for (const [path, item] of deletes as [string, any][]) {
        const responses = Object.keys(item.delete.responses);
        expect([path, responses.includes('200')]).toEqual([path, true]);
        expect([path, responses.includes('204')]).toEqual([path, false]);
        expect(
          item.delete.responses['200'].content['application/json'].schema.$ref,
        ).toBeDefined();
      }
    });

    it('StaffInvite documents acceptedAt and revokedAt, and every emailed link is marked development-only', () => {
      const invite = doc.components.schemas.StaffInvite;
      expect(invite.properties).toHaveProperty('acceptedAt');
      expect(invite.properties).toHaveProperty('revokedAt');
      expect(invite.properties.link['x-dev-only']).toBe(true);
      expect(invite.properties.link.description).toMatch(/DEVELOPMENT ONLY/);
      for (const name of [
        'SignupResponse',
        'PasswordResetRequested',
        'VerificationSent',
      ]) {
        const schema = doc.components.schemas[name];
        const field =
          schema?.properties?.verificationLink ?? schema?.properties?.link;
        expect([name, field?.['x-dev-only']]).toEqual([name, true]);
      }
    });

    it('locale fields are plain strings, not an en|ur enum', () => {
      const fields: [string, string][] = [
        ['SignupDto', 'locale'],
        ['UpdateMeDto', 'locale'],
        ['CreateEndCustomerDto', 'locale'],
        ['UpdateTenantDto', 'defaultLocale'],
      ];
      for (const [schema, field] of fields) {
        const property = doc.components.schemas[schema].properties[field];
        expect([schema, property.type, property.enum]).toEqual([
          schema,
          'string',
          undefined,
        ]);
        expect(property.description).toMatch(/GET \/v1\/i18n\/locales/);
      }
    });

    it('documents the preview route and the password length rule', () => {
      expect(doc.paths['/v1/auth/invites/preview'].get).toBeDefined();
      const password =
        doc.components.schemas.SignupDto.properties.ownerPassword;
      expect(password).toMatchObject({ minLength: 8, maxLength: 72 });
    });
  });
});

/** `TRUST_PROXY`: the real `configureApp`, with and without a trusted proxy in front. */
describe('TRUST_PROXY (G25)', () => {
  @Controller('whoami')
  class WhoAmI {
    @Get()
    ip(@Req() req: Request) {
      return { ip: req.ip };
    }
  }

  async function appWith(trustProxy: string | undefined) {
    const module = await Test.createTestingModule({
      controllers: [WhoAmI],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'TRUST_PROXY' ? trustProxy : undefined,
          },
        },
        { provide: WidgetCorsService, useValue: { optionsFor: jest.fn() } },
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    return app;
  }

  const ipSeenBy = async (app: INestApplication, forwarded: string) =>
    (
      await request(app.getHttpServer())
        .get('/v1/whoami')
        .set('X-Forwarded-For', forwarded)
    ).body.ip as string;

  it('by default the forwarded header is ignored: every client looks like the socket address', async () => {
    const app = await appWith(undefined);
    expect(await ipSeenBy(app, '203.0.113.7')).toMatch(/127\.0\.0\.1$/);
    await app.close();
  });

  it('with one trusted proxy the client address from X-Forwarded-For is used', async () => {
    const app = await appWith('1');
    expect(await ipSeenBy(app, '203.0.113.7')).toBe('203.0.113.7');
    await app.close();
  });

  it('with one trusted proxy a forged leading entry does not win: the proxy-reported client does', async () => {
    const app = await appWith('1');
    expect(await ipSeenBy(app, '6.6.6.6, 203.0.113.7')).toBe('203.0.113.7');
    await app.close();
  });

  it('a trusted address list works too (loopback is the test client)', async () => {
    const app = await appWith('loopback');
    expect(await ipSeenBy(app, '198.51.100.9')).toBe('198.51.100.9');
    await app.close();
  });
});
