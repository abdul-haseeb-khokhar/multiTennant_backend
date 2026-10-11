import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class PreviewInviteQueryDto {
  @ApiProperty({ description: 'The token from the emailed invite link' })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  token: string;
}
