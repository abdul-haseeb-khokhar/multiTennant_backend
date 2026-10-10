import type { BillingInterval } from './billing.constants';

const DAY_MS = 86_400_000;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Adds calendar months in UTC, clamping to the end of a shorter month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/** End of a billing period that starts at `start`. `none` has no length, so callers must pass an explicit end. */
export function addInterval(
  start: Date,
  interval: Exclude<BillingInterval, 'none'>,
): Date {
  return addMonths(start, interval === 'year' ? 12 : 1);
}

/** Whole days from `now` until `until`, rounded up, never negative. Null when there is no end. */
export function daysUntil(until: Date | null, now: Date): number | null {
  if (!until) return null;
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY_MS));
}
