/**
 * Workbook parity (SPEC §9, §10): the spreadsheet formulas must equal the engine.
 *
 * The test builds the workbook, writes a set of input profiles into copies, recalculates ALL copies in a single
 * headless LibreOffice run, reads the results back through the workbook's named ranges (`out_*`) and compares
 * them with `plan()` — money to the cent. It is skipped, with a console message, when `soffice` is not on PATH.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultInput, getRules, plan, sanitiseInput } from '../src/engine/index';
import type { LeverId, PlannerInput, PlannerResult, YearRules } from '../src/engine/index';
import {
  EXAMPLE,
  INPUT_NAMES,
  MONTH_LABELS,
  NO,
  PRIORITY_PRESETS,
  PR_YEAR_LABELS,
  RESIDENCY_LABELS,
  SCENARIO_IDS,
  SHEETS,
  SIMULATOR_STEPS,
  WARNING_CODES,
  YES,
  buildWorkbook,
  buildWorkbookWithMap,
  findSoffice,
  recalculate,
  releaseFileName,
} from '../workbook/build';
import type { BuiltWorkbook, InputName } from '../workbook/build';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-11-13';

// ---------------------------------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------------------------------

interface Overrides {
  incomeYear?: number;
  today?: string;
  profile?: Partial<PlannerInput['profile']>;
  income?: Partial<PlannerInput['income']>;
  existing?: Partial<PlannerInput['existing']>;
  otherReliefs?: number;
  levers?: {
    srs?: Partial<PlannerInput['levers']['srs']>;
    cpfSelf?: Partial<PlannerInput['levers']['cpfSelf']>;
    cpfFamily?: Partial<PlannerInput['levers']['cpfFamily']>;
  };
  preferences?: Partial<PlannerInput['preferences']>;
}

/** The opening example (SPEC A.1) with some fields replaced. */
function make(overrides: Overrides = {}): PlannerInput {
  const base = defaultInput(TODAY);
  return {
    incomeYear: overrides.incomeYear ?? 2026,
    today: overrides.today ?? TODAY,
    profile: { ...base.profile, ...overrides.profile },
    income: { ...base.income, ...overrides.income },
    existing: { ...base.existing, ...overrides.existing },
    otherReliefs: overrides.otherReliefs ?? base.otherReliefs,
    levers: {
      srs: { ...base.levers.srs, ...overrides.levers?.srs },
      cpfSelf: { ...base.levers.cpfSelf, ...overrides.levers?.cpfSelf },
      cpfFamily: { ...base.levers.cpfFamily, ...overrides.levers?.cpfFamily },
    },
    preferences: { ...base.preferences, ...overrides.preferences },
  };
}

const FLEX: LeverId[] = ['srs', 'cpfSelf', 'cpfFamily'];
const INTEREST: LeverId[] = ['cpfSelf', 'srs', 'cpfFamily'];
const FAMILY: LeverId[] = ['cpfFamily', 'srs', 'cpfSelf'];
const ALL_ON = { srs: { enabled: true }, cpfSelf: { enabled: true }, cpfFamily: { enabled: true } };

/**
 * Rule sets a buyer might create by editing the Rules sheet. The public `plan()` only knows the registered
 * income years, so for these the engine's internal `planFor(sanitisedInput, rules)` supplies the expected result.
 */
const BASE_2026 = getRules(2026);
const CUSTOM_RULES: Record<string, YearRules> = {
  rebate: { ...BASE_2026, pitRebate: { rate: 0.6, cap: 200 } },
  edited: {
    ...BASE_2026,
    taxBrackets: [
      { from: 0, rate: 0 },
      { from: 22_000, rate: 0.025 },
      { from: 35_000, rate: 0.045 },
      { from: 50_000, rate: 0.08 },
      { from: 90_000, rate: 0.125 },
      { from: 150_000, rate: 0.165 },
      { from: 250_000, rate: 0.205 },
      { from: 600_000, rate: 0.25 },
    ],
    pitRebate: { rate: 0.5, cap: 300 },
    personalReliefCap: 60_000,
    earnedIncomeRelief: { below55: 1_500, age55to59: 6_500, age60plus: 9_000 },
    donationDeductionMultiplier: 3,
    cpf: {
      ...BASE_2026.cpf,
      owCeilingMonthly: 9_000,
      annualWageCeiling: 120_000,
      fullRates: [
        { maxAge: 50, employeeRate: 0.21, employerRate: 0.17, phaseInFactor: 0.63 },
        { maxAge: 58, employeeRate: 0.165, employerRate: 0.16, phaseInFactor: 0.495 },
        { maxAge: 65, employeeRate: 0.115, employerRate: 0.125, phaseInFactor: 0.345 },
        { maxAge: 70, employeeRate: 0.075, employerRate: 0.09, phaseInFactor: 0.225 },
        { maxAge: null, employeeRate: 0.05, employerRate: 0.075, phaseInFactor: 0.15 },
      ],
    },
    srs: { ...BASE_2026.srs, capCitizenPr: 18_000, capForeigner: 40_000, minAge: 21 },
    cpfTopUp: { ...BASE_2026.cpfTopUp, selfReliefCap: 10_000, familyReliefCap: 6_000, familyGiverResidency: ['citizen', 'pr', 'foreigner'] },
  },
};

interface Profile {
  name: string;
  input: PlannerInput;
  /** Key of CUSTOM_RULES when the workbook is built from edited rules. */
  rules?: keyof typeof CUSTOM_RULES;
}

const MIN_RATE_CHOICES = [0, 0.02, 0.035, 0.07, 0.115, 0.15, 0.18, 0.19, 0.195, 0.2, 0.22, 0.23, 0.24];
const MIN_RATE_WAGES = [3_000, 3_600, 4_200, 6_500, 9_500, 12_000, 15_000, 18_000, 21_000, 24_000, 30_000, 45_000, 90_000];
const MIN_RATE_DATES = [
  '2026-01-01',
  '2026-02-28',
  '2026-03-31',
  '2026-04-15',
  '2026-05-01',
  '2026-06-30',
  '2026-07-04',
  '2026-08-20',
  '2026-09-09',
  '2026-10-31',
  '2026-11-30',
  '2026-12-01',
  '2026-12-25',
];

