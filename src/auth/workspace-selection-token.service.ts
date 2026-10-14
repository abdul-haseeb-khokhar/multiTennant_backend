import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomUUID } from 'node:crypto';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { IssuedAtClaims } from './token-freshness';

export const WORKSPACE_SELECT_SCOPE = 'workspace-select';
/** How long a person has to pick a workspace (and to switch to another one) after typing the password. */
export const SELECTION_TOKEN_TTL_SECONDS = 10 * 60;

/** What a selection token carries: the memberships whose password matched, as user ids. */
export interface SelectionClaims extends IssuedAtClaims {
  /** `tenant_user` ids, one per workspace whose password matched. Never an email address. */
  userIds: string[];
}

/**
 * Signs and verifies the token of the workspace picker (J2): the proof, valid for 10 minutes, that
 * this caller typed the right password for these memberships. Like the widget token it uses a
 * signing secret DERIVED from `JWT_SECRET` (HMAC with its own label) and a `scope` of its own, so
 * the staff and platform strategies and the widget guard all reject it on the signature, and a
 * staff, platform or widget token is rejected here. It is not an access token: it opens no route.
 * It lists user ids only (no email, no tenant names).
 */
@Injectable()
export class WorkspaceSelectionTokenService {
  private readonly secret: string;
  /** A private instance: nothing here may share the configuration of the staff JwtModule. */
  private readonly jwt = new JwtService({});

  constructor(config: ConfigService) {
    this.secret = createHmac('sha256', config.getOrThrow<string>('JWT_SECRET'))
      .update('workspace-selection-token-v1')
      .digest('hex');
  }

  sign(userIds: string[]): { token: string; expiresIn: number } {
    const token = this.jwt.sign(
      {
        scope: WORKSPACE_SELECT_SCOPE,
        userIds,
        // Milliseconds, so a logout or password change can be compared exactly (J1).
        iatMs: Date.now(),
      },
      {
        secret: this.secret,
        jwtid: randomUUID(),
        expiresIn: SELECTION_TOKEN_TTL_SECONDS,
      },
    );
    return { token, expiresIn: SELECTION_TOKEN_TTL_SECONDS };
  }

  /** 401 SELECTION_TOKEN_INVALID for anything that is not a valid, unexpired selection token. */
  verify(token: string): SelectionClaims {
    let payload: Record<string, unknown>;
    try {
      payload = this.jwt.verify<Record<string, unknown>>(token, {
        secret: this.secret,
      });
    } catch {
      throw invalid();
    }
    const { userIds } = payload;
    if (
      payload.scope !== WORKSPACE_SELECT_SCOPE ||
      !Array.isArray(userIds) ||
      userIds.length === 0 ||
      !userIds.every((id) => typeof id === 'string' && id.length > 0)
    ) {
      throw invalid();
    }
    return {
      userIds: userIds as string[],
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
      iatMs: typeof payload.iatMs === 'number' ? payload.iatMs : undefined,
    };
  }
}

function invalid() {
  return new ApiException(
    HttpStatus.UNAUTHORIZED,
    ErrorCode.SELECTION_TOKEN_INVALID,
    'This sign-in has expired or is not valid',
  );
}
