import { ConfigService } from '@nestjs/config';
import { BillingScheduler } from './billing.scheduler';

describe('BillingScheduler', () => {
  const make = (env: Record<string, unknown>) => {
    const subscriptions = {
      processDueTransitions: jest
        .fn()
        .mockResolvedValue({ processed: 0, skipped: false }),
    };
    const reminders = { generate: jest.fn().mockResolvedValue({ created: 0 }) };
    const housekeeping = { purge: jest.fn().mockResolvedValue({}) };
    const clock = { now: () => new Date('2026-10-10T00:00:00.000Z') };
    const scheduler = new BillingScheduler(
      { get: (key: string) => env[key] } as unknown as ConfigService,
      subscriptions as never,
      reminders as never,
      housekeeping as never,
      clock as never,
    );
    return { scheduler, subscriptions, reminders, housekeeping };
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does not start a timer in tests or when switched off', () => {
    for (const env of [{ NODE_ENV: 'test' }, { BILLING_JOB: 'off' }]) {
      const { scheduler, subscriptions } = make(env);
      scheduler.onApplicationBootstrap();
      jest.advanceTimersByTime(48 * 3600 * 1000);
      expect(subscriptions.processDueTransitions).not.toHaveBeenCalled();
      scheduler.onModuleDestroy();
    }
  });

  it('sweeps shortly after boot and then on the configured interval', async () => {
    const { scheduler, subscriptions } = make({
      NODE_ENV: 'production',
      BILLING_JOB: 'on',
      BILLING_JOB_INTERVAL_MINUTES: 60,
    });
    scheduler.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(31_000);
    expect(subscriptions.processDueTransitions).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(subscriptions.processDueTransitions).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5 * 60 * 60_000);
    expect(subscriptions.processDueTransitions).toHaveBeenCalledTimes(2);
  });

  it('a failing sweep is logged, never thrown, and the next tick still runs', async () => {
    const { scheduler, subscriptions } = make({ NODE_ENV: 'production' });
    subscriptions.processDueTransitions.mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(scheduler.run()).resolves.toBeUndefined();
    await scheduler.run();
    expect(subscriptions.processDueTransitions).toHaveBeenCalledTimes(2);
  });

  it('after the transitions it creates the reminders and purges, each step failing alone', async () => {
    const { scheduler, subscriptions, reminders, housekeeping } = make({
      NODE_ENV: 'production',
    });
    subscriptions.processDueTransitions.mockRejectedValueOnce(
      new Error('db down'),
    );
    reminders.generate.mockRejectedValueOnce(new Error('reminders down'));
    await expect(scheduler.run()).resolves.toBeUndefined();
    expect(reminders.generate).toHaveBeenCalledTimes(1);
    expect(housekeeping.purge).toHaveBeenCalledWith(
      new Date('2026-10-10T00:00:00.000Z'),
    );
    await scheduler.run();
    expect(reminders.generate).toHaveBeenCalledTimes(2);
    expect(housekeeping.purge).toHaveBeenCalledTimes(2);
  });

  it('does not start a second sweep while one is still running', async () => {
    const { scheduler, subscriptions } = make({ NODE_ENV: 'production' });
    let finish: (v: unknown) => void = () => undefined;
    subscriptions.processDueTransitions.mockReturnValueOnce(
      new Promise((resolve) => (finish = resolve)),
    );
    const first = scheduler.run();
    await scheduler.run();
    expect(subscriptions.processDueTransitions).toHaveBeenCalledTimes(1);
    finish({ processed: 0, skipped: false });
    await first;
  });
});
