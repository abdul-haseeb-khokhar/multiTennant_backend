import { ApiProperty } from '@nestjs/swagger';

export class ApiKeyView {
  @ApiProperty() id: string;
  @ApiProperty() tenantId: string;
  @ApiProperty({ enum: ['widget', 'server'] }) type: string;
  @ApiProperty() name: string;
  @ApiProperty({
    example: 'wk_AbCd1',
    description: 'First characters of the key, to recognise it in a list.',
  })
  keyPrefix: string;
  @ApiProperty({ type: [String] }) allowedOrigins: string[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastUsedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'User id of the staff member who created it.',
  })
  createdBy: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
}

export class CreatedApiKey extends ApiKeyView {
  @ApiProperty({
    example: 'wk_AbCd1234…',
    description:
      'The full key. Shown ONCE, in this response; only its hash is stored.',
  })
  key: string;
}
