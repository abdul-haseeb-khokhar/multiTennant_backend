import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { SessionTokenService } from '../auth/session-token.service';
import { EntitlementsService } from '../billing/entitlements/entitlements.service';
import { hashToken } from '../common/tokens/tokens';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvitesService } from './invites.service';

const owner: AuthUser = {
  userId: 'o1',
  tenantId: 'tenant-a',
  role: 'owner',
  emailVerified: true,
};
const admin: AuthUser = { ...owner, userId: 'a1', role: 'admin' };

const DAY = 24 * 3600 * 1000;

describe('InvitesService', () => {
  let service: InvitesService;
  let prisma: PrismaMock;
  let mail: { sendNow: jest.Mock };
  let audit: { record: jest.Mock };
  let sessions: { sign: jest.Mock };
  let entitlements: { assertSeatAvailable: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    mail = { sendNow: jest.fn().mockResolvedValue({}) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    sessions = { sign: jest.fn().mockReturnValue('signed.jwt') };
    entitlements = {
      assertSeatAvailable: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitesService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: mail },
        { provide: AuditService, useValue: audit },
        { provide: SessionTokenService, useValue: sessions },
        { provide: EntitlementsService, useValue: entitlements },
      ],
    }).compile();
    service = module.get(InvitesService);
  });

  describe('create', () => {
    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue({ defaultLocale: 'ur' });
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      prisma.staffInvite.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'inv-1',
          tenantId: data.tenantId,
          email: data.email,
          role: data.role,
          expiresAt: data.expiresAt,
          invitedBy: data.invitedBy,
        }),
      );
    });

    it('stores a hashed 7-day single-use token, scoped to the tenant, and emails the token', async () => {
      const before = Date.now();
      const res = await service.create(
        'tenant-a',
        { email: 'agent@acme.com', role: 'agent' },
        admin,
      );

      const data = prisma.staffInvite.create.mock.calls[0][0].data;
      const sent = mail.sendNow.mock.calls[0][0];
      expect(data).toMatchObject({
        tenantId: 'tenant-a',
        email: 'agent@acme.com',
        role: 'agent',
        invitedBy: 'a1',
      });
      expect(data.tokenHash).toBe(hashToken(sent.token));
      expect(data.tokenHash).not.toBe(sent.token);
      const ttl = data.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(7 * DAY - 1000);
      expect(ttl).toBeLessThan(7 * DAY + 5000);
      expect(sent).toMatchObject({
        to: 'agent@acme.com',
        template: 'staff-invite',
        locale: 'ur',
      });
      // The hash is never selected back and never returned.
      expect(prisma.staffInvite.create.mock.calls[0][0].omit).toEqual({
        tokenHash: true,
      });
      expect(JSON.stringify(res)).not.toContain(data.tokenHash);
      expect(res).toMatchObject({ id: 'inv-1', email: 'agent@acme.com' });
    });

    it('defaults the role to agent and normalises the email', async () => {
      await service.create('tenant-a', { email: '  Agent@ACME.com ' }, admin);
      expect(prisma.staffInvite.create.mock.calls[0][0].data).toMatchObject({
        email: 'agent@acme.com',
        role: 'agent',
      });
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a', email: 'agent@acme.com' },
        select: { id: true },
      });
    });

    it('checks the plan seat limit inside the transaction, ignoring the address being re-invited', async () => {
      await service.create('tenant-a', { email: ' New@Acme.com ' }, owner);
      expect(entitlements.assertSeatAvailable).toHaveBeenCalledWith(
        prisma,
        'tenant-a',
        'invite',
        'new@acme.com',
      );
    });

    it('creates nothing and sends no email when the plan has no seat left (403 PLAN_LIMIT_REACHED)', async () => {
      entitlements.assertSeatAvailable.mockRejectedValue(
        Object.assign(new Error('limit'), {
          status: 403,
          response: { code: 'PLAN_LIMIT_REACHED' },
        }),
      );
      await expect(
        service.create('tenant-a', { email: 'n@acme.com' }, owner),
      ).rejects.toMatchObject({ response: { code: 'PLAN_LIMIT_REACHED' } });
      expect(prisma.staffInvite.create).not.toHaveBeenCalled();
      expect(mail.sendNow).not.toHaveBeenCalled();
    });

    it('returns the link only when the mail service exposes it (MAIL_MODE=link)', async () => {
      await expect(
        service.create('tenant-a', { email: 'a@acme.com' }, admin),
      ).resolves.not.toHaveProperty('link', expect.anything());

      mail.sendNow.mockResolvedValue({
        link: 'http://x/accept-invite?token=t',
      });
      await expect(
        service.create('tenant-a', { email: 'b@acme.com' }, admin),
      ).resolves.toMatchObject({ link: 'http://x/accept-invite?token=t' });
    });

    it('replaces a pending invite for the same address (resend), in one transaction with the audit entry', async () => {
      await service.create('tenant-a', { email: 'agent@acme.com' }, admin);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.staffInvite.updateMany).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-a',
          email: 'agent@acme.com',
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-a',
          actor: { userId: 'a1', role: 'admin' },
          action: 'user.invited',
          targetType: 'invite',
          targetId: 'inv-1',
          after: expect.objectContaining({
            email: 'agent@acme.com',
            role: 'agent',
          }),
        }),
        prisma,
      );
    });

    it('lets an admin invite admin and agent but only an owner invite an owner', async () => {
      await expect(
        service.create(
          'tenant-a',
          { email: 'x@acme.com', role: 'admin' },
          admin,
        ),
      ).resolves.toBeDefined();

      await expect(
        service.create(
          'tenant-a',
          { email: 'x@acme.com', role: 'owner' },
          admin,
        ),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'OWNER_REQUIRED' },
      });
      expect(prisma.staffInvite.create).toHaveBeenCalledTimes(1);

      await expect(
        service.create(
          'tenant-a',
          { email: 'x@acme.com', role: 'owner' },
          owner,
        ),
      ).resolves.toBeDefined();
    });

    it('409 EMAIL_TAKEN when the address already belongs to a user of this tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({ id: 'u9' });
      await expect(
        service.create('tenant-a', { email: 'taken@acme.com' }, admin),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'EMAIL_TAKEN' },
      });
      expect(prisma.staffInvite.create).not.toHaveBeenCalled();
      expect(mail.sendNow).not.toHaveBeenCalled();
    });

    it('404 TENANT_NOT_FOUND for an unknown tenant', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      await expect(
        service.create('nope', { email: 'a@acme.com' }, admin),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('surfaces a mail failure as 503 MAIL_DELIVERY_FAILED', async () => {
      mail.sendNow.mockRejectedValue(
        Object.assign(new Error('x'), {
          status: 503,
          response: { code: 'MAIL_DELIVERY_FAILED' },
        }),
      );
      await expect(
        service.create('tenant-a', { email: 'a@acme.com' }, admin),
      ).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('findAll', () => {
    it('lists only pending invites of the tenant, never exposing the token hash', async () => {
      prisma.staffInvite.findMany.mockResolvedValue([{ id: 'inv-1' }]);
      prisma.staffInvite.count.mockResolvedValue(1);
      await expect(service.findAll('tenant-a', {})).resolves.toEqual({
        data: [{ id: 'inv-1' }],
        total: 1,
        skip: 0,
        take: 20,
      });
      const where = prisma.staffInvite.findMany.mock.calls[0][0].where;
      expect(where).toEqual({
        tenantId: 'tenant-a',
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      });
      expect(prisma.staffInvite.findMany.mock.calls[0][0].omit).toEqual({
        tokenHash: true,
      });
      expect(prisma.staffInvite.count).toHaveBeenCalledWith({ where });
    });
  });

  describe('revoke', () => {
    it('only revokes a pending invite of this tenant', async () => {
      prisma.staffInvite.findFirst.mockResolvedValue({ role: 'agent' });
      prisma.staffInvite.update.mockResolvedValue({ id: 'inv-1' });
      await service.revoke('tenant-a', 'inv-1', admin);
      expect(prisma.staffInvite.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'inv-1',
          tenantId: 'tenant-a',
          acceptedAt: null,
          revokedAt: null,
        },
        select: { role: true },
      });
      expect(prisma.staffInvite.update).toHaveBeenCalledWith({
        where: { id: 'inv-1', tenantId: 'tenant-a' },
        data: { revokedAt: expect.any(Date) },
        omit: { tokenHash: true },
      });
    });

    it("404 INVITE_NOT_FOUND for another tenant's, accepted or already revoked invite", async () => {
      prisma.staffInvite.findFirst.mockResolvedValue(null);
      await expect(
        service.revoke('tenant-a', 'invite-of-b', admin),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'INVITE_NOT_FOUND' },
      });
      expect(prisma.staffInvite.update).not.toHaveBeenCalled();
    });

    it('only an owner may revoke an owner invite', async () => {
      prisma.staffInvite.findFirst.mockResolvedValue({ role: 'owner' });
      await expect(
        service.revoke('tenant-a', 'inv-1', admin),
      ).rejects.toMatchObject({ response: { code: 'OWNER_REQUIRED' } });
      prisma.staffInvite.update.mockResolvedValue({ id: 'inv-1' });
      await expect(
        service.revoke('tenant-a', 'inv-1', owner),
      ).resolves.toBeDefined();
    });

    it('maps a P2025 race to 404', async () => {
      prisma.staffInvite.findFirst.mockResolvedValue({ role: 'agent' });
      prisma.staffInvite.update.mockRejectedValue(prismaError('P2025'));
      await expect(
        service.revoke('tenant-a', 'inv-1', admin),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('accept', () => {
    const invite = (over: Record<string, unknown> = {}) => ({
      id: 'inv-1',
      tenantId: 'tenant-a',
      email: 'agent@acme.com',
      role: 'agent',
      acceptedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      tenant: { status: 'active' },
      ...over,
    });
    const dto = {
      token: 'the-token',
      password: 'my-own-password',
      name: 'Sana',
    };

    beforeEach(() => {
      prisma.staffInvite.findUnique.mockResolvedValue(invite());
      prisma.staffInvite.updateMany.mockResolvedValue({ count: 1 });
      prisma.tenantUser.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'new-user',
          tenantId: data.tenantId,
          email: data.email,
          role: data.role,
        }),
      );
    });

    it('creates the user with the invited role, their own password and a verified email, and returns a session', async () => {
      const res = await service.accept(dto);

      expect(prisma.staffInvite.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tokenHash: hashToken('the-token') },
        }),
      );
      const created = prisma.tenantUser.create.mock.calls[0][0];
      expect(created.data).toMatchObject({
        tenantId: 'tenant-a',
        email: 'agent@acme.com',
        role: 'agent',
        name: 'Sana',
        emailVerifiedAt: expect.any(Date),
      });
      expect(
        await bcrypt.compare('my-own-password', created.data.passwordHash),
      ).toBe(true);
      expect(created.omit).toEqual({ passwordHash: true });
      expect(sessions.sign).toHaveBeenCalledWith(
        'new-user',
        'tenant-a',
        'agent',
      );
      expect(res).toMatchObject({
        access_token: 'signed.jwt',
        user: { id: 'new-user' },
      });
      expect(JSON.stringify(res)).not.toContain('passwordHash');
    });

    it('uses up the invite and records invite.accepted in the same transaction', async () => {
      await service.accept(dto);
      expect(prisma.staffInvite.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'inv-1',
          tenantId: 'tenant-a',
          acceptedAt: null,
          revokedAt: null,
        },
        data: { acceptedAt: expect.any(Date) },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-a',
          actor: { userId: 'new-user', role: 'agent' },
          action: 'invite.accepted',
          targetType: 'invite',
          targetId: 'inv-1',
        }),
        prisma,
      );
    });

    it.each([
      ['unknown', null],
      ['already accepted', invite({ acceptedAt: new Date() })],
      ['revoked', invite({ revokedAt: new Date() })],
      ['expired', invite({ expiresAt: new Date(Date.now() - 1000) })],
    ])(
      'rejects a token that is %s with 400 INVITE_INVALID',
      async (_n, found) => {
        prisma.staffInvite.findUnique.mockResolvedValue(found);
        await expect(service.accept(dto)).rejects.toMatchObject({
          status: 400,
          response: { code: 'INVITE_INVALID' },
        });
        expect(prisma.tenantUser.create).not.toHaveBeenCalled();
      },
    );

    it('is single use even when two requests race (the claim updates no row)', async () => {
      prisma.staffInvite.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.accept(dto)).rejects.toMatchObject({
        response: { code: 'INVITE_INVALID' },
      });
      expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    });

    it('refuses an invite of a suspended tenant', async () => {
      prisma.staffInvite.findUnique.mockResolvedValue(
        invite({ tenant: { status: 'suspended' } }),
      );
      await expect(service.accept(dto)).rejects.toMatchObject({
        status: 403,
        response: { code: 'TENANT_SUSPENDED' },
      });
    });

    it('refuses an invite of a closed account', async () => {
      prisma.staffInvite.findUnique.mockResolvedValue(
        invite({ tenant: { status: 'closed' } }),
      );
      await expect(service.accept(dto)).rejects.toMatchObject({
        status: 403,
        response: { code: 'TENANT_CLOSED' },
      });
    });

    it('checks the seat limit when the invite becomes a user, and creates no user when over the limit', async () => {
      entitlements.assertSeatAvailable.mockRejectedValue(
        Object.assign(new Error('limit'), {
          status: 403,
          response: { code: 'PLAN_LIMIT_REACHED' },
        }),
      );
      await expect(service.accept(dto)).rejects.toMatchObject({
        response: { code: 'PLAN_LIMIT_REACHED' },
      });
      expect(entitlements.assertSeatAvailable).toHaveBeenCalledWith(
        prisma,
        'tenant-a',
        'accept',
      );
      expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    });

    it('409 EMAIL_TAKEN when the user appeared in the meantime', async () => {
      prisma.tenantUser.create.mockRejectedValue(prismaError('P2002'));
      await expect(service.accept(dto)).rejects.toMatchObject({
        status: 409,
        response: { code: 'EMAIL_TAKEN' },
      });
      expect(sessions.sign).not.toHaveBeenCalled();
    });

    it('rethrows unexpected errors', async () => {
      prisma.tenantUser.create.mockRejectedValue(new Error('db down'));
      await expect(service.accept(dto)).rejects.toThrow('db down');
    });
  });
});
