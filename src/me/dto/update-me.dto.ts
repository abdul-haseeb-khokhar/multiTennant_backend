import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { OptionalLocaleProperty } from '../../common/validation/locale';

export class UpdateMeDto {
  @ApiPropertyOptional({
    example: 'Sana Malik',
    type: String,
    nullable: true,
    description: 'Display name. `null` clears it (an empty string is refused).',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string | null;

  @OptionalLocaleProperty({
    nullable: true,
    description:
      'Dashboard language. `null` clears it, so the tenant default applies.',
  })
  locale?: string | null;
}
