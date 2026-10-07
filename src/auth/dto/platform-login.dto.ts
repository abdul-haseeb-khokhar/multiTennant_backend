import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { NormalizedEmailProperty } from '../../common/validation/email';

export class PlatformLoginDto {
  @NormalizedEmailProperty({ example: 'ops@example.com' })
  email: string;

  @ApiProperty()
  @IsString()
  password: string;
}
