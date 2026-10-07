import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { ROLES } from '../../auth/roles';
import { NormalizedEmailProperty } from '../../common/validation/email';

export class CreateInviteDto {
  @NormalizedEmailProperty({ example: 'agent@acme.com' })
  email: string;

  @ApiPropertyOptional({
    enum: ROLES,
    default: 'agent',
    description: 'Only an owner may invite another owner.',
  })
  @IsOptional()
  @IsIn(ROLES)
  role?: string;
}
