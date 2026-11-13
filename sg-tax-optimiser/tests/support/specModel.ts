/**
 * An independent transcription of SPEC.md §5 (rule values) and §6.0–§6.6, §6.10 (calculation model), written by
 * the test author from the specification text alone. It shares no code and no data with `src/engine/` (only the
 * type declarations of the data contract are imported), so a property test that compares the engine with this
 * model checks the engine's rule data as well as its logic.
 *
 * Everything here is integer arithmetic on whole dollars, per-mille rates and cents; the only non-integers are
 * the donation deduction (a multiple of S$0.50) and the reported rates.
 */
import type { BindingConstraint, LeverAmounts, LeverId, Residency } from '../../src/engine/types';

// ---------------------------------------------------------------------------------------------------------------
// SPEC §5 — rule values, typed in by hand from the specification
// ---------------------------------------------------------------------------------------------------------------

export const LEVERS: readonly LeverId[] = ['srs', 'cpfSelf', 'cpfFamily'];
export const SPEC_YEARS = [2025, 2026, 2027] as const;
export type SpecYear = (typeof SPEC_YEARS)[number];

/** §6.0: money inputs are clamped to at most S$10,000,000,000. */
export const SPEC_MAX_MONEY = 10_000_000_000;
/** §5.2: overall cap on personal reliefs. */
export const SPEC_RELIEF_CAP = 80_000;
/** §5.3: annual wage ceiling. */
export const SPEC_ANNUAL_WAGE_CEILING = 102_000;
/** §5.3: 20% × S$102,000. */
export const SPEC_MAX_COMPULSORY_CPF = 20_400;
/** §5.3: Ordinary Wage ceiling per month. */
export const SPEC_OW_CEILING: Record<SpecYear, number> = { 2025: 7_400, 2026: 8_000, 2027: 8_000 };
/** §5.4: SRS relief caps. */
export const SPEC_SRS_CAP = { citizenPr: 15_300, foreigner: 35_700 } as const;
/** §5.4: CPF cash top-up relief caps (self, family). */
export const SPEC_TOPUP_CAP = 8_000;
/** §5.4: retirement and healthcare sums (informational). */
export const SPEC_SUMS: Record<SpecYear, { frs: number; ers: number; bhs: number }> = {
  2025: { frs: 213_000, ers: 426_000, bhs: 75_500 },
  2026: { frs: 220_400, ers: 440_800, bhs: 79_000 },
  2027: { frs: 228_200, ers: 456_400, bhs: 79_000 },
};
/** §5.2: Earned Income Relief. */
export const SPEC_EIR = { below55: 1_000, age55to59: 6_000, age60plus: 8_000 } as const;

export interface SpecBracket {
  /** Chargeable income at which the band starts. */
  from: number;
  /** The band's rate as a fraction (as it would be typed into a rules file). */
  rate: number;
  /** The same rate per mille. */
  mille: number;
  /** §5.1 "cumulative tax at top of band" of the band below = tax on exactly `from` dollars. */
  taxAtFrom: number;
}

/** §5.1 resident rates (YA2024 onwards; used for all three supported income years). */
export const SPEC_BRACKETS: readonly SpecBracket[] = [
  { from: 0, rate: 0, mille: 0, taxAtFrom: 0 },
  { from: 20_000, rate: 0.02, mille: 20, taxAtFrom: 0 },
  { from: 30_000, rate: 0.035, mille: 35, taxAtFrom: 200 },
  { from: 40_000, rate: 0.07, mille: 70, taxAtFrom: 550 },
  { from: 80_000, rate: 0.115, mille: 115, taxAtFrom: 3_350 },
  { from: 120_000, rate: 0.15, mille: 150, taxAtFrom: 7_950 },
  { from: 160_000, rate: 0.18, mille: 180, taxAtFrom: 13_950 },
  { from: 200_000, rate: 0.19, mille: 190, taxAtFrom: 21_150 },
  { from: 240_000, rate: 0.195, mille: 195, taxAtFrom: 28_750 },
  { from: 280_000, rate: 0.2, mille: 200, taxAtFrom: 36_550 },
  { from: 320_000, rate: 0.22, mille: 220, taxAtFrom: 44_550 },
  { from: 500_000, rate: 0.23, mille: 230, taxAtFrom: 84_150 },
  { from: 1_000_000, rate: 0.24, mille: 240, taxAtFrom: 199_150 },
];

