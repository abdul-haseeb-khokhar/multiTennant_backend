import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser, ROLES } from './roles';

export const TENANT_SCOPE = 'tenant';

interface TenantTokenPayload {
  sub?: string;
  tenantId?: string;
  role?: string;
  scope?: string;
}

/** Verifies staff tokens (`scope: "tenant"`). Platform-admin tokens are rejected here. */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: TenantTokenPayload): AuthUser {
    if (
      payload.scope !== TENANT_SCOPE ||
      !payload.sub ||
      !payload.tenantId ||
      !ROLES.includes(payload.role as AuthUser['role'])
    ) {
      throw new UnauthorizedException();
    }
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role as AuthUser['role'],
    };
  }
}
