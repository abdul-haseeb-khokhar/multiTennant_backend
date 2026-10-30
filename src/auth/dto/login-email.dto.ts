import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { NormalizedEmailProperty } from '../../common/validation/email';

/** Step one of the email-first login (J2): no workspace slug. */
export class LoginEmailDto {
  @NormalizedEmailProperty({ example: 'owner@acme.com' })
  email: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password: string;
}

/** Step two (J2): open one of the workspaces whose password matched. */
export class SelectWorkspaceDto {
  @ApiProperty({
    description: 'The `selectionToken` returned by `POST /auth/login-email`.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  selectionToken: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'The `tenantId` of one of the listed workspaces. A workspace that was not listed gets 403 `WORKSPACE_NOT_SELECTABLE`.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  tenantId: string;
}