const PROFILES: Profile[] = [
  { name: 'A.1 opening example', input: make() },
  {
    name: 'A.2 older PR with a budget and the relief cap in play',
    input: make({
      profile: { residency: 'pr', prYear: 3, ageAtYearEnd: 57, birthMonth: 6 },
      income: { monthlyOrdinaryWage: 14_000, additionalWages: 40_000 },
      existing: { srs: 5_000 },
      otherReliefs: 30_000,
      levers: { ...ALL_ON, cpfFamily: { enabled: true, maxAmount: 8_000 } },
      preferences: { cashBudget: 20_000, minSavingRate: 0, priority: INTEREST },
    }),
  },
  {
    name: 'A.3 lower income, nothing recommended at 7%',
    input: make({ profile: { ageAtYearEnd: 28 }, income: { monthlyOrdinaryWage: 3_500, additionalWages: 3_500 }, otherReliefs: 0 }),
  },
  {
    name: 'A.3 lower income, any saving',
    input: make({
      profile: { ageAtYearEnd: 28 },
      income: { monthlyOrdinaryWage: 3_500, additionalWages: 3_500 },
      otherReliefs: 0,
      preferences: { minSavingRate: 0 },
    }),
  },
  {
    name: 'PR in 1st year',
    input: make({ profile: { residency: 'pr', prYear: 1, ageAtYearEnd: 30 }, income: { monthlyOrdinaryWage: 6_000, additionalWages: 12_000 } }),
  },
  {
    name: 'PR in 2nd year, above 55 to 60',
    input: make({
      profile: { residency: 'pr', prYear: 2, ageAtYearEnd: 58, birthMonth: 3 },
      income: { monthlyOrdinaryWage: 9_100, additionalWages: 7_777 },
      levers: ALL_ON,
    }),
  },
  {
    name: 'PR in 2nd year turning 60 in August',
    input: make({
      profile: { residency: 'pr', prYear: 2, ageAtYearEnd: 60, birthMonth: 8 },
      income: { monthlyOrdinaryWage: 5_333, additionalWages: 9_000 },
      preferences: { minSavingRate: 0.035 },
    }),
  },
  {
    name: 'Foreigner, all schemes switched on',
    input: make({
      profile: { residency: 'foreigner', ageAtYearEnd: 41 },
      income: { monthlyOrdinaryWage: 15_000, additionalWages: 30_000 },
      levers: ALL_ON,
    }),
  },
  {
    name: 'Foreigner, over the SRS cap already, CPF override ignored',
    input: make({
      profile: { residency: 'foreigner', ageAtYearEnd: 50 },
      income: { monthlyOrdinaryWage: 28_000, additionalWages: 120_000, employeeCpfOverride: 12_000 },
      existing: { srs: 36_000, cpfTopUpSelf: 1_000, cpfTopUpFamily: 500 },
      levers: ALL_ON,
      preferences: { minSavingRate: 0.115 },
    }),
  },
  {
    name: 'Turning 55 in June',
    input: make({
      profile: { ageAtYearEnd: 55, birthMonth: 6 },
      income: { monthlyOrdinaryWage: 9_000, additionalWages: 20_000 },
    }),
  },
  {
    name: 'Turning 55 in December (no change this year)',
    input: make({ profile: { ageAtYearEnd: 55, birthMonth: 12 }, income: { monthlyOrdinaryWage: 7_300, additionalWages: 11_000 } }),
  },
  {
    name: 'Turning 60 in January',
    input: make({ profile: { ageAtYearEnd: 60, birthMonth: 1 }, income: { monthlyOrdinaryWage: 7_000, additionalWages: 14_000 } }),
  },
  {
    name: 'Turning 65 in November',
    input: make({
      profile: { ageAtYearEnd: 65, birthMonth: 11 },
      income: { monthlyOrdinaryWage: 8_250, additionalWages: 16_500 },
      levers: ALL_ON,
      preferences: { minSavingRate: 0.035, priority: FAMILY },
    }),
  },
  {
    name: 'Turning 70 in April',
    input: make({ profile: { ageAtYearEnd: 70, birthMonth: 4 }, income: { monthlyOrdinaryWage: 6_100, additionalWages: 3_000 }, preferences: { minSavingRate: 0.02 } }),
  },
  {
    name: 'Age 72',
    input: make({ profile: { ageAtYearEnd: 72, birthMonth: 2 }, income: { monthlyOrdinaryWage: 5_000, additionalWages: 5_000 }, preferences: { minSavingRate: 0 } }),
  },
  {
    name: 'Age 59 turning into EIR 55-59, cap just under',
    input: make({ profile: { ageAtYearEnd: 59, birthMonth: 9 }, income: { monthlyOrdinaryWage: 11_000, additionalWages: 0 } }),
  },
  {
    name: 'Five months worked',
    input: make({ income: { monthlyOrdinaryWage: 12_000, monthsWorked: 5, additionalWages: 5_000 }, preferences: { minSavingRate: 0.02 } }),
  },
  {
    name: 'One month worked, large bonus',
    input: make({ income: { monthlyOrdinaryWage: 20_000, monthsWorked: 1, additionalWages: 150_000 } }),
  },
  {
    name: 'Low wage in the phase-in band',
    input: make({ profile: { ageAtYearEnd: 24 }, income: { monthlyOrdinaryWage: 600, additionalWages: 500 }, otherReliefs: 0, preferences: { minSavingRate: 0 } }),
  },
  {
    name: 'Low wage in the nil band',
    input: make({ profile: { ageAtYearEnd: 19 }, income: { monthlyOrdinaryWage: 480, additionalWages: 0 }, otherReliefs: 0 }),
  },
  {
    name: 'Wage exactly at the top of the phase-in band, other income taxed',
    input: make({
      profile: { ageAtYearEnd: 61, birthMonth: 5 },
      income: { monthlyOrdinaryWage: 750, additionalWages: 1_000, otherTaxableIncome: 64_000 },
      otherReliefs: 2_000,
      preferences: { minSavingRate: 0.02 },
    }),
  },
  {
    name: 'Wage just above the phase-in band, 7 months',
    input: make({ income: { monthlyOrdinaryWage: 751, monthsWorked: 7, additionalWages: 333, otherTaxableIncome: 90_000 }, preferences: { minSavingRate: 0 } }),
  },
  {
    name: 'Very high income',
    input: make({
      profile: { ageAtYearEnd: 48 },
      income: { monthlyOrdinaryWage: 80_000, additionalWages: 500_000, otherTaxableIncome: 300_000 },
      otherReliefs: 12_000,
      levers: ALL_ON,
      preferences: { minSavingRate: 0.22 },
    }),
  },
  {
    name: 'Relief cap binds the plan',
    input: make({ otherReliefs: 50_000, levers: ALL_ON }),
  },
  {
    name: 'Reliefs already over the cap',
    input: make({ income: { monthlyOrdinaryWage: 16_000, additionalWages: 60_000 }, otherReliefs: 70_000, levers: ALL_ON }),
  },
  {
    name: 'Reliefs exactly at the cap',
    input: make({ otherReliefs: 58_600, levers: ALL_ON }),
  },
  {
    name: 'Existing contributions partly used',
    input: make({ existing: { srs: 10_000, cpfTopUpSelf: 3_000, cpfTopUpFamily: 2_000 }, levers: ALL_ON }),
  },
  {
    name: 'Existing contributions over every cap',
    input: make({ existing: { srs: 20_000, cpfTopUpSelf: 9_000, cpfTopUpFamily: 8_500 }, levers: ALL_ON }),
  },
  {
    name: 'Guaranteed interest first with a cash budget',
    input: make({ preferences: { cashBudget: 10_000, priority: INTEREST } }),
  },
  {
    name: 'Family first with a family maximum and a budget',
    input: make({
      levers: { ...ALL_ON, cpfFamily: { enabled: true, maxAmount: 3_000 } },
      preferences: { cashBudget: 12_000, priority: FAMILY },
    }),
  },
  {
    name: 'Family first, no limits',
    input: make({ income: { monthlyOrdinaryWage: 13_500, additionalWages: 27_000 }, levers: ALL_ON, preferences: { priority: FAMILY, minSavingRate: 0.115 } }),
  },
  {
    name: 'Flexibility first with family switched on and a tight budget',
    input: make({ levers: ALL_ON, preferences: { cashBudget: 16_001, priority: FLEX } }),
  },
  { name: 'Cash budget of zero', input: make({ preferences: { cashBudget: 0 } }) },
  {
    name: 'Family switched on with a maximum',
    input: make({ levers: { ...ALL_ON, cpfFamily: { enabled: true, maxAmount: 2_500 } } }),
  },
  {
    name: 'Room limit on own CPF',
    input: make({ profile: { ageAtYearEnd: 56, birthMonth: 2 }, levers: { cpfSelf: { enabled: true, roomToLimit: 1_200 } } }),
  },
  {
    name: 'Room limit of zero on own CPF, SRS off',
    input: make({ levers: { srs: { enabled: false }, cpfSelf: { enabled: true, roomToLimit: 0 } } }),
  },
  { name: 'CPF override below the maximum', input: make({ income: { employeeCpfOverride: 15_000 } }) },
  {
    name: 'CPF override above the maximum',
    input: make({ income: { monthlyOrdinaryWage: 18_000, employeeCpfOverride: 25_000 }, preferences: { minSavingRate: 0.15 } }),
  },
  {
    name: 'Donations and employment expenses',
    input: make({ income: { donations: 1_001, employmentExpenses: 3_000 }, preferences: { minSavingRate: 0.035 } }),
  },
  {
    name: 'Donations larger than income',
    input: make({ income: { monthlyOrdinaryWage: 2_000, additionalWages: 0, donations: 20_000, employmentExpenses: 30_000 }, otherReliefs: 0 }),
  },
  {
    name: 'Other income with a modest salary',
    input: make({ income: { monthlyOrdinaryWage: 2_800, additionalWages: 2_800, otherTaxableIncome: 40_000 }, preferences: { minSavingRate: 0.035 } }),
  },
  { name: 'Nothing switched on', input: make({ levers: { srs: { enabled: false }, cpfSelf: { enabled: false }, cpfFamily: { enabled: false } } }) },
  { name: 'No income at all', input: make({ income: { monthlyOrdinaryWage: 0, additionalWages: 0 }, otherReliefs: 0 }) },
  {
    name: 'Under 18: no SRS',
    input: make({ profile: { ageAtYearEnd: 17 }, income: { monthlyOrdinaryWage: 9_000, additionalWages: 9_000 }, otherReliefs: 0 }),
  },
  {
    name: 'Untidy entries are tidied the same way',
    input: make({
      profile: { ageAtYearEnd: 35.7 },
      income: { monthlyOrdinaryWage: 10_000.9, monthsWorked: 14, additionalWages: -5, otherTaxableIncome: 1_234.56, donations: 99.99 },
      existing: { srs: 100.5, cpfTopUpSelf: -20 },
      otherReliefs: 4_999.99,
      levers: { cpfSelf: { enabled: true, roomToLimit: 7_000.4 }, cpfFamily: { enabled: true, maxAmount: -1 } },
      preferences: { cashBudget: 21_000.99, simulatorStep: 50 },
    }),
  },
  {
    name: 'Blank optional entries use the defaults',
    input: make({
      profile: { residency: 'pr', prYear: undefined, birthMonth: undefined },
      income: { monthsWorked: undefined, otherTaxableIncome: undefined, employmentExpenses: undefined, donations: undefined },
      preferences: { simulatorStep: undefined },
    }),
  },
  { name: 'Simulator step 500', input: make({ levers: ALL_ON, preferences: { simulatorStep: 500 } }) },
  { name: 'Simulator step 2,500', input: make({ levers: ALL_ON, preferences: { simulatorStep: 2_500, minSavingRate: 0.15 } }) },
  { name: 'Simulator step 100 (more steps than rows)', input: make({ levers: ALL_ON, preferences: { simulatorStep: 100 } }) },

  // "As at" dates: before the year, the last fortnight, the last day, and after the deadline.
  { name: 'As at the year before', input: make({ today: '2025-12-20' }) },
  { name: 'As at 17 December (14 days left)', input: make({ today: '2026-12-17' }) },
  { name: 'As at 16 December (15 days left)', input: make({ today: '2026-12-16', levers: ALL_ON }) },
  { name: 'As at 31 December (the deadline)', input: make({ today: '2026-12-31' }) },
  { name: 'As at 31 December with nothing recommended', input: make({ today: '2026-12-31', preferences: { minSavingRate: 0.24 } }) },
  { name: 'As at 1 January after the deadline', input: make({ today: '2027-01-01' }) },
  { name: 'As at long after the deadline', input: make({ today: '2028-03-05', levers: ALL_ON }) },

  // Every minimum-rate choice, each with a different income and "as at" month.
  ...MIN_RATE_CHOICES.map(
    (rate, index): Profile => ({
      name: `Minimum rate ${(rate * 100).toFixed(1)}%`,
      input: make({
        today: MIN_RATE_DATES[index] ?? TODAY,
        profile: { ageAtYearEnd: 27 + index * 3, birthMonth: (index % 12) + 1 },
        income: { monthlyOrdinaryWage: MIN_RATE_WAGES[index] ?? 10_000, additionalWages: (MIN_RATE_WAGES[index] ?? 10_000) * 2 },
        otherReliefs: 1_000 * index,
        levers: index % 2 === 0 ? ALL_ON : undefined,
        preferences: { minSavingRate: rate, priority: [FLEX, INTEREST, FAMILY][index % 3] ?? FLEX },
      }),
    }),
  ),

  // Income year 2025 (YA2026): the IRAS sample calculations of SPEC Appendix B.
  {
    name: '2025: IRAS sample, Mr Heng',
    input: make({
      incomeYear: 2025,
      today: '2025-06-15',
      income: { monthlyOrdinaryWage: 4_000, additionalWages: 2_000, donations: 100 },
      otherReliefs: 4_000,
      preferences: { minSavingRate: 0 },
    }),
  },
  {
    name: '2025: IRAS sample, S$250,000 earner aged 68',
    input: make({
      incomeYear: 2025,
      today: '2025-12-30',
      profile: { ageAtYearEnd: 68, birthMonth: 7 },
      income: { monthlyOrdinaryWage: 19_000, additionalWages: 22_000, donations: 100 },
      otherReliefs: 0,
      levers: ALL_ON,
    }),
  },
  {
    name: '2025: S$9,000 a month, S$20,000 bonus, looked at in 2026',
    input: make({ incomeYear: 2025, today: '2026-02-01', income: { monthlyOrdinaryWage: 9_000, additionalWages: 20_000 } }),
  },
  {
    name: '2025: turning 60 in March',
    input: make({
      incomeYear: 2025,
      today: '2025-03-10',
      profile: { ageAtYearEnd: 60, birthMonth: 3 },
      income: { monthlyOrdinaryWage: 7_600, additionalWages: 9_999 },
      preferences: { minSavingRate: 0.035 },
    }),
  },

  // Income year 2027 (YA2028, projected rules).
  { name: '2027: the example, planned from 2026', input: make({ incomeYear: 2027, today: TODAY }) },
  {
    name: '2027: phase-in wage at 57 (factor 0.57)',
    input: make({
      incomeYear: 2027,
      today: '2027-03-31',
      profile: { ageAtYearEnd: 57, birthMonth: 1 },
      income: { monthlyOrdinaryWage: 600, additionalWages: 100, otherTaxableIncome: 52_000 },
      otherReliefs: 0,
      preferences: { minSavingRate: 0 },
    }),
  },
  {
    name: '2027: turning 65 in June, relief cap in play',
    input: make({
      incomeYear: 2027,
      today: '2027-12-20',
      profile: { ageAtYearEnd: 65, birthMonth: 6 },
      income: { monthlyOrdinaryWage: 10_500, additionalWages: 31_000 },
      otherReliefs: 44_000,
      levers: ALL_ON,
      preferences: { priority: INTEREST },
    }),
  },
  {
    name: '2027: PR in 2nd year turning 55 in May',
    input: make({
      incomeYear: 2027,
      today: '2027-08-08',
      profile: { residency: 'pr', prYear: 2, ageAtYearEnd: 55, birthMonth: 5 },
      income: { monthlyOrdinaryWage: 8_800, additionalWages: 17_600 },
    }),
  },

  // Rules a buyer has edited on the Rules sheet.
  {
    name: 'Rebate year: capped rebate',
    rules: 'rebate',
    input: make({ profile: { ageAtYearEnd: 28 }, income: { monthlyOrdinaryWage: 3_500, additionalWages: 3_500 }, otherReliefs: 0, preferences: { minSavingRate: 0 } }),
  },
  {
    name: 'Rebate year: rebate below the cap',
    rules: 'rebate',
    input: make({ profile: { ageAtYearEnd: 28 }, income: { monthlyOrdinaryWage: 2_900, additionalWages: 2_000 }, otherReliefs: 0, preferences: { minSavingRate: 0.02 } }),
  },
  { name: 'Rebate year: the example', rules: 'rebate', input: make() },
  {
    name: 'Edited rules: citizen aged 52',
    rules: 'edited',
    input: make({
      profile: { ageAtYearEnd: 52, birthMonth: 4 },
      income: { monthlyOrdinaryWage: 11_250, additionalWages: 33_333, donations: 777 },
      levers: ALL_ON,
      preferences: { minSavingRate: 0.045 },
    }),
  },
  {
    name: 'Edited rules: foreigner aged 20 who may top up family',
    rules: 'edited',
    input: make({
      profile: { residency: 'foreigner', ageAtYearEnd: 20 },
      income: { monthlyOrdinaryWage: 7_000, additionalWages: 10_000 },
      otherReliefs: 0,
      levers: ALL_ON,
      preferences: { minSavingRate: 0 },
    }),
  },
  {
    name: 'Edited rules: low tax, rebate not capped',
    rules: 'edited',
    input: make({
      profile: { ageAtYearEnd: 58, birthMonth: 10 },
      income: { monthlyOrdinaryWage: 3_200, additionalWages: 4_000 },
      otherReliefs: 0,
      preferences: { minSavingRate: 0 },
    }),
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Writing inputs
// ---------------------------------------------------------------------------------------------------------------

function isoToDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day));
}

