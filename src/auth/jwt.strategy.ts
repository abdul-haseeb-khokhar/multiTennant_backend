import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, ROLES } from './roles';
import { IssuedAtClaims, wasIssuedBefore } from './token-freshness';

export const TENANT_SCOPE = 'tenant';

interface TenantTokenPayload extends IssuedAtClaims {
  sub?: string;
  tenantId?: string;
  role?: string;
  scope?: string;
}

/**
 * Verifies staff tokens (`scope: "tenant"`; platform-admin tokens are rejected here) and then
 * re-checks the user in the database on every request (H2): a deleted user, a disabled user, a
 * token issued before the last password change (H2) or before the last logout (`tokensValidAfter`,
 * J1) is refused at once, and the role used for
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
        tokensValidAfter: true,
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
    // A password change and a logout both end every earlier token of the user. `wasIssuedBefore`
    // compares in milliseconds when the token carries `iatMs`, so a login right after either works.
    for (const cutoff of [user.passwordChangedAt, user.tokensValidAfter]) {
      if (cutoff && wasIssuedBefore(payload, cutoff)) {
        throw new UnauthorizedException();
      }
    }

    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: user.role as AuthUser['role'],
      emailVerified: user.emailVerifiedAt !== null,
    };
  }
}
