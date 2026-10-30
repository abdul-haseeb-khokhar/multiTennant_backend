import { Injectable } from '@nestjs/common';
import { RateLimitedException } from '../common/errors/rate-limited.exception';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { SlugService } from '../slugs/slug.service';

/** Requests per IP per minute: enough for typing a slug with a short debounce, not for walking the namespace. */
export const SLUG_CHECKS_PER_MINUTE = 30;

/**
 * The public "is this workspace address free?" check (J2, J3), used while typing at signup. It
 * answers a yes or no and up to three free alternatives, and nothing about who holds a taken slug
 * (a tenant, or a tenant that gave it up less than 90 days ago, look the same). Limited per IP.
 */
@Injectable()
export class SlugAvailabilityService {
  constructor(
    private readonly slugs: SlugService,
    private readonly limiter: RateLimiter,
  ) {}

  async check(slug: string, ip: string) {
    const limit = this.limiter.hit(
      `slug-available:${ip}`,
      SLUG_CHECKS_PER_MINUTE,
      60_000,
    );
    if (!limit.allowed) {
      throw new RateLimitedException(limit.retryAfterSeconds);
    }
    const available = await this.slugs.isAvailable(slug);
    return {
      available,
      suggestions: available ? [] : await this.slugs.suggest(slug),
    };
  }
}
