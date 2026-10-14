import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

/**
 * An HTTP error that carries a stable machine code (see `ErrorCode`). `extra` adds fields to the
 * body next to `statusCode`, `code` and `message` (for example the `suggestions` of a taken slug);
 * the three standard fields cannot be overwritten.
 */
export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: ErrorCode,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super({ ...extra, statusCode: status, code, message }, status);
  }
}
