import { RateLimitedException } from '../common/errors/rate-limited.exception';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { WidgetRateLimitService } from './widget-rate-limit.service';
import { DEFAULT_WIDGET_LIMITS } from './widget.constants';

describe('WidgetRateLimitService (F6)', () => {
  const service = (over = {}) =>
    new WidgetRateLimitService(new RateLimiter(), {
      ...DEFAULT_WIDGET_LIMITS,
      ...over,
    });

  it('lets calls through up to the limit and then answers 429 with Retry-After', () => {
    const limits = service();
    const check = () =>
      limits.enforce([{ scope: 'message-ip', id: '1.2.3.4', limit: 3 }]);
    check();
    check();
    check();
    try {
      check();
      throw new Error('expected a 429');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitedException);
      expect((error as RateLimitedException).getStatus()).toBe(429);
      expect((error as RateLimitedException).retryAfterSeconds).toBeGreaterThan(
        0,
      );
    }
  });

  it('counts per scope and per id: one visitor, key or IP does not use up another', () => {
    const limits = service();
    const hit = (scope: string, id: string) =>
      limits.enforce([{ scope, id, limit: 1 }]);
    hit('message-ip', 'a');
    hit('message-ip', 'b');
    hit('message-visitor', 'a');
    expect(() => hit('message-ip', 'a')).toThrow(RateLimitedException);
  });

  it('refuses when any one of several limits is exceeded', () => {
    const limits = service();
    const run = () =>
      limits.enforce([
        { scope: 'ip', id: 'x', limit: 100 },
        { scope: 'key', id: 'k', limit: 2 },
        { scope: 'visitor', id: 'v', limit: 100 },
      ]);
    run();
    run();
    expect(run).toThrow(RateLimitedException);
  });

  it('keeps counting the other windows of a blocked caller', () => {
    const limiter = new RateLimiter();
    const limits = new WidgetRateLimitService(limiter, DEFAULT_WIDGET_LIMITS);
    const spy = jest.spyOn(limiter, 'hit');
    expect(() =>
      limits.enforce([
        { scope: 'a', id: '1', limit: 0 },
        { scope: 'b', id: '1', limit: 5 },
      ]),
    ).toThrow(RateLimitedException);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('allows preflights up to its own limit without throwing', () => {
    const limits = service({ preflightPerIp: 2 });
    expect(limits.preflightAllowed('ip')).toBe(true);
    expect(limits.preflightAllowed('ip')).toBe(true);
    expect(limits.preflightAllowed('ip')).toBe(false);
    expect(limits.preflightAllowed('other')).toBe(true);
  });
});
