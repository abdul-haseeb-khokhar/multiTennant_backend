import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Notification, Prisma } from '@prisma/client';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { customerLabel } from '../end-customers/customer-label';
import type { EngineEventEnvelope } from '../engine/engine.types';
import { NotificationType } from '../notifications/notification-types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { StaffEvent, WidgetEvent } from '../realtime/realtime.constants';
import {
  createdKey,
  requestSubmittedNotification,
  updatedKey,
} from '../requests/request-views';
import {
  RealtimeHub,
  staffChannel,
  widgetChannel,
} from '../realtime/realtime.hub';
import { UsageService } from '../usage/usage.service';

type Tx = Prisma.TransactionClient;

export type IngestStatus = 'processed' | 'duplicate' | 'ignored';

/** What an event does once its transaction committed: live messages to open streams. */
interface Effects {
  staff: { event: string; data: Record<string, unknown>; dedupeKey?: string }[];
  widget: {
    conversationId: string;
    event: string;
    data: Record<string, unknown>;
    dedupeKey: string;
  }[];
  notified: Notification[];
  known: boolean;
}

/** Event types this backend acts on. The rest is acknowledged and ignored (see the contract). */
export const HANDLED_EVENT_TYPES = [
  'conversation.created',
  'conversation.escalated',
  'conversation.assigned',
  'conversation.released',
  'conversation.resolved',
  'message.created',
  'usage.recorded',
  'action.proposed',
  'record.submitted',
  'record.updated',
] as const;

/**
 * Voice-first event types the engine reports (M2.4, L4) that no phase handles yet: a call ended
 * (`usage.call_minutes`: Phase 5E). They are ACKNOWLEDGED (200 `ignored`) after the usual tenant
 * check, and not written to the inbox, so that once the phase that handles them exists a re-delivery
 * of the engine outbox is still processed instead of being answered `duplicate`. (`record.submitted`
 * and `record.updated` are handled since Phase 5B-2.)
 */
export const PENDING_EVENT_TYPES = ['usage.call_minutes'] as const;

/**
 * Applies the events the AI engine pushes (D5): usage into `usage_daily`, notifications for the
 * team, and live messages to the dashboard and the customer's widget. It is the single code path
 * for both the real engine (`POST /internal/events`, after the signature check) and the mock
 * engine (called in-process).
 *
 *  - Tenant: ONLY the envelope's `tenantId`, checked against an existing tenant. Ids inside `data`
 *    (conversation, customer, user) are looked up scoped to that tenant, never trusted to pick one.
 *  - Idempotent: the (tenant, event id) pair is inserted into `engine_events` in the SAME
 *    transaction as the event's effects, so a delivery either happened completely or not at all,
 *    and a repeat is a no-op (`duplicate`).
 *  - Live messages go out AFTER the commit, so a stream never announces something that rolled back.
 *  - Message text is never logged and never stored in the inbox.
 */
@Injectable()
export class EngineEventsService {
  private readonly logger = new Logger(EngineEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly usage: UsageService,
    private readonly hub: RealtimeHub,
  ) {}

