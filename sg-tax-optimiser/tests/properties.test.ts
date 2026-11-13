/**
 * Property tests (SPEC §10) by an independent test author.
 *
 * Every property runs at least 300 times on inputs from `tests/support/generators.ts` with a fixed seed, so a
 * failure reproduces. Expected values are recomputed in the test — from the engine's own outputs where the
 * property is an invariant, and from `tests/support/specModel.ts` (a separate transcription of SPEC §5–§6) where
 * it is a figure — never by calling the engine code under test to predict itself.
 *
 * Environment overrides for deeper runs:  PROP_RUNS=4000 PROP_SEED=7 npx vitest run tests/properties.test.ts
 * (Very long runs can make Vitest report a worker "Timeout calling onTaskUpdate" error although every test passes.)
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_INCOME_YEARS,
  computeCpf,
  defaultIncomeYear,
  defaultInput,
  evaluate,
  getRules,
  grossTax,
  marginalRate,
  plan,
  sanitiseInput,
} from '../src/engine';
import type { LeverAmounts, LeverId, PlannerInput, PlannerResult, YearRules } from '../src/engine';
import { planFor } from '../src/engine/plan';
import { sanitise } from '../src/engine/sanitise';
import {
  BRACKET_BOUNDARIES,
  MIN_SAVING_RATES,
  PRIORITY_PERMUTATIONS,
  chargeableIncomeArb,
  garbageInputArb,
  messyInputArb,
  plannerInputArb,
  seededInputs,
  seededMessyInputs,
  withPreferences,
} from './support/generators';
import {
  LEVERS,
  SPEC_ANNUAL_WAGE_CEILING,
  SPEC_BAND_MAX_AGE,
  SPEC_BRACKETS,
  SPEC_EIR,
  SPEC_FULL_EMPLOYEE_MILLE,
  SPEC_FULL_EMPLOYER_MILLE,
  SPEC_MATCHED_TOPUP,
  SPEC_MAX_COMPULSORY_CPF,
  SPEC_MAX_MONEY,
  SPEC_OW_CEILING,
  SPEC_PAYOUT_ELIGIBILITY_AGE,
  SPEC_PR1_EMPLOYEE_MILLE,
  SPEC_PR2_EMPLOYEE_MILLE,
  SPEC_RELIEF_CAP,
  SPEC_SRS_CAP,
  SPEC_SUMS,
  SPEC_TOPUP_CAP,
  SPEC_WARNINGS,
  SPEC_YEARS,
  ZERO,
  cents,
  existingOf,
  isSpecYear,
  specAllocate,
  specCpf,
  specDates,
  specLevers,
  specPlan,
  specRateOfDollar,
  specRoomProvided,
  specSanitise,
  specTax,
  specTaxCents,
  specUsefulRoom,
} from './support/specModel';
import type { FullInput, SpecPlan, SpecYear } from './support/specModel';

// ---------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && process.env[name] !== undefined && process.env[name] !== '' ? parsed : fallback;
}

/** Fixed base seed: every property derives its own seed from this and its name. */
const BASE_SEED = envInt('PROP_SEED', 20_261_113);
/** Runs per property (never fewer than 300). */
const RUNS = Math.max(300, envInt('PROP_RUNS', 500));

function seedFor(name: string): number {
  let hash = BASE_SEED | 0;
  for (let i = 0; i < name.length; i++) hash = (Math.imul(hash, 31) + name.charCodeAt(i)) | 0;
  return hash;
}

/** Register one property as a Vitest test. `scale` shrinks the run count of expensive properties (floor 300). */
function prop<T>(name: string, arbitrary: fc.Arbitrary<T>, check: (value: T) => void, scale = 1): void {
  it(name, () => {
    fc.assert(
      fc.property(arbitrary, (value) => {
        check(value);
      }),
      { seed: seedFor(name), numRuns: Math.max(300, Math.round(RUNS * scale)) },
    );
  });
}

/** Collects failed checks so that hot loops do not pay for an `expect` per element. */
class Problems {
  private readonly list: string[] = [];
  check(ok: boolean, message: () => string): void {
    if (!ok && this.list.length < 25) this.list.push(message());
  }
  eq(actual: unknown, expected: unknown, what: string): void {
    this.check(Object.is(actual, expected), () => `${what}: got ${String(actual)}, expected ${String(expected)}`);
  }
  done(): void {
    if (this.list.length > 0) throw new Error(`${this.list.length} problem(s):\n  ${this.list.join('\n  ')}`);
  }
}

const zeros = (): LeverAmounts => ({ srs: 0, cpfSelf: 0, cpfFamily: 0 });
const sum = (amounts: LeverAmounts): number => amounts.srs + amounts.cpfSelf + amounts.cpfFamily;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** True when a dollar amount has at most two decimals. */
const isCents = (value: number): boolean => Number.isFinite(value) && Number(value.toFixed(2)) === value;

interface Case {
  input: PlannerInput;
  r: PlannerResult;
  /** The input as SPEC §6.0 sanitises it, by the test's own sanitiser. */
  s: FullInput;
  /** SPEC §6.6 recomputed by the test's own model. */
  m: SpecPlan;
}

function run(input: PlannerInput): Case {
  const s = specSanitise(input);
  return { input, r: plan(input), s, m: specPlan(s) };
}

const RATE_SET = new Set(SPEC_BRACKETS.map((band) => band.rate));

