import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/roles';
import { Clock } from '../billing/clock';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { SlugService } from '../slugs/slug.service';
import { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto';

/**
 * The workspace's own settings (J3, J7): any staff member reads them, the owner changes them. The
 * tenant is always the one in the verified token (rule 1); the route's `:tenantId` was already
 * checked against it by the guard.
 *
 * A slug rename (J3) is: free (see `SlugService`), at most once every 30 days, and it keeps the old
 * slug as an alias (30 days accepted at login, 90 days reserved). Taking and releasing slugs
 * happens in one transaction behind `SlugService.lock`, together with the audit entry.
 */
@Injectable()
export class TenantSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly slugs: SlugService,
    private readonly clock: Clock,
  ) {}

  async get(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) {
      throw this.notFound();
    }
    const previousSlugs = await this.prisma.tenantSlugAlias.findMany({
      where: { tenantId, reservedUntil: { gt: this.clock.now() } },
      orderBy: { createdAt: 'desc' },
      select: { slug: true, acceptedUntil: true, reservedUntil: true },
    });
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      defaultLocale: tenant.defaultLocale,
      timezone: tenant.timezone,
      createdAt: tenant.createdAt,
      slugChangedAt: tenant.slugChangedAt,
      slugChangeAllowedAt: this.slugs.nextChangeAllowedAt(tenant.slugChangedAt),
      previousSlugs,
    };
  }

  async update(actor: AuthUser, dto: UpdateTenantSettingsDto) {
    const { tenantId } = actor;
    try {
      await this.prisma.$transaction(async (tx) => {
        // Claims on slugs queue here, so the availability check below cannot go stale.
        await this.slugs.lock(tx);
        const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
        if (!tenant) {
          throw this.notFound();
        }

        const changes: Prisma.TenantUpdateInput = {};
        const before: Record<string, string> = {};
        const after: Record<string, string> = {};
        const plain = ['name', 'defaultLocale', 'timezone'] as const;
        for (const field of plain) {
          const value = dto[field];
          if (value !== undefined && value !== tenant[field]) {
            changes[field] = value;
            before[field] = tenant[field];
            after[field] = value;
          }
        }

        const newSlug =
          dto.slug !== undefined && dto.slug !== tenant.slug ? dto.slug : null;
        if (newSlug !== null) {
          await this.prepareRename(tx, tenant, newSlug);
          changes.slug = newSlug;
          changes.slugChangedAt = this.clock.now();
        }
        if (Object.keys(changes).length === 0) {
          return;
        }

        await tx.tenant.update({ where: { id: tenantId }, data: changes });

        const base = {
          tenantId,
          actor: { userId: actor.userId, role: actor.role },
          targetType: 'tenant',
          targetId: tenantId,
        };
        if (Object.keys(after).length > 0) {
          await this.audit.record(
            {
              ...base,
              action: AuditAction.TENANT_UPDATED,
              before,
              after,
            },
            tx,
          );
        }
        if (newSlug !== null) {
          await this.audit.record(
            {
              ...base,
              action: AuditAction.TENANT_SLUG_CHANGED,
              before: { slug: tenant.slug },
              after: { slug: newSlug },
            },
            tx,
          );
        }
      });
    } catch (error) {
      // Two renames to one slug that slipped past the lock: the unique index has the last word.
      if (isPrismaError(error, 'P2002') && dto.slug !== undefined) {
        throw await this.slugTaken(dto.slug, tenantId);
      }
      throw error;
    }
    return this.get(tenantId);
  }

  /**
   * The checks of a rename and its side effects on the alias table: not within 30 days of the last
   * one, the new slug free (409 `SLUG_TAKEN` with suggestions), the old slug kept as an alias, an
   * alias of this tenant's own that is being taken back removed.
   */
  private async prepareRename(
    tx: Prisma.TransactionClient,
    tenant: { id: string; slug: string; slugChangedAt: Date | null },
    newSlug: string,
  ) {
    const next = this.slugs.nextChangeAllowedAt(tenant.slugChangedAt);
    if (next) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.SLUG_CHANGE_TOO_SOON,
        'The slug can only be changed once every 30 days',
        { nextAllowedAt: next.toISOString() },
      );
    }
    if (!(await this.slugs.isAvailable(newSlug, tenant.id, tx))) {
      throw await this.slugTaken(newSlug, tenant.id, tx);
    }

    // Taking an old slug of its own back: it stops being an alias.
    await tx.tenantSlugAlias.deleteMany({
      where: { tenantId: tenant.id, slug: newSlug },
    });
    // The slug being given up: still accepted at login for 30 days, reserved for 90.
    const windows = this.slugs.aliasWindows();
    await tx.tenantSlugAlias.deleteMany({
      where: { tenantId: tenant.id, slug: tenant.slug },
    });
    await tx.tenantSlugAlias.create({
      data: { tenantId: tenant.id, slug: tenant.slug, ...windows },
    });
  }

  private async slugTaken(
    slug: string,
    tenantId: string,
    db?: Prisma.TransactionClient,
  ) {
    const suggestions = await this.slugs.suggest(slug, tenantId, db);
    return new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.SLUG_TAKEN,
      'This tenant slug is not available',
      { suggestions },
    );
  }

  private notFound() {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.TENANT_NOT_FOUND,
      'Tenant not found',
    );
  }
}
