import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { EmailVerificationService } from '../auth/email-verification.service';
import { AuthUser } from '../auth/roles';
import { EntitlementsService } from '../billing/entitlements/entitlements.service';
import { ConversationsService } from '../conversations/conversations.service';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { resolvePage, toPage } from '../common/pagination/pagination';
import { normalizeEmail } from '../common/validation/email';
import { DEFAULT_LOCALE } from '../i18n/locales';
import { PrismaService } from '../prisma/prisma.service';
import { QueryTenantUserDto } from './dto/query-tenant-user.dto';
import { UpdateTenantUserDto } from './dto/update-tenant-user.dto';

const MAX_SERIALIZATION_ATTEMPTS = 3;

/**
 * Every method takes `tenantId` first and puts it in each query's `where`. `actor` is the staff
 * member making the change; it drives the owner rules from the role matrix (B2): only an owner
 * may change, disable or delete an owner or promote someone to owner, and a tenant never loses
 * its last active owner. People join through invitations (`InvitesService`), so there is no
 * create here, and nobody can set another person's password.
 *
 * Changes that depend on a count (the last-owner rule) run in a serializable transaction, so two
 * simultaneous owner removals cannot both pass the check. Role and status changes also write
 * their audit entry in the same transaction.
 */
@Injectable()
export class TenantUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emailVerification: EmailVerificationService,
    private readonly entitlements: EntitlementsService,
    private readonly conversations: ConversationsService,
  ) {}

  async findAll(tenantId: string, query: QueryTenantUserDto, actor: AuthUser) {
    const page = resolvePage(query);
    const [data, total] = await Promise.all([
      this.prisma.tenantUser.findMany({
        where: { tenantId },
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        omit: this.hiddenFields(actor),
      }),
      this.prisma.tenantUser.count({ where: { tenantId } }),
    ]);
    return toPage(data, total, page);
  }

  async findOne(tenantId: string, id: string, actor: AuthUser) {
    const user = await this.prisma.tenantUser.findFirst({
      where: { id, tenantId },
      omit: this.hiddenFields(actor),
    });
    if (!user) {
      throw this.notFound(id);
    }
    return user;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateTenantUserDto,
    actor: AuthUser,
  ) {
    const email = dto.email ? normalizeEmail(dto.email) : undefined;
    let emailChanged: { id: string; email: string; locale: string } | undefined;
    let becameDisabled = false;

    try {
      const updated = await this.serializable(async (tx) => {
        const existing = await tx.tenantUser.findFirst({
          where: { id, tenantId },
          omit: { passwordHash: true },
        });
        if (!existing) {
          throw this.notFound(id);
        }
        if (existing.role === 'owner' || dto.role === 'owner') {
          this.requireOwner(actor);
        }
        const stopsBeingActiveOwner =
          existing.role === 'owner' &&
          existing.status === 'active' &&
          ((dto.role !== undefined && dto.role !== 'owner') ||
            dto.status === 'disabled');
        if (stopsBeingActiveOwner) {
          await this.assertAnotherActiveOwner(tx, tenantId, id);
        }

        // A disabled user becoming active takes a seat again (plan seat limit, I5).
        if (dto.status === 'active' && existing.status !== 'active') {
          await this.entitlements.assertSeatAvailable(
            tx,
            tenantId,
            'reactivate',
          );
        }

        const data: Prisma.TenantUserUpdateInput = {};
        const newEmail = email !== undefined && email !== existing.email;
        if (newEmail) {
          data.email = email;
          // The new address has not proven itself yet.
          data.emailVerifiedAt = null;
        }
        if (dto.role !== undefined) data.role = dto.role;
        if (dto.status !== undefined) data.status = dto.status;

        const user = await tx.tenantUser.update({
          where: { id, tenantId },
          data,
          omit: { passwordHash: true },
        });
        becameDisabled =
          existing.status !== 'disabled' && user.status === 'disabled';

        const base = {
          tenantId,
          actor: { userId: actor.userId, role: actor.role },
          targetType: 'user',
          targetId: id,
        };
        if (user.role !== existing.role) {
          await this.audit.record(
            {
              ...base,
              action: AuditAction.USER_ROLE_CHANGED,
              before: { role: existing.role },
              after: { role: user.role },
            },
            tx,
          );
        }
        if (user.status !== existing.status) {
          await this.audit.record(
            {
              ...base,
              action:
                user.status === 'disabled'
                  ? AuditAction.USER_DISABLED
                  : AuditAction.USER_ENABLED,
              before: { status: existing.status },
              after: { status: user.status },
            },
            tx,
          );
        }
        if (newEmail) {
          await this.audit.record(
            {
              ...base,
              action: AuditAction.USER_EMAIL_CHANGED,
              before: { email: existing.email },
              after: { email: user.email },
            },
            tx,
          );
          const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: { defaultLocale: true },
          });
          emailChanged = {
            id: user.id,
            email: user.email,
            locale: user.locale ?? tenant?.defaultLocale ?? DEFAULT_LOCALE,
          };
        }
        return user;
      });

      if (emailChanged) {
        await this.emailVerification.issue(emailChanged);
      }
      if (becameDisabled) {
        // The conversations they held would wait for nobody: back to the queue (best effort).
        await this.conversations.releaseHeldBy(actor, id, 'assignee_disabled');
      }
      return updated;
    } catch (error) {
      if (isPrismaError(error, 'P2002')) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          ErrorCode.EMAIL_TAKEN,
          'A user with this email already exists for this tenant',
        );
      }
      if (isPrismaError(error, 'P2025')) {
        throw this.notFound(id);
      }
      throw error;
    }
  }

  async remove(tenantId: string, id: string, actor: AuthUser) {
    try {
      const removed = await this.serializable(async (tx) => {
        const existing = await tx.tenantUser.findFirst({
          where: { id, tenantId },
          omit: { passwordHash: true },
        });
        if (!existing) {
          throw this.notFound(id);
        }
        if (existing.role === 'owner') {
          this.requireOwner(actor);
          if (existing.status === 'active') {
            await this.assertAnotherActiveOwner(tx, tenantId, id);
          }
        }
        const removed = await tx.tenantUser.delete({
          where: { id, tenantId },
          omit: { passwordHash: true },
        });
        await this.audit.record(
          {
            tenantId,
            actor: { userId: actor.userId, role: actor.role },
            action: AuditAction.USER_DELETED,
            targetType: 'user',
            targetId: id,
            before: removed,
          },
          tx,
        );
        return removed;
      });
      // Their conversations go back to the queue (best effort, after the delete committed).
      await this.conversations.releaseHeldBy(actor, id, 'assignee_deleted');
      return removed;
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw this.notFound(id);
      }
      throw error;
    }
  }

  /**
   * Columns left out of a read. The password hash never leaves; when the password last changed
   * and whether the email was confirmed are account-security details for owners and admins only
   * (G23.3), not for an agent browsing the team.
   */
  private hiddenFields(actor: AuthUser) {
    return actor.role === 'agent'
      ? { passwordHash: true, passwordChangedAt: true, emailVerifiedAt: true }
      : { passwordHash: true };
  }

  /** Runs `fn` in a serializable transaction, retrying when Postgres aborts it for a conflict. */
  private async serializable<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isPrismaError(error, 'P2034')) {
          throw error;
        }
        if (attempt >= MAX_SERIALIZATION_ATTEMPTS) {
          throw new ApiException(
            HttpStatus.CONFLICT,
            ErrorCode.CONFLICT,
            'The change conflicted with another one, please retry',
          );
        }
      }
    }
  }

  private requireOwner(actor: AuthUser) {
    if (actor.role !== 'owner') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.OWNER_REQUIRED,
        'Only an owner can change, disable or remove an owner',
      );
    }
  }

  /** The tenant must keep at least one active owner besides `userId`. */
  private async assertAnotherActiveOwner(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
  ) {
    const others = await tx.tenantUser.count({
      where: { tenantId, role: 'owner', status: 'active', id: { not: userId } },
    });
    if (others === 0) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.LAST_OWNER,
        'A tenant must keep at least one active owner',
      );
    }
  }

  private notFound(id: string) {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.USER_NOT_FOUND,
      `Tenant user ${id} not found`,
    );
  }
}
