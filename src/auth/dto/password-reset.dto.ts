import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { NormalizedEmailProperty } from '../../common/validation/email';

export class PasswordResetRequestDto {
  @ApiProperty({ example: 'acme', description: 'The tenant slug' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  tenantSlug: string;

  @NormalizedEmailProperty({ example: 'agent@acme.com' })
  email: string;
}

export class PasswordResetConfirmDto {
  @ApiProperty({ description: 'The token from the emailed reset link' })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  token: string;

  @ApiProperty({ minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;
}
