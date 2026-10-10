import { HttpStatus, Injectable } from '@nestjs/common';
import { BillingEventType } from '../billing/billing.constants';
import { SubscriptionService } from '../billing/subscriptions/subscription.service';
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
    private readonly subscriptions: SubscriptionService,
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
   * `adminId` is the platform admin making the change. `name` and `defaultLocale` are plain
   * columns. `status` and `plan` belong to the subscription (the `tenants` columns are only its
   * mirrors, written by SubscriptionService alone), so they are applied as billing events, which
   * audit themselves: `suspended` suspends, `active`/`trial` lifts a suspension, `plan` changes
   * the plan without a payment. Use the /subscription endpoints for anything richer.
   */
  async update(id: string, dto: UpdateTenantDto, adminId: string) {
    await this.findOne(id);
    const actor = { userId: adminId, role: 'platform_admin' };
    const base = { tenantId: id, source: 'manual' as const, actor };

    // Subscription changes first: they can be refused (409/404) and must not leave a half update.
    if (dto.status !== undefined) {
      await this.subscriptions.applyEvent(
        dto.status === 'suspended'
          ? { ...base, type: BillingEventType.TENANT_SUSPENDED, payload: {} }
          : { ...base, type: BillingEventType.TENANT_UNSUSPENDED, payload: {} },
      );
    }
    if (dto.plan !== undefined) {
      await this.subscriptions.applyEvent({
        ...base,
        type: BillingEventType.PLAN_CHANGED,
        payload: { planCode: dto.plan },
      });
    }

    if (dto.name !== undefined || dto.defaultLocale !== undefined) {
      try {
        await this.prisma.tenant.update({
          where: { id },
          data: { name: dto.name, defaultLocale: dto.defaultLocale },
        });
      } catch (error) {
        if (isPrismaError(error, 'P2025')) {
          throw this.notFound(id);
        }
        throw error;
      }
    }
    return this.findOne(id);
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