/** §5.3 upper ages of the five CPF age bands ("55 and below", "above 55 to 60", …, "above 70"). */
export const SPEC_BAND_MAX_AGE: readonly (number | null)[] = [55, 60, 65, 70, null];

/** §5.3 employee rates per mille, Citizens and SPRs from the third year, by band. */
export const SPEC_FULL_EMPLOYEE_MILLE: Record<SpecYear, readonly number[]> = {
  2025: [200, 170, 115, 75, 50],
  2026: [200, 180, 125, 75, 50],
  2027: [200, 190, 130, 75, 50],
};
/** §5.3 employer rates per mille, Citizens and SPRs from the third year, by band. */
export const SPEC_FULL_EMPLOYER_MILLE: Record<SpecYear, readonly number[]> = {
  2025: [170, 155, 120, 90, 75],
  2026: [170, 160, 125, 90, 75],
  2027: [170, 165, 130, 90, 75],
};
/** §5.3 first-year SPR employee rate: 5% at every age. */
export const SPEC_PR1_EMPLOYEE_MILLE: readonly number[] = [50, 50, 50, 50, 50];
/** §5.3 second-year SPR employee rates: 15% / 12.5% / 7.5% / 5% (above 65). */
export const SPEC_PR2_EMPLOYEE_MILLE: readonly number[] = [150, 125, 75, 50, 50];

/** §6.11 table: code → severity, in table order. */
export const SPEC_WARNINGS: readonly (readonly [string, 'info' | 'caution' | 'blocker'])[] = [
  ['NO_TAX_PAYABLE', 'info'],
  ['RELIEF_CAP_EXCEEDED_BASELINE', 'caution'],
  ['RELIEF_CAP_LIMITS_PLAN', 'caution'],
  ['BELOW_MIN_SAVING_RATE', 'info'],
  ['BUDGET_LIMITS_PLAN', 'info'],
  ['LEVER_LIMITS_PLAN', 'info'],
  ['EXISTING_EXCEEDS_CAP', 'caution'],
  ['CPF_OVERRIDE_ABOVE_MAX', 'caution'],
  ['FOREIGNER_NO_CPF', 'info'],
  ['PR_GRADUATED_RATES', 'info'],
  ['AGE_55_PLUS_TOPUP', 'info'],
  ['SRS_UNDER_18', 'caution'],
  ['DEADLINE_PASSED', 'blocker'],
  ['DEADLINE_SOON', 'caution'],
  ['PROJECTED_RULES', 'caution'],
  ['PIT_REBATE_APPLIED', 'info'],
];

// ---------------------------------------------------------------------------------------------------------------
// A fully-populated input (what §6.0 sanitising produces)
// ---------------------------------------------------------------------------------------------------------------

export interface FullInput {
  incomeYear: number;
  today: string;
  profile: { residency: Residency; prYear: 1 | 2 | 3; ageAtYearEnd: number; birthMonth: number };
  income: {
    monthlyOrdinaryWage: number;
    monthsWorked: number;
    additionalWages: number;
    otherTaxableIncome: number;
    employmentExpenses: number;
    donations: number;
    employeeCpfOverride: number | null;
  };
  existing: { srs: number; cpfTopUpSelf: number; cpfTopUpFamily: number };
  otherReliefs: number;
  levers: {
    srs: { enabled: boolean };
    cpfSelf: { enabled: boolean; roomToLimit: number | null };
    cpfFamily: { enabled: boolean; maxAmount: number | null };
  };
  preferences: { cashBudget: number | null; minSavingRate: number; priority: LeverId[]; simulatorStep: number };
}

export function isSpecYear(year: unknown): year is SpecYear {
  return year === 2025 || year === 2026 || year === 2027;
}

