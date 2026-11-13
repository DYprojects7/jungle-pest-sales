import type { YearRules } from '../types';
import { RULES_2025 } from './2025';
import { RULES_2026 } from './2026';
import { RULES_2027 } from './2027';

const RULES_BY_YEAR: Record<number, YearRules> = {
  2025: RULES_2025,
  2026: RULES_2026,
  2027: RULES_2027,
};

/** Income years with rule data, ascending. */
export const SUPPORTED_INCOME_YEARS: number[] = Object.keys(RULES_BY_YEAR)
  .map(Number)
  .sort((a, b) => a - b);

/** Rules for an income year. Throws a RangeError for unsupported years. */
export function getRules(incomeYear: number): YearRules {
  const rules = RULES_BY_YEAR[incomeYear];
  if (!rules) {
    throw new RangeError(
      `No rules for income year ${incomeYear}. Supported: ${SUPPORTED_INCOME_YEARS.join(', ')}.`,
    );
  }
  return rules;
}

/**
 * The income year to plan for on a given date: today's calendar year when it is supported,
 * otherwise the nearest supported year.
 */
export function defaultIncomeYear(today: string): number {
  const year = Number(String(today ?? '').slice(0, 4));
  const first = SUPPORTED_INCOME_YEARS[0]!;
  const last = SUPPORTED_INCOME_YEARS[SUPPORTED_INCOME_YEARS.length - 1]!;
  if (!Number.isFinite(year)) return last;
  if (year < first) return first;
  if (year > last) return last;
  return SUPPORTED_INCOME_YEARS.includes(year) ? year : last;
}

export { RULES_2025, RULES_2026, RULES_2027 };
