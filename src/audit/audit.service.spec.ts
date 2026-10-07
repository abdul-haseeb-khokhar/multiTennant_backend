import { Test, TestingModule } from '@nestjs/testing';
import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { requestStore } from '../common/request-context/request-store';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, sanitize } from './audit.service';

describe('sanitize', () => {
  it('removes secret-looking keys at any depth, case-insensitively', () => {
    expect(
      sanitize({
        email: 'a@b.co',
        passwordHash: 'x',
        Password: 'x',
        tokenHash: 'x',
        resetToken: 'x',
        link: 'http://x?token=t',
        apiSecret: 'x',
        nested: {
          keep: 1,
          authorization: 'Bearer x',
          deeper: [{ hash: 'x', ok: true }],
        },
      }),
    ).toEqual({
      email: 'a@b.co',
      nested: { keep: 1, deeper: [{ ok: true }] },
    });
  });

  it('turns dates into ISO strings and drops undefined and functions', () => {
    expect(
      sanitize({
        at: new Date('2026-10-07T10:00:00Z'),
        gone: undefined,
        fn: () => 1,
      }),
    ).toEqual({ at: '2026-10-07T10:00:00.000Z' });
  });

  it('returns undefined for nothing, and stops at a maximum depth', () => {
    expect(sanitize(undefined)).toBeUndefined();
    expect(sanitize(null)).toBeUndefined();
    let deep: any = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(JSON.stringify(sanitize(deep))).not.toContain('"v"');
  });
});

describe('AuditService', () => {
  let service: AuditService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [AuditService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(AuditService);
  });

  describe('record', () => {
    it('stores actor, target and sanitised before/after, with the request metadata', async () => {
      await requestStore.run(
        { requestId: 'req-1', ip: '1.2.3.4', userAgent: 'jest' },
        () =>
          service.record({
            tenantId: 'tenant-a',
            actor: { userId: 'u1', role: 'owner' },
            action: 'user.role_changed',
            targetType: 'user',
            targetId: 'u2',
            before: { role: 'agent', passwordHash: 'x' },
            after: { role: 'admin' },
          }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-a',
          actorUserId: 'u1',
          actorRole: 'owner',
          action: 'user.role_changed',
          targetType: 'user',
          targetId: 'u2',
          before: { role: 'agent' },
          after: { role: 'admin' },
          ip: '1.2.3.4',
          userAgent: 'jest',
          requestId: 'req-1',
        },
      });
    });

    it('works outside a request and for the system actor', async () => {
      await service.record({ tenantId: 'tenant-a', action: 'x' });
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-a',
        actorUserId: null,
        actorRole: null,
        ip: undefined,
        requestId: undefined,
      });
    });

    it('writes through the transaction client when given one', async () => {
      const tx = { auditLog: { create: jest.fn() } };
      await service.record({ tenantId: 'tenant-a', action: 'x' }, tx as any);
      expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('never stores a link or token that slipped into a snapshot', async () => {
      await service.record({
        tenantId: 'tenant-a',
        action: 'user.invited',
        after: {
          email: 'a@b.co',
          link: 'http://x?token=secret',
          tokenHash: 'h',
        },
      });
      const stored = JSON.stringify(prisma.auditLog.create.mock.calls[0][0]);
      expect(stored).not.toContain('secret');
      expect(stored).not.toContain('tokenHash');
    });
  });

  describe('findAll', () => {
    beforeEach(() => {
      prisma.auditLog.findMany.mockResolvedValue([{ id: 'l1' }]);
      prisma.auditLog.count.mockResolvedValue(1);
    });

    it('is scoped to the tenant, newest first, with the standard envelope', async () => {
      await expect(service.findAll('tenant-a', {})).resolves.toEqual({
        data: [{ id: 'l1' }],
        total: 1,
        skip: 0,
        take: 20,
      });
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a' },
        skip: 0,
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(prisma.auditLog.count).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a' },
      });
    });

    it('applies the actor, action, from and to filters, always together with the tenant', async () => {
      const from = new Date('2026-10-01');
      const to = new Date('2026-10-07');
      await service.findAll('tenant-a', {
        actor: 'u1',
        action: 'user.deleted',
        from,
        to,
        skip: 10,
        take: 5,
      });
      const where = {
        tenantId: 'tenant-a',
        actorUserId: 'u1',
        action: 'user.deleted',
        createdAt: { gte: from, lte: to },
      };
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where, skip: 10, take: 5 }),
      );
      expect(prisma.auditLog.count).toHaveBeenCalledWith({ where });
    });

    it('supports an open-ended date range', async () => {
      const from = new Date('2026-10-01');
      await service.findAll('tenant-a', { from });
      expect(prisma.auditLog.findMany.mock.calls[0][0].where).toEqual({
        tenantId: 'tenant-a',
        createdAt: { gte: from },
      });
    });

    it('caps take at 100', async () => {
      await expect(
        service.findAll('tenant-a', { take: 9999 }),
      ).resolves.toMatchObject({ take: 100 });
    });
  });
});
