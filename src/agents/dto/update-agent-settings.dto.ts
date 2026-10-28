import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsObject, Min } from 'class-validator';

export class UpdateAgentSettingsDto {
  @ApiProperty({
    minimum: 1,
    example: 3,
    description:
      'The version you started from (the `version` of your last GET). If someone saved in between, the answer is 409 AGENT_SETTINGS_VERSION_CONFLICT with `currentVersion`: reload and make the change again.',
  })
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { tone: 'friendly', replyLanguage: 'ur' },
    description:
      'The keys to change. Each key you send replaces that whole key; keys you leave out keep their value. Known keys: businessName, purpose, tone (professional|friendly|concise|formal), timezone (IANA), uiLocale and replyLanguage (en|ur), hours (`{mon: [["09:00","17:00"]], …}` or null), escalation (call forwarding), capabilities, voices, collect (what the agent collects: the engine\'s document, stored as it is; null = not set up). The backend checks the structure only (400 AGENT_SETTINGS_INVALID with `details`); deeper checks of `collect` and `voices` belong to the engine.',
  })
  @IsObject()
  settings: Record<string, unknown>;
}
