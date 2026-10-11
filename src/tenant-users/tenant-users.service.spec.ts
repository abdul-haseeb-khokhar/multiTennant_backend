import { Test, TestingModule } from '@nestjs/testing';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import { AuditService } from '../audit/audit.service';
import { EmailVerificationService } from '../auth/email-verification.service';
import type { AuthUser } from '../auth/roles';
import { EntitlementsService } from '../billing/entitlements/entitlements.service';
import { ConversationsService } from '../conversations/conversations.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantUsersService } from './tenant-users.service';

const owner: AuthUser = {
  userId: 'o1',
  tenantId: 'tenant-a',
  role: 'owner',
  emailVerified: true,
};
const admin: AuthUser = {
  userId: 'a1',
  tenantId: 'tenant-a',
  role: 'admin',
  emailVerified: true,
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  tenantId: 'tenant-a',
  email: 'u1@acme.com',
  role: 'agent',
  status: 'active',
  locale: null,
  ...over,
});

describe('TenantUsersService', () => {
  let service: TenantUsersService;
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let verification: { issue: jest.Mock };
  let entitlements: { assertSeatAvailable: jest.Mock };
  let conversations: { releaseHeldBy: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    verification = { issue: jest.fn().mockResolvedValue({}) };
    entitlements = {
      assertSeatAvailable: jest.fn().mockResolvedValue(undefined),
    };
    conversations = {
      releaseHeldBy: jest.fn().mockResolvedValue({ released: 0, failed: 0 }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantUsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: EmailVerificationService, useValue: verification },
        { provide: EntitlementsService, useValue: entitlements },
        { provide: ConversationsService, useValue: conversations },
      ],
    }).compile();
    service = module.get(TenantUsersService);
  });

  it('has no way to create a user or set a password: people join by invite', () => {
    expect((service as any).create).toBeUndefined();
  });

  describe('findAll', () => {
    it('returns the envelope, scoped to the tenant, with defaults take=20 skip=0', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([row()]);
      prisma.tenantUser.count.mockResolvedValue(1);

      await expect(service.findAll('tenant-a', {}, admin)).resolves.toEqual({
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
      const res = await service.findAll(
        'tenant-a',
        { skip: 5, take: 5000 },
        admin,
      );
      expect(res).toMatchObject({ skip: 5, take: 100 });
      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  describe('what an agent may see (G23.3)', () => {
    const agent: AuthUser = {
      userId: 'g1',
      tenantId: 'tenant-a',
      role: 'agent',
      emailVerified: true,
    };

    it.each([
      ['owner', owner],
      ['admin', admin],
    ])('a list for the %s keeps the security columns', async (_name, actor) => {
      prisma.tenantUser.findMany.mockResolvedValue([]);
      prisma.tenantUser.count.mockResolvedValue(0);
      await service.findAll('tenant-a', {}, actor);
      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ omit: { passwordHash: true } }),
      );
    });

    it('a list for an agent leaves out passwordChangedAt and emailVerifiedAt', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([]);
      prisma.tenantUser.count.mockResolvedValue(0);
      await service.findAll('tenant-a', {}, agent);
      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          omit: {
            passwordHash: true,
            passwordChangedAt: true,
            emailVerifiedAt: true,
          },
        }),
      );
    });

    it('a single user for an agent leaves them out too', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row());
      await service.findOne('tenant-a', 'u1', agent);
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith({
        where: { id: 'u1', tenantId: 'tenant-a' },
        omit: {
          passwordHash: true,
          passwordChangedAt: true,
          emailVerifiedAt: true,
        },
      });
    });
  });

  describe('findOne', () => {
    it("looks up by id AND tenantId, so another tenant's user is a 404", async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      await expect(
        service.findOne('tenant-a', 'user-of-b', admin),
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
    it('runs in a serializable transaction and scopes the mutation to the tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row());
      prisma.tenantUser.update.mockResolvedValue(row({ role: 'admin' }));

      await service.update('tenant-a', 'u1', { role: 'admin' }, admin);

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable',
      });
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith({
        where: { id: 'u1', tenantId: 'tenant-a' },
        omit: { passwordHash: true },
      });
      expect(prisma.tenantUser.update).toHaveBeenCalledWith({
        where: { id: 'u1', tenantId: 'tenant-a' },
        data: { role: 'admin' },
        omit: { passwordHash: true },
      });
    });

    it('checks the plan seat limit when a disabled user becomes active again, inside the same transaction', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        row({ status: 'disabled' }),
      );
      prisma.tenantUser.update.mockResolvedValue(row({ status: 'active' }));
      await service.update('tenant-a', 'u1', { status: 'active' }, admin);
      expect(entitlements.assertSeatAvailable).toHaveBeenCalledWith(
        prisma,
        'tenant-a',
        'reactivate',
      );
    });

    it('does not reactivate when the plan has no seat left (403 PLAN_LIMIT_REACHED)', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        row({ status: 'disabled' }),
      );
      entitlements.assertSeatAvailable.mockRejectedValue(
        Object.assign(new Error('limit'), {
          status: 403,
          response: { code: 'PLAN_LIMIT_REACHED' },
        }),
      );
      await expect(
        service.update('tenant-a', 'u1', { status: 'active' }, admin),
      ).rejects.toMatchObject({ response: { code: 'PLAN_LIMIT_REACHED' } });
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });

    it('does not take a seat for changes that keep the user as they are (already active, or being disabled)', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row());
      prisma.tenantUser.update.mockResolvedValue(row());
      await service.update('tenant-a', 'u1', { status: 'active' }, admin);
      await service.update('tenant-a', 'u1', { status: 'disabled' }, admin);
      await service.update('tenant-a', 'u1', { role: 'admin' }, admin);
      expect(entitlements.assertSeatAvailable).not.toHaveBeenCalled();
    });

    it('has no password field: a password in the data is never written', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row());
      prisma.tenantUser.update.mockResolvedValue(row());
      await service.update(
        'tenant-a',
        'u1',
        { role: 'agent', password: 'x' } as any,
        admin,
      );
      const data = prisma.tenantUser.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('passwordHash');
      expect(data).not.toHaveProperty('password');
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
      await expect(
        service.update('tenant-a', 'u1', { status: 'disabled' }, admin),
      ).rejects.toMatchObject({ response: { code: 'OWNER_REQUIRED' } });

      prisma.tenantUser.findFirst.mockResolvedValue(row({ role: 'agent' }));
      await expect(
        service.update('tenant-a', 'u1', { role: 'owner' }, admin),
      ).rejects.toMatchObject({ response: { code: 'OWNER_REQUIRED' } });
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });

    describe('last active owner', () => {
      beforeEach(() => {
        prisma.tenantUser.findFirst.mockResolvedValue(row({ role: 'owner' }));
      });

      it.each([
        ['demoted', { role: 'admin' }],
        ['disabled', { status: 'disabled' }],
      ])(
        'refuses to leave the tenant without an active owner when %s',
        async (_name, dto) => {
          prisma.tenantUser.count.mockResolvedValue(0);
          await expect(
            service.update('tenant-a', 'u1', dto, owner),
          ).rejects.toMatchObject({
            status: 409,
            response: { code: 'LAST_OWNER' },
          });
          // Counts the OTHER active owners of this tenant only.
          expect(prisma.tenantUser.count).toHaveBeenCalledWith({
            where: {
              tenantId: 'tenant-a',
              role: 'owner',
              status: 'active',
              id: { not: 'u1' },
            },
          });
          expect(prisma.tenantUser.update).not.toHaveBeenCalled();
        },
      );

      it('allows it when another active owner exists', async () => {
        prisma.tenantUser.count.mockResolvedValue(1);
        prisma.tenantUser.update.mockResolvedValue(row({ role: 'admin' }));
        await expect(
          service.update('tenant-a', 'u1', { role: 'admin' }, owner),
        ).resolves.toBeDefined();
      });

      it('does not count an unrelated change (email) as losing the owner', async () => {
        prisma.tenantUser.update.mockResolvedValue(row({ role: 'owner' }));
        await service.update('tenant-a', 'u1', { role: 'owner' }, owner);
        expect(prisma.tenantUser.count).not.toHaveBeenCalled();
      });

      it('does not apply to an owner that is already disabled', async () => {
        prisma.tenantUser.findFirst.mockResolvedValue(
          row({ role: 'owner', status: 'disabled' }),
        );
        prisma.tenantUser.update.mockResolvedValue(
          row({ role: 'admin', status: 'disabled' }),
        );
        await service.update('tenant-a', 'u1', { role: 'admin' }, owner);
        expect(prisma.tenantUser.count).not.toHaveBeenCalled();
      });
    });

    it('retries a serialization failure and gives up with 409 after three attempts', async () => {
      prisma.$transaction.mockRejectedValueOnce(prismaError('P2034'));
      prisma.tenantUser.findFirst.mockResolvedValue(row());
      prisma.tenantUser.update.mockResolvedValue(row({ role: 'admin' }));
      await expect(
        service.update('tenant-a', 'u1', { role: 'admin' }, admin),
      ).resolves.toBeDefined();
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);

      prisma.$transaction.mockReset();
      prisma.$transaction.mockRejectedValue(prismaError('P2034'));
      await expect(
        service.update('tenant-a', 'u1', { role: 'admin' }, admin),
      ).rejects.toMatchObject({ status: 409, response: { code: 'CONFLICT' } });
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });

    describe('audit trail (written in the same transaction)', () => {
      const ctx = {
        tenantId: 'tenant-a',
        actor: { userId: 'a1', role: 'admin' },
        targetType: 'user',
        targetId: 'u1',
      };

      it('records user.role_changed with before and after', async () => {
        prisma.tenantUser.findFirst.mockResolvedValue(row({ role: 'agent' }));
        prisma.tenantUser.update.mockResolvedValue(row({ role: 'admin' }));
        await service.update('tenant-a', 'u1', { role: 'admin' }, admin);

        expect(audit.record).toHaveBeenCalledTimes(1);
        expect(audit.record).toHaveBeenCalledWith(
          {
            ...ctx,
            action: 'user.role_changed',
            before: { role: 'agent' },
            after: { role: 'admin' },
          },
          prisma,
        );
      });

      it('records user.disabled and user.enabled', async () => {
        prisma.tenantUser.findFirst.mockResolvedValue(row());
        prisma.tenantUser.update.mockResolvedValue(row({ status: 'disabled' }));
        await service.update('tenant-a', 'u1', { status: 'disabled' }, admin);
        expect(audit.record).toHaveBeenLastCalledWith(
          expect.objectContaining({
            action: 'user.disabled',
            before: { status: 'active' },
            after: { status: 'disabled' },
          }),
          prisma,
        );

        prisma.tenantUser.findFirst.mockResolvedValue(
          row({ status: 'disabled' }),
        );
        prisma.tenantUser.update.mockResolvedValue(row({ status: 'active' }));
        await service.update('tenant-a', 'u1', { status: 'active' }, admin);
        expect(audit.record).toHaveBeenLastCalledWith(
          expect.objectContaining({ action: 'user.enabled' }),
          prisma,
        );
      });

      it('records nothing when nothing changed', async () => {
        prisma.tenantUser.findFirst.mockResolvedValue(row());
        prisma.tenantUser.update.mockResolvedValue(row());
        await service.update('tenant-a', 'u1', { role: 'agent' }, admin);
        expect(audit.record).not.toHaveBeenCalled();
      });

      it('does not record when the update fails', async () => {
        prisma.tenantUser.findFirst.mockResolvedValue(row());
        prisma.tenantUser.update.mockRejectedValue(new Error('boom'));
        await expect(
          service.update('tenant-a', 'u1', { role: 'admin' }, admin),
        ).rejects.toThrow('boom');
        expect(audit.record).not.toHaveBeenCalled();
      });
    });

    describe('email change', () => {
      it('normalises the address, resets verification, records it and sends a new verification link', async () => {
        prisma.tenantUser.findFirst.mockResolvedValue(row());
        prisma.tenantUser.update.mockResolvedValue(
          row({ email: 'new@acme.com' }),
        );
        prisma.tenant.findUnique.mockResolvedValue({ defaultLocale: 'ur' });

        await service.update(
          'tenant-a',
          'u1',
          { email: '  New@ACME.com ' },
          admin,
        );

        expect(prisma.tenantUser.update.mock.calls[0][0].data).toEqual({
          email: 'new@acme.com',
          emailVerifiedAt: null,
        });
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'user.email_changed',
            before: { email: 'u1@acme.com' },
            after: { email: 'new@acme.com' },
          }),
          prisma,
        );
        expect(verification.issue).toHaveBeenCalledWith({
          id: 'u1',
          email: 'new@acme.com',
          locale: 'ur',
        });
      });

      it('does nothing special when the email is the same apart from case', async () => {
        prisma.tenantUser.findFirst.mockResolvedValue(row());
        prisma.tenantUser.update.mockResolvedValue(row());
        await service.update('tenant-a', 'u1', { email: 'U1@acme.com' }, admin);
        expect(prisma.tenantUser.update.mock.calls[0][0].data).toEqual({});
        expect(verification.issue).not.toHaveBeenCalled();
      });
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

  describe('conversations of a user who is disabled or deleted (Phase 4)', () => {
    it('disabling a user gives their conversations back to the queue, after the change committed', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row({ status: 'active' }));
      prisma.tenantUser.update.mockResolvedValue(row({ status: 'disabled' }));
      await service.update('tenant-a', 'u1', { status: 'disabled' }, admin);
      expect(conversations.releaseHeldBy).toHaveBeenCalledWith(
        admin,
        'u1',
        'assignee_disabled',
      );
    });

    it.each([
      ['a role change', { role: 'admin' }, { role: 'admin' }],
      ['enabling', { status: 'active' }, { status: 'active' }],
    ])('%s releases nothing', async (_name, dto, patch) => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        row({ status: 'disabled' }),
      );
      prisma.tenantUser.update.mockResolvedValue(row(patch));
      await service.update('tenant-a', 'u1', dto, admin);
      expect(conversations.releaseHeldBy).not.toHaveBeenCalled();
    });

    it('disabling someone who is already disabled releases nothing', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        row({ status: 'disabled' }),
      );
      prisma.tenantUser.update.mockResolvedValue(row({ status: 'disabled' }));
      await service.update('tenant-a', 'u1', { status: 'disabled' }, admin);
      expect(conversations.releaseHeldBy).not.toHaveBeenCalled();
    });

    it('a refused change (last owner) releases nothing', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        row({ role: 'owner', status: 'active' }),
      );
      prisma.tenantUser.count.mockResolvedValue(0);
      await expect(
        service.update('tenant-a', 'u1', { status: 'disabled' }, owner),
      ).rejects.toMatchObject({ status: 409 });
      expect(conversations.releaseHeldBy).not.toHaveBeenCalled();
    });

    it('deleting a user gives their conversations back to the queue', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row());
      prisma.tenantUser.delete.mockResolvedValue(row());
      await service.remove('tenant-a', 'u1', admin);
      expect(conversations.releaseHeldBy).toHaveBeenCalledWith(
        admin,
        'u1',
        'assignee_deleted',
      );
    });

    it('a delete that finds nobody releases nothing', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      await expect(
        service.remove('tenant-a', 'nobody', admin),
      ).rejects.toMatchObject({ status: 404 });
      expect(conversations.releaseHeldBy).not.toHaveBeenCalled();
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

    it('records user.deleted with the removed user as before, in the same transaction', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row());
      prisma.tenantUser.delete.mockResolvedValue(row());
      await service.remove('tenant-a', 'u1', admin);
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-a',
          actor: { userId: 'a1', role: 'admin' },
          action: 'user.deleted',
          targetType: 'user',
          targetId: 'u1',
          before: row(),
        },
        prisma,
      );
    });

    it('never deletes a user of another tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      await expect(
        service.remove('tenant-a', 'user-of-b', owner),
      ).rejects.toMatchObject({ status: 404 });
      expect(prisma.tenantUser.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('lets only an owner delete an owner, and never the last active one', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(row({ role: 'owner' }));
      await expect(
        service.remove('tenant-a', 'u1', admin),
      ).rejects.toMatchObject({ response: { code: 'OWNER_REQUIRED' } });

      prisma.tenantUser.count.mockResolvedValue(0);
      await expect(
        service.remove('tenant-a', 'u1', owner),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'LAST_OWNER' },
      });
      expect(prisma.tenantUser.delete).not.toHaveBeenCalled();

      prisma.tenantUser.count.mockResolvedValue(1);
      prisma.tenantUser.delete.mockResolvedValue(row({ role: 'owner' }));
      await expect(
        service.remove('tenant-a', 'u1', owner),
      ).resolves.toBeDefined();
    });

    it('may delete a disabled owner without a last-owner check', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        row({ role: 'owner', status: 'disabled' }),
      );
      prisma.tenantUser.delete.mockResolvedValue(row());
      await service.remove('tenant-a', 'u1', owner);
      expect(prisma.tenantUser.count).not.toHaveBeenCalled();
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
