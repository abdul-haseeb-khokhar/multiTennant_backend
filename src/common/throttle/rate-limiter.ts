import { Injectable } from '@nestjs/common';

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter kept in process memory. Good enough for one instance (the case until
 * Phase 8); with several instances every instance counts on its own, so move this behind Redis
 * then. Keys are never logged because they can contain an email address.
 */
const MAX_KEYS = 50_000;

@Injectable()
export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  /** Counts one attempt on `key` and says whether it is within `limit` per `windowMs`. */
  hit(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    this.prune(now);
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return {
      allowed: window.count <= limit,
      retryAfterSeconds: Math.max(Math.ceil((window.resetAt - now) / 1000), 1),
    };
  }

  /**
   * Whether `key` may still act: fewer than `limit` hits so far in its current window. Counts
   * nothing, so a caller can look first and only count what really failed (login throttling).
   * `retryAfterSeconds` is the time until the window ends.
   */
  peek(key: string, limit: number): RateLimitResult {
    const now = Date.now();
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: window.count < limit,
      retryAfterSeconds: Math.max(Math.ceil((window.resetAt - now) / 1000), 1),
    };
  }

  /** Forgets the counter of `key` (a successful login clears the failures counted against it). */
  reset(key: string) {
    this.windows.delete(key);
  }

  private prune(now: number) {
    // Bound on memory: sweep expired windows once the map is large, and if an attack with many
    // distinct keys still leaves it full, drop the oldest entries (insertion order) so the map
    // can never grow without limit.
    if (this.windows.size < 10_000) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size < MAX_KEYS) break;
      this.windows.delete(key);
    }
  }
}
