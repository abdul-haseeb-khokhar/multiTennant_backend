import {
  PLAN_CATALOG_VARIABLES,
  PLAN_CATALOG_VARIABLE_NAMES,
  fieldLabel,
  planCatalogProblems,
  readPlanCatalogSettings,
} from './plan-catalog.env';

describe('plan catalogue variables', () => {
  it('are exactly the six documented names, each tied to one plan and one field', () => {
    expect(PLAN_CATALOG_VARIABLE_NAMES).toEqual([
      'PLAN_STARTER_CALL_MINUTES',
      'PLAN_FREE_CALL_MINUTES',
      'PLAN_PRO_CALL_MINUTES',
      'PLAN_PRO_OVERAGE_MINUTE_MINOR',
      'PLAN_PRO_PRICE_MONTH_MINOR',
      'PLAN_PRO_PRICE_YEAR_MINOR',
    ]);
    expect(
      PLAN_CATALOG_VARIABLES.map((v) => [
        v.planCode,
        fieldLabel(v.target),
        v.max,
      ]),
    ).toEqual([
      ['starter', 'entitlements.callMinutesPerPeriod', 1_000_000],
      ['free', 'entitlements.callMinutesPerPeriod', 1_000_000],
      ['pro', 'entitlements.callMinutesPerPeriod', 1_000_000],
      ['pro', 'entitlements.overageMinuteMinor', 2_000_000_000],
      ['pro', 'priceMinor', 2_000_000_000],
      ['pro', 'yearlyPriceMinor', 2_000_000_000],
    ]);
  });
});

describe('planCatalogProblems', () => {
  it('is empty when nothing is set, or every value is a whole number inside its bounds', () => {
    expect(planCatalogProblems({})).toEqual([]);
    expect(
      planCatalogProblems({
        PLAN_STARTER_CALL_MINUTES: '30',
        PLAN_FREE_CALL_MINUTES: 20,
        PLAN_PRO_CALL_MINUTES: '0',
        PLAN_PRO_PRICE_MONTH_MINOR: '2000000000',
      }),
    ).toEqual([]);
  });

  it('treats unset, empty and blank as "not set"', () => {
    expect(
      planCatalogProblems({
        PLAN_STARTER_CALL_MINUTES: undefined,
        PLAN_FREE_CALL_MINUTES: '',
        PLAN_PRO_CALL_MINUTES: '  ',
        PLAN_PRO_PRICE_MONTH_MINOR: null,
      }),
    ).toEqual([]);
  });

  it.each([
    'abc',
    '-1',
    '1.5',
    '1e3',
    '0x10',
    '+5',
    '1 000',
    '1000001',
    '12345678901',
  ])('flags %s for a minutes variable', (bad) => {
    expect(planCatalogProblems({ PLAN_PRO_CALL_MINUTES: bad })).toEqual([
      expect.stringContaining('PLAN_PRO_CALL_MINUTES'),
    ]);
  });

  it.each([NaN, Infinity, -3, 2.5, 1_000_001, true, {}, []])(
    'flags the non-string value %p',
    (bad) => {
      expect(planCatalogProblems({ PLAN_PRO_CALL_MINUTES: bad })).toHaveLength(
        1,
      );
    },
  );

  it('never repeats the value, only the name and the rule', () => {
    const [problem] = planCatalogProblems({
      PLAN_PRO_CALL_MINUTES: 'topsecret',
    });
    expect(problem).not.toContain('topsecret');
    expect(problem).toContain('whole number');
  });
});

describe('readPlanCatalogSettings', () => {
  const read = (env: Record<string, unknown>) =>
    readPlanCatalogSettings((name) => env[name]).map((s) => [
      s.variable.name,
      s.value,
    ]);

  it('returns only the variables that are set, as numbers, in the table order', () => {
    expect(
      read({
        PLAN_PRO_PRICE_MONTH_MINOR: '1999900',
        PLAN_STARTER_CALL_MINUTES: 45,
        PLAN_FREE_CALL_MINUTES: '',
      }),
    ).toEqual([
      ['PLAN_STARTER_CALL_MINUTES', 45],
      ['PLAN_PRO_PRICE_MONTH_MINOR', 1999900],
    ]);
  });

  it('a 0 is a real value (no minutes), not "unset"', () => {
    expect(read({ PLAN_FREE_CALL_MINUTES: '0' })).toEqual([
      ['PLAN_FREE_CALL_MINUTES', 0],
    ]);
  });

  it('is empty when nothing is set', () => {
    expect(read({})).toEqual([]);
  });

  it('throws on an invalid value instead of guessing (boot validation refuses these first)', () => {
    expect(() => read({ PLAN_PRO_CALL_MINUTES: '1.5' })).toThrow(
      /PLAN_PRO_CALL_MINUTES/,
    );
  });
});
