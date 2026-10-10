import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { normalizeOrigin } from '../common/validation/origin';
import { WidgetAuth } from './widget-auth';
import { applyWidgetCors } from './widget-cors.service';
import { WidgetTokenService } from './widget-token.service';

/**
 * Authenticates widget routes. A request passes only with:
 *  1. a valid, unexpired widget token (a staff or platform token is a different kind and fails here),
 *  2. the widget key the session was started with still active (revoking a key ends its sessions),
 *  3. a request `Origin` that is on THAT key's allow-list (a missing Origin is refused).
 * It then lets that origin read the response (CORS) and exposes the token's tenant, end customer
 * and conversation. They come only from the signed token, never from the request body or URL.
 */
@Injectable()
export class WidgetAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: WidgetTokenService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { widget?: WidgetAuth }>();
    const response = http.getResponse<Response>();

    const header = request.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'A widget token is required',
      );
    }
    const claims = this.tokens.verify(token);

    const key = await this.apiKeys.findActiveWidgetKey(
      claims.tenantId,
      claims.keyId,
    );
    if (!key) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.WIDGET_KEY_INVALID,
        'The widget key is no longer valid',
      );
    }
    const origin = normalizeOrigin(request.headers.origin);
    if (!origin || !this.apiKeys.originAllowed(key, origin)) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.ORIGIN_NOT_ALLOWED,
        'This origin is not allowed for the widget key',
      );
    }
    applyWidgetCors(response, origin);
    this.apiKeys.touch(claims.tenantId, key.id);

    request.widget = { ...claims, origin };
    return true;
  }
}
