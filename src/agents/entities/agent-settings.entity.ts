import { ApiProperty } from '@nestjs/swagger';

export class AgentSettingsVersionSummary {
  @ApiProperty({ format: 'uuid' })
  agentId: string;

  @ApiProperty({ example: 3, description: 'Starts at 1; every save adds one.' })
  version: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The staff user who saved it; null for the first version.',
  })
  createdBy: string | null;
}

export class AgentSettingsVersion extends AgentSettingsVersionSummary {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      "The settings document in the engine's shape: businessName, purpose, tone, timezone, uiLocale, replyLanguage, hours, escalation (call forwarding, with the contacts' phone numbers), capabilities, voices, collect.",
  })
  document: Record<string, unknown>;
}
