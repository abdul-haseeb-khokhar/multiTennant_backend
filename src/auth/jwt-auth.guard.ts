import {
  ExecutionContext,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService } from '../prisma/prisma.service';
import { assertTenantUsable } from './tenant-status';

/**
 * Staff authentication for tenant routes:
 * 1. a valid staff JWT (401 otherwise),
 * 2. the token's tenant equals `:tenantId` in the URL (403 TENANT_MISMATCH),
 * 3. the tenant is not suspended or closed (403 TENANT_SUSPENDED / TENANT_CLOSED, B6). The check reads
 *    the `tenants.status` mirror of the subscription, kept in step by SubscriptionService.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isAuthenticated = (await super.canActivate(context)) as boolean;
    if (!isAuthenticated) {
      return false;
    }

    const request = context.switchToHttp().getRequest();
    const routeTenantId = request.params.tenantId;
    if (routeTenantId && routeTenantId !== request.user.tenantId) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.TENANT_MISMATCH,
        'You do not have access to this tenant',
      );
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: request.user.tenantId },
      select: { status: true },
    });
    if (!tenant) {
      throw new UnauthorizedException();
    }
    assertTenantUsable(tenant.status);
    return true;
  }
}
