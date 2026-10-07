import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { resolvePage, toPage } from '../common/pagination/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { QueryTenantDto } from './dto/query-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';

/** Cross-tenant operations for platform admins. Tenant creation lives in `AuthService.signup`. */
@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(query: QueryTenantDto) {
    const page = resolvePage(query);
    const [data, total] = await Promise.all([
      this.prisma.tenant.findMany({
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.tenant.count(),
    ]);
    return toPage(data, total, page);
  }

  async findOne(id: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw this.notFound(id);
    }
    return tenant;
  }

  /**
   * `adminId` is the platform admin making the change. Suspending or reactivating a tenant is
   * written to that tenant's audit log (H6) in the same transaction.
   */
  async update(id: string, dto: UpdateTenantDto, adminId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.tenant.findUnique({ where: { id } });
        if (!existing) {
          throw this.notFound(id);
        }
        const updated = await tx.tenant.update({
          where: { id },
          data: {
            name: dto.name,
            plan: dto.plan,
            status: dto.status,
            defaultLocale: dto.defaultLocale,
          },
        });
        const suspended =
          updated.status === 'suspended' && existing.status !== 'suspended';
        const reactivated =
          existing.status === 'suspended' && updated.status !== 'suspended';
        if (suspended || reactivated) {
          await this.audit.record(
            {
              tenantId: id,
              actor: { userId: adminId, role: 'platform_admin' },
              action: suspended
                ? AuditAction.TENANT_SUSPENDED
                : AuditAction.TENANT_REACTIVATED,
              targetType: 'tenant',
              targetId: id,
              before: { status: existing.status },
              after: { status: updated.status },
            },
            tx,
          );
        }
        return updated;
      });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw this.notFound(id);
      }
      throw error;
    }
  }

  async remove(id: string) {
    try {
      return await this.prisma.tenant.delete({ where: { id } });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw this.notFound(id);
      }
      if (isPrismaError(error, 'P2003')) {
        // ON DELETE RESTRICT: a tenant with users, customers or engine data goes through
        // the offboarding procedure (architecture 5.6), not a bare delete.
        throw new ApiException(
          HttpStatus.CONFLICT,
          ErrorCode.TENANT_HAS_DEPENDENCIES,
          `Tenant ${id} still has users or customers and cannot be deleted`,
        );
      }
      throw error;
    }
  }

  private notFound(id: string) {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.TENANT_NOT_FOUND,
      `Tenant ${id} not found`,
    );
  }
}
