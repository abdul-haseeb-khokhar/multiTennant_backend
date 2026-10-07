import { Test, TestingModule } from '@nestjs/testing';
import {
  createPrismaMock,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import { PrismaService } from '../prisma/prisma.service';
import { TenantsService } from './tenants.service';

describe('TenantsService (platform admin)', () => {
  let service: TenantsService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [TenantsService, { provide: PrismaService, useValue: prisma }],
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
    it('can change name, plan and status', async () => {
      prisma.tenant.update.mockResolvedValue({ id: '1', status: 'suspended' });
      await service.update('1', { status: 'suspended', plan: 'pro' });
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { name: undefined, plan: 'pro', status: 'suspended' },
      });
    });

    it('maps P2025 to 404 and rethrows anything else', async () => {
      prisma.tenant.update.mockRejectedValueOnce(prismaError('P2025'));
      await expect(service.update('x', { name: 'n' })).rejects.toMatchObject({
        status: 404,
        response: { code: 'TENANT_NOT_FOUND' },
      });

      prisma.tenant.update.mockRejectedValueOnce(new Error('boom'));
      await expect(service.update('x', { name: 'n' })).rejects.toThrow('boom');
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
