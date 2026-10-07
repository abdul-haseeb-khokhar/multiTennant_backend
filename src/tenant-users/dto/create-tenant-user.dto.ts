import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { ROLES } from '../../auth/roles';

export class CreateTenantUserDto {
  @ApiProperty({ example: 'agent@acme.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({
    enum: ROLES,
    default: 'agent',
    description: 'Only an owner may create another owner.',
  })
  @IsOptional()
  @IsIn(ROLES)
  role?: string;
}
