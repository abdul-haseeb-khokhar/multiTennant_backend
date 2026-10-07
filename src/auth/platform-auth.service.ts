import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformLoginDto } from './dto/platform-login.dto';
import { PLATFORM_SCOPE } from './platform-jwt.strategy';

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password', 10);

@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: PlatformLoginDto) {
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { email: dto.email },
    });
    const passwordMatches = await bcrypt.compare(
      dto.password,
      admin?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!admin || !passwordMatches) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_CREDENTIALS,
        'Invalid credentials',
      );
    }

    const access_token = this.jwtService.sign(
      { sub: admin.id, scope: PLATFORM_SCOPE },
      { expiresIn: this.config.get('PLATFORM_JWT_EXPIRES_IN', '1h') },
    );
    return { access_token };
  }
}
