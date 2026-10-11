import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional, ApiPropertyOptions } from '@nestjs/swagger';
import { IsOptional, ValidateBy } from 'class-validator';
import { isSupportedLocale, LOCALES } from '../../i18n/locales';

/**
 * Passes for a locale code the registry (`src/i18n/locales.ts`) knows. The check reads the
 * registry when it runs, so adding a language is a change to the registry and its translation
 * files only, never to a DTO or the OpenAPI document.
 */
export const IsLocaleCode = () =>
  ValidateBy({
    name: 'isLocaleCode',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && isSupportedLocale(value),
      defaultMessage: () =>
        `$property must be a supported locale code (${LOCALES.map((l) => l.code).join(', ')})`,
    },
  });

/**
 * An optional locale field: validated against the registry, documented as a plain string (not an
 * enum) that points at `GET /v1/i18n/locales`. `nullable` lets the field clear a value.
 */
export const OptionalLocaleProperty = (
  options: ApiPropertyOptions & { nullable?: boolean } = {},
) =>
  applyDecorators(
    ApiPropertyOptional({
      type: String,
      example: 'en',
      ...options,
      description: `${options.description ?? 'Language'} A locale code from GET /v1/i18n/locales (BCP-47, for example \`en\`, \`ur\`).`,
    }),
    IsOptional(),
    IsLocaleCode(),
  );
