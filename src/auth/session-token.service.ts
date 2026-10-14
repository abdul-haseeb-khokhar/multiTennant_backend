import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TENANT_SCOPE } from './jwt.strategy';

/**
 * Issues the staff access token returned by login, signup and invite acceptance. Besides the
 * library's `iat` (whole seconds) the token carries `iatMs`, so a logout or a password change can
 * tell it from an earlier token in the same second (see `token-freshness.ts`).
 */
@Injectable()
export class SessionTokenService {
  constructor(private readonly jwtService: JwtService) {}

  sign(userId: string, tenantId: string, role: string) {
    return this.jwtService.sign({
      sub: userId,
      tenantId,
      role,
      scope: TENANT_SCOPE,
      iatMs: Date.now(),
    });
  }
}
