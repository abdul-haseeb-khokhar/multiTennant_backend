import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { phoneOfExternalId } from '../end-customers/phone-customers.service';
import { NotificationType } from '../notifications/notification-types';
import type { NewNotification } from '../notifications/notifications.service';
import { StaffEvent } from '../realtime/realtime.constants';
import { RealtimeHub, staffChannel } from '../realtime/realtime.hub';
import { ServiceRequest } from './entities/service-request.entity';
import { RequestStatus, allowedMoves } from './state-machine';

/** What the list shows: everything but `details` (the engine's document, up to 16 KB of personal data). */
export const REQUEST_LIST_SELECT = {
  id: true,
  reference: true,
  type: true,
  status: true,
  channel: true,
  language: true,
  summary: true,
  scheduledLocal: true,
  timezone: true,
  configVersion: true,
  conversationId: true,
  note: true,
  cancelledBy: true,
  statusChangedAt: true,
  statusChangedBy: true,
  createdAt: true,
  updatedAt: true,
  agent: { select: { id: true, name: true } },
  customer: {
    select: { id: true, name: true, externalId: true, locale: true },
  },
} satisfies Prisma.CustomerRequestSelect;

export const REQUEST_DETAIL_SELECT = {
  ...REQUEST_LIST_SELECT,
  details: true,
} satisfies Prisma.CustomerRequestSelect;

export type RequestListRow = Prisma.CustomerRequestGetPayload<{
  select: typeof REQUEST_LIST_SELECT;
}>;
export type RequestDetailRow = Prisma.CustomerRequestGetPayload<{
  select: typeof REQUEST_DETAIL_SELECT;
}>;

/** A row as the staff API shows it. `details` appears only when the row was read with it. */
export function toRequestView(
  row: RequestListRow | RequestDetailRow,
): ServiceRequest {
  const { customer, agent, details, ...rest } = row as RequestDetailRow;
  return {
    ...rest,
    allowedStatuses: [...allowedMoves('staff', row.status as RequestStatus)],
    agent: { id: agent.id, name: agent.name },
    customer: customer
      ? {
          id: customer.id,
          name: customer.name,
          phone: phoneOfExternalId(customer.externalId),
          locale: customer.locale,
        }
      : null,
    ...(details !== undefined && {
      details: details as Record<string, unknown>,
    }),
  };
}

/**
 * The notification every active staff member gets for a new request. Ids, the reference the caller
 * was given, the type and the agent's name: NO customer name, number or details (they stay on the
 * request itself). One per request through the dedupe key, however often it is asked for (the route
 * and the `record.submitted` event both do).
 */
export function requestSubmittedNotification(row: {
  id: string;
  reference: string;
  type: string;
  agentId: string;
  agentName: string;
}): NewNotification {
  return {
    type: NotificationType.REQUEST_SUBMITTED,
    params: {
      requestId: row.id,
      reference: row.reference,
      requestType: row.type,
      agentId: row.agentId,
      agentName: row.agentName,
    },
    link: `/requests/${row.id}`,
    dedupeKey: `request:${row.id}:submitted`,
  };
}

/**
 * Tells the open dashboard streams that a request appeared or changed (ids and the status only: the
 * UI refetches; never the caller's details). Call it AFTER the transaction committed. The dedupe keys
 * make the live message once-only however many paths report the same thing (the internal route and
 * the engine's event).
 */
@Injectable()
export class RequestsLive {
  constructor(private readonly hub: RealtimeHub) {}

  created(
    tenantId: string,
    row: { id: string; status: string; agentId: string },
  ) {
    this.hub.publish(
      staffChannel(tenantId),
      StaffEvent.REQUEST_CREATED,
      { requestId: row.id, status: row.status, agentId: row.agentId },
      { dedupeKey: createdKey(row.id) },
    );
  }

  updated(
    tenantId: string,
    row: { id: string; status: string; updatedAt: Date },
  ) {
    this.hub.publish(
      staffChannel(tenantId),
      StaffEvent.REQUEST_UPDATED,
      { requestId: row.id, status: row.status },
      { dedupeKey: updatedKey(row.id, row.updatedAt) },
    );
  }
}

export const createdKey = (id: string) => `request:${id}:created`;
export const updatedKey = (id: string, updatedAt: Date) =>
  `request:${id}:updated:${updatedAt.getTime()}`;
