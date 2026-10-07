import { ApiProperty } from '@nestjs/swagger';

/** Response shape of a staff user. The password hash is never returned. */
export class TenantUser {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: ['owner', 'admin', 'agent'] })
  role: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
