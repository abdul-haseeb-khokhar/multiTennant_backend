import { Test, TestingModule } from '@nestjs/testing';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
} from '../../test/utils/prisma-mock';
import { hashToken } from '../common/tokens/tokens';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailVerificationService } from './email-verification.service';

describe('EmailVerificationService', () => {
  let service: EmailVerificationService;
  let prisma: PrismaMock;
  let mail: { queue: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    mail = { queue: jest.fn().mockReturnValue({}) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailVerificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: mail },
      ],
    }).compile();
    service = module.get(EmailVerificationService);
  });

  describe('issue', () => {
    const user = { id: 'u1', email: 'owner@acme.com', locale: 'ur' };

    it('stores only the hash, expiring in 24 hours, and emails the token', async () => {
      const before = Date.now();
      await service.issue(user);

      const stored = prisma.emailVerification.create.mock.calls[0][0].data;
      const sent = mail.queue.mock.calls[0][0];
      expect(sent).toMatchObject({
        to: 'owner@acme.com',
        template: 'email-verification',
        locale: 'ur',
      });
      expect(stored.tokenHash).toBe(hashToken(sent.token));
      expect(stored.tokenHash).not.toBe(sent.token);
      expect(stored.userId).toBe('u1');
      expect(stored.expiresAt.getTime() - before).toBeGreaterThanOrEqual(
        24 * 3600 * 1000 - 1000,
      );
      expect(stored.expiresAt.getTime() - before).toBeLessThanOrEqual(
        24 * 3600 * 1000 + 5000,
      );
    });

    it('retires older unused links of that user first', async () => {
      await service.issue(user);
      expect(prisma.emailVerification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', usedAt: null },
        data: { usedAt: expect.any(Date) },
      });
    });

    it('returns what the mail service returns (the link only in MAIL_MODE=link)', async () => {
      mail.queue.mockReturnValue({ link: 'http://x/verify-email?token=t' });
      await expect(service.issue(user)).resolves.toEqual({
        link: 'http://x/verify-email?token=t',
      });
    });
  });

  describe('resend', () => {
    const actor = {
      userId: 'u1',
      tenantId: 'tenant-a',
      role: 'owner' as const,
      emailVerified: false,
    };

    it('sends a fresh link to the signed-in user, looked up within their tenant', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u1',
        email: 'owner@acme.com',
        locale: null,
        emailVerifiedAt: null,
        tenant: { defaultLocale: 'ur' },
      });
      await service.resend(actor);
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1', tenantId: 'tenant-a' } }),
      );
      expect(mail.queue).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'owner@acme.com', locale: 'ur' }),
      );
    });

    it('does nothing for an already verified user or a missing one', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u1',
        email: 'x@y.co',
        locale: null,
        emailVerifiedAt: new Date(),
        tenant: { defaultLocale: 'en' },
      });
      await expect(service.resend(actor)).resolves.toEqual({});
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      await expect(service.resend(actor)).resolves.toEqual({});
      expect(mail.queue).not.toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    const record = (over: Record<string, unknown> = {}) => ({
      id: 'v1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'u1', tenantId: 'tenant-a' },
      ...over,
    });

    beforeEach(() => {
      prisma.emailVerification.updateMany.mockResolvedValue({ count: 1 });
    });

    it('looks the token up by its hash and marks the user verified, scoped to their tenant', async () => {
      prisma.emailVerification.findUnique.mockResolvedValue(record());
      await service.verify('the-token');

      expect(prisma.emailVerification.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tokenHash: hashToken('the-token') },
        }),
      );
      expect(prisma.emailVerification.updateMany).toHaveBeenCalledWith({
        where: { id: 'v1', usedAt: null },
        data: { usedAt: expect.any(Date) },
      });
      expect(prisma.tenantUser.update).toHaveBeenCalledWith({
        where: { id: 'u1', tenantId: 'tenant-a' },
        data: { emailVerifiedAt: expect.any(Date) },
      });
    });

    it.each([
      ['unknown', null],
      ['used', record({ usedAt: new Date() })],
      ['expired', record({ expiresAt: new Date(Date.now() - 1000) })],
    ])(
      'rejects a %s token with 400 VERIFICATION_TOKEN_INVALID',
      async (_n, found) => {
        prisma.emailVerification.findUnique.mockResolvedValue(found);
        await expect(service.verify('t')).rejects.toMatchObject({
          status: 400,
          response: { code: 'VERIFICATION_TOKEN_INVALID' },
        });
        expect(prisma.tenantUser.update).not.toHaveBeenCalled();
      },
    );

    it('is single use even when two requests race (the claim updates no row)', async () => {
      prisma.emailVerification.findUnique.mockResolvedValue(record());
      prisma.emailVerification.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.verify('t')).rejects.toMatchObject({
        response: { code: 'VERIFICATION_TOKEN_INVALID' },
      });
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });
  });
});
