import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { ROLES } from '../../auth/roles';
import { NormalizedEmail } from '../../common/validation/email';

export const USER_STATUSES = ['active', 'disabled'] as const;

/** There is deliberately no password field: people set their own (invite, reset). */
export class UpdateTenantUserDto {
  @ApiPropertyOptional({
    example: 'agent@acme.com',
    description: 'A new address must be verified again.',
  })
  @IsOptional()
  @NormalizedEmail()
  email?: string;

  @ApiPropertyOptional({
    enum: ROLES,
    description: 'Only an owner may promote to or change an owner.',
  })
  @IsOptional()
  @IsIn(ROLES)
  role?: string;

  @ApiPropertyOptional({
    enum: USER_STATUSES,
    description:
      '`disabled` takes effect on the very next request. The last active owner cannot be disabled.',
  })
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: string;
}
