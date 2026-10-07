import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { isReservedSlug, slugify, withSuffix } from '../tenants/slug';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { TENANT_SCOPE } from './jwt.strategy';

const SALT_ROUNDS = 10;
const MAX_DERIVED_SLUG_ATTEMPTS = 5;

// Compared against when the tenant or user does not exist, so a failed login takes about as
// long whether or not the account exists.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password', SALT_ROUNDS);

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async login(dto: LoginDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: dto.tenantSlug },
    });
    const user = tenant
      ? await this.prisma.tenantUser.findFirst({
          where: { tenantId: tenant.id, email: dto.email },
        })
      : null;

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!tenant || !user || !passwordMatches) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_CREDENTIALS,
        'Invalid credentials',
      );
    }
    if (tenant.status === 'suspended') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.TENANT_SUSPENDED,
        'This tenant is suspended',
      );
    }

    return {
      access_token: this.signTenantToken(user.id, tenant.id, user.role),
    };
  }

  async signup(dto: SignupDto) {
    const passwordHash = await bcrypt.hash(dto.ownerPassword, SALT_ROUNDS);

    const explicitSlug = dto.tenantSlug;
    if (explicitSlug && isReservedSlug(explicitSlug)) {
      throw this.slugTaken();
    }
    const baseSlug = explicitSlug ?? slugify(dto.tenantName);

    let slug = baseSlug;
    for (let attempt = 1; ; attempt++) {
      try {
        const { tenant, owner } = await this.createTenantWithOwner(
          dto,
          slug,
          passwordHash,
        );
        return {
          tenant,
          owner,
          access_token: this.signTenantToken(owner.id, tenant.id, owner.role),
        };
      } catch (error) {
        // A new tenant has no users yet, so the only unique constraint that can fire is the slug.
        if (!isPrismaError(error, 'P2002')) {
          throw error;
        }
        if (explicitSlug || attempt >= MAX_DERIVED_SLUG_ATTEMPTS) {
          throw this.slugTaken();
        }
        slug = withSuffix(baseSlug);
      }
    }
  }

  private createTenantWithOwner(
    dto: SignupDto,
    slug: string,
    passwordHash: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: dto.tenantName, slug },
      });
      const owner = await tx.tenantUser.create({
        data: {
          tenantId: tenant.id,
          email: dto.ownerEmail,
          passwordHash,
          role: 'owner',
        },
        omit: { passwordHash: true },
      });
      return { tenant, owner };
    });
  }

  private signTenantToken(userId: string, tenantId: string, role: string) {
    return this.jwtService.sign({
      sub: userId,
      tenantId,
      role,
      scope: TENANT_SCOPE,
    });
  }

  private slugTaken() {
    return new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.SLUG_TAKEN,
      'This tenant slug is not available',
    );
  }
}
