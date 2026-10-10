/** A dashboard stream ticket lives this long and works once. */
export const STREAM_TICKET_TTL_SECONDS = 30;

/** Open dashboard streams one staff member may have at the same time (the oldest is closed beyond it). */
export const STAFF_STREAMS_PER_USER = 5;

/** Open widget streams one conversation may have (a few tabs of the same visitor). */
export const WIDGET_STREAMS_PER_CONVERSATION = 3;

/**
 * A dashboard stream is closed after this long so the user's standing is checked from scratch; the
 * client reconnects with `Last-Event-ID` (and a fresh ticket if it uses tickets).
 */
export const STAFF_STREAM_MAX_AGE_MS = 60 * 60_000;

/** How often an open dashboard stream re-checks that its user is still active (disabled users are cut off). */
export const STAFF_STREAM_CHECK_MS = 60_000;

/** Ticket requests per user and minute (in process memory). */
export const TICKET_REQUESTS_PER_MINUTE = 30;

/** Dashboard event names (the ids in the payload let the UI refetch). */
export const StaffEvent = {
  CONVERSATION_ESCALATED: 'conversation.escalated',
  CONVERSATION_ASSIGNED: 'conversation.assigned',
  CONVERSATION_RELEASED: 'conversation.released',
  CONVERSATION_RESOLVED: 'conversation.resolved',
  MESSAGE_CREATED: 'message.created',
  NOTIFICATION_CREATED: 'notification.created',
  ACTION_PROPOSED: 'action.proposed',
} as const;

/** Widget event names. */
export const WidgetEvent = {
  /** A staff reply or a system line (`agent.joined`), as it appears in the history. */
  MESSAGE: 'message',
  /** The conversation changed status: `escalated`, `human_active`, `active`, `resolved`. */
  STATUS: 'status',
} as const;
