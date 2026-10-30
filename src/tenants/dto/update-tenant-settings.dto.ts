import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { OptionalLocaleProperty } from '../../common/validation/locale';
import { OptionalTimeZoneProperty } from '../../common/validation/timezone';
import { SLUG_PATTERN } from '../slug';

/**
 * What the owner may change about their own workspace (J3, J7). Every field is optional; a field
 * that equals the current value changes nothing. Plan and status are not here: they belong to the
 * subscription.
 */
export class UpdateTenantSettingsDto {
  @ApiPropertyOptional({ example: 'Acme Support' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @OptionalLocaleProperty({
    description: "The workspace's default language (H7).",
  })
  defaultLocale?: string;

  @OptionalTimeZoneProperty({
    description:
      'IANA time zone of the workspace (J7), for example `Asia/Karachi` (the default). Working hours, the audit display and reminder wording use it; stored timestamps stay UTC.',
  })
  timezone?: string;

  @ApiPropertyOptional({
    example: 'acme-support',
    description:
      'Renames the workspace slug (3-40 chars: a-z, 0-9, dashes). Allowed once every 30 days. The new slug must be free (409 `SLUG_TAKEN` with `suggestions` otherwise). The old slug keeps working at login for 30 days and nobody else can take it for 90 days. Widget keys are unaffected.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Matches(SLUG_PATTERN, {
    message:
      'slug must be 3-40 characters: lower-case letters, digits and dashes, not starting or ending with a dash',
  })
  slug?: string;
}
