import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { prismaError } from '../../../test/utils/prisma-mock';
import { ApiException } from './api.exception';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorCode } from './error-codes';
import { RateLimitedException } from './rate-limited.exception';

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();
  let headers: jest.Mock;

  function run(exception: unknown) {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const setHeader = jest.fn();
    headers = setHeader;
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status, setHeader }),
        getRequest: () => ({ id: 'req-1', originalUrl: '/v1/x?email=a@b.co' }),
      }),
    } as unknown as ArgumentsHost;
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
    filter.catch(exception, host);
    return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] };
  }

  it('a rate-limited error answers 429 TOO_MANY_REQUESTS and tells the client when to retry', () => {
    const { status, body } = run(new RateLimitedException(42));
    expect(status).toBe(429);
    expect(body).toMatchObject({ statusCode: 429, code: 'TOO_MANY_REQUESTS' });
    expect(headers).toHaveBeenCalledWith('Retry-After', '42');
  });

  it('other errors set no Retry-After header', () => {
    run(new ApiException(HttpStatus.CONFLICT, ErrorCode.SLUG_TAKEN, 'taken'));
    expect(headers).not.toHaveBeenCalled();
  });

  it('keeps the code of an ApiException', () => {
    const { status, body } = run(
      new ApiException(HttpStatus.CONFLICT, ErrorCode.SLUG_TAKEN, 'taken'),
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      statusCode: 409,
      code: 'SLUG_TAKEN',
      message: 'taken',
      requestId: 'req-1',
    });
  });

  it.each([
    [new UnauthorizedException(), 401, 'UNAUTHORIZED'],
    [new ForbiddenException(), 403, 'FORBIDDEN'],
    [new NotFoundException('nope'), 404, 'NOT_FOUND'],
  ])(
    'derives a generic code from the status (%#)',
    (exception, statusCode, code) => {
      const { status, body } = run(exception);
      expect(status).toBe(statusCode);
      expect(body).toMatchObject({ statusCode, code });
    },
  );

  it('turns class-validator output into VALIDATION_ERROR with details', () => {
    const { body } = run(
      new BadRequestException([
        'email must be an email',
        'password is too short',
      ]),
    );
    expect(body).toEqual({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: ['email must be an email', 'password is too short'],
      requestId: 'req-1',
    });
  });

  it('maps unhandled Prisma P2002 / P2025 to 409 / 404 as a safety net', () => {
    expect(run(prismaError('P2002'))).toMatchObject({
      status: 409,
      body: { code: 'CONFLICT' },
    });
    expect(run(prismaError('P2025'))).toMatchObject({
      status: 404,
      body: { code: 'NOT_FOUND' },
    });
  });

  it('answers an Express body-parser client error (413) with its status instead of a 500', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
    });
    expect(run(tooLarge)).toMatchObject({
      status: 413,
      body: {
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'request entity too large',
      },
    });

    const other = Object.assign(new Error('unsupported charset'), {
      status: 415,
      expose: true,
    });
    expect(run(other)).toMatchObject({
      status: 415,
      body: { code: 'BAD_REQUEST' },
    });
  });

  it('still hides errors that merely carry a status but are not safe to expose', () => {
    const hidden = Object.assign(new Error('internal detail'), { status: 400 });
    expect(run(hidden)).toMatchObject({
      status: 500,
      body: { code: 'INTERNAL_ERROR' },
    });
    const server = Object.assign(new Error('boom'), {
      status: 502,
      expose: true,
    });
    expect(run(server)).toMatchObject({ status: 500 });
  });

  it('hides the details of unexpected errors and logs them', () => {
    const { status, body } = run(new Error('password=hunter2 leaked'));
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-1',
    });
    expect(filter['logger'].error).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', path: '/v1/x' }),
    );
  });
});
