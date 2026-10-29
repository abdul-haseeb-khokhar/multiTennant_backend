import { RateLimitedException } from '../common/errors/rate-limited.exception';
import { RateLimiter } from '../common/throttle/rate-limiter';

const WINDOW_MS = 60_000;

/**
 * Counts one call of an internal route (the ones the engine calls) against `key` and throws the
 * usual 429 with `Retry-After` beyond `limitPerMinute`. The key names the route and the tenant
 * (`status:<tenantId>`), never a phone number or anything else personal.
 */
export function enforceInternalLimit(
  limiter: RateLimiter,
  key: string,
  limitPerMinute: number,
): void {
  const result = limiter.hit(key, limitPerMinute, WINDOW_MS);
  if (!result.allowed) throw new RateLimitedException(result.retryAfterSeconds);
}
