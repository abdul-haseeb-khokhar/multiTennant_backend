import { Test, TestingModule } from '@nestjs/testing';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantsService } from './tenants.service';

describe('TenantsService (platform admin)', () => {
  let service: TenantsService;
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(TenantsService);
  });

  it('has no create: tenants come into existence through signup only', () => {
    expect(
      (service as unknown as Record<string, unknown>).create,
    ).toBeUndefined();
  });

  describe('findAll', () => {
    it('returns the envelope with default take=20 and a stable order', async () => {
      prisma.tenant.findMany.mockResolvedValue([{ id: '1' }]);
      prisma.tenant.count.mockResolvedValue(1);

      await expect(service.findAll({})).resolves.toEqual({
        data: [{ id: '1' }],
        total: 1,
        skip: 0,
        take: 20,
      });
      expect(prisma.tenant.findMany).toHaveBeenCalledWith({
        skip: 0,
        take: 20,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    });

    it('caps take at 100', async () => {
      prisma.tenant.findMany.mockResolvedValue([]);
      prisma.tenant.count.mockResolvedValue(0);
      await expect(service.findAll({ take: 999 })).resolves.toMatchObject({
        take: 100,
      });
    });
  });

  describe('findOne', () => {
    it('returns the tenant when found', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: '1', name: 'Acme' });
      await expect(service.findOne('1')).resolves.toEqual({
        id: '1',
        name: 'Acme',
      });
    });

    it('throws 404 TENANT_NOT_FOUND when missing', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toMatchObject({
        status: 404,
        response: { code: 'TENANT_NOT_FOUND' },
      });
    });
  });

  describe('update', () => {
    const existing = (status = 'active') => ({
      id: '1',
      name: 'Acme',
      status,
      plan: 'free',
    });

    it('can change name, plan, status and default language', async () => {
      prisma.tenant.findUnique.mockResolvedValue(existing());
      prisma.tenant.update.mockResolvedValue({ id: '1', status: 'suspended' });
      await service.update(
        '1',
        { status: 'suspended', plan: 'pro', defaultLocale: 'ur' },
        'admin-1',
      );
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: {
          name: undefined,
          plan: 'pro',
          status: 'suspended',
          defaultLocale: 'ur',
        },
      });
    });

    it('records tenant.suspended in the tenant audit log, with the platform admin as actor, in the same transaction', async () => {
      prisma.tenant.findUnique.mockResolvedValue(existing('active'));
      prisma.tenant.update.mockResolvedValue({ id: '1', status: 'suspended' });
      await service.update('1', { status: 'suspended' }, 'admin-1');
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: '1',
          actor: { userId: 'admin-1', role: 'platform_admin' },
          action: 'tenant.suspended',
          targetType: 'tenant',
          targetId: '1',
          before: { status: 'active' },
          after: { status: 'suspended' },
        },
        prisma,
      );
    });

    it('records tenant.reactivated when a suspended tenant is activated again', async () => {
      prisma.tenant.findUnique.mockResolvedValue(existing('suspended'));
      prisma.tenant.update.mockResolvedValue({ id: '1', status: 'active' });
      await service.update('1', { status: 'active' }, 'admin-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'tenant.reactivated' }),
        prisma,
      );
    });

    it('records nothing for a rename or when the status did not change', async () => {
      prisma.tenant.findUnique.mockResolvedValue(existing('suspended'));
      prisma.tenant.update.mockResolvedValue({ id: '1', status: 'suspended' });
      await service.update('1', { status: 'suspended' }, 'admin-1');
      prisma.tenant.findUnique.mockResolvedValue(existing('active'));
      prisma.tenant.update.mockResolvedValue({ id: '1', status: 'active' });
      await service.update('1', { name: 'New' }, 'admin-1');
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404 TENANT_NOT_FOUND for an unknown tenant, and maps a P2025 race to 404', async () => {
      prisma.tenant.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.update('x', { name: 'n' }, 'admin-1'),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'TENANT_NOT_FOUND' },
      });

      prisma.tenant.findUnique.mockResolvedValue(existing());
      prisma.tenant.update.mockRejectedValueOnce(prismaError('P2025'));
      await expect(
        service.update('x', { name: 'n' }, 'admin-1'),
      ).rejects.toMatchObject({ status: 404 });

      prisma.tenant.update.mockRejectedValueOnce(new Error('boom'));
      await expect(
        service.update('x', { name: 'n' }, 'admin-1'),
      ).rejects.toThrow('boom');
    });
  });

  describe('remove', () => {
    it('deletes the tenant', async () => {
      prisma.tenant.delete.mockResolvedValue({ id: '1' });
      await expect(service.remove('1')).resolves.toEqual({ id: '1' });
      expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: '1' } });
    });

    it('maps P2025 to 404 and the RESTRICT foreign key (P2003) to 409 TENANT_HAS_DEPENDENCIES', async () => {
      prisma.tenant.delete.mockRejectedValueOnce(prismaError('P2025'));
      await expect(service.remove('x')).rejects.toMatchObject({ status: 404 });

      prisma.tenant.delete.mockRejectedValueOnce(prismaError('P2003'));
      await expect(service.remove('x')).rejects.toMatchObject({
        status: 409,
        response: { code: 'TENANT_HAS_DEPENDENCIES' },
      });
    });
  });
});