/** The Planner cell values for an engine input (undefined / null become a blank cell). */
function cellValues(input: PlannerInput): Record<InputName, ExcelJS.CellValue> {
  const blank = (value: number | null | undefined): ExcelJS.CellValue => (value === null || value === undefined ? null : value);
  const yesNo = (value: boolean): string => (value ? YES : NO);
  const preset = PRIORITY_PRESETS.find((candidate) => candidate.order.join() === input.preferences.priority.join());
  if (!preset) throw new Error(`No "Which first?" preset for priority ${input.preferences.priority.join()}`);
  const { profile, income, existing, levers, preferences } = input;
  return {
    in_residency: RESIDENCY_LABELS[profile.residency],
    in_prYear: profile.prYear === undefined ? null : (PR_YEAR_LABELS[profile.prYear - 1] ?? null),
    in_age: profile.ageAtYearEnd,
    in_birthMonth: profile.birthMonth === undefined ? null : (MONTH_LABELS[profile.birthMonth - 1] ?? null),
    in_monthlyWage: income.monthlyOrdinaryWage,
    in_monthsWorked: blank(income.monthsWorked),
    in_additionalWages: income.additionalWages,
    in_otherIncome: blank(income.otherTaxableIncome),
    in_employmentExpenses: blank(income.employmentExpenses),
    in_donations: blank(income.donations),
    in_cpfOverride: blank(income.employeeCpfOverride),
    in_existingSrs: existing.srs,
    in_existingCpfSelf: existing.cpfTopUpSelf,
    in_existingCpfFamily: existing.cpfTopUpFamily,
    in_otherReliefs: input.otherReliefs,
    in_useSrs: yesNo(levers.srs.enabled),
    in_useCpfSelf: yesNo(levers.cpfSelf.enabled),
    in_cpfSelfRoom: blank(levers.cpfSelf.roomToLimit),
    in_useCpfFamily: yesNo(levers.cpfFamily.enabled),
    in_cpfFamilyMax: blank(levers.cpfFamily.maxAmount),
    in_minSavingRate: preferences.minSavingRate,
    in_cashBudget: blank(preferences.cashBudget),
    in_priority: preset.label,
    in_asAtDate: isoToDate(input.today),
    in_simulatorStep: blank(preferences.simulatorStep),
  };
}

