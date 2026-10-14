import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { OptionalLocaleProperty } from '../../common/validation/locale';

/**
 * Platform-admin only (`/v1/admin/tenants`). Tenants are created through signup, never through
 * this API. `plan` and `status` are still declared so a client that sends them gets a clear
 * 400 `USE_SUBSCRIPTION_ROUTES` (J5) instead of having them silently ignored; use
 * `/v1/admin/tenants/:id/subscription` for billing.
 */
export class UpdateTenantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    enum: ['starter', 'free', 'pro', 'enterprise'],
    deprecated: true,
    description:
      'REMOVED (J5): sending it answers 400 `USE_SUBSCRIPTION_ROUTES`. Use POST /admin/tenants/:id/subscription/change-plan or activate.',
  })
  @IsOptional()
  @IsIn(['starter', 'free', 'pro', 'enterprise'])
  plan?: string;

  @ApiPropertyOptional({
    enum: ['trial', 'active', 'suspended'],
    deprecated: true,
    description:
      'REMOVED (J5): sending it answers 400 `USE_SUBSCRIPTION_ROUTES`. Use POST /admin/tenants/:id/subscription/suspend or unsuspend.',
  })
  @IsOptional()
  @IsIn(['trial', 'active', 'suspended'])
  status?: string;

  @OptionalLocaleProperty({
    description: "The tenant's default language (H7).",
  })
  defaultLocale?: string;
}
