import { ApiProperty } from '@nestjs/swagger';
import { NotificationType } from '../notification-types';

/**
 * An in-app notification. There is no text: render the keys `<type>.title` and `<type>.body` of the
 * `notifications` namespace (`GET /v1/i18n/:locale/notifications`) with `params`. The params of each
 * type are listed in docs/architecture.md (section 5.7) and in the translation files.
 */
export class Notification {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    enum: Object.values(NotificationType),
    description:
      'Translation key prefix: the title is `<type>.title`, the body `<type>.body`.',
  })
  type: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Values for the ICU placeholders of the translations, for example `{ customer, conversationId, reason }` or `{ percent, limit }`.',
  })
  params: Record<string, unknown>;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '/conversations/6c1f…',
    description: 'App-relative path to open when the notification is clicked.',
  })
  link: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class MarkAllReadResult {
  @ApiProperty({ description: 'How many notifications were unread before.' })
  updated: number;
}
