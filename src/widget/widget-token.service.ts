import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomUUID } from 'node:crypto';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { WIDGET_TOKEN_TTL_SECONDS } from './widget.constants';

export const WIDGET_SCOPE = 'widget';

/** What a widget token carries (D3). It reaches exactly one conversation of one end customer. */
export interface WidgetClaims {
  tenantId: string;
  endCustomerId: string;
  conversationId: string;
  /** The widget key the session was started with; re-checked (revoked? origin?) on every request. */
  keyId: string;
  locale: string;
}

/**
 * Signs and verifies widget tokens. They use a signing secret DERIVED from `JWT_SECRET`
 * (HMAC with a fixed label), not `JWT_SECRET` itself, and carry `scope: "widget"`: a widget token
 * therefore fails signature verification at the staff and platform strategies, and a staff or
 * platform token fails it here, even before any scope claim is looked at.
 */
@Injectable()
export class WidgetTokenService {
  private readonly secret: string;
  /**
   * A private instance, not the one `JwtModule` provides: the staff and platform tokens are
   * signed by that one with `JWT_SECRET`, and nothing here may share its configuration.
   */
  private readonly jwt = new JwtService({});

  constructor(config: ConfigService) {
    this.secret = createHmac('sha256', config.getOrThrow<string>('JWT_SECRET'))
      .update('widget-session-token-v1')
      .digest('hex');
  }

  sign(claims: WidgetClaims): { token: string; expiresAt: Date } {
    const token = this.jwt.sign(
      { ...claims, scope: WIDGET_SCOPE },
      {
        secret: this.secret,
        subject: claims.endCustomerId,
        // A unique id per token: two refreshes in the same second still differ, and a later
        // revocation list could name one.
        jwtid: randomUUID(),
        expiresIn: WIDGET_TOKEN_TTL_SECONDS,
      },
    );
    return {
      token,
      expiresAt: new Date(Date.now() + WIDGET_TOKEN_TTL_SECONDS * 1000),
    };
  }

  /** 401 WIDGET_TOKEN_EXPIRED for an expired token (the widget refreshes), 401 UNAUTHORIZED otherwise. */
  verify(token: string): WidgetClaims {
    let payload: Record<string, unknown>;
    try {
      payload = this.jwt.verify<Record<string, unknown>>(token, {
        secret: this.secret,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TokenExpiredError') {
        throw new ApiException(
          HttpStatus.UNAUTHORIZED,
          ErrorCode.WIDGET_TOKEN_EXPIRED,
          'The widget session has expired',
        );
      }
      throw unauthorized();
    }
    const text = (key: string) => {
      const value = payload[key];
      if (typeof value !== 'string' || !value) throw unauthorized();
      return value;
    };
    if (payload.scope !== WIDGET_SCOPE) throw unauthorized();
    return {
      tenantId: text('tenantId'),
      endCustomerId: text('endCustomerId'),
      conversationId: text('conversationId'),
      keyId: text('keyId'),
      locale: typeof payload.locale === 'string' ? payload.locale : 'en',
    };
  }
}

function unauthorized() {
  return new ApiException(
    HttpStatus.UNAUTHORIZED,
    ErrorCode.UNAUTHORIZED,
    'Invalid widget token',
  );
}
