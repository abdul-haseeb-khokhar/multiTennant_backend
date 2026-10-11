import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantUser } from '../../tenant-users/entities/tenant-user.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { DEV_ONLY } from '../../common/openapi/dev-only';

export class SignupResponse {
  @ApiProperty({ type: Tenant })
  tenant: Tenant;

  @ApiProperty({ type: TenantUser })
  owner: TenantUser;

  @ApiProperty({
    description: 'Send as `Authorization: Bearer <access_token>`',
  })
  access_token: string;

  @ApiPropertyOptional({
    ...DEV_ONLY,
    description:
      'DEVELOPMENT ONLY: present only when the server runs with MAIL_MODE=link (refused in production); the email-verification link.',
  })
  verificationLink?: string;
}
