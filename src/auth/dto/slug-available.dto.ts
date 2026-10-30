import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class SlugAvailableQueryDto {
  @ApiProperty({
    example: 'acme-support',
    description:
      'The slug to check, as typed. Anything that is not a valid slug (too short, capitals, spaces, a word we keep) simply comes back as not available, with cleaned-up suggestions.',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  slug: string;
}
