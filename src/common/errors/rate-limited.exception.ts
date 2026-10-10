import { HttpStatus } from '@nestjs/common';
import { ApiException } from './api.exception';
import { ErrorCode } from './error-codes';

/**
 * 429 TOO_MANY_REQUESTS that also tells the client when to retry: `AllExceptionsFilter` turns
 * `retryAfterSeconds` into a `Retry-After` header.
 */
export class RateLimitedException extends ApiException {
  constructor(
    public readonly retryAfterSeconds: number,
    message = `Too many requests, try again in ${retryAfterSeconds} seconds`,
  ) {
    super(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.TOO_MANY_REQUESTS, message);
  }
}
