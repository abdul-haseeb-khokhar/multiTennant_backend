import { ApiProperty } from '@nestjs/swagger';
import {
  CONVERSATION_STATUSES,
  ESCALATION_REASONS,
} from '../../engine/engine.types';

export class ConversationCustomer {
  @ApiProperty({ type: String, nullable: true })
  name: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'web_a1b2c3…',
    description:
      "The customer's id in their channel: a phone number, the tenant's own id, or for an anonymous website visitor a SHORTENED `web_` id (the full one is that visitor's secret). Null when the customer record no longer exists.",
  })
  externalId: string | null;

  @ApiProperty({ enum: ['widget', 'whatsapp', 'voice'] })
  channel: string;
}

export class Conversation {
  @ApiProperty()
  id: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  endCustomerId: string | null;

  @ApiProperty({ type: ConversationCustomer })
  customer: ConversationCustomer;

  @ApiProperty({ enum: ['widget', 'whatsapp', 'voice'] })
  channel: string;

  @ApiProperty({
    enum: CONVERSATION_STATUSES,
    description:
      '`active` the AI answers; `escalated` waits for a human; `human_active` a human handles it (the AI is silent); `resolved` is over.',
  })
  status: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The staff member handling it (while `human_active`).',
  })
  assignedUserId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Their name (or email when they have no name). Null when nobody holds it or the user was deleted.',
  })
  assignedUserName: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  escalatedAt: string | null;

  @ApiProperty({
    enum: ESCALATION_REASONS,
    nullable: true,
    type: String,
    description: 'Stable code; translate it in the dashboard.',
  })
  escalationReason: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Hand-off note written when it escalated.',
  })
  summary: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastMessageAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt: string | null;

  @ApiProperty({
    enum: ['ai', 'human', 'customer', 'system'],
    nullable: true,
    type: String,
  })
  resolvedBy: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

export class ConversationMessage {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['customer', 'ai', 'human', 'system'] })
  authorType: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The staff member who wrote a `human` message.',
  })
  authorUserId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Their name (or email); the customer's name for a `customer` message; null for the AI, system lines and deleted users.",
  })
  authorName: string | null;

  @ApiProperty({
    description:
      'Message text. Empty for a system line: use `contentKey` instead.',
  })
  content: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'agent.joined',
    description:
      'For system lines: a key of the `widget` translation namespace (`GET /v1/i18n/:locale/widget`), for example `agent.joined`, `agent.left`, `resolved.notice`.',
  })
  contentKey: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

export class ConversationDetail {
  @ApiProperty({ type: Conversation })
  conversation: Conversation;

  @ApiProperty({
    type: 'object',
    required: ['data', 'total', 'skip', 'take'],
    properties: {
      data: {
        type: 'array',
        items: { $ref: '#/components/schemas/ConversationMessage' },
      },
      total: { type: 'integer' },
      skip: { type: 'integer' },
      take: { type: 'integer' },
    },
    description: 'The messages, oldest first, paginated.',
  })
  messages: {
    data: ConversationMessage[];
    total: number;
    skip: number;
    take: number;
  };
}

export class ConversationCounts {
  @ApiProperty({
    type: 'object',
    required: ['active', 'escalated', 'human_active', 'resolved'],
    properties: {
      active: { type: 'integer' },
      escalated: { type: 'integer', description: 'The queue.' },
      human_active: { type: 'integer' },
      resolved: { type: 'integer' },
    },
  })
  counts: Record<string, number>;

  @ApiProperty({
    description: 'How many conversations I am handling right now.',
  })
  assignedToMe: number;
}
