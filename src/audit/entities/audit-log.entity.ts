import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape of an audit entry. `before` and `after` never contain secrets. */
export class AuditLog {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Tenant user id, or platform admin id when actorRole is platform_admin',
  })
  actorUserId: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    enum: ['owner', 'admin', 'agent', 'platform_admin'],
  })
  actorRole: string | null;

  @ApiProperty({ example: 'user.role_changed' })
  action: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'user' })
  targetType: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  targetId: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  before: Record<string, unknown> | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  after: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ip: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  userAgent: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  requestId: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
