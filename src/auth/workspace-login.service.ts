import { HttpStatus, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { normalizeEmail } from '../common/validation/email';
import { PrismaService } from '../prisma/prisma.service';
import { LoginEmailDto, SelectWorkspaceDto } from './dto/login-email.dto';
import { LoginThrottleService } from './login-throttle.service';
import { SessionTokenService } from './session-token.service';
import { assertTenantUsable } from './tenant-status';
import { wasIssuedBefore } from './token-freshness';
import { WorkspaceSelectionTokenService } from './workspace-selection-token.service';

/**
 * How many DIFFERENT password hashes one login request compares against. A request always runs
 * exactly this many bcrypt comparisons (real ones first, dummy ones to fill up), whatever the
 * email: so it costs the same for an unknown address as for a known one, and one request can never
 * trigger dozens of hashes. Memberships that share a password share a hash (a password reset by
 * email gives every workspace the same one), so people who reset once are covered by one
 * comparison however many workspaces they have; a person with more than three different passwords
 * sees the newest three matched and the rest counted in `unmatchedCount` (a reset by email
 * brings them back together).
 */
export const MAX_COMPARED_PASSWORDS = 3;
/** Memberships read for one email. Far above any real person; bounds the work of a hostile request. */
const MAX_MEMBERSHIPS = 100;

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password', 10);

type UnavailableReason =
  'ACCOUNT_DISABLED' | 'TENANT_SUSPENDED' | 'TENANT_CLOSED';

/** The columns a login needs; the hash stays inside this file. */
const MEMBERSHIP_SELECT = {
  id: true,
  tenantId: true,
  role: true,
  status: true,
  passwordHash: true,
  passwordChangedAt: true,
  tokensValidAfter: true,
  tenant: { select: { slug: true, name: true, status: true } },
} as const;

interface Membership {
  id: string;
  tenantId: string;
  role: string;
  status: string;
  passwordHash: string;
  passwordChangedAt: Date | null;
  tokensValidAfter: Date | null;
  tenant: { slug: string; name: string; status: string };
}

/**
 * Email-first login (J2, option 1: one password per workspace). Step one proves a password and
 * lists the workspaces it opens; step two opens one. Only a correct password reveals anything:
 * a wrong password and an unknown email give the same generic 401 in the same time.
 */
@Injectable()
export class WorkspaceLoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionTokens: SessionTokenService,
    private readonly selectionTokens: WorkspaceSelectionTokenService,
    private readonly throttle: LoginThrottleService,
  ) {}

  async loginByEmail(dto: LoginEmailDto, ip: string) {
    const email = normalizeEmail(dto.email);
    this.throttle.assertAllowed(ip, email);

    const memberships = await this.prisma.tenantUser.findMany({
      where: { email },
      select: MEMBERSHIP_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: MAX_MEMBERSHIPS,
    });

    const matched = await this.membershipsMatching(memberships, dto.password);
    if (matched.length === 0) {
      this.throttle.recordFailure(ip, email);
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_CREDENTIALS,
        'Invalid credentials',
      );
    }
    this.throttle.recordSuccess(ip, email);

    const workspaces = matched
      .map((m) => {
        const reason = this.unavailableReason(m);
        return {
          tenantId: m.tenantId,
          slug: m.tenant.slug,
          name: m.tenant.name,
          role: m.role,
          available: reason === null,
          ...(reason !== null && { reason }),
        };
      })
      .sort(
        (a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug),
      );

    const { token, expiresIn } = this.selectionTokens.sign(
      matched.map((m) => m.id),
    );
    const available = matched.filter((m) => this.unavailableReason(m) === null);
    return {
      selectionToken: token,
      expiresIn,
      workspaces,
      unmatchedCount: memberships.length - matched.length,
      // Exactly one way in: the picker adds nothing, so hand over the access token as well.
      ...(available.length === 1 && this.opened(available[0])),
    };
  }

  async selectWorkspace(dto: SelectWorkspaceDto) {
    const claims = this.selectionTokens.verify(dto.selectionToken);

    // Both conditions at once: the membership must be one the token lists AND belong to the
    // workspace asked for, so a token can never open a workspace it did not prove.
    const user = await this.prisma.tenantUser.findFirst({
      where: { id: { in: claims.userIds }, tenantId: dto.tenantId },
      select: MEMBERSHIP_SELECT,
    });
    if (!user) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.WORKSPACE_NOT_SELECTABLE,
        'This workspace cannot be opened with this sign-in',
      );
    }
    // J1: a logout or a password change after the password was typed ends the selection too.
    for (const cutoff of [user.passwordChangedAt, user.tokensValidAfter]) {
      if (cutoff && wasIssuedBefore(claims, cutoff)) {
        throw new ApiException(
          HttpStatus.UNAUTHORIZED,
          ErrorCode.SELECTION_TOKEN_INVALID,
          'This sign-in has expired or is not valid',
        );
      }
    }
    // The same errors the slug login gives.
    if (user.status !== 'active') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.ACCOUNT_DISABLED,
        'This account is disabled',
      );
    }
    assertTenantUsable(user.tenant.status);

    return this.opened(user);
  }

  // -------------------------------------------------------------------------------------------

  /**
   * The memberships whose password matches `password`. Runs exactly MAX_COMPARED_PASSWORDS bcrypt
   * comparisons in parallel (real hashes first, dummy ones after), so the time does not depend on
   * how many accounts the email has, or whether it has any.
   */
  private async membershipsMatching(
    memberships: Membership[],
    password: string,
  ) {
    const hashes = [...new Set(memberships.map((m) => m.passwordHash))].slice(
      0,
      MAX_COMPARED_PASSWORDS,
    );
    const results = await Promise.all(
      Array.from({ length: MAX_COMPARED_PASSWORDS }, (_, i) =>
        bcrypt.compare(password, hashes[i] ?? DUMMY_PASSWORD_HASH),
      ),
    );
    // A padding slot has no real hash: its result is ignored, whatever it says.
    const matching = new Set(hashes.filter((_, i) => results[i]));
    return memberships.filter((m) => matching.has(m.passwordHash));
  }

  private unavailableReason(m: Membership): UnavailableReason | null {
    if (m.status !== 'active') return 'ACCOUNT_DISABLED';
    if (m.tenant.status === 'suspended') return 'TENANT_SUSPENDED';
    if (m.tenant.status === 'closed') return 'TENANT_CLOSED';
    return null;
  }

  private opened(m: Membership) {
    return {
      access_token: this.sessionTokens.sign(m.id, m.tenantId, m.role),
      workspace: {
        tenantId: m.tenantId,
        slug: m.tenant.slug,
        name: m.tenant.name,
        role: m.role,
      },
    };
  }
}
