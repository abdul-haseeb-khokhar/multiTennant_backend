import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { NormalizedEmailProperty } from '../../common/validation/email';
import { NewPasswordProperty } from '../../common/validation/password-length';

export class PasswordResetRequestDto {
  @ApiPropertyOptional({
    example: 'acme',
    description:
      'The tenant slug. Leave it out (J2) and the reset covers EVERY workspace where this email exists: one email, one link, and the new password is set in all of them. With a slug (the original flow) only that workspace is reset.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  tenantSlug?: string;

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
