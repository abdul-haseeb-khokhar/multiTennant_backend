import { RateLimiter } from '../common/throttle/rate-limiter';
import { LOGIN_LIMITS, LoginThrottleService } from './login-throttle.service';

describe('LoginThrottleService', () => {
  let service: LoginThrottleService;
  let now: number;

  beforeEach(() => {
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    service = new LoginThrottleService(new RateLimiter());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const fail = (ip: string, email: string, times: number) => {
    for (let i = 0; i < times; i++) {
      service.assertAllowed(ip, email);
      service.recordFailure(ip, email);
    }
  };
  const blocked = (ip: string, email: string) => {
    try {
      service.assertAllowed(ip, email);
      return null;
    } catch (error) {
      return error as { status: number; retryAfterSeconds: number };
    }
  };
  const minutes = (n: number) => n * 60_000;

  it('the documented numbers', () => {
    expect(LOGIN_LIMITS).toEqual({
      attemptsPerIp: { limit: 60, windowMs: 60_000 },
      failuresPerEmailAndIp: { limit: 5, windowMs: 900_000 },
      failuresPerIp: { limit: 30, windowMs: 900_000 },
    });
  });

  describe('failures of one email from one address', () => {
    it('allows five wrong passwords, then answers 429 with the seconds until it ends, before any password is compared', () => {
      fail('1.1.1.1', 'victim@acme.com', 5);
      const error = blocked('1.1.1.1', 'victim@acme.com');
      expect(error).toMatchObject({ status: 429 });
      expect(error!.retryAfterSeconds).toBe(900);

      now += minutes(5);
      expect(blocked('1.1.1.1', 'victim@acme.com')!.retryAfterSeconds).toBe(
        600,
      );
    });

    it('the block ends by itself after the 15-minute window (no lock-out for good)', () => {
      fail('1.1.1.1', 'victim@acme.com', 5);
      expect(blocked('1.1.1.1', 'victim@acme.com')).not.toBeNull();
      now += minutes(15) + 1;
      expect(blocked('1.1.1.1', 'victim@acme.com')).toBeNull();
    });

    it('does not block the same email from ANOTHER address: an attacker cannot lock the victim out', () => {
      fail('6.6.6.6', 'victim@acme.com', 5);
      expect(blocked('6.6.6.6', 'victim@acme.com')).not.toBeNull();
      expect(blocked('203.0.113.9', 'victim@acme.com')).toBeNull();
    });

    it('does not block another email from the same address (below the per-address ceiling)', () => {
      fail('1.1.1.1', 'a@acme.com', 5);
      expect(blocked('1.1.1.1', 'b@acme.com')).toBeNull();
    });

    it('treats the email case-insensitively', () => {
      fail('1.1.1.1', 'Victim@Acme.com', 5);
      expect(blocked('1.1.1.1', ' victim@acme.COM ')).not.toBeNull();
    });

    it('a correct password clears the failures of that email at that address', () => {
      fail('1.1.1.1', 'victim@acme.com', 4);
      service.recordSuccess('1.1.1.1', 'victim@acme.com');
      fail('1.1.1.1', 'victim@acme.com', 4);
      expect(blocked('1.1.1.1', 'victim@acme.com')).toBeNull();
    });
  });

  describe('failures from one address, any email (a higher ceiling)', () => {
    it('blocks the address after 30 wrong passwords across different emails', () => {
      for (let i = 0; i < 30; i++) {
        fail('1.1.1.1', `user${i}@acme.com`, 1);
      }
      const error = blocked('1.1.1.1', 'fresh@acme.com');
      expect(error).toMatchObject({ status: 429 });
      expect(blocked('2.2.2.2', 'fresh@acme.com')).toBeNull();
    });

    it('29 failures are still fine; a success does not clear the address total', () => {
      for (let i = 0; i < 29; i++) fail('1.1.1.1', `user${i}@acme.com`, 1);
      service.recordSuccess('1.1.1.1', 'user0@acme.com');
      expect(blocked('1.1.1.1', 'fresh@acme.com')).toBeNull();
      fail('1.1.1.1', 'one-more@acme.com', 1);
      expect(blocked('1.1.1.1', 'fresh@acme.com')).not.toBeNull();
    });
  });

  describe('attempts from one address, whatever the outcome (protects the CPU)', () => {
    it('allows 60 requests a minute, then 429; the next minute starts fresh', () => {
      for (let i = 0; i < 60; i++)
        service.assertAllowed('1.1.1.1', `e${i}@x.io`);
      expect(blocked('1.1.1.1', 'e61@x.io')).toMatchObject({ status: 429 });
      expect(blocked('2.2.2.2', 'e61@x.io')).toBeNull();
      now += 61_000;
      expect(blocked('1.1.1.1', 'e61@x.io')).toBeNull();
    });

    it('successful logins count as attempts but never as failures', () => {
      for (let i = 0; i < 40; i++) {
        service.assertAllowed('1.1.1.1', 'busy@acme.com');
        service.recordSuccess('1.1.1.1', 'busy@acme.com');
      }
      expect(blocked('1.1.1.1', 'busy@acme.com')).toBeNull();
    });
  });

  it('knows nothing about accounts: the decision depends on the address and the typed email only', () => {
    // The same sequence of failures blocks an email that exists and one that does not, identically.
    fail('1.1.1.1', 'exists@acme.com', 5);
    fail('1.1.1.1', 'does-not-exist@nowhere.io', 5);
    expect(blocked('1.1.1.1', 'exists@acme.com')).not.toBeNull();
    expect(blocked('1.1.1.1', 'does-not-exist@nowhere.io')).not.toBeNull();
  });
});