/** Every number finite; dollars whole and non-negative; tax figures in whole cents; rates in range. */
function assertWellFormed(r: PlannerResult): void {
  const p = new Problems();
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'number') {
      p.check(Number.isFinite(value), () => `${path} is ${value}`);
      p.check(!Object.is(value, -0), () => `${path} is -0`);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`);
    }
  };
  const { rules: _rules, ...rest } = r;
  visit(rest, '$');

  const dollars = (value: number, path: string): void =>
    p.check(Number.isInteger(value) && value >= 0, () => `${path} = ${value} is not a non-negative whole dollar amount`);
  const tax = (value: number, path: string): void =>
    p.check(isCents(value) && value >= 0, () => `${path} = ${value} is not a non-negative amount in whole cents`);
  const rate = (value: number, path: string, max = 0.24): void =>
    p.check(value >= 0 && value <= max + 1e-12, () => `${path} = ${value} is outside 0…${max}`);
  const amounts = (value: LeverAmounts, path: string): void => {
    for (const lever of LEVERS) dollars(value[lever], `${path}.${lever}`);
    p.check(Object.keys(value).sort().join() === [...LEVERS].sort().join(), () => `${path} has keys ${Object.keys(value).join()}`);
  };

  for (const key of ['ordinaryWagesSubject', 'additionalWageCeiling', 'additionalWagesSubject', 'employeeContribution', 'employerContribution'] as const) {
    dollars(r.cpf[key], `cpf.${key}`);
  }
  p.eq(r.cpf.monthlyEmployeeRates.length, 12, 'cpf.monthlyEmployeeRates.length');
  r.cpf.monthlyEmployeeRates.forEach((value, index) => rate(value, `cpf.monthlyEmployeeRates[${index}]`, 0.2));

  for (const which of ['baseline', 'optimised'] as const) {
    const t = r[which];
    for (const key of ['employmentIncome', 'employmentExpenses', 'otherTaxableIncome', 'totalIncome', 'chargeableIncome'] as const) {
      dollars(t[key], `${which}.${key}`);
    }
    for (const [key, value] of Object.entries(t.reliefs)) dollars(value, `${which}.reliefs.${key}`);
    for (const key of ['donationDeduction', 'assessableIncome'] as const) {
      p.check(Number.isInteger(t[key] * 2) && t[key] >= 0, () => `${which}.${key} = ${t[key]} is not a multiple of S$0.50`);
    }
    for (const key of ['grossTax', 'pitRebate', 'taxPayable'] as const) tax(t[key], `${which}.${key}`);
    p.check(RATE_SET.has(t.marginalRate), () => `${which}.marginalRate = ${t.marginalRate} is not a bracket rate`);
    rate(t.effectiveRate, `${which}.effectiveRate`);
  }

  for (const lever of LEVERS) {
    dollars(r.levers[lever].statutoryCap, `levers.${lever}.statutoryCap`);
    dollars(r.levers[lever].used, `levers.${lever}.used`);
    dollars(r.levers[lever].room, `levers.${lever}.room`);
    p.check(typeof r.levers[lever].eligible === 'boolean' && typeof r.levers[lever].enabled === 'boolean', () => `levers.${lever} flags`);
  }
  dollars(r.reliefCapRoom, 'reliefCapRoom');

  amounts(r.plan.contributions, 'plan.contributions');
  dollars(r.plan.totalContribution, 'plan.totalContribution');
  dollars(r.plan.chargeableIncomeBefore, 'plan.chargeableIncomeBefore');
  dollars(r.plan.chargeableIncomeAfter, 'plan.chargeableIncomeAfter');
  for (const key of ['taxBefore', 'taxAfter', 'taxSaved', 'unrealisedSaving'] as const) tax(r.plan[key], `plan.${key}`);
  rate(r.plan.savingRate, 'plan.savingRate');
  p.check(RATE_SET.has(r.plan.marginalRateBefore) && RATE_SET.has(r.plan.marginalRateAfter), () => 'plan.marginalRate*');

  r.ladder.forEach((tier, index) => {
    for (const key of ['fromContribution', 'toContribution', 'amount', 'usedByPlan'] as const) dollars(tier[key], `ladder[${index}].${key}`);
    tax(tier.taxSaved, `ladder[${index}].taxSaved`);
    tax(tier.cumulativeTaxSaved, `ladder[${index}].cumulativeTaxSaved`);
    p.check(RATE_SET.has(tier.rate), () => `ladder[${index}].rate = ${tier.rate} is not a bracket rate`);
  });
  r.simulator.forEach((row, index) => {
    dollars(row.contribution, `simulator[${index}].contribution`);
    amounts(row.split, `simulator[${index}].split`);
    for (const key of ['taxPayable', 'taxSaved', 'stepSaving'] as const) tax(row[key], `simulator[${index}].${key}`);
    rate(row.stepRate, `simulator[${index}].stepRate`, 0.245);
  });
  r.scenarios.forEach((scenario, index) => {
    amounts(scenario.contributions, `scenarios[${index}].contributions`);
    dollars(scenario.totalContribution, `scenarios[${index}].totalContribution`);
    dollars(scenario.wastedContribution, `scenarios[${index}].wastedContribution`);
    tax(scenario.taxPayable, `scenarios[${index}].taxPayable`);
    tax(scenario.taxSaved, `scenarios[${index}].taxSaved`);
    rate(scenario.savingRate, `scenarios[${index}].savingRate`);
  });

  p.check(Number.isInteger(r.monthlyPlan.daysToDeadline), () => `monthlyPlan.daysToDeadline = ${r.monthlyPlan.daysToDeadline}`);
  dollars(r.monthlyPlan.monthsRemaining, 'monthlyPlan.monthsRemaining');
  r.monthlyPlan.schedule.forEach((row, index) => {
    amounts(row.amounts, `monthlyPlan.schedule[${index}].amounts`);
    dollars(row.total, `monthlyPlan.schedule[${index}].total`);
  });
  for (const key of [...LEVERS, 'total'] as const) dollars(r.monthlyPlan.fullYearMonthly[key], `monthlyPlan.fullYearMonthly.${key}`);
  p.done();
}

// ---------------------------------------------------------------------------------------------------------------
// The rule data and the test's own model, anchored to the SPEC text
// ---------------------------------------------------------------------------------------------------------------

describe('rule data matches SPEC §5 (independent transcription)', () => {
  it('supports exactly income years 2025, 2026 and 2027', () => {
    expect(SUPPORTED_INCOME_YEARS).toEqual([...SPEC_YEARS]);
    for (const year of [2024, 2028, 2026.5, Number.NaN, 0, -2026]) expect(() => getRules(year)).toThrow();
  });

  it.each([...SPEC_YEARS])('income year %i', (year) => {
    const rules = getRules(year);
    expect(rules.incomeYear).toBe(year);
    expect(rules.ya).toBe(year + 1);
    expect(rules.status).toBe(year === 2027 ? 'projected' : 'final');
    expect(rules.contributionDeadline).toBe(`${year}-12-31`);

    // §5.1
    expect(rules.taxBrackets).toEqual(SPEC_BRACKETS.map(({ from, rate }) => ({ from, rate })));
    expect(rules.pitRebate).toBeNull();
    // §5.2
    expect(rules.personalReliefCap).toBe(SPEC_RELIEF_CAP);
    expect(rules.earnedIncomeRelief).toEqual(SPEC_EIR);
    expect(rules.donationDeductionMultiplier).toBe(2.5);
    // §5.3
    expect(rules.cpf.owCeilingMonthly).toBe(SPEC_OW_CEILING[year]);
    expect(rules.cpf.annualWageCeiling).toBe(SPEC_ANNUAL_WAGE_CEILING);
    expect(rules.cpf.employeeNilUpTo).toBe(500);
    expect(rules.cpf.phaseInUpTo).toBe(750);
    const specBand = (age: number): number => {
      const index = SPEC_BAND_MAX_AGE.findIndex((maxAge) => maxAge === null || age < maxAge);
      return index < 0 ? SPEC_BAND_MAX_AGE.length - 1 : index;
    };
    for (let completedAge = 0; completedAge <= 120; completedAge++) {
      const lookup = (table: YearRules['cpf']['fullRates']) => {
        const band = table.find((candidate) => candidate.maxAge === null || completedAge < candidate.maxAge);
        if (!band) throw new Error(`no CPF band for age ${completedAge}`);
        return band;
      };
      const index = specBand(completedAge);
      const fullBand = lookup(rules.cpf.fullRates);
      expect(fullBand.employeeRate, `full employee rate at ${completedAge}`).toBe(SPEC_FULL_EMPLOYEE_MILLE[year][index]! / 1000);
      expect(fullBand.employerRate, `full employer rate at ${completedAge}`).toBe(SPEC_FULL_EMPLOYER_MILLE[year][index]! / 1000);
      expect(lookup(rules.cpf.prYear1Rates).employeeRate, `PR year 1 at ${completedAge}`).toBe(SPEC_PR1_EMPLOYEE_MILLE[index]! / 1000);
      expect(lookup(rules.cpf.prYear2Rates).employeeRate, `PR year 2 at ${completedAge}`).toBe(SPEC_PR2_EMPLOYEE_MILLE[index]! / 1000);
      for (const table of [rules.cpf.fullRates, rules.cpf.prYear1Rates, rules.cpf.prYear2Rates]) {
        const band = lookup(table);
        // "factor = 3 × employee rate, so it meets the full rate exactly at S$750"
        expect(Math.round(band.phaseInFactor * 1e6)).toBe(Math.round(band.employeeRate * 3e6));
      }
    }
    // §5.4
    expect(rules.srs.capCitizenPr).toBe(SPEC_SRS_CAP.citizenPr);
    expect(rules.srs.capForeigner).toBe(SPEC_SRS_CAP.foreigner);
    expect(rules.srs.minAge).toBe(18);
    expect(rules.cpfTopUp.selfReliefCap).toBe(SPEC_TOPUP_CAP);
    expect(rules.cpfTopUp.familyReliefCap).toBe(SPEC_TOPUP_CAP);
    expect(rules.cpfTopUp.fullRetirementSum).toBe(SPEC_SUMS[year].frs);
    expect(rules.cpfTopUp.enhancedRetirementSum).toBe(SPEC_SUMS[year].ers);
    expect(rules.cpfTopUp.basicHealthcareSum).toBe(SPEC_SUMS[year].bhs);
    expect([...rules.cpfTopUp.familyGiverResidency].sort()).toEqual(['citizen', 'pr']);
    // §5.4: the matched part of a top-up (no relief for the giver) and the payout eligibility age
    expect(rules.cpfTopUp.matchedTopUps).toEqual({
      retirementAnnualCap: SPEC_MATCHED_TOPUP[year].retirement,
      mediSaveAnnualCap: SPEC_MATCHED_TOPUP[year].mediSave,
    });
    expect(rules.cpfTopUp.payoutEligibilityAge).toBe(SPEC_PAYOUT_ELIGIBILITY_AGE);
  });

  it('§5.4 figures typed here a second time: matched top-ups 2,000 / 1,000 (MediSave from 2026), payouts from 65', () => {
    expect(SPEC_YEARS.map((year) => getRules(year).cpfTopUp.matchedTopUps.retirementAnnualCap)).toEqual([2_000, 2_000, 2_000]);
    expect(SPEC_YEARS.map((year) => getRules(year).cpfTopUp.matchedTopUps.mediSaveAnnualCap)).toEqual([null, 1_000, 1_000]);
    expect(SPEC_YEARS.map((year) => getRules(year).cpfTopUp.payoutEligibilityAge)).toEqual([65, 65, 65]);
    expect(SPEC_YEARS.map((year) => getRules(year).cpfTopUp.fullRetirementSum)).toEqual([213_000, 220_400, 228_200]);
    expect(SPEC_YEARS.map((year) => getRules(year).cpfTopUp.enhancedRetirementSum)).toEqual([426_000, 440_800, 456_400]);
  });
});

/** A complete input; `over` replaces whole sections' fields. */
function example(over: {
  incomeYear?: number;
  profile?: Partial<FullInput['profile']>;
  income?: Partial<FullInput['income']>;
  existing?: Partial<FullInput['existing']>;
  otherReliefs?: number;
  srs?: boolean;
  cpfSelf?: Partial<FullInput['levers']['cpfSelf']>;
  cpfFamily?: Partial<FullInput['levers']['cpfFamily']>;
  preferences?: Partial<FullInput['preferences']>;
}): FullInput {
  const incomeYear = over.incomeYear ?? 2026;
  return {
    incomeYear,
    today: `${incomeYear}-11-13`,
    profile: {
      residency: 'citizen',
      prYear: 3,
      ageAtYearEnd: 35,
      birthMonth: 12,
      hasUnusedParenthoodTaxRebate: false,
      ...over.profile,
    },
    income: {
      monthlyOrdinaryWage: 10_000,
      monthsWorked: 12,
      additionalWages: 15_000,
      otherTaxableIncome: 0,
      employmentExpenses: 0,
      donations: 0,
      employeeCpfOverride: null,
      ...over.income,
    },
    existing: { srs: 0, cpfTopUpSelf: 0, cpfTopUpFamily: 0, ...over.existing },
    otherReliefs: over.otherReliefs ?? 0,
    levers: {
      srs: { enabled: over.srs ?? true },
      cpfSelf: { enabled: true, roomToLimit: null, ...over.cpfSelf },
      cpfFamily: { enabled: false, maxAmount: null, ...over.cpfFamily },
    },
    preferences: {
      cashBudget: null,
      minSavingRate: 0.07,
      priority: ['srs', 'cpfSelf', 'cpfFamily'],
      simulatorStep: 1_000,
      ...over.preferences,
    },
  };
}

describe('worked examples (SPEC Appendix A and B, and the test author\'s own): the test model and the engine agree with the hand figures', () => {
  /** The figures both implementations must give for one worked example. */
  interface Expected {
    cpf: number;
    reliefs: number;
    chargeableIncome: number;
    tax: number;
    total?: number;
    binding?: string;
    contributions?: LeverAmounts;
    taxAfter?: number;
    taxSaved?: number;
    unrealised?: number;
    assessable?: number;
    /** Warning codes in the order of the §6.11 table (the examples are dated 13 November: no deadline warning). */
    warnings?: string[];
  }
  /** Appendix A.2 with the CPF (self) room given or left blank (A.2b). */
  const a2 = (roomToLimit: number | null): FullInput =>
    example({
      profile: { residency: 'pr', prYear: 3, ageAtYearEnd: 57, birthMonth: 6 },
      income: { monthlyOrdinaryWage: 14_000, additionalWages: 40_000 },
      existing: { srs: 5_000 },
      otherReliefs: 30_000,
      cpfSelf: { roomToLimit },
      cpfFamily: { enabled: true, maxAmount: 8_000 },
      preferences: { cashBudget: 20_000, minSavingRate: 0, priority: ['cpfSelf', 'srs', 'cpfFamily'] },
    });
  const cases: [string, FullInput, Expected][] = [
    [
      'A.1 the opening example',
      example({ otherReliefs: 5_000 }),
      {
        cpf: 20_400,
        reliefs: 26_400,
        chargeableIncome: 108_600,
        tax: 6_639,
        total: 23_300,
        binding: 'leverLimits',
        contributions: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 },
        taxAfter: 3_959.5,
        taxSaved: 2_679.5,
        unrealised: 2_359.5,
        warnings: ['LEVER_LIMITS_PLAN'],
      },
    ],
    [
      'A.2 older PR (room of 50,000 entered), budget, relief cap in play',
      a2(50_000),
      {
        cpf: 18_360,
        reliefs: 59_360,
        chargeableIncome: 148_640,
        tax: 12_246,
        total: 20_000,
        binding: 'cashBudget',
        contributions: { srs: 10_300, cpfSelf: 8_000, cpfFamily: 1_700 },
        taxAfter: 9_246,
        taxSaved: 3_000,
        unrealised: 96,
        warnings: ['BUDGET_LIMITS_PLAN', 'AGE_55_PLUS_TOPUP', 'FAMILY_TOPUP_CHECKS'],
      },
    ],
    [
      'A.2b the same person with the CPF room left blank: own CPF is left out',
      // L = 10,300 + 0 + 8,000 = 18,300; chargeable income after 130,340 -> 7,950 + 15% × 10,340 = 9,501
      a2(null),
      {
        cpf: 18_360,
        reliefs: 59_360,
        chargeableIncome: 148_640,
        tax: 12_246,
        total: 18_300,
        binding: 'leverLimits',
        contributions: { srs: 10_300, cpfSelf: 0, cpfFamily: 8_000 },
        taxAfter: 9_501,
        taxSaved: 2_745,
        unrealised: 351, // down to 128,000 (the relief cap): 9,501 − 9,150
        warnings: ['LEVER_LIMITS_PLAN', 'CPF_SELF_ROOM_UNCONFIRMED', 'FAMILY_TOPUP_CHECKS'],
      },
    ],
    [
      'A.3 lower income, 7% minimum: nothing recommended',
      example({ profile: { ageAtYearEnd: 28 }, income: { monthlyOrdinaryWage: 3_500, additionalWages: 3_500 } }),
      {
        cpf: 9_100,
        reliefs: 10_100,
        chargeableIncome: 35_400,
        tax: 389,
        total: 0,
        binding: 'usefulRoom',
        contributions: { srs: 0, cpfSelf: 0, cpfFamily: 0 },
        taxAfter: 389,
        taxSaved: 0,
        unrealised: 0,
      },
    ],
    [
      'A.3 lower income, any saving',
      example({
        profile: { ageAtYearEnd: 28 },
        income: { monthlyOrdinaryWage: 3_500, additionalWages: 3_500 },
        preferences: { minSavingRate: 0 },
      }),
      {
        cpf: 9_100,
        reliefs: 10_100,
        chargeableIncome: 35_400,
        tax: 389,
        total: 15_400,
        binding: 'usefulRoom',
        contributions: { srs: 15_300, cpfSelf: 100, cpfFamily: 0 },
        taxAfter: 0,
        taxSaved: 389,
        unrealised: 0,
      },
    ],
    [
      'B IRAS sample, YA2026, Mr Heng',
      example({
        incomeYear: 2025,
        income: { monthlyOrdinaryWage: 4_000, additionalWages: 2_000, donations: 100 },
        otherReliefs: 4_000,
      }),
      { cpf: 10_000, reliefs: 15_000, chargeableIncome: 34_750, tax: 366.25, assessable: 49_750 },
    ],
    [
      'B IRAS sample, YA2026, the 250,000-dollar earner aged 66–70',
      example({
        incomeYear: 2025,
        profile: { ageAtYearEnd: 67 },
        income: { monthlyOrdinaryWage: 19_000, additionalWages: 22_000, donations: 100 },
      }),
      { cpf: 7_650, reliefs: 15_650, chargeableIncome: 234_100, tax: 27_629, assessable: 249_750 },
    ],
    [
      'B CPF Board 2025: 9,000 a month with a 20,000 bonus',
      example({ incomeYear: 2025, income: { monthlyOrdinaryWage: 9_000, additionalWages: 20_000 } }),
      // 1,480 × 12 + 20% × 13,200 = 20,400; income 128,000; reliefs 21,400; CI 106,600; tax 3,350 + 11.5% × 26,600
      { cpf: 20_400, reliefs: 21_400, chargeableIncome: 106_600, tax: 6_409 },
    ],
    // ---- Worked by the test author from SPEC §5–§6 (not in the Appendix): one boundary each. ----
    [
      'H1 turns 55 in March: three months at 20%, nine at 18%, bonus at the December rate; CPF room entered',
      // CPF 3 × 1,200 + 9 × 1,080 + 18% × 12,000 = 15,480; EIR 6,000; CI 84,000 − 21,480 = 62,520; tax 550 + 7% × 22,520
      example({
        profile: { ageAtYearEnd: 55, birthMonth: 3 },
        income: { monthlyOrdinaryWage: 6_000, additionalWages: 12_000 },
        cpfSelf: { roomToLimit: 8_000 },
      }),
      {
        cpf: 15_480,
        reliefs: 21_480,
        chargeableIncome: 62_520,
        tax: 2_126.4,
        total: 22_520,
        binding: 'usefulRoom',
        contributions: { srs: 15_300, cpfSelf: 7_220, cpfFamily: 0 },
        taxAfter: 550,
        taxSaved: 1_576.4,
        unrealised: 0,
        warnings: ['AGE_55_PLUS_TOPUP'],
      },
    ],
    [
      'H1b the same person with the CPF room left blank (SPEC §6.5): SRS only, the rest of the 7% band is out of reach',
      // L = 15,300; CI after 47,220 -> 550 + 7% × 7,220 = 1,055.40; unrealised down to 40,000: 1,055.40 − 550
      example({ profile: { ageAtYearEnd: 55, birthMonth: 3 }, income: { monthlyOrdinaryWage: 6_000, additionalWages: 12_000 } }),
      {
        cpf: 15_480,
        reliefs: 21_480,
        chargeableIncome: 62_520,
        tax: 2_126.4,
        total: 15_300,
        binding: 'leverLimits',
        contributions: { srs: 15_300, cpfSelf: 0, cpfFamily: 0 },
        taxAfter: 1_055.4,
        taxSaved: 1_071,
        unrealised: 505.4,
        warnings: ['LEVER_LIMITS_PLAN', 'CPF_SELF_ROOM_UNCONFIRMED'],
      },
    ],
    [
      'H2 second-year PR aged 62 in 2027: 7.5% employee rate, EIR 8,000',
      // CPF 375 × 12 = 4,500; CI 60,000 − 12,500 = 47,500; tax 550 + 7% × 7,500; U = 7,500
      example({ incomeYear: 2027, profile: { residency: 'pr', prYear: 2, ageAtYearEnd: 62 }, income: { monthlyOrdinaryWage: 5_000, additionalWages: 0 } }),
      {
        cpf: 4_500,
        reliefs: 12_500,
        chargeableIncome: 47_500,
        tax: 1_075,
        total: 7_500,
        binding: 'usefulRoom',
        contributions: { srs: 7_500, cpfSelf: 0, cpfFamily: 0 },
        taxAfter: 550,
        taxSaved: 525,
        unrealised: 0,
      },
    ],
    [
      'H3 wage in the phase-in range (700 a month) with other income',
      // CPF floor(0.6 × 200) × 12 = 1,440; CI 68,400 − 2,440 = 65,960; tax 550 + 7% × 25,960; after 23,300: 550 + 7% × 2,660
      example({ profile: { ageAtYearEnd: 30 }, income: { monthlyOrdinaryWage: 700, additionalWages: 0, otherTaxableIncome: 60_000 } }),
      {
        cpf: 1_440,
        reliefs: 2_440,
        chargeableIncome: 65_960,
        tax: 2_367.2,
        total: 23_300,
        binding: 'leverLimits',
        contributions: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 },
        taxAfter: 736.2,
        taxSaved: 1_631,
        unrealised: 186.2,
      },
    ],
    [
      'H4 foreigner with 10,000 already in SRS: cap 35,700, no CPF, plan spans the 20% and 19.5% brackets',
      // CI 300,000 − 1,000 − 10,000 = 289,000; tax 36,550 + 20% × 9,000; after 25,700: 28,750 + 19.5% × 23,300
      example({
        profile: { residency: 'foreigner', ageAtYearEnd: 40 },
        income: { monthlyOrdinaryWage: 20_000, additionalWages: 60_000 },
        existing: { srs: 10_000 },
        preferences: { minSavingRate: 0 },
      }),
      {
        cpf: 0,
        reliefs: 11_000,
        chargeableIncome: 289_000,
        tax: 38_350,
        total: 25_700,
        binding: 'leverLimits',
        contributions: { srs: 25_700, cpfSelf: 0, cpfFamily: 0 },
        taxAfter: 33_293.5,
        taxSaved: 5_056.5,
        unrealised: 8_343.5, // down to 220,000 (the relief cap): 33,293.50 − 24,950
      },
    ],
    [
      'H5 the 80,000 overall relief cap stops the plan after 4,800',
      // reliefs 1,000 + 19,200 + 55,000 = 75,200; CI 284,800; tax 36,550 + 20% × 4,800
      example({
        profile: { ageAtYearEnd: 45 },
        income: { monthlyOrdinaryWage: 30_000, additionalWages: 0 },
        otherReliefs: 55_000,
        cpfFamily: { enabled: true },
        preferences: { minSavingRate: 0 },
      }),
      {
        cpf: 19_200,
        reliefs: 75_200,
        chargeableIncome: 284_800,
        tax: 37_510,
        total: 4_800,
        binding: 'reliefCap',
        contributions: { srs: 4_800, cpfSelf: 0, cpfFamily: 0 },
        taxAfter: 36_550,
        taxSaved: 960,
        unrealised: 0,
      },
    ],
    [
      'H6 an odd donation: assessable income ends in .50 and chargeable income is rounded down',
      // 333 × 2.5 = 832.50; assessable 59,167.50; CI floor(46,167.50) = 46,167; tax 550 + 7% × 6,167 = 981.69
      example({ income: { monthlyOrdinaryWage: 5_000, additionalWages: 0, donations: 333 } }),
      {
        cpf: 12_000,
        reliefs: 13_000,
        chargeableIncome: 46_167,
        tax: 981.69,
        assessable: 59_167.5,
        total: 6_167,
        binding: 'usefulRoom',
        contributions: { srs: 6_167, cpfSelf: 0, cpfFamily: 0 },
        taxAfter: 550,
        taxSaved: 431.69,
        unrealised: 0,
      },
    ],
    [
      'H7 five months worked in 2025: OW ceiling 7,400, AW ceiling 102,000 − 37,000',
      // CPF 1,480 × 5 + 20% × 65,000 = 20,400; CI 125,000 − 21,400 = 103,600; tax 3,350 + 11.5% × 23,600
      example({ incomeYear: 2025, income: { monthlyOrdinaryWage: 9_000, monthsWorked: 5, additionalWages: 80_000 } }),
      {
        cpf: 20_400,
        reliefs: 21_400,
        chargeableIncome: 103_600,
        tax: 6_064,
        total: 23_300,
        binding: 'leverLimits',
        contributions: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 },
        taxAfter: 3_384.5,
        taxSaved: 2_679.5,
        unrealised: 2_484.5, // down to 45,000 (the relief cap): 3,384.50 − 900
      },
    ],
    [
      'H8 turns 70 in June: six months at 7.5%, six at 5%; 3.5% bracket is below the 7% minimum',
      // CPF 300 × 6 + 200 × 6 = 3,000; EIR 8,000; CI 48,000 − 11,000 = 37,000; tax 200 + 3.5% × 7,000
      example({ profile: { ageAtYearEnd: 70, birthMonth: 6 }, income: { monthlyOrdinaryWage: 4_000, additionalWages: 0 } }),
      {
        cpf: 3_000,
        reliefs: 11_000,
        chargeableIncome: 37_000,
        tax: 445,
        total: 0,
        binding: 'usefulRoom',
        contributions: { srs: 0, cpfSelf: 0, cpfFamily: 0 },
        taxAfter: 445,
        taxSaved: 0,
        unrealised: 0,
      },
    ],
    [
      'H9 aged 17: no SRS; the CPF top-up alone takes chargeable income down to 20,000',
      // CPF 600 × 12; CI 36,000 − 8,200 = 27,800; tax 2% × 7,800
      example({ profile: { ageAtYearEnd: 17 }, income: { monthlyOrdinaryWage: 3_000, additionalWages: 0 }, preferences: { minSavingRate: 0 } }),
      {
        cpf: 7_200,
        reliefs: 8_200,
        chargeableIncome: 27_800,
        tax: 156,
        total: 7_800,
        binding: 'usefulRoom',
        contributions: { srs: 0, cpfSelf: 7_800, cpfFamily: 0 },
        taxAfter: 0,
        taxSaved: 156,
        unrealised: 0,
      },
    ],
    [
      'H10 CPF override above the maximum is capped at 20,400',
      // CI 135,000 − 21,400 = 113,600; tax 3,350 + 11.5% × 33,600; after 23,300: 3,350 + 11.5% × 10,300
      example({ income: { employeeCpfOverride: 25_000 } }),
      {
        cpf: 20_400,
        reliefs: 21_400,
        chargeableIncome: 113_600,
        tax: 7_214,
        total: 23_300,
        binding: 'leverLimits',
        contributions: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 },
        taxAfter: 4_534.5,
        taxSaved: 2_679.5,
        unrealised: 2_934.5, // down to 55,000 (the relief cap): 4,534.50 − 1,600
      },
    ],
    [
      'H12 the A.1 person at 55 (birth month 12: still 20% CPF) with the CPF room left blank',
      // EIR 6,000: reliefs 31,400; CI 103,600; tax 3,350 + 11.5% × 23,600; after 15,300: 3,350 + 11.5% × 8,300
      example({ profile: { ageAtYearEnd: 55 }, otherReliefs: 5_000 }),
      {
        cpf: 20_400,
        reliefs: 31_400,
        chargeableIncome: 103_600,
        tax: 6_064,
        total: 15_300,
        binding: 'leverLimits',
        contributions: { srs: 15_300, cpfSelf: 0, cpfFamily: 0 },
        taxAfter: 4_304.5,
        taxSaved: 1_759.5,
        unrealised: 2_704.5, // down to 55,000 (the relief cap): 4,304.50 − 1,600
        warnings: ['LEVER_LIMITS_PLAN', 'CPF_SELF_ROOM_UNCONFIRMED'],
      },
    ],
    [
      'H13 the same person with 3,000 of room entered',
      // after 18,300: CI 85,300 -> 3,350 + 11.5% × 5,300 = 3,959.50
      example({ profile: { ageAtYearEnd: 55 }, otherReliefs: 5_000, cpfSelf: { roomToLimit: 3_000 } }),
      {
        cpf: 20_400,
        reliefs: 31_400,
        chargeableIncome: 103_600,
        tax: 6_064,
        total: 18_300,
        binding: 'leverLimits',
        contributions: { srs: 15_300, cpfSelf: 3_000, cpfFamily: 0 },
        taxAfter: 3_959.5,
        taxSaved: 2_104.5,
        unrealised: 2_359.5, // 3,959.50 − 1,600
        warnings: ['LEVER_LIMITS_PLAN', 'AGE_55_PLUS_TOPUP'],
      },
    ],
    [
      'H14 one year younger (54) the blank room does not bind: the A.1 plan',
      example({ profile: { ageAtYearEnd: 54 }, otherReliefs: 5_000 }),
      {
        cpf: 20_400,
        reliefs: 26_400,
        chargeableIncome: 108_600,
        tax: 6_639,
        total: 23_300,
        binding: 'leverLimits',
        contributions: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 },
        taxAfter: 3_959.5,
        taxSaved: 2_679.5,
        unrealised: 2_359.5,
        warnings: ['LEVER_LIMITS_PLAN'],
      },
    ],
    [
      'H15 foreigner who worked 6 months, PTR ticked: SRS spans the 11.5% and 7% bands',
      // 7,000 × 6 + 42,000 bonus = 84,000; CI 83,000; tax 3,350 + 11.5% × 3,000 = 3,695; U(7%) = 43,000 > L = 35,700
      // after 35,700: CI 47,300 -> 550 + 7% × 7,300 = 1,061; unrealised down to 40,000: 1,061 − 550
      example({
        profile: { residency: 'foreigner', ageAtYearEnd: 40, hasUnusedParenthoodTaxRebate: true },
        income: { monthlyOrdinaryWage: 7_000, monthsWorked: 6, additionalWages: 42_000 },
      }),
      {
        cpf: 0,
        reliefs: 1_000,
        chargeableIncome: 83_000,
        tax: 3_695,
        total: 35_700,
        binding: 'leverLimits',
        contributions: { srs: 35_700, cpfSelf: 0, cpfFamily: 0 },
        taxAfter: 1_061,
        taxSaved: 2_634,
        unrealised: 511,
        warnings: ['LEVER_LIMITS_PLAN', 'FOREIGNER_NO_CPF', 'TAX_RESIDENCY_CHECK', 'SRS_NON_RESIDENT_WITHDRAWAL', 'PARENTHOOD_TAX_REBATE'],
      },
    ],
    [
      'H11 foreigner: CPF top-ups for family earn no relief (SPEC §6.5), existing or new',
      // CI 135,000 − 1,000 = 134,000; tax 7,950 + 15% × 14,000; nothing can be contributed
      example({
        profile: { residency: 'foreigner' },
        existing: { cpfTopUpFamily: 8_000 },
        srs: false,
        cpfSelf: { enabled: false },
        cpfFamily: { enabled: true },
        preferences: { minSavingRate: 0 },
      }),
      {
        cpf: 0,
        reliefs: 1_000,
        chargeableIncome: 134_000,
        tax: 10_050,
        total: 0,
        binding: 'leverLimits',
        contributions: { srs: 0, cpfSelf: 0, cpfFamily: 0 },
        taxAfter: 10_050,
        taxSaved: 0,
        unrealised: 8_450, // down to 55,000 (the relief cap): 10,050 − 1,600
        warnings: ['LEVER_LIMITS_PLAN', 'FOREIGNER_NO_CPF'],
      },
    ],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    // The test model…
    const m = specPlan(input);
    expect(m.baseline.reliefs.cpf).toBe(expected.cpf);
    expect(m.baseline.reliefs.totalBeforeCap).toBe(expected.reliefs);
    expect(m.baseline.chargeableIncome).toBe(expected.chargeableIncome);
    expect(m.baseline.taxPayable).toBe(expected.tax);
    if (expected.assessable !== undefined) expect(m.baseline.assessableIncome).toBe(expected.assessable);
    if (expected.total !== undefined) {
      expect(m.total).toBe(expected.total);
      expect(m.bindingConstraint).toBe(expected.binding);
      expect(m.contributions).toEqual(expected.contributions);
      expect(m.optimised.taxPayable).toBe(expected.taxAfter);
      expect(m.taxSavedCents).toBe(cents(expected.taxSaved ?? 0));
      expect(m.unrealisedSavingCents).toBe(cents(expected.unrealised ?? 0));
    }
    // …and the engine.
    const r = plan(input);
    expect(r.cpf.employeeContribution).toBe(expected.cpf);
    expect(r.baseline.reliefs.totalBeforeCap).toBe(expected.reliefs);
    expect(r.baseline.chargeableIncome).toBe(expected.chargeableIncome);
    expect(r.baseline.taxPayable).toBe(expected.tax);
    if (expected.assessable !== undefined) expect(r.baseline.assessableIncome).toBe(expected.assessable);
    if (expected.total !== undefined) {
      expect(r.plan.totalContribution).toBe(expected.total);
      expect(r.plan.bindingConstraint).toBe(expected.binding);
      expect(r.plan.contributions).toEqual(expected.contributions);
      expect(r.plan.taxAfter).toBe(expected.taxAfter);
      expect(r.plan.taxSaved).toBe(expected.taxSaved);
      expect(r.plan.unrealisedSaving).toBe(expected.unrealised);
    }
    if (expected.warnings !== undefined) {
      expect(r.warnings.map((warning) => warning.code)).toEqual(expected.warnings);
      const severity = new Map(SPEC_WARNINGS);
      expect(r.warnings.map((warning) => warning.severity)).toEqual(expected.warnings.map((code) => severity.get(code)));
    }
  });

  it('A.1 and A.2: U, C, L, ladder, monthly plan and scenario figures', () => {
    const a1 = specPlan(example({ otherReliefs: 5_000 }));
    expect([a1.usefulRoom, a1.reliefCapRoom, a1.leverRoom, a1.budget]).toEqual([68_600, 53_600, 23_300, Infinity]);
    const r1 = plan(example({ otherReliefs: 5_000 }));
    expect(r1.ladder).toEqual([
      { fromContribution: 0, toContribution: 23_300, amount: 23_300, rate: 0.115, taxSaved: 2_679.5, cumulativeTaxSaved: 2_679.5, usedByPlan: 23_300 },
    ]);
    expect(r1.monthlyPlan.schedule.map((row) => [row.month, row.amounts.srs, row.amounts.cpfSelf])).toEqual([
      ['2026-11', 7_650, 4_000],
      ['2026-12', 7_650, 4_000],
    ]);

    const a2Input = a2(50_000);
    const m2 = specPlan(a2Input);
    expect([m2.usefulRoom, m2.reliefCapRoom, m2.leverRoom, m2.budget]).toEqual([128_640, 20_640, 26_300, 20_000]);
    expect(m2.rooms).toEqual({ srs: 10_300, cpfSelf: 8_000, cpfFamily: 8_000 });
    const r2 = plan(a2Input);
    expect(r2.ladder.map((t) => [t.fromContribution, t.toContribution, t.rate, t.taxSaved, t.usedByPlan, t.zeroReason])).toEqual([
      [0, 20_640, 0.15, 3_096, 20_000, undefined],
      [20_640, 26_300, 0, 0, 0, 'reliefCap'],
    ]);
    const maxAll = r2.scenarios.find((scenario) => scenario.id === 'maxAll');
    expect([maxAll?.totalContribution, maxAll?.taxSaved, maxAll?.wastedContribution]).toEqual([26_300, 3_096, 5_660]);
    expect(r2.warnings.map(({ code, severity }) => [code, severity])).toEqual([
      ['BUDGET_LIMITS_PLAN', 'info'],
      ['AGE_55_PLUS_TOPUP', 'info'],
      ['FAMILY_TOPUP_CHECKS', 'caution'],
    ]);
  });

  it('A.2b: with the room left blank own CPF has no room anywhere — levers, L, ladder, simulator, scenarios, schedule, warnings', () => {
    const input = a2(null);
    const m = specPlan(input);
    expect([m.usefulRoom, m.reliefCapRoom, m.leverRoom, m.budget]).toEqual([128_640, 20_640, 18_300, 20_000]);
    expect(m.rooms).toEqual({ srs: 10_300, cpfSelf: 0, cpfFamily: 8_000 });
    const r = plan(input);
    expect(r.levers.cpfSelf).toEqual({ statutoryCap: 8_000, used: 0, room: 0, eligible: true, enabled: true });
    expect([r.levers.srs.room, r.levers.cpfFamily.room, r.reliefCapRoom]).toEqual([10_300, 8_000, 20_640]);
    // one tier: 18,300 is inside the relief-cap room and inside the 15% bracket
    expect(r.ladder).toEqual([
      { fromContribution: 0, toContribution: 18_300, amount: 18_300, rate: 0.15, taxSaved: 2_745, cumulativeTaxSaved: 2_745, usedByPlan: 18_300 },
    ]);
    // simulator: 0, 1,000 … 18,000, 18,300 in the order cpfSelf (nothing) → srs → family
    expect(r.simulator.map((row) => row.contribution)).toEqual([...Array.from({ length: 19 }, (_unused, i) => i * 1_000), 18_300]);
    expect(r.simulator.every((row) => row.split.cpfSelf === 0)).toBe(true);
    expect(r.simulator[11]?.split).toEqual({ srs: 10_300, cpfSelf: 0, cpfFamily: 700 });
    expect(r.simulator[19]?.taxSaved).toBe(2_745);
    // scenarios: "CPF only" is empty, "SRS + CPF" is SRS alone (138,340 -> 7,950 + 15% × 18,340 = 10,701)
    const scenario = (id: string) => r.scenarios.find((candidate) => candidate.id === id);
    expect(scenario('cpfSelfOnly')).toEqual({
      id: 'cpfSelfOnly',
      contributions: { srs: 0, cpfSelf: 0, cpfFamily: 0 },
      totalContribution: 0,
      taxPayable: 12_246,
      taxSaved: 0,
      savingRate: 0,
      wastedContribution: 0,
    });
    for (const id of ['srsOnly', 'srsPlusCpfSelf']) {
      expect([scenario(id)?.contributions, scenario(id)?.taxPayable, scenario(id)?.taxSaved], id).toEqual([{ srs: 10_300, cpfSelf: 0, cpfFamily: 0 }, 10_701, 1_545]);
    }
    for (const id of ['maxAll', 'recommended']) {
      expect([scenario(id)?.contributions, scenario(id)?.taxSaved, scenario(id)?.wastedContribution], id).toEqual([{ srs: 10_300, cpfSelf: 0, cpfFamily: 8_000 }, 2_745, 0]);
    }
    // two instalments (13 November); "from January" figures ceil(10,300 / 12) = 859 and ceil(8,000 / 12) = 667
    expect(r.monthlyPlan.schedule.map((row) => [row.month, row.amounts.srs, row.amounts.cpfSelf, row.amounts.cpfFamily, row.total])).toEqual([
      ['2026-11', 5_150, 0, 4_000, 9_150],
      ['2026-12', 5_150, 0, 4_000, 9_150],
    ]);
    expect(r.monthlyPlan.fullYearMonthly).toEqual({ srs: 859, cpfSelf: 0, cpfFamily: 667, total: 1_526 });
    expect(r.warnings.map(({ code, severity }) => [code, severity])).toEqual([
      ['LEVER_LIMITS_PLAN', 'info'],
      ['CPF_SELF_ROOM_UNCONFIRMED', 'caution'],
      ['FAMILY_TOPUP_CHECKS', 'caution'],
    ]);
    // the baseline is A.2's: only what is recommended changes
    expect(r.baseline).toEqual(plan(a2(50_000)).baseline);
  });

  it('B CPF Board maxima and the AW ceiling example (2026)', () => {
    const rules = getRules(2026);
    const monthly = (age: number): number =>
      computeCpf(example({ profile: { ageAtYearEnd: age }, income: { monthlyOrdinaryWage: 8_000, monthsWorked: 1, additionalWages: 0 } }), rules)
        .employeeContribution;
    expect([monthly(40), monthly(58), monthly(63)]).toEqual([1_600, 1_440, 1_000]);
    const cpf = computeCpf(example({ income: { monthlyOrdinaryWage: 9_000, additionalWages: 50_000 } }), rules);
    expect([cpf.ordinaryWagesSubject, cpf.additionalWageCeiling, cpf.employeeContribution]).toEqual([96_000, 6_000, 20_400]);
  });

  it('defaultInput is the A.1 example and defaultIncomeYear picks the nearest supported year', () => {
    expect(sanitiseInput(defaultInput('2026-11-13'))).toEqual(example({ otherReliefs: 5_000 }));
    expect(['2019-05-05', '2025-01-01', '2026-06-30', '2027-12-31', '2031-01-01'].map(defaultIncomeYear)).toEqual([
      2025, 2025, 2026, 2027, 2027,
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// grossTax and marginalRate
// ---------------------------------------------------------------------------------------------------------------

describe('grossTax and marginalRate (SPEC §5.1, §6.4)', () => {
  const everyRules = SPEC_YEARS.map((year) => getRules(year));
  const rulesArb = fc.constantFrom(...everyRules);

  it('equals the §5.1 cumulative figure at every bracket boundary, and the hand-rounded half-cent cases', () => {
    for (const rules of everyRules) {
      for (const band of SPEC_BRACKETS) expect(grossTax(band.from, rules), `tax on ${band.from}`).toBe(band.taxAtFrom);
      // Appendix B rate-table vectors, typed from the SPEC.
      const vectors: [number, number][] = [
        [20_000, 0], [30_000, 200], [40_000, 550], [80_000, 3_350], [120_000, 7_950], [160_000, 13_950], [200_000, 21_150],
        [240_000, 28_750], [280_000, 36_550], [320_000, 44_550], [500_000, 84_150], [1_000_000, 199_150], [1_200_000, 247_150],
      ];
      for (const [ci, tax] of vectors) expect(grossTax(ci, rules), `tax on ${ci}`).toBe(tax);
      // Worked by hand: an odd dollar in a half-percent bracket gives a half cent, which rounds UP.
      const halfCents: [number, number][] = [
        [20_001, 0.02], [30_001, 200.04], [30_003, 200.11], [39_999, 549.97], [40_001, 550.07], [80_001, 3_350.12],
        [80_003, 3_350.35], [119_999, 7_949.89], [240_001, 28_750.2], [279_999, 36_549.81], [1_000_001, 199_150.24],
      ];
      for (const [ci, tax] of halfCents) expect(grossTax(ci, rules), `tax on ${ci}`).toBe(tax);
    }
  });

  it('every whole-dollar chargeable income from 0 to 1,050,000: closed form, monotone, zero up to 20,000', () => {
    for (const rules of everyRules) {
      const p = new Problems();
      let previousCents = 0;
      let previousRate = 0;
      for (let ci = 0; ci <= 1_050_000; ci++) {
        const tax = grossTax(ci, rules);
        const taxCents = Math.round(tax * 100);
        if (taxCents !== specTaxCents(ci) || taxCents / 100 !== tax) p.check(false, () => `grossTax(${ci}) = ${tax}, closed form ${specTaxCents(ci) / 100}`);
        if (taxCents < previousCents) p.check(false, () => `grossTax decreases at ${ci}`);
        if (ci <= 20_000 && tax !== 0) p.check(false, () => `grossTax(${ci}) = ${tax}, expected 0`);
        const rate = marginalRate(ci, rules);
        if (rate !== specRateOfDollar(ci)) p.check(false, () => `marginalRate(${ci}) = ${rate}, expected ${specRateOfDollar(ci)}`);
        if (rate < previousRate) p.check(false, () => `marginalRate decreases at ${ci}`);
        previousCents = taxCents;
        previousRate = rate;
      }
      p.done();
    }
  });

  prop('grossTax matches the closed form and is in whole cents', fc.tuple(rulesArb, chargeableIncomeArb), ([rules, ci]) => {
    const tax = grossTax(ci, rules);
    expect(isCents(tax)).toBe(true);
    expect(cents(tax)).toBe(specTaxCents(ci));
  });

  prop('grossTax is 0 up to 20,000 and positive above', fc.tuple(rulesArb, fc.integer({ min: 0, max: 40_000 })), ([rules, ci]) => {
    if (ci <= 20_000) expect(grossTax(ci, rules)).toBe(0);
    else expect(grossTax(ci, rules)).toBeGreaterThan(0);
  });

  prop('grossTax is non-decreasing in chargeable income', fc.tuple(rulesArb, chargeableIncomeArb, chargeableIncomeArb), ([rules, a, b]) => {
    const [low, high] = a <= b ? [a, b] : [b, a];
    expect(cents(grossTax(low, rules))).toBeLessThanOrEqual(cents(grossTax(high, rules)));
  });

  prop(
    'grossTax is convex: second differences on integer grids are >= 0',
    fc.tuple(rulesArb, chargeableIncomeArb, fc.oneof(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 60_000 }), fc.integer({ min: 1, max: 600_000 }))),
    ([rules, start, rawStep]) => {
      // Stay inside the engine's domain: chargeable income cannot exceed 14 × S$10bn (SPEC §6.0 clamp on inputs).
      const step = Math.max(1, Math.min(rawStep, Math.floor((140_000_000_000 - start) / 4)));
      fc.pre(start + 4 * step <= 140_000_000_000);
      const second = (x: number, h: number): number =>
        cents(grossTax(x + 2 * h, rules)) - 2 * cents(grossTax(x + h, rules)) + cents(grossTax(x, rules));
      // On even dollars no bracket sum has a half cent, so the published (rounded) figures are exactly convex.
      expect(second(start - (start % 2), 2 * step)).toBeGreaterThanOrEqual(0);
      // On any grid each of the three figures carries at most half a cent of rounding: -1 cent is the worst case.
      expect(second(start, step)).toBeGreaterThanOrEqual(-1);
    },
  );

  prop('marginalRate is non-decreasing and is the rate of the last dollar', fc.tuple(rulesArb, chargeableIncomeArb, chargeableIncomeArb), ([rules, a, b]) => {
    const [low, high] = a <= b ? [a, b] : [b, a];
    expect(marginalRate(low, rules)).toBeLessThanOrEqual(marginalRate(high, rules));
    expect(marginalRate(low, rules)).toBe(specRateOfDollar(low));
    // The last dollar costs its marginal rate (to the cent: both figures are rounded).
    if (low >= 1) {
      const lastDollar = cents(grossTax(low, rules)) - cents(grossTax(low - 1, rules));
      expect(Math.abs(lastDollar - marginalRate(low, rules) * 100)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  prop(
    'grossTax and marginalRate never return NaN or a negative number, whatever number they are given',
    fc.tuple(rulesArb, fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, -0, -1, 0.5, 19_999.99, 20_000.5, 1e15, 1e300))),
    ([rules, value]) => {
      for (const result of [grossTax(value, rules), marginalRate(value, rules)]) {
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(0);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Robustness and sanitising
// ---------------------------------------------------------------------------------------------------------------

describe('plan() on bad input (SPEC §6.0)', () => {
  prop('never throws for garbage objects; every number is finite, money in cents, contributions whole and >= 0', garbageInputArb, (raw) => {
    const r = plan(raw as PlannerInput);
    assertWellFormed(r);
    for (const lever of LEVERS) {
      expect(Number.isInteger(r.plan.contributions[lever]) && r.plan.contributions[lever] >= 0).toBe(true);
    }
    // What the engine says it used is what §6.0 says it should use, and sanitising again changes nothing.
    expect(r.input).toEqual(specSanitise(raw));
    expect(sanitiseInput(r.input)).toEqual(r.input);
    expect(() => evaluate(raw as PlannerInput, raw as LeverAmounts)).not.toThrow();
  });

  prop('throws only a RangeError, and only for an unsupported income year', fc.anything(), (raw) => {
    try {
      plan(raw as PlannerInput);
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
    }
    expect(() => sanitiseInput(raw as PlannerInput)).not.toThrow();
  });

  prop('negative, fractional, oversized, mistyped and missing fields are sanitised exactly as §6.0 says', messyInputArb, (raw) => {
    const expected = specSanitise(raw);
    expect(sanitiseInput(raw as PlannerInput)).toEqual(expected);
    const r = plan(raw as PlannerInput);
    expect(r.input).toEqual(expected);
    assertWellFormed(r);
    // …and the figures are those of the sanitised input.
    const m = specPlan(expected);
    expect(r.baseline).toEqual(m.baseline);
    expect(r.plan.contributions).toEqual(m.contributions);
    expect(cents(r.plan.taxSaved)).toBe(m.taxSavedCents);
  });

  it('money above S$10,000,000,000 is clamped and the arithmetic stays exact at the clamp', () => {
    const huge = example({
      income: { monthlyOrdinaryWage: 1e15, additionalWages: 9e15, otherTaxableIncome: 2 ** 53, donations: 3 },
      otherReliefs: 5,
    });
    const r = plan(huge);
    expect(r.input.income.monthlyOrdinaryWage).toBe(SPEC_MAX_MONEY);
    expect(r.input.income.additionalWages).toBe(SPEC_MAX_MONEY);
    expect(r.input.income.otherTaxableIncome).toBe(SPEC_MAX_MONEY);
    // 14 × 10bn of income, less 7.50 of donation deduction and 1,000 + 20,400 + 5 of reliefs.
    expect(r.baseline.totalIncome).toBe(140_000_000_000);
    expect(r.baseline.assessableIncome).toBe(139_999_999_992.5);
    expect(r.baseline.chargeableIncome).toBe(139_999_978_587);
    // 199,150 + 24% × (139,999,978,587 − 1,000,000) = 33,599,954,010.88
    expect(r.baseline.taxPayable).toBe(33_599_954_010.88);
    assertWellFormed(r);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The model: CPF, levers, reliefs, tax
// ---------------------------------------------------------------------------------------------------------------

describe('CPF, levers, reliefs and tax (SPEC §6.1–§6.5)', () => {
  prop('valid inputs come back from sanitising with only the defaults filled in, and all outputs are well-formed', plannerInputArb, (input) => {
    const { r, s } = run(input);
    expect(r.input).toEqual(s);
    expect(sanitiseInput(input)).toEqual(s);
    // Defaults: 12 months, birth month 12, PR year 3, step 1,000, no limits.
    expect(s.income.monthsWorked).toBe(input.income.monthsWorked ?? 12);
    expect(s.profile.birthMonth).toBe(input.profile.birthMonth ?? 12);
    expect(s.profile.prYear).toBe(input.profile.prYear ?? 3);
    expect(s.preferences.simulatorStep).toBe(input.preferences.simulatorStep ?? 1_000);
    expect(s.preferences.cashBudget).toBe(input.preferences.cashBudget ?? null);
    expect(s.levers.cpfSelf.roomToLimit).toBe(input.levers.cpfSelf.roomToLimit ?? null);
    expect(s.profile.hasUnusedParenthoodTaxRebate).toBe(input.profile.hasUnusedParenthoodTaxRebate ?? false);
    expect(r.input.profile.hasUnusedParenthoodTaxRebate).toBe(input.profile.hasUnusedParenthoodTaxRebate === true);
    expect(r.rules).toBe(getRules(input.incomeYear));
    assertWellFormed(r);
  });

  prop('CPF: caps, wage ceilings, monthly rates, override, and the §6.1 figure itself', plannerInputArb, (input) => {
    const { r, s } = run(input);
    const cpf = r.cpf;
    const year = s.incomeYear as keyof typeof SPEC_OW_CEILING;
    expect(computeCpf(input, getRules(s.incomeYear))).toEqual(cpf);

    // Invariants
    expect(cpf.employeeContribution).toBeLessThanOrEqual(Math.floor(0.2 * 102_000));
    expect(cpf.ordinaryWagesSubject).toBeLessThanOrEqual(SPEC_OW_CEILING[year] * s.income.monthsWorked);
    expect(cpf.additionalWagesSubject).toBeLessThanOrEqual(cpf.additionalWageCeiling);
    expect(cpf.additionalWagesSubject).toBeLessThanOrEqual(s.income.additionalWages);
    expect(cpf.ordinaryWagesSubject + cpf.additionalWagesSubject).toBeLessThanOrEqual(SPEC_ANNUAL_WAGE_CEILING);
    expect(cpf.monthlyEmployeeRates).toHaveLength(12);
    const worked = cpf.monthlyEmployeeRates.map((rate) => rate !== 0);
    if (s.profile.residency === 'foreigner') {
      expect(cpf).toEqual({
        source: 'none',
        ordinaryWagesSubject: 0,
        additionalWageCeiling: 0,
        additionalWagesSubject: 0,
        employeeContribution: 0,
        employerContribution: 0,
        monthlyEmployeeRates: new Array<number>(12).fill(0),
      });
    } else {
      // Zeros exactly for the months not worked: the first 12 − n months of the year.
      expect(worked).toEqual(Array.from({ length: 12 }, (_unused, index) => index >= 12 - s.income.monthsWorked));
      expect(cpf.ordinaryWagesSubject).toBe(Math.min(s.income.monthlyOrdinaryWage, SPEC_OW_CEILING[year]) * s.income.monthsWorked);
      expect(cpf.additionalWageCeiling).toBe(Math.max(0, SPEC_ANNUAL_WAGE_CEILING - cpf.ordinaryWagesSubject));
      expect(cpf.additionalWagesSubject).toBe(Math.min(s.income.additionalWages, cpf.additionalWageCeiling));
      // Rates never rise during the year (people only get older).
      const rates = cpf.monthlyEmployeeRates.filter((rate) => rate !== 0);
      for (let i = 1; i < rates.length; i++) expect(rates[i]!).toBeLessThanOrEqual(rates[i - 1]!);
      if (s.income.employeeCpfOverride !== null) {
        expect(cpf.source).toBe('override');
        expect(cpf.employeeContribution).toBe(Math.min(s.income.employeeCpfOverride, SPEC_MAX_COMPULSORY_CPF));
        expect(cpf.employerContribution).toBe(0);
        // The wage breakdown is still that of the automatic calculation.
        const auto = computeCpf({ ...input, income: { ...input.income, employeeCpfOverride: null } }, getRules(s.incomeYear));
        expect(auto.source).toBe('auto');
        expect({ ...cpf, source: 'auto', employeeContribution: auto.employeeContribution, employerContribution: auto.employerContribution }).toEqual(auto);
      } else {
        expect(cpf.source).toBe('auto');
      }
    }

    // The figure, against the test's own §6.1.
    const model = specCpf(s);
    const { employerContribution: engineEmployer, ...engineRest } = cpf;
    const { employerContribution: modelEmployer, ...modelRest } = model;
    expect(engineRest).toEqual(modelRest);
    if (modelEmployer !== null) expect(engineEmployer).toBe(modelEmployer);
    expect(r.baseline.reliefs.cpf).toBe(cpf.employeeContribution);
  });

  prop('levers: eligibility, statutory caps, used and room as §6.5 defines them', plannerInputArb, (input) => {
    const { r, s } = run(input);
    const model = specLevers(s);
    for (const lever of LEVERS) {
      const { roomIfEnabled: _roomIfEnabled, ...expected } = model[lever];
      expect(r.levers[lever], lever).toEqual(expected);
    }
    // §6.5 spelled out once more, from the SPEC table.
    const citizenOrPr = s.profile.residency !== 'foreigner';
    expect(r.levers.srs.eligible).toBe(s.profile.ageAtYearEnd >= 18);
    expect(r.levers.cpfSelf.eligible).toBe(citizenOrPr);
    expect(r.levers.cpfFamily.eligible).toBe(citizenOrPr);
    expect(r.levers.srs.statutoryCap).toBe(s.profile.ageAtYearEnd < 18 ? 0 : citizenOrPr ? 15_300 : 35_700);
    expect(r.levers.cpfSelf.statutoryCap).toBe(citizenOrPr ? 8_000 : 0);
    expect(r.levers.cpfFamily.statutoryCap).toBe(citizenOrPr ? 8_000 : 0);
    // The room of the person's own CPF: what is left under the cap, cut to the room entered — and nothing at all
    // from age 55 until a room is entered ("Room must be confirmed from age 55").
    const left = citizenOrPr ? Math.max(0, 8_000 - Math.min(s.existing.cpfTopUpSelf, 8_000)) : 0;
    const entered = s.levers.cpfSelf.roomToLimit;
    const roomIfEnabled = entered !== null ? Math.min(left, entered) : s.profile.ageAtYearEnd >= 55 ? 0 : left;
    expect(model.cpfSelf.roomIfEnabled).toBe(roomIfEnabled);
    expect(r.levers.cpfSelf.room).toBe(citizenOrPr && s.levers.cpfSelf.enabled ? roomIfEnabled : 0);
    expect(r.levers.cpfSelf.used).toBe(citizenOrPr ? Math.min(s.existing.cpfTopUpSelf, 8_000) : 0);
    // The other two schemes do not depend on age 55 or on that room.
    const srsCap = r.levers.srs.statutoryCap;
    expect(r.levers.srs.room).toBe(s.levers.srs.enabled ? Math.max(0, srsCap - Math.min(s.existing.srs, srsCap)) : 0);
    const familyLeft = citizenOrPr ? Math.max(0, 8_000 - Math.min(s.existing.cpfTopUpFamily, 8_000)) : 0;
    const most = s.levers.cpfFamily.maxAmount;
    expect(r.levers.cpfFamily.room).toBe(s.levers.cpfFamily.enabled ? (most === null ? familyLeft : Math.min(familyLeft, most)) : 0);
  });

  prop('feasibility: nothing beyond a room, the budget, the relief cap or a statutory cap; nothing to a disabled or ineligible lever', plannerInputArb, (input) => {
    const { r, s } = run(input);
    const { contributions } = r.plan;
    const existing = existingOf(s);
    const citizenOrPr = s.profile.residency === 'citizen' || s.profile.residency === 'pr';
    const eligible: Record<LeverId, boolean> = { srs: s.profile.ageAtYearEnd >= 18, cpfSelf: citizenOrPr, cpfFamily: citizenOrPr };
    const cap: LeverAmounts = { srs: citizenOrPr ? 15_300 : 35_700, cpfSelf: 8_000, cpfFamily: 8_000 };
    for (const lever of LEVERS) {
      const amount = contributions[lever];
      expect(Number.isInteger(amount) && amount >= 0, `${lever} = ${amount}`).toBe(true);
      expect(amount, `${lever} within its room`).toBeLessThanOrEqual(r.levers[lever].room);
      if (!s.levers[lever].enabled || !eligible[lever]) expect(amount, `${lever} is disabled or ineligible`).toBe(0);
      if (amount > 0) expect(amount + existing[lever], `${lever} with existing vs statutory cap`).toBeLessThanOrEqual(cap[lever]);
    }
    const { roomToLimit } = s.levers.cpfSelf;
    const { maxAmount } = s.levers.cpfFamily;
    if (roomToLimit !== null) expect(contributions.cpfSelf).toBeLessThanOrEqual(roomToLimit);
    // SPEC §6.5: from 55, not a dollar into the person's own CPF until the room has been entered.
    if (roomToLimit === null && s.profile.ageAtYearEnd >= 55) expect(contributions.cpfSelf).toBe(0);
    if (maxAmount !== null) expect(contributions.cpfFamily).toBeLessThanOrEqual(maxAmount);
    expect(r.plan.totalContribution).toBe(sum(contributions));
    if (s.preferences.cashBudget !== null) expect(r.plan.totalContribution).toBeLessThanOrEqual(s.preferences.cashBudget);
    expect(r.plan.totalContribution).toBeLessThanOrEqual(r.reliefCapRoom);
    // Every recommended dollar is a dollar of allowed relief.
    expect(r.optimised.reliefs.totalAllowed - r.baseline.reliefs.totalAllowed).toBe(r.plan.totalContribution);
    expect(r.optimised.reliefs.lostToCap).toBe(r.baseline.reliefs.lostToCap);
  });

  prop('reliefs and tax: the cap, chargeable income, baseline = evaluate(zeros), optimised = evaluate(plan)', plannerInputArb, (input) => {
    const { r, s, m } = run(input);
    for (const t of [r.baseline, r.optimised]) {
      const { reliefs } = t;
      expect(reliefs.totalBeforeCap).toBe(
        reliefs.earnedIncome + reliefs.cpf + reliefs.srs + reliefs.cpfTopUpSelf + reliefs.cpfTopUpFamily + reliefs.other,
      );
      expect(reliefs.totalAllowed).toBe(Math.min(reliefs.totalBeforeCap, 80_000));
      expect(reliefs.lostToCap).toBe(reliefs.totalBeforeCap - reliefs.totalAllowed);
      expect(t.chargeableIncome).toBe(Math.floor(Math.max(0, t.assessableIncome - reliefs.totalAllowed)));
      expect(t.employmentIncome).toBe(s.income.monthlyOrdinaryWage * s.income.monthsWorked + s.income.additionalWages);
      expect(t.totalIncome).toBe(Math.max(0, t.employmentIncome - s.income.employmentExpenses) + s.income.otherTaxableIncome);
      expect(t.donationDeduction).toBe(s.income.donations * 2.5);
      expect(t.assessableIncome).toBe(Math.max(0, t.totalIncome - t.donationDeduction));
      expect(reliefs.other).toBe(s.otherReliefs);
      expect(cents(t.grossTax)).toBe(specTaxCents(t.chargeableIncome));
      expect(t.pitRebate).toBe(0);
      expect(t.taxPayable).toBe(t.grossTax);
      expect(t.marginalRate).toBe(specRateOfDollar(t.chargeableIncome));
      expect(t.effectiveRate).toBe(t.totalIncome === 0 ? 0 : t.taxPayable / t.totalIncome);
    }
    expect(r.baseline).toEqual(evaluate(input, zeros()));
    expect(r.optimised).toEqual(evaluate(input, r.plan.contributions));
    // The figures, against the test's own §6.2–§6.4.
    expect(r.baseline).toEqual(m.baseline);
    expect(r.optimised).toEqual(specTax(s, r.plan.contributions));
  });

  prop(
    'evaluate: additional contributions count exactly like existing ones, and garbage amounts count as zero',
    fc.tuple(plannerInputArb, fc.nat(40_000), fc.nat(12_000), fc.nat(12_000)),
    ([input, srs, cpfSelf, cpfFamily]) => {
      const additional = { srs, cpfSelf, cpfFamily };
      const s = specSanitise(input);
      const moved: PlannerInput = {
        ...input,
        existing: {
          srs: s.existing.srs + srs,
          cpfTopUpSelf: s.existing.cpfTopUpSelf + cpfSelf,
          cpfTopUpFamily: s.existing.cpfTopUpFamily + cpfFamily,
        },
      };
      const viaAdditional = evaluate(input, additional);
      expect(viaAdditional).toEqual(evaluate(moved, zeros()));
      expect(viaAdditional).toEqual(specTax(s, additional));
      expect(cents(viaAdditional.taxPayable)).toBeLessThanOrEqual(cents(evaluate(input, zeros()).taxPayable));
      expect(evaluate(input, { srs: Number.NaN, cpfSelf: -5, cpfFamily: undefined } as unknown as LeverAmounts)).toEqual(evaluate(input, zeros()));
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// The optimiser
// ---------------------------------------------------------------------------------------------------------------

/** The plan's total, binding constraint and savings recomputed from the engine's OWN outputs (SPEC §6.6). */
function fromOutputs(r: PlannerResult, s: FullInput) {
  const ci0 = r.baseline.chargeableIncome;
  const U = specUsefulRoom(ci0, s.preferences.minSavingRate);
  const C = Math.max(0, 80_000 - r.baseline.reliefs.totalBeforeCap);
  const L = r.levers.srs.room + r.levers.cpfSelf.room + r.levers.cpfFamily.room;
  const B = s.preferences.cashBudget === null ? Infinity : s.preferences.cashBudget;
  return { ci0, U, C, L, B, X: Math.min(U, C, L, B) };
}

describe('the optimiser (SPEC §6.6)', () => {
  prop('X = min(U, C, L, B); allocation, tax saved, binding constraint and unrealised saving as specified', plannerInputArb, (input) => {
    const { r, s, m } = run(input);
    const o = fromOutputs(r, s);
    expect(r.reliefCapRoom).toBe(o.C);
    expect(r.plan.totalContribution).toBe(o.X);
    // Same again from the test's own model (independent CI0, reliefs and rooms).
    expect([o.U, o.C, o.L, o.B]).toEqual([m.usefulRoom, m.reliefCapRoom, m.leverRoom, m.budget]);
    expect(r.plan.totalContribution).toBe(m.total);
    expect(r.plan.contributions).toEqual(m.contributions);
    expect(r.plan.contributions).toEqual(specAllocate(o.X, { srs: r.levers.srs.room, cpfSelf: r.levers.cpfSelf.room, cpfFamily: r.levers.cpfFamily.room }, s.preferences.priority));

    expect(r.plan.taxBefore).toBe(r.baseline.taxPayable);
    expect(r.plan.taxAfter).toBe(r.optimised.taxPayable);
    expect(cents(r.plan.taxBefore)).toBe(specTaxCents(o.ci0));
    expect(cents(r.plan.taxAfter)).toBe(specTaxCents(o.ci0 - o.X));
    expect(cents(r.plan.taxSaved)).toBe(cents(r.plan.taxBefore) - cents(r.plan.taxAfter));
    expect(cents(r.plan.taxSaved)).toBe(m.taxSavedCents);
    expect(r.plan.savingRate).toBe(o.X === 0 ? 0 : r.plan.taxSaved / o.X);
    expect(r.plan.chargeableIncomeBefore).toBe(o.ci0);
    expect(r.plan.chargeableIncomeAfter).toBe(o.ci0 - o.X);
    expect(r.plan.chargeableIncomeAfter).toBe(r.optimised.chargeableIncome);
    expect(r.plan.marginalRateBefore).toBe(specRateOfDollar(o.ci0));
    expect(r.plan.marginalRateAfter).toBe(specRateOfDollar(o.ci0 - o.X));

    // Binding constraint: 'none' without tax; otherwise the smallest of U, C, L, B, ties in that order.
    const expectedBinding =
      r.baseline.taxPayable === 0
        ? 'none'
        : o.U === o.X
          ? 'usefulRoom'
          : o.C === o.X
            ? 'reliefCap'
            : o.L === o.X
              ? 'leverLimits'
              : 'cashBudget';
    expect(r.plan.bindingConstraint).toBe(expectedBinding);
    expect(r.plan.bindingConstraint).toBe(m.bindingConstraint);

    // Unrealised saving: tax after X less tax after min(U, C).
    const unrealised = specTaxCents(o.ci0 - o.X) - specTaxCents(o.ci0 - Math.min(o.U, o.C));
    expect(cents(r.plan.unrealisedSaving)).toBe(unrealised);
    if (['usefulRoom', 'reliefCap', 'none'].includes(r.plan.bindingConstraint)) expect(r.plan.unrealisedSaving).toBe(0);
    if (r.plan.unrealisedSaving > 0) expect(['leverLimits', 'cashBudget']).toContain(r.plan.bindingConstraint);
  });

  prop('no wasted dollar: the last recommended dollar saves at least the minimum rate and more than nothing', plannerInputArb, (input) => {
    const { r, s } = run(input);
    const X = r.plan.totalContribution;
    const ci0 = r.baseline.chargeableIncome;
    const recommended = r.scenarios.find((scenario) => scenario.id === 'recommended');
    expect(recommended?.wastedContribution).toBe(0);
    expect(r.plan.taxSaved).toBeGreaterThanOrEqual(0);
    expect(r.plan.taxAfter).toBeLessThanOrEqual(r.plan.taxBefore);
    if (X > 0) {
      // The X-th dollar takes chargeable income from CI0 − X + 1 to CI0 − X: it is dollar number CI0 − X + 1.
      expect(X).toBeLessThanOrEqual(ci0);
      const lastRate = specRateOfDollar(ci0 - X + 1);
      expect(lastRate).toBeGreaterThan(0);
      expect(lastRate).toBeGreaterThanOrEqual(s.preferences.minSavingRate);
      expect(r.plan.taxSaved).toBeGreaterThan(0);
      // So the plan as a whole saves at least the minimum rate (to the cent), and at most the top rate it started in.
      expect(cents(r.plan.taxSaved)).toBeGreaterThanOrEqual(Math.floor(s.preferences.minSavingRate * X * 100) - 1);
      expect(cents(r.plan.taxSaved)).toBeLessThanOrEqual(Math.ceil(r.plan.marginalRateBefore * X * 100) + 1);
      expect(r.plan.savingRate).toBeGreaterThan(0);
    } else {
      expect(r.plan.taxSaved).toBe(0);
      expect(r.plan.savingRate).toBe(0);
    }
  });

  prop('maximality: one more dollar would break a constraint or fall in a bracket below the minimum rate (or at 0%)', plannerInputArb, (input) => {
    const { r, s } = run(input);
    const o = fromOutputs(r, s);
    const X = r.plan.totalContribution;
    expect(X).toBe(o.X);
    const noLeverHasRoom = LEVERS.every((lever) => r.plan.contributions[lever] === r.levers[lever].room);
    const budgetUsedUp = s.preferences.cashBudget !== null && X + 1 > s.preferences.cashBudget;
    const reliefCapReached = X + 1 > r.reliefCapRoom;
    // The next dollar would be dollar number CI0 − X of chargeable income.
    const nextRate = specRateOfDollar(o.ci0 - X);
    const nextDollarNotWorthIt = nextRate === 0 || nextRate < s.preferences.minSavingRate;
    expect(noLeverHasRoom || budgetUsedUp || reliefCapReached || nextDollarNotWorthIt).toBe(true);
    // And the reported binding constraint is one that really binds.
    const binds: Record<string, boolean> = {
      usefulRoom: nextDollarNotWorthIt,
      reliefCap: reliefCapReached,
      leverLimits: noLeverHasRoom,
      cashBudget: budgetUsedUp,
      none: r.baseline.taxPayable === 0,
    };
    expect(binds[r.plan.bindingConstraint], r.plan.bindingConstraint).toBe(true);
  });

  /** Predicate "every dollar of a total T meets the minimum rate" from the SPEC brackets. */
  const everyDollarQualifies = (T: number, ci0: number, C: number, minRate: number): boolean => {
    if (T === 0) return true;
    if (T > C || T > ci0) return false; // dollars beyond the relief cap, or beyond the income, save nothing
    const lastRate = specRateOfDollar(ci0 - T + 1);
    return lastRate > 0 && lastRate >= minRate;
  };

  prop('optimality, dollar by dollar: no total within the rooms and budget whose every dollar qualifies saves more', plannerInputArb, (input) => {
    const { r, s, m } = run(input);
    const ci0 = m.baseline.chargeableIncome;
    const baseCents = specTaxCents(ci0);
    const limit = Math.min(m.leverRoom, m.budget);
    let best = 0;
    let bestTotal = 0;
    for (let T = 0; T <= limit; T++) {
      if (!everyDollarQualifies(T, ci0, m.reliefCapRoom, s.preferences.minSavingRate)) continue;
      const saved = baseCents - specTaxCents(ci0 - T);
      if (saved > best) {
        best = saved;
        bestTotal = T;
      }
    }
    expect(cents(r.plan.taxSaved), `best total ${bestTotal}`).toBe(best);
    // The plan is the LARGEST qualifying total too (it uses every qualifying dollar available).
    let largest = 0;
    for (let T = limit; T >= 0; T--) {
      if (everyDollarQualifies(T, ci0, m.reliefCapRoom, s.preferences.minSavingRate)) {
        largest = T;
        break;
      }
    }
    expect(r.plan.totalContribution).toBe(largest);
  });

  /** Shrink the rooms so that a S$500 grid over three levers stays small. */
  const smallRoomsArb = fc
    .tuple(
      plannerInputArb,
      fc.option(fc.integer({ min: 0, max: 3_000 }), { nil: null }),
      fc.option(fc.integer({ min: 0, max: 3_000 }), { nil: null }),
      fc.option(fc.integer({ min: 0, max: 3_000 }), { nil: null }),
      fc.boolean(),
    )
    .map(([input, srsRoom, selfRoom, familyRoom, allOn]): PlannerInput => {
      const srsCap = input.profile.residency === 'foreigner' ? 35_700 : 15_300;
      return {
        ...input,
        existing: { ...input.existing, srs: srsRoom === null ? input.existing.srs : srsCap - srsRoom },
        levers: {
          srs: { enabled: allOn || input.levers.srs.enabled },
          cpfSelf: { enabled: allOn || input.levers.cpfSelf.enabled, roomToLimit: selfRoom ?? input.levers.cpfSelf.roomToLimit },
          cpfFamily: { enabled: allOn || input.levers.cpfFamily.enabled, maxAmount: familyRoom ?? input.levers.cpfFamily.maxAmount },
        },
      };
    });

  const gridValues = (room: number, step: number): number[] => {
    const values: number[] = [];
    for (let value = 0; value < room; value += step) values.push(value);
    values.push(room);
    return values;
  };
  const gridStep = (rooms: LeverAmounts): number => {
    for (const step of [500, 1_000, 2_000, 4_000]) {
      const points = LEVERS.reduce((count, lever) => count * (Math.ceil(rooms[lever] / step) + 1), 1);
      if (points <= 3_000) return step;
    }
    return 8_000;
  };

  prop(
    'optimality by brute force: no allocation on a grid within the rooms and budget beats the plan',
    smallRoomsArb,
    (input) => {
      const { r, s, m } = run(input);
      const rooms: LeverAmounts = { srs: r.levers.srs.room, cpfSelf: r.levers.cpfSelf.room, cpfFamily: r.levers.cpfFamily.room };
      const step = gridStep(rooms);
      const ci0 = m.baseline.chargeableIncome;
      const baseCents = cents(r.baseline.taxPayable);
      const planSaved = cents(r.plan.taxSaved);

      // The same profile with no minimum rate and no budget: nothing at all may save more than its plan.
      const freeInput = withPreferences(input, { minSavingRate: 0, cashBudget: null });
      const freeSaved = cents(plan(freeInput).plan.taxSaved);
      expect(freeSaved).toBeGreaterThanOrEqual(planSaved);

      const p = new Problems();
      let bestOnGrid = 0;
      for (const srs of gridValues(rooms.srs, step)) {
        for (const cpfSelf of gridValues(rooms.cpfSelf, step)) {
          for (const cpfFamily of gridValues(rooms.cpfFamily, step)) {
            const allocation = { srs, cpfSelf, cpfFamily };
            const T = srs + cpfSelf + cpfFamily;
            const saved = baseCents - cents(evaluate(input, allocation).taxPayable);
            const where = (): string => JSON.stringify(allocation);
            // Tax depends only on the total, and only up to the relief cap and down to zero income.
            p.check(saved === baseCents - m.taxCentsAfter(T), () => `${where()} saves ${saved}c, expected ${baseCents - m.taxCentsAfter(T)}c`);
            p.check(saved <= freeSaved, () => `${where()} saves ${saved}c > unconstrained plan ${freeSaved}c`);
            bestOnGrid = Math.max(bestOnGrid, saved);
            const withinBudget = s.preferences.cashBudget === null || T <= s.preferences.cashBudget;
            if (withinBudget && everyDollarQualifies(T, ci0, m.reliefCapRoom, s.preferences.minSavingRate)) {
              p.check(saved <= planSaved, () => `${where()} is feasible and saves ${saved}c > plan ${planSaved}c`);
            }
          }
        }
      }
      // The grid contains "everything into every lever", which realises the unconstrained optimum.
      p.check(bestOnGrid === freeSaved, () => `best on grid ${bestOnGrid}c, unconstrained plan ${freeSaved}c`);
      p.done();
    },
    0.6,
  );

  prop(
    'order-independence: any split of a total across levers within their rooms gives the same tax',
    fc.tuple(plannerInputArb, fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true })),
    ([input, share, u1, u2]) => {
      const { r, m } = run(input);
      const rooms: LeverAmounts = { srs: r.levers.srs.room, cpfSelf: r.levers.cpfSelf.room, cpfFamily: r.levers.cpfFamily.room };
      const L = sum(rooms);
      const T = Math.min(L, Math.floor(share * (L + 1)));
      const splits = PRIORITY_PERMUTATIONS.map((priority) => specAllocate(T, rooms, priority));
      // …and one that is not a priority walk.
      const random = zeros();
      random.srs = Math.min(rooms.srs, Math.floor(u1 * T));
      random.cpfSelf = Math.min(rooms.cpfSelf, Math.floor(u2 * (T - random.srs)));
      random.cpfFamily = Math.min(rooms.cpfFamily, T - random.srs - random.cpfSelf);
      let left = T - sum(random);
      for (const lever of LEVERS) {
        const extra = Math.min(rooms[lever] - random[lever], left);
        random[lever] += extra;
        left -= extra;
      }
      splits.push(random);
      const reference = evaluate(input, splits[0]!);
      for (const split of splits) {
        expect(sum(split)).toBe(T);
        const result = evaluate(input, split);
        expect(result.taxPayable, JSON.stringify(split)).toBe(reference.taxPayable);
        expect(result.chargeableIncome).toBe(reference.chargeableIncome);
        expect(result.reliefs.totalBeforeCap).toBe(reference.reliefs.totalBeforeCap);
      }
      expect(cents(reference.taxPayable)).toBe(m.taxCentsAfter(T));
    },
  );

  prop('order-independence: changing only the priority never changes the total or the tax saved', plannerInputArb, (input) => {
    const { r } = run(input);
    for (const priority of PRIORITY_PERMUTATIONS) {
      const other = plan(withPreferences(input, { priority: [...priority] }));
      expect(other.plan.totalContribution).toBe(r.plan.totalContribution);
      expect(other.plan.taxSaved).toBe(r.plan.taxSaved);
      expect(other.plan.taxAfter).toBe(r.plan.taxAfter);
      expect(other.plan.bindingConstraint).toBe(r.plan.bindingConstraint);
      expect(other.plan.unrealisedSaving).toBe(r.plan.unrealisedSaving);
      // The priority is honoured: a later lever gets money only when every earlier one is full.
      let earlierFull = true;
      for (const lever of priority) {
        if (!earlierFull) expect(other.plan.contributions[lever], `${lever} in ${priority.join('>')}`).toBe(0);
        if (other.plan.contributions[lever] < other.levers[lever].room) earlierFull = false;
      }
      expect(other.ladder).toEqual(r.ladder);
      expect(other.scenarios.map(({ id, taxSaved, totalContribution }) => [id, taxSaved, totalContribution])).toEqual(
        r.scenarios.map(({ id, taxSaved, totalContribution }) => [id, taxSaved, totalContribution]),
      );
    }
  });

  prop('applying the plan leaves nothing more to recommend, and the tax is then what the plan promised', plannerInputArb, (input) => {
    const { r, s } = run(input);
    const { contributions } = r.plan;
    const applied: PlannerInput = {
      ...input,
      existing: {
        srs: s.existing.srs + contributions.srs,
        cpfTopUpSelf: s.existing.cpfTopUpSelf + contributions.cpfSelf,
        cpfTopUpFamily: s.existing.cpfTopUpFamily + contributions.cpfFamily,
      },
      levers: {
        srs: { ...input.levers.srs },
        cpfSelf: {
          ...input.levers.cpfSelf,
          roomToLimit: s.levers.cpfSelf.roomToLimit === null ? null : s.levers.cpfSelf.roomToLimit - contributions.cpfSelf,
        },
        cpfFamily: {
          ...input.levers.cpfFamily,
          maxAmount: s.levers.cpfFamily.maxAmount === null ? null : s.levers.cpfFamily.maxAmount - contributions.cpfFamily,
        },
      },
      preferences: {
        ...input.preferences,
        cashBudget: s.preferences.cashBudget === null ? null : s.preferences.cashBudget - r.plan.totalContribution,
      },
    };
    const after = plan(applied);
    expect(after.baseline.taxPayable).toBe(r.plan.taxAfter);
    expect(after.baseline.chargeableIncome).toBe(r.plan.chargeableIncomeAfter);
    expect(after.plan.totalContribution).toBe(0);
    expect(after.plan.taxSaved).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Monotonicity
// ---------------------------------------------------------------------------------------------------------------

describe('monotonicity', () => {
  const saved = (input: PlannerInput): number => cents(plan(input).plan.taxSaved);
  const baselineTax = (input: PlannerInput): number => cents(plan(input).baseline.taxPayable);

  prop('raising the cash budget never reduces the tax saved', fc.tuple(plannerInputArb, fc.nat(60_000), fc.nat(60_000)), ([input, a, b]) => {
    const [low, high] = a <= b ? [a, b] : [b, a];
    const atLow = plan(withPreferences(input, { cashBudget: low }));
    const atHigh = plan(withPreferences(input, { cashBudget: high }));
    const unlimited = plan(withPreferences(input, { cashBudget: null }));
    expect(cents(atLow.plan.taxSaved)).toBeLessThanOrEqual(cents(atHigh.plan.taxSaved));
    expect(cents(atHigh.plan.taxSaved)).toBeLessThanOrEqual(cents(unlimited.plan.taxSaved));
    expect(atLow.plan.totalContribution).toBeLessThanOrEqual(atHigh.plan.totalContribution);
    expect(atHigh.plan.totalContribution).toBeLessThanOrEqual(unlimited.plan.totalContribution);
    expect(saved(withPreferences(input, { cashBudget: 0 }))).toBe(0);
  });

  prop('raising a room limit never reduces the tax saved', fc.tuple(plannerInputArb, fc.nat(9_000), fc.nat(9_000), fc.boolean()), ([input, a, b, forceOn]) => {
    const [low, high] = a <= b ? [a, b] : [b, a];
    const withSelf = (roomToLimit: number | null): PlannerInput => ({
      ...input,
      levers: { ...input.levers, cpfSelf: { enabled: forceOn || input.levers.cpfSelf.enabled, roomToLimit } },
    });
    const withFamily = (maxAmount: number | null): PlannerInput => ({
      ...input,
      levers: { ...input.levers, cpfFamily: { enabled: forceOn || input.levers.cpfFamily.enabled, maxAmount } },
    });
    expect(saved(withSelf(low))).toBeLessThanOrEqual(saved(withSelf(high)));
    if (specSanitise(input).profile.ageAtYearEnd >= 55) {
      // SPEC §6.5: from 55 a blank room is "not confirmed" — it saves what a room of 0 saves, never more than a room.
      expect(saved(withSelf(null))).toBe(saved(withSelf(0)));
      expect(saved(withSelf(null))).toBeLessThanOrEqual(saved(withSelf(low)));
    } else {
      // Below 55 a blank room is "no limit".
      expect(saved(withSelf(high))).toBeLessThanOrEqual(saved(withSelf(null)));
      expect(saved(withSelf(null))).toBe(saved(withSelf(8_000)));
    }
    expect(saved(withFamily(low))).toBeLessThanOrEqual(saved(withFamily(high)));
    expect(saved(withFamily(high))).toBeLessThanOrEqual(saved(withFamily(null)));
  });

  prop('enabling a lever never reduces the tax saved', plannerInputArb, (input) => {
    for (const lever of LEVERS) {
      const set = (enabled: boolean): PlannerInput => ({
        ...input,
        levers: { ...input.levers, [lever]: { ...input.levers[lever], enabled } },
      });
      const off = plan(set(false));
      const on = plan(set(true));
      expect(cents(off.plan.taxSaved), lever).toBeLessThanOrEqual(cents(on.plan.taxSaved));
      expect(off.plan.totalContribution, lever).toBeLessThanOrEqual(on.plan.totalContribution);
      expect(off.plan.contributions[lever]).toBe(0);
    }
  });

  const rateArb = fc.oneof(fc.constantFrom(...MIN_SAVING_RATES), fc.double({ min: 0, max: 0.3, noNaN: true }));
  prop('lowering the minimum saving rate never reduces the tax saved', fc.tuple(plannerInputArb, rateArb, rateArb), ([input, a, b]) => {
    const [low, high] = a <= b ? [a, b] : [b, a];
    expect(saved(withPreferences(input, { minSavingRate: high }))).toBeLessThanOrEqual(saved(withPreferences(input, { minSavingRate: low })));
    expect(saved(withPreferences(input, { minSavingRate: low }))).toBeLessThanOrEqual(saved(withPreferences(input, { minSavingRate: 0 })));
    // A minimum above the top rate recommends nothing.
    expect(saved(withPreferences(input, { minSavingRate: 0.2400001 }))).toBe(0);
  });

  prop('raising other reliefs never raises the baseline tax', fc.tuple(plannerInputArb, fc.oneof(fc.nat(2_000), fc.nat(120_000))), ([input, extra]) => {
    expect(baselineTax({ ...input, otherReliefs: input.otherReliefs + extra })).toBeLessThanOrEqual(baselineTax(input));
  });

  prop('having already contributed more never raises the baseline tax', fc.tuple(plannerInputArb, fc.nat(20_000), fc.constantFrom('srs', 'cpfTopUpSelf', 'cpfTopUpFamily')), ([input, extra, field]) => {
    const more: PlannerInput = { ...input, existing: { ...input.existing, [field]: input.existing[field as keyof PlannerInput['existing']] + extra } };
    expect(baselineTax(more)).toBeLessThanOrEqual(baselineTax(input));
  });

  prop('more other taxable income never lowers the baseline tax or the chargeable income', fc.tuple(plannerInputArb, fc.oneof(fc.nat(5), fc.nat(300_000))), ([input, extra]) => {
    const more: PlannerInput = { ...input, income: { ...input.income, otherTaxableIncome: (input.income.otherTaxableIncome ?? 0) + extra } };
    const before = plan(input).baseline;
    const after = plan(more).baseline;
    expect(cents(after.taxPayable)).toBeGreaterThanOrEqual(cents(before.taxPayable));
    expect(after.chargeableIncome).toBeGreaterThanOrEqual(before.chargeableIncome);
    expect(after.chargeableIncome - before.chargeableIncome).toBeLessThanOrEqual(extra);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SPEC §6.11 — the cautions that cover what the tool cannot see (conditions and normative wording)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The six conditions the rule audit added or changed, worked out from the sanitised input `s` (the test's own
 * sanitiser) and the engine's result `r` — never from engine internals — and compared with the codes emitted.
 */
function assertCautions(r: PlannerResult, s: FullInput): void {
  const codes = r.warnings.map((warning) => warning.code as string);
  const has = (code: string): boolean => codes.includes(code);
  const foreigner = s.profile.residency === 'foreigner';
  const ownCpfFrom55 = s.profile.ageAtYearEnd >= 55 && s.levers.cpfSelf.enabled && !foreigner;
  const provided = s.levers.cpfSelf.roomToLimit !== null;

  expect(has('TAX_RESIDENCY_CHECK'), 'TAX_RESIDENCY_CHECK').toBe(foreigner && s.income.monthsWorked <= 6);
  expect(has('SRS_NON_RESIDENT_WITHDRAWAL'), 'SRS_NON_RESIDENT_WITHDRAWAL').toBe(foreigner && s.levers.srs.enabled && s.profile.ageAtYearEnd >= 18);
  expect(has('CPF_SELF_ROOM_UNCONFIRMED'), 'CPF_SELF_ROOM_UNCONFIRMED').toBe(ownCpfFrom55 && !provided);
  expect(has('AGE_55_PLUS_TOPUP'), 'AGE_55_PLUS_TOPUP').toBe(ownCpfFrom55 && provided);
  expect(has('FAMILY_TOPUP_CHECKS'), 'FAMILY_TOPUP_CHECKS').toBe(!foreigner && (r.plan.contributions.cpfFamily > 0 || s.existing.cpfTopUpFamily > 0));
  expect(has('PARENTHOOD_TAX_REBATE'), 'PARENTHOOD_TAX_REBATE').toBe(s.profile.hasUnusedParenthoodTaxRebate);
  // The two age-55 messages are alternatives: "enter your room" or "the plan uses the room you entered".
  expect(has('CPF_SELF_ROOM_UNCONFIRMED') && has('AGE_55_PLUS_TOPUP'), 'both age-55 warnings').toBe(false);

  // The same again in the words of the table, from what the engine reports about itself.
  expect(has('SRS_NON_RESIDENT_WITHDRAWAL')).toBe(r.input.profile.residency === 'foreigner' && r.levers.srs.enabled && r.levers.srs.eligible);
  expect(has('TAX_RESIDENCY_CHECK')).toBe(r.input.profile.residency === 'foreigner' && (r.input.income.monthsWorked ?? 12) <= 6);
  const reported = r.input.profile.ageAtYearEnd >= 55 && r.levers.cpfSelf.enabled && r.levers.cpfSelf.eligible;
  expect(has('CPF_SELF_ROOM_UNCONFIRMED')).toBe(reported && typeof r.input.levers.cpfSelf.roomToLimit !== 'number');
  expect(has('AGE_55_PLUS_TOPUP')).toBe(reported && typeof r.input.levers.cpfSelf.roomToLimit === 'number');
  expect(has('FAMILY_TOPUP_CHECKS')).toBe(r.levers.cpfFamily.eligible && (r.plan.contributions.cpfFamily > 0 || r.input.existing.cpfTopUpFamily > 0));
  expect(has('PARENTHOOD_TAX_REBATE')).toBe(r.input.profile.hasUnusedParenthoodTaxRebate === true);

  // What the room caution promises: the person's own CPF really is left out of the plan.
  if (has('CPF_SELF_ROOM_UNCONFIRMED')) {
    expect(r.levers.cpfSelf.room).toBe(0);
    expect(r.plan.contributions.cpfSelf).toBe(0);
  }
  // A family caution is raised whenever a family dollar is recommended.
  if (r.plan.contributions.cpfFamily > 0) expect(has('FAMILY_TOPUP_CHECKS')).toBe(true);
  // SRS is recommended to a foreigner only together with the withdrawal caution.
  if (foreigner && r.plan.contributions.srs > 0) expect(has('SRS_NON_RESIDENT_WITHDRAWAL')).toBe(true);
}

/** A dollar figure as the messages print it: "S$" and digits with thousands separators. */
const FIGURE = /S\$\d[\d,]*(?:\.\d+)?/g;
/** A message with every dollar figure replaced by "#". */
const wording = (text: string): string => text.replace(FIGURE, '#');
/** The dollar figures of a message, in order. */
const figuresIn = (text: string): number[] => (text.match(FIGURE) ?? []).map((figure) => Number(figure.slice(2).replace(/,/g, '')));

/** SPEC §6.11, "messages are normative", typed from the specification; "#" stands for a figure from the rules. */
const CAUTION_TEXT = {
  TAX_RESIDENCY_CHECK:
    'You worked here for half the year or less. You are a tax resident only if you were in Singapore for at least 183 days (IRAS has further rules for stays that span two years). Non-residents get no reliefs, so this plan would not apply.',
  SRS_NON_RESIDENT_WITHDRAWAL:
    "If you have left Singapore when you withdraw, SRS is taxed as a non-resident's: at least 7.5 cents per dollar withdrawn at retirement age or under the 10-year rule for foreigners, and at least 20 cents if earlier.",
  SRS_LOW_VALUE: ' # of this plan saves less than 7.5 cents per dollar today.',
  CPF_SELF_ROOM_UNCONFIRMED:
    'From age 55 the CPF Board accepts top-ups up to the Enhanced Retirement Sum (#), but only the part up to the Full Retirement Sum (#) earns relief, and a top-up cannot be reversed. Your own CPF is left out until you enter how much you can still top up with relief (# if you have set aside the Full Retirement Sum).',
  AGE_55_PLUS_TOPUP: (year: number): string =>
    `From age 55, cash top-ups go to your Retirement Account and earn relief only up to the Full Retirement Sum (# in ${year}). The plan uses the room you entered (#); check it against your CPF Retirement dashboard.`,
  FAMILY_TOPUP_CHECKS: (withMediSave: boolean): string =>
    `Family top-ups: the part the Government matches earns you no relief — the first # a year for a member on the Matched Retirement Savings Scheme${withMediSave ? ', # for MediSave' : ''}. The amounts here are top-ups beyond that, to a family member who qualifies.`,
  PARENTHOOD_TAX_REBATE:
    'With unused Parenthood Tax Rebate your tax bill this year may already be #. This plan would then save no cash now: it makes the rebate last longer, so the benefit arrives in a later year.',
  CPF_OVERRIDE_ABOVE_MAX_ENDING:
    "Voluntary contributions to your three CPF accounts earn no relief; a cash top-up to your MediSave, Special or Retirement Account does — enter it under 'Already contributed'.",
  DEADLINE_SOON_ENDING:
    'Banks stop taking same-day SRS contributions before midnight on the last day, some as early as 7pm, and a CPF top-up counts on the day the CPF Board receives it, so transfer as soon as you can.',
} as const;

/**
 * SPEC §6.11 `lowValueAmount`: the part of the plan's contribution that lies in ladder tiers whose rate is below
 * 0.075 — from the brackets: the plan's dollars are dollars number CI0 − X + 1 … CI0 of chargeable income.
 */
function specLowValueAmount(chargeableIncome: number, total: number): number {
  let low = 0;
  SPEC_BRACKETS.forEach((band, index) => {
    if (band.rate >= 0.075) return;
    const top = SPEC_BRACKETS[index + 1]?.from ?? Infinity;
    // dollars n with band.from < n ≤ top, within (CI0 − X, CI0]
    low += Math.max(0, Math.min(top, chargeableIncome) - Math.max(band.from, chargeableIncome - total));
  });
  return low;
}

/** The wording and the figures of the cautions that are present, against the normative text of SPEC §6.11. */
function assertCautionWording(r: PlannerResult, s: FullInput): void {
  if (!isSpecYear(s.incomeYear)) throw new Error(`unsupported year ${s.incomeYear}`);
  const year: SpecYear = s.incomeYear;
  const find = (code: string) => r.warnings.find((warning) => warning.code === code);

  const residency = find('TAX_RESIDENCY_CHECK');
  if (residency) expect(residency.message).toBe(CAUTION_TEXT.TAX_RESIDENCY_CHECK);

  const srs = find('SRS_NON_RESIDENT_WITHDRAWAL');
  if (srs) {
    const low = specLowValueAmount(r.baseline.chargeableIncome, r.plan.totalContribution);
    expect(srs.params?.lowValueAmount).toBe(low);
    // …which is what the engine's own ladder says the plan uses of the tiers below 7.5 cents.
    expect(r.ladder.filter((tier) => tier.rate < 0.075).reduce((total, tier) => total + tier.usedByPlan, 0)).toBe(low);
    expect(wording(srs.message)).toBe(CAUTION_TEXT.SRS_NON_RESIDENT_WITHDRAWAL + (low > 0 ? CAUTION_TEXT.SRS_LOW_VALUE : ''));
    expect(figuresIn(srs.message)).toEqual(low > 0 ? [low] : []);
  }

  const unconfirmed = find('CPF_SELF_ROOM_UNCONFIRMED');
  if (unconfirmed) {
    expect(wording(unconfirmed.message)).toBe(CAUTION_TEXT.CPF_SELF_ROOM_UNCONFIRMED);
    expect(figuresIn(unconfirmed.message)).toEqual([SPEC_SUMS[year].ers, SPEC_SUMS[year].frs, 0]);
  }

  const from55 = find('AGE_55_PLUS_TOPUP');
  if (from55) {
    expect(wording(from55.message)).toBe(CAUTION_TEXT.AGE_55_PLUS_TOPUP(year));
    expect(figuresIn(from55.message)).toEqual([SPEC_SUMS[year].frs, s.levers.cpfSelf.roomToLimit]);
  }

  const family = find('FAMILY_TOPUP_CHECKS');
  if (family) {
    const matched = SPEC_MATCHED_TOPUP[year];
    expect(wording(family.message)).toBe(CAUTION_TEXT.FAMILY_TOPUP_CHECKS(matched.mediSave !== null));
    expect(figuresIn(family.message)).toEqual(matched.mediSave === null ? [matched.retirement] : [matched.retirement, matched.mediSave]);
  }

  const rebate = find('PARENTHOOD_TAX_REBATE');
  if (rebate) {
    expect(wording(rebate.message)).toBe(CAUTION_TEXT.PARENTHOOD_TAX_REBATE);
    expect(figuresIn(rebate.message)).toEqual([0]);
  }

  const override = find('CPF_OVERRIDE_ABOVE_MAX');
  if (override) expect(override.message.endsWith(CAUTION_TEXT.CPF_OVERRIDE_ABOVE_MAX_ENDING), override.message).toBe(true);
  const soon = find('DEADLINE_SOON');
  if (soon) expect(soon.message.endsWith(CAUTION_TEXT.DEADLINE_SOON_ENDING), soon.message).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------
// Ladder, simulator, scenarios, monthly plan, warnings
// ---------------------------------------------------------------------------------------------------------------

describe('ladder, simulator, scenarios, monthly plan and warnings (SPEC §6.7–§6.11)', () => {
  prop('ladder: contiguous tiers from 0 to L at non-increasing statutory rates that reconcile with the plan', plannerInputArb, (input) => {
    const { r, s, m } = run(input);
    const L = m.leverRoom;
    const C = m.reliefCapRoom;
    const ci0 = m.baseline.chargeableIncome;
    const X = r.plan.totalContribution;
    const baseCents = specTaxCents(ci0);
    const withinCap = Math.min(L, C);
    const p = new Problems();

    if (L === 0) p.eq(r.ladder.length, 0, 'ladder length when L = 0');
    let cursor = 0;
    let previousRate = Infinity;
    let usedTotal = 0;
    let amountTotal = 0;
    let savedTotal = 0;
    r.ladder.forEach((tier, index) => {
      const at = `ladder[${index}]`;
      p.eq(tier.fromContribution, cursor, `${at}.fromContribution`);
      p.check(tier.toContribution > tier.fromContribution, () => `${at} is empty`);
      p.eq(tier.amount, tier.toContribution - tier.fromContribution, `${at}.amount`);
      p.check(tier.rate <= previousRate, () => `${at}.rate ${tier.rate} rises above ${previousRate}`);
      p.eq(tier.zeroReason !== undefined, tier.rate === 0, `${at} has a zeroReason iff its rate is 0`);
      p.eq('zeroReason' in tier, tier.rate === 0, `${at} has the zeroReason key iff its rate is 0`);

      if (tier.fromContribution < withinCap) {
        // Dollars that reduce chargeable income: one statutory rate throughout, from CI0 − from down to CI0 − to + 1.
        p.check(tier.toContribution <= withinCap, () => `${at} straddles the relief cap at ${withinCap}`);
        p.eq(tier.rate, specRateOfDollar(ci0 - tier.fromContribution), `${at}.rate (first dollar)`);
        p.eq(tier.rate, specRateOfDollar(ci0 - tier.toContribution + 1), `${at}.rate (last dollar)`);
        if (tier.rate === 0) p.eq(tier.zeroReason, 'belowTaxThreshold', `${at}.zeroReason`);
      } else {
        p.eq(tier.rate, 0, `${at}.rate beyond the relief cap`);
        p.eq(tier.zeroReason, 'reliefCap', `${at}.zeroReason`);
      }
      const savedCents = m.taxCentsAfter(tier.fromContribution) - m.taxCentsAfter(tier.toContribution);
      p.eq(cents(tier.taxSaved), savedCents, `${at}.taxSaved in cents`);
      p.eq(cents(tier.cumulativeTaxSaved), baseCents - m.taxCentsAfter(tier.toContribution), `${at}.cumulativeTaxSaved in cents`);
      p.eq(tier.usedByPlan, Math.max(0, Math.min(tier.toContribution, X) - tier.fromContribution), `${at}.usedByPlan`);
      // Without a rebate a tier saves its rate on every dollar (each end of the tier is rounded to the cent).
      p.check(Math.abs(cents(tier.taxSaved) - tier.rate * tier.amount * 100) <= 0.5 + 1e-6, () => `${at}: ${tier.taxSaved} is not ${tier.rate} × ${tier.amount}`);

      const next = r.ladder[index + 1];
      if (next) p.check(next.rate !== tier.rate || next.zeroReason !== tier.zeroReason, () => `${at} and the next tier should have been merged`);
      cursor = tier.toContribution;
      previousRate = tier.rate;
      usedTotal += tier.usedByPlan;
      amountTotal += tier.amount;
      savedTotal += cents(tier.taxSaved);
    });
    p.eq(cursor, L, 'the last tier ends at L');
    p.eq(amountTotal, L, 'tier amounts sum to L');
    p.eq(usedTotal, X, 'usedByPlan sums to the plan total');
    const last = r.ladder[r.ladder.length - 1];
    const everything = specAllocate(L, m.rooms, s.preferences.priority);
    const savedByEverything = cents(r.baseline.taxPayable) - cents(evaluate(input, everything).taxPayable);
    p.eq(last ? cents(last.cumulativeTaxSaved) : 0, savedByEverything, 'last cumulativeTaxSaved vs evaluate(everything)');
    p.eq(savedTotal, savedByEverything, 'tier savings sum to the saving from contributing L');
    // The part of the ladder the plan uses adds up to the plan's saving.
    const tierOfPlan = r.ladder.filter((tier) => tier.toContribution <= X);
    const fullyUsed = tierOfPlan.reduce((total, tier) => total + cents(tier.taxSaved), 0);
    p.check(fullyUsed <= cents(r.plan.taxSaved), () => `fully-used tiers save ${fullyUsed}c > plan ${cents(r.plan.taxSaved)}c`);
    // The plan never stops inside a tier it could finish for free… and never uses a zero-rate tier.
    for (const tier of r.ladder) p.check(tier.rate > 0 || tier.usedByPlan === 0, () => `the plan uses ${tier.usedByPlan} of a 0% tier`);
    p.done();
  });

  prop('simulator: rows 0…L in steps, splits within rooms, savings non-decreasing and reconciled', plannerInputArb, (input) => {
    const { r, s, m } = run(input);
    const L = m.leverRoom;
    const step = s.preferences.simulatorStep;
    const X = r.plan.totalContribution;
    const baseCents = cents(r.baseline.taxPayable);
    const rows = r.simulator;
    const p = new Problems();

    p.eq(rows.length, Math.ceil(L / step) + 1, 'row count');
    p.eq(rows[0]?.contribution, 0, 'first row');
    p.eq(rows[rows.length - 1]?.contribution, L, 'last row');
    let stepTotal = 0;
    rows.forEach((row, index) => {
      const at = `simulator[${index}]`;
      const previous = index > 0 ? rows[index - 1] : undefined;
      p.eq(row.contribution, Math.min(index * step, L), `${at}.contribution`);
      if (previous) p.check(row.contribution > previous.contribution, () => `${at}.contribution does not increase`);
      p.eq(sum(row.split), row.contribution, `${at}.split sums to the contribution`);
      for (const lever of LEVERS) p.check(row.split[lever] >= 0 && row.split[lever] <= m.rooms[lever], () => `${at}.split.${lever} = ${row.split[lever]} exceeds room ${m.rooms[lever]}`);
      const expectedSplit = specAllocate(row.contribution, m.rooms, s.preferences.priority);
      p.check(LEVERS.every((lever) => row.split[lever] === expectedSplit[lever]), () => `${at}.split is not the priority walk`);
      p.eq(cents(row.taxPayable), m.taxCentsAfter(row.contribution), `${at}.taxPayable in cents`);
      p.eq(cents(row.taxSaved), baseCents - cents(row.taxPayable), `${at}.taxSaved`);
      p.eq(cents(row.stepSaving), previous ? cents(row.taxSaved) - cents(previous.taxSaved) : 0, `${at}.stepSaving`);
      p.eq(row.stepRate, previous ? row.stepSaving / (row.contribution - previous.contribution) : 0, `${at}.stepRate`);
      if (previous) p.check(cents(row.taxSaved) >= cents(previous.taxSaved), () => `${at}.taxSaved falls`);
      if (previous) p.check(cents(row.stepSaving) <= cents(previous.stepSaving) + 1 || index === 1 || row.contribution - previous.contribution < step, () => `${at}.stepSaving rises`);
      p.eq(row.withinPlan, row.contribution <= X, `${at}.withinPlan`);
      stepTotal += cents(row.stepSaving);
    });
    const lastRow = rows[rows.length - 1];
    p.eq(stepTotal, lastRow ? cents(lastRow.taxSaved) : 0, 'step savings sum to the last taxSaved');
    p.done();
    // Spot-check a few rows through the public evaluate().
    for (const row of [rows[0], rows[Math.floor(rows.length / 2)], lastRow]) {
      if (row) expect(row.taxPayable).toBe(evaluate(input, row.split).taxPayable);
    }
  });

  prop('scenarios: six rows in SPEC order, each consistent with evaluate() and with the definition of waste', plannerInputArb, (input) => {
    const { r, s, m } = run(input);
    expect(r.scenarios.map((scenario) => scenario.id)).toEqual(['none', 'srsOnly', 'cpfSelfOnly', 'srsPlusCpfSelf', 'maxAll', 'recommended']);
    const srs = m.levers.srs.roomIfEnabled;
    const cpfSelf = m.levers.cpfSelf.roomIfEnabled;
    const cpfFamily = m.levers.cpfFamily.room;
    // §6.9 ignores the switch of the person's own CPF, not the §6.5 rule: from 55 a blank room is no room.
    if (s.profile.ageAtYearEnd >= 55 && s.levers.cpfSelf.roomToLimit === null) {
      expect(cpfSelf).toBe(0);
      for (const scenario of r.scenarios) expect(scenario.contributions.cpfSelf, scenario.id).toBe(0);
    }
    const expected: LeverAmounts[] = [
      { srs: 0, cpfSelf: 0, cpfFamily: 0 },
      { srs, cpfSelf: 0, cpfFamily: 0 },
      { srs: 0, cpfSelf, cpfFamily: 0 },
      { srs, cpfSelf, cpfFamily: 0 },
      { srs, cpfSelf, cpfFamily },
      r.plan.contributions,
    ];
    const ci0 = m.baseline.chargeableIncome;
    const baseCents = cents(r.baseline.taxPayable);
    r.scenarios.forEach((scenario, index) => {
      const what = scenario.id;
      expect(scenario.contributions, what).toEqual(expected[index]);
      const total = sum(scenario.contributions);
      expect(scenario.totalContribution, what).toBe(total);
      const evaluated = evaluate(input, scenario.contributions);
      expect(scenario.taxPayable, what).toBe(evaluated.taxPayable);
      expect(cents(scenario.taxSaved), what).toBe(baseCents - cents(evaluated.taxPayable));
      expect(scenario.savingRate, what).toBe(total === 0 ? 0 : scenario.taxSaved / total);
      const effective = Math.min(total, specUsefulRoom(ci0, 0), m.reliefCapRoom);
      expect(scenario.wastedContribution, what).toBe(total - effective);
      // The dollars not counted as wasted are the ones that produce the whole saving, each at a positive rate.
      expect(cents(scenario.taxSaved), what).toBe(baseCents - specTaxCents(ci0 - effective));
      if (effective > 0) expect(specRateOfDollar(ci0 - effective + 1), what).toBeGreaterThan(0);
      expect(cents(scenario.taxSaved), what).toBeGreaterThanOrEqual(0);
    });
    const [none, , , , maxAll, recommended] = r.scenarios;
    expect([none?.totalContribution, none?.taxSaved, none?.wastedContribution, none?.taxPayable]).toEqual([0, 0, 0, r.baseline.taxPayable]);
    expect([recommended?.taxSaved, recommended?.taxPayable, recommended?.wastedContribution]).toEqual([r.plan.taxSaved, r.plan.taxAfter, 0]);
    // No scenario saves more than "everything", and the recommendation never saves more than it either.
    for (const scenario of r.scenarios) expect(cents(scenario.taxSaved), scenario.id).toBeLessThanOrEqual(cents(maxAll?.taxSaved ?? 0));
  });

  prop('monthly plan: instalments to December that sum exactly to the plan; deadline arithmetic', plannerInputArb, (input) => {
    const { r, s } = run(input);
    const mp = r.monthlyPlan;
    const dates = specDates(s.incomeYear, s.today);
    const { contributions } = r.plan;
    const X = r.plan.totalContribution;
    expect(mp.deadline).toBe(dates.deadline);
    expect(mp.daysToDeadline).toBe(dates.daysToDeadline);
    expect(mp.monthsRemaining).toBe(dates.monthsRemaining);

    const n = dates.monthsRemaining;
    if (n > 0 && X > 0) {
      expect(mp.schedule).toHaveLength(n);
      mp.schedule.forEach((row, index) => {
        // Consecutive months ending in December of the income year.
        expect(row.month).toBe(`${s.incomeYear}-${String(12 - n + 1 + index).padStart(2, '0')}`);
        expect(row.total).toBe(sum(row.amounts));
      });
      expect(mp.schedule[n - 1]?.month).toBe(`${s.incomeYear}-12`);
      for (const lever of LEVERS) {
        const amounts = mp.schedule.map((row) => row.amounts[lever]);
        expect(amounts.reduce((total, amount) => total + amount, 0), lever).toBe(contributions[lever]);
        const base = Math.floor(contributions[lever] / n);
        const extra = contributions[lever] - base * n;
        expect(amounts, lever).toEqual(Array.from({ length: n }, (_unused, index) => (index < extra ? base + 1 : base)));
      }
      expect(mp.schedule.reduce((total, row) => total + row.total, 0)).toBe(X);
    } else {
      expect(mp.schedule).toEqual([]);
    }
    for (const lever of LEVERS) expect(mp.fullYearMonthly[lever], lever).toBe(Math.ceil(contributions[lever] / 12));
    expect(mp.fullYearMonthly.total).toBe(LEVERS.reduce((total, lever) => total + Math.ceil(contributions[lever] / 12), 0));
    // Twelve of the full-year instalments cover the plan, and overshoot by less than 12 dollars per lever.
    for (const lever of LEVERS) {
      expect(mp.fullYearMonthly[lever] * 12).toBeGreaterThanOrEqual(contributions[lever]);
      expect(mp.fullYearMonthly[lever] * 12 - contributions[lever]).toBeLessThan(12);
    }
  });

  prop(
    'calendar: daysToDeadline and monthsRemaining for any date from year 1 to 9999 (leap years, century years, time suffixes)',
    fc.tuple(
      fc.constantFrom(...SPEC_YEARS),
      fc.oneof(
        fc.integer({ min: 1, max: 9_999 }),
        fc.integer({ min: 1_890, max: 2_110 }),
        fc.constantFrom(1900, 2000, 2100, 2400),
        fc.integer({ min: 2_023, max: 2_029 }),
        fc.integer({ min: 2_024, max: 2_028 }),
      ),
      fc.oneof(fc.integer({ min: 1, max: 12 }), fc.constantFrom(12, 12, 1, 2, 3)),
      fc.oneof(fc.integer({ min: 1, max: 31 }), fc.constantFrom(1, 15, 16, 17, 18, 28, 29, 30, 31)),
      fc.constantFrom('', 'T00:00:00Z', 'T23:59:59+08:00', ' 12:00', 'T12:34:56.789-11:00'),
    ),
    ([incomeYear, year, month, rawDay, suffix]) => {
      const lastDay = new Date(Date.UTC(2000, month, 0)).getUTCDate();
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      const day = Math.min(rawDay, month === 2 ? (leap ? 29 : 28) : lastDay);
      const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const r = plan({ ...example({ incomeYear }), today: date + suffix });
      expect(r.input.today).toBe(date);
      // The platform's own calendar, used only here.
      const utc = (y: number, m: number, d: number): number => {
        const moment = new Date(0);
        moment.setUTCFullYear(y, m - 1, d);
        return moment.getTime();
      };
      expect(r.monthlyPlan.daysToDeadline).toBe(Math.round((utc(incomeYear, 12, 31) - utc(year, month, day)) / 86_400_000));
      expect(r.monthlyPlan.monthsRemaining).toBe(year < incomeYear ? 12 : year > incomeYear ? 0 : 13 - month);
      expect(r.monthlyPlan.schedule).toHaveLength(r.monthlyPlan.monthsRemaining);
      expect(r.warnings.some((warning) => warning.code === 'DEADLINE_PASSED')).toBe(year > incomeYear);
      expect(r.warnings.some((warning) => warning.code === 'DEADLINE_SOON')).toBe(year === incomeYear && month === 12 && day >= 17);
    },
  );

  prop('warnings: at most one per code, in table order, each exactly when its §6.11 condition holds', plannerInputArb, (input) => {
    const { r, s, m } = run(input);
    const dates = specDates(s.incomeYear, s.today);
    const existing = existingOf(s);
    const foreigner = s.profile.residency === 'foreigner';
    const ownCpfFrom55 = s.profile.ageAtYearEnd >= 55 && s.levers.cpfSelf.enabled && !foreigner;
    const condition: Record<string, boolean> = {
      NO_TAX_PAYABLE: m.baseline.taxPayable === 0,
      RELIEF_CAP_EXCEEDED_BASELINE: m.baseline.reliefs.lostToCap > 0,
      RELIEF_CAP_LIMITS_PLAN: m.bindingConstraint === 'reliefCap',
      BELOW_MIN_SAVING_RATE: m.baseline.taxPayable > 0 && m.usefulRoom === 0,
      BUDGET_LIMITS_PLAN: m.bindingConstraint === 'cashBudget',
      LEVER_LIMITS_PLAN: m.bindingConstraint === 'leverLimits',
      EXISTING_EXCEEDS_CAP: LEVERS.some((lever) => m.levers[lever].statutoryCap > 0 && existing[lever] > m.levers[lever].statutoryCap),
      CPF_OVERRIDE_ABOVE_MAX:
        !foreigner && s.income.employeeCpfOverride !== null && s.income.employeeCpfOverride > SPEC_MAX_COMPULSORY_CPF,
      FOREIGNER_NO_CPF: foreigner,
      TAX_RESIDENCY_CHECK: foreigner && s.income.monthsWorked <= 6,
      SRS_NON_RESIDENT_WITHDRAWAL: foreigner && s.levers.srs.enabled && s.profile.ageAtYearEnd >= 18,
      PR_GRADUATED_RATES: s.profile.residency === 'pr' && s.profile.prYear < 3,
      CPF_SELF_ROOM_UNCONFIRMED: ownCpfFrom55 && !specRoomProvided(s),
      AGE_55_PLUS_TOPUP: ownCpfFrom55 && specRoomProvided(s),
      FAMILY_TOPUP_CHECKS: !foreigner && (m.contributions.cpfFamily > 0 || s.existing.cpfTopUpFamily > 0),
      PARENTHOOD_TAX_REBATE: s.profile.hasUnusedParenthoodTaxRebate,
      SRS_UNDER_18: s.profile.ageAtYearEnd < 18,
      DEADLINE_PASSED: dates.daysToDeadline < 0,
      DEADLINE_SOON: dates.daysToDeadline >= 0 && dates.daysToDeadline <= 14 && m.total > 0,
      PROJECTED_RULES: s.incomeYear === 2027,
      PIT_REBATE_APPLIED: false, // no supported year has a rebate
    };
    expect(Object.keys(condition)).toEqual(SPEC_WARNINGS.map(([code]) => code));
    const codes = r.warnings.map((warning) => warning.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual(SPEC_WARNINGS.filter(([code]) => condition[code]).map(([code]) => code));
    const severity = new Map(SPEC_WARNINGS);
    for (const warning of r.warnings) {
      expect(warning.severity, warning.code).toBe(severity.get(warning.code));
      expect(typeof warning.message === 'string' && warning.message.length > 0, warning.code).toBe(true);
      expect(warning.message, warning.code).not.toMatch(/NaN|undefined|Infinity|null|\[object/);
      for (const value of Object.values(warning.params ?? {})) {
        expect(typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)), `${warning.code} params`).toBe(true);
      }
    }
    // The same conditions from the engine's own outputs.
    expect(codes.includes('NO_TAX_PAYABLE')).toBe(r.baseline.taxPayable === 0);
    expect(codes.includes('RELIEF_CAP_LIMITS_PLAN')).toBe(r.plan.bindingConstraint === 'reliefCap');
    expect(codes.includes('BUDGET_LIMITS_PLAN')).toBe(r.plan.bindingConstraint === 'cashBudget');
    expect(codes.includes('LEVER_LIMITS_PLAN')).toBe(r.plan.bindingConstraint === 'leverLimits');
    expect(codes.includes('DEADLINE_PASSED')).toBe(r.monthlyPlan.daysToDeadline < 0);
    expect(codes.includes('DEADLINE_SOON')).toBe(
      r.monthlyPlan.daysToDeadline >= 0 && r.monthlyPlan.daysToDeadline <= 14 && r.plan.totalContribution > 0,
    );
    expect(codes.includes('PROJECTED_RULES')).toBe(r.rules.status === 'projected');
    assertCautions(r, s);
    assertCautionWording(r, s);
  });

  prop('the cautions for what the tool cannot see, on inputs that need sanitising and on garbage: each exactly when its condition holds', fc.oneof(messyInputArb, messyInputArb, garbageInputArb), (raw) => {
    const r = plan(raw as PlannerInput);
    const s = specSanitise(raw);
    expect(r.input).toEqual(s);
    assertCautions(r, s);
    assertCautionWording(r, s);
    // …in table order, one per code, with the table's severities.
    const codes = r.warnings.map((warning) => warning.code);
    expect(codes).toEqual(SPEC_WARNINGS.map(([code]) => code).filter((code) => codes.includes(code)));
    const severity = new Map(SPEC_WARNINGS);
    for (const warning of r.warnings) expect(warning.severity, warning.code).toBe(severity.get(warning.code));
  });

  prop('LEVER_LIMITS_PLAN quotes only a saving the person can reach: every scheme left off switched on, at its own room', plannerInputArb, (input) => {
    const { r, s, m } = run(input);
    const warning = r.warnings.find((candidate) => candidate.code === 'LEVER_LIMITS_PLAN');
    expect(warning !== undefined).toBe(m.bindingConstraint === 'leverLimits');
    if (!warning) return;
    // §6.11: N(X) − N(min(U, C, B, Σ roomIfEnabled)); roomIfEnabled is 0 for an ineligible scheme, respects the
    // person's own limits and — §6.5 — is 0 for the person's own CPF from 55 until a room has been entered.
    const everyScheme = m.levers.srs.roomIfEnabled + m.levers.cpfSelf.roomIfEnabled + m.levers.cpfFamily.roomIfEnabled;
    const reachable = Math.min(m.usefulRoom, m.reliefCapRoom, m.budget, everyScheme);
    const ci0 = m.baseline.chargeableIncome;
    const extraCents = specTaxCents(ci0 - m.total) - specTaxCents(ci0 - reachable);
    expect(extraCents).toBeGreaterThanOrEqual(0);
    expect(cents(Number(warning.params?.savingIfSwitchedOn))).toBe(extraCents);
    // The same figure the way a person would find it: switch every scheme on and plan again.
    const allOn = plan({
      ...input,
      levers: {
        srs: { ...input.levers.srs, enabled: true },
        cpfSelf: { ...input.levers.cpfSelf, enabled: true },
        cpfFamily: { ...input.levers.cpfFamily, enabled: true },
      },
    });
    expect(cents(allOn.plan.taxSaved) - cents(r.plan.taxSaved)).toBe(extraCents);
    // From 55 with the room blank, the person's own CPF is not part of "what you could still switch on".
    if (s.profile.ageAtYearEnd >= 55 && !specRoomProvided(s)) {
      expect(everyScheme).toBe(m.levers.srs.roomIfEnabled + m.levers.cpfFamily.roomIfEnabled);
      expect(allOn.plan.contributions.cpfSelf).toBe(0);
    }
    // The sentence is left out when its figure is 0 (§6.11), so a dollar figure in the message means a reachable saving.
    if (extraCents === 0) expect(warning.message).not.toMatch(/switch/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Idempotence, purity, determinism
// ---------------------------------------------------------------------------------------------------------------

describe('idempotence and purity', () => {
  prop('plan(result.input) equals plan(input); sanitiseInput is idempotent; nothing is mutated; results are plain JSON', plannerInputArb, (input) => {
    const before = JSON.stringify(input);
    const r = plan(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(plan(input)).toEqual(r);
    const again = plan(r.input);
    expect(again).toEqual(r);
    expect(again.input).toEqual(r.input);
    const once = sanitiseInput(input);
    expect(sanitiseInput(once)).toEqual(once);
    expect(JSON.stringify(input)).toBe(before);
    // Nothing that JSON would drop or turn into null.
    const { rules: _rules, ...rest } = r;
    expect(clone(rest)).toEqual(rest);
    // `today` only matters to the monthly plan and the deadline warnings.
    const otherDay = plan({ ...input, today: `${input.incomeYear}-01-01` });
    expect(otherDay.plan).toEqual(r.plan);
    expect(otherDay.baseline).toEqual(r.baseline);
    expect(otherDay.ladder).toEqual(r.ladder);
    expect(otherDay.scenarios).toEqual(r.scenarios);
  });

  prop('garbage: sanitiseInput is idempotent and plan(sanitised) equals plan(raw)', garbageInputArb, (raw) => {
    const once = sanitiseInput(raw as PlannerInput);
    expect(sanitiseInput(once)).toEqual(once);
    expect(plan(once)).toEqual(plan(raw as PlannerInput));
  });

  it('the rule data is not changed by planning', () => {
    const snapshot = JSON.stringify(SPEC_YEARS.map((year) => getRules(year)));
    for (const input of seededInputs(500, 4_242)) plan(input);
    expect(JSON.stringify(SPEC_YEARS.map((year) => getRules(year)))).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A year with a Personal Income Tax Rebate (rules are data: SPEC §5.1, §6.4, §6.6 "Statutory-rate note")
// ---------------------------------------------------------------------------------------------------------------

describe('a rule set with a Personal Income Tax Rebate (SPEC §6.4, §6.6, §6.7, §6.11)', () => {
  const rebateArb = fc.constantFrom({ rate: 0.6, cap: 200 }, { rate: 0.5, cap: 200 }, { rate: 0.5, cap: 500 }, { rate: 1, cap: 100 }, { rate: 0.125, cap: 1_000 });
  /** min(cap, round2(rate × grossTax)) in cents; rates here are whole per-mille values. */
  const rebateCents = (grossCents: number, rebate: { rate: number; cap: number }): number =>
    Math.min(rebate.cap * 100, Math.floor((Math.round(rebate.rate * 1000) * grossCents + 500) / 1000));

  prop('rebate = min(cap, round2(rate × gross)); realised savings; the plan is still optimal for tax payable', fc.tuple(plannerInputArb, rebateArb), ([input, pitRebate]) => {
    const rules: YearRules = { ...getRules(input.incomeYear), pitRebate };
    const r = planFor(sanitise(input), rules);
    const s = specSanitise(input);
    const m = specPlan(s);
    assertWellFormed(r);
    const payable = (ci: number): number => {
      const gross = specTaxCents(ci);
      return Math.max(0, gross - rebateCents(gross, pitRebate));
    };
    const ci0 = m.baseline.chargeableIncome;
    for (const [t, ci] of [[r.baseline, ci0], [r.optimised, ci0 - m.total]] as const) {
      expect(t.chargeableIncome).toBe(ci);
      expect(cents(t.grossTax)).toBe(specTaxCents(ci));
      expect(cents(t.pitRebate)).toBe(rebateCents(specTaxCents(ci), pitRebate));
      expect(cents(t.taxPayable)).toBe(payable(ci));
    }
    // The amount recommended is decided on statutory rates, so it is the same with and without the rebate.
    expect(r.plan.totalContribution).toBe(m.total);
    expect(r.plan.contributions).toEqual(m.contributions);
    expect(cents(r.plan.taxSaved)).toBe(payable(ci0) - payable(ci0 - m.total));
    expect(r.plan.taxSaved).toBeGreaterThanOrEqual(0);
    expect(r.warnings.some((warning) => warning.code === 'PIT_REBATE_APPLIED')).toBe(r.baseline.pitRebate > 0);
    expect(r.warnings.some((warning) => warning.code === 'NO_TAX_PAYABLE')).toBe(payable(ci0) === 0);
    // Tax payable stays monotone in relief, so no smaller or equal total saves more…
    const after = (c: number): number => payable(Math.max(0, ci0 - Math.min(c, m.reliefCapRoom)));
    for (const tier of r.ladder) {
      expect(cents(tier.taxSaved)).toBe(after(tier.fromContribution) - after(tier.toContribution));
      expect(cents(tier.cumulativeTaxSaved)).toBe(payable(ci0) - after(tier.toContribution));
      expect(tier.rate).toBe(tier.fromContribution < Math.min(m.leverRoom, m.reliefCapRoom) ? specRateOfDollar(ci0 - tier.fromContribution) : 0);
    }
    for (const row of r.simulator) expect(cents(row.taxPayable)).toBe(after(row.contribution));
    let best = 0;
    for (let T = 0; T <= m.total; T += Math.max(1, Math.floor(m.total / 200))) best = Math.max(best, payable(ci0) - payable(ci0 - T));
    expect(cents(r.plan.taxSaved)).toBeGreaterThanOrEqual(best);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The generators reach the cases the properties are about
// ---------------------------------------------------------------------------------------------------------------

describe('generator coverage and engine speed', () => {
  const inputs = seededInputs(4_000, 20_261_113);

  it('the seeded generator reaches every year, residency, binding constraint, warning and boundary case', () => {
    const count = new Map<string, number>();
    const bump = (key: string): void => void count.set(key, (count.get(key) ?? 0) + 1);
    for (const input of inputs) {
      const r = plan(input);
      const s = specSanitise(input);
      const o = fromOutputs(r, s);
      bump(`year:${input.incomeYear}`);
      bump(`residency:${input.profile.residency}`);
      bump(`binding:${r.plan.bindingConstraint}`);
      for (const warning of r.warnings) bump(`warning:${warning.code}`);
      if (r.plan.totalContribution > 0) bump('plan>0');
      if (r.plan.unrealisedSaving > 0) bump('unrealised>0');
      if (r.ladder.length >= 3) bump('ladder>=3 tiers');
      if (r.ladder.some((tier) => tier.zeroReason === 'reliefCap')) bump('ladder:reliefCap tier');
      if (r.ladder.some((tier) => tier.zeroReason === 'belowTaxThreshold')) bump('ladder:belowTaxThreshold tier');
      if (BRACKET_BOUNDARIES.includes(r.baseline.chargeableIncome)) bump('CI0 on a bracket boundary');
      if (BRACKET_BOUNDARIES.includes(r.baseline.chargeableIncome - 1)) bump('CI0 one above a boundary');
      if (BRACKET_BOUNDARIES.includes(r.plan.chargeableIncomeAfter) && r.plan.totalContribution > 0) bump('plan stops on a boundary');
      if (r.baseline.assessableIncome % 1 !== 0) bump('assessable ends in .50');
      if (r.baseline.reliefs.lostToCap > 0) bump('reliefs over the cap');
      if (r.reliefCapRoom > 0 && r.reliefCapRoom < o.L) bump('0 < C < L');
      if (r.cpf.source === 'override') bump('cpf override');
      if (new Set(r.cpf.monthlyEmployeeRates.filter((rate) => rate > 0)).size > 1) bump('age band changes mid-year');
      if (r.cpf.additionalWagesSubject < r.input.income.additionalWages && r.cpf.additionalWagesSubject > 0) bump('AW cut by the ceiling');
      if (r.input.income.monthlyOrdinaryWage > 500 && r.input.income.monthlyOrdinaryWage <= 750) bump('wage in phase-in range');
      const ties = [o.U, o.C, o.L, o.B].filter((value) => value === o.X).length;
      if (ties >= 2 && r.baseline.taxPayable > 0) bump('tie between constraints');
      if (o.B === o.X && o.X > 0 && o.X === o.L) bump('budget ties with lever room');
      if (r.monthlyPlan.schedule.length > 0) bump('schedule');
      if (r.monthlyPlan.monthsRemaining === 12 && input.today.slice(0, 4) !== String(input.incomeYear)) bump('today before the year');
      if (r.simulator.length > 100) bump('simulator > 100 rows');
    }
    const required: [string, number][] = [
      ['year:2025', 800], ['year:2026', 800], ['year:2027', 800],
      ['residency:citizen', 1_000], ['residency:pr', 800], ['residency:foreigner', 600],
      ['binding:none', 100], ['binding:usefulRoom', 300], ['binding:reliefCap', 100], ['binding:leverLimits', 300], ['binding:cashBudget', 100],
      ...SPEC_WARNINGS.filter(([code]) => code !== 'PIT_REBATE_APPLIED').map(([code]): [string, number] => [`warning:${code}`, 40]),
      ['plan>0', 1_200], ['unrealised>0', 300], ['ladder>=3 tiers', 100], ['ladder:reliefCap tier', 100], ['ladder:belowTaxThreshold tier', 100],
      ['CI0 on a bracket boundary', 30], ['CI0 one above a boundary', 20], ['plan stops on a boundary', 40], ['assessable ends in .50', 150],
      ['reliefs over the cap', 100], ['0 < C < L', 100], ['cpf override', 300], ['age band changes mid-year', 80], ['AW cut by the ceiling', 300],
      ['wage in phase-in range', 100], ['tie between constraints', 100], ['budget ties with lever room', 20], ['schedule', 800],
      ['today before the year', 200], ['simulator > 100 rows', 100],
    ];
    if (process.env.PROP_SHOW_COVERAGE) console.log([...count.entries()].sort().map(([key, n]) => `${key}: ${n}`).join('\n'));
    const missing = required.filter(([key, minimum]) => (count.get(key) ?? 0) < minimum).map(([key, minimum]) => `${key}: ${count.get(key) ?? 0} < ${minimum}`);
    expect(missing).toEqual([]);
  });

  it('plan() takes well under 5 ms (SPEC §7)', () => {
    for (const input of inputs.slice(0, 300)) plan(input); // warm-up
    const started = performance.now();
    for (const input of inputs) plan(input);
    const mean = (performance.now() - started) / inputs.length;
    expect(mean).toBeLessThan(5);
    // The largest output: a foreigner's S$35,700 of SRS room in S$100 steps (358 simulator rows).
    const worst: PlannerInput = {
      ...example({ profile: { residency: 'foreigner' }, income: { monthlyOrdinaryWage: 60_000 }, preferences: { simulatorStep: 100, minSavingRate: 0 } }),
    };
    const timings: number[] = [];
    for (let i = 0; i < 31; i++) {
      const t0 = performance.now();
      plan(worst);
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    expect(plan(worst).simulator).toHaveLength(358);
    expect(timings[15]!).toBeLessThan(5);
  });
});
