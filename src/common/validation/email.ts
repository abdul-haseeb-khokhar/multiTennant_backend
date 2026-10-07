import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptions } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

/** Emails are stored and compared trimmed and lower-cased (`A@x.com` and `a@x.com` are one user). */
export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

/** `@Transform` that normalises a string and leaves any other value for the validators to reject. */
export const toNormalizedEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? normalizeEmail(value) : value;

/** Normalises (before validation runs) and validates an email field. */
export const NormalizedEmail = () =>
  applyDecorators(Transform(toNormalizedEmail), IsEmail());

/** `NormalizedEmail` plus the OpenAPI property description. */
export const NormalizedEmailProperty = (options: ApiPropertyOptions = {}) =>
  applyDecorators(ApiProperty(options), NormalizedEmail());
