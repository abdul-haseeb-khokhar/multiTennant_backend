/**
 * In-app notification types (H5). A notification stores no text: the frontend renders the keys
 * `<type>.title` and `<type>.body` of the `notifications` translation namespace (ICU messages) with
 * the notification's `params`, in the reader's language. Keep the params of each type stable: the
 * frontend renders them by name (`{customer}`, `{percent}`, ...).
 *
 * `link` is an app-relative path the notification opens (the frontend prefixes its own origin).
 */
export const NotificationType = {
  CONVERSATION_ESCALATED: 'conversation.escalated',
  CONVERSATION_ASSIGNED: 'conversation.assigned',
  ACTION_PROPOSED: 'action.proposed',
  BILLING_TRIAL_ENDING: 'billing.trial_ending',
  BILLING_PERIOD_ENDING: 'billing.period_ending',
  BILLING_GRACE_STARTED: 'billing.grace_started',
  BILLING_DOWNGRADED: 'billing.downgraded',
  USAGE_THRESHOLD: 'usage.threshold',
  USAGE_LIMIT_REACHED: 'usage.limit_reached',
} as const;
export type NotificationType =
  (typeof NotificationType)[keyof typeof NotificationType];

export interface NotificationTypeInfo {
  /** Who receives it. */
  recipients: string;
  /** The `params` the translations may use, and what they are. */
  params: Record<string, string>;
  link: string | null;
}

/** Documentation of every type; the unit test checks that each has translations in en and ur. */
export const NOTIFICATION_TYPES: Record<
  NotificationType,
  NotificationTypeInfo
> = {
  [NotificationType.CONVERSATION_ESCALATED]: {
    recipients: 'every active staff member',
    params: {
      conversationId: 'id of the conversation',
      customer:
        'the customer name, or a short non-secret label such as "web_ab12cd…" for an anonymous visitor',
      channel: 'widget | whatsapp | voice',
      reason:
        'customer_requested | low_confidence | failed_action | sentiment | topic | outside_hours | ai_unavailable | limit_reached | other',
    },
    link: '/conversations/<conversationId>',
  },
  [NotificationType.CONVERSATION_ASSIGNED]: {
    recipients:
      'the assignee, when somebody else assigned it (a plain claim by yourself sends nothing)',
    params: {
      conversationId: 'id of the conversation',
      customer: 'as in conversation.escalated',
      channel: 'widget | whatsapp | voice',
    },
    link: '/conversations/<conversationId>',
  },
  [NotificationType.ACTION_PROPOSED]: {
    recipients: 'active owners and admins',
    params: {
      actionId: 'id of the proposed action',
      action: 'short action name, for example "refund"',
      conversationId: 'id of the conversation it came from (may be absent)',
      customer: 'as in conversation.escalated (may be absent)',
    },
    link: '/conversations/<conversationId> when known, else null',
  },
  [NotificationType.BILLING_TRIAL_ENDING]: {
    recipients: 'active owners and admins; at 7, 3 and 1 days left',
    params: {
      daysLeft: 'whole days until the trial (Starter) ends',
      endsAt: 'ISO-8601 instant the trial ends',
      threshold: '7 | 3 | 1',
    },
    link: '/billing',
  },
  [NotificationType.BILLING_PERIOD_ENDING]: {
    recipients: 'active owners and admins; at 7, 3 and 1 days left',
    params: {
      daysLeft: 'whole days until the paid period ends',
      endsAt: 'ISO-8601 instant the paid period ends',
      plan: 'plan name',
      cancelAtPeriodEnd: 'true when the plan was cancelled and will not renew',
      threshold: '7 | 3 | 1',
    },
    link: '/billing',
  },
  [NotificationType.BILLING_GRACE_STARTED]: {
    recipients: 'active owners and admins; once per overdue period',
    params: {
      plan: 'plan name',
      graceEndsAt: 'ISO-8601 instant the grace period ends',
      graceDaysLeft: 'whole days of grace left when it started',
    },
    link: '/billing',
  },
  [NotificationType.BILLING_DOWNGRADED]: {
    recipients: 'active owners and admins; once per downgrade',
    params: {
      fromPlan: 'plan name before',
      toPlan: 'plan name now (Free)',
      reason: 'trial_ended | grace_expired | canceled | plan_ended',
    },
    link: '/billing',
  },
  [NotificationType.USAGE_THRESHOLD]: {
    recipients: 'active owners and admins; once per period at 80%',
    params: {
      metric: 'conversations',
      percent: '80',
      used: 'conversations used in the period',
      limit: 'conversations included in the plan',
      period: 'month | total (since the plan period began)',
    },
    link: '/billing',
  },
  [NotificationType.USAGE_LIMIT_REACHED]: {
    recipients: 'active owners and admins; once per period at 100%',
    params: {
      metric: 'conversations',
      percent: '100',
      used: 'conversations used in the period',
      limit: 'conversations included in the plan',
      period: 'month | total',
    },
    link: '/billing',
  },
};

/** Notifications older than this are deleted by the housekeeping job. */
export const NOTIFICATION_RETENTION_DAYS = 90;