function writeInputs(built: BuiltWorkbook, input: PlannerInput): void {
  const values = cellValues(input);
  for (const name of INPUT_NAMES) {
    const location = built.map.inputs[name];
    const ws = built.workbook.getWorksheet(location.sheet);
    if (!ws) throw new Error(`Missing sheet ${location.sheet}`);
    ws.getCell(location.ref.replace(/\$/g, '')).value = values[name];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading results through the named ranges
// ---------------------------------------------------------------------------------------------------------------

type Scalar = number | string | boolean | Date | null;

const ERROR_TEXT = /^#(NAME\?|VALUE!|REF!|DIV\/0!|N\/A|NUM!|NULL!)/;

function scalarOf(cell: ExcelJS.Cell): Scalar {
  const raw: unknown = cell.formula ? cell.result : cell.value;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean' || raw instanceof Date) return raw;
  throw new Error(`Unexpected cell content at ${cell.address}: ${JSON.stringify(raw)}`);
}

/** A recalculated workbook, read by defined name. */
class Results {
  constructor(private readonly wb: ExcelJS.Workbook) {}

  private cells(name: string): ExcelJS.Cell[] {
    const reference = this.wb.definedNames.getRanges(name).ranges[0];
    if (!reference) throw new Error(`The recalculated workbook has no defined name "${name}"`);
    const match = /^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(reference);
    if (!match) throw new Error(`Cannot parse the reference of "${name}": ${reference}`);
    const sheetName = (match[1] ?? match[2] ?? '').replace(/''/g, "'");
    const ws = this.wb.getWorksheet(sheetName);
    if (!ws) throw new Error(`Defined name "${name}" points at a missing sheet: ${sheetName}`);
    const first = ws.getCell(`${match[3] ?? ''}${match[4] ?? ''}`);
    const last = match[5] ? ws.getCell(`${match[5]}${match[6] ?? ''}`) : first;
    const out: ExcelJS.Cell[] = [];
    for (let row = Number(first.row); row <= Number(last.row); row++) {
      for (let col = Number(first.col); col <= Number(last.col); col++) out.push(ws.getCell(row, col));
    }
    return out;
  }

  value(name: string): Scalar {
    const cells = this.cells(name);
    if (cells.length !== 1 || !cells[0]) throw new Error(`"${name}" is not a single cell`);
    return scalarOf(cells[0]);
  }

  column(name: string): Scalar[] {
    return this.cells(name).map(scalarOf);
  }

  /** Every cell that evaluates to an error, as "Sheet!A1 #ERR". */
  errors(): string[] {
    const found: string[] = [];
    for (const ws of this.wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          const candidates: unknown[] = [cell.value, cell.formula ? cell.result : undefined];
          for (const candidate of candidates) {
            if (candidate !== null && typeof candidate === 'object' && 'error' in candidate) {
              found.push(`${ws.name}!${cell.address} ${String((candidate as { error: unknown }).error)}`);
            } else if (typeof candidate === 'string' && ERROR_TEXT.test(candidate)) {
              found.push(`${ws.name}!${cell.address} ${candidate}`);
            }
          }
        });
      });
    }
    return found;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------------------------

