import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mockTransaction, PrismaMock } from './utils/prisma-mock';
import { createTestApp } from './utils/test-app';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Phase 3C, J1: logout ends every session of the user, and only of that user. */
describe('Logout and token revocation (e2e, J1)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let staffToken: (
    user: { userId: string; tenantId: string; role: string },
    record?: object,
    issuedAt?: number,
  ) => string;
  let platformToken: (adminId?: string) => string;

  interface Row {
    id: string;
    tenantId: string;
    role: string;
    status: string;
    tokensValidAfter: Date | null;
  }
  let rows: Map<string, Row>;
  let admin: { id: string; tokensValidAfter: Date | null };

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => `Bearer ${token}`;
  const mint = (userId: string, tenantId = 'tenant-a', role = 'agent') =>
    staffToken({ userId, tenantId, role });

  beforeAll(async () => {
    ({ app, prisma, staffToken, platformToken } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    mockTransaction(prisma);
    rows = new Map(
      [
        ['agent-1', 'tenant-a', 'agent'],
        ['agent-2', 'tenant-a', 'agent'],
        ['owner-b', 'tenant-b', 'owner'],
      ].map(([id, tenantId, role]) => [
        id,
        { id, tenantId, role, status: 'active', tokensValidAfter: null },
      ]),
    );
    // A stateful stand-in for the user table: JwtStrategy reads it, logout writes it.
    prisma.tenantUser.findUnique.mockImplementation(
      ({ where }: { where: { id: string; tenantId?: string } }) => {
        const row = rows.get(where.id);
        return Promise.resolve(
          row && (!where.tenantId || where.tenantId === row.tenantId)
            ? {
                role: row.role,
                status: row.status,
                emailVerifiedAt: new Date('2026-01-01'),
                passwordChangedAt: null,
                tokensValidAfter: row.tokensValidAfter,
              }
            : null,
        );
      },
    );
    prisma.tenantUser.update.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string; tenantId: string };
        data: { tokensValidAfter: Date };
      }) => {
        const row = rows.get(where.id);
        if (!row || row.tenantId !== where.tenantId) {
          return Promise.reject(new Error('not found'));
        }
        row.tokensValidAfter = data.tokensValidAfter;
        return Promise.resolve({});
      },
    );
    prisma.tenant.findUnique.mockResolvedValue({ status: 'active' });
    prisma.tenantUser.findMany.mockResolvedValue([]);
    prisma.tenantUser.count.mockResolvedValue(0);

    admin = { id: 'admin-1', tokensValidAfter: null };
    prisma.platformAdmin.findUnique.mockImplementation(() =>
      Promise.resolve({ ...admin }),
    );
    prisma.platformAdmin.update.mockImplementation(
      ({ data }: { data: { tokensValidAfter: Date } }) => {
        admin.tokensValidAfter = data.tokensValidAfter;
        return Promise.resolve({});
      },
    );
    prisma.tenant.findMany.mockResolvedValue([]);
    prisma.tenant.count.mockResolvedValue(0);
  });

  const listUsers = (token: string, tenantId = 'tenant-a') =>
    http()
      .get(`/v1/tenants/${tenantId}/users`)
      .set('Authorization', bearer(token));

  describe('POST /v1/auth/logout', () => {
    it('answers 204, ends the token that was used and audits auth.logout without secrets', async () => {
      const token = mint('agent-1');
      await listUsers(token).expect(200);

      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer(token))
        .expect(204);

      expect(rows.get('agent-1')!.tokensValidAfter).toBeInstanceOf(Date);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const entry = prisma.auditLog.create.mock.calls[0][0].data;
      expect(entry).toMatchObject({
        tenantId: 'tenant-a',
        actorUserId: 'agent-1',
        actorRole: 'agent',
        action: 'auth.logout',
        targetType: 'user',
        targetId: 'agent-1',
      });
      expect(JSON.stringify(entry)).not.toContain(token);
      await listUsers(token).expect(401);
    });

    it('ends ALL sessions of the user (two tokens, "log out everywhere") and nobody else', async () => {
      const laptop = mint('agent-1');
      const phone = mint('agent-1');
      const colleague = mint('agent-2');

      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer(laptop))
        .expect(204);

      await listUsers(laptop).expect(401);
      await listUsers(phone).expect(401);
      await listUsers(colleague).expect(200);
      expect(rows.get('agent-2')!.tokensValidAfter).toBeNull();
    });

    it('a login right after the logout works, even within the same second', async () => {
      const old = mint('agent-1');
      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer(old))
        .expect(204);
      await sleep(5); // a real login takes far longer than this (bcrypt)
      const fresh = mint('agent-1');
      await listUsers(fresh).expect(200);
      await listUsers(old).expect(401);
    });

    it('a token issued in the same second but BEFORE the logout is still refused', async () => {
      // Both tokens fall in one wall-clock second; only the millisecond claim can tell them apart.
      const before = mint('agent-1');
      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer(mint('agent-1')))
        .expect(204);
      await listUsers(before).expect(401);
    });

    it('is refused without a token and with a platform token', async () => {
      await http().post('/v1/auth/logout').expect(401);
      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer(platformToken()))
        .expect(401);
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });

    it('works while the workspace is suspended (so old tokens do not revive on reactivation)', async () => {
      const token = mint('agent-1');
      prisma.tenant.findUnique.mockResolvedValue({ status: 'suspended' });
      await listUsers(token).expect(403);
      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer(token))
        .expect(204);
      prisma.tenant.findUnique.mockResolvedValue({ status: 'active' });
      await listUsers(token).expect(401);
    });

    it("only ever stamps the caller, scoped to the caller's own tenant", async () => {
      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer(mint('owner-b', 'tenant-b', 'owner')))
        .expect(204);
      expect(prisma.tenantUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'owner-b', tenantId: 'tenant-b' },
        }),
      );
      expect(rows.get('agent-1')!.tokensValidAfter).toBeNull();
    });

    it('is refused for a disabled user (their token is already dead)', async () => {
      const token = mint('agent-1');
      rows.get('agent-1')!.status = 'disabled';
      await http()
        .post('/v1/auth/logout')
        .set('Authorization', bearer(token))
        .expect(401);
    });
  });

  describe('POST /v1/admin/auth/logout', () => {
    it('ends every platform token of that admin and a new login works at once', async () => {
      const first = platformToken();
      const second = platformToken();
      await http()
        .get('/v1/admin/tenants')
        .set('Authorization', bearer(first))
        .expect(200);

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
        .expect(401);
      await sleep(5);
      await http()
        .get('/v1/admin/tenants')
        .set('Authorization', bearer(platformToken()))
        .expect(200);
    });

    it('is refused without a token and with a staff token', async () => {
      await http().post('/v1/admin/auth/logout').expect(401);
      await http()
        .post('/v1/admin/auth/logout')
        .set('Authorization', bearer(mint('agent-1')))
        .expect(401);
      expect(prisma.platformAdmin.update).not.toHaveBeenCalled();
    });
  });
});
