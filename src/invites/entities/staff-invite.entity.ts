import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantUser } from '../../tenant-users/entities/tenant-user.entity';

/** Response shape of an invitation. The token and its hash are never returned. */
export class StaffInvite {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ example: 'agent@acme.com' })
  email: string;

  @ApiProperty({ enum: ['owner', 'admin', 'agent'] })
  role: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Id of the user who sent the invite',
  })
  invitedBy: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiPropertyOptional({
    description:
      'Only on creation and only with MAIL_MODE=link (development): the invite link, so it can be passed on by hand.',
  })
  link?: string;
}

export class AcceptInviteResponse {
  @ApiProperty({
    description: 'Send as `Authorization: Bearer <access_token>`',
  })
  access_token: string;

  @ApiProperty({ type: TenantUser })
  user: TenantUser;
}
