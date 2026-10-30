import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/**
 * Lets a service-to-service request through only if it carries `Authorization: Bearer
 * <INTERNAL_API_TOKEN>` (D2): the routes the AI engine calls on the backend, outside `/v1` (the
 * agent settings pull of Phase 5B-1; the status check, requests and numbers of 5B-2 and 5D will use
 * it too). The comparison is constant-time (digests of equal length), every failure answers the same
 * 401 and a deployment without the token answers 503, so nothing reveals which part was wrong.
 * (`POST /internal/events` is different on purpose: it verifies a signature over the body.)
 * These routes must also be reachable only on the private network.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.get<string>('INTERNAL_API_TOKEN');
    if (!secret) {
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.SERVICE_UNAVAILABLE,
        'The internal API is not configured',
      );
    }
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    const presented = header ? BEARER.exec(header)?.[1] : undefined;
    if (!presented || !sameSecret(presented, secret)) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Invalid service token',
      );
    }
    return true;
  }
}

function sameSecret(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
