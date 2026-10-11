/** Longest customer message, in characters (F6: enforced here and by the engine). */
export const MAX_MESSAGE_LENGTH = 2000;

/** Lifetime of a widget token (D3). The widget refreshes it by calling the session endpoint again. */
export const WIDGET_TOKEN_TTL_SECONDS = 15 * 60;

export const WIDGET_CHANNEL = 'widget';

/** `external_id` of an anonymous widget visitor (B4). */
export const WIDGET_EXTERNAL_ID_PREFIX = 'web_';

/** Request headers a browser may send to the widget routes (also the CORS allow-list). */
export const WIDGET_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'X-Request-Id',
  // A fetch-based reader of GET /v1/widget/events sends it to resume after a reconnect.
  'Last-Event-ID',
];

/**
 * Fixed-window limits, per minute. The counters live in process memory (`RateLimiter`), so with
 * several instances each one counts on its own: the effective limit is multiplied by the number
 * of instances until Phase 8 moves them behind Redis. `ip` is the socket address unless Express
 * `trust proxy` is configured (known issue: behind a proxy every request shares the proxy's IP).
 */
export interface WidgetLimits {
  windowMs: number;
  sessionPerIp: number;
  sessionPerKey: number;
  sessionPerVisitor: number;
  messagePerIp: number;
  messagePerKey: number;
  messagePerVisitor: number;
  readPerIp: number;
  readPerVisitor: number;
  preflightPerIp: number;
}

export const DEFAULT_WIDGET_LIMITS: WidgetLimits = {
  windowMs: 60_000,
  sessionPerIp: 30,
  sessionPerKey: 600,
  sessionPerVisitor: 10,
  messagePerIp: 60,
  messagePerKey: 1200,
  messagePerVisitor: 20,
  readPerIp: 120,
  readPerVisitor: 60,
  preflightPerIp: 120,
};

/** Injection token for the limits, so tests can use small numbers. */
export const WIDGET_LIMITS = 'WIDGET_LIMITS';
