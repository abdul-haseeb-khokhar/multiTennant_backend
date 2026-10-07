import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { generateToken, hashToken } from '../common/tokens/tokens';
import { MailService } from '../mail/mail.service';
import { DEFAULT_LOCALE } from '../i18n/locales';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './roles';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Email verification links (H4). The token is single use and stored hashed. */
@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /**
   * Creates a verification link for the user and emails it in the background. Earlier unused
   * links stop working. Returns the link only when `MAIL_MODE=link`.
   */
  async issue(user: {
    id: string;
    email: string;
    locale: string;
  }): Promise<{ link?: string }> {
    const { token, tokenHash } = generateToken();
    const now = new Date();
    await this.prisma.emailVerification.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    });
    await this.prisma.emailVerification.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
      },
    });
    return this.mail.queue({
      to: user.email,
      template: 'email-verification',
      token,
      locale: user.locale,
    });
  }

  /** Sends a fresh link to the signed-in user; a user who is already verified gets nothing. */
  async resend(actor: AuthUser): Promise<{ link?: string }> {
    const user = await this.prisma.tenantUser.findFirst({
      where: { id: actor.userId, tenantId: actor.tenantId },
      select: {
        id: true,
        email: true,
        locale: true,
        emailVerifiedAt: true,
        tenant: { select: { defaultLocale: true } },
      },
    });
    if (!user || user.emailVerifiedAt) {
      return {};
    }
    return this.issue({
      id: user.id,
      email: user.email,
      locale: user.locale ?? user.tenant.defaultLocale ?? DEFAULT_LOCALE,
    });
  }

  /** Marks the user's email as verified. Throws 400 for an unknown, used or expired token. */
  async verify(token: string) {
    const record = await this.prisma.emailVerification.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { id: true, tenantId: true } } },
    });
    const now = new Date();
    if (!record || record.usedAt || record.expiresAt <= now) {
      throw this.invalid();
    }

    await this.prisma.$transaction(async (tx) => {
      // Claiming the row first makes the link single use even when two requests race.
      const claimed = await tx.emailVerification.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) {
        throw this.invalid();
      }
      await tx.tenantUser.update({
        where: { id: record.user.id, tenantId: record.user.tenantId },
        data: { emailVerifiedAt: now },
      });
    });
  }

  private invalid() {
    return new ApiException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VERIFICATION_TOKEN_INVALID,
      'This verification link is invalid or has expired',
    );
  }
}
