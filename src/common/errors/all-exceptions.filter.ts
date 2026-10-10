import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { ErrorCode } from './error-codes';
import { RateLimitedException } from './rate-limited.exception';

const CODE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.PAYLOAD_TOO_LARGE,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.TOO_MANY_REQUESTS,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
};

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: string[];
  /** 429 only: seconds until the caller may try again (also the `Retry-After` header). */
  retryAfterSeconds?: number;
  requestId?: string;
}

/**
 * Turns every error into `{ statusCode, code, message }` (F5). Validation errors also carry
 * `details` (one string per failed rule). Unexpected errors are logged and answered with a
 * generic 500 so internals never reach the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { id?: string }>();

    const body = this.toBody(exception);
    body.requestId = request.id;

    if (body.statusCode >= 500) {
      this.logger.error({
        message:
          exception instanceof Error ? exception.message : 'Unknown error',
        stack: exception instanceof Error ? exception.stack : undefined,
        requestId: request.id,
        path: request.originalUrl?.split('?')[0],
      });
    }

    if (exception instanceof RateLimitedException) {
      body.retryAfterSeconds = exception.retryAfterSeconds;
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }
    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const obj = typeof res === 'object' && res !== null ? (res as any) : {};
      const raw: unknown = typeof res === 'string' ? res : obj.message;

      if (Array.isArray(raw)) {
        // class-validator output
        return {
          statusCode: status,
          code: obj.code ?? ErrorCode.VALIDATION_ERROR,
          message: 'Validation failed',
          details: raw.map(String),
        };
      }
      return {
        statusCode: status,
        code: obj.code ?? CODE_BY_STATUS[status] ?? ErrorCode.INTERNAL_ERROR,
        message: typeof raw === 'string' ? raw : exception.message,
      };
    }

    // Safety net for Prisma errors a service did not map itself.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          statusCode: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          message: 'A record with these values already exists',
        };
      }
      if (exception.code === 'P2025') {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          code: ErrorCode.NOT_FOUND,
          message: 'Record not found',
        };
      }
    }

    // Client errors raised by Express middleware (body-parser: 413 "request entity too large",
    // bad encodings, ...) are http-errors, not Nest exceptions. They are the caller's mistake and
    // `expose` says their message is safe to show.
    const clientError = exception as
      { status?: unknown; expose?: unknown; message?: unknown } | undefined;
    if (
      exception instanceof Error &&
      typeof clientError?.status === 'number' &&
      clientError.status >= 400 &&
      clientError.status < 500 &&
      clientError.expose === true
    ) {
      return {
        statusCode: clientError.status,
        code: CODE_BY_STATUS[clientError.status] ?? ErrorCode.BAD_REQUEST,
        message: exception.message,
      };
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    };
  }
}
