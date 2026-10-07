import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape of a staff user. The password hash is never returned. */
export class TenantUser {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ example: 'agent@acme.com', description: 'Lower-case' })
  email: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  name: string | null;

  @ApiProperty({ enum: ['owner', 'admin', 'agent'] })
  role: string;

  @ApiProperty({
    enum: ['active', 'disabled'],
    description: 'A disabled user is refused on the next request.',
  })
  status: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  emailVerifiedAt: Date | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Tokens issued before this instant are rejected.',
  })
  passwordChangedAt: Date | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'ur',
    description: 'Dashboard language; null means the tenant default.',
  })
  locale: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