function num(value: Scalar, label: string): number {
  expect(typeof value, `${label} should be a number, got ${JSON.stringify(value)}`).toBe('number');
  return value as number;
}

/** Whole dollars: exactly equal. */
function expectDollars(actual: Scalar, expected: number, label: string): void {
  expect(num(actual, label), label).toBe(expected);
}

/** Money to the cent. */
function expectCents(actual: Scalar, expected: number, label: string): void {
  expect(Math.round(num(actual, label) * 100), label).toBe(Math.round(expected * 100));
}

/** A ratio: equal to within floating-point noise. */
function expectRate(actual: Scalar, expected: number, label: string): void {
  expect(Math.abs(num(actual, label) - expected), `${label}: ${String(actual)} vs ${expected}`).toBeLessThan(1e-12);
}

const LEVERS: LeverId[] = ['srs', 'cpfSelf', 'cpfFamily'];
const RELIEF_KEYS = {
  eir: 'earnedIncome',
  cpf: 'cpf',
  srs: 'srs',
  cpfSelf: 'cpfTopUpSelf',
  cpfFamily: 'cpfTopUpFamily',
  other: 'other',
  totalBeforeCap: 'totalBeforeCap',
  totalAllowed: 'totalAllowed',
  lostToCap: 'lostToCap',
} as const;

