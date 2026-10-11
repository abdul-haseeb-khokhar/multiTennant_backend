import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { NormalizedEmailProperty } from '../../common/validation/email';
import { NewPasswordProperty } from '../../common/validation/password-length';

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

  @NewPasswordProperty()
  password: string;
}
