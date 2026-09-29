import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { PrismaService } from '../prisma/prisma.service';

describe('TenantsService', () => {
  let service: TenantsService;
  let prisma: { tenant: Record<string, jest.Mock> };

  beforeEach(async () => {
    prisma = {
      tenant: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TenantsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<TenantsService>(TenantsService);
  });

  it('creates a tenant', async () => {
    prisma.tenant.create.mockResolvedValue({ id: '1', name: 'Acme' });
    const result = await service.create({ name: 'Acme' });
    expect(prisma.tenant.create).toHaveBeenCalledWith({ data: { name: 'Acme' } });
    expect(result).toEqual({ id: '1', name: 'Acme' });
  });

  it('throws NotFoundException when finding a missing tenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    await expect(service.findOne('missing-id')).rejects.toThrow(NotFoundException);
  });

  it('returns a tenant when found', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: '1', name: 'Acme' });
    const result = await service.findOne('1');
    expect(result).toEqual({ id: '1', name: 'Acme' });
  });
});