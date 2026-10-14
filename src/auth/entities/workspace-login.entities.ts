import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WorkspaceChoice {
  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ example: 'acme' })
  slug: string;

  @ApiProperty({ example: 'Acme Support' })
  name: string;

  @ApiProperty({ enum: ['owner', 'admin', 'agent'] })
  role: string;

  @ApiProperty({
    description:
      'False when this workspace cannot be opened right now (see `reason`). It is still listed: the caller proved the password for it.',
  })
  available: boolean;

  @ApiPropertyOptional({
    enum: ['ACCOUNT_DISABLED', 'TENANT_SUSPENDED', 'TENANT_CLOSED'],
    description:
      'Why it is not available; an error code the frontend translates (`errors.<code>`).',
  })
  reason?: string;
}

export class OpenedWorkspace {
  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ example: 'acme' })
  slug: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ enum: ['owner', 'admin', 'agent'] })
  role: string;
}

export class LoginEmailResponse {
  @ApiProperty({
    description:
      'Proof, for 10 minutes, of the workspaces listed below. Send it to `POST /auth/select-workspace`. Not an access token; keep it in memory, not in a cookie.',
  })
  selectionToken: string;

  @ApiProperty({ example: 600, description: 'Seconds the token stays valid.' })
  expiresIn: number;

  @ApiProperty({
    type: [WorkspaceChoice],
    description:
      'Only workspaces where this email AND this password match; sorted by name.',
  })
  workspaces: WorkspaceChoice[];

  @ApiProperty({
    example: 1,
    description:
      'How many other workspaces use this email with a different password (or could not be checked). Show "N other workspaces use a different password: reset your password". It reveals nothing to anyone who did not type a correct password.',
  })
  unmatchedCount: number;

  @ApiPropertyOptional({
    description:
      'Present only when exactly ONE listed workspace is available: the normal staff access token, so the picker can be skipped.',
  })
  access_token?: string;

  @ApiPropertyOptional({
    type: OpenedWorkspace,
    description: 'The workspace `access_token` belongs to.',
  })
  workspace?: OpenedWorkspace;
}

export class SelectWorkspaceResponse {
  @ApiProperty({
    description: 'The normal staff access token for that workspace.',
  })
  access_token: string;

  @ApiProperty({ type: OpenedWorkspace })
  workspace: OpenedWorkspace;
}

export class SlugAvailability {
  @ApiProperty()
  available: boolean;

  @ApiProperty({
    type: [String],
    description:
      'Up to three free alternatives when the slug is not available; empty when it is.',
  })
  suggestions: string[];
}
