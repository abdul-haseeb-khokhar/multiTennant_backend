import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-engine-signature';
export const TIMESTAMP_HEADER = 'x-engine-timestamp';
/** A request older (or newer) than this is refused, so a captured request cannot be replayed later. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** `sha256=<hex>` of HMAC-SHA256(secret, "<timestamp>.<raw body>"): what the engine sends and the backend checks. */
export function signEngineEvent(
  secret: string,
  timestamp: string,
  rawBody: Buffer | string,
): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
  return `sha256=${mac}`;
}

export type SignatureCheck = 'ok' | 'missing' | 'stale' | 'invalid';

/**
 * Checks the signature headers of an event delivery against the exact bytes received. Compares in
 * constant time. The secret is the shared `INTERNAL_API_TOKEN`; it is never sent over the wire.
 */
export function checkEngineSignature(
  secret: string,
  headers: { timestamp?: string; signature?: string },
  rawBody: Buffer | undefined,
  nowMs: number,
): SignatureCheck {
  const { timestamp, signature } = headers;
  if (!timestamp || !signature || !rawBody) return 'missing';
  if (!/^\d{1,12}$/.test(timestamp)) return 'invalid';
  if (
    Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS
  ) {
    return 'stale';
  }
  const expected = Buffer.from(signEngineEvent(secret, timestamp, rawBody));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return 'invalid';
  return timingSafeEqual(expected, actual) ? 'ok' : 'invalid';
}