  async ingest(event: EngineEventEnvelope): Promise<{ status: IngestStatus }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: event.tenantId },
      select: { id: true },
    });
    if (!tenant) {
      this.logger.warn({
        message: 'Engine event for an unknown tenant',
        eventType: event.type,
      });
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.TENANT_NOT_FOUND,
        'Unknown tenant',
      );
    }

    if ((PENDING_EVENT_TYPES as readonly string[]).includes(event.type)) {
      // Type and tenant only: never the data (a request summary may hold a caller's words).
      this.logger.log({
        message: 'Acknowledged an engine event that is not handled yet',
        eventType: event.type,
        tenantId: event.tenantId,
      });
      return { status: 'ignored' };
    }

    const effects: Effects = {
      staff: [],
      widget: [],
      notified: [],
      known: true,
    };
    let duplicate = false;
    await this.prisma.$transaction(async (tx) => {
      const inserted = await tx.engineEvent.createMany({
        data: [
          {
            tenantId: event.tenantId,
            eventId: event.id,
            type: event.type,
            occurredAt: new Date(event.occurredAt),
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        duplicate = true;
        return;
      }
      await this.handle(tx, event, effects);
    });
    if (duplicate) return { status: 'duplicate' };

    this.publish(event, effects);
    if (!effects.known) {
      this.logger.warn({
        message: 'Ignoring an engine event of an unknown type',
        eventType: event.type,
        tenantId: event.tenantId,
      });
      return { status: 'ignored' };
    }
    return { status: 'processed' };
  }

  // -------------------------------------------------------------------------------------------

  private async handle(tx: Tx, event: EngineEventEnvelope, effects: Effects) {
    const { tenantId, data } = event;
    switch (event.type) {
      case 'conversation.created':
        return;

      case 'conversation.escalated': {
        const conversationId = requireString(data, 'conversationId');
        const reason = optionalString(data, 'reason') ?? 'other';
        const who = await this.customerOf(
          tx,
          tenantId,
          conversationId,
          optionalString(data, 'endCustomerId'),
        );
        const recipients = await this.notifications.activeStaffIds(
          tenantId,
          undefined,
          tx,
        );
        effects.notified.push(
          ...(await this.notifications.create(
            tenantId,
            recipients,
            {
              type: NotificationType.CONVERSATION_ESCALATED,
              params: {
                conversationId,
                customer: who.label,
                channel: who.channel,
                reason,
              },
              link: `/conversations/${conversationId}`,
            },
            tx,
          )),
        );
        // The engine now knows about the escalation the gateway could not deliver (known issue 12).
        await tx.gatewayConversation.updateMany({
          where: { tenantId, conversationId, escalationPending: true },
          data: { escalationPending: false },
        });
        effects.staff.push({
          event: StaffEvent.CONVERSATION_ESCALATED,
          data: { conversationId, reason },
        });
        effects.widget.push(this.status(event, conversationId, 'escalated'));
        return;
      }

      case 'conversation.assigned': {
        const conversationId = requireString(data, 'conversationId');
        const assignedUserId = requireString(data, 'assignedUserId');
        const assignedBy = optionalString(data, 'assignedByUserId');
        // Taking a conversation yourself is not news to you; being given one is.
        if (assignedBy !== assignedUserId) {
          const assignee = await this.notifications.activeStaffIds(
            tenantId,
            undefined,
            tx,
          );
          if (assignee.includes(assignedUserId)) {
            const who = await this.customerOf(tx, tenantId, conversationId);
            effects.notified.push(
              ...(await this.notifications.create(
                tenantId,
                [assignedUserId],
                {
                  type: NotificationType.CONVERSATION_ASSIGNED,
                  params: {
                    conversationId,
                    customer: who.label,
                    channel: who.channel,
                  },
                  link: `/conversations/${conversationId}`,
                },
                tx,
              )),
            );
          }
        }
        effects.staff.push({
          event: StaffEvent.CONVERSATION_ASSIGNED,
          data: { conversationId, assignedUserId },
        });
        effects.widget.push(this.status(event, conversationId, 'human_active'));
        return;
      }

      case 'conversation.released': {
        const conversationId = requireString(data, 'conversationId');
        const to =
          optionalString(data, 'to') === 'escalated' ? 'escalated' : 'active';
        effects.staff.push({
          event: StaffEvent.CONVERSATION_RELEASED,
          data: { conversationId, to },
        });
        effects.widget.push(this.status(event, conversationId, to));
        return;
      }

      case 'conversation.resolved': {
        const conversationId = requireString(data, 'conversationId');
        effects.staff.push({
          event: StaffEvent.CONVERSATION_RESOLVED,
          data: { conversationId },
        });
        effects.widget.push(this.status(event, conversationId, 'resolved'));
        return;
      }

      case 'message.created': {
        const conversationId = requireString(data, 'conversationId');
        const messageId = requireString(data, 'messageId');
        const authorType = requireString(data, 'authorType');
        effects.staff.push({
          event: StaffEvent.MESSAGE_CREATED,
          data: { conversationId, messageId, authorType },
          dedupeKey: `message:${messageId}`,
        });
        // The customer sees what staff wrote and the system lines, nothing else (their own and
        // the AI's messages reach the widget through the reply stream). The staff member's
        // identity never goes to the widget.
        const content = optionalString(data, 'content') ?? '';
        const contentKey = optionalString(data, 'contentKey') ?? null;
        if (
          (authorType === 'human' && content) ||
          (authorType === 'system' && contentKey)
        ) {
          effects.widget.push({
            conversationId,
            event: WidgetEvent.MESSAGE,
            data: {
              id: messageId,
              authorType,
              content: authorType === 'system' ? '' : content,
              contentKey,
              createdAt: optionalString(data, 'createdAt') ?? event.occurredAt,
            },
            dedupeKey: `message:${messageId}`,
          });
        }
        return;
      }

      case 'usage.recorded': {
        await this.usage.recordMessage(
          tenantId,
          {
            messageId: requireString(data, 'messageId'),
            tokensIn: optionalNumber(data, 'tokensIn'),
            tokensOut: optionalNumber(data, 'tokensOut'),
          },
          tx,
        );
        return;
      }

      case 'action.proposed': {
        const actionId = requireString(data, 'actionId');
        const conversationId = optionalString(data, 'conversationId');
        const recipients = await this.notifications.activeStaffIds(
          tenantId,
          ['owner', 'admin'],
          tx,
        );
        const who = conversationId
          ? await this.customerOf(tx, tenantId, conversationId)
          : null;
        effects.notified.push(
          ...(await this.notifications.create(
            tenantId,
            recipients,
            {
              type: NotificationType.ACTION_PROPOSED,
              params: {
                actionId,
                action: optionalString(data, 'action') ?? 'action',
                ...(conversationId && { conversationId }),
                ...(who && { customer: who.label }),
              },
              link: conversationId ? `/conversations/${conversationId}` : null,
            },
            tx,
          )),
        );
        effects.staff.push({
          event: StaffEvent.ACTION_PROPOSED,
          data: { actionId, ...(conversationId && { conversationId }) },
        });
        return;
      }

      // A request was saved or changed (Phase 5B-2). The request ITSELF arrives through the internal
      // routes (the source of truth: they carry the details and answer `locked` / `reference_taken`);
      // the event only carries ids and the reference. So it never creates or changes a request: it looks
      // the request up under the envelope's tenant and makes sure the team has been told (notification
      // and live update are once-only through their dedupe keys, so the route and the event never
      // double up). An event for a request this backend does not have is processed without effect.
      case 'record.submitted': {
        const request = await this.requestOf(tx, tenantId, data);
        if (!request) return;
        const recipients = await this.notifications.activeStaffIds(
          tenantId,
          undefined,
          tx,
        );
        effects.notified.push(
          ...(await this.notifications.create(
            tenantId,
            recipients,
            requestSubmittedNotification({
              id: request.id,
              reference: request.reference,
              type: request.type,
              agentId: request.agentId,
              agentName: request.agent.name,
            }),
            tx,
          )),
        );
        effects.staff.push({
          event: StaffEvent.REQUEST_CREATED,
          data: {
            requestId: request.id,
            status: request.status,
            agentId: request.agentId,
          },
          dedupeKey: createdKey(request.id),
        });
        return;
      }

      case 'record.updated': {
        const request = await this.requestOf(tx, tenantId, data);
        if (!request) return;
        effects.staff.push({
          event: StaffEvent.REQUEST_UPDATED,
          data: { requestId: request.id, status: request.status },
          dedupeKey: updatedKey(request.id, request.updatedAt),
        });
        return;
      }

      default:
        effects.known = false;
    }
  }

  /**
   * The request an event is about: by the backend's id (`recordId`, which the engine got from the
   * create call) or else by the reference, ALWAYS under the envelope's tenant. Nothing else about the
   * request is read (no details, no customer).
   */
  private async requestOf(
    tx: Tx,
    tenantId: string,
    data: Record<string, unknown>,
  ) {
    const recordId = optionalString(data, 'recordId');
    const reference = optionalString(data, 'reference');
    if (!recordId && !reference) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'data.recordId or data.reference is required',
      );
    }
    const request = await tx.customerRequest.findFirst({
      where: {
        tenantId,
        ...(recordId
          ? { id: recordId }
          : { reference: reference?.toUpperCase() }),
      },
      select: {
        id: true,
        reference: true,
        type: true,
        status: true,
        agentId: true,
        updatedAt: true,
        agent: { select: { name: true } },
      },
    });
    if (!request) {
      // Type and tenant only (the reference is what the caller was told; keep it out of the log).
      this.logger.warn({
        message: 'Engine event about a request this backend does not have',
        tenantId,
      });
    }
    return request;
  }

  private status(
    event: EngineEventEnvelope,
    conversationId: string,
    status: string,
  ): Effects['widget'][number] {
    return {
      conversationId,
      event: WidgetEvent.STATUS,
      data: { status },
      dedupeKey: `status:${event.id}`,
    };
  }

  /**
   * Who the conversation is with, for the text of a notification. The customer comes from the
   * gateway's own record of the conversation (tenant-scoped); an `endCustomerId` in the event is
   * only used if it is a customer of THIS tenant. Falls back to a short conversation id.
   */
  private async customerOf(
    tx: Tx,
    tenantId: string,
    conversationId: string,
    endCustomerId?: string,
  ): Promise<{ label: string; channel: string }> {
    const gateway = await tx.gatewayConversation.findFirst({
      where: { tenantId, conversationId },
      select: { endCustomerId: true, channel: true },
    });
    const customerId = gateway?.endCustomerId ?? endCustomerId;
    const customer = customerId
      ? await tx.endCustomer.findFirst({
          where: { id: customerId, tenantId },
          select: { name: true, externalId: true },
        })
      : null;
    return {
      label: customer
        ? customerLabel(customer)
        : `#${conversationId.slice(0, 8)}`,
      channel: gateway?.channel ?? 'widget',
    };
  }

  private publish(event: EngineEventEnvelope, effects: Effects) {
    for (const item of effects.staff) {
      this.hub.publish(staffChannel(event.tenantId), item.event, item.data, {
        dedupeKey: item.dedupeKey,
      });
    }
    for (const item of effects.widget) {
      this.hub.publish(
        widgetChannel(event.tenantId, item.conversationId),
        item.event,
        item.data,
        { dedupeKey: item.dedupeKey },
      );
    }
    this.notifications.announce(event.tenantId, effects.notified);
  }
}

function requireString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VALIDATION_ERROR,
      `data.${key} is required`,
    );
  }
  return value;
}

function optionalString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 && value.length <= 4000
    ? value
    : undefined;
}

function optionalNumber(
  data: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
