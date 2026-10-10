import { randomBytes } from 'node:crypto';
import { hashToken } from '../common/tokens/tokens';

export const API_KEY_TYPES = ['widget', 'server'] as const;
export type ApiKeyType = (typeof API_KEY_TYPES)[number];

const PREFIXES: Record<ApiKeyType, string> = { widget: 'wk_', server: 'sk_' };
/** Characters of the key kept in clear for display (for example `wk_AbCd1`). */
const DISPLAY_PREFIX_LENGTH = 8;

/**
 * Makes a key: a type prefix plus 24 (widget) or 32 (server) random bytes. Only the sha256 is
 * stored, so the full key exists once, in the response that creates it. A widget key is public by
 * nature (it sits in the page source); it is not a secret and is always checked together with the
 * request Origin.
 */
export function generateApiKey(type: ApiKeyType) {
  const key = `${PREFIXES[type]}${randomBytes(type === 'widget' ? 24 : 32).toString('base64url')}`;
  return {
    key,
    keyHash: hashApiKey(key),
    keyPrefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

export function hashApiKey(key: string) {
  return hashToken(key);
}

/** Cheap shape check so a malformed value never reaches the database. */
export function looksLikeWidgetKey(value: unknown): value is string {
  return typeof value === 'string' && /^wk_[A-Za-z0-9_-]{20,64}$/.test(value);
}