function assertParity(results: Results, expected: PlannerResult): void {
  const { cpf, baseline, optimised, plan: p, levers, ladder, simulator, scenarios, monthlyPlan, warnings } = expected;

  // §6.1 CPF
  expectDollars(results.value('out_employeeCpf'), cpf.employeeContribution, 'employee CPF');
  expect(results.value('out_cpfSource'), 'CPF source').toBe(cpf.source);
  expectDollars(results.value('out_owSubject'), cpf.ordinaryWagesSubject, 'ordinary wages subject to CPF');
  expectDollars(results.value('out_awCeiling'), cpf.additionalWageCeiling, 'additional wage ceiling');
  expectDollars(results.value('out_awSubject'), cpf.additionalWagesSubject, 'additional wages subject to CPF');
  const monthRates = results.column('out_monthlyEmployeeRates');
  expect(monthRates.length).toBe(12);
  cpf.monthlyEmployeeRates.forEach((rate, month) => expectRate(monthRates[month] ?? null, rate, `employee rate, month ${month + 1}`));

  // §6.2 income
  expectDollars(results.value('out_employmentIncome'), baseline.employmentIncome, 'employment income');
  expectDollars(results.value('out_totalIncome'), baseline.totalIncome, 'total income');
  expectCents(results.value('out_donationDeduction'), baseline.donationDeduction, 'donation deduction');
  expectCents(results.value('out_assessableIncome'), baseline.assessableIncome, 'assessable income');

  // §6.3 reliefs and §6.4 tax, before and after
  for (const [side, computation] of [
    ['base', baseline],
    ['opt', optimised],
  ] as const) {
    for (const [line, key] of Object.entries(RELIEF_KEYS)) {
      expectDollars(results.value(`out_${side}_${line}`), computation.reliefs[key], `${side} relief ${line}`);
    }
    expectDollars(results.value(`out_${side}_ci`), computation.chargeableIncome, `${side} chargeable income`);
    expectCents(results.value(`out_${side}_gross`), computation.grossTax, `${side} gross tax`);
    expectCents(results.value(`out_${side}_rebate`), computation.pitRebate, `${side} rebate`);
    expectCents(results.value(`out_${side}_tax`), computation.taxPayable, `${side} tax payable`);
    expectRate(results.value(`out_${side}_marginal`), computation.marginalRate, `${side} marginal rate`);
    expectRate(results.value(`out_${side}_effective`), computation.effectiveRate, `${side} effective rate`);
  }

  // §6.5 levers
  for (const lever of LEVERS) {
    expect(results.value(`out_eligible_${lever}`), `${lever} eligible`).toBe(levers[lever].eligible ? 1 : 0);
    expect(results.value(`out_enabled_${lever}`), `${lever} enabled`).toBe(levers[lever].enabled ? 1 : 0);
    expectDollars(results.value(`out_cap_${lever}`), levers[lever].statutoryCap, `${lever} statutory cap`);
    expectDollars(results.value(`out_used_${lever}`), levers[lever].used, `${lever} used`);
    expectDollars(results.value(`out_room_${lever}`), levers[lever].room, `${lever} room`);
  }
  expectDollars(results.value('out_leverRoom'), levers.srs.room + levers.cpfSelf.room + levers.cpfFamily.room, 'lever room L');
  expectDollars(results.value('out_reliefCapRoom'), expected.reliefCapRoom, 'relief cap room C');

  // §6.6 the plan (headline cells on the Planner)
  expectDollars(results.value('out_srs'), p.contributions.srs, 'plan SRS');
  expectDollars(results.value('out_cpfSelf'), p.contributions.cpfSelf, 'plan CPF self');
  expectDollars(results.value('out_cpfFamily'), p.contributions.cpfFamily, 'plan CPF family');
  expectDollars(results.value('out_total'), p.totalContribution, 'plan total');
  expectCents(results.value('out_taxBefore'), p.taxBefore, 'tax before');
  expectCents(results.value('out_taxAfter'), p.taxAfter, 'tax after');
  expectCents(results.value('out_taxSaved'), p.taxSaved, 'tax saved');
  expectRate(results.value('out_savingRate'), p.savingRate, 'saving rate');
  expectDollars(results.value('out_ciBefore'), p.chargeableIncomeBefore, 'chargeable income before');
  expectDollars(results.value('out_ciAfter'), p.chargeableIncomeAfter, 'chargeable income after');
  expectRate(results.value('out_marginalBefore'), p.marginalRateBefore, 'marginal rate before');
  expectRate(results.value('out_marginalAfter'), p.marginalRateAfter, 'marginal rate after');
  expect(results.value('out_bindingConstraint'), 'binding constraint').toBe(p.bindingConstraint);
  expectCents(results.value('out_unrealisedSaving'), p.unrealisedSaving, 'unrealised saving');
  expect(typeof results.value('out_reason'), 'reason sentence').toBe('string');

  // §6.7 ladder: the non-empty rows are the engine's tiers, in order
  const ladderCols = {
    from: results.column('out_ladder_from'),
    to: results.column('out_ladder_to'),
    amount: results.column('out_ladder_amount'),
    rate: results.column('out_ladder_rate'),
    taxSaved: results.column('out_ladder_taxSaved'),
    cumulative: results.column('out_ladder_cumulative'),
    used: results.column('out_ladder_used'),
    reason: results.column('out_ladder_reason'),
  };
  const rungRows = ladderCols.amount.map((_amount, index) => index).filter((index) => ladderCols.amount[index] !== null);
  expect(rungRows.length, 'number of ladder tiers').toBe(ladder.length);
  ladder.forEach((tier, index) => {
    const row = rungRows[index] ?? -1;
    const label = `ladder tier ${index + 1}`;
    expectDollars(ladderCols.from[row] ?? null, tier.fromContribution, `${label} from`);
    expectDollars(ladderCols.to[row] ?? null, tier.toContribution, `${label} to`);
    expectDollars(ladderCols.amount[row] ?? null, tier.amount, `${label} amount`);
    expectRate(ladderCols.rate[row] ?? null, tier.rate, `${label} rate`);
    expectCents(ladderCols.taxSaved[row] ?? null, tier.taxSaved, `${label} tax saved`);
    expectCents(ladderCols.cumulative[row] ?? null, tier.cumulativeTaxSaved, `${label} cumulative`);
    expectDollars(ladderCols.used[row] ?? null, tier.usedByPlan, `${label} used by plan`);
    expect(ladderCols.reason[row] ?? null, `${label} zero reason`).toBe(tier.zeroReason ?? null);
  });

  // §6.8 simulator: every row the sheet has room for
  const sim = {
    contribution: results.column('out_sim_contribution'),
    srs: results.column('out_sim_srs'),
    cpfSelf: results.column('out_sim_cpfSelf'),
    cpfFamily: results.column('out_sim_cpfFamily'),
    tax: results.column('out_sim_tax'),
    saved: results.column('out_sim_saved'),
    stepSaving: results.column('out_sim_stepSaving'),
    stepRate: results.column('out_sim_stepRate'),
    withinPlan: results.column('out_sim_withinPlan'),
  };
  expect(sim.contribution.length).toBe(SIMULATOR_STEPS + 1);
  for (let i = 0; i <= SIMULATOR_STEPS; i++) {
    const row = simulator[i];
    const label = `simulator row ${i}`;
    if (!row) {
      expect(sim.contribution[i], `${label} should be blank`).toBeNull();
      expect(sim.tax[i], `${label} tax should be blank`).toBeNull();
      continue;
    }
    expectDollars(sim.contribution[i] ?? null, row.contribution, `${label} contribution`);
    expectDollars(sim.srs[i] ?? null, row.split.srs, `${label} SRS`);
    expectDollars(sim.cpfSelf[i] ?? null, row.split.cpfSelf, `${label} CPF self`);
    expectDollars(sim.cpfFamily[i] ?? null, row.split.cpfFamily, `${label} CPF family`);
    expectCents(sim.tax[i] ?? null, row.taxPayable, `${label} tax payable`);
    expectCents(sim.saved[i] ?? null, row.taxSaved, `${label} tax saved`);
    expectCents(sim.stepSaving[i] ?? null, row.stepSaving, `${label} step saving`);
    expectRate(sim.stepRate[i] ?? null, row.stepRate, `${label} step rate`);
    expect(sim.withinPlan[i], `${label} within plan`).toBe(row.withinPlan ? YES : NO);
  }

  // §6.9 scenarios
  const scen = {
    id: results.column('out_scen_id'),
    srs: results.column('out_scen_srs'),
    cpfSelf: results.column('out_scen_cpfSelf'),
    cpfFamily: results.column('out_scen_cpfFamily'),
    total: results.column('out_scen_total'),
    tax: results.column('out_scen_tax'),
    saved: results.column('out_scen_saved'),
    rate: results.column('out_scen_rate'),
    wasted: results.column('out_scen_wasted'),
  };
  expect(scen.id).toEqual([...SCENARIO_IDS]);
  expect(scenarios.map((scenario) => scenario.id)).toEqual([...SCENARIO_IDS]);
  scenarios.forEach((scenario, index) => {
    const label = `scenario ${scenario.id}`;
    expectDollars(scen.srs[index] ?? null, scenario.contributions.srs, `${label} SRS`);
    expectDollars(scen.cpfSelf[index] ?? null, scenario.contributions.cpfSelf, `${label} CPF self`);
    expectDollars(scen.cpfFamily[index] ?? null, scenario.contributions.cpfFamily, `${label} CPF family`);
    expectDollars(scen.total[index] ?? null, scenario.totalContribution, `${label} total`);
    expectCents(scen.tax[index] ?? null, scenario.taxPayable, `${label} tax payable`);
    expectCents(scen.saved[index] ?? null, scenario.taxSaved, `${label} tax saved`);
    expectRate(scen.rate[index] ?? null, scenario.savingRate, `${label} saving rate`);
    expectDollars(scen.wasted[index] ?? null, scenario.wastedContribution, `${label} wasted`);
  });

  // §6.10 monthly plan
  expectDollars(results.value('out_monthsRemaining'), monthlyPlan.monthsRemaining, 'months remaining');
  expectDollars(results.value('out_daysToDeadline'), monthlyPlan.daysToDeadline, 'days to deadline');
  const deadline = results.value('out_deadline');
  expect(deadline instanceof Date ? deadline.toISOString().slice(0, 10) : deadline, 'deadline').toBe(monthlyPlan.deadline);
  const sched = {
    month: results.column('out_sched_month'),
    srs: results.column('out_sched_srs'),
    cpfSelf: results.column('out_sched_cpfSelf'),
    cpfFamily: results.column('out_sched_cpfFamily'),
    total: results.column('out_sched_total'),
  };
  expect(sched.month.length).toBe(12);
  const shown = sched.total.map((_total, index) => index).filter((index) => sched.total[index] !== null);
  expect(shown.length, 'number of instalments').toBe(monthlyPlan.schedule.length);
  monthlyPlan.schedule.forEach((instalment, index) => {
    const row = shown[index] ?? -1;
    const label = `instalment ${instalment.month}`;
    const month = sched.month[row];
    expect(month instanceof Date ? month.toISOString().slice(0, 7) : month, `${label} month`).toBe(instalment.month);
    expectDollars(sched.srs[row] ?? null, instalment.amounts.srs, `${label} SRS`);
    expectDollars(sched.cpfSelf[row] ?? null, instalment.amounts.cpfSelf, `${label} CPF self`);
    expectDollars(sched.cpfFamily[row] ?? null, instalment.amounts.cpfFamily, `${label} CPF family`);
    expectDollars(sched.total[row] ?? null, instalment.total, `${label} total`);
  });
  if (monthlyPlan.schedule.length > 0) {
    // The schedule sums exactly to the plan.
    const sum = (column: Scalar[]): number => column.reduce<number>((total, value) => total + (typeof value === 'number' ? value : 0), 0);
    expect(sum(sched.srs)).toBe(p.contributions.srs);
    expect(sum(sched.cpfSelf)).toBe(p.contributions.cpfSelf);
    expect(sum(sched.cpfFamily)).toBe(p.contributions.cpfFamily);
    expect(sum(sched.total)).toBe(p.totalContribution);
  }
  expectDollars(results.value('out_fullYear_srs'), monthlyPlan.fullYearMonthly.srs, 'start in January: SRS');
  expectDollars(results.value('out_fullYear_cpfSelf'), monthlyPlan.fullYearMonthly.cpfSelf, 'start in January: CPF self');
  expectDollars(results.value('out_fullYear_cpfFamily'), monthlyPlan.fullYearMonthly.cpfFamily, 'start in January: CPF family');
  expectDollars(results.value('out_fullYear_total'), monthlyPlan.fullYearMonthly.total, 'start in January: total');

  // §6.11 warnings: the same codes fire, and the Planner shows one line for each
  const codes = results.column('out_warningCodes');
  const flags = results.column('out_warningFlags');
  expect(codes).toEqual([...WARNING_CODES]);
  const fired = codes.filter((_code, index) => flags[index] === 1);
  expect(fired, 'warnings that fire').toEqual(warnings.map((warning) => warning.code));
  const lines = results.column('out_warnings').filter((line) => line !== null);
  expect(lines.length, 'warning lines on the Planner').toBe(warnings.length);
  for (const line of lines) expect(String(line)).toMatch(/^(Note|Check|Too late) — /);
}

