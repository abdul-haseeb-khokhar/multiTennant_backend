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

  describe('peek and reset (login throttling)', () => {
    it('peek counts nothing: the limit is reached only by hits', () => {
      const limiter = new RateLimiter();
      for (let i = 0; i < 10; i++) {
        expect(limiter.peek('k', 2).allowed).toBe(true);
      }
      limiter.hit('k', 2, 60_000);
      expect(limiter.peek('k', 2).allowed).toBe(true);
      limiter.hit('k', 2, 60_000);
      expect(limiter.peek('k', 2)).toEqual({
        allowed: false,
        retryAfterSeconds: 60,
      });
    });

    it('peek reports the time left, and allows again when the window has passed', () => {
      const limiter = new RateLimiter();
      limiter.hit('k', 1, 60_000);
      jest.advanceTimersByTime(45_000);
      expect(limiter.peek('k', 1)).toEqual({
        allowed: false,
        retryAfterSeconds: 15,
      });
      jest.advanceTimersByTime(15_001);
      expect(limiter.peek('k', 1)).toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });
    });

    it('an unknown key is allowed', () => {
      expect(new RateLimiter().peek('nobody', 1).allowed).toBe(true);
    });

    it('reset forgets the counter of one key only', () => {
      const limiter = new RateLimiter();
      limiter.hit('a', 1, 60_000);
      limiter.hit('b', 1, 60_000);
      limiter.reset('a');
      expect(limiter.peek('a', 1).allowed).toBe(true);
      expect(limiter.peek('b', 1).allowed).toBe(false);
      limiter.reset('never-seen');
    });
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
