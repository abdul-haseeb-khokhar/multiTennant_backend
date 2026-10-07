import { ApiProperty } from '@nestjs/swagger';
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
}
