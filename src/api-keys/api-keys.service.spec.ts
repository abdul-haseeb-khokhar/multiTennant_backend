import { HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
} from '../../test/utils/prisma-mock';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { EntitlementsService } from '../billing/entitlements/entitlements.service';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { hashToken } from '../common/tokens/tokens';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeysService, MAX_ACTIVE_API_KEYS } from './api-keys.service';

const admin: AuthUser = {
  userId: 'admin-1',
  tenantId: 'tenant-a',
  role: 'admin',
  emailVerified: true,
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'key-1',
  tenantId: 'tenant-a',
  type: 'widget',
  name: 'Website',
  keyPrefix: 'wk_AbCd1',
  allowedOrigins: ['https://shop.example.com'],
  lastUsedAt: null,
  revokedAt: null,
  createdBy: 'admin-1',
  createdAt: new Date('2026-10-08T00:00:00Z'),
  ...over,
});

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('expected a rejection');
}

describe('ApiKeysService', () => {
  let service: ApiKeysService;
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let entitlements: { assert: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    entitlements = { assert: jest.fn().mockResolvedValue(undefined) };
    prisma.apiKey.count.mockResolvedValue(0);
    // Prisma applies `omit`; the mock must strip the hash itself.
    prisma.apiKey.create.mockImplementation(
      ({ data: { keyHash: _hash, ...data } }) => Promise.resolve(row(data)),
    );
    const module = await Test.createTestingModule({
      providers: [
        ApiKeysService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: EntitlementsService, useValue: entitlements },
      ],
    }).compile();
    service = module.get(ApiKeysService);
  });

  describe('create', () => {
    it('returns the full key once, stores only its hash, and audits without the key', async () => {
      const created = await service.create(
        'tenant-a',
        {
          name: 'Website',
          allowedOrigins: ['https://Shop.example.com/'],
        },
        admin,
      );
      expect(created.key).toMatch(/^wk_/);

      const data = prisma.apiKey.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        tenantId: 'tenant-a',
        type: 'widget',
        createdBy: 'admin-1',
        allowedOrigins: ['https://shop.example.com'],
      });
      expect(data.keyHash).toBe(hashToken(created.key));
      expect(JSON.stringify(data)).not.toContain(created.key);
      expect(prisma.apiKey.create.mock.calls[0][0].omit).toEqual({
        keyHash: true,
      });
      expect(created).not.toHaveProperty('keyHash');

      const entry = audit.record.mock.calls[0][0];
      expect(entry).toMatchObject({
        tenantId: 'tenant-a',
        action: 'apikey.created',
        actor: { userId: 'admin-1', role: 'admin' },
      });
      expect(JSON.stringify(entry)).not.toContain(created.key);
      expect(audit.record.mock.calls[0][1]).toBe(prisma);
    });

    it('needs chat in the plan for a widget key, but not for a server key', async () => {
      entitlements.assert.mockRejectedValue(
        new ApiException(
          HttpStatus.FORBIDDEN,
          ErrorCode.PLAN_FEATURE_UNAVAILABLE,
          'no chat',
        ),
      );
      const error = await rejection(
        service.create('tenant-a', { name: 'x' }, admin),
      );
      expect(error.code).toBe(ErrorCode.PLAN_FEATURE_UNAVAILABLE);
      expect(entitlements.assert).toHaveBeenCalledWith(
        'tenant-a',
        'channel:chat',
      );
      expect(prisma.apiKey.create).not.toHaveBeenCalled();

      await service.create('tenant-a', { name: 'x', type: 'server' }, admin);
      expect(prisma.apiKey.create).toHaveBeenCalled();
    });

    it('refuses an eleventh active key, counting only this tenants non-revoked keys', async () => {
      prisma.apiKey.count.mockResolvedValue(MAX_ACTIVE_API_KEYS);
      const error = await rejection(
        service.create('tenant-a', { name: 'x' }, admin),
      );
      expect(error.code).toBe(ErrorCode.API_KEY_LIMIT_REACHED);
      expect(error.getStatus()).toBe(409);
      expect(prisma.apiKey.count).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a', revokedAt: null },
      });
    });

    it('defaults to no origins, which means the key works nowhere', async () => {
      await service.create('tenant-a', { name: 'x' }, admin);
      expect(prisma.apiKey.create.mock.calls[0][0].data.allowedOrigins).toEqual(
        [],
      );
    });
  });

  describe('reading is scoped to the tenant and never returns the hash', () => {
    it('lists only the tenant keys, hiding revoked ones unless asked', async () => {
      prisma.apiKey.findMany.mockResolvedValue([row()]);
      prisma.apiKey.count.mockResolvedValue(1);
      await service.findAll('tenant-a', {});
      expect(prisma.apiKey.findMany.mock.calls[0][0]).toMatchObject({
        where: { tenantId: 'tenant-a', revokedAt: null },
        omit: { keyHash: true },
      });
      await service.findAll('tenant-a', { includeRevoked: true });
      expect(prisma.apiKey.findMany.mock.calls[1][0].where).toEqual({
        tenantId: 'tenant-a',
      });
    });

    it('findOne asks for id AND tenant, so another tenants key is a 404', async () => {
      prisma.apiKey.findFirst.mockResolvedValue(null);
      const error = await rejection(service.findOne('tenant-b', 'key-1'));
      expect(error.code).toBe(ErrorCode.API_KEY_NOT_FOUND);
      expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
        where: { id: 'key-1', tenantId: 'tenant-b' },
        omit: { keyHash: true },
      });
    });
  });

  describe('update', () => {
    it('replaces the origins, scoped to the tenant, and audits before and after', async () => {
      prisma.apiKey.findFirst
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(undefined);
      prisma.apiKey.updateMany.mockResolvedValue({ count: 1 });
      prisma.apiKey.findFirstOrThrow.mockResolvedValue(
        row({ allowedOrigins: ['https://new.example.com'] }),
      );
      const updated = await service.update(
        'tenant-a',
        'key-1',
        { allowedOrigins: ['https://New.example.com'] },
        admin,
      );
      expect(updated.allowedOrigins).toEqual(['https://new.example.com']);
      expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
        where: { id: 'key-1', tenantId: 'tenant-a', revokedAt: null },
        data: { allowedOrigins: ['https://new.example.com'] },
      });
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: 'apikey.updated',
        before: { allowedOrigins: ['https://shop.example.com'] },
        after: { allowedOrigins: ['https://new.example.com'] },
      });
    });

    it('does not change a revoked key and does not touch another tenant', async () => {
      prisma.apiKey.findFirst.mockResolvedValueOnce(
        row({ revokedAt: new Date() }),
      );
      const revoked = await rejection(
        service.update('tenant-a', 'key-1', { name: 'x' }, admin),
      );
      expect(revoked.getStatus()).toBe(409);

      prisma.apiKey.findFirst.mockResolvedValueOnce(null);
      const other = await rejection(
        service.update('tenant-b', 'key-1', { name: 'x' }, admin),
      );
      expect(other.code).toBe(ErrorCode.API_KEY_NOT_FOUND);
      expect(prisma.apiKey.updateMany).not.toHaveBeenCalled();
    });

    it('an empty update changes and audits nothing', async () => {
      prisma.apiKey.findFirst.mockResolvedValue(row());
      await service.update('tenant-a', 'key-1', {}, admin);
      expect(prisma.apiKey.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('revokes once, scoped to the tenant, and audits', async () => {
      prisma.apiKey.updateMany.mockResolvedValue({ count: 1 });
      prisma.apiKey.findFirst.mockResolvedValue(row({ revokedAt: new Date() }));
      const revoked = await service.revoke('tenant-a', 'key-1', admin);
      expect(revoked.revokedAt).not.toBeNull();
      expect(prisma.apiKey.updateMany.mock.calls[0][0].where).toEqual({
        id: 'key-1',
        tenantId: 'tenant-a',
        revokedAt: null,
      });
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: 'apikey.revoked',
        targetId: 'key-1',
      });
    });

    it('is idempotent: a second revoke changes and records nothing', async () => {
      prisma.apiKey.updateMany.mockResolvedValue({ count: 0 });
      prisma.apiKey.findFirst.mockResolvedValue(row({ revokedAt: new Date() }));
      await service.revoke('tenant-a', 'key-1', admin);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('answers 404 for a key of another tenant', async () => {
      prisma.apiKey.updateMany.mockResolvedValue({ count: 0 });
      prisma.apiKey.findFirst.mockResolvedValue(null);
      const error = await rejection(service.revoke('tenant-b', 'key-1', admin));
      expect(error.code).toBe(ErrorCode.API_KEY_NOT_FOUND);
    });
  });

  describe('widget key resolution', () => {
    it('finds an active widget key by the hash of what the browser sent', async () => {
      prisma.apiKey.findUnique.mockResolvedValue(row());
      const found = await service.resolveWidgetKey('wk_theKeyTheBrowserSent');
      expect(found?.id).toBe('key-1');
      expect(prisma.apiKey.findUnique).toHaveBeenCalledWith({
        where: { keyHash: hashToken('wk_theKeyTheBrowserSent') },
        omit: { keyHash: true },
      });
    });

    it.each([
      ['unknown', null],
      ['revoked', row({ revokedAt: new Date() })],
      ['a server key', row({ type: 'server' })],
    ])(
      'answers null for %s, so the caller cannot tell the cases apart',
      async (_label, found) => {
        prisma.apiKey.findUnique.mockResolvedValue(found);
        await expect(service.resolveWidgetKey('wk_x')).resolves.toBeNull();
      },
    );

    it('re-reads the key a token names within the tokens tenant only', async () => {
      prisma.apiKey.findFirst.mockResolvedValue(row());
      await service.findActiveWidgetKey('tenant-a', 'key-1');
      expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'key-1',
          tenantId: 'tenant-a',
          type: 'widget',
          revokedAt: null,
        },
        omit: { keyHash: true },
      });
    });

    it('compares origins in canonical form and refuses a missing one', () => {
      const key = { allowedOrigins: ['https://shop.example.com'] };
      expect(service.originAllowed(key, 'https://shop.example.com')).toBe(true);
      expect(service.originAllowed(key, 'HTTPS://SHOP.example.com/')).toBe(
        true,
      );
      expect(service.originAllowed(key, 'https://evil.example.com')).toBe(
        false,
      );
      expect(
        service.originAllowed(key, 'https://shop.example.com.evil.com'),
      ).toBe(false);
      expect(service.originAllowed(key, undefined)).toBe(false);
      expect(service.originAllowed({ allowedOrigins: [] }, 'null')).toBe(false);
    });

    it('writes last_used_at at most every few minutes and never throws', async () => {
      prisma.apiKey.updateMany.mockRejectedValue(new Error('db down'));
      expect(() => service.touch('tenant-a', 'key-1')).not.toThrow();
      await Promise.resolve();
      const where = prisma.apiKey.updateMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ id: 'key-1', tenantId: 'tenant-a' });
      expect(where.OR).toHaveLength(2);
    });
  });
});
