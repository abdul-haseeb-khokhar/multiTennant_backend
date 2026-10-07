import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString } from 'class-validator';
import { NormalizedEmailProperty } from '../../common/validation/email';

export class LoginDto {
  @ApiProperty({
    example: 'acme',
    description: 'The tenant slug chosen at signup',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  tenantSlug: string;

  @NormalizedEmailProperty({ example: 'owner@acme.com' })
  email: string;

  @ApiProperty()
  @IsString()
  password: string;
}
