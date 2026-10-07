import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TENANT_SCOPE } from './jwt.strategy';

/** Issues the staff access token returned by login, signup and invite acceptance. */
@Injectable()
export class SessionTokenService {
  constructor(private readonly jwtService: JwtService) {}

  sign(userId: string, tenantId: string, role: string) {
    return this.jwtService.sign({
      sub: userId,
      tenantId,
      role,
      scope: TENANT_SCOPE,
    });
  }
}
