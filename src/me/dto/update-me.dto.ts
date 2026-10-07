import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { LOCALE_CODES } from '../../i18n/locales';

export class UpdateMeDto {
  @ApiPropertyOptional({ example: 'Sana Malik' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    enum: LOCALE_CODES,
    nullable: true,
    description:
      'Dashboard language. `null` clears it, so the tenant default applies.',
  })
  @IsOptional()
  @IsIn(LOCALE_CODES)
  locale?: string | null;
}
