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
      'The keys to change. Each key you send replaces that whole key; keys you leave out keep their value. Known keys: businessName, purpose, tone (professional|friendly|concise|formal), timezone (IANA), uiLocale and replyLanguage (en|ur), hours (`{mon: [["09:00","17:00"]], …}` or null), escalation (call forwarding), capabilities, voices, collect (what the agent collects: the engine\'s document, stored as it is; null = not set up). Optional keys the engine added (absent until set): greeting (`{en?, ur?}`, 400 characters each, `{business}` is the placeholder), recordCalls and autoEndCalls (booleans), endCallDelaySeconds (2 to 10), profileSummary (text up to 1200 or null), profileSummarySources (`[{id, title, hash}]`, up to 10) and escalation.announce (`{en?, ur?}`, 200 characters each). A key the backend does not know (at the top or inside escalation) is kept exactly as sent and handed to the engine: the engine owns the field list. The backend checks the structure only (400 AGENT_SETTINGS_INVALID with `details`); deeper checks of `collect`, `voices` and the placeholders belong to the engine.',
  })
  @IsObject()
  settings: Record<string, unknown>;
}
