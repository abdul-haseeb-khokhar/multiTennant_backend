import { Test, TestingModule } from '@nestjs/testing';
import {
  createPrismaMock,
  mockTransaction,
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
    mockTransaction(prisma);
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
    const tenantRow = (over: Record<string, unknown> = {}) => ({
      id: '1',
      name: 'Acme',
      status: 'active',
      plan: 'free',
      ...over,
    });

    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue(tenantRow());
      prisma.tenant.update.mockResolvedValue(tenantRow());
    });

    it('writes name and default language', async () => {
      await service.update('1', { name: 'New', defaultLocale: 'ur' });
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { name: 'New', defaultLocale: 'ur' },
      });
    });

    it.each([
      ['plan', { plan: 'pro' }],
      ['status', { status: 'suspended' }],
      ['status active', { status: 'active' }],
      [
        'plan and status with a name',
        { name: 'New', plan: 'pro', status: 'trial' },
      ],
    ])(
      'J5: %s is refused with 400 USE_SUBSCRIPTION_ROUTES and nothing at all is written',
      async (_name, dto) => {
        await expect(service.update('1', dto)).rejects.toMatchObject({
          status: 400,
          response: { code: 'USE_SUBSCRIPTION_ROUTES' },
        });
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
      },
    );

    it('touches nothing when no field is sent', async () => {
      await service.update('1', {});
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('404 TENANT_NOT_FOUND for an unknown tenant, and maps a P2025 race to 404', async () => {
      prisma.tenant.findUnique.mockResolvedValueOnce(null);
      await expect(service.update('x', { name: 'n' })).rejects.toMatchObject({
        status: 404,
        response: { code: 'TENANT_NOT_FOUND' },
      });

      prisma.tenant.update.mockRejectedValueOnce(prismaError('P2025'));
      await expect(service.update('x', { name: 'n' })).rejects.toMatchObject({
        status: 404,
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
