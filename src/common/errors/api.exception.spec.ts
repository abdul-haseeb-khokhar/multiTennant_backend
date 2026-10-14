import { HttpStatus } from '@nestjs/common';
import { ApiException } from './api.exception';
import { ErrorCode } from './error-codes';

describe('ApiException', () => {
  it('carries the code and the standard body', () => {
    const error = new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.SLUG_TAKEN,
      'taken',
    );
    expect(error.code).toBe('SLUG_TAKEN');
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      code: 'SLUG_TAKEN',
      message: 'taken',
    });
  });

  it('adds extra fields to the body without letting them overwrite the standard ones', () => {
    const error = new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.SLUG_TAKEN,
      'taken',
      { suggestions: ['acme-2'], code: 'EVIL', statusCode: 200, message: 'x' },
    );
    expect(error.getResponse()).toEqual({
      suggestions: ['acme-2'],
      statusCode: 409,
      code: 'SLUG_TAKEN',
      message: 'taken',
    });
  });
});
