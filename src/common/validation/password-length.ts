import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength, ValidateBy } from 'class-validator';

/** bcrypt looks at the first 72 BYTES of a password and silently ignores the rest. */
export const BCRYPT_MAX_BYTES = 72;
export const PASSWORD_MIN_LENGTH = 8;

/** At most `max` bytes in UTF-8 (a character can take up to four bytes). */
export const MaxBytes = (max: number) =>
  ValidateBy({
    name: 'maxBytes',
    constraints: [max],
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max,
      defaultMessage: () => `$property must be at most ${max} bytes (UTF-8)`,
    },
  });

/**
 * A new password: 8 to 72 characters and no more than 72 bytes, so the whole password is what
 * bcrypt hashes (a longer one would log in with only its first 72 bytes).
 */
export const NewPasswordProperty = () =>
  applyDecorators(
    ApiProperty({
      minLength: PASSWORD_MIN_LENGTH,
      maxLength: BCRYPT_MAX_BYTES,
      description: `${PASSWORD_MIN_LENGTH} to ${BCRYPT_MAX_BYTES} characters, at most ${BCRYPT_MAX_BYTES} bytes in UTF-8.`,
    }),
    IsString(),
    MinLength(PASSWORD_MIN_LENGTH),
    MaxLength(BCRYPT_MAX_BYTES),
    MaxBytes(BCRYPT_MAX_BYTES),
  );
