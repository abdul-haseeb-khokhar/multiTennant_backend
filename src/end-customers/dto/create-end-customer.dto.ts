import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';
import { OptionalLocaleProperty } from '../../common/validation/locale';

export class CreateEndCustomerDto {
  @ApiProperty({
    example: 'web_5f1c...',
    description: 'Unique per tenant (B4)',
  })
  @IsString()
  externalId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @OptionalLocaleProperty({
    description: "The customer's language (H7); unset means unknown.",
  })
  locale?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
