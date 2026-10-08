import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateDataUseDto {
  @ApiProperty({
    description:
      'true records explicit consent; false revokes it. There is no pre-ticked default: the setting is off until an owner turns it on.',
  })
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({
    example: '2026-10-01',
    maxLength: 50,
    description:
      'Required when `enabled` is true: the version of the terms the owner was shown and accepted.',
  })
  @ValidateIf((dto: UpdateDataUseDto) => dto.enabled === true)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  termsVersion?: string;
}