function specYear(year: number): SpecYear {
  if (!isSpecYear(year)) throw new RangeError(`specModel: unsupported income year ${String(year)}`);
  return year;
}

// ---------------------------------------------------------------------------------------------------------------
// SPEC §6.0 — sanitising
// ---------------------------------------------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** "not finite or < 0 → 0; otherwise Math.floor", then "clamped to at most S$10,000,000,000". */
export function specMoney(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0; // (−0 is 0)
  return Math.min(Math.floor(value), SPEC_MAX_MONEY);
}

/** Sanitised like money (without the money cap), then clamped; a missing or non-number value takes the default. */
function specClampedInt(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== 'number') return fallback;
  const whole = !Number.isFinite(value) || value <= 0 ? 0 : Math.floor(value);
  return Math.min(hi, Math.max(lo, whole));
}

/** Optional limits apply only when they are numbers (then sanitised like money). */
function specOptionalMoney(value: unknown): number | null {
  return typeof value === 'number' ? specMoney(value) : null;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/**
 * The leading `YYYY-MM-DD` of a string when it is a real calendar date, else null. SPEC §6.0 (as clarified):
 * a date followed directly by another digit ("2026-11-135") cannot be parsed.
 */
export function specParseDate(value: unknown): { year: number; month: number; day: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * SPEC §6.0 applied to anything. A lever is enabled only when its `enabled` flag is exactly the boolean `true`
 * (§6.0, as clarified).
 */
export function specSanitise(raw: unknown): FullInput {
  const top = record(raw);
  const profile = record(top.profile);
  const income = record(top.income);
  const existing = record(top.existing);
  const levers = record(top.levers);
  const preferences = record(top.preferences);
  const incomeYear = typeof top.incomeYear === 'number' ? top.incomeYear : Number.NaN;

  const priority: LeverId[] = [];
  const given = Array.isArray(preferences.priority) ? (preferences.priority as unknown[]) : [];
  for (const candidate of [...given, ...LEVERS]) {
    const lever = LEVERS.find((id) => id === candidate);
    if (lever !== undefined && !priority.includes(lever)) priority.push(lever);
  }

  const date = specParseDate(top.today);
  const rate = preferences.minSavingRate;
  const step = preferences.simulatorStep;

  return {
    incomeYear,
    today: date
      ? `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`
      : `${pad(Number.isInteger(incomeYear) ? incomeYear : 0, 4)}-01-01`,
    profile: {
      residency: profile.residency === 'pr' || profile.residency === 'foreigner' ? profile.residency : 'citizen',
      prYear: profile.prYear === 1 || profile.prYear === 2 ? profile.prYear : 3,
      ageAtYearEnd: specClampedInt(profile.ageAtYearEnd, 0, 120, 0),
      birthMonth: specClampedInt(profile.birthMonth, 1, 12, 12),
    },
    income: {
      monthlyOrdinaryWage: specMoney(income.monthlyOrdinaryWage),
      monthsWorked: specClampedInt(income.monthsWorked, 1, 12, 12),
      additionalWages: specMoney(income.additionalWages),
      otherTaxableIncome: specMoney(income.otherTaxableIncome),
      employmentExpenses: specMoney(income.employmentExpenses),
      donations: specMoney(income.donations),
      employeeCpfOverride: specOptionalMoney(income.employeeCpfOverride),
    },
    existing: {
      srs: specMoney(existing.srs),
      cpfTopUpSelf: specMoney(existing.cpfTopUpSelf),
      cpfTopUpFamily: specMoney(existing.cpfTopUpFamily),
    },
    otherReliefs: specMoney(top.otherReliefs),
    levers: {
      srs: { enabled: record(levers.srs).enabled === true },
      cpfSelf: {
        enabled: record(levers.cpfSelf).enabled === true,
        roomToLimit: specOptionalMoney(record(levers.cpfSelf).roomToLimit),
      },
      cpfFamily: {
        enabled: record(levers.cpfFamily).enabled === true,
        maxAmount: specOptionalMoney(record(levers.cpfFamily).maxAmount),
      },
    },
    preferences: {
      cashBudget: specOptionalMoney(preferences.cashBudget),
      minSavingRate: typeof rate !== 'number' || Number.isNaN(rate) ? 0 : Math.min(1, Math.max(0, rate)),
      priority,
      simulatorStep: typeof step !== 'number' ? 1_000 : Math.max(100, specClampedInt(step, 0, Infinity, 1_000)),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SPEC §5.1 / §6.4 — tax
// ---------------------------------------------------------------------------------------------------------------

/** floor(a / b) for non-negative integers without a floating-point quotient. */
function floorDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}

/**
 * Gross tax in whole cents on a whole-dollar chargeable income, by the closed form of the §5.1 table:
 * the cumulative tax at the bottom of the band plus the band's rate on the excess, rounded half-up to the cent.
 */
export function specTaxCents(chargeableIncome: number): number {
  let band = SPEC_BRACKETS[0]!;
  for (const candidate of SPEC_BRACKETS) {
    if (candidate.from <= chargeableIncome) band = candidate;
  }
  const mills = band.mille * (chargeableIncome - band.from);
  return band.taxAtFrom * 100 + floorDiv(mills + 5, 10);
}

/**
 * The statutory rate on the n-th dollar of chargeable income (n = 1 is the first dollar): the rate of the band
 * with the largest `from` below n. 0 for n ≤ 0. `specRateOfDollar(ci)` is therefore the §6.4 marginal rate at ci.
 */
export function specRateOfDollar(n: number): number {
  if (n <= 0) return 0;
  let rate = 0;
  for (const band of SPEC_BRACKETS) {
    if (band.from < n) rate = band.rate;
  }
  return rate;
}

/** §6.6 floorCI(r): `from` of the lowest band whose rate > 0 and rate ≥ r (∞ if none). */
export function specFloorCI(minRate: number): number {
  for (const band of SPEC_BRACKETS) {
    if (band.rate > 0 && band.rate >= minRate) return band.from;
  }
  return Infinity;
}

/** §6.6 usefulRoom(r) = max(0, CI0 − floorCI(r)). */
export function specUsefulRoom(chargeableIncome: number, minRate: number): number {
  const floor = specFloorCI(minRate);
  return floor === Infinity ? 0 : Math.max(0, chargeableIncome - floor);
}

// ---------------------------------------------------------------------------------------------------------------
// SPEC §6.1 — compulsory employee CPF
// ---------------------------------------------------------------------------------------------------------------

export interface SpecCpf {
  source: 'auto' | 'override' | 'none';
  ordinaryWagesSubject: number;
  additionalWageCeiling: number;
  additionalWagesSubject: number;
  employeeContribution: number;
  /** null when the SPEC gives no employer rates (first- and second-year SPRs). */
  employerContribution: number | null;
  monthlyEmployeeRates: number[];
}

/** Index of the CPF age band for a completed age. */
function bandIndex(completedAge: number): number {
  for (let i = 0; i < SPEC_BAND_MAX_AGE.length; i++) {
    const maxAge = SPEC_BAND_MAX_AGE[i];
    if (maxAge === null || maxAge === undefined || completedAge < maxAge) return i;
  }
  return SPEC_BAND_MAX_AGE.length - 1;
}

export function specCpf(s: FullInput): SpecCpf {
  const { residency, prYear, ageAtYearEnd, birthMonth } = s.profile;
  if (residency === 'foreigner') {
    return {
      source: 'none',
      ordinaryWagesSubject: 0,
      additionalWageCeiling: 0,
      additionalWagesSubject: 0,
      employeeContribution: 0,
      employerContribution: 0,
      monthlyEmployeeRates: new Array<number>(12).fill(0),
    };
  }
  const year = specYear(s.incomeYear);
  const graduated = residency === 'pr' && prYear !== 3;
  const employeeMille = !graduated
    ? SPEC_FULL_EMPLOYEE_MILLE[year]
    : prYear === 1
      ? SPEC_PR1_EMPLOYEE_MILLE
      : SPEC_PR2_EMPLOYEE_MILLE;
  const employerMille = graduated ? null : SPEC_FULL_EMPLOYER_MILLE[year];
  const bandOf = (month: number): number => bandIndex(month <= birthMonth ? ageAtYearEnd - 1 : ageAtYearEnd);

  const ow = s.income.monthlyOrdinaryWage;
  const owSubject = Math.min(ow, SPEC_OW_CEILING[year]);
  const firstWorked = 13 - s.income.monthsWorked;

  let ordinaryWagesSubject = 0;
  let employee = 0;
  let employerMills = 0;
  const monthlyEmployeeRates: number[] = [];
  for (let month = 1; month <= 12; month++) {
    if (month < firstWorked) {
      monthlyEmployeeRates.push(0);
      continue;
    }
    const band = bandOf(month);
    const mille = employeeMille[band]!;
    ordinaryWagesSubject += owSubject;
    if (ow <= 500) employee += 0;
    else if (ow <= 750) employee += floorDiv(3 * mille * (ow - 500), 1000);
    else employee += floorDiv(mille * owSubject, 1000);
    if (employerMille) employerMills += employerMille[band]! * owSubject;
    monthlyEmployeeRates.push(mille / 1000);
  }

  const december = bandOf(12);
  const additionalWageCeiling = Math.max(0, SPEC_ANNUAL_WAGE_CEILING - ordinaryWagesSubject);
  const additionalWagesSubject = Math.min(s.income.additionalWages, additionalWageCeiling);
  employee += floorDiv(employeeMille[december]! * additionalWagesSubject, 1000);
  if (employerMille) employerMills += employerMille[december]! * additionalWagesSubject;

  const override = s.income.employeeCpfOverride;
  if (override !== null) {
    return {
      source: 'override',
      ordinaryWagesSubject,
      additionalWageCeiling,
      additionalWagesSubject,
      employeeContribution: Math.min(override, SPEC_MAX_COMPULSORY_CPF),
      employerContribution: 0,
      monthlyEmployeeRates,
    };
  }
  return {
    source: 'auto',
    ordinaryWagesSubject,
    additionalWageCeiling,
    additionalWagesSubject,
    employeeContribution: employee,
    employerContribution: employerMille ? floorDiv(employerMills + 500, 1000) : null,
    monthlyEmployeeRates,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SPEC §6.5 — levers
// ---------------------------------------------------------------------------------------------------------------

export interface SpecLever {
  eligible: boolean;
  enabled: boolean;
  statutoryCap: number;
  used: number;
  roomIfEnabled: number;
  room: number;
}

export function existingOf(s: FullInput): LeverAmounts {
  return { srs: s.existing.srs, cpfSelf: s.existing.cpfTopUpSelf, cpfFamily: s.existing.cpfTopUpFamily };
}

export function specLevers(s: FullInput): Record<LeverId, SpecLever> {
  const { residency, ageAtYearEnd } = s.profile;
  const citizenOrPr = residency === 'citizen' || residency === 'pr';
  const eligible: Record<LeverId, boolean> = { srs: ageAtYearEnd >= 18, cpfSelf: citizenOrPr, cpfFamily: citizenOrPr };
  const capIfEligible: LeverAmounts = {
    srs: residency === 'foreigner' ? SPEC_SRS_CAP.foreigner : SPEC_SRS_CAP.citizenPr,
    cpfSelf: SPEC_TOPUP_CAP,
    cpfFamily: SPEC_TOPUP_CAP,
  };
  const userLimit: Record<LeverId, number | null> = {
    srs: null,
    cpfSelf: s.levers.cpfSelf.roomToLimit,
    cpfFamily: s.levers.cpfFamily.maxAmount,
  };
  const existing = existingOf(s);
  const one = (lever: LeverId): SpecLever => {
    const statutoryCap = eligible[lever] ? capIfEligible[lever] : 0;
    const used = Math.min(existing[lever], statutoryCap);
    let roomIfEnabled = Math.max(0, statutoryCap - used);
    const limit = userLimit[lever];
    if (limit !== null) roomIfEnabled = Math.min(roomIfEnabled, limit);
    const enabled = s.levers[lever].enabled;
    return {
      eligible: eligible[lever],
      enabled,
      statutoryCap,
      used,
      roomIfEnabled,
      room: eligible[lever] && enabled ? roomIfEnabled : 0,
    };
  };
  return { srs: one('srs'), cpfSelf: one('cpfSelf'), cpfFamily: one('cpfFamily') };
}

// ---------------------------------------------------------------------------------------------------------------
// SPEC §6.2–§6.4 — income, reliefs, tax
// ---------------------------------------------------------------------------------------------------------------

export interface SpecTax {
  employmentIncome: number;
  employmentExpenses: number;
  otherTaxableIncome: number;
  totalIncome: number;
  donationDeduction: number;
  assessableIncome: number;
  reliefs: {
    earnedIncome: number;
    cpf: number;
    srs: number;
    cpfTopUpSelf: number;
    cpfTopUpFamily: number;
    other: number;
    totalBeforeCap: number;
    totalAllowed: number;
    lostToCap: number;
  };
  chargeableIncome: number;
  grossTax: number;
  pitRebate: number;
  taxPayable: number;
  marginalRate: number;
  effectiveRate: number;
}

export const ZERO: LeverAmounts = { srs: 0, cpfSelf: 0, cpfFamily: 0 };

/** §6.2–§6.4 with `additional` whole-dollar contributions on top of the existing ones. No year has a PIT rebate. */
export function specTax(s: FullInput, additional: LeverAmounts = ZERO): SpecTax {
  const { income, existing, profile } = s;
  const levers = specLevers(s);
  const cpf = specCpf(s).employeeContribution;

  const employmentIncome = income.monthlyOrdinaryWage * income.monthsWorked + income.additionalWages;
  const netEmployment = Math.max(0, employmentIncome - income.employmentExpenses);
  const totalIncome = netEmployment + income.otherTaxableIncome;
  // Work in half-dollars so the 250% donation deduction stays an integer.
  const assessableHalves = Math.max(0, 2 * totalIncome - 5 * income.donations);

  const eirForAge =
    profile.ageAtYearEnd < 55 ? SPEC_EIR.below55 : profile.ageAtYearEnd <= 59 ? SPEC_EIR.age55to59 : SPEC_EIR.age60plus;
  const earnedIncome = Math.min(eirForAge, netEmployment);
  const srs = Math.min(existing.srs + additional.srs, levers.srs.statutoryCap);
  const cpfTopUpSelf = Math.min(existing.cpfTopUpSelf + additional.cpfSelf, levers.cpfSelf.statutoryCap);
  const cpfTopUpFamily = Math.min(existing.cpfTopUpFamily + additional.cpfFamily, levers.cpfFamily.statutoryCap);
  const totalBeforeCap = earnedIncome + cpf + srs + cpfTopUpSelf + cpfTopUpFamily + s.otherReliefs;
  const totalAllowed = Math.min(totalBeforeCap, SPEC_RELIEF_CAP);
  const chargeableIncome = floorDiv(Math.max(0, assessableHalves - 2 * totalAllowed), 2);

  const taxPayable = specTaxCents(chargeableIncome) / 100;
  return {
    employmentIncome,
    employmentExpenses: income.employmentExpenses,
    otherTaxableIncome: income.otherTaxableIncome,
    totalIncome,
    donationDeduction: (5 * income.donations) / 2,
    assessableIncome: assessableHalves / 2,
    reliefs: {
      earnedIncome,
      cpf,
      srs,
      cpfTopUpSelf,
      cpfTopUpFamily,
      other: s.otherReliefs,
      totalBeforeCap,
      totalAllowed,
      lostToCap: totalBeforeCap - totalAllowed,
    },
    chargeableIncome,
    grossTax: taxPayable,
    pitRebate: 0,
    taxPayable,
    marginalRate: specRateOfDollar(chargeableIncome),
    effectiveRate: totalIncome === 0 ? 0 : taxPayable / totalIncome,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SPEC §6.6 — the optimiser
// ---------------------------------------------------------------------------------------------------------------

/** Walk the priority order; give each lever min(room, remaining). */
export function specAllocate(total: number, rooms: LeverAmounts, priority: readonly LeverId[]): LeverAmounts {
  const out: LeverAmounts = { srs: 0, cpfSelf: 0, cpfFamily: 0 };
  let remaining = total;
  for (const lever of priority) {
    const give = Math.min(rooms[lever], remaining);
    out[lever] = give;
    remaining -= give;
  }
  return out;
}

export interface SpecPlan {
  baseline: SpecTax;
  levers: Record<LeverId, SpecLever>;
  rooms: LeverAmounts;
  /** U */
  usefulRoom: number;
  /** C */
  reliefCapRoom: number;
  /** L */
  leverRoom: number;
  /** B (Infinity when there is no budget) */
  budget: number;
  /** X */
  total: number;
  contributions: LeverAmounts;
  optimised: SpecTax;
  taxSavedCents: number;
  bindingConstraint: BindingConstraint;
  unrealisedSavingCents: number;
  /** N(c): tax payable in cents after contributing c dollars to levers with room (relief stops at C). */
  taxCentsAfter(contribution: number): number;
}

export function specPlan(s: FullInput): SpecPlan {
  const baseline = specTax(s);
  const levers = specLevers(s);
  const rooms: LeverAmounts = { srs: levers.srs.room, cpfSelf: levers.cpfSelf.room, cpfFamily: levers.cpfFamily.room };
  const ci0 = baseline.chargeableIncome;

  const usefulRoom = specUsefulRoom(ci0, s.preferences.minSavingRate);
  const reliefCapRoom = Math.max(0, SPEC_RELIEF_CAP - baseline.reliefs.totalBeforeCap);
  const leverRoom = rooms.srs + rooms.cpfSelf + rooms.cpfFamily;
  const budget = s.preferences.cashBudget === null ? Infinity : s.preferences.cashBudget;
  const total = Math.min(usefulRoom, reliefCapRoom, leverRoom, budget);

  const taxCentsAfter = (contribution: number): number =>
    specTaxCents(Math.max(0, ci0 - Math.min(contribution, reliefCapRoom)));

  const contributions = specAllocate(total, rooms, s.preferences.priority);
  const optimised = specTax(s, contributions);
  const baseCents = specTaxCents(ci0);

  let bindingConstraint: BindingConstraint;
  if (baseCents === 0) bindingConstraint = 'none';
  else if (usefulRoom === total) bindingConstraint = 'usefulRoom';
  else if (reliefCapRoom === total) bindingConstraint = 'reliefCap';
  else if (leverRoom === total) bindingConstraint = 'leverLimits';
  else bindingConstraint = 'cashBudget';

  return {
    baseline,
    levers,
    rooms,
    usefulRoom,
    reliefCapRoom,
    leverRoom,
    budget,
    total,
    contributions,
    optimised,
    taxSavedCents: baseCents - specTaxCents(optimised.chargeableIncome),
    bindingConstraint,
    unrealisedSavingCents: taxCentsAfter(total) - taxCentsAfter(Math.min(usefulRoom, reliefCapRoom)),
    taxCentsAfter,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SPEC §6.10 — dates
// ---------------------------------------------------------------------------------------------------------------

/** Days since the Unix epoch of a civil date (proleptic Gregorian), via the platform's UTC calendar. */
function epochDay(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.round(date.getTime() / 86_400_000);
}

export interface SpecDates {
  deadline: string;
  daysToDeadline: number;
  monthsRemaining: number;
}

/** §6.10 for a sanitised `today` (a valid `YYYY-MM-DD`). */
export function specDates(incomeYear: number, today: string): SpecDates {
  const date = specParseDate(today);
  if (!date) throw new RangeError(`specModel: not a date: ${today}`);
  const monthsRemaining = date.year < incomeYear ? 12 : date.year > incomeYear ? 0 : 12 - date.month + 1;
  return {
    deadline: `${incomeYear}-12-31`,
    daysToDeadline: epochDay(incomeYear, 12, 31) - epochDay(date.year, date.month, date.day),
    monthsRemaining,
  };
}

/** Money in dollars (at most two decimals) as whole cents. */
export function cents(dollars: number): number {
  return Math.round(dollars * 100);
}