// ---------------------------------------------------------------------------------------------------------------
// Tests that need no spreadsheet application
// ---------------------------------------------------------------------------------------------------------------

/** Functions the workbook may use: all present in Excel 2016, Google Sheets and LibreOffice. */
const ALLOWED_FUNCTIONS = new Set([
  'SUM',
  'SUMPRODUCT',
  'INDEX',
  'MATCH',
  'VLOOKUP',
  'MIN',
  'MAX',
  'IF',
  'AND',
  'OR',
  'FLOOR',
  'ROUND',
  'ROUNDUP',
  'INT',
  'CHOOSE',
  'DATE',
  'YEAR',
  'MONTH',
  'DAY',
  'TODAY',
  'TEXT',
  'IFERROR',
  'COUNTIF',
  'ISNUMBER',
  'REPT',
]);

function formulasOf(workbook: ExcelJS.Workbook): { where: string; formula: string }[] {
  const out: { where: string; formula: string }[] = [];
  for (const ws of workbook.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.formula) out.push({ where: `${ws.name}!${cell.address}`, formula: cell.formula });
      });
    });
  }
  return out;
}

describe('workbook structure', () => {
  it('has the eight sheets of SPEC §9 in order and opens on the Planner', async () => {
    const workbook = await buildWorkbook(2026);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(['Start', 'Planner', 'Ladder', 'Scenarios', 'Simulator', 'Monthly Plan', 'Tax Working', 'Rules']);
    expect(Object.values(SHEETS)).toEqual(workbook.worksheets.map((ws) => ws.name));
    expect(workbook.views[0]?.activeTab).toBe(1);
    expect(releaseFileName(2026)).toBe('SG-Tax-Optimiser-YA2027.xlsx');
    expect(releaseFileName(2025)).toBe('SG-Tax-Optimiser-YA2026.xlsx');
  });

  it('defines a named range for every input and output, and inputs are unlocked cells on unprotected-by-password sheets', async () => {
    const { workbook, map } = await buildWorkbookWithMap(2026);
    for (const name of INPUT_NAMES) {
      const location = map.inputs[name];
      const reference = workbook.definedNames.getRanges(name).ranges[0];
      expect(reference, name).toBeDefined();
      expect(reference?.endsWith(location.ref), `${name} -> ${String(reference)}`).toBe(true);
      const cell = workbook.getWorksheet(location.sheet)?.getCell(location.ref.replace(/\$/g, ''));
      expect(cell?.protection?.locked, `${name} should be unlocked`).toBe(false);
      expect(cell?.dataValidation, `${name} should have data validation`).toBeDefined();
    }
    expect(Object.keys(map.outputs).length).toBeGreaterThan(80);
    for (const name of Object.keys(map.outputs)) {
      expect(name.startsWith('out_')).toBe(true);
      expect(workbook.definedNames.getRanges(name).ranges.length, name).toBe(1);
    }
    for (const ws of workbook.worksheets) {
      const protection = (ws as unknown as { sheetProtection?: Record<string, unknown> | null }).sheetProtection;
      if (protection) {
        expect(protection.hashValue, `${ws.name} must not be password protected`).toBeUndefined();
        expect(protection.saltValue, `${ws.name} must not be password protected`).toBeUndefined();
      }
    }
  });

  it('opens with the worked example of SPEC A.1', async () => {
    const { workbook, map } = await buildWorkbookWithMap(2026);
    const expected = cellValues(defaultInput(TODAY));
    for (const name of INPUT_NAMES) {
      if (name === 'in_asAtDate') continue; // =TODAY()
      const location = map.inputs[name];
      const cell = workbook.getWorksheet(location.sheet)?.getCell(location.ref.replace(/\$/g, ''));
      expect(cell?.value ?? null, name).toEqual(expected[name]);
    }
    expect(EXAMPLE.monthlyWage).toBe(10_000);
    const asAt = workbook.getWorksheet(map.inputs.in_asAtDate.sheet)?.getCell(map.inputs.in_asAtDate.ref.replace(/\$/g, ''));
    expect(asAt?.formula).toBe('TODAY()');
  });

  it.each([2025, 2026, 2027])('uses only widely supported functions and safe formula shapes (income year %i)', async (year) => {
    const workbook = await buildWorkbook(year);
    const formulas = formulasOf(workbook);
    expect(formulas.length).toBeGreaterThan(1500);
    const used = new Set<string>();
    for (const { where, formula } of formulas) {
      expect(formula.length, `${where} formula length`).toBeLessThan(8000);
      // Each text literal must fit Excel's 255-character limit.
      for (const literal of formula.match(/"(?:[^"]|"")*"/g) ?? []) {
        expect(literal.length, `${where} text literal`).toBeLessThanOrEqual(257);
      }
      const bare = formula.replace(/"(?:[^"]|"")*"/g, '""');
      for (const match of bare.matchAll(/([A-Z][A-Z0-9.]*)\(/g)) used.add(match[1] ?? '');
      expect(bare, `${where} must not use structured or dynamic-array syntax`).not.toMatch(/[#@{}\[\]]/);
    }
    const unexpected = [...used].filter((name) => !ALLOWED_FUNCTIONS.has(name));
    expect(unexpected, 'functions outside the allowed list').toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Parity through LibreOffice
// ---------------------------------------------------------------------------------------------------------------

const soffice = findSoffice();
if (!soffice) {
  console.warn(
    '[workbook parity] SKIPPED: "soffice" (LibreOffice) is not on PATH, so the workbook formulas cannot be recalculated. ' +
      'Install LibreOffice to run the workbook-vs-engine parity test.',
  );
}

describe.skipIf(!soffice)('workbook parity with the engine (LibreOffice recalculation)', () => {
  const workDir = join(ROOT, '.tmp', `workbook-test-${process.pid}-${Date.now()}`);
  const loaded = new Map<string, Results>();
  const expectedByName = new Map<string, PlannerResult>();

  beforeAll(async () => {
    const inDir = join(workDir, 'in');
    const outDir = join(workDir, 'out');
    mkdirSync(inDir, { recursive: true });

    // The engine entry point that takes explicit rules is internal; load it loosely so a rename there shows up
    // as a clear message here instead of a broken import.
    const internal = (await import('../src/engine/plan')) as unknown as {
      planFor?: (input: PlannerInput, rules: YearRules) => PlannerResult;
    };
    const planFor = internal.planFor;
    if (typeof planFor !== 'function') throw new Error('src/engine/plan.ts no longer exports planFor(input, rules).');

    // One workbook per income year / rule set; each profile is written into it and saved as its own copy.
    const builds = new Map<string, BuiltWorkbook>();
    const files: string[] = [];
    for (const [index, profile] of PROFILES.entries()) {
      const rules = profile.rules ? CUSTOM_RULES[profile.rules] : undefined;
      const key = profile.rules ?? String(profile.input.incomeYear);
      let built = builds.get(key);
      if (!built) {
        built = await buildWorkbookWithMap(profile.input.incomeYear, rules ? { rules } : {});
        builds.set(key, built);
      }
      writeInputs(built, profile.input);
      const file = join(inDir, `profile-${String(index).padStart(3, '0')}.xlsx`);
      await built.workbook.xlsx.writeFile(file);
      files.push(file);
      expectedByName.set(profile.name, rules ? planFor(sanitiseInput(profile.input), rules) : plan(profile.input));
    }

    // ONE LibreOffice run recalculates every copy, with a private profile directory.
    const recalculated = recalculate(files, { outDir, profileDir: join(workDir, 'lo-profile'), timeoutMs: 540_000 });
    for (const [index, profile] of PROFILES.entries()) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(recalculated[index] ?? '');
      loaded.set(profile.name, new Results(workbook));
    }
  }, 600_000);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('covers at least 30 profiles with unique names', () => {
    expect(PROFILES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(PROFILES.map((profile) => profile.name)).size).toBe(PROFILES.length);
    expect(new Set(PROFILES.map((profile) => profile.input.incomeYear))).toEqual(new Set([2025, 2026, 2027]));
  });

  it('no cell in any sheet evaluates to an error value', () => {
    const errors: string[] = [];
    for (const profile of PROFILES) {
      for (const error of loaded.get(profile.name)?.errors() ?? ['not recalculated']) errors.push(`${profile.name}: ${error}`);
    }
    expect(errors).toEqual([]);
  });

  it.each(PROFILES.map((profile) => [profile.name] as const))('%s', (name) => {
    const results = loaded.get(name);
    const expected = expectedByName.get(name);
    expect(results, 'recalculated workbook').toBeDefined();
    expect(expected, 'engine result').toBeDefined();
    if (results && expected) assertParity(results, expected);
  });

  it('reproduces SPEC Appendix A.1 to the cent', () => {
    const r = loaded.get('A.1 opening example');
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.value('out_employmentIncome')).toBe(135_000);
    expect(r.value('out_employeeCpf')).toBe(20_400);
    expect(r.value('out_base_totalBeforeCap')).toBe(26_400);
    expect(r.value('out_ciBefore')).toBe(108_600);
    expect(r.value('out_taxBefore')).toBe(6_639);
    expect(r.value('out_usefulRoom')).toBe(68_600);
    expect(r.value('out_reliefCapRoom')).toBe(53_600);
    expect(r.value('out_leverRoom')).toBe(23_300);
    expect(r.value('out_total')).toBe(23_300);
    expect(r.value('out_bindingConstraint')).toBe('leverLimits');
    expect(r.value('out_srs')).toBe(15_300);
    expect(r.value('out_cpfSelf')).toBe(8_000);
    expect(r.value('out_ciAfter')).toBe(85_300);
    expect(r.value('out_taxAfter')).toBe(3_959.5);
    expect(r.value('out_taxSaved')).toBe(2_679.5);
    expect(r.value('out_savingRate')).toBeCloseTo(0.115, 12);
    expect(r.value('out_unrealisedSaving')).toBe(2_359.5);
    expect(r.column('out_ladder_amount').filter((v) => v !== null)).toEqual([23_300]);
    expect(r.column('out_sched_srs').filter((v) => v !== null)).toEqual([7_650, 7_650]);
    expect(r.column('out_sched_cpfSelf').filter((v) => v !== null)).toEqual([4_000, 4_000]);
  });

  it('reproduces SPEC Appendix A.2 to the cent', () => {
    const r = loaded.get('A.2 older PR with a budget and the relief cap in play');
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.value('out_employeeCpf')).toBe(18_360);
    expect(r.value('out_employmentIncome')).toBe(208_000);
    expect(r.value('out_base_totalBeforeCap')).toBe(59_360);
    expect(r.value('out_ciBefore')).toBe(148_640);
    expect(r.value('out_taxBefore')).toBe(12_246);
    expect([r.value('out_room_srs'), r.value('out_room_cpfSelf'), r.value('out_room_cpfFamily')]).toEqual([10_300, 8_000, 8_000]);
    expect([r.value('out_usefulRoom'), r.value('out_reliefCapRoom'), r.value('out_leverRoom')]).toEqual([128_640, 20_640, 26_300]);
    expect(r.value('out_total')).toBe(20_000);
    expect(r.value('out_bindingConstraint')).toBe('cashBudget');
    expect([r.value('out_cpfSelf'), r.value('out_srs'), r.value('out_cpfFamily')]).toEqual([8_000, 10_300, 1_700]);
    expect(r.value('out_taxAfter')).toBe(9_246);
    expect(r.value('out_taxSaved')).toBe(3_000);
    expect(r.value('out_unrealisedSaving')).toBe(96);
    expect(r.column('out_ladder_amount').filter((v) => v !== null)).toEqual([20_640, 5_660]);
    expect(r.column('out_ladder_taxSaved').filter((v) => v !== null)).toEqual([3_096, 0]);
    expect(r.column('out_ladder_reason')).toContain('reliefCap');
    const maxAll = SCENARIO_IDS.indexOf('maxAll');
    expect(r.column('out_scen_total')[maxAll]).toBe(26_300);
    expect(r.column('out_scen_saved')[maxAll]).toBe(3_096);
    expect(r.column('out_scen_wasted')[maxAll]).toBe(5_660);
  });

  it('reproduces SPEC Appendix A.3 to the cent', () => {
    const none = loaded.get('A.3 lower income, nothing recommended at 7%');
    const any = loaded.get('A.3 lower income, any saving');
    expect(none).toBeDefined();
    expect(any).toBeDefined();
    if (!none || !any) return;
    expect(none.value('out_employeeCpf')).toBe(9_100);
    expect(none.value('out_base_totalBeforeCap')).toBe(10_100);
    expect(none.value('out_ciBefore')).toBe(35_400);
    expect(none.value('out_taxBefore')).toBe(389);
    expect(none.value('out_marginalBefore')).toBeCloseTo(0.035, 12);
    expect(none.value('out_usefulRoom')).toBe(0);
    expect(none.value('out_total')).toBe(0);
    expect(none.value('out_bindingConstraint')).toBe('usefulRoom');
    expect(any.value('out_usefulRoom')).toBe(15_400);
    expect([any.value('out_srs'), any.value('out_cpfSelf')]).toEqual([15_300, 100]);
    expect(any.value('out_taxAfter')).toBe(0);
    expect(any.value('out_taxSaved')).toBe(389);
  });

  it('reproduces the IRAS sample calculations of SPEC Appendix B (income year 2025)', () => {
    const heng = loaded.get('2025: IRAS sample, Mr Heng');
    const high = loaded.get('2025: IRAS sample, S$250,000 earner aged 68');
    expect(heng).toBeDefined();
    expect(high).toBeDefined();
    if (!heng || !high) return;
    expect(heng.value('out_assessableIncome')).toBe(49_750);
    expect(heng.value('out_base_totalBeforeCap')).toBe(15_000);
    expect(heng.value('out_ciBefore')).toBe(34_750);
    expect(heng.value('out_taxBefore')).toBe(366.25);
    expect(high.value('out_employeeCpf')).toBe(7_650);
    expect(high.value('out_base_totalBeforeCap')).toBe(15_650);
    expect(high.value('out_ciBefore')).toBe(234_100);
    expect(high.value('out_taxBefore')).toBe(27_629);
  });
});
