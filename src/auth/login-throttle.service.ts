import { Injectable } from '@nestjs/common';
import { RateLimitedException } from '../common/errors/rate-limited.exception';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { normalizeEmail } from '../common/validation/email';

/**
 * The numbers of login throttling (known issue 1, J2). Exported so the tests and the docs quote
 * the same values.
 */
export const LOGIN_LIMITS = {
  /** Every login request from one IP, whatever its outcome: protects the CPU (a request costs bcrypt hashes). */
  attemptsPerIp: { limit: 60, windowMs: 60_000 },
  /** FAILED logins for one email from one IP. */
  failuresPerEmailAndIp: { limit: 5, windowMs: 15 * 60_000 },
  /** FAILED logins from one IP for any email: a higher ceiling, for guessing across many addresses. */
  failuresPerIp: { limit: 30, windowMs: 15 * 60_000 },
} as const;

/**
 * Throttles `POST /auth/login` and `POST /auth/login-email`, in process memory (per instance until
 * Phase 8 puts the counters in Redis, like every other limiter). Only FAILED passwords are counted
 * against the limits, so heavy legitimate use is never punished, and the window is fixed: after
 * 15 minutes without a new block the counters are gone, so a lock-out always ends by itself.
 *
 * Why it cannot be used to lock someone out for good: the failure counters are keyed by the email
 * AND the IP (an attacker at one address can lock only "this email from this address" and that
 * address), and the only counter without an email is per IP with a higher ceiling. There is NO
 * counter per email alone, so an attacker who is not at the victim's address (or behind it) cannot
 * stop the victim from logging in. The price: a botnet with many addresses can try 5 passwords per
 * address per window; bcrypt makes each try cost the attacker time, and the password policy and a
 * reset by email are the other defences. Behind a reverse proxy set `TRUST_PROXY`, otherwise every
 * client shares the proxy's address and its ceilings.
 *
 * The check happens BEFORE any password is compared, so a blocked request does no bcrypt work, and
 * it depends only on the IP and the submitted email text, never on whether the account exists.
 */
@Injectable()
export class LoginThrottleService {
  constructor(private readonly limiter: RateLimiter) {}

  /** Call first. Counts the attempt for the IP and throws 429 (with Retry-After) when blocked. */
  assertAllowed(ip: string, email: string) {
    const { attemptsPerIp, failuresPerEmailAndIp, failuresPerIp } =
      LOGIN_LIMITS;
    const attempt = this.limiter.hit(
      this.attemptKey(ip),
      attemptsPerIp.limit,
      attemptsPerIp.windowMs,
    );
    if (!attempt.allowed) {
      throw new RateLimitedException(attempt.retryAfterSeconds);
    }
    for (const [key, limit] of [
      [this.pairKey(ip, email), failuresPerEmailAndIp.limit],
      [this.ipKey(ip), failuresPerIp.limit],
    ] as const) {
      const state = this.limiter.peek(key, limit);
      if (!state.allowed) {
        throw new RateLimitedException(state.retryAfterSeconds);
      }
    }
  }

  /** A wrong password (or an unknown account: the caller cannot tell them apart, and neither can this). */
  recordFailure(ip: string, email: string) {
    const { failuresPerEmailAndIp, failuresPerIp } = LOGIN_LIMITS;
    this.limiter.hit(
      this.pairKey(ip, email),
      failuresPerEmailAndIp.limit,
      failuresPerEmailAndIp.windowMs,
    );
    this.limiter.hit(
      this.ipKey(ip),
      failuresPerIp.limit,
      failuresPerIp.windowMs,
    );
  }

  /** A correct password clears the failures of this email at this address (the IP total keeps counting). */
  recordSuccess(ip: string, email: string) {
    this.limiter.reset(this.pairKey(ip, email));
  }

  private attemptKey(ip: string) {
    return `login:attempts:${ip}`;
  }

  private ipKey(ip: string) {
    return `login:failures:ip:${ip}`;
  }

  private pairKey(ip: string, email: string) {
    return `login:failures:pair:${ip}:${normalizeEmail(email)}`;
  }
}
