import { IsEmail, IsString, MinLength, IsOptional, IsIn } from 'class-validator';

export class CreateTenantUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsIn(['owner', 'admin', 'agent'])
  role?: string;
}