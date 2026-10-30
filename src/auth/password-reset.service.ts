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
import { SlugService } from '../slugs/slug.service';
import {
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
} from './dto/password-reset.dto';

const SALT_ROUNDS = 10;
const RESET_TTL_MS = 60 * 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_IP = 10;
const MAX_REQUESTS_PER_EMAIL = 3;

/**
 * Self-service password reset (H2, J2): hashed, single-use, one-hour tokens.
 *
 * Two ways in. With a workspace slug the reset covers that one workspace (the original flow).
 * With the email alone (J2) the person gets ONE email with ONE link, and confirming sets the new
 * password on EVERY membership with that address: proof of the mailbox covers them all. That is
 * the one deliberate cross-tenant write in the code base; the address comes from the reset
 * record's user row, never from the request.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
    private readonly slugs: SlugService,
  ) {}

  /**
   * Always succeeds from the caller's point of view, whether or not the account exists, so the
   * endpoint cannot be used to find out who has an account. Two limits apply: per IP (429 once
   * exceeded) and per email address (further requests are silently ignored, so an attacker learns
   * nothing from it and cannot flood one person's inbox). The per-email count is the same for both
   * ways in: asking by slug and by email alternately does not double it.
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
      `password-reset:email:${email}`,
      MAX_REQUESTS_PER_EMAIL,
      WINDOW_MS,
    );
    if (!byEmail.allowed) {
      return {};
    }

    const target = dto.tenantSlug
      ? await this.inWorkspace(dto.tenantSlug, email)
      : await this.byEmail(email);
    if (!target) {
      return {};
    }

    const { token, tokenHash } = generateToken();
    const now = new Date();
    await this.prisma.passwordReset.updateMany({
      where: { userId: target.userId, usedAt: null },
      data: { usedAt: now },
    });
    await this.prisma.passwordReset.create({
      data: {
        userId: target.userId,
        tokenHash,
        expiresAt: new Date(now.getTime() + RESET_TTL_MS),
        email,
        allWorkspaces: target.allWorkspaces,
      },
    });
    return this.mail.queue({
      to: email,
      template: 'password-reset',
      token,
      locale: target.locale,
    });
  }

  /**
   * Sets the new password and stamps `passwordChangedAt`, which invalidates every token issued
   * before this moment. Throws 400 for an unknown, used or expired token, a disabled user, or a
   * user whose email is no longer the one the link was sent to. A link requested by email alone
   * sets the same password (one hash) on every membership with that email.
   */
  async confirm(dto: PasswordResetConfirmDto) {
    const reset = await this.prisma.passwordReset.findUnique({
      where: { tokenHash: hashToken(dto.token) },
      include: {
        user: {
          select: {
            id: true,
            tenantId: true,
            role: true,
            status: true,
            email: true,
          },
        },
      },
    });
    const now = new Date();
    if (
      !reset ||
      reset.usedAt ||
      reset.expiresAt <= now ||
      reset.user.status !== 'active' ||
      // The address changed after the link was sent: whoever holds the old mailbox gets nothing.
      (reset.email !== null && reset.email !== reset.user.email)
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

      // Every workspace of this person for an email-only reset, else just this user.
      const affected = reset.allWorkspaces
        ? await tx.tenantUser.findMany({
            where: { email: user.email },
            select: { id: true, tenantId: true, role: true },
          })
        : [{ id: user.id, tenantId: user.tenantId, role: user.role }];
      if (reset.allWorkspaces) {
        await tx.tenantUser.updateMany({
          where: { email: user.email },
          data: { passwordHash, passwordChangedAt: now },
        });
      } else {
        await tx.tenantUser.update({
          where: { id: user.id, tenantId: user.tenantId },
          data: { passwordHash, passwordChangedAt: now },
        });
      }
      // Any other reset link for these users is dead as well.
      await tx.passwordReset.updateMany({
        where: { userId: { in: affected.map((m) => m.id) }, usedAt: null },
        data: { usedAt: now },
      });
      for (const member of affected) {
        await this.audit.record(
          {
            tenantId: member.tenantId,
            actor: { userId: member.id, role: member.role },
            action: AuditAction.PASSWORD_RESET,
            targetType: 'user',
            targetId: member.id,
            ...(reset.allWorkspaces && { after: { allWorkspaces: true } }),
          },
          tx,
        );
      }
    });
  }

  // -------------------------------------------------------------------------------------------

  /** The original flow: one workspace, by its slug (or an old slug it still answers to). */
  private async inWorkspace(slug: string, email: string) {
    const tenant = await this.slugs.resolveTenant(slug);
    const user = tenant
      ? await this.prisma.tenantUser.findFirst({
          where: { tenantId: tenant.id, email },
          select: { id: true, status: true, locale: true },
        })
      : null;
    if (!tenant || !user || user.status !== 'active') {
      return null;
    }
    return {
      userId: user.id,
      allWorkspaces: false,
      locale: user.locale ?? tenant.defaultLocale ?? DEFAULT_LOCALE,
    };
  }

  /**
   * J2: no slug. Any active membership with this email can hold the link (the oldest, so the
   * choice is stable); confirming applies to all of them. The language is that membership's.
   */
  private async byEmail(email: string) {
    const user = await this.prisma.tenantUser.findFirst({
      where: { email, status: 'active' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        locale: true,
        tenant: { select: { defaultLocale: true } },
      },
    });
    if (!user) {
      return null;
    }
    return {
      userId: user.id,
      allWorkspaces: true,
      locale: user.locale ?? user.tenant.defaultLocale ?? DEFAULT_LOCALE,
    };
  }

  private invalid() {
    return new ApiException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.RESET_TOKEN_INVALID,
      'This reset link is invalid or has expired',
    );
  }
}
