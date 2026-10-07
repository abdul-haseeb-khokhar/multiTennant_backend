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

/**
 * Staff authentication for tenant routes:
 * 1. a valid staff JWT (401 otherwise),
 * 2. the token's tenant equals `:tenantId` in the URL (403 TENANT_MISMATCH),
 * 3. the tenant is not suspended (403 TENANT_SUSPENDED, B6).
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
    if (tenant.status === 'suspended') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.TENANT_SUSPENDED,
        'This tenant is suspended',
      );
    }
    return true;
  }
}
