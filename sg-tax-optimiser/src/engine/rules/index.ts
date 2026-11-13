import { parseIsoDate } from '../dates';
import type { YearRules } from '../types';
import { RULES_2025 } from './2025';
import { RULES_2026 } from './2026';
import { RULES_2027 } from './2027';

/**
 * Make a rule object, and everything it holds, read-only.
 *
 * `plan()` hands the caller the engine's own rule object (`result.rules === getRules(year)`), and the years
 * share their tax table, PR rate tables, relief catalogue and sources. If any of that could be edited, a caller
 * that sorted or changed a table would silently change every later calculation, for every year. Frozen, such a
 * write throws instead (the engine and its callers are ES modules, so strict mode applies).
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

/** The registered rule sets by income year. A Map, so only its own numeric keys are income years. */
const RULES_BY_YEAR: ReadonlyMap<number, YearRules> = new Map(
  [RULES_2025, RULES_2026, RULES_2027].map((rules) => [rules.incomeYear, deepFreeze(rules)]),
);

/** Income years with rule data, ascending. Read-only (frozen). */
export const SUPPORTED_INCOME_YEARS: number[] = Object.freeze(
  [...RULES_BY_YEAR.keys()].sort((a, b) => a - b),
) as number[];

/**
 * Rules for an income year (read-only). Throws a RangeError for anything that is not a supported income year
 * given as a number: an unsupported year, a string such as '2026', or a property name such as 'constructor'.
 */
export function getRules(incomeYear: number): YearRules {
  const supported = `Supported: ${SUPPORTED_INCOME_YEARS.join(', ')}.`;
  if (typeof incomeYear !== 'number') {
    // Described by its type only: turning an arbitrary value into text can itself throw.
    const given: unknown = incomeYear;
    const kind = typeof given === 'string' ? `the string ${JSON.stringify(given)}` : given === null ? 'null' : typeof given;
    throw new RangeError(`The income year must be a number, not ${kind}. ${supported}`);
  }
  const rules = RULES_BY_YEAR.get(incomeYear);
  if (!rules) throw new RangeError(`No rules for income year ${incomeYear}. ${supported}`);
  return rules;
}

/**
 * The year to fall back on when there is no date to go by: the latest supported income year whose rules are
 * final (never a projected year), or the latest supported year if none is final.
 */
function latestFinalIncomeYear(): number {
  const finalYears = SUPPORTED_INCOME_YEARS.filter((year) => RULES_BY_YEAR.get(year)?.status === 'final');
  const latest = finalYears[finalYears.length - 1] ?? SUPPORTED_INCOME_YEARS[SUPPORTED_INCOME_YEARS.length - 1];
  if (latest === undefined) throw new RangeError('No income year has rules.');
  return latest;
}

/**
 * SPEC §7: the income year to plan for on a given date — today's calendar year when it is supported, otherwise
 * the nearest supported year. When `today` cannot be parsed (§6.0) the answer is the latest supported income
 * year whose rules are final.
 */
export function defaultIncomeYear(today: string): number {
  const date = parseIsoDate(today);
  if (!date) return latestFinalIncomeYear();
  const { year } = date;
  const first = SUPPORTED_INCOME_YEARS[0]!;
  const last = SUPPORTED_INCOME_YEARS[SUPPORTED_INCOME_YEARS.length - 1]!;
  if (year < first) return first;
  if (year > last) return last;
  return SUPPORTED_INCOME_YEARS.includes(year) ? year : last;
}

export { RULES_2025, RULES_2026, RULES_2027 };
