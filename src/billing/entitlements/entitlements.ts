/**
 * What a plan allows (`plans.entitlements`, merged with `subscriptions.entitlements_override`).
 *
 *   {
 *     "seats": 3,                         // active users + pending invites; null = unlimited
 *     "conversationsPerPeriod": 100,      // AI conversations; null = unlimited
 *     "conversationPeriod": "total",      // "total" = since the subscription period began, "month" = calendar month
 *     "knowledgeMb": 20,                  // knowledge base size in MB; null = unlimited
 *     "channels": ["chat", "whatsapp"],   // channels the tenant may connect
 *     "voice": false,                     // phone calls (the Pro add-on is granted through an override)
 *     "poweredByLabel": true,             // the widget shows our label
 *     "overageConversationMinor": 1500,   // optional price hint: extra conversation, minor units
 *     "voicePerMinuteMinor": 2500         // optional price hint: voice minute, minor units
 *   }
 *
 * A key missing from the JSON is treated as the most restrictive value (0 / false / none), so a
 * malformed plan row can never grant more than intended. `null` is the only way to say "unlimited".
 */
export type ConversationPeriod = 'total' | 'month';

export interface Entitlements {
  seats: number | null;
  conversationsPerPeriod: number | null;
  conversationPeriod: ConversationPeriod;
  knowledgeMb: number | null;
  channels: string[];
  voice: boolean;
  poweredByLabel: boolean;
  overageConversationMinor?: number;
  voicePerMinuteMinor?: number;
}

/** Numeric limits that `EntitlementsService.check` compares usage against. */
export const LIMIT_KEYS = ['seats', 'conversations', 'knowledgeMb'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** Keys `check` accepts: a limit, `voice`, or `channel:<name>` (for example `channel:whatsapp`). */
export type EntitlementKey = LimitKey | 'voice' | `channel:${string}`;

const LIMIT_FIELD: Record<
  LimitKey,
  'seats' | 'conversationsPerPeriod' | 'knowledgeMb'
> = {
  seats: 'seats',
  conversations: 'conversationsPerPeriod',
  knowledgeMb: 'knowledgeMb',
};

export function limitFor(entitlements: Entitlements, key: LimitKey) {
  return entitlements[LIMIT_FIELD[key]];
}

function limit(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

/** Reads a JSON value from the database into a well-formed `Entitlements`, restrictive on anything unexpected. */
export function parseEntitlements(json: unknown): Entitlements {
  const raw =
    json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  const entitlements: Entitlements = {
    seats: limit(raw.seats),
    conversationsPerPeriod: limit(raw.conversationsPerPeriod),
    conversationPeriod: raw.conversationPeriod === 'total' ? 'total' : 'month',
    knowledgeMb: limit(raw.knowledgeMb),
    channels: Array.isArray(raw.channels)
      ? raw.channels.filter((c): c is string => typeof c === 'string')
      : [],
    voice: raw.voice === true,
    poweredByLabel: raw.poweredByLabel !== false,
  };
  if (typeof raw.overageConversationMinor === 'number') {
    entitlements.overageConversationMinor = raw.overageConversationMinor;
  }
  if (typeof raw.voicePerMinuteMinor === 'number') {
    entitlements.voicePerMinuteMinor = raw.voicePerMinuteMinor;
  }
  return entitlements;
}

/** The override replaces the plan's value key by key; keys it does not mention keep the plan's value. */
export function mergeEntitlements(
  planEntitlements: unknown,
  override: unknown,
): Entitlements {
  const base =
    planEntitlements &&
    typeof planEntitlements === 'object' &&
    !Array.isArray(planEntitlements)
      ? (planEntitlements as Record<string, unknown>)
      : {};
  const extra =
    override && typeof override === 'object' && !Array.isArray(override)
      ? (override as Record<string, unknown>)
      : {};
  return parseEntitlements({ ...base, ...extra });
}

const OVERRIDE_KEYS = new Set([
  'seats',
  'conversationsPerPeriod',
  'conversationPeriod',
  'knowledgeMb',
  'channels',
  'voice',
  'poweredByLabel',
  'overageConversationMinor',
  'voicePerMinuteMinor',
]);

/**
 * Validates an override sent by a platform admin. Returns the cleaned object, or the first
 * problem as a message. Unknown keys are rejected rather than stored.
 */
export function validateOverride(
  value: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'entitlementsOverride must be an object' };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!OVERRIDE_KEYS.has(key)) {
      return { ok: false, error: `Unknown entitlement "${key}"` };
    }
    const numeric = ['seats', 'conversationsPerPeriod', 'knowledgeMb'].includes(
      key,
    );
    if (numeric) {
      if (item !== null && !(Number.isInteger(item) && (item as number) >= 0)) {
        return {
          ok: false,
          error: `${key} must be a non-negative integer or null`,
        };
      }
    } else if (key === 'conversationPeriod') {
      if (item !== 'total' && item !== 'month') {
        return {
          ok: false,
          error: 'conversationPeriod must be total or month',
        };
      }
    } else if (key === 'channels') {
      if (!Array.isArray(item) || !item.every((c) => typeof c === 'string')) {
        return { ok: false, error: 'channels must be an array of strings' };
      }
    } else if (key === 'voice' || key === 'poweredByLabel') {
      if (typeof item !== 'boolean') {
        return { ok: false, error: `${key} must be a boolean` };
      }
    } else if (!(Number.isInteger(item) && (item as number) >= 0)) {
      return { ok: false, error: `${key} must be a non-negative integer` };
    }
    out[key] = item;
  }
  return { ok: true, value: out };
}
