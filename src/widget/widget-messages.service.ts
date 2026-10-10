import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { GatewayConversation } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { EngineClient } from '../engine/engine-client';
import {
  EngineCallContext,
  EngineError,
  EscalationReason,
} from '../engine/engine.types';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { SendWidgetMessageDto } from './dto/send-widget-message.dto';
import { QueryWidgetConversationDto } from './dto/query-widget-conversation.dto';
import { WidgetAuth } from './widget-auth';
import { WidgetRateLimitService } from './widget-rate-limit.service';
import { WidgetSessionsService } from './widget-sessions.service';
import { FallbackReason, WidgetTextService } from './widget-text.service';
import { MAX_MESSAGE_LENGTH } from './widget.constants';
import { resolvePage } from '../common/pagination/pagination';

/** One server-sent event of the reply stream (`event:` name and JSON `data:`). */
export type WidgetEvent =
  | { event: 'accepted'; data: { messageId: string } }
  | { event: 'token'; data: { text: string } }
  | { event: 'escalated'; data: { message: string; reason?: string } }
  | {
      event: 'fallback';
      data: { reason: FallbackReason; message: string; escalated: boolean };
    }
  | {
      event: 'done';
      data: {
        messageId: string | null;
        aiReply: boolean;
        conversationStatus: string;
      };
    }
  | { event: 'error'; data: { code: string } };

export interface PreparedReply {
  /** The events to send. Starts only when iterated; everything that can fail with a normal HTTP error already did. */
  events: AsyncGenerator<WidgetEvent>;
}

type Mode = 'normal' | 'limited' | 'blocked';

/** What the reply stream needs to know about the visitor's gateway conversation. */
type OwnConversation = Pick<
  GatewayConversation,
  'id' | 'conversationId' | 'escalationReason' | 'escalationPending'
>;

/** Longest we wait for the engine to take an escalation before answering the customer (ms). */
const ESCALATE_TIMEOUT_MS = 3000;

/**
 * Relays a customer message to the engine and turns what happens into the widget's event stream
 * (architecture 5.2). Whatever goes wrong, the customer gets an answer, never a dead end (I5, D7):
 *  - tenant switched off  -> `fallback service_unavailable`, the engine is not called;
 *  - plan limit reached   -> the message is stored without an AI reply, the conversation is
 *    escalated (`limit_reached`), `fallback limit_reached`;
 *  - engine down or slow  -> `fallback ai_unavailable`, an escalation (`ai_unavailable`) is
 *    attempted (and remembered when the engine cannot be reached either).
 * The LLM is never called in the first two cases. Message text is never logged.
 */
@Injectable()
export class WidgetMessagesService {
  private readonly logger = new Logger(WidgetMessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineClient,
    private readonly usage: UsageService,
    private readonly sessions: WidgetSessionsService,
    private readonly text: WidgetTextService,
    private readonly rateLimits: WidgetRateLimitService,
  ) {}

