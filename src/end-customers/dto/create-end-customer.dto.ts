import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { LOCALE_CODES } from '../../i18n/locales';

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

  @ApiPropertyOptional({
    enum: LOCALE_CODES,
    description: "The customer's language (H7); unset means unknown.",
  })
  @IsOptional()
  @IsIn(LOCALE_CODES)
  locale?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
