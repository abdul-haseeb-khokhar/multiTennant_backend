import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FALLBACK_REASONS } from '../widget-text.service';

export class WidgetFallback {
  @ApiProperty({
    enum: FALLBACK_REASONS,
    description:
      '`service_unavailable`: the chat is switched off for this tenant (suspended, closed, no chat in the plan). `limit_reached`: the plan limit was reached and a human takes over. `ai_unavailable`: the assistant is down or too slow and a human takes over. The customer never sees billing details.',
  })
  reason: string;

  @ApiProperty({
    description:
      "Text to show the customer, already in their language: the tenant's own fallback message when it has one (Phase 5), else the default from the `widget` namespace.",
  })
  message: string;
}

export class WidgetSession {
  @ApiProperty({
    enum: ['ready', 'limited', 'blocked'],
    description:
      '`ready`: chat normally. `limited`: the conversation exists but the AI will not answer it (plan limit); messages reach a human; `fallback` says what to show. `blocked`: no chat possible, there is no token; show `fallback`.',
  })
  status: string;

  @ApiPropertyOptional({
    description:
      'Widget token (Authorization: Bearer) for the other widget routes. Absent when `blocked`. Valid 15 minutes; call this endpoint again with the same visitorId to get a new one.',
  })
  token?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  expiresAt?: string;

  @ApiPropertyOptional({ example: 900 })
  expiresInSeconds?: number;

  @ApiPropertyOptional()
  conversationId?: string;

  @ApiProperty({
    example: 'ur',
    description: 'Language to render the widget in.',
  })
  locale: string;

  @ApiProperty({ example: 'en', description: "The tenant's default language." })
  defaultLocale: string;

  @ApiPropertyOptional({ description: 'Greeting to show first (in `locale`).' })
  greeting?: string;

  @ApiPropertyOptional({ description: 'Name of the assistant.' })
  personaName?: string;

  @ApiProperty({
    description:
      'Whether the widget must show the "Powered by" label (Free plan).',
  })
  poweredBy: boolean;

  @ApiPropertyOptional({ type: WidgetFallback })
  fallback?: WidgetFallback;
}

export class WidgetHistoryMessage {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['customer', 'ai', 'human', 'system'] })
  authorType: string;
  @ApiProperty() content: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Translation key (`widget` namespace) for system lines such as `agent.joined`; then `content` is empty.',
  })
  contentKey?: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: string;
}

export class WidgetConversation {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['active', 'escalated', 'human_active', 'resolved'] })
  status: string;
  @ApiProperty({ type: [WidgetHistoryMessage] }) data: WidgetHistoryMessage[];
  @ApiProperty() total: number;
  @ApiProperty() skip: number;
  @ApiProperty() take: number;
}

/** Documentation of the `data:` payload of each server-sent event of `POST /v1/widget/messages`. */
export class SseAcceptedEvent {
  @ApiProperty({ description: 'Id of the stored customer message.' })
  messageId: string;
}

export class SseTokenEvent {
  @ApiProperty({
    description: 'The next piece of the reply; concatenate them.',
  })
  text: string;
}

export class SseEscalatedEvent {
  @ApiProperty({
    description:
      'A human has been asked to take over (or is already waiting). Show this text.',
  })
  message: string;
  @ApiPropertyOptional({ description: 'Why (engine escalation reason code).' })
  reason?: string;
}

export class SseFallbackEvent extends WidgetFallback {
  @ApiProperty({
    description:
      'True when the conversation was handed to a human; false when it could not be (nobody was told yet, the gateway retries).',
  })
  escalated: boolean;
}

export class SseDoneEvent {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Id of the assistant message; null when the AI did not answer.',
  })
  messageId: string | null;
  @ApiProperty() aiReply: boolean;
  @ApiProperty({ enum: ['active', 'escalated', 'human_active', 'resolved'] })
  conversationStatus: string;
}

export class SseErrorEvent {
  @ApiProperty({
    example: 'CONVERSATION_RESOLVED',
    description:
      'The conversation is gone or finished (`CONVERSATION_NOT_FOUND`, `CONVERSATION_RESOLVED`): call POST /v1/widget/sessions again for a new one.',
  })
  code: string;
}
