import { HttpStatus, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuditAction, AuditService } from '../audit/audit.service';
import { RateLimitedException } from '../common/errors/rate-limited.exception';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { generateToken, hashToken } from '../common/tokens/tokens';
import { normalizeEmail } from '../common/validation/email';
import { DEFAULT_LOCALE } from '../i18n/locales';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
} from './dto/password-reset.dto';

const SALT_ROUNDS = 10;
const RESET_TTL_MS = 60 * 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_IP = 10;
const MAX_REQUESTS_PER_EMAIL = 3;

/** Self-service password reset (H2): hashed, single-use, one-hour tokens. */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
  ) {}

  /**
   * Always succeeds from the caller's point of view, whether or not the account exists, so the
   * endpoint cannot be used to find out who has an account. Two limits apply: per IP (429 once
   * exceeded) and per tenant+email (further requests are silently ignored, so an attacker learns
   * nothing from it and cannot flood one person's inbox).
   */
  async request(
    dto: PasswordResetRequestDto,
    ip: string,
  ): Promise<{ link?: string }> {
    const email = normalizeEmail(dto.email);
    const byIp = this.limiter.hit(
      `password-reset:ip:${ip}`,
      MAX_REQUESTS_PER_IP,
      WINDOW_MS,
    );
    if (!byIp.allowed) {
      throw new RateLimitedException(byIp.retryAfterSeconds);
    }
    const byEmail = this.limiter.hit(
      `password-reset:email:${dto.tenantSlug}:${email}`,
      MAX_REQUESTS_PER_EMAIL,
      WINDOW_MS,
    );
    if (!byEmail.allowed) {
      return {};
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: dto.tenantSlug },
      select: { id: true, status: true, defaultLocale: true },
    });
    const user = tenant
      ? await this.prisma.tenantUser.findFirst({
          where: { tenantId: tenant.id, email },
          select: { id: true, status: true, locale: true },
        })
      : null;
    if (!tenant || !user || user.status !== 'active') {
      return {};
    }

    const { token, tokenHash } = generateToken();
    const now = new Date();
    await this.prisma.passwordReset.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    });
    await this.prisma.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(now.getTime() + RESET_TTL_MS),
      },
    });
    return this.mail.queue({
      to: email,
      template: 'password-reset',
      token,
      locale: user.locale ?? tenant.defaultLocale ?? DEFAULT_LOCALE,
    });
  }

  /**
   * Sets the new password and stamps `passwordChangedAt`, which invalidates every token issued
   * before this moment. Throws 400 for an unknown, used or expired token or a disabled user.
   */
  async confirm(dto: PasswordResetConfirmDto) {
    const reset = await this.prisma.passwordReset.findUnique({
      where: { tokenHash: hashToken(dto.token) },
      include: {
        user: {
          select: { id: true, tenantId: true, role: true, status: true },
        },
      },
    });
    const now = new Date();
    if (
      !reset ||
      reset.usedAt ||
      reset.expiresAt <= now ||
      reset.user.status !== 'active'
    ) {
      throw this.invalid();
    }
    const { user } = reset;
    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    await this.prisma.$transaction(async (tx) => {
      // Claiming the row first makes the link single use even when two requests race.
      const claimed = await tx.passwordReset.updateMany({
        where: { id: reset.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) {
        throw this.invalid();
      }
      await tx.tenantUser.update({
        where: { id: user.id, tenantId: user.tenantId },
        data: { passwordHash, passwordChangedAt: now },
      });
      // Any other reset link for this user is dead as well.
      await tx.passwordReset.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      });
      await this.audit.record(
        {
          tenantId: user.tenantId,
          actor: { userId: user.id, role: user.role },
          action: AuditAction.PASSWORD_RESET,
          targetType: 'user',
          targetId: user.id,
        },
        tx,
      );
    });
  }

  private invalid() {
    return new ApiException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.RESET_TOKEN_INVALID,
      'This reset link is invalid or has expired',
    );
  }
}
