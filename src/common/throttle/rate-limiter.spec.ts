import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-07T10:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('allows up to the limit within the window, then refuses with a retry time', () => {
    const limiter = new RateLimiter();
    expect(limiter.hit('k', 2, 60_000).allowed).toBe(true);
    expect(limiter.hit('k', 2, 60_000).allowed).toBe(true);
    expect(limiter.hit('k', 2, 60_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });

  it('counts keys independently', () => {
    const limiter = new RateLimiter();
    limiter.hit('a', 1, 60_000);
    expect(limiter.hit('a', 1, 60_000).allowed).toBe(false);
    expect(limiter.hit('b', 1, 60_000).allowed).toBe(true);
  });

  it('starts a fresh window once the old one has passed', () => {
    const limiter = new RateLimiter();
    limiter.hit('k', 1, 60_000);
    expect(limiter.hit('k', 1, 60_000).allowed).toBe(false);
    jest.advanceTimersByTime(60_001);
    expect(limiter.hit('k', 1, 60_000).allowed).toBe(true);
  });

  it('reports the remaining time of the window', () => {
    const limiter = new RateLimiter();
    limiter.hit('k', 1, 60_000);
    jest.advanceTimersByTime(45_000);
    expect(limiter.hit('k', 1, 60_000).retryAfterSeconds).toBe(15);
  });

  it('never keeps more than 50,000 keys, even when none has expired', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 60_000; i++) {
      limiter.hit(`k${i}`, 5, 3600_000);
    }
    expect((limiter as any).windows.size).toBeLessThanOrEqual(50_000);
    // the newest keys survive and still count
    expect(limiter.hit('k59999', 1, 3600_000).allowed).toBe(false);
  });
});
