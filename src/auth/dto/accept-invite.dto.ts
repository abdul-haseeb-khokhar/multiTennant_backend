import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { NewPasswordProperty } from '../../common/validation/password-length';

export class AcceptInviteDto {
  @ApiProperty({ description: 'The token from the emailed invite link' })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  token: string;

  @NewPasswordProperty()
  password: string;

  @ApiPropertyOptional({ example: 'Sana Malik' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;
}
