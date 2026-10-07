import { Test, TestingModule } from '@nestjs/testing';
import {
  createPrismaMock,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import { PrismaService } from '../prisma/prisma.service';
import { EndCustomersService } from './end-customers.service';

const customer = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  tenantId: 'tenant-a',
  externalId: 'ext-1',
  name: null,
  metadata: null,
  ...over,
});

describe('EndCustomersService', () => {
  let service: EndCustomersService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EndCustomersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(EndCustomersService);
  });

  describe('create', () => {
    it('writes the tenantId passed by the caller', async () => {
      prisma.endCustomer.create.mockResolvedValue(customer());
      await service.create('tenant-a', {
        externalId: 'ext-1',
        name: 'Ann',
        metadata: { vip: true },
      });
      expect(prisma.endCustomer.create).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-a',
          externalId: 'ext-1',
          name: 'Ann',
          metadata: { vip: true },
        },
      });
    });

    it('maps P2002 to 409 EXTERNAL_ID_TAKEN and P2003 to 404 TENANT_NOT_FOUND', async () => {
      prisma.endCustomer.create.mockRejectedValueOnce(prismaError('P2002'));
      await expect(
        service.create('tenant-a', { externalId: 'dup' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'EXTERNAL_ID_TAKEN' },
      });

      prisma.endCustomer.create.mockRejectedValueOnce(prismaError('P2003'));
      await expect(
        service.create('tenant-a', { externalId: 'x' }),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'TENANT_NOT_FOUND' },
      });
    });
  });

  describe('findAll', () => {
    it('returns the envelope, scoped to the tenant, defaulting to take=20', async () => {
      prisma.endCustomer.findMany.mockResolvedValue([customer()]);
      prisma.endCustomer.count.mockResolvedValue(30);

      await expect(service.findAll('tenant-a', {})).resolves.toEqual({
        data: [customer()],
        total: 30,
        skip: 0,
        take: 20,
      });
      expect(prisma.endCustomer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-a' },
          skip: 0,
          take: 20,
        }),
      );
      expect(prisma.endCustomer.count).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a' },
      });
    });

    it('caps take at 100', async () => {
      prisma.endCustomer.findMany.mockResolvedValue([]);
      prisma.endCustomer.count.mockResolvedValue(0);
      await expect(
        service.findAll('tenant-a', { take: 101 }),
      ).resolves.toMatchObject({ take: 100 });
    });
  });

  describe('tenant isolation: tenant A never reads or changes tenant B rows', () => {
    beforeEach(() => {
      // the row exists, but only for tenant-b: a scoped lookup for tenant-a finds nothing
      prisma.endCustomer.findFirst.mockImplementation(({ where }) =>
        Promise.resolve(
          where.tenantId === 'tenant-b'
            ? customer({ tenantId: 'tenant-b' })
            : null,
        ),
      );
    });

    it('findOne', async () => {
      await expect(service.findOne('tenant-a', 'c1')).rejects.toMatchObject({
        status: 404,
        response: { code: 'CUSTOMER_NOT_FOUND' },
      });
      expect(prisma.endCustomer.findFirst).toHaveBeenCalledWith({
        where: { id: 'c1', tenantId: 'tenant-a' },
      });
    });

    it('update', async () => {
      await expect(
        service.update('tenant-a', 'c1', { name: 'hijack' }),
      ).rejects.toMatchObject({ status: 404 });
      expect(prisma.endCustomer.update).not.toHaveBeenCalled();
    });

    it('remove', async () => {
      await expect(service.remove('tenant-a', 'c1')).rejects.toMatchObject({
        status: 404,
      });
      expect(prisma.endCustomer.delete).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('scopes the mutation itself to the tenant, not just the lookup', async () => {
      prisma.endCustomer.findFirst.mockResolvedValue(customer());
      prisma.endCustomer.update.mockResolvedValue(customer({ name: 'Ann' }));

      await service.update('tenant-a', 'c1', { name: 'Ann' });
      expect(prisma.endCustomer.update).toHaveBeenCalledWith({
        where: { id: 'c1', tenantId: 'tenant-a' },
        data: { externalId: undefined, name: 'Ann', metadata: undefined },
      });
    });

    it('maps P2002 (externalId already used) to 409 and P2025 to 404', async () => {
      prisma.endCustomer.findFirst.mockResolvedValue(customer());
      prisma.endCustomer.update.mockRejectedValueOnce(prismaError('P2002'));
      await expect(
        service.update('tenant-a', 'c1', { externalId: 'dup' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'EXTERNAL_ID_TAKEN' },
      });

      prisma.endCustomer.update.mockRejectedValueOnce(prismaError('P2025'));
      await expect(
        service.update('tenant-a', 'c1', { name: 'x' }),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'CUSTOMER_NOT_FOUND' },
      });
    });
  });

  describe('remove', () => {
    it('deletes only within the tenant', async () => {
      prisma.endCustomer.findFirst.mockResolvedValue(customer());
      prisma.endCustomer.delete.mockResolvedValue(customer());
      await service.remove('tenant-a', 'c1');
      expect(prisma.endCustomer.delete).toHaveBeenCalledWith({
        where: { id: 'c1', tenantId: 'tenant-a' },
      });
    });

    it('maps a P2025 race to 404', async () => {
      prisma.endCustomer.findFirst.mockResolvedValue(customer());
      prisma.endCustomer.delete.mockRejectedValue(prismaError('P2025'));
      await expect(service.remove('tenant-a', 'c1')).rejects.toMatchObject({
        status: 404,
      });
    });
  });
});
