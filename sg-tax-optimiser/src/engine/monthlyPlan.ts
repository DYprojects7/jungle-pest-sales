/**
 * The monthly set-aside plan (SPEC §6.10). Pure date arithmetic on the ISO strings: `today` comes from the
 * input and the deadline from the rules; the system clock is never read.
 */
import { daysBetween, formatIsoMonth, parseIsoDate } from './dates';
import type { CivilDate } from './dates';
import { LEVER_IDS, noContributions, totalOf } from './levers';
import type { LeverAmounts, MonthlyPlan, MonthlyPlanRow, YearRules } from './types';

const MONTHS_IN_YEAR = 12;

/** A rule or sanitised-input date; both are guaranteed to be valid `YYYY-MM-DD` strings. */
function civilDate(iso: string): CivilDate {
  const date = parseIsoDate(iso);
  if (!date) throw new RangeError(`Not an ISO date (YYYY-MM-DD): ${iso}`);
  return date;
}

/** §6.10 `monthsRemaining`: instalment months left in the income year, counting the current month. */
function monthsRemaining(today: CivilDate, incomeYear: number): number {
  if (today.year < incomeYear) return MONTHS_IN_YEAR;
  if (today.year > incomeYear) return 0;
  return MONTHS_IN_YEAR - today.month + 1;
}

/**
 * §6.10 schedule: each lever's amount in `months` whole-dollar instalments that sum exactly to the amount, the
 * earlier instalments taking the odd dollars. The last instalment is in December of the income year.
 */
function schedule(contributions: LeverAmounts, months: number, incomeYear: number): MonthlyPlanRow[] {
  const rows: MonthlyPlanRow[] = [];
  for (let index = 0; index < months; index++) {
    const amounts = noContributions();
    for (const lever of LEVER_IDS) {
      const base = Math.floor(contributions[lever] / months);
      const extra = contributions[lever] - base * months;
      amounts[lever] = index < extra ? base + 1 : base;
    }
    rows.push({
      month: formatIsoMonth(incomeYear, MONTHS_IN_YEAR - months + 1 + index),
      amounts,
      total: totalOf(amounts),
    });
  }
  return rows;
}

/**
 * SPEC §6.10.
 * @param today sanitised `PlannerInput.today`
 * @param rules supplies the income year and the contribution deadline (31 December of that year)
 * @param contributions the plan's additional contribution per lever
 */
export function buildMonthlyPlan(today: string, rules: YearRules, contributions: LeverAmounts): MonthlyPlan {
  const { incomeYear, contributionDeadline: deadline } = rules;
  const todayDate = civilDate(today);
  const months = monthsRemaining(todayDate, incomeYear);
  const hasPlan = totalOf(contributions) > 0;

  const fullYearMonthly = noContributions();
  for (const lever of LEVER_IDS) {
    fullYearMonthly[lever] = Math.ceil(contributions[lever] / MONTHS_IN_YEAR);
  }

  return {
    deadline,
    daysToDeadline: daysBetween(todayDate, civilDate(deadline)),
    monthsRemaining: months,
    schedule: months > 0 && hasPlan ? schedule(contributions, months, incomeYear) : [],
    fullYearMonthly: { ...fullYearMonthly, total: totalOf(fullYearMonthly) },
  };
}
