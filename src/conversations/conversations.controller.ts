import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { ConversationsService } from './conversations.service';
import {
  QueryConversationDto,
  QueryConversationMessagesDto,
  ReleaseConversationDto,
  SendConversationMessageDto,
} from './dto/conversation.dto';
import {
  Conversation,
  ConversationCounts,
  ConversationDetail,
  ConversationMessage,
} from './entities/conversation.entity';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/** The optional `Idempotency-Key` of a command, validated like the widget's. */
function keyOf(request: Request): string | undefined {
  const value = request.header('idempotency-key');
  if (value === undefined) return undefined;
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VALIDATION_ERROR,
      'Idempotency-Key must be 8 to 100 characters of A-Z, a-z, 0-9, _ or -',
    );
  }
  return value;
}

const IdempotencyHeader = ApiHeader({
  name: 'Idempotency-Key',
  required: false,
  description:
    'Optional (8-100 characters of A-Z a-z 0-9 _ -). Sending the same key again repeats the result instead of doing it twice.',
});

/**
 * Staff conversations (Phase 4). Every role reads and works conversations (B2); the rules about
 * WHO may reply, release or resolve a claimed conversation are in `ConversationsService`.
 */
@ApiTags('conversations')
@ApiBearerAuth()
@Controller('tenants/:tenantId/conversations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: 'List conversations (every role)',
    description:
      'The queue is `?status=escalated&sort=escalatedAt`; my work is `?assignedTo=me`; one customer is `?customerId=`. Newest activity first by default.',
  })
  @ApiPaginatedResponse(Conversation)
  list(@CurrentUser() user: AuthUser, @Query() query: QueryConversationDto) {
    return this.conversations.list(user, query);
  }

  @Get('counts')
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: 'How many conversations per status (for the sidebar badge)',
    description:
      '`counts.escalated` is the queue; `assignedToMe` how many I am handling.',
  })
  @ApiOkResponse({ type: ConversationCounts })
  counts(@CurrentUser() user: AuthUser) {
    return this.conversations.counts(user);
  }

  @Get(':id')
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: 'One conversation with its messages (every role)',
    description:
      'The messages are oldest first and paginated (default 50). System lines ("an agent joined") have an empty `content` and a `contentKey` of the `widget` namespace. Another tenant\'s conversation is a 404.',
  })
  @ApiOkResponse({ type: ConversationDetail })
  @ApiNotFoundResponse({ description: 'CONVERSATION_NOT_FOUND' })
  get(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query() query: QueryConversationMessagesDto,
  ) {
    return this.conversations.get(user, id, query);
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'admin', 'agent')
  @IdempotencyHeader
  @ApiOperation({
    summary: 'Take a conversation (every role)',
    description:
      'Only an `active` or `escalated` conversation nobody holds: it becomes `human_active` and the AI stops answering. Two people claiming at once: one wins, the other gets 409 CONVERSATION_ALREADY_CLAIMED. Claiming what you already hold answers 200 again.',
  })
  @ApiOkResponse({ type: Conversation })
  @ApiConflictResponse({
    description: 'CONVERSATION_ALREADY_CLAIMED or CONVERSATION_RESOLVED',
  })
  claim(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.conversations.claim(user, id, keyOf(request));
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'admin', 'agent')
  @IdempotencyHeader
  @ApiOperation({
    summary: 'Give a conversation back (the person handling it)',
    description:
      "`to: active` (default): the AI answers again. `to: escalated`: back in the queue. Only the assignee, whatever their role (owner and admin cannot release a colleague's conversation until transfer exists): otherwise 409 CONVERSATION_NOT_ASSIGNED_TO_YOU.",
  })
  @ApiOkResponse({ type: Conversation })
  @ApiConflictResponse({
    description: 'CONVERSATION_NOT_ASSIGNED_TO_YOU or CONVERSATION_RESOLVED',
  })
  release(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReleaseConversationDto,
    @Req() request: Request,
  ) {
    return this.conversations.release(user, id, dto.to, keyOf(request));
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'admin', 'agent')
  @IdempotencyHeader
  @ApiOperation({
    summary: 'Close a conversation (the person handling it)',
    description:
      "Only the assignee: otherwise 409 CONVERSATION_NOT_ASSIGNED_TO_YOU. A resolved conversation accepts no more messages; the customer's next message starts a new one.",
  })
  @ApiOkResponse({ type: Conversation })
  @ApiConflictResponse({
    description: 'CONVERSATION_NOT_ASSIGNED_TO_YOU or CONVERSATION_RESOLVED',
  })
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.conversations.resolve(user, id, keyOf(request));
  }

  @Post(':id/messages')
  @Roles('owner', 'admin', 'agent')
  @IdempotencyHeader
  @ApiOperation({
    summary: 'Reply to the customer (the person handling it)',
    description:
      'At most 2,000 characters (400 MESSAGE_TOO_LONG). Only the assignee of a `human_active` conversation: otherwise 409 CONVERSATION_NOT_ASSIGNED_TO_YOU. The customer sees it in the widget at once.',
  })
  @ApiCreatedResponse({ type: ConversationMessage })
  @ApiBadRequestResponse({
    description: 'MESSAGE_TOO_LONG or VALIDATION_ERROR',
  })
  @ApiConflictResponse({
    description: 'CONVERSATION_NOT_ASSIGNED_TO_YOU or CONVERSATION_RESOLVED',
  })
  reply(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SendConversationMessageDto,
    @Req() request: Request,
  ) {
    return this.conversations.reply(user, id, dto.content, keyOf(request));
  }
}
