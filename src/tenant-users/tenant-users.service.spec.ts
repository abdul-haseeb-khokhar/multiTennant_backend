import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import {
  prismaError,
  createPrismaMock,
  PrismaMock,
} from '../../test/utils/prisma-mock';
import type { AuthUser } from '../auth/roles';
import { PrismaService } from '../prisma/prisma.service';
import { TenantUsersService } from './tenant-users.service';

const owner: AuthUser = { userId: 'o1', tenantId: 'tenant-a', role: 'owner' };
const admin: AuthUser = { userId: 'a1', tenantId: 'tenant-a', role: 'admin' };
const agent: AuthUser = { userId: 'g1', tenantId: 'tenant-a', role: 'agent' };

const row = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  tenantId: 'tenant-a',
  email: 'u1@acme.com',
  role: 'agent',
  ...over,
});

describe('TenantUsersService', () => {
  let service: TenantUsersService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantUsersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(TenantUsersService);
  });

  describe('create', () => {
    it('hashes the password, scopes to the tenant and never selects the hash back', async () => {
      prisma.tenantUser.create.mockResolvedValue(row());
      await service.create(
        'tenant-a',
        { email: 'u1@acme.com', password: 'password123', role: 'agent' },
        admin,
      );

      const arg = prisma.tenantUser.create.mock.calls[0][0];
      expect(arg.data).toMatchObject({
        tenantId: 'tenant-a',
        email: 'u1@acme.com',
        role: 'agent',
      });
      expect(arg.data.passwordHash).not.toBe('password123');
      expect(await bcrypt.compare('password123', arg.data.passwordHash)).toBe(
        true,
      );
      expect(arg.omit).toEqual({ passwordHash: true });
    });

    it('lets only an owner create an owner (B2)', async () => {
      const dto = {
        email: 'x@acme.com',
        password: 'password123',
        role: 'owner',
      };
      await expect(
        service.create('tenant-a', dto, admin),
      ).rejects.toMatchObject({ response: { code: 'OWNER_REQUIRED' } });
      await expect(
        service.create('tenant-a', dto, agent),
      ).rejects.toMatchObject({ response: { code: 'OWNER_REQUIRED' } });
      expect(prisma.tenantUser.create).not.toHaveBeenCalled();

      prisma.tenantUser.create.mockResolvedValue(row({ role: 'owner' }));
      await expect(
        service.create('tenant-a', dto, owner),
      ).resolves.toMatchObject({ role: 'owner' });
    });

    it('maps P2002 to 409 EMAIL_TAKEN and P2003 to 404 TENANT_NOT_FOUND', async () => {
      const dto = { email: 'x@acme.com', password: 'password123' };
      prisma.tenantUser.create.mockRejectedValueOnce(prismaError('P2002'));
      await expect(
        service.create('tenant-a', dto, admin),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'EMAIL_TAKEN' },
      });

      prisma.tenantUser.create.mockRejectedValueOnce(prismaError('P2003'));
      await expect(
        service.create('tenant-a', dto, admin),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'TENANT_NOT_FOUND' },
      });
    });

    it('rethrows unknown errors', async () => {
      prisma.tenantUser.create.mockRejectedValue(new Error('boom'));
      await expect(
        service.create(
          'tenant-a',
          { email: 'x@acme.com', password: 'password123' },
          admin,
        ),
      ).rejects.toThrow('boom');
    });
  });

  describe('findAll', () => {
    it('returns the envelope, scoped to the tenant, with defaults take=20 skip=0', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([row()]);
      prisma.tenantUser.count.mockResolvedValue(1);

      await expect(service.findAll('tenant-a', {})).resolves.toEqual({
        data: [row()],
        total: 1,
        skip: 0,
        take: 20,
      });
      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-a' },
          skip: 0,
          take: 20,
          omit: { passwordHash: true },
        }),
      );
      expect(prisma.tenantUser.count).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a' },
      });
    });

    it('caps take at 100', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([]);
      prisma.tenantUser.count.mockResolvedValue(0);
      const res = await service.findAll('tenant-a', { skip: 5, take: 5000 });
      expect(res).toMatchObject({ skip: 5, take: 100 });
      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  describe('findOne', () => {
    it("looks up by id AND tenantId, so another tenant's user is a 404", async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      await expect(
        service.findOne('tenant-a', 'user-of-b'),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'USER_NOT_FOUND' },
      });
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith({
        where: { id: 'user-of-b', tenantId: 'tenant-a' },
        omit: { passwordHash: true },
      });
    });
  });

  describe('update', () => {
    it('scopes the mutation to the tenant and hashes a new password', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row());
      prisma.tenantUser.update.mockResolvedValue(row({ role: 'admin' }));

      await service.update(
        'tenant-a',
        'u1',
        { role: 'admin', password: 'new-password-1' },
        admin,
      );

      const arg = prisma.tenantUser.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'u1', tenantId: 'tenant-a' });
      expect(arg.omit).toEqual({ passwordHash: true });
      expect(arg.data.role).toBe('admin');
      expect(
        await bcrypt.compare('new-password-1', arg.data.passwordHash),
      ).toBe(true);
    });

    it('never touches a user of another tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      await expect(
        service.update('tenant-a', 'user-of-b', { role: 'admin' }, owner),
      ).rejects.toMatchObject({ status: 404 });
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });

    it('only an owner may change an owner or promote someone to owner', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row({ role: 'owner' }));
      await expect(
        service.update('tenant-a', 'u1', { email: 'n@acme.com' }, admin),
      ).rejects.toMatchObject({ response: { code: 'OWNER_REQUIRED' } });

      prisma.tenantUser.findFirst.mockResolvedValue(row({ role: 'agent' }));
      await expect(
        service.update('tenant-a', 'u1', { role: 'owner' }, admin),
      ).rejects.toMatchObject({ response: { code: 'OWNER_REQUIRED' } });
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });

    it('refuses to demote the last owner but allows it when another owner exists', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row({ role: 'owner' }));
      prisma.tenantUser.count.mockResolvedValue(1);
      await expect(
        service.update('tenant-a', 'u1', { role: 'admin' }, owner),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'LAST_OWNER' },
      });
      expect(prisma.tenantUser.count).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a', role: 'owner' },
      });

      prisma.tenantUser.count.mockResolvedValue(2);
      prisma.tenantUser.update.mockResolvedValue(row({ role: 'admin' }));
      await expect(
        service.update('tenant-a', 'u1', { role: 'admin' }, owner),
      ).resolves.toBeDefined();
    });

    it('maps P2002 to 409 EMAIL_TAKEN and P2025 to 404', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row());
      prisma.tenantUser.update.mockRejectedValueOnce(prismaError('P2002'));
      await expect(
        service.update('tenant-a', 'u1', { email: 'taken@acme.com' }, admin),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'EMAIL_TAKEN' },
      });

      prisma.tenantUser.update.mockRejectedValueOnce(prismaError('P2025'));
      await expect(
        service.update('tenant-a', 'u1', { email: 'x@acme.com' }, admin),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'USER_NOT_FOUND' },
      });
    });
  });

  describe('remove', () => {
    it('REGRESSION: takes (tenantId, id) and deletes that user instead of always answering 404', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row());
      prisma.tenantUser.delete.mockResolvedValue(row());

      await expect(
        service.remove('tenant-a', 'u1', admin),
      ).resolves.toMatchObject({ id: 'u1' });

      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1', tenantId: 'tenant-a' } }),
      );
      expect(prisma.tenantUser.delete).toHaveBeenCalledWith({
        where: { id: 'u1', tenantId: 'tenant-a' },
        omit: { passwordHash: true },
      });
    });

    it('never deletes a user of another tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      await expect(
        service.remove('tenant-a', 'user-of-b', owner),
      ).rejects.toMatchObject({ status: 404 });
      expect(prisma.tenantUser.delete).not.toHaveBeenCalled();
    });

    it('lets only an owner delete an owner, and never the last one', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row({ role: 'owner' }));
      await expect(
        service.remove('tenant-a', 'u1', admin),
      ).rejects.toMatchObject({ response: { code: 'OWNER_REQUIRED' } });

      prisma.tenantUser.count.mockResolvedValue(1);
      await expect(
        service.remove('tenant-a', 'u1', owner),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'LAST_OWNER' },
      });
      expect(prisma.tenantUser.delete).not.toHaveBeenCalled();

      prisma.tenantUser.count.mockResolvedValue(2);
      prisma.tenantUser.delete.mockResolvedValue(row({ role: 'owner' }));
      await expect(
        service.remove('tenant-a', 'u1', owner),
      ).resolves.toBeDefined();
    });

    it('maps a P2025 race to 404', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row());
      prisma.tenantUser.delete.mockRejectedValue(prismaError('P2025'));
      await expect(
        service.remove('tenant-a', 'u1', admin),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
