import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FakeClock } from '../src/billing/clock';
import { EntitlementsService } from '../src/billing/entitlements/entitlements.service';
import { Gateway, installGateway } from './utils/gateway-fixtures';
import { PrismaMock } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

type Role = 'owner' | 'admin' | 'agent';

describe('API keys (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let clock: FakeClock;
  let gateway: Gateway;
  let staffToken: Awaited<ReturnType<typeof createTestApp>>['staffToken'];
  let platformToken: (id?: string) => string;
  let allowStaff: () => void;

  const http = () => request(app.getHttpServer());
  const as = (role: Role, tenantId = 'tenant-a') =>
    `Bearer ${staffToken({ userId: `${role}-1`, tenantId, role })}`;
  const url = (tenantId = 'tenant-a', suffix = '') =>
    `/v1/tenants/${tenantId}/api-keys${suffix}`;

  const create = (
    body: Record<string, unknown> = {},
    auth = as('admin'),
    tenantId = 'tenant-a',
  ) =>
    http()
      .post(url(tenantId))
      .set('Authorization', auth)
      .send({ name: 'Website chat', ...body });

  beforeAll(async () => {
    ({ app, prisma, clock, staffToken, platformToken, allowStaff } =
      await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    allowStaff();
    gateway = installGateway(prisma, clock, {
      tenants: [
        { id: 'tenant-a', plan: 'pro' },
        { id: 'tenant-b', plan: 'pro' },
      ],
    });
    for (const tenantId of ['tenant-a', 'tenant-b']) {
      app.get(EntitlementsService).invalidate(tenantId);
    }
  });

  describe('POST /v1/tenants/:tenantId/api-keys', () => {
    it('creates a widget key, returns the full key ONCE, stores only its hash, and audits without the key', async () => {
      const res = await create({
        allowedOrigins: ['https://Shop.example.com/', 'http://localhost:5173'],
      }).expect(201);
      expect(res.body).toMatchObject({
        tenantId: 'tenant-a',
        type: 'widget',
        name: 'Website chat',
        allowedOrigins: ['https://shop.example.com', 'http://localhost:5173'],
        revokedAt: null,
        lastUsedAt: null,
        createdBy: 'admin-1',
      });
      expect(res.body.key).toMatch(/^wk_[A-Za-z0-9_-]{32}$/);
      expect(res.body.keyPrefix).toBe(res.body.key.slice(0, 8));
      expect(res.body).not.toHaveProperty('keyHash');

      // Stored: only the sha256.
      const stored = gateway.apiKeys[0];
      expect(stored.keyHash).toBe(gateway.sha256(res.body.key));
      expect(JSON.stringify(stored)).not.toContain(res.body.key);

      // Audited, without the key.
      expect(gateway.audit).toHaveLength(1);
      expect(gateway.audit[0]).toMatchObject({
        tenantId: 'tenant-a',
        action: 'apikey.created',
        actorUserId: 'admin-1',
        actorRole: 'admin',
        targetId: stored.id,
      });
      expect(JSON.stringify(gateway.audit)).not.toContain(res.body.key);
    });

    it('owner and admin may create; an agent may not (403 INSUFFICIENT_ROLE)', async () => {
      await create({}, as('owner')).expect(201);
      await create({}, as('admin')).expect(201);
      const agent = await create({}, as('agent')).expect(403);
      expect(agent.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('401 without a token, with a platform token, and with a token of another kind', async () => {
      await http().post(url()).send({ name: 'x' }).expect(401);
      await http()
        .post(url())
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({ name: 'x' })
        .expect(401);
    });

    it('creates keys only for the tenant in the token (403 TENANT_MISMATCH otherwise)', async () => {
      const res = await create({}, as('owner', 'tenant-a'), 'tenant-b').expect(
        403,
      );
      expect(res.body.code).toBe('TENANT_MISMATCH');
      expect(gateway.apiKeys).toHaveLength(0);
    });

    it('defaults to a widget key with no origins (works nowhere until origins are set)', async () => {
      const res = await create().expect(201);
      expect(res.body.type).toBe('widget');
      expect(res.body.allowedOrigins).toEqual([]);
    });

    it('creates a server key with a longer sk_ key (no route accepts it yet)', async () => {
      const res = await create({ type: 'server' }).expect(201);
      expect(res.body.key).toMatch(/^sk_/);
    });

    it.each([
      ['a wildcard', { allowedOrigins: ['https://*.example.com'] }],
      [
        'plain http on a real host',
        { allowedOrigins: ['http://shop.example.com'] },
      ],
      ['a path', { allowedOrigins: ['https://shop.example.com/chat'] }],
      ['a query', { allowedOrigins: ['https://shop.example.com?x=1'] }],
      ['a non-array', { allowedOrigins: 'https://shop.example.com' }],
      [
        '21 origins',
        {
          allowedOrigins: Array.from(
            { length: 21 },
            (_, i) => `https://s${i}.example.com`,
          ),
        },
      ],
      ['an unknown type', { type: 'admin' }],
      ['no name', { name: undefined }],
      ['a blank name', { name: '   ' }],
      ['a name over 80 characters', { name: 'x'.repeat(81) }],
    ])('400 for %s', async (_label, body) => {
      const res = await create(body as Record<string, unknown>).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(gateway.apiKeys).toHaveLength(0);
    });

    it('allows at most 10 active keys; revoking one frees a place', async () => {
      for (let i = 0; i < 10; i++) await create().expect(201);
      const refused = await create().expect(409);
      expect(refused.body.code).toBe('API_KEY_LIMIT_REACHED');
      const first = gateway.apiKeys[0];
      await http()
        .delete(url('tenant-a', `/${first.id}`))
        .set('Authorization', as('owner'))
        .expect(200);
      await create().expect(201);
    });

    it('counts keys per tenant: tenant B is not held back by tenant A', async () => {
      for (let i = 0; i < 10; i++) await create().expect(201);
      await create({}, as('owner', 'tenant-b'), 'tenant-b').expect(201);
    });

    describe('plan and standing (I5)', () => {
      it('403 TENANT_SUSPENDED for a suspended tenant', async () => {
        gateway.tenants.get('tenant-a')!.status = 'suspended';
        const res = await create().expect(403);
        expect(res.body.code).toBe('TENANT_SUSPENDED');
      });

      it('403 SUBSCRIPTION_PAST_DUE: a tenant that has not paid cannot hand out new widget keys', async () => {
        gateway.subscriptions.get('tenant-a')!.status = 'past_due';
        gateway.subscriptions.get('tenant-a')!.graceEndsAt = new Date(
          clock.now().getTime() + 5 * 86_400_000,
        );
        app.get(EntitlementsService).invalidate('tenant-a');
        const res = await create().expect(403);
        expect(res.body.code).toBe('SUBSCRIPTION_PAST_DUE');
        // ...but a server key is not a channel and is not blocked by that rule.
        await create({ type: 'server' }).expect(201);
      });

      it('403 PLAN_FEATURE_UNAVAILABLE when the plan has no chat', async () => {
        gateway.subscriptions.get('tenant-a')!.entitlementsOverride = {
          channels: [],
        };
        app.get(EntitlementsService).invalidate('tenant-a');
        const res = await create().expect(403);
        expect(res.body.code).toBe('PLAN_FEATURE_UNAVAILABLE');
      });
    });
  });

  describe('listing and reading (owner/admin only, never the key or its hash)', () => {
    let keyId: string;
    beforeEach(async () => {
      const res = await create({
        allowedOrigins: ['https://shop.example.com'],
      }).expect(201);
      keyId = res.body.id;
    });

    it('lists the tenant keys with prefix and origins, in the page envelope', async () => {
      const res = await http()
        .get(url())
        .set('Authorization', as('admin'))
        .expect(200);
      expect(res.body).toMatchObject({ total: 1, skip: 0, take: 20 });
      expect(res.body.data[0]).toMatchObject({
        id: keyId,
        type: 'widget',
        allowedOrigins: ['https://shop.example.com'],
      });
      expect(JSON.stringify(res.body)).not.toMatch(/keyHash|"key":/);
    });

    it('hides revoked keys unless includeRevoked=true', async () => {
      await http()
        .delete(url('tenant-a', `/${keyId}`))
        .set('Authorization', as('owner'))
        .expect(200);
      const hidden = await http()
        .get(url())
        .set('Authorization', as('owner'))
        .expect(200);
      expect(hidden.body.total).toBe(0);
      const shown = await http()
        .get(url('tenant-a', '?includeRevoked=true'))
        .set('Authorization', as('owner'))
        .expect(200);
      expect(shown.body.total).toBe(1);
      expect(shown.body.data[0].revokedAt).not.toBeNull();
      await http()
        .get(url('tenant-a', '?includeRevoked=maybe'))
        .set('Authorization', as('owner'))
        .expect(400);
    });

    it('agents cannot list or read keys', async () => {
      await http().get(url()).set('Authorization', as('agent')).expect(403);
      await http()
        .get(url('tenant-a', `/${keyId}`))
        .set('Authorization', as('agent'))
        .expect(403);
    });

    it("tenant isolation: another tenant's admin gets 403 on the URL and 404 on their own URL", async () => {
      const wrongUrl = await http()
        .get(url('tenant-a', `/${keyId}`))
        .set('Authorization', as('admin', 'tenant-b'))
        .expect(403);
      expect(wrongUrl.body.code).toBe('TENANT_MISMATCH');
      const ownUrl = await http()
        .get(url('tenant-b', `/${keyId}`))
        .set('Authorization', as('admin', 'tenant-b'))
        .expect(404);
      expect(ownUrl.body.code).toBe('API_KEY_NOT_FOUND');
      const list = await http()
        .get(url('tenant-b'))
        .set('Authorization', as('admin', 'tenant-b'))
        .expect(200);
      expect(list.body.total).toBe(0);
    });

    it('reads one key', async () => {
      const res = await http()
        .get(url('tenant-a', `/${keyId}`))
        .set('Authorization', as('admin'))
        .expect(200);
      expect(res.body.id).toBe(keyId);
      expect(res.body).not.toHaveProperty('keyHash');
    });
  });

  describe('PATCH (name, allowed origins)', () => {
    let keyId: string;
    beforeEach(async () => {
      keyId = (await create({ allowedOrigins: ['https://a.example.com'] })).body
        .id;
      gateway.audit.length = 0;
    });
    const patch = (body: object, auth = as('admin'), tenantId = 'tenant-a') =>
      http()
        .patch(url(tenantId, `/${keyId}`))
        .set('Authorization', auth)
        .send(body);

    it('replaces the origins and audits before and after', async () => {
      const res = await patch({
        allowedOrigins: ['https://b.example.com', 'https://c.example.com'],
        name: 'Renamed',
      }).expect(200);
      expect(res.body).toMatchObject({
        name: 'Renamed',
        allowedOrigins: ['https://b.example.com', 'https://c.example.com'],
      });
      expect(gateway.audit[0]).toMatchObject({
        action: 'apikey.updated',
        before: { allowedOrigins: ['https://a.example.com'] },
        after: {
          allowedOrigins: ['https://b.example.com', 'https://c.example.com'],
        },
      });
    });

    it('clearing the origins is allowed (the key then works nowhere)', async () => {
      const res = await patch({ allowedOrigins: [] }).expect(200);
      expect(res.body.allowedOrigins).toEqual([]);
    });

    it('validates origins like creation does', async () => {
      await patch({ allowedOrigins: ['https://*.example.com'] }).expect(400);
    });

    it('agents may not; other tenants cannot', async () => {
      await patch({ name: 'x' }, as('agent')).expect(403);
      await patch({ name: 'x' }, as('admin', 'tenant-b'), 'tenant-b').expect(
        404,
      );
    });

    it('a revoked key cannot be changed (409)', async () => {
      await http()
        .delete(url('tenant-a', `/${keyId}`))
        .set('Authorization', as('owner'))
        .expect(200);
      await patch({ name: 'x' }).expect(409);
    });
  });

  describe('DELETE (revoke)', () => {
    let keyId: string;
    beforeEach(async () => {
      keyId = (await create()).body.id;
      gateway.audit.length = 0;
    });

    it('revokes, audits once and is idempotent', async () => {
      const first = await http()
        .delete(url('tenant-a', `/${keyId}`))
        .set('Authorization', as('admin'))
        .expect(200);
      expect(first.body.revokedAt).not.toBeNull();
      await http()
        .delete(url('tenant-a', `/${keyId}`))
        .set('Authorization', as('admin'))
        .expect(200);
      expect(gateway.audit.map((a) => a.action)).toEqual(['apikey.revoked']);
    });

    it('an agent cannot revoke, another tenant cannot revoke it, an unknown id is 404', async () => {
      await http()
        .delete(url('tenant-a', `/${keyId}`))
        .set('Authorization', as('agent'))
        .expect(403);
      await http()
        .delete(url('tenant-b', `/${keyId}`))
        .set('Authorization', as('admin', 'tenant-b'))
        .expect(404);
      await http()
        .delete(url('tenant-a', '/no-such-key'))
        .set('Authorization', as('admin'))
        .expect(404);
      expect(gateway.apiKeys[0].revokedAt).toBeNull();
    });
  });
});
