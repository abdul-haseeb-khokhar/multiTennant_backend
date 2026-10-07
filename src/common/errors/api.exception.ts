import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

/** An HTTP error that carries a stable machine code (see `ErrorCode`). */
export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super({ statusCode: status, code, message }, status);
  }
}
