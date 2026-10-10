import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AllowedOrigins } from '../../common/validation/origin';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateApiKeyDto {
  @ApiPropertyOptional({ example: 'Website chat', maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Replaces the whole allow-list. Same rules as when creating (exact origins, https or http for localhost, at most 20).',
  })
  @IsOptional()
  @AllowedOrigins()
  allowedOrigins?: string[];
}
