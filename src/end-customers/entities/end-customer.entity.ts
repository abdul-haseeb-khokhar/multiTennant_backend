import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape of an end customer. */
export class EndCustomer {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty()
  externalId: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  name: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ur' })
  locale: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  metadata: Record<string, unknown> | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