  /**
   * Does every check that should still answer with a normal HTTP error (429, 400, 404) and returns
   * the event stream. `signal` aborts the engine call when the customer's connection closes.
   */
  async prepare(
    auth: WidgetAuth,
    dto: SendWidgetMessageDto,
    request: { ip: string; requestId?: string; idempotencyKey?: string },
    signal: AbortSignal,
  ): Promise<PreparedReply> {
    const limits = this.rateLimits.config;
    this.rateLimits.enforce([
      { scope: 'message-ip', id: request.ip, limit: limits.messagePerIp },
      { scope: 'message-key', id: auth.keyId, limit: limits.messagePerKey },
      {
        scope: 'message-visitor',
        id: `${auth.tenantId}:${auth.endCustomerId}`,
        limit: limits.messagePerVisitor,
      },
    ]);
    if (Array.from(dto.content).length > MAX_MESSAGE_LENGTH) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.MESSAGE_TOO_LONG,
        `A message can have at most ${MAX_MESSAGE_LENGTH} characters`,
      );
    }

    const conversation = await this.ownConversation(auth);
    const gate = await this.sessions.chatGate(auth.tenantId);
    const mode: Mode = !gate.open
      ? 'blocked'
      : conversation.aiBlocked
        ? 'limited'
        : 'normal';

    const ctx: EngineCallContext = {
      // The tenant is the one in the verified token, never from the request.
      tenantId: auth.tenantId,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey
        ? `${auth.conversationId}:${request.idempotencyKey}`
        : `${auth.conversationId}:${randomUUID()}`,
      signal,
    };
    void this.prisma.gatewayConversation
      .updateMany({
        where: { id: conversation.id, tenantId: auth.tenantId },
        data: { lastActivityAt: new Date() },
      })
      .catch(() => undefined);

    return {
      events: this.run(mode, auth, conversation, dto.content, ctx, signal),
    };
  }

  /** The visitor's conversation: paged messages from the engine, minus anything internal. */
  async history(
    auth: WidgetAuth,
    query: QueryWidgetConversationDto,
    request: { ip: string; requestId?: string },
  ) {
    const limits = this.rateLimits.config;
    this.rateLimits.enforce([
      { scope: 'read-ip', id: request.ip, limit: limits.readPerIp },
      {
        scope: 'read-visitor',
        id: `${auth.tenantId}:${auth.endCustomerId}`,
        limit: limits.readPerVisitor,
      },
    ]);
    const conversation = await this.ownConversation(auth);
    const gate = await this.sessions.chatGate(auth.tenantId);
    if (!gate.open) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.TENANT_SUSPENDED,
        'The chat is not available',
      );
    }
    const page = resolvePage(query);
    try {
      const result = await this.engine.getConversation(
        { tenantId: auth.tenantId, requestId: request.requestId },
        conversation.conversationId,
        page,
      );
      return {
        id: result.conversation.id,
        status: result.conversation.status,
        data: result.messages.data
          // Tool calls and the staff member's identity stay inside the platform.
          .filter((message) => message.authorType !== 'tool')
          .map((message) => ({
            id: message.id,
            authorType: message.authorType,
            content: message.content,
            contentKey: message.contentKey ?? null,
            createdAt: message.createdAt,
          })),
        total: result.messages.total,
        skip: result.messages.skip,
        take: result.messages.take,
      };
    } catch (error) {
      if (error instanceof EngineError && error.kind === 'not_found') {
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          ErrorCode.CONVERSATION_NOT_FOUND,
          'Conversation not found',
        );
      }
      this.logEngineProblem(auth.tenantId, error);
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.ENGINE_UNAVAILABLE,
        'The assistant is not available right now',
      );
    }
  }

  // -------------------------------------------------------------------------------------------

  /** The gateway's record of the token's conversation, scoped to the token's tenant AND end customer. */
  private async ownConversation(auth: WidgetAuth) {
    const row = await this.prisma.gatewayConversation.findFirst({
      where: {
        tenantId: auth.tenantId,
        endCustomerId: auth.endCustomerId,
        conversationId: auth.conversationId,
        closedAt: null,
      },
    });
    if (!row) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.CONVERSATION_NOT_FOUND,
        'Conversation not found',
      );
    }
    return row;
  }

  private async *run(
    mode: Mode,
    auth: WidgetAuth,
    conversation: OwnConversation,
    content: string,
    ctx: EngineCallContext,
    signal: AbortSignal,
  ): AsyncGenerator<WidgetEvent> {
    if (mode === 'blocked') {
      yield {
        event: 'fallback',
        data: {
          ...(await this.text.fallback(
            auth.tenantId,
            'service_unavailable',
            auth.locale,
          )),
          escalated: false,
        },
      };
      return;
    }
    try {
      if (mode === 'limited') {
        yield* this.limited(auth, conversation, content, ctx);
      } else {
        yield* this.normal(auth, content, ctx);
      }
    } catch (error) {
      if (signal.aborted) return; // the customer left; nothing to answer
      yield* this.failed(auth, conversation, error, ctx);
    }
  }

  private async *normal(
    auth: WidgetAuth,
    content: string,
    ctx: EngineCallContext,
  ): AsyncGenerator<WidgetEvent> {
    let escalated = false;
    for await (const event of this.engine.sendMessage(
      ctx,
      auth.conversationId,
      { content, externalMessageId: ctx.idempotencyKey, aiReply: true },
    )) {
      switch (event.type) {
        case 'accepted':
          await this.count(auth.tenantId, { messageId: event.messageId });
          yield { event: 'accepted', data: { messageId: event.messageId } };
          break;
        case 'token':
          yield { event: 'token', data: { text: event.text } };
          break;
        case 'usage':
          await this.count(auth.tenantId, {
            messageId: event.messageId,
            tokensIn: event.tokensIn,
            tokensOut: event.tokensOut,
          });
          break;
        case 'escalated':
          escalated = true;
          yield {
            event: 'escalated',
            data: {
              message: await this.text.escalatedNotice(
                auth.tenantId,
                auth.locale,
              ),
              reason: event.reason,
            },
          };
          break;
        case 'done':
          if (event.messageId) {
            await this.count(auth.tenantId, { messageId: event.messageId });
          }
          // A follow-up on a conversation that already waits for a human: no AI reply, say so.
          if (
            !event.aiReply &&
            event.conversationStatus === 'escalated' &&
            !escalated
          ) {
            yield {
              event: 'escalated',
              data: {
                message: await this.text.escalatedNotice(
                  auth.tenantId,
                  auth.locale,
                ),
              },
            };
          }
          yield {
            event: 'done',
            data: {
              messageId: event.messageId,
              aiReply: event.aiReply,
              conversationStatus: event.conversationStatus,
            },
          };
          break;
      }
    }
  }

  /** Plan limit reached: store the message for a human, escalate, never call the model (I5). */
  private async *limited(
    auth: WidgetAuth,
    conversation: OwnConversation,
    content: string,
    ctx: EngineCallContext,
  ): AsyncGenerator<WidgetEvent> {
    for await (const event of this.engine.sendMessage(
      ctx,
      auth.conversationId,
      { content, externalMessageId: ctx.idempotencyKey, aiReply: false },
    )) {
      if (event.type === 'accepted') {
        await this.count(auth.tenantId, { messageId: event.messageId });
        yield { event: 'accepted', data: { messageId: event.messageId } };
      }
    }
    const escalated = await this.escalate(
      auth,
      conversation,
      'limit_reached',
      ctx,
    );
    yield {
      event: 'fallback',
      data: {
        ...(await this.text.fallback(
          auth.tenantId,
          'limit_reached',
          auth.locale,
        )),
        escalated,
      },
    };
  }

  /** The engine failed or was too slow: escalate, then answer with the fallback (D7). */
  private async *failed(
    auth: WidgetAuth,
    conversation: OwnConversation,
    error: unknown,
    ctx: EngineCallContext,
  ): AsyncGenerator<WidgetEvent> {
    if (error instanceof EngineError && error.kind === 'not_found') {
      await this.close(auth, conversation.id);
      yield {
        event: 'error',
        data: { code: ErrorCode.CONVERSATION_NOT_FOUND },
      };
      return;
    }
    if (error instanceof EngineError && error.kind === 'conflict') {
      await this.close(auth, conversation.id);
      yield { event: 'error', data: { code: ErrorCode.CONVERSATION_RESOLVED } };
      return;
    }
    this.logEngineProblem(auth.tenantId, error);
    const escalated = await this.escalate(
      auth,
      conversation,
      'ai_unavailable',
      { ...ctx, signal: undefined },
    );
    yield {
      event: 'fallback',
      data: {
        ...(await this.text.fallback(
          auth.tenantId,
          'ai_unavailable',
          auth.locale,
        )),
        escalated,
      },
    };
  }

  /**
   * Tells the engine to escalate. If the engine cannot be reached the escalation is remembered
   * (`escalation_pending`) so a later phase can deliver it; the customer is answered either way.
   */
  private async escalate(
    auth: WidgetAuth,
    conversation: OwnConversation,
    reason: EscalationReason,
    ctx: EngineCallContext,
  ): Promise<boolean> {
    if (
      conversation.escalationReason === reason &&
      !conversation.escalationPending
    ) {
      return true;
    }
    let delivered = false;
    try {
      await this.engine.escalate(
        {
          tenantId: auth.tenantId,
          requestId: ctx.requestId,
          idempotencyKey: `escalate:${auth.conversationId}:${reason}`,
          signal: AbortSignal.timeout(ESCALATE_TIMEOUT_MS),
        },
        auth.conversationId,
        { reason },
      );
      delivered = true;
    } catch (error) {
      this.logEngineProblem(auth.tenantId, error);
    }
    await this.prisma.gatewayConversation
      .updateMany({
        where: { id: conversation.id, tenantId: auth.tenantId },
        data: { escalationReason: reason, escalationPending: !delivered },
      })
      .catch(() => undefined);
    return delivered;
  }

  private async close(auth: WidgetAuth, id: string) {
    await this.prisma.gatewayConversation
      .updateMany({
        where: { id, tenantId: auth.tenantId },
        data: { closedAt: new Date() },
      })
      .catch(() => undefined);
  }

  /** Counting usage must never break the chat. */
  private async count(
    tenantId: string,
    usage: { messageId: string; tokensIn?: number; tokensOut?: number },
  ) {
    try {
      await this.usage.recordMessage(tenantId, usage);
    } catch (error) {
      this.logger.warn({
        message: 'Could not record message usage',
        tenantId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private logEngineProblem(tenantId: string, error: unknown) {
    this.logger.warn({
      message: 'The engine could not serve a widget request',
      tenantId,
      kind: error instanceof EngineError ? error.kind : 'unexpected',
      status: error instanceof EngineError ? error.status : undefined,
    });
  }
}
