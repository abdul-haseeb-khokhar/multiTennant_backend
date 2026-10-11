import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantUser } from '../../tenant-users/entities/tenant-user.entity';
import { DEV_ONLY } from '../../common/openapi/dev-only';

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
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the invitation was accepted. Always null in the pending list; set on an invite that was used.',
  })
  acceptedAt?: Date | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the invitation was revoked. Null in the pending list; set on the answer to a revoke.',
  })
  revokedAt?: Date | null;

  @ApiPropertyOptional({
    ...DEV_ONLY,
    description:
      'DEVELOPMENT ONLY. Present only on the answer to creating an invite, and only when the server runs with MAIL_MODE=link (refused in production): the invite link, so it can be passed on by hand. Never in lists, never in production.',
  })
  link?: string;
}

export class InvitePreview {
  @ApiProperty({ example: 'Acme Support' })
  tenantName: string;

  @ApiProperty({ enum: ['owner', 'admin', 'agent'] })
  role: string;

  @ApiProperty({ example: 'agent@acme.com' })
  email: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
}

export class AcceptInviteResponse {
  @ApiProperty({
    description: 'Send as `Authorization: Bearer <access_token>`',
  })
  access_token: string;

  @ApiProperty({ type: TenantUser })
  user: TenantUser;
}
