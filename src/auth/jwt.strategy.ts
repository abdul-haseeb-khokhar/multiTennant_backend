import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, ROLES } from './roles';

export const TENANT_SCOPE = 'tenant';

interface TenantTokenPayload {
  sub?: string;
  tenantId?: string;
  role?: string;
  scope?: string;
  /** Issued-at, in seconds (set by the JWT library). */
  iat?: number;
}

/**
 * Verifies staff tokens (`scope: "tenant"`; platform-admin tokens are rejected here) and then
 * re-checks the user in the database on every request (H2): a deleted user, a disabled user or a
 * token issued before the last password change is refused at once, and the role used for
 * authorisation is the current one, not the one in the token. Costs one indexed lookup.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: TenantTokenPayload): Promise<AuthUser> {
    if (payload.scope !== TENANT_SCOPE || !payload.sub || !payload.tenantId) {
      throw new UnauthorizedException();
    }

    const user = await this.prisma.tenantUser.findUnique({
      where: { id: payload.sub, tenantId: payload.tenantId },
      select: {
        role: true,
        status: true,
        emailVerifiedAt: true,
        passwordChangedAt: true,
      },
    });
    if (!user || !ROLES.includes(user.role as AuthUser['role'])) {
      throw new UnauthorizedException();
    }
    if (user.status !== 'active') {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.ACCOUNT_DISABLED,
        'This account is disabled',
      );
    }
    // `iat` has one-second resolution: only a token from an earlier second than the password
    // change is rejected, so logging in right after a reset works.
    if (
      user.passwordChangedAt &&
      (payload.iat === undefined ||
        payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000))
    ) {
      throw new UnauthorizedException();
    }

    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: user.role as AuthUser['role'],
      emailVerified: user.emailVerifiedAt !== null,
    };
  }
}
