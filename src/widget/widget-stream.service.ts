import { HttpStatus, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { WIDGET_STREAMS_PER_CONVERSATION } from '../realtime/realtime.constants';
import { RealtimeHub, widgetChannel } from '../realtime/realtime.hub';
import { lastEventIdOf, openSse } from '../realtime/sse';
import { StreamRegistry } from '../realtime/stream-registry';
import { WidgetAuth } from './widget-auth';
import { WidgetMessagesService } from './widget-messages.service';
import { WidgetRateLimitService } from './widget-rate-limit.service';
import { WidgetSessionsService } from './widget-sessions.service';
import { WIDGET_TOKEN_TTL_SECONDS } from './widget.constants';

/** How often an open widget stream re-checks that its key is still active (revoking a key ends its sessions). */
const KEY_CHECK_MS = 60_000;

/**
 * The customer's live channel (Phase 4, D5): what happens in their conversation while they are not
 * sending a message, namely a staff member's reply, the system lines (`agent.joined`, `agent.left`,
 * `resolved.notice`, as translation keys) and the conversation's status. The widget token, the
 * key and the `Origin` were already checked by `WidgetAuthGuard`; the stream is bound to the
 * token's tenant and conversation and ends when the token expires (the widget refreshes its
 * session and reconnects with `Last-Event-ID`) or when the key is revoked. The history route stays
 * the fallback: a widget that cannot hold a stream polls `GET /v1/widget/conversation`.
 */
@Injectable()
export class WidgetStreamService {
  constructor(
    private readonly hub: RealtimeHub,
    private readonly registry: StreamRegistry,
    private readonly rateLimits: WidgetRateLimitService,
    private readonly messages: WidgetMessagesService,
    private readonly sessions: WidgetSessionsService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  async open(
    auth: WidgetAuth,
    request: Request,
    response: Response,
    ip: string,
  ): Promise<void> {
    const limits = this.rateLimits.config;
    this.rateLimits.enforce([
      { scope: 'read-ip', id: ip, limit: limits.readPerIp },
      {
        scope: 'read-visitor',
        id: `${auth.tenantId}:${auth.endCustomerId}`,
        limit: limits.readPerVisitor,
      },
    ]);
    // Everything that should still be an ordinary JSON error happens before the first byte.
    await this.messages.assertOwnConversation(auth);
    const gate = await this.sessions.chatGate(auth.tenantId);
    if (!gate.open) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.TENANT_SUSPENDED,
        'The chat is not available',
      );
    }

    const connection = openSse(request, response, {
      expiresAt: auth.expiresAtMs,
      checkEveryMs: KEY_CHECK_MS,
      stillAllowed: async () => {
        const key = await this.apiKeys.findActiveWidgetKey(
          auth.tenantId,
          auth.keyId,
        );
        return (
          key !== null && (await this.sessions.chatGate(auth.tenantId)).open
        );
      },
    });
    const release = this.registry.register(
      `widget:${auth.tenantId}:${auth.conversationId}`,
      WIDGET_STREAMS_PER_CONVERSATION,
      (reason) => connection.close(reason),
    );
    const subscription = this.hub.subscribe(
      widgetChannel(auth.tenantId, auth.conversationId),
      (event) => connection.send(event.event, event.data, event.id),
      { lastEventId: lastEventIdOf(request) },
    );
    connection.onClose(() => {
      subscription.unsubscribe();
      release();
    });

    connection.send('ready', {
      heartbeatSeconds: 25,
      tokenExpiresInSeconds: auth.expiresAtMs
        ? Math.max(Math.round((auth.expiresAtMs - Date.now()) / 1000), 0)
        : WIDGET_TOKEN_TTL_SECONDS,
    });
    if (subscription.replay === 'resync') {
      // Too old to resume: the widget re-reads GET /v1/widget/conversation.
      connection.send('resync', {});
    } else {
      for (const event of subscription.replay) {
        connection.send(event.event, event.data, event.id);
      }
    }
  }
}
