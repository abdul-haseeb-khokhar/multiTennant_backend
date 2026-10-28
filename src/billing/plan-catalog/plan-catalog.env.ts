/**
 * The plan numbers and prices that come from ENVIRONMENT VARIABLES (decided 2026-10-21, L6): the
 * operator changes a variable and restarts, instead of editing the `plans` table by hand. The table
 * stays the single source of truth that all other code reads; `PlanCatalogSyncService` only applies
 * the variables that are SET on top of it, once at startup.
 *
 * All six are optional, whole numbers written in digits only. Money is in MINOR units of the plan's
 * currency (PKR 25 = 2500), minutes are whole minutes.
 */

/** Minutes and counts: 0 to 1,000,000. */
export const PLAN_CATALOG_MAX_MINUTES = 1_000_000;
/** Money: 0 to 2,000,000,000, because the money columns are 32-bit integers. */
export const PLAN_CATALOG_MAX_MONEY_MINOR = 2_000_000_000;

export type PlanCatalogTarget =
  | { kind: 'entitlement'; key: 'callMinutesPerPeriod' | 'overageMinuteMinor' }
  | { kind: 'column'; column: 'priceMinor' | 'yearlyPriceMinor' };

export interface PlanCatalogVariable {
  /** The environment variable. */
  name: string;
  /** The `plans.code` it changes. */
  planCode: 'starter' | 'free' | 'pro';
  target: PlanCatalogTarget;
  max: number;
  /** What the number means, for messages and docs. */
  unit: 'minutes' | 'minor units';
}

export const PLAN_CATALOG_VARIABLES: readonly PlanCatalogVariable[] = [
  {
    name: 'PLAN_STARTER_CALL_MINUTES',
    planCode: 'starter',
    target: { kind: 'entitlement', key: 'callMinutesPerPeriod' },
    max: PLAN_CATALOG_MAX_MINUTES,
    unit: 'minutes',
  },
  {
    name: 'PLAN_FREE_CALL_MINUTES',
    planCode: 'free',
    target: { kind: 'entitlement', key: 'callMinutesPerPeriod' },
    max: PLAN_CATALOG_MAX_MINUTES,
    unit: 'minutes',
  },
  {
    name: 'PLAN_PRO_CALL_MINUTES',
    planCode: 'pro',
    target: { kind: 'entitlement', key: 'callMinutesPerPeriod' },
    max: PLAN_CATALOG_MAX_MINUTES,
    unit: 'minutes',
  },
  {
    name: 'PLAN_PRO_OVERAGE_MINUTE_MINOR',
    planCode: 'pro',
    target: { kind: 'entitlement', key: 'overageMinuteMinor' },
    max: PLAN_CATALOG_MAX_MONEY_MINOR,
    unit: 'minor units',
  },
  {
    name: 'PLAN_PRO_PRICE_MONTH_MINOR',
    planCode: 'pro',
    target: { kind: 'column', column: 'priceMinor' },
    max: PLAN_CATALOG_MAX_MONEY_MINOR,
    unit: 'minor units',
  },
  {
    name: 'PLAN_PRO_PRICE_YEAR_MINOR',
    planCode: 'pro',
    target: { kind: 'column', column: 'yearlyPriceMinor' },
    max: PLAN_CATALOG_MAX_MONEY_MINOR,
    unit: 'minor units',
  },
];

export const PLAN_CATALOG_VARIABLE_NAMES = PLAN_CATALOG_VARIABLES.map(
  (variable) => variable.name,
);

/** A variable that is set and valid: the value to write into one field of one plan. */
export interface PlanCatalogSetting {
  variable: PlanCatalogVariable;
  value: number;
}

/** The label used in logs and docs: `entitlements.callMinutesPerPeriod` or `priceMinor`. */
export function fieldLabel(target: PlanCatalogTarget): string {
  return target.kind === 'entitlement'
    ? `entitlements.${target.key}`
    : target.column;
}

/** What a raw environment value means: unset (undefined, empty or blank), a whole number, or invalid. */
function interpret(
  raw: unknown,
  max: number,
): { state: 'unset' } | { state: 'ok'; value: number } | { state: 'invalid' } {
  if (raw === undefined || raw === null) return { state: 'unset' };
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 0 && raw <= max
      ? { state: 'ok', value: raw }
      : { state: 'invalid' };
  }
  if (typeof raw !== 'string') return { state: 'invalid' };
  const text = raw.trim();
  // An empty value in `.env` (`PLAN_PRO_CALL_MINUTES=`) means "not set", never "0".
  if (text === '') return { state: 'unset' };
  // Digits only: no sign, no decimals, no exponent, no separators ("1e3" and "10.0" are refused).
  if (!/^\d{1,10}$/.test(text)) return { state: 'invalid' };
  const value = Number(text);
  return value <= max ? { state: 'ok', value } : { state: 'invalid' };
}

/**
 * The problems with the plan variables in `raw` (names and rules only, never the values), for the
 * boot-time validation. An empty list means every variable that is set is a whole number inside
 * its bounds.
 */
export function planCatalogProblems(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const variable of PLAN_CATALOG_VARIABLES) {
    if (interpret(raw[variable.name], variable.max).state === 'invalid') {
      problems.push(
        `${variable.name} must be a whole number from 0 to ${variable.max.toLocaleString('en-US')} written in digits (${variable.unit})`,
      );
    }
  }
  return problems;
}

/**
 * The variables that are set, in a stable order. Throws on an invalid value (boot validation has
 * refused those already; this guards a caller that skipped it).
 */
export function readPlanCatalogSettings(
  get: (name: string) => unknown,
): PlanCatalogSetting[] {
  const settings: PlanCatalogSetting[] = [];
  for (const variable of PLAN_CATALOG_VARIABLES) {
    const result = interpret(get(variable.name), variable.max);
    if (result.state === 'invalid') {
      throw new Error(
        `${variable.name} must be a whole number from 0 to ${variable.max} (${variable.unit})`,
      );
    }
    if (result.state === 'ok') {
      settings.push({ variable, value: result.value });
    }
  }
  return settings;
}
