import { ApiProperty } from '@nestjs/swagger';

/**
 * An agent is the TENANT's own setup that the one shared engine uses for a call (settings,
 * knowledge, hours, greeting, voice, forwarding contacts). It is not a separate AI and it is not the
 * staff role named `agent`.
 */
export class Agent {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ example: 'Evening reception' })
  name: string;

  @ApiProperty({
    enum: ['active', 'disabled'],
    description:
      'A disabled agent is still readable and editable by staff; callers hear the "not available" message.',
  })
  status: string;

  @ApiProperty({
    description:
      'Every workspace has exactly one default agent. It cannot be deleted.',
  })
  isDefault: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
