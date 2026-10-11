import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { NormalizedEmailProperty } from '../../common/validation/email';
import { OptionalLocaleProperty } from '../../common/validation/locale';
import { NewPasswordProperty } from '../../common/validation/password-length';
import { SLUG_PATTERN } from '../../tenants/slug';

export class SignupDto {
  @ApiProperty({ example: 'Acme Support' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  tenantName: string;

  @ApiPropertyOptional({
    example: 'acme',
    description:
      'Login identifier for the tenant (3-40 chars: a-z, 0-9, dashes). Derived from the name when omitted.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Matches(SLUG_PATTERN, {
    message:
      'tenantSlug must be 3-40 characters: lower-case letters, digits and dashes, not starting or ending with a dash',
  })
  tenantSlug?: string;

  @NormalizedEmailProperty({ example: 'owner@acme.com' })
  ownerEmail: string;

  @NewPasswordProperty()
  ownerPassword: string;

  @OptionalLocaleProperty({
    default: 'en',
    description: "The tenant's default language (H7).",
  })
  locale?: string;
}
