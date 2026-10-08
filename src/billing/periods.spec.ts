import { addDays, addInterval, addMonths, daysUntil } from './periods';

const d = (s: string) => new Date(s);

describe('periods', () => {
  it('adds calendar months in UTC and clamps to the end of a shorter month', () => {
    expect(addMonths(d('2026-10-07T00:00:00Z'), 1)).toEqual(
      d('2026-11-07T00:00:00Z'),
    );
    expect(addMonths(d('2026-01-31T00:00:00Z'), 1)).toEqual(
      d('2026-02-28T00:00:00Z'),
    );
    expect(addMonths(d('2028-01-31T00:00:00Z'), 1)).toEqual(
      d('2028-02-29T00:00:00Z'),
    );
    expect(addMonths(d('2026-12-15T10:30:00Z'), 1)).toEqual(
      d('2027-01-15T10:30:00Z'),
    );
  });

  it('a year is twelve months, a month is one', () => {
    expect(addInterval(d('2026-10-07T00:00:00Z'), 'year')).toEqual(
      d('2027-10-07T00:00:00Z'),
    );
    expect(addInterval(d('2026-10-07T00:00:00Z'), 'month')).toEqual(
      d('2026-11-07T00:00:00Z'),
    );
    expect(addInterval(d('2028-02-29T00:00:00Z'), 'year')).toEqual(
      d('2029-02-28T00:00:00Z'),
    );
  });

  it('adds days without caring about the time zone', () => {
    expect(addDays(d('2026-10-07T00:00:00Z'), 15)).toEqual(
      d('2026-10-22T00:00:00Z'),
    );
  });

  it('counts whole days left, rounded up, never negative, null without an end', () => {
    const now = d('2026-10-07T12:00:00Z');
    expect(daysUntil(d('2026-10-22T00:00:00Z'), now)).toBe(15);
    expect(daysUntil(d('2026-10-07T13:00:00Z'), now)).toBe(1);
    expect(daysUntil(d('2026-10-07T12:00:00Z'), now)).toBe(0);
    expect(daysUntil(d('2026-10-01T00:00:00Z'), now)).toBe(0);
    expect(daysUntil(null, now)).toBeNull();
  });
});
