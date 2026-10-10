import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { ROLES } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { assertTenantUsable } from '../auth/tenant-status';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService } from '../prisma/prisma.service';
import { StreamTicketService } from './stream-ticket.service';

const unauthorized = () =>
  new ApiException(
    HttpStatus.UNAUTHORIZED,
    ErrorCode.UNAUTHORIZED,
    'A valid access token or stream ticket is required',
  );

/**
 * Authentication of the dashboard event stream, in this order:
 *  1. an `Authorization: Bearer <staff token>` header, checked exactly like every other staff
 *     route (`JwtAuthGuard`: signature, user still active, current role, tenant matches the URL,
 *     tenant not suspended);
 *  2. otherwise a single-use `?ticket=` from `POST …/events/ticket`, valid for the URL's tenant.
 * The staff token itself is NEVER read from the query string: with no header and no valid ticket the
 * answer is 401, whatever else is in the URL.
 */
@Injectable()
export class StaffStreamGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtAuthGuard,
    private readonly tickets: StreamTicketService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    if (request.headers.authorization) {
      return this.jwt.canActivate(context);
    }
    const ticket =
      typeof request.query.ticket === 'string' ? request.query.ticket : '';
    const tenantId = request.params.tenantId as string | undefined;
    if (!ticket || ticket.length > 200 || !tenantId) throw unauthorized();

    const redeemed = await this.tickets.redeem(ticket, tenantId);
    if (!redeemed) throw unauthorized();

    // The same standing checks as JwtStrategy, read fresh: the user may have been disabled or have a
    // new password since the ticket was issued.
    const user = await this.prisma.tenantUser.findFirst({
      where: { id: redeemed.userId, tenantId },
      select: {
        role: true,
        status: true,
        emailVerifiedAt: true,
        passwordChangedAt: true,
      },
    });
    if (!user || !ROLES.includes(user.role as AuthUser['role'])) {
      throw unauthorized();
    }
    if (user.status !== 'active') {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.ACCOUNT_DISABLED,
        'This account is disabled',
      );
    }
    if (user.passwordChangedAt && user.passwordChangedAt > redeemed.issuedAt) {
      throw unauthorized();
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (!tenant) throw unauthorized();
    assertTenantUsable(tenant.status);

    request.user = {
      userId: redeemed.userId,
      tenantId,
      role: user.role as AuthUser['role'],
      emailVerified: user.emailVerifiedAt !== null,
    };
    return true;
  }
}
