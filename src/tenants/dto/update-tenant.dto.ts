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
 * this API. `plan` and `status` are kept for compatibility but no longer write the tenant
 * columns: they are translated into subscription events (see TenantsService.update). Use
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
      'Deprecated: same as POST /admin/tenants/:id/subscription/change-plan with no payment (a paid plan gets one interval, no invoice).',
  })
  @IsOptional()
  @IsIn(['starter', 'free', 'pro', 'enterprise'])
  plan?: string;

  @ApiPropertyOptional({
    enum: ['trial', 'active', 'suspended'],
    deprecated: true,
    description:
      '`suspended` suspends the tenant; `active` or `trial` lifts a suspension (it returns to the state it had). Nothing else changes: the real state is the subscription.',
  })
  @IsOptional()
  @IsIn(['trial', 'active', 'suspended'])
  status?: string;

  @OptionalLocaleProperty({
    description: "The tenant's default language (H7).",
  })
  defaultLocale?: string;
}
