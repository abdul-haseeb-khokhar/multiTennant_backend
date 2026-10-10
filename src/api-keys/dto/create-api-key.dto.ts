import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AllowedOrigins } from '../../common/validation/origin';
import { API_KEY_TYPES } from '../api-key.util';
import type { ApiKeyType } from '../api-key.util';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateApiKeyDto {
  @ApiProperty({ example: 'Website chat', maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({
    enum: API_KEY_TYPES,
    default: 'widget',
    description:
      '`widget` keys start chats from a web page. `server` keys are stored but no route accepts them yet.',
  })
  @IsOptional()
  @IsIn(API_KEY_TYPES)
  type?: ApiKeyType;

  @ApiPropertyOptional({
    type: [String],
    example: ['https://shop.example.com', 'http://localhost:5173'],
    description:
      'Exact origins allowed to use a widget key (`scheme://host[:port]`). https only, except http for localhost. No wildcards, paths or queries; at most 20. An empty list means the key works nowhere.',
  })
  @IsOptional()
  @AllowedOrigins()
  allowedOrigins?: string[];
}
