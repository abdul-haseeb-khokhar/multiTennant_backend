import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { IssuedAtClaims, wasIssuedBefore } from './token-freshness';

export const PLATFORM_SCOPE = 'platform';

export interface PlatformUser {
  adminId: string;
}

/**
 * Verifies platform-admin tokens (`scope: "platform"`, B1). Staff tokens are rejected here. The
 * admin is re-read on every request: a deleted admin, or a token issued before the admin's last
 * logout (`tokensValidAfter`, J1), is refused at once.
 */
@Injectable()
export class PlatformJwtStrategy extends PassportStrategy(
  Strategy,
  'platform-jwt',
) {
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

  async validate(
    payload: { sub?: string; scope?: string } & IssuedAtClaims,
  ): Promise<PlatformUser> {
    if (payload.scope !== PLATFORM_SCOPE || !payload.sub) {
      throw new UnauthorizedException();
    }
    // A deleted admin loses access immediately instead of at token expiry.
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { id: payload.sub },
      select: { id: true, tokensValidAfter: true },
    });
    if (!admin) {
      throw new UnauthorizedException();
    }
    if (
      admin.tokensValidAfter &&
      wasIssuedBefore(payload, admin.tokensValidAfter)
    ) {
      throw new UnauthorizedException();
    }
    return { adminId: admin.id };
  }
}
