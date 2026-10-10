import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeHub, staffChannel } from './realtime.hub';
import {
  STAFF_STREAMS_PER_USER,
  STAFF_STREAM_CHECK_MS,
  STAFF_STREAM_MAX_AGE_MS,
  STREAM_TICKET_TTL_SECONDS,
} from './realtime.constants';
import { lastEventIdOf, openSse } from './sse';
import { StaffStreamGuard } from './staff-stream.guard';
import { StreamRegistry } from './stream-registry';
import { StreamTicketService } from './stream-ticket.service';

class StreamTicketResponse {
  @ApiProperty({
    description:
      'Single use, valid for 30 seconds: open the stream with `?ticket=<this>` right away.',
  })
  ticket: string;

  @ApiProperty({ example: STREAM_TICKET_TTL_SECONDS })
  expiresInSeconds: number;
}

@ApiTags('events')
@Controller('tenants/:tenantId/events')
export class StaffEventsController {
  constructor(
    private readonly hub: RealtimeHub,
    private readonly registry: StreamRegistry,
    private readonly tickets: StreamTicketService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('ticket')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin', 'agent')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'A single-use ticket to open the event stream from a browser',
    description:
      'A browser `EventSource` cannot send an `Authorization` header, and the access token must never be put in a URL. Call this with the normal `Authorization` header, then open `GET …/events?ticket=<ticket>` within 30 seconds. The ticket works once; open a new one (this call again) for every reconnect. A server-side proxy that can set the header does not need tickets.',
  })
  @ApiOkResponse({ type: StreamTicketResponse })
  ticket(@Param('tenantId') tenantId: string, @CurrentUser() user: AuthUser) {
    return this.tickets.issue(tenantId, user.userId);
  }

  @Get()
  @UseGuards(StaffStreamGuard, RolesGuard)
  @Roles('owner', 'admin', 'agent')
  @ApiBearerAuth()
  @ApiProduces('text/event-stream')
  @ApiQuery({
    name: 'ticket',
    required: false,
    description:
      'A single-use ticket from `POST …/events/ticket`, instead of the `Authorization` header. The access token itself is never accepted in the query string.',
  })
  @ApiQuery({
    name: 'lastEventId',
    required: false,
    description:
      'Resume point for clients that cannot send the `Last-Event-ID` header (a new `EventSource` after a reconnect).',
  })
  @ApiOperation({
    summary: 'Live events for the dashboard (server-sent events)',
    description: [
      'A `text/event-stream` for every staff role. Authentication: `Authorization: Bearer <token>` (from a server-side proxy) or `?ticket=` (direct browser use).',
      'Events (the payload only has ids, so the UI refetches): `conversation.escalated`, `conversation.assigned`, `conversation.released`, `conversation.resolved` `{conversationId}`; `message.created` `{conversationId, messageId, authorType}`; `action.proposed` `{actionId, conversationId?}`; `notification.created` `{notificationId, type}` (only on the stream of the user it is for).',
      'Control events: `ready` (the stream is open), `resync` (your `Last-Event-ID` is too old or from before a restart: reload your lists), `closed` `{reason}` (`expired`, `revoked` when the user was disabled, `limit` when a sixth stream replaced this one). A `: ping` comment arrives every 25 seconds. Every data event has an `id`; send it back as `Last-Event-ID` to receive what you missed (the last 100 events are kept).',
      'At most 5 streams per user; opening another closes the oldest. The fan-out lives in the memory of one backend instance: several instances need a shared bus (Redis, Phase 8). A stream ends after one hour; reconnect.',
    ].join('\n\n'),
  })
  @ApiOkResponse({
    description: 'text/event-stream',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            'retry: 3000\n\nevent: ready\ndata: {"heartbeatSeconds":25}\n\nid: 9f2a-1\nevent: conversation.escalated\ndata: {"conversationId":"…"}\n\n',
        },
      },
    },
  })
  stream(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const connection = openSse(request, response, {
      expiresAt: Date.now() + STAFF_STREAM_MAX_AGE_MS,
      checkEveryMs: STAFF_STREAM_CHECK_MS,
      // A user disabled or deleted while connected is cut off at the next check.
      stillAllowed: async () => {
        const row = await this.prisma.tenantUser.findFirst({
          where: { id: user.userId, tenantId, status: 'active' },
          select: { id: true },
        });
        return row !== null;
      },
    });
    const release = this.registry.register(
      `staff:${tenantId}:${user.userId}`,
      STAFF_STREAMS_PER_USER,
      (reason) => connection.close(reason),
    );
    const subscription = this.hub.subscribe(
      staffChannel(tenantId),
      (event) => connection.send(event.event, event.data, event.id),
      { lastEventId: lastEventIdOf(request), userId: user.userId },
    );
    connection.onClose(() => {
      subscription.unsubscribe();
      release();
    });

    connection.send('ready', { heartbeatSeconds: 25 });
    if (subscription.replay === 'resync') {
      connection.send('resync', {});
    } else {
      for (const event of subscription.replay) {
        connection.send(event.event, event.data, event.id);
      }
    }
  }
}
