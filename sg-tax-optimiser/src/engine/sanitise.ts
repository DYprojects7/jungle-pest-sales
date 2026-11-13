/**
 * Input sanitising and defaulting (SPEC §6.0).
 *
 * `sanitise` accepts anything shaped roughly like a `PlannerInput` — including garbage numbers, missing optional
 * fields and missing sections — and returns a fully-populated input that the rest of the engine can use without
 * further checks. It never throws.
 */
import { formatIsoDate, parseIsoDate } from './dates';
import { LEVER_IDS } from './levers';
import { MAX_MONEY, wholeNumber } from './money';
import type { LeverId, PlannerInput, PrYear, Residency } from './types';

/** A `PlannerInput` with every optional field resolved to a concrete value (`null` = "no limit" / "not provided"). */
export interface SanitisedInput extends PlannerInput {
  profile: {
    residency: Residency;
    prYear: PrYear;
    ageAtYearEnd: number;
    birthMonth: number;
    hasUnusedParenthoodTaxRebate: boolean;
  };
  income: {
    monthlyOrdinaryWage: number;
    monthsWorked: number;
    additionalWages: number;
    otherTaxableIncome: number;
    employmentExpenses: number;
    donations: number;
    employeeCpfOverride: number | null;
  };
  levers: {
    srs: { enabled: boolean };
    cpfSelf: { enabled: boolean; roomToLimit: number | null };
    cpfFamily: { enabled: boolean; maxAmount: number | null };
  };
  preferences: {
    cashBudget: number | null;
    minSavingRate: number;
    priority: LeverId[];
    simulatorStep: number;
  };
}

const MAX_AGE = 120;
const DEFAULT_SIMULATOR_STEP = 1000;
const MIN_SIMULATOR_STEP = 100;

/** A property bag for reading fields off a value that may not be an object at all. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** A money input: non-negative whole dollars, at most MAX_MONEY. */
export function money(value: unknown): number {
  return Math.min(wholeNumber(value), MAX_MONEY);
}

/**
 * An optional limit. The SPEC applies a limit only "when it is a number" (§6.1, §6.5, §6.6): a number is
 * sanitised as a money input (so NaN or a negative limit is a limit of 0); anything else means "no limit".
 */
function optionalMoney(value: unknown): number | null {
  return typeof value === 'number' ? money(value) : null;
}

/**
 * An optional figure that REPLACES a calculated one (the employee CPF override, §6.0 and §6.1). Unlike a limit,
 * reading a meaningless value as 0 would not be the cautious direction: it would remove the CPF relief, overstate
 * the tax and recommend more than the user's own minimum rate allows. So only a finite number of 0 or more is a
 * figure; anything else (NaN, ±Infinity, a negative number, a non-number) means "not provided".
 */
function optionalFigure(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? money(value) : null;
}

/**
 * A whole-number input with a legal range: a number is sanitised (not finite or negative -> 0, rounded down)
 * and then clamped to [min, max]; anything that is not a number takes `fallback`.
 */
function integerInRange(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number') return fallback;
  return Math.min(max, Math.max(min, wholeNumber(value)));
}

function residency(value: unknown): Residency {
  return value === 'pr' || value === 'foreigner' ? value : 'citizen';
}

function prYear(value: unknown): PrYear {
  return value === 1 || value === 2 ? value : 3;
}

/** A fraction clamped to 0…1 (it is not a money input, so it is not rounded down); 0 when it is not a number. */
function minSavingRate(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Whole dollars, at least 100; 1,000 when not given. */
function simulatorStep(value: unknown): number {
  if (typeof value !== 'number') return DEFAULT_SIMULATOR_STEP;
  return Math.max(MIN_SIMULATOR_STEP, wholeNumber(value));
}

/** A permutation of the three levers: valid entries in the order given, then any missing ones in canonical order. */
function priority(value: unknown): LeverId[] {
  const ordered: LeverId[] = [];
  const add = (candidate: unknown): void => {
    const lever = LEVER_IDS.find((id) => id === candidate);
    if (lever !== undefined && !ordered.includes(lever)) ordered.push(lever);
  };
  if (Array.isArray(value)) value.forEach(add);
  LEVER_IDS.forEach(add);
  return ordered;
}

/**
 * `today` as `YYYY-MM-DD` (SPEC §6.0): its leading date when it can be parsed, otherwise 1 January of the income
 * year (the whole year ahead, no deadline warning).
 */
function today(value: unknown, incomeYear: number): string {
  const parsed = parseIsoDate(value);
  if (parsed) return formatIsoDate(parsed);
  const year = Number.isInteger(incomeYear) && incomeYear >= 0 && incomeYear <= 9999 ? incomeYear : 0;
  return formatIsoDate({ year, month: 1, day: 1 });
}

/** SPEC §6.0. Idempotent: sanitising a sanitised input returns an equal object. */
export function sanitise(input: PlannerInput): SanitisedInput {
  const raw = asRecord(input);
  const profile = asRecord(raw.profile);
  const income = asRecord(raw.income);
  const existing = asRecord(raw.existing);
  const levers = asRecord(raw.levers);
  const preferences = asRecord(raw.preferences);
  const incomeYear = typeof raw.incomeYear === 'number' ? raw.incomeYear : Number.NaN;

  return {
    incomeYear,
    today: today(raw.today, incomeYear),
    profile: {
      residency: residency(profile.residency),
      prYear: prYear(profile.prYear),
      ageAtYearEnd: integerInRange(profile.ageAtYearEnd, 0, MAX_AGE, 0),
      birthMonth: integerInRange(profile.birthMonth, 1, 12, 12),
      // §6.0: like a lever's `enabled` flag, true only for the boolean `true` (never for 1 or "true").
      hasUnusedParenthoodTaxRebate: profile.hasUnusedParenthoodTaxRebate === true,
    },
    income: {
      monthlyOrdinaryWage: money(income.monthlyOrdinaryWage),
      monthsWorked: integerInRange(income.monthsWorked, 1, 12, 12),
      additionalWages: money(income.additionalWages),
      otherTaxableIncome: money(income.otherTaxableIncome),
      employmentExpenses: money(income.employmentExpenses),
      donations: money(income.donations),
      employeeCpfOverride: optionalFigure(income.employeeCpfOverride),
    },
    existing: {
      srs: money(existing.srs),
      cpfTopUpSelf: money(existing.cpfTopUpSelf),
      cpfTopUpFamily: money(existing.cpfTopUpFamily),
    },
    otherReliefs: money(raw.otherReliefs),
    // §6.0: a lever is enabled only when its flag is exactly `true` (never for 1, "true" or a missing flag).
    levers: {
      srs: { enabled: asRecord(levers.srs).enabled === true },
      cpfSelf: {
        enabled: asRecord(levers.cpfSelf).enabled === true,
        roomToLimit: optionalMoney(asRecord(levers.cpfSelf).roomToLimit),
      },
      cpfFamily: {
        enabled: asRecord(levers.cpfFamily).enabled === true,
        maxAmount: optionalMoney(asRecord(levers.cpfFamily).maxAmount),
      },
    },
    preferences: {
      cashBudget: optionalMoney(preferences.cashBudget),
      minSavingRate: minSavingRate(preferences.minSavingRate),
      priority: priority(preferences.priority),
      simulatorStep: simulatorStep(preferences.simulatorStep),
    },
  };
}
