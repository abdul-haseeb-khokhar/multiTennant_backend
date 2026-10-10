import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { CreateWidgetSessionDto } from './dto/create-widget-session.dto';
import { QueryWidgetConversationDto } from './dto/query-widget-conversation.dto';
import { SendWidgetMessageDto } from './dto/send-widget-message.dto';
import {
  SseAcceptedEvent,
  SseDoneEvent,
  SseErrorEvent,
  SseEscalatedEvent,
  SseFallbackEvent,
  SseTokenEvent,
  WidgetConversation,
  WidgetSession,
} from './entities/widget.entities';
import { CurrentWidget } from './widget-auth';
import type { WidgetAuth } from './widget-auth';
import { WidgetAuthGuard } from './widget-auth.guard';
import { applyWidgetCors } from './widget-cors.service';
import { WidgetMessagesService } from './widget-messages.service';
import { WidgetSessionsService } from './widget-sessions.service';

type RequestWithId = Request & { id?: string };

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * The public face for the embedded chat widget (architecture 5.2). Browsers on customers'
 * websites call these routes; nothing else of the platform is reachable with a widget token.
 * CORS for `/v1/widget/*` is per widget key (see `WidgetCorsService`).
 */
@ApiTags('widget')
@ApiExtraModels(
  SseAcceptedEvent,
  SseTokenEvent,
  SseEscalatedEvent,
  SseFallbackEvent,
  SseDoneEvent,
  SseErrorEvent,
)
@Controller('widget')
export class WidgetController {
  private readonly logger = new Logger(WidgetController.name);

  constructor(
    private readonly sessions: WidgetSessionsService,
    private readonly messages: WidgetMessagesService,
  ) {}

  @Post('sessions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start or refresh a chat session (public, widget key + Origin)',
    description:
      'Validates the widget key together with the request `Origin` (the key must list that origin; a call without an Origin header is refused), checks that the tenant may chat, creates or finds the visitor (`web_<visitorId>`), creates the conversation (or resumes the open one of this visitor: call again with the same `visitorId` to get a fresh token before the 15 minutes end) and returns the widget token. A suspended or closed tenant, a plan without chat, or an engine that is down answers **200 with `status: "blocked"`** and a `fallback` text instead of an error; a tenant at its conversation limit gets `status: "limited"`. Errors: 401 WIDGET_KEY_INVALID, 403 ORIGIN_NOT_ALLOWED, 429 TOO_MANY_REQUESTS (with `Retry-After`).',
  })
  @ApiOkResponse({ type: WidgetSession })
  async createSession(
    @Body() dto: CreateWidgetSessionDto,
    @Req() request: RequestWithId,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.sessions.start(
      dto,
      {
        origin: request.headers.origin,
        ip: request.ip ?? 'unknown',
        requestId: request.id,
      },
      (origin) => applyWidgetCors(response, origin),
    );
  }

  @Post('messages')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WidgetAuthGuard)
  @ApiBearerAuth()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'A unique id (8-100 characters of A-Z a-z 0-9 _ -) per message. Sending the same key again does not store the message twice and does not call the model again.',
  })
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Send a customer message and stream the reply (widget token)',
    description:
      'The response is a **server-sent event stream** (`text/event-stream`), read with `fetch` and a stream reader (a POST cannot use `EventSource`). Events, in order: `accepted` (message stored), then `token` (zero or more; concatenate `text`), optionally `escalated` (a human was asked to take over), and finally either `done` or `fallback` (the AI did not answer: `service_unavailable`, `limit_reached` or `ai_unavailable`; the customer is never left without a text). `error` (`CONVERSATION_NOT_FOUND`, `CONVERSATION_RESOLVED`) means call POST /v1/widget/sessions for a new conversation. Failures before the stream starts are ordinary JSON errors: 400 MESSAGE_TOO_LONG (over 2,000 characters), 401 WIDGET_TOKEN_EXPIRED, 403 ORIGIN_NOT_ALLOWED, 404 CONVERSATION_NOT_FOUND, 429. Each event is `event: <name>` + `data: <json>` + blank line; the payload schemas are listed under `Sse*Event`.',
  })
  @ApiOkResponse({
    description: 'text/event-stream',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            'event: accepted\ndata: {"messageId":"…"}\n\nevent: token\ndata: {"text":"Our "}\n\nevent: done\ndata: {"messageId":"…","aiReply":true,"conversationStatus":"active"}\n\n',
        },
      },
    },
  })
  async sendMessage(
    @CurrentWidget() auth: WidgetAuth,
    @Body() dto: SendWidgetMessageDto,
    @Req() request: RequestWithId,
    @Res() response: Response,
  ) {
    const key = request.header('idempotency-key');
    if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Idempotency-Key must be 8 to 100 characters of A-Z, a-z, 0-9, _ or -',
      );
    }
    const abort = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) abort.abort();
    });

    // Anything that should be a normal HTTP error happens here, before the first byte is sent.
    const prepared = await this.messages.prepare(
      auth,
      dto,
      {
        ip: request.ip ?? 'unknown',
        requestId: request.id,
        idempotencyKey: key,
      },
      abort.signal,
    );

    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    try {
      for await (const { event, data } of prepared.events) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    } catch (error) {
      this.logger.error({
        message: 'The widget reply stream failed unexpectedly',
        requestId: request.id,
        tenantId: auth.tenantId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      response.write(
        `event: error\ndata: ${JSON.stringify({ code: ErrorCode.INTERNAL_ERROR })}\n\n`,
      );
    } finally {
      response.end();
    }
  }

  @Get('conversation')
  @UseGuards(WidgetAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The conversation history of the visitor (widget token)',
    description:
      'Oldest first, paged. Returns only the conversation named in the token; internal (tool) messages and staff identities are left out. 503 ENGINE_UNAVAILABLE when the engine cannot be reached.',
  })
  @ApiOkResponse({ type: WidgetConversation })
  history(
    @CurrentWidget() auth: WidgetAuth,
    @Query() query: QueryWidgetConversationDto,
    @Req() request: RequestWithId,
  ) {
    return this.messages.history(auth, query, {
      ip: request.ip ?? 'unknown',
      requestId: request.id,
    });
  }
}
