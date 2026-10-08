import { HttpStatus, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { normalizeEmail } from '../common/validation/email';
import { DEFAULT_LOCALE } from '../i18n/locales';
import { SubscriptionService } from '../billing/subscriptions/subscription.service';
import { PrismaService } from '../prisma/prisma.service';
import { isReservedSlug, slugify, withSuffix } from '../tenants/slug';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { EmailVerificationService } from './email-verification.service';
import { SessionTokenService } from './session-token.service';
import { assertTenantUsable } from './tenant-status';

const SALT_ROUNDS = 10;
const MAX_DERIVED_SLUG_ATTEMPTS = 5;

// Compared against when the tenant or user does not exist, so a failed login takes about as
// long whether or not the account exists.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password', SALT_ROUNDS);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionTokens: SessionTokenService,
    private readonly emailVerification: EmailVerificationService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  async login(dto: LoginDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: dto.tenantSlug },
    });
    const user = tenant
      ? await this.prisma.tenantUser.findFirst({
          where: { tenantId: tenant.id, email: normalizeEmail(dto.email) },
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
    // Only after the password matched, so this does not reveal which accounts exist.
    if (user.status !== 'active') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.ACCOUNT_DISABLED,
        'This account is disabled',
      );
    }
    assertTenantUsable(tenant.status);

    return {
      access_token: this.sessionTokens.sign(user.id, tenant.id, user.role),
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
        // The owner can use the trial straight away; inviting staff waits for the verification
        // link (H4). A mail problem must not undo a completed signup, hence the background send.
        const verification = await this.emailVerification.issue({
          id: owner.id,
          email: owner.email,
          locale: tenant.defaultLocale,
        });
        return {
          tenant,
          owner,
          access_token: this.sessionTokens.sign(
            owner.id,
            tenant.id,
            owner.role,
          ),
          // Only with MAIL_MODE=link (development).
          verificationLink: verification.link,
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
        data: {
          name: dto.tenantName,
          slug,
          defaultLocale: dto.locale ?? DEFAULT_LOCALE,
        },
      });
      const owner = await tx.tenantUser.create({
        data: {
          tenantId: tenant.id,
          email: normalizeEmail(dto.ownerEmail),
          passwordHash,
          role: 'owner',
        },
        omit: { passwordHash: true },
      });
      // Every new tenant starts on Starter for 15 days (I2), in the same transaction.
      await this.subscriptions.createStarter(tx, tenant.id);
      return { tenant, owner };
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
