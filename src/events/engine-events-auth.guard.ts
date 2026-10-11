import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Clock } from '../billing/clock';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  checkEngineSignature,
} from './engine-event-signature';

/**
 * Lets a request through only if the AI engine signed it with the shared service token (D2, D5).
 * Every failure answers the same 401, so a caller learns nothing about which part was wrong; a
 * deployment without `INTERNAL_API_TOKEN` answers 503 (the receiver is switched off).
 */
@Injectable()
export class EngineEventsAuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.get<string>('INTERNAL_API_TOKEN');
    if (!secret) {
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.SERVICE_UNAVAILABLE,
        'The event receiver is not configured',
      );
    }
    const request = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();
    const header = (name: string) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const result = checkEngineSignature(
      secret,
      {
        timestamp: header(TIMESTAMP_HEADER),
        signature: header(SIGNATURE_HEADER),
      },
      request.rawBody,
      this.clock.now().getTime(),
    );
    if (result !== 'ok') {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Invalid event signature',
      );
    }
    return true;
  }
}
