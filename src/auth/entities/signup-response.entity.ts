import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantUser } from '../../tenant-users/entities/tenant-user.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';

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
    description:
      'Only with MAIL_MODE=link (development): the email-verification link.',
  })
  verificationLink?: string;
}
