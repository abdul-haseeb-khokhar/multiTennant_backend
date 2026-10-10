import { Inject, Injectable } from '@nestjs/common';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { RateLimitedException } from '../common/errors/rate-limited.exception';
import { WIDGET_LIMITS } from './widget.constants';
import type { WidgetLimits } from './widget.constants';

/**
 * The widget's rate limits (F6): per IP, per widget key and per visitor, each its own counter.
 * Counters are per process (see `WidgetLimits`). Keys contain ids and the IP address and are
 * never logged.
 */
@Injectable()
export class WidgetRateLimitService {
  constructor(
    private readonly limiter: RateLimiter,
    @Inject(WIDGET_LIMITS) private readonly limits: WidgetLimits,
  ) {}

  /** Throws 429 (with `Retry-After`) when any of the counters is over its limit. */
  enforce(checks: { scope: string; id: string; limit: number }[]): void {
    let retryAfter = 0;
    for (const check of checks) {
      // Count every check even when an earlier one failed, so a blocked caller keeps burning
      // all its windows instead of probing the others for free.
      const result = this.limiter.hit(
        `widget:${check.scope}:${check.id}`,
        check.limit,
        this.limits.windowMs,
      );
      if (!result.allowed) {
        retryAfter = Math.max(retryAfter, result.retryAfterSeconds);
      }
    }
    if (retryAfter > 0) throw new RateLimitedException(retryAfter);
  }

  /** True when the IP is still within the preflight allowance (no exception: preflights just go unanswered). */
  preflightAllowed(ip: string): boolean {
    return this.limiter.hit(
      `widget:preflight:${ip}`,
      this.limits.preflightPerIp,
      this.limits.windowMs,
    ).allowed;
  }

  get config(): WidgetLimits {
    return this.limits;
  }
}
