import { ApiProperty } from '@nestjs/swagger';

export class DataUse {
  @ApiProperty({ example: 'model_training' })
  purpose: string;

  @ApiProperty({
    description:
      'Whether consent is currently given. false until an owner turns it on.',
  })
  enabled: boolean;

  @ApiProperty({
    enum: ['off', 'granted', 'revoked'],
    description:
      '`off` = never given (the default), `granted`, or `revoked` after having been given.',
  })
  status: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Terms version accepted with the last grant.',
  })
  termsVersion: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'User id of the owner who accepted.',
  })
  acceptedBy: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt: Date | null;
}
