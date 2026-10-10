import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { CONVERSATION_STATUSES } from '../../engine/engine.types';
import type {
  ConversationSort,
  ConversationStatus,
} from '../../engine/engine.types';

export class QueryConversationDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    type: String,
    example: 'escalated,human_active',
    description:
      'One or more statuses, comma-separated: `active` (the AI answers), `escalated` (waiting for a human, the queue), `human_active` (a human handles it), `resolved`.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      : value,
  )
  @IsIn(CONVERSATION_STATUSES, { each: true })
  status?: ConversationStatus[];

  @ApiPropertyOptional({
    example: 'me',
    description:
      '`me` = the conversations I handle, or the id of a team member.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(me|[0-9a-fA-F-]{36})$/, {
    message: 'assignedTo must be "me" or a user id',
  })
  assignedTo?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only the conversations of this end customer.',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    enum: ['lastMessageAt', 'escalatedAt'],
    default: 'lastMessageAt',
    description:
      '`lastMessageAt`: newest activity first. `escalatedAt`: the queue order, the one that has waited longest first.',
  })
  @IsOptional()
  @IsIn(['lastMessageAt', 'escalatedAt'])
  sort?: ConversationSort;
}

/** Paging of the messages of one conversation (oldest first). */
export class QueryConversationMessagesDto extends PaginationQueryDto {}

export class ReleaseConversationDto {
  @ApiPropertyOptional({
    enum: ['active', 'escalated'],
    default: 'active',
    description:
      '`active`: the AI answers again. `escalated`: back in the queue for a colleague. (To close it, use resolve.)',
  })
  @IsOptional()
  @IsIn(['active', 'escalated'])
  to?: 'active' | 'escalated';
}

export class SendConversationMessageDto {
  @ApiProperty({
    maxLength: 2000,
    description: 'The reply the customer will see (at most 2,000 characters).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  content: string;
}
