import { HttpStatus, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AgentProvisioningService } from '../agents/agent-provisioning.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { normalizeEmail } from '../common/validation/email';
import { DEFAULT_LOCALE } from '../i18n/locales';
import { SubscriptionService } from '../billing/subscriptions/subscription.service';
import { PrismaService } from '../prisma/prisma.service';
import { SlugService } from '../slugs/slug.service';
import { slugify, withSuffix } from '../tenants/slug';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { EmailVerificationService } from './email-verification.service';
import { AuthUser } from './roles';
import { LoginThrottleService } from './login-throttle.service';
import { SessionTokenService } from './session-token.service';
import { assertTenantUsable } from './tenant-status';

const SALT_ROUNDS = 10;
const MAX_DERIVED_SLUG_ATTEMPTS = 5;

// Compared against when the tenant or user does not exist, so a failed login takes about as
// long whether or not the account exists.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password', SALT_ROUNDS);

/** Thrown inside the signup transaction when the wanted slug is not free. */
class SlugUnavailableError extends Error {}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionTokens: SessionTokenService,
    private readonly emailVerification: EmailVerificationService,
    private readonly subscriptions: SubscriptionService,
    private readonly audit: AuditService,
    private readonly slugs: SlugService,
    private readonly throttle: LoginThrottleService,
    private readonly agents: AgentProvisioningService,
  ) {}

  /**
   * Login with the workspace slug (the original flow, kept for workspace-specific links). Throttled
   * like the email-first login: see `LoginThrottleService`.
   */
  async login(dto: LoginDto, ip: string) {
    this.throttle.assertAllowed(ip, dto.email);
    // The tenant's current slug, or the one it had in the last 30 days (J3).
    const tenant = await this.slugs.resolveTenant(dto.tenantSlug);
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
      this.throttle.recordFailure(ip, dto.email);
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_CREDENTIALS,
        'Invalid credentials',
      );
    }
    this.throttle.recordSuccess(ip, dto.email);
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

  /**
   * Ends every session of the user (J1): all tokens issued before now stop working, on every
   * device. The stamp and its audit entry commit together. A login afterwards gets a token issued
   * after the stamp (compared to the millisecond, see `token-freshness.ts`).
   */
  async logout(actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantUser.update({
        where: { id: actor.userId, tenantId: actor.tenantId },
        data: { tokensValidAfter: new Date() },
      });
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actor: { userId: actor.userId, role: actor.role },
          action: AuditAction.AUTH_LOGOUT,
          targetType: 'user',
          targetId: actor.userId,
        },
        tx,
      );
    });
  }

  async signup(dto: SignupDto) {
    const passwordHash = await bcrypt.hash(dto.ownerPassword, SALT_ROUNDS);

    const explicitSlug = dto.tenantSlug;
    if (explicitSlug && !this.slugs.isUsable(explicitSlug)) {
      throw await this.slugTaken(explicitSlug);
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
        // link (H4). A mail problem must not undo a completed signup: a failed send is reported as
        // `verificationDelivery: 'failed'` and the owner can resend from the dashboard.
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
          verificationDelivery: verification.delivery,
        };
      } catch (error) {
        // The slug is taken or reserved (SlugUnavailableError), or lost a race for it. A new tenant
        // has no users yet, so the only unique constraint that can fire is the slug.
        if (
          !(error instanceof SlugUnavailableError) &&
          !isPrismaError(error, 'P2002')
        ) {
          throw error;
        }
        if (explicitSlug || attempt >= MAX_DERIVED_SLUG_ATTEMPTS) {
          throw await this.slugTaken(slug);
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
      // A slug is taken by a tenant that has it, and for 90 days by one that gave it up (J3).
      await this.slugs.lock(tx);
      if (!(await this.slugs.isAvailable(slug, undefined, tx))) {
        throw new SlugUnavailableError();
      }
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
      // ... and its default agent with the first settings version (L7), so the product works from
      // the first minute. It is not counted against any limit: the plan always has room for one.
      await this.agents.provision(tx, tenant, {
        isDefault: true,
        actor: { userId: owner.id, role: owner.role },
      });
      return { tenant, owner };
    });
  }

  /** 409 SLUG_TAKEN, with free alternatives (the same the availability check offers). */
  private async slugTaken(slug: string) {
    return new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.SLUG_TAKEN,
      'This tenant slug is not available',
      { suggestions: await this.slugs.suggest(slug) },
    );
  }
}
