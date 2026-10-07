import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
} from '../../test/utils/prisma-mock';
import { AuditService } from '../audit/audit.service';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { hashToken } from '../common/tokens/tokens';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordResetService } from './password-reset.service';

describe('PasswordResetService', () => {
  let service: PasswordResetService;
  let prisma: PrismaMock;
  let mail: { queue: jest.Mock };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    mail = { queue: jest.fn().mockReturnValue({}) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordResetService,
        RateLimiter,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: mail },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(PasswordResetService);
  });

  describe('request', () => {
    const dto = { tenantSlug: 'acme', email: 'agent@acme.com' };

    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        status: 'active',
        defaultLocale: 'ur',
      });
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'u1',
        status: 'active',
        locale: null,
      });
    });

    it('creates a one-hour, hashed token and emails it in the language of the user (tenant default)', async () => {
      const before = Date.now();
      await service.request(dto, '1.1.1.1');

      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 't1', email: 'agent@acme.com' },
        select: expect.any(Object),
      });
      const stored = prisma.passwordReset.create.mock.calls[0][0].data;
      const sent = mail.queue.mock.calls[0][0];
      expect(sent).toMatchObject({
        to: 'agent@acme.com',
        template: 'password-reset',
        locale: 'ur',
      });
      expect(stored.tokenHash).toBe(hashToken(sent.token));
      expect(stored.userId).toBe('u1');
      const ttl = stored.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(3600_000 - 1000);
      expect(ttl).toBeLessThan(3600_000 + 5000);
    });

    it('retires earlier unused reset links of that user', async () => {
      await service.request(dto, '1.1.1.1');
      expect(prisma.passwordReset.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', usedAt: null },
        data: { usedAt: expect.any(Date) },
      });
    });

    it('normalises the email it looks up', async () => {
      await service.request({ ...dto, email: '  Agent@ACME.com ' }, '1.1.1.1');
      expect(prisma.tenantUser.findFirst.mock.calls[0][0].where.email).toBe(
        'agent@acme.com',
      );
    });

    it('answers the same way for unknown tenant, unknown user, disabled user: nothing created, nothing sent', async () => {
      prisma.tenant.findUnique.mockResolvedValueOnce(null);
      await expect(service.request(dto, '1.1.1.1')).resolves.toEqual({});

      prisma.tenantUser.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.request({ ...dto, email: 'other@acme.com' }, '1.1.1.2'),
      ).resolves.toEqual({});

      prisma.tenantUser.findFirst.mockResolvedValueOnce({
        id: 'u2',
        status: 'disabled',
        locale: null,
      });
      await expect(
        service.request({ ...dto, email: 'off@acme.com' }, '1.1.1.3'),
      ).resolves.toEqual({});

      expect(prisma.passwordReset.create).not.toHaveBeenCalled();
      expect(mail.queue).not.toHaveBeenCalled();
    });

    it('returns the link only when the mail service exposes it (MAIL_MODE=link)', async () => {
      mail.queue.mockReturnValue({ link: 'http://x/reset-password?token=t' });
      await expect(service.request(dto, '1.1.1.1')).resolves.toEqual({
        link: 'http://x/reset-password?token=t',
      });
    });

    describe('throttling', () => {
      it('allows 3 requests per email in an hour, then silently sends nothing (no signal to the caller)', async () => {
        for (let i = 0; i < 3; i++) {
          await service.request(dto, `10.0.0.${i}`);
        }
        expect(mail.queue).toHaveBeenCalledTimes(3);

        await expect(service.request(dto, '10.0.0.9')).resolves.toEqual({});
        expect(mail.queue).toHaveBeenCalledTimes(3);
        expect(prisma.passwordReset.create).toHaveBeenCalledTimes(3);
      });

      it('counts per tenant and email, so another address is unaffected', async () => {
        for (let i = 0; i < 4; i++) await service.request(dto, `10.0.0.${i}`);
        await service.request({ ...dto, email: 'b@acme.com' }, '10.0.1.1');
        expect(mail.queue).toHaveBeenCalledTimes(4);
      });

      it('allows 10 requests per IP in an hour, then answers 429 TOO_MANY_REQUESTS', async () => {
        for (let i = 0; i < 10; i++) {
          await service.request({ ...dto, email: `u${i}@acme.com` }, '9.9.9.9');
        }
        await expect(
          service.request({ ...dto, email: 'u11@acme.com' }, '9.9.9.9'),
        ).rejects.toMatchObject({
          status: 429,
          response: { code: 'TOO_MANY_REQUESTS' },
        });
        // another IP is fine
        await expect(
          service.request({ ...dto, email: 'u11@acme.com' }, '8.8.8.8'),
        ).resolves.toBeDefined();
      });

      it('applies the limits whether or not the account exists, so they reveal nothing', async () => {
        prisma.tenant.findUnique.mockResolvedValue(null);
        for (let i = 0; i < 10; i++) {
          await service.request({ ...dto, email: `n${i}@x.io` }, '7.7.7.7');
        }
        await expect(
          service.request({ ...dto, email: 'n11@x.io' }, '7.7.7.7'),
        ).rejects.toMatchObject({ status: 429 });
      });
    });
  });

  describe('confirm', () => {
    const reset = (over: Record<string, unknown> = {}) => ({
      id: 'r1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'u1', tenantId: 't1', role: 'agent', status: 'active' },
      ...over,
    });
    const dto = { token: 'the-token', password: 'brand-new-password' };

    beforeEach(() => {
      prisma.passwordReset.updateMany.mockResolvedValue({ count: 1 });
    });

    it('sets the new password and passwordChangedAt, uses up every reset link and writes the audit entry in the same transaction', async () => {
      prisma.passwordReset.findUnique.mockResolvedValue(reset());
      await service.confirm(dto);

      expect(prisma.passwordReset.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tokenHash: hashToken('the-token') },
        }),
      );
      const update = prisma.tenantUser.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'u1', tenantId: 't1' });
      expect(update.data.passwordChangedAt).toBeInstanceOf(Date);
      expect(await bcrypt.compare(dto.password, update.data.passwordHash)).toBe(
        true,
      );
      expect(prisma.passwordReset.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', usedAt: null },
        data: { usedAt: expect.any(Date) },
      });
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: 't1',
          actor: { userId: 'u1', role: 'agent' },
          action: 'password.reset',
          targetType: 'user',
          targetId: 'u1',
        },
        prisma,
      );
    });

    it.each([
      ['unknown', null],
      ['used', reset({ usedAt: new Date() })],
      ['expired', reset({ expiresAt: new Date(Date.now() - 1000) })],
      [
        'for a disabled user',
        reset({
          user: { id: 'u1', tenantId: 't1', role: 'agent', status: 'disabled' },
        }),
      ],
    ])(
      'rejects a token that is %s with 400 RESET_TOKEN_INVALID',
      async (_n, found) => {
        prisma.passwordReset.findUnique.mockResolvedValue(found);
        await expect(service.confirm(dto)).rejects.toMatchObject({
          status: 400,
          response: { code: 'RESET_TOKEN_INVALID' },
        });
        expect(prisma.tenantUser.update).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      },
    );

    it('is single use even when two requests race (the claim updates no row)', async () => {
      prisma.passwordReset.findUnique.mockResolvedValue(reset());
      prisma.passwordReset.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.confirm(dto)).rejects.toMatchObject({
        response: { code: 'RESET_TOKEN_INVALID' },
      });
      expect(prisma.tenantUser.update).not.toHaveBeenCalled();
    });
  });
});
