import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { LOCALE_CODES } from '../../i18n/locales';

/**
 * Platform-admin only (`/v1/admin/tenants`). Tenants are created through signup, never through
 * this API, so `plan` and `status` can only be changed here.
 */
export class UpdateTenantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ enum: ['free', 'pro', 'enterprise'] })
  @IsOptional()
  @IsIn(['free', 'pro', 'enterprise'])
  plan?: string;

  @ApiPropertyOptional({ enum: ['trial', 'active', 'suspended'] })
  @IsOptional()
  @IsIn(['trial', 'active', 'suspended'])
  status?: string;

  @ApiPropertyOptional({
    enum: LOCALE_CODES,
    description: "The tenant's default language (H7).",
  })
  @IsOptional()
  @IsIn(LOCALE_CODES)
  defaultLocale?: string;
}
