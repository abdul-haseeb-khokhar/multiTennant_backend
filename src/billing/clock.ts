/**
 * Source of "now" for everything time-dependent in billing. Injectable so tests can move time
 * instead of waiting 15 days (use `FakeClock`).
 */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock a test controls. */
export class FakeClock extends Clock {
  constructor(private current: Date = new Date('2026-10-07T00:00:00.000Z')) {
    super();
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(value: Date | string) {
    this.current = new Date(value);
  }

  advanceDays(days: number) {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }

  advanceMs(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}
