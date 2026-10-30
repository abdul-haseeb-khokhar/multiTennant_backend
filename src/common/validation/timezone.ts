import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional, ApiPropertyOptions } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, ValidateBy } from 'class-validator';

/** The default time zone of a new tenant (J7); the database column has the same default. */
export const DEFAULT_TIMEZONE = 'Asia/Karachi';

// An IANA name is letters, digits, `_`, `+`, `-` in segments separated by `/` (`Asia/Karachi`,
// `America/Argentina/Buenos_Aires`, `Etc/GMT+5`, `UTC`). This also keeps out the UTC-offset forms
// (`+05:00`) that newer JavaScript engines accept but that are not zone names.
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * The canonical spelling of an IANA time-zone name (`asia/karachi` -> `Asia/Karachi`), or null
 * when the runtime's tz database does not know it. Checked with `Intl`, so it needs no list of
 * zones in the code.
 */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const name = value.trim();
  if (!IANA_SHAPE.test(name)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: name,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Passes for a known IANA time-zone name (any capitalisation; the transform stores the canonical one). */
export const IsTimeZone = () =>
  ValidateBy({
    name: 'isTimeZone',
    validator: {
      validate: (value: unknown) => canonicalTimeZone(value) !== null,
      defaultMessage: () =>
        '$property must be an IANA time zone name such as Asia/Karachi',
    },
  });

/** An optional time-zone field: validated, and normalised to the canonical IANA spelling. */
export const OptionalTimeZoneProperty = (options: ApiPropertyOptions = {}) =>
  applyDecorators(
    ApiPropertyOptional({
      type: String,
      example: DEFAULT_TIMEZONE,
      ...options,
    }),
    Transform(({ value }) => canonicalTimeZone(value) ?? value),
    IsOptional(),
    IsTimeZone(),
  );
