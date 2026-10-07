import { HttpStatus, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AcceptInviteDto } from '../auth/dto/accept-invite.dto';
import type { AuthUser } from '../auth/roles';
import { SessionTokenService } from '../auth/session-token.service';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { resolvePage, toPage } from '../common/pagination/pagination';
import { generateToken, hashToken } from '../common/tokens/tokens';
import { normalizeEmail } from '../common/validation/email';
import { DEFAULT_LOCALE } from '../i18n/locales';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { QueryInviteDto } from './dto/query-invite.dto';

const SALT_ROUNDS = 10;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Staff invitations (H1): an owner or admin never sets another person's password; they invite by
 * email and the invitee sets their own. Tokens are 32 random bytes, stored hashed, single use,
 * valid for seven days. Management methods take `tenantId` first and scope every query to it;
 * `accept` is public and takes the tenant from the invite the token belongs to.
 */
@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly sessionTokens: SessionTokenService,
  ) {}

  /**
   * Creates an invite and emails the link. Inviting an address that already has a pending invite
   * replaces it (the old link stops working), which doubles as "resend".
   */
  async create(tenantId: string, dto: CreateInviteDto, actor: AuthUser) {
    const role = dto.role ?? 'agent';
    if (role === 'owner') {
      this.requireOwner(actor);
    }
    const email = normalizeEmail(dto.email);

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { defaultLocale: true },
    });
    if (!tenant) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.TENANT_NOT_FOUND,
        `Tenant ${tenantId} not found`,
      );
    }
    const existing = await this.prisma.tenantUser.findFirst({
      where: { tenantId, email },
      select: { id: true },
    });
    if (existing) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.EMAIL_TAKEN,
        'A user with this email already exists for this tenant',
      );
    }

    const { token, tokenHash } = generateToken();
    const now = new Date();
    const invite = await this.prisma.$transaction(async (tx) => {
      await tx.staffInvite.updateMany({
        where: { tenantId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      const created = await tx.staffInvite.create({
        data: {
          tenantId,
          email,
          role,
          tokenHash,
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
          invitedBy: actor.userId,
        },
        omit: { tokenHash: true },
      });
      await this.audit.record(
        {
          tenantId,
          actor: { userId: actor.userId, role: actor.role },
          action: AuditAction.USER_INVITED,
          targetType: 'invite',
          targetId: created.id,
          after: { email, role, expiresAt: created.expiresAt },
        },
        tx,
      );
      return created;
    });

    const { link } = await this.mail.sendNow({
      to: email,
      template: 'staff-invite',
      token,
      locale: tenant.defaultLocale ?? DEFAULT_LOCALE,
    });
    return { ...invite, link };
  }

  /** Pending invites only: not accepted, not revoked, not expired. */
  async findAll(tenantId: string, query: QueryInviteDto) {
    const page = resolvePage(query);
    const where = {
      tenantId,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    };
    const [data, total] = await Promise.all([
      this.prisma.staffInvite.findMany({
        where,
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        omit: { tokenHash: true },
      }),
      this.prisma.staffInvite.count({ where }),
    ]);
    return toPage(data, total, page);
  }

  async revoke(tenantId: string, id: string, actor: AuthUser) {
    const invite = await this.prisma.staffInvite.findFirst({
      where: { id, tenantId, acceptedAt: null, revokedAt: null },
      select: { role: true },
    });
    if (!invite) {
      throw this.notFound(id);
    }
    if (invite.role === 'owner') {
      this.requireOwner(actor);
    }
    try {
      return await this.prisma.staffInvite.update({
        where: { id, tenantId },
        data: { revokedAt: new Date() },
        omit: { tokenHash: true },
      });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw this.notFound(id);
      }
      throw error;
    }
  }

  /** Public: turns a valid token into a user (already verified) and a session. */
  async accept(dto: AcceptInviteDto) {
    const invite = await this.prisma.staffInvite.findUnique({
      where: { tokenHash: hashToken(dto.token) },
      include: { tenant: { select: { status: true } } },
    });
    const now = new Date();
    if (
      !invite ||
      invite.acceptedAt ||
      invite.revokedAt ||
      invite.expiresAt <= now
    ) {
      throw this.invalid();
    }
    if (invite.tenant.status === 'suspended') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.TENANT_SUSPENDED,
        'This tenant is suspended',
      );
    }
    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        // Claiming the invite first makes it single use even when two requests race.
        const claimed = await tx.staffInvite.updateMany({
          where: {
            id: invite.id,
            tenantId: invite.tenantId,
            acceptedAt: null,
            revokedAt: null,
          },
          data: { acceptedAt: now },
        });
        if (claimed.count !== 1) {
          throw this.invalid();
        }
        const created = await tx.tenantUser.create({
          data: {
            tenantId: invite.tenantId,
            email: invite.email,
            passwordHash,
            role: invite.role,
            name: dto.name,
            // They received the link at this address, which proves they control it (H4).
            emailVerifiedAt: now,
          },
          omit: { passwordHash: true },
        });
        await this.audit.record(
          {
            tenantId: invite.tenantId,
            actor: { userId: created.id, role: created.role },
            action: AuditAction.INVITE_ACCEPTED,
            targetType: 'invite',
            targetId: invite.id,
            after: {
              userId: created.id,
              email: created.email,
              role: created.role,
            },
          },
          tx,
        );
        return created;
      });
      return {
        access_token: this.sessionTokens.sign(
          user.id,
          user.tenantId,
          user.role,
        ),
        user,
      };
    } catch (error) {
      if (isPrismaError(error, 'P2002')) {
        // Someone created this user another way since the invite went out; the transaction
        // rolled back, so the invite stays pending.
        throw new ApiException(
          HttpStatus.CONFLICT,
          ErrorCode.EMAIL_TAKEN,
          'A user with this email already exists for this tenant',
        );
      }
      throw error;
    }
  }

  private requireOwner(actor: AuthUser) {
    if (actor.role !== 'owner') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.OWNER_REQUIRED,
        'Only an owner can invite or revoke an owner invite',
      );
    }
  }

  private notFound(id: string) {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.INVITE_NOT_FOUND,
      `Pending invite ${id} not found`,
    );
  }

  private invalid() {
    return new ApiException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.INVITE_INVALID,
      'This invitation is invalid or has expired',
    );
  }
}
