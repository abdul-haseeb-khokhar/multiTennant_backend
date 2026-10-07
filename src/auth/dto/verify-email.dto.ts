import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({ description: 'The token from the emailed verification link' })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  token: string;
}
