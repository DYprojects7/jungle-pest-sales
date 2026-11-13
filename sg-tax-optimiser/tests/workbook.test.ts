/**
 * Workbook parity (SPEC §9, §10): the spreadsheet formulas must equal the engine.
 *
 * The test builds the workbook, writes a set of input profiles into copies, recalculates ALL copies with headless
 * LibreOffice (a few processes side by side), reads the results back through the workbook's named ranges (`out_*`) and compares
 * them with `plan()` — money to the cent, and the warning lines word for word. It is skipped, with a console
 * message, when `soffice` is not on PATH.
 *
 * It also checks the things only a workbook can get wrong: the shipped release file against a fresh build, the
 * chart added to the file, what happens when the Rules sheet is typed over, and — through LibreOffice's own
 * scripting interface — what happens when a row is inserted in or removed from the tax table.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultInput, getRules, plan, sanitiseInput } from '../src/engine/index';
import type { LeverId, PlannerInput, PlannerResult, PlannerWarning, YearRules } from '../src/engine/index';
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
  WARNING_CODES,
  WARNING_LINES,
  WORKBOOK_CHECKS,
  YES,
  bracketCapacity,
  buildWorkbook,
  buildWorkbookWithMap,
  chartXml,
  findSoffice,
  recalculateParallel,
  releaseFileName,
  simulatorSteps,
  workbookBuffer,
  writeWorkbook,
} from '../workbook/build';
import type { BuiltWorkbook, InputName, RuleName } from '../workbook/build';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-11-13';

// ---------------------------------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------------------------------

/** Fields may hold anything: some profiles feed the engine and the cells the same rubbish (SPEC §6.0). */
type Loose<T> = { [K in keyof T]?: unknown };

interface Overrides {
  incomeYear?: number;
  today?: string;
  profile?: Loose<PlannerInput['profile']>;
  income?: Loose<PlannerInput['income']>;
  existing?: Loose<PlannerInput['existing']>;
  otherReliefs?: unknown;
  levers?: {
    srs?: Loose<PlannerInput['levers']['srs']>;
    cpfSelf?: Loose<PlannerInput['levers']['cpfSelf']>;
    cpfFamily?: Loose<PlannerInput['levers']['cpfFamily']>;
  };
  preferences?: Loose<PlannerInput['preferences']>;
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
    otherReliefs: 'otherReliefs' in overrides ? overrides.otherReliefs : base.otherReliefs,
    levers: {
      srs: { ...base.levers.srs, ...overrides.levers?.srs },
      cpfSelf: { ...base.levers.cpfSelf, ...overrides.levers?.cpfSelf },
      cpfFamily: { ...base.levers.cpfFamily, ...overrides.levers?.cpfFamily },
    },
    preferences: { ...base.preferences, ...overrides.preferences },
  } as PlannerInput;
}

/** Today's date on this machine, as the workbook's =TODAY() will see it. */
function systemToday(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const FLEX: LeverId[] = ['srs', 'cpfSelf', 'cpfFamily'];
const INTEREST: LeverId[] = ['cpfSelf', 'srs', 'cpfFamily'];
const FAMILY: LeverId[] = ['cpfFamily', 'srs', 'cpfSelf'];
const ALL_ON = { srs: { enabled: true }, cpfSelf: { enabled: true }, cpfFamily: { enabled: true } };
const ALL_OFF = { srs: { enabled: false }, cpfSelf: { enabled: false }, cpfFamily: { enabled: false } };

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
  // An unlikely table on purpose: tax from the first dollar, two neighbouring brackets at the same rate, a
  // tax-free band in the middle and a rate that falls. The ladder must merge and label rungs as the engine does.
  odd: {
    ...BASE_2026,
    taxBrackets: [
      { from: 0, rate: 0.01 },
      { from: 10_000, rate: 0.03 },
      { from: 20_000, rate: 0.03 },
      { from: 30_000, rate: 0.07 },
      { from: 50_000, rate: 0 },
      { from: 60_000, rate: 0.1 },
      { from: 90_000, rate: 0.08 },
    ],
  },
  // The stock rules for another year, as a buyer gets them by typing a new year over the Rules sheet.
  retyped2027: { ...BASE_2026, incomeYear: 2027, ya: 2028, contributionDeadline: '2027-12-31' },
  retyped2027OldDeadline: { ...BASE_2026, incomeYear: 2027, ya: 2028, contributionDeadline: '2026-12-31' },
};

/** Types a value over a named cell of the Rules sheet (`offset` = row within a named range, from 0). */
type RuleSetter = (name: RuleName, value: ExcelJS.CellValue, offset?: number) => void;

interface Profile {
  name: string;
  input: PlannerInput;
  /** Key of CUSTOM_RULES: the rules the engine is given. The workbook is built from them unless `edit` is set. */
  rules?: keyof typeof CUSTOM_RULES;
  /** Cell contents written after the usual mapping, to test odd entries (text, TRUE, blanks). */
  raw?: Partial<Record<InputName, ExcelJS.CellValue>>;
  /** Edits typed over the Rules sheet of the stock workbook for `input.incomeYear` … */
  edit?: (set: RuleSetter) => void;
  /** … built for this income year (default 2026). */
  editBase?: number;
  /** Workbook checks expected to apply, in the order of WORKBOOK_CHECKS (default none). */
  checks?: number[];
  /** False when the Rules sheet is deliberately broken, so there is nothing to compare with the engine. */
  compare?: boolean;
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
  {
    name: 'Amounts above S$10 billion are capped',
    input: make({
      income: { monthlyOrdinaryWage: 25_000_000_000, additionalWages: 30_000_000_000, otherTaxableIncome: 5_000_000_000, donations: 1_000_000_001 },
      otherReliefs: 99_000_000_000,
      levers: ALL_ON,
      preferences: { cashBudget: 12_000_000_000, minSavingRate: 0.24 },
    }),
  },
  { name: 'Minimum rate typed by hand: 10%', input: make({ levers: ALL_ON, preferences: { minSavingRate: 0.1 } }) },
  { name: 'Minimum rate typed by hand: above 100%', input: make({ preferences: { minSavingRate: 1.5 } }) },
  { name: 'Minimum rate typed by hand: negative', input: make({ profile: { ageAtYearEnd: 44 }, preferences: { minSavingRate: -0.3 } }) },

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

  // ---- Boundaries of SPEC §6 (from the independent review; each one guards a formula a slip would break) ----
  // Chargeable income on and one dollar either side of a bracket edge.
  { name: 'CI exactly 80,000, minimum 11.5% (U = 0)', input: make({ otherReliefs: 33_600, preferences: { minSavingRate: 0.115 } }) },
  { name: 'CI 80,001, minimum 11.5% (U = 1)', input: make({ otherReliefs: 33_599, preferences: { minSavingRate: 0.115 } }) },
  { name: 'CI exactly 80,000, minimum 7%', input: make({ otherReliefs: 33_600 }) },
  { name: 'CI 79,999, minimum 11.5%', input: make({ otherReliefs: 33_601, preferences: { minSavingRate: 0.115 } }) },
  {
    name: 'CI exactly 120,000, minimum 15% (U = 0)',
    input: make({ income: { monthlyOrdinaryWage: 10_000, additionalWages: 26_400 }, preferences: { minSavingRate: 0.15 } }),
  },
  {
    name: 'CI 120,001, minimum 15% (U = 1)',
    input: make({ income: { monthlyOrdinaryWage: 10_000, additionalWages: 26_401 }, preferences: { minSavingRate: 0.15 } }),
  },
  {
    name: 'CI exactly 20,000 (no tax)',
    input: make({ income: { monthlyOrdinaryWage: 3_000, additionalWages: 0 }, otherReliefs: 7_800, preferences: { minSavingRate: 0 } }),
  },
  {
    name: 'CI 20,001 (tax of 2 cents), any saving',
    input: make({ income: { monthlyOrdinaryWage: 3_000, additionalWages: 0 }, otherReliefs: 7_799, preferences: { minSavingRate: 0 } }),
  },
  {
    name: 'CI 20,001 (tax of 2 cents), minimum 2%',
    input: make({ income: { monthlyOrdinaryWage: 3_000, additionalWages: 0 }, otherReliefs: 7_799, preferences: { minSavingRate: 0.02 } }),
  },
  {
    name: 'CI 30,001 (tax 200.035 rounds to 200.04)',
    input: make({ income: { monthlyOrdinaryWage: 3_000, additionalWages: 0, otherTaxableIncome: 2_201 }, otherReliefs: 0, preferences: { minSavingRate: 0 } }),
  },
  {
    name: 'CI 30,003 (tax 200.105 rounds to 200.11), minimum 3.5%',
    input: make({ income: { monthlyOrdinaryWage: 3_000, additionalWages: 0, otherTaxableIncome: 2_203 }, otherReliefs: 0, preferences: { minSavingRate: 0.035 } }),
  },
  {
    name: 'CI exactly 1,000,000, minimum 24% (U = 0)',
    input: make({
      income: { monthlyOrdinaryWage: 80_000, additionalWages: 0, otherTaxableIncome: 85_200 },
      otherReliefs: 25_000,
      levers: ALL_ON,
      preferences: { minSavingRate: 0.24 },
    }),
  },
  {
    name: 'CI 1,000,001, minimum 24% (U = 1)',
    input: make({
      income: { monthlyOrdinaryWage: 80_000, additionalWages: 0, otherTaxableIncome: 85_201 },
      otherReliefs: 25_000,
      levers: ALL_ON,
      preferences: { minSavingRate: 0.24 },
    }),
  },
  {
    name: 'CI 240,007 (odd half cent at 19.5%)',
    input: make({ income: { monthlyOrdinaryWage: 20_000, additionalWages: 26_407 }, otherReliefs: 5_000, levers: ALL_ON, preferences: { minSavingRate: 0.195 } }),
  },

  // CPF wage edges.
  {
    name: 'Wage exactly 500 (no employee share)',
    input: make({ income: { monthlyOrdinaryWage: 500, additionalWages: 1_000, otherTaxableIncome: 60_000 }, preferences: { minSavingRate: 0 } }),
  },
  {
    name: 'Wage 501 (phase-in starts)',
    input: make({ income: { monthlyOrdinaryWage: 501, additionalWages: 1_000, otherTaxableIncome: 60_000 }, preferences: { minSavingRate: 0 } }),
  },
  { name: 'Wage 749', input: make({ income: { monthlyOrdinaryWage: 749, additionalWages: 0, otherTaxableIncome: 60_000 } }) },
  { name: 'Wage exactly 750', input: make({ income: { monthlyOrdinaryWage: 750, additionalWages: 0, otherTaxableIncome: 60_000 } }) },
  { name: 'Wage 751', input: make({ income: { monthlyOrdinaryWage: 751, additionalWages: 0, otherTaxableIncome: 60_000 } }) },
  { name: 'Wage exactly 8,000, bonus exactly 6,000 (both ceilings)', input: make({ income: { monthlyOrdinaryWage: 8_000, additionalWages: 6_000 } }) },
  { name: 'Wage 8,001, bonus 6,001', input: make({ income: { monthlyOrdinaryWage: 8_001, additionalWages: 6_001 } }) },
  { name: 'Wage 7,999, bonus 6,013', input: make({ income: { monthlyOrdinaryWage: 7_999, additionalWages: 6_013 } }) },
  {
    name: 'Wage 6,667 at 12.5% (fractional share)',
    input: make({ profile: { ageAtYearEnd: 63, birthMonth: 2 }, income: { monthlyOrdinaryWage: 6_667, additionalWages: 3_333 } }),
  },

  // Ages either side of every band, with birth months at both ends of the year.
  ...(
    [
      [54, 1],
      [55, 1],
      [55, 11],
      [56, 12],
      [59, 12],
      [60, 12],
      [61, 1],
      [65, 1],
      [66, 6],
      [70, 12],
      [71, 1],
    ] as const
  ).map(
    ([age, birthMonth]): Profile => ({
      name: `Age ${age}, birth month ${birthMonth}, everything switched on`,
      input: make({ profile: { ageAtYearEnd: age, birthMonth }, income: { monthlyOrdinaryWage: 6_543, additionalWages: 12_345 }, levers: ALL_ON }),
    }),
  ),
  { name: 'Age 18 citizen (SRS just open)', input: make({ profile: { ageAtYearEnd: 18 }, levers: ALL_ON }) },
  { name: 'Age 17 citizen, everything switched on (no SRS, CPF open)', input: make({ profile: { ageAtYearEnd: 17 }, levers: ALL_ON }) },
  { name: 'Age 0', input: make({ profile: { ageAtYearEnd: 0 }, levers: ALL_ON }) },
  { name: 'Age 120', input: make({ profile: { ageAtYearEnd: 120, birthMonth: 5 }, levers: ALL_ON }) },
  { name: 'Foreigner aged 17: nothing open to them', input: make({ profile: { residency: 'foreigner', ageAtYearEnd: 17 }, levers: ALL_ON }) },
  {
    name: 'Foreigner aged 60, everything switched on, CPF figure above the maximum',
    input: make({ profile: { residency: 'foreigner', ageAtYearEnd: 60, birthMonth: 2 }, income: { employeeCpfOverride: 30_000 }, levers: ALL_ON }),
  },
  {
    name: 'Foreigner aged 55, only own CPF switched on, existing top-ups',
    input: make({
      profile: { residency: 'foreigner', ageAtYearEnd: 55 },
      existing: { cpfTopUpSelf: 100, cpfTopUpFamily: 100 },
      levers: { srs: { enabled: false }, cpfSelf: { enabled: true }, cpfFamily: { enabled: false } },
    }),
  },
  {
    name: 'Foreigner with existing CPF top-ups above the caps (not open to them, so no warning)',
    input: make({ profile: { residency: 'foreigner' }, existing: { cpfTopUpSelf: 9_000, cpfTopUpFamily: 9_000, srs: 35_700 }, levers: ALL_ON }),
  },
  { name: 'Citizen with "1st year" left in the PR cell (ignored)', input: make({ profile: { residency: 'citizen', prYear: 1 } }) },
  {
    name: 'PR in 2nd year aged 70, CPF figure one dollar above the maximum',
    input: make({ profile: { residency: 'pr', prYear: 2, ageAtYearEnd: 70, birthMonth: 6 }, income: { employeeCpfOverride: 20_401 }, levers: ALL_ON }),
  },
  { name: 'CPF figure exactly the maximum', input: make({ income: { employeeCpfOverride: 20_400 } }) },
  { name: 'CPF figure of 0 (counts as a figure, not as blank)', input: make({ income: { employeeCpfOverride: 0 } }) },

  // Limits that tie, and limits at 0 and 1.
  { name: 'Nothing switched on, U = 0', input: make({ levers: ALL_OFF, preferences: { minSavingRate: 0.24 } }) },
  { name: 'Nothing switched on, relief cap already reached', input: make({ levers: ALL_OFF, otherReliefs: 58_600 }) },
  { name: 'Nothing switched on, no tax', input: make({ levers: ALL_OFF, income: { monthlyOrdinaryWage: 1_500, additionalWages: 0 } }) },
  { name: 'Budget 0 and nothing switched on (L = B = 0)', input: make({ levers: ALL_OFF, preferences: { cashBudget: 0 } }) },
  { name: 'Budget 0 and U = 0', input: make({ preferences: { cashBudget: 0, minSavingRate: 0.24 } }) },
  { name: 'Budget 1', input: make({ preferences: { cashBudget: 1 } }) },
  { name: 'Budget equals L (tie between scheme room and cash)', input: make({ preferences: { cashBudget: 23_300 } }) },
  { name: 'Budget one dollar under L', input: make({ preferences: { cashBudget: 23_299 } }) },
  { name: 'C equals L (tie between relief cap and scheme room)', input: make({ otherReliefs: 35_300 }) },
  { name: 'U equals C (tie between minimum rate and relief cap)', input: make({ income: { monthlyOrdinaryWage: 10_000, additionalWages: 0 }, otherReliefs: 40_000 }) },
  { name: 'U equals L (tie between minimum rate and scheme room)', input: make({ income: { monthlyOrdinaryWage: 8_000, additionalWages: 4_000 }, otherReliefs: 15_700 }) },
  {
    name: 'U equals C equals B (three-way tie)',
    input: make({ income: { monthlyOrdinaryWage: 10_000, additionalWages: 0 }, otherReliefs: 40_000, preferences: { cashBudget: 19_800 } }),
  },
  { name: 'Reliefs one dollar over the cap', input: make({ otherReliefs: 58_601, levers: ALL_ON }) },
  { name: 'Reliefs one dollar under the cap (C = 1)', input: make({ otherReliefs: 58_599, levers: ALL_ON }) },
  { name: 'Plan reaches the relief cap exactly', input: make({ otherReliefs: 22_300, levers: ALL_ON, preferences: { minSavingRate: 0 } }) },
  { name: 'Existing contributions exactly at every cap', input: make({ existing: { srs: 15_300, cpfTopUpSelf: 8_000, cpfTopUpFamily: 8_000 }, levers: ALL_ON }) },
  { name: 'Existing contributions one dollar over every cap', input: make({ existing: { srs: 15_301, cpfTopUpSelf: 8_001, cpfTopUpFamily: 8_001 }, levers: ALL_ON }) },
  { name: 'Existing contributions one dollar under every cap', input: make({ existing: { srs: 15_299, cpfTopUpSelf: 7_999, cpfTopUpFamily: 7_999 }, levers: ALL_ON }) },
  { name: 'Existing over the cap on a scheme that is switched off', input: make({ existing: { cpfTopUpFamily: 9_000 } }) },
  { name: 'Own CPF room 0 and family maximum 0', input: make({ levers: { ...ALL_ON, cpfSelf: { enabled: true, roomToLimit: 0 }, cpfFamily: { enabled: true, maxAmount: 0 } } }) },
  {
    name: 'Own CPF room and family maximum above the caps',
    input: make({ levers: { ...ALL_ON, cpfSelf: { enabled: true, roomToLimit: 50_000 }, cpfFamily: { enabled: true, maxAmount: 50_000 } } }),
  },
  { name: 'Family first, U = 5', input: make({ otherReliefs: 33_595, levers: ALL_ON, preferences: { minSavingRate: 0.115, priority: FAMILY } }) },
  { name: 'Guaranteed interest first, U = 8,001', input: make({ otherReliefs: 25_599, levers: ALL_ON, preferences: { minSavingRate: 0.115, priority: INTEREST } }) },
  { name: 'Family first, budget inside the family room', input: make({ levers: ALL_ON, preferences: { priority: FAMILY, cashBudget: 7_999 } }) },

  // Ladders with several rungs.
  {
    name: 'Ladder crossing four brackets and the relief cap',
    input: make({ income: { monthlyOrdinaryWage: 4_600, additionalWages: 9_000 }, otherReliefs: 0, levers: ALL_ON, preferences: { minSavingRate: 0 } }),
  },
  {
    name: 'Ladder: chargeable income smaller than the room',
    input: make({ income: { monthlyOrdinaryWage: 2_400, additionalWages: 0 }, otherReliefs: 0, levers: ALL_ON, preferences: { minSavingRate: 0 } }),
  },
  {
    name: 'Ladder: chargeable income of 0 with schemes switched on',
    input: make({ income: { monthlyOrdinaryWage: 900, additionalWages: 0 }, otherReliefs: 0, levers: ALL_ON, preferences: { minSavingRate: 0 } }),
  },
  {
    name: 'Ladder: tax-free dollars and then dollars over the cap',
    input: make({ income: { monthlyOrdinaryWage: 8_000, additionalWages: 6_000 }, otherReliefs: 55_000, levers: ALL_ON, preferences: { minSavingRate: 0 } }),
  },

  // Income oddities.
  { name: 'One month worked', input: make({ income: { monthlyOrdinaryWage: 9_000, monthsWorked: 1, additionalWages: 0, otherTaxableIncome: 70_000 } }) },
  { name: 'Earned Income Relief limited to earned income', input: make({ income: { monthlyOrdinaryWage: 50, additionalWages: 0, otherTaxableIncome: 75_000 }, otherReliefs: 0 }) },
  { name: 'Donations of S$1 (deduction with cents)', input: make({ income: { donations: 1 } }) },
  { name: 'Donations of S$3 with chargeable income on a bracket edge', input: make({ income: { donations: 3 }, otherReliefs: 33_592, preferences: { minSavingRate: 0.115 } }) },

  // Simulator: the table must reach the maximum contribution at the smallest step (reported as cut off at 120 steps).
  { name: 'Simulator: L 12,000 at step 100', input: make({ existing: { srs: 3_300 }, levers: { cpfSelf: { enabled: false } }, preferences: { simulatorStep: 100 } }) },
  { name: 'Simulator: L 12,001 at step 100 (was cut off)', input: make({ existing: { srs: 3_299 }, levers: { cpfSelf: { enabled: false } }, preferences: { simulatorStep: 100 } }) },
  { name: 'Simulator: foreigner, L 35,700 at step 100 (357 steps)', input: make({ profile: { residency: 'foreigner' }, preferences: { simulatorStep: 100 } }) },
  { name: 'Simulator: step larger than L', input: make({ preferences: { simulatorStep: 100_000 } }) },
  { name: 'Simulator: step equals L', input: make({ preferences: { simulatorStep: 23_300 } }) },
  { name: 'Simulator: step 777, family first', input: make({ levers: ALL_ON, preferences: { simulatorStep: 777, priority: FAMILY } }) },
  { name: 'Simulator: L 0', input: make({ levers: ALL_OFF, preferences: { simulatorStep: 100 } }) },

  // Dates.
  { name: 'As at 30 December (1 day left)', input: make({ today: '2026-12-30' }) },
  { name: 'As at 1 January 2000', input: make({ today: '2000-01-01' }) },
  { name: 'Monthly: X = 1 over 12 months', input: make({ today: '2026-01-15', otherReliefs: 33_599, preferences: { minSavingRate: 0.115 } }) },
  { name: 'Monthly: 11 months, amounts that do not divide', input: make({ today: '2026-02-01', levers: ALL_ON, preferences: { cashBudget: 17_777 } }) },
  { name: 'As at 31 December with nothing switched on (no deadline warning)', input: make({ today: '2026-12-31', levers: ALL_OFF }) },

  // Odd cell contents: the engine is given the same rubbish (SPEC §6.0).
  { name: 'RAW months worked 0 (counts as 1)', input: make({ income: { monthsWorked: 0 } }) },
  { name: 'RAW months worked -3', input: make({ income: { monthsWorked: -3 } }) },
  { name: 'RAW months worked 0.5', input: make({ income: { monthsWorked: 0.5 } }) },
  { name: 'RAW months worked 12.9', input: make({ income: { monthsWorked: 12.9 } }) },
  { name: 'RAW text in months worked', input: make({ income: { monthsWorked: 'x' } }), raw: { in_monthsWorked: 'x' } },
  { name: 'RAW text in monthly salary', input: make({ income: { monthlyOrdinaryWage: Number.NaN } }), raw: { in_monthlyWage: 'ten thousand' } },
  { name: 'RAW text in age', input: make({ profile: { ageAtYearEnd: 'old' } }), raw: { in_age: 'old' } },
  { name: 'RAW age 54.9', input: make({ profile: { ageAtYearEnd: 54.9 } }) },
  { name: 'RAW age 500', input: make({ profile: { ageAtYearEnd: 500 } }) },
  // The review's one mismatch. LibreOffice has no logical type: TRUE in a number cell is stored and shown as 1,
  // so there the workbook must behave exactly as if 1 had been typed (Excel and the engine read TRUE as 0).
  { name: 'RAW TRUE in the bonus cell (LibreOffice stores and shows it as 1)', input: make({ income: { additionalWages: 1 } }), raw: { in_additionalWages: true } },
  { name: 'RAW blank residency', input: make({ profile: { residency: undefined } }), raw: { in_residency: null } },
  { name: 'RAW unknown residency', input: make({ profile: { residency: 'alien' } }), raw: { in_residency: 'Alien' } },
  { name: 'RAW blank "which scheme first"', input: make(), raw: { in_priority: null } },
  { name: 'RAW blank yes/no cells', input: make({ levers: ALL_OFF }), raw: { in_useSrs: null, in_useCpfSelf: null, in_useCpfFamily: null } },
  { name: 'RAW number typed as text in other reliefs', input: make({ otherReliefs: '5000' }), raw: { in_otherReliefs: '5000' } },
  { name: 'RAW blank minimum rate', input: make({ preferences: { minSavingRate: undefined } }), raw: { in_minSavingRate: null } },
  { name: 'RAW text in the minimum rate', input: make({ preferences: { minSavingRate: '7%' } }), raw: { in_minSavingRate: '7%' } },
  { name: 'RAW text in the CPF figure', input: make({ income: { employeeCpfOverride: 'n/a' } }), raw: { in_cpfOverride: 'n/a' } },
  { name: 'RAW negative cash limit', input: make({ preferences: { cashBudget: -5 } }) },
  // SPEC §6.0: a negative CPF figure is not a figure, so the worked-out contribution is used (not a relief of 0).
  { name: 'RAW negative CPF figure', input: make({ income: { employeeCpfOverride: -500 } }) },
  { name: 'RAW simulator step 0', input: make({ preferences: { simulatorStep: 0 } }) },
  { name: 'RAW simulator step 99.5', input: make({ preferences: { simulatorStep: 99.5 } }) },
  { name: 'RAW text in the simulator step', input: make({ preferences: { simulatorStep: 'big' } }), raw: { in_simulatorStep: 'big' } },
  { name: 'RAW as-at date with a time of day', input: make({ today: '2026-12-17' }), raw: { in_asAtDate: new Date(Date.UTC(2026, 11, 17, 18, 30)) } },
  // A cleared as-at cell means today (a declared difference from the engine's 1 January fallback).
  { name: 'RAW blank as-at date (means today)', input: make({ today: systemToday() }), raw: { in_asAtDate: null } },
  { name: 'RAW text in the as-at date (means today)', input: make({ today: systemToday() }), raw: { in_asAtDate: 'tomorrow' } },
  { name: 'RAW blank birth month in the year of turning 55', input: make({ profile: { ageAtYearEnd: 55, birthMonth: undefined } }), raw: { in_birthMonth: null } },

  // A tax table unlike any real one: rungs must merge and be labelled as in the engine.
  { name: 'Odd tax table: every rung, any saving', rules: 'odd', input: make({ levers: ALL_ON, preferences: { minSavingRate: 0 } }) },
  {
    name: 'Odd tax table: income of 45,000 with a 3% minimum',
    rules: 'odd',
    input: make({ income: { monthlyOrdinaryWage: 3_750, additionalWages: 0 }, otherReliefs: 0, levers: ALL_ON, preferences: { minSavingRate: 0.03 } }),
  },
  {
    name: 'Odd tax table: chargeable income below the room',
    rules: 'odd',
    input: make({ income: { monthlyOrdinaryWage: 1_900, additionalWages: 0 }, otherReliefs: 0, levers: ALL_ON, preferences: { minSavingRate: 0 } }),
  },
  {
    name: 'Odd tax table: minimum of 8% skips the tax-free band in the middle',
    rules: 'odd',
    input: make({ income: { monthlyOrdinaryWage: 8_000, additionalWages: 0 }, otherReliefs: 0, levers: ALL_ON, preferences: { minSavingRate: 0.08 } }),
  },

  // Values typed over the Rules sheet of the stock workbook, as a buyer would.
  {
    name: 'Typed on Rules: income year 2027 (the deadline follows the year)',
    rules: 'retyped2027',
    input: make({ incomeYear: 2027, today: '2027-11-13' }),
    edit: (set) => set('rule_incomeYear', 2027),
  },
  {
    name: 'Typed on Rules: income year 2027, looked at the day after its deadline',
    rules: 'retyped2027',
    input: make({ incomeYear: 2027, today: '2028-01-01' }),
    edit: (set) => set('rule_incomeYear', 2027),
  },
  {
    name: 'Typed on Rules: a rebate of 60% capped at S$200',
    rules: 'rebate',
    input: make({ profile: { ageAtYearEnd: 28 }, income: { monthlyOrdinaryWage: 3_500, additionalWages: 3_500 }, otherReliefs: 0, preferences: { minSavingRate: 0 } }),
    edit: (set) => {
      set('rule_rebateRate', 0.6);
      set('rule_rebateCap', 200);
    },
  },
  {
    name: 'Typed on Rules: income year 2027 with last year\'s deadline typed in (check line)',
    rules: 'retyped2027OldDeadline',
    input: make({ incomeYear: 2027, today: '2027-11-13' }),
    edit: (set) => {
      set('rule_incomeYear', 2027);
      set('rule_deadline', new Date(Date.UTC(2026, 11, 31)));
    },
    checks: [0, 1],
  },
  {
    name: 'Typed on Rules: two brackets out of order (check line)',
    input: make(),
    edit: (set) => {
      set('rule_bracketFrom', 120_000, 4);
      set('rule_bracketFrom', 80_000, 5);
    },
    checks: [1, 0],
    compare: false,
  },
  {
    name: 'Typed on Rules: a bracket rate cleared (check line)',
    input: make(),
    edit: (set) => set('rule_bracketRate', null, 6),
    checks: [1, 0],
    compare: false,
  },
  {
    name: 'Typed on Rules: the deadline cleared (31 December is used, with a check line)',
    input: make(),
    edit: (set) => set('rule_deadline', null),
    checks: [0, 1],
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Writing inputs
// ---------------------------------------------------------------------------------------------------------------

function isoToDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day));
}

/** The Planner cell values for an engine input (undefined / null / NaN become a blank cell). */
function cellValues(input: PlannerInput): Record<InputName, ExcelJS.CellValue> {
  const cell = (value: unknown): ExcelJS.CellValue =>
    value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value)) ? null : (value as ExcelJS.CellValue);
  const yesNo = (value: unknown): string => (value === true ? YES : NO);
  const preset = PRIORITY_PRESETS.find((candidate) => candidate.order.join() === input.preferences.priority.join());
  if (!preset) throw new Error(`No "Which first?" preset for priority ${input.preferences.priority.join()}`);
  const { profile, income, existing, levers, preferences } = input;
  return {
    in_residency: RESIDENCY_LABELS[profile.residency] ?? null,
    in_prYear: profile.prYear === undefined ? null : (PR_YEAR_LABELS[profile.prYear - 1] ?? null),
    in_age: cell(profile.ageAtYearEnd),
    in_birthMonth: profile.birthMonth === undefined ? null : (MONTH_LABELS[profile.birthMonth - 1] ?? null),
    in_monthlyWage: cell(income.monthlyOrdinaryWage),
    in_monthsWorked: cell(income.monthsWorked),
    in_additionalWages: cell(income.additionalWages),
    in_otherIncome: cell(income.otherTaxableIncome),
    in_employmentExpenses: cell(income.employmentExpenses),
    in_donations: cell(income.donations),
    in_cpfOverride: cell(income.employeeCpfOverride),
    in_existingSrs: cell(existing.srs),
    in_existingCpfSelf: cell(existing.cpfTopUpSelf),
    in_existingCpfFamily: cell(existing.cpfTopUpFamily),
    in_otherReliefs: cell(input.otherReliefs),
    in_useSrs: yesNo(levers.srs.enabled),
    in_useCpfSelf: yesNo(levers.cpfSelf.enabled),
    in_cpfSelfRoom: cell(levers.cpfSelf.roomToLimit),
    in_useCpfFamily: yesNo(levers.cpfFamily.enabled),
    in_cpfFamilyMax: cell(levers.cpfFamily.maxAmount),
    in_minSavingRate: cell(preferences.minSavingRate),
    in_cashBudget: cell(preferences.cashBudget),
    in_priority: preset.label,
    in_asAtDate: isoToDate(input.today),
    in_simulatorStep: cell(preferences.simulatorStep),
  };
}

/** "$C$13:$C$26" -> { col: 3, top: 13, bottom: 26 }. */
function parseRef(ref: string): { col: number; top: number; bottom: number } {
  const match = /^\$([A-Z]+)\$(\d+)(?::\$([A-Z]+)\$(\d+))?$/.exec(ref);
  if (!match) throw new Error(`Cannot parse the reference ${ref}`);
  const col = (match[1] ?? '').split('').reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
  return { col, top: Number(match[2]), bottom: Number(match[4] ?? match[2]) };
}

function colLetters(col: number): string {
  let out = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

function writeInputs(built: BuiltWorkbook, input: PlannerInput, raw: Profile['raw'] = {}): void {
  const values = { ...cellValues(input), ...raw };
  for (const name of INPUT_NAMES) {
    const location = built.map.inputs[name];
    const ws = built.workbook.getWorksheet(location.sheet);
    if (!ws) throw new Error(`Missing sheet ${location.sheet}`);
    ws.getCell(location.ref.replace(/\$/g, '')).value = values[name];
  }
}

/** Types over named cells of the Rules sheet. */
function ruleSetter(built: BuiltWorkbook): RuleSetter {
  return (name, value, offset = 0) => {
    const location = built.map.rules[name];
    const ws = built.workbook.getWorksheet(location.sheet);
    if (!ws) throw new Error(`Missing sheet ${location.sheet}`);
    const { col, top, bottom } = parseRef(location.ref);
    if (top + offset > bottom) throw new Error(`${name} has no row ${offset}`);
    ws.getCell(top + offset, col).value = value;
  };
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
  constructor(readonly wb: ExcelJS.Workbook) {}

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

function text(actual: Scalar, label: string): string {
  expect(typeof actual, `${label} should be text, got ${JSON.stringify(actual)}`).toBe('string');
  return String(actual);
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

const LEAD = { info: 'Note — ', caution: 'Check — ', blocker: 'Too late — ' } as const;

function dollars(amount: number): string {
  return `S$${amount.toLocaleString('en-US')}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The Planner lines for an engine warning: the engine's own message after "Note — " / "Check — " / "Too late — ",
 * with its first letter in lower case. EXISTING_EXCEEDS_CAP has one sentence for each scheme over its cap, and
 * the Planner gives each sentence a line of its own.
 */
function plannerLines(warning: PlannerWarning): string[] {
  const sentences = warning.code === 'EXISTING_EXCEEDS_CAP' ? warning.message.split(/(?<=earns none\.) (?=You have already put)/) : [warning.message];
  return sentences.map((sentence) => LEAD[warning.severity] + sentence.charAt(0).toLowerCase() + sentence.slice(1));
}

/** How the "Why the plan stops here" sentence must begin for each binding constraint. */
function reasonPattern(expected: PlannerResult): RegExp {
  const { plan: p, levers } = expected;
  const room = LEVERS.reduce((total, lever) => total + levers[lever].room, 0);
  switch (p.bindingConstraint) {
    case 'none':
      return /^You have no tax to pay for this year/;
    case 'usefulRoom':
      if (p.totalContribution === 0) return /^Nothing is recommended: each extra dollar would save [\d.]+ cents or less, below the [\d.]+ cents you asked for\./;
      return p.marginalRateAfter === 0 ? /^The plan takes your chargeable income down to the tax-free band\./ : /^Beyond this, each extra dollar would save [\d.]+ cents or less/;
    case 'reliefCap':
      return p.totalContribution === 0 ? /^Your reliefs have already reached the S\$[\d,]+ overall cap/ : /^The plan stops where your total reliefs reach the S\$[\d,]+ overall cap\./;
    case 'leverLimits': {
      if (room > 0) return /^You have used all the room in the schemes you switched on\./;
      const switchedOn = LEVERS.filter((lever) => levers[lever].enabled);
      if (switchedOn.length === 0) return /^No scheme is switched on, so there is nothing to recommend\./;
      return switchedOn.every((lever) => !levers[lever].eligible)
        ? /^None of the schemes you switched on is open to you/
        : /^The schemes you switched on have no room left this year/;
    }
    case 'cashBudget':
      return new RegExp(`^Your cash limit of ${escapeRegExp(dollars(expected.input.preferences.cashBudget ?? 0))} is used up\\.`);
    default:
      throw new Error(`Unknown binding constraint ${String(p.bindingConstraint)}`);
  }
}

interface ParityOptions {
  /** Workbook checks expected to apply, in the order of WORKBOOK_CHECKS. */
  checks?: number[];
}

function assertParity(results: Results, expected: PlannerResult, options: ParityOptions = {}): void {
  const { cpf, baseline, optimised, plan: p, levers, ladder, simulator, scenarios, monthlyPlan, warnings, rules } = expected;
  const leverRoom = levers.srs.room + levers.cpfSelf.room + levers.cpfFamily.room;

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

  // §6.4 the tax table as the Tax Working sheet lists it: the Rules brackets, and slices that add up
  const bracketFrom = results.column('out_bracket_from');
  const bracketRate = results.column('out_bracket_rate');
  rules.taxBrackets.forEach((bracket, index) => {
    expectDollars(bracketFrom[index] ?? null, bracket.from, `bracket ${index + 1} start`);
    expectRate(bracketRate[index] ?? null, bracket.rate, `bracket ${index + 1} rate`);
  });
  expect(bracketFrom.slice(rules.taxBrackets.length).every((value) => value === null), 'unused bracket rows are blank').toBe(true);
  const sumOf = (column: Scalar[]): number => column.reduce<number>((total, value) => total + (typeof value === 'number' ? value : 0), 0);
  expect(sumOf(results.column('out_bracket_baseIncome')), 'income slices add up to chargeable income').toBe(baseline.chargeableIncome);
  expect(Math.abs(sumOf(results.column('out_bracket_baseTax')) - baseline.grossTax), 'tax by slice adds up to the tax').toBeLessThanOrEqual(0.005 + 1e-6);

  // §6.5 levers
  for (const lever of LEVERS) {
    expect(results.value(`out_eligible_${lever}`), `${lever} eligible`).toBe(levers[lever].eligible ? 1 : 0);
    expect(results.value(`out_enabled_${lever}`), `${lever} enabled`).toBe(levers[lever].enabled ? 1 : 0);
    expectDollars(results.value(`out_cap_${lever}`), levers[lever].statutoryCap, `${lever} statutory cap`);
    expectDollars(results.value(`out_used_${lever}`), levers[lever].used, `${lever} used`);
    expectDollars(results.value(`out_room_${lever}`), levers[lever].room, `${lever} room`);
  }
  expectDollars(results.value('out_leverRoom'), leverRoom, 'lever room L');
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
  expect(text(results.value('out_reason'), 'reason sentence'), 'reason sentence').toMatch(reasonPattern(expected));

  // §6.7 ladder: the rows shown are the engine's tiers, in order and closed up
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
  expect(rungRows, 'ladder rows shown').toEqual(ladder.map((_tier, index) => index));
  ladder.forEach((tier, index) => {
    const label = `ladder tier ${index + 1}`;
    expectDollars(ladderCols.from[index] ?? null, tier.fromContribution, `${label} from`);
    expectDollars(ladderCols.to[index] ?? null, tier.toContribution, `${label} to`);
    expectDollars(ladderCols.amount[index] ?? null, tier.amount, `${label} amount`);
    expectRate(ladderCols.rate[index] ?? null, tier.rate, `${label} rate`);
    expectCents(ladderCols.taxSaved[index] ?? null, tier.taxSaved, `${label} tax saved`);
    expectCents(ladderCols.cumulative[index] ?? null, tier.cumulativeTaxSaved, `${label} cumulative`);
    expectDollars(ladderCols.used[index] ?? null, tier.usedByPlan, `${label} used by plan`);
    expect(ladderCols.reason[index] ?? null, `${label} zero reason`).toBe(tier.zeroReason ?? null);
  });

  // The chart's points: four per rung (start, where the plan stops inside it twice, end); later rows repeat the last point
  const chart = {
    x: results.column('out_chart_x'),
    all: results.column('out_chart_all'),
    planX: results.column('out_chart_planX'),
    plan: results.column('out_chart_plan'),
  };
  expect(chart.x.length, 'chart points').toBe(ladderCols.amount.length * 4);
  const X = p.totalContribution;
  let last = { x: 0, all: 0, plan: 0 };
  for (let index = 0; index < ladderCols.amount.length; index++) {
    const tier = ladder[index];
    for (let q = 0; q < 4; q++) {
      const at = index * 4 + q;
      const label = `chart point ${at + 1}`;
      if (tier) {
        const stop = Math.max(tier.fromContribution, Math.min(tier.toContribution, X));
        last = {
          x: q === 0 ? tier.fromContribution : q === 3 ? tier.toContribution : stop,
          all: tier.rate,
          plan: (q <= 1 ? tier.fromContribution < X : tier.toContribution <= X) ? tier.rate : 0,
        };
      }
      expectDollars(chart.x[at] ?? null, last.x, `${label} x`);
      expectRate(chart.all[at] ?? null, last.all, `${label} every rung`);
      // The plan's line never runs past the plan total.
      expectDollars(chart.planX[at] ?? null, Math.min(last.x, X), `${label} x of your plan`);
      expectRate(chart.plan[at] ?? null, last.plan, `${label} your plan`);
    }
  }

  // §6.8 simulator: every engine row, up to the maximum contribution, and blank rows after it
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
  expect(simulator.length, 'the simulator table has a row for every step up to the maximum contribution').toBeLessThanOrEqual(sim.contribution.length);
  expect(text(results.value('out_simulatorNote'), 'simulator note'), 'simulator note').toMatch(/^Steps of S\$[\d,]+ up to the S\$[\d,]+ of room/);
  for (let i = 0; i < sim.contribution.length; i++) {
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
  expectDollars(sim.contribution[simulator.length - 1] ?? null, leverRoom, 'the last simulator row is the maximum contribution');

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
    comment: results.column('out_scen_comment'),
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
  // The comment on the recommended row names the limit that stopped the plan.
  const planComment = text(scen.comment[SCENARIO_IDS.indexOf('recommended')] ?? null, 'comment on the recommended plan');
  const stops = {
    none: /^The recommended plan\./,
    usefulRoom: /^Stops where the next dollar would save less than your minimum\./,
    reliefCap: /^Stops at the overall relief cap\./,
    leverLimits: /^Uses all the room in the schemes you switched on\./,
    cashBudget: /^Stops at your cash limit\./,
  } as const;
  expect(planComment).toMatch(p.totalContribution === 0 ? /^Nothing more is recommended/ : stops[p.bindingConstraint]);

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
    expect(sumOf(sched.srs)).toBe(p.contributions.srs);
    expect(sumOf(sched.cpfSelf)).toBe(p.contributions.cpfSelf);
    expect(sumOf(sched.cpfFamily)).toBe(p.contributions.cpfFamily);
    expect(sumOf(sched.total)).toBe(p.totalContribution);
  }
  expectDollars(results.value('out_fullYear_srs'), monthlyPlan.fullYearMonthly.srs, 'start in January: SRS');
  expectDollars(results.value('out_fullYear_cpfSelf'), monthlyPlan.fullYearMonthly.cpfSelf, 'start in January: CPF self');
  expectDollars(results.value('out_fullYear_cpfFamily'), monthlyPlan.fullYearMonthly.cpfFamily, 'start in January: CPF family');
  expectDollars(results.value('out_fullYear_total'), monthlyPlan.fullYearMonthly.total, 'start in January: total');
  // The banner above the instalments agrees with the table under it.
  const days = monthlyPlan.daysToDeadline;
  const monthlyBanner =
    days < 0
      ? monthlyPlan.schedule.length > 0
        ? /^The deadline for \d{4} passed on \d+ \w+ \d{4}\. The amounts below are listed only because the year has not ended/
        : /^The deadline for \d{4} has passed \(\d+ \w+ \d{4}\)\. .* no instalments are shown\.$/
      : p.totalContribution === 0
        ? /^Nothing more is recommended for \d{4}, so there are no instalments\./
        : days === 0
          ? /^Today is the deadline\. Transfer now/
          : days <= 14
            ? new RegExp(`^Only ${days} day${days === 1 ? '' : 's'} left\\.`)
            : new RegExp(`^Set aside the amounts below in each of the ${monthlyPlan.monthsRemaining} month${monthlyPlan.monthsRemaining === 1 ? '' : 's'} left to reach ${escapeRegExp(dollars(p.totalContribution))} by `);
  expect(text(results.value('out_monthlyBanner'), 'monthly banner')).toMatch(monthlyBanner);

  // §6.11 warnings: the same codes fire, and the Planner shows the engine's message for each, in order,
  // after a line for each workbook check that applies
  const codes = results.column('out_warningCodes');
  const flags = results.column('out_warningFlags');
  expect(codes).toEqual([...WARNING_CODES]);
  const fired = codes.filter((_code, index) => flags[index] === 1);
  expect(fired, 'warnings that fire').toEqual(warnings.map((warning) => warning.code));
  const checks = options.checks ?? WORKBOOK_CHECKS.map(() => 0);
  expect(results.column('out_workbookCheckFlags'), 'workbook checks that apply').toEqual(checks);
  const checkCount = checks.reduce((total, flag) => total + flag, 0);
  const lineCells = results.column('out_warnings');
  expect(lineCells.length).toBe(WARNING_LINES);
  const lines = lineCells.filter((line) => line !== null).map(String);
  expect(lines.slice(checkCount), 'warning lines on the Planner').toEqual(warnings.flatMap(plannerLines));
  // …and the Tax Working sheet lists each message whole, beside its code.
  const messages = results.column('out_warningMessages');
  warnings.forEach((warning) => {
    const whole = LEAD[warning.severity] + warning.message.charAt(0).toLowerCase() + warning.message.slice(1);
    expect(messages[WARNING_CODES.indexOf(warning.code)], `${warning.code} on the Tax Working sheet`).toBe(whole);
  });
  // SPEC §6.11: the further savings a message may quote are the ones a single change of setting can reach.
  for (const warning of warnings) {
    if (warning.code === 'BUDGET_LIMITS_PLAN') expectCents(results.value('out_savingWithMoreCash'), Number(warning.params?.savingWithMoreCash), 'saving with more cash');
    if (warning.code === 'LEVER_LIMITS_PLAN') expectCents(results.value('out_savingIfSwitchedOn'), Number(warning.params?.savingIfSwitchedOn), 'saving with every scheme switched on');
  }
  for (const line of lines.slice(0, checkCount)) expect(line).toMatch(/^Check — the (tax table|last contribution day) on the Rules sheet /);
  expect(lineCells.slice(lines.length).every((line) => line === null), 'warning lines are closed up').toBe(true);

  // The Planner says so at the top when the Rules sheet needs attention, and never otherwise.
  const banner = text(results.value('out_plannerBanner'), 'Planner banner');
  expect(banner).toMatch(checkCount > 0 ? /^CHECK THE RULES SHEET FIRST/ : /^(EXAMPLE SHOWN|Your figures) — /);
  if (checks[0] === 0) expect(results.value('out_rulesIssue'), 'the tax table is in order').toBeNull();

  // The notes beside the optional cells say which figure is in use.
  const input = expected.input;
  const overrideNote = text(results.value('out_note_cpfOverride'), 'note beside the CPF figure');
  if (input.profile.residency === 'foreigner') expect(overrideNote).toMatch(/^Not used: foreigners/);
  else if (cpf.source === 'auto') expect(overrideNote).toBe(`Not filled in, so it is worked out from your pay: ${dollars(cpf.employeeContribution)}. Fill in to use the figure on your payslips or CPF statement.`);
  else if (fired.includes('CPF_OVERRIDE_ABOVE_MAX')) expect(overrideNote).toMatch(new RegExp(`^Above the most possible in a year, so ${escapeRegExp(dollars(cpf.employeeContribution))} is used\\.`));
  else expect(overrideNote).toMatch(new RegExp(`^Using your figure of ${escapeRegExp(dollars(cpf.employeeContribution))} instead of the worked-out S\\$[\\d,]+\\.`));
  const budgetNote = text(results.value('out_note_cashBudget'), 'note beside the cash limit');
  const budget = input.preferences.cashBudget ?? null;
  if (budget === null) expect(budgetNote).toBe('Blank = no limit.');
  else if (budget === 0) expect(budgetNote).toMatch(/^A limit of S\$0 means nothing is recommended\./);
  else expect(budgetNote).toMatch(new RegExp(`^The plan will not go above ${escapeRegExp(dollars(budget))}\\.`));
  expect(text(results.value('out_note_minSavingRate'), 'note beside the minimum rate')).toMatch(
    input.preferences.minSavingRate === 0 ? /^Any saving counts/ : /^The plan only uses dollars that each save at least [\d.]+% in tax\./,
  );
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
  'NOT',
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
  'COUNT',
  'COUNTIF',
  'ISNUMBER',
  'N',
  'ROW',
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

/** A small XML reader, enough for the chart parts this project writes: element names and their children, in order. */
interface XmlNode {
  name: string;
  attributes: string;
  children: XmlNode[];
}

function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', attributes: '', children: [] };
  const stack: XmlNode[] = [root];
  for (const match of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g)) {
    const [, closing, name, attributes, selfClosing] = match;
    const parent = stack[stack.length - 1];
    if (!parent || !name) throw new Error('Malformed XML');
    if (closing) {
      if (parent.name !== name) throw new Error(`Malformed XML: </${name}> closes <${parent.name}>`);
      stack.pop();
      continue;
    }
    const node: XmlNode = { name, attributes: attributes ?? '', children: [] };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error('Malformed XML: unclosed element');
  return root;
}

function* walk(node: XmlNode): Generator<XmlNode> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

/** Child order the file format (ECMA-376, DrawingML charts) requires for the elements the chart part uses. */
const CHART_CHILD_ORDER: Record<string, string[]> = {
  'c:chartSpace': ['c:date1904', 'c:lang', 'c:roundedCorners', 'c:style', 'c:clrMapOvr', 'c:pivotSource', 'c:protection', 'c:chart', 'c:spPr', 'c:txPr', 'c:externalData', 'c:printSettings', 'c:userShapes', 'c:extLst'],
  'c:chart': ['c:title', 'c:autoTitleDeleted', 'c:pivotFmts', 'c:view3D', 'c:floor', 'c:sideWall', 'c:backWall', 'c:plotArea', 'c:legend', 'c:plotVisOnly', 'c:dispBlanksAs', 'c:extLst'],
  'c:plotArea': ['c:layout', 'c:scatterChart', 'c:valAx', 'c:dTable', 'c:spPr', 'c:extLst'],
  'c:scatterChart': ['c:scatterStyle', 'c:varyColors', 'c:ser', 'c:dLbls', 'c:axId', 'c:extLst'],
  'c:ser': ['c:idx', 'c:order', 'c:tx', 'c:spPr', 'c:marker', 'c:dPt', 'c:dLbls', 'c:trendline', 'c:errBars', 'c:xVal', 'c:yVal', 'c:smooth', 'c:extLst'],
  'c:valAx': ['c:axId', 'c:scaling', 'c:delete', 'c:axPos', 'c:majorGridlines', 'c:minorGridlines', 'c:title', 'c:numFmt', 'c:majorTickMark', 'c:minorTickMark', 'c:tickLblPos', 'c:spPr', 'c:txPr', 'c:crossAx', 'c:crosses', 'c:crossesAt', 'c:crossBetween', 'c:majorUnit', 'c:minorUnit', 'c:dispUnits', 'c:extLst'],
  'c:title': ['c:tx', 'c:layout', 'c:overlay', 'c:spPr', 'c:txPr'],
  'c:legend': ['c:legendPos', 'c:legendEntry', 'c:layout', 'c:overlay', 'c:spPr', 'c:txPr'],
  'c:scaling': ['c:logBase', 'c:orientation', 'c:max', 'c:min'],
  'c:dLbls': ['c:dLbl', 'c:delete', 'c:numFmt', 'c:spPr', 'c:txPr', 'c:dLblPos', 'c:showLegendKey', 'c:showVal', 'c:showCatName', 'c:showSerName', 'c:showPercent', 'c:showBubbleSize', 'c:separator', 'c:showLeaderLines'],
  'c:marker': ['c:symbol', 'c:size', 'c:spPr'],
  'c:numRef': ['c:f', 'c:numCache', 'c:extLst'],
  'c:strRef': ['c:f', 'c:strCache', 'c:extLst'],
  'c:rich': ['a:bodyPr', 'a:lstStyle', 'a:p'],
  'c:txPr': ['a:bodyPr', 'a:lstStyle', 'a:p'],
  'c:spPr': ['a:xfrm', 'a:custGeom', 'a:prstGeom', 'a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill', 'a:ln', 'a:effectLst'],
  'a:ln': ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:pattFill', 'a:prstDash', 'a:custDash', 'a:round', 'a:bevel', 'a:miter', 'a:headEnd', 'a:tailEnd'],
  'a:p': ['a:pPr', 'a:r', 'a:endParaRPr'],
  'a:defRPr': ['a:ln', 'a:noFill', 'a:solidFill', 'a:latin', 'a:ea', 'a:cs'],
  'a:rPr': ['a:ln', 'a:noFill', 'a:solidFill', 'a:latin', 'a:ea', 'a:cs'],
};

/** Fails if any element has a child the format does not list for it, or children out of the required order. */
function expectChartOrder(xml: string): void {
  let checked = 0;
  for (const node of walk(parseXml(xml))) {
    const order = CHART_CHILD_ORDER[node.name];
    if (!order) continue;
    checked++;
    const positions = node.children.map((child) => order.indexOf(child.name));
    expect(positions.includes(-1), `<${node.name}> has only children the format allows: ${node.children.map((child) => child.name).join(', ')}`).toBe(false);
    expect(positions, `children of <${node.name}> are in the order the format requires`).toEqual([...positions].sort((a, b) => a - b));
  }
  expect(checked).toBeGreaterThan(20);
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
    for (const name of [...Object.keys(map.outputs), ...Object.keys(map.rules)]) {
      expect(/^(out|rule)_/.test(name)).toBe(true);
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
      // MAX / MIN of an array expression needs array evaluation, which the applications do not all do alike:
      // such limits are taken over a helper column instead.
      expect(bare, `${where} must not rely on array evaluation inside MAX or MIN`).not.toMatch(/SUMPRODUCT\((MAX|MIN)\(/);
      expect(bare, `${where} must not compare or multiply inside MAX or MIN`).not.toMatch(/\b(MAX|MIN)\(\(/);
    }
    const unexpected = [...used].filter((name) => !ALLOWED_FUNCTIONS.has(name));
    expect(unexpected, 'functions outside the allowed list').toEqual([]);
  });

  it('stays inside the file-format limits that make Excel "repair" a workbook', async () => {
    const workbook = await buildWorkbook(2026);
    for (const ws of workbook.worksheets) {
      expect(ws.name.length, `sheet name ${ws.name}`).toBeLessThanOrEqual(31);
      const validations = (ws as unknown as { dataValidations: { model: Record<string, ExcelJS.DataValidation> } }).dataValidations.model;
      for (const [address, validation] of Object.entries(validations)) {
        const where = `${ws.name}!${address}`;
        expect((validation.promptTitle ?? '').length, `${where} prompt title`).toBeLessThanOrEqual(32);
        expect((validation.errorTitle ?? '').length, `${where} error title`).toBeLessThanOrEqual(32);
        expect((validation.prompt ?? '').length, `${where} prompt`).toBeLessThanOrEqual(255);
        expect((validation.error ?? '').length, `${where} error message`).toBeLessThanOrEqual(255);
        for (const formula of validation.formulae ?? []) {
          if (typeof formula === 'string') expect(formula.length, `${where} validation source`).toBeLessThanOrEqual(255);
        }
      }
      ws.eachRow({ includeEmpty: false }, (row) => {
        expect(row.height ?? 15, `${ws.name} row ${row.number} height`).toBeLessThanOrEqual(409);
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (typeof cell.value === 'string') expect(cell.value.length, `${ws.name}!${cell.address} text`).toBeLessThan(32_767);
        });
      });
    }
    const built = await buildWorkbookWithMap(2026);
    const names = [...INPUT_NAMES, ...Object.keys(built.map.outputs), ...Object.keys(built.map.rules)];
    for (const name of names) {
      // A defined name must not look like a cell reference (A1 or R1C1 style) and has no spaces.
      expect(name, `defined name ${name}`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(name, `defined name ${name}`).not.toMatch(/^[A-Za-z]{1,3}\d+$/);
      expect(name.length).toBeLessThanOrEqual(255);
    }
  });

  it('offers the minimum rate as plain percentages, so a dropdown choice is the number it shows', async () => {
    const { workbook, map } = await buildWorkbookWithMap(2026);
    const location = map.inputs.in_minSavingRate;
    const cell = workbook.getWorksheet(location.sheet)?.getCell(location.ref.replace(/\$/g, ''));
    const validation = cell?.dataValidation;
    expect(validation?.type).toBe('list');
    // A rate that is not in the list can still be typed (SPEC §8.3 "or a custom minimum").
    expect(validation?.errorStyle).toBe('warning');
    expect(validation?.prompt ?? '').not.toMatch(/sensible|\d+(\.\d+)?%\s+is/);
    const source = String(validation?.formulae?.[0] ?? '');
    const match = /^Rules!\$([A-Z]+)\$(\d+):\$[A-Z]+\$(\d+)$/.exec(source);
    expect(match, `list source ${source}`).not.toBeNull();
    const rules = workbook.getWorksheet(SHEETS.rules);
    const [, column, top, bottom] = match ?? [];
    const rates: unknown[] = [];
    for (let row = Number(top); row <= Number(bottom); row++) {
      const item = rules?.getCell(`${column ?? ''}${row}`);
      // No text hidden in the number format: what the list shows parses back to the value it holds.
      expect(item?.numFmt, `list item in row ${row}`).toBe('0.0%');
      rates.push(item?.formula ? 'formula' : item?.value);
    }
    expect(rates[0]).toBe(0);
    expect(rates.length).toBe(getRules(2026).taxBrackets.length);
    expect(rates.slice(1).every((rate) => rate === 'formula'), 'the other choices follow the tax table').toBe(true);
  });

  it('keeps the tax table safe to extend: every grey cell finds its neighbours from its own position', async () => {
    const { workbook, map } = await buildWorkbookWithMap(2026);
    const rules = workbook.getWorksheet(SHEETS.rules);
    const from = parseRef(map.rules.rule_bracketFrom.ref);
    const count = getRules(2026).taxBrackets.length;
    // The named ranges run one row past the last bracket, to the grey end line, so a row inserted after the
    // last bracket is still inside them.
    expect(from.bottom - from.top).toBe(count);
    for (const offset of [2, 3, 4]) {
      const column = colLetters(from.col + offset);
      // Apart from its own row number, the formula is the same text in every row (so it can be copied from any row).
      const shapes = new Set<string>();
      for (let row = from.top; row < from.bottom; row++) {
        const formula = rules?.getCell(`${column}${row}`).formula ?? '';
        expect(formula, `${column}${row}`).not.toBe('');
        // No reference to a neighbouring row by address: only to its own row and to absolute ranges.
        const relative = [...formula.matchAll(/(?<![$A-Z])([A-Z]{1,2})(\d+)\b/g)].map((reference) => Number(reference[2]));
        expect(relative.every((referenced) => referenced === row), `${column}${row} refers only to its own row: ${formula}`).toBe(true);
        shapes.add(formula.replace(new RegExp(`(?<![$A-Z0-9])([A-Z]{1,2})${row}\\b`, 'g'), '$1#'));
      }
      expect(shapes.size, `column ${column} has one formula for every row`).toBe(1);
      expect(rules?.getCell(`${column}${from.bottom}`).value ?? null, 'the end line holds no value').toBeNull();
    }
    // The other sheets have room for more brackets than the year starts with.
    expect(map.sizes.bracketRows).toBe(bracketCapacity(count));
    expect(map.sizes.bracketRows).toBeGreaterThanOrEqual(count + 5);
    expect(map.sizes.ladderRows).toBe(map.sizes.bracketRows + 2);
    // The deadline follows the income year unless it is typed over.
    const deadline = parseRef(map.rules.rule_deadline.ref);
    expect(rules?.getCell(deadline.top, deadline.col).formula).toMatch(/^DATE\(\$[A-Z]+\$\d+,12,31\)$/);
  });

  it('sizes the simulator so the smallest step reaches the largest room the rules allow', async () => {
    for (const year of [2025, 2026, 2027]) {
      const rules = getRules(year);
      const { map } = await buildWorkbookWithMap(year);
      expect(map.sizes.simulatorSteps).toBe(simulatorSteps(rules));
      expect(map.sizes.simulatorSteps * 100).toBeGreaterThanOrEqual(Math.max(rules.srs.capForeigner, rules.srs.capCitizenPr + rules.cpfTopUp.selfReliefCap + rules.cpfTopUp.familyReliefCap));
    }
  });

  it('adds the savings ladder as a real chart, with parts in the order the file format requires', async () => {
    const built = await buildWorkbookWithMap(2026);
    expect(built.charts.length).toBe(1);
    const spec = built.charts[0];
    if (!spec) return;
    expect(spec.sheet).toBe(SHEETS.ladder);
    // The series read the chart-point columns that the parity test checks against the engine.
    const reference = (name: string): string => `${built.map.outputs[name]?.sheet}!${built.map.outputs[name]?.ref}`;
    // The whole ladder first (its x column is the one an application with a single x column would use), then the plan.
    expect(spec.series.map((series) => series.xRef)).toEqual([reference('out_chart_x'), reference('out_chart_planX')]);
    expect(spec.series.map((series) => series.yRef)).toEqual([reference('out_chart_all'), reference('out_chart_plan')]);
    const xml = chartXml(spec);
    expectChartOrder(xml);
    expect(xml).not.toMatch(/Cache>/); // no stale cached values: each application reads the cells

    const zip = await JSZip.loadAsync(await workbookBuffer(built));
    const part = async (path: string): Promise<string> => (await zip.file(path)?.async('string')) ?? '';
    expect(await part('xl/charts/chart1.xml')).toBe(xml);
    expect(await part('xl/drawings/drawing1.xml')).toContain('r:id="rId1"');
    expect(await part('xl/drawings/_rels/drawing1.xml.rels')).toContain('Target="../charts/chart1.xml"');
    const types = await part('[Content_Types].xml');
    expect(types).toContain('<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>');
    expect(types).toContain('<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>');
    // Exactly one sheet carries the drawing, and it is the Ladder; <drawing> sits where the format wants it.
    const workbookXml = await part('xl/workbook.xml');
    const sheetFiles = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
    const withDrawing: string[] = [];
    for (const file of sheetFiles) {
      const sheetXml = await part(file);
      if (!/<drawing\b/.test(sheetXml)) continue;
      withDrawing.push(file);
      const order = ['<sheetData', '<sheetProtection', '<mergeCells', '<conditionalFormatting', '<dataValidations', '<pageMargins', '<pageSetup', '<headerFooter', '<drawing', '<tableParts', '<extLst']
        .map((tag) => sheetXml.indexOf(tag))
        .filter((index) => index >= 0);
      expect(order, `${file}: elements in the order the format requires`).toEqual([...order].sort((a, b) => a - b));
      const rels = await part(file.replace(/([^/]+)$/, '_rels/$1.rels'));
      expect(rels).toContain('Target="../drawings/drawing1.xml"');
    }
    expect(withDrawing.length).toBe(1);
    expect(workbookXml).toContain(`name="${SHEETS.ladder}"`);
    // ExcelJS (used to read results back) still opens the file with its chart.
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load((await workbookBuffer(built)) as unknown as ExcelJS.Buffer);
    expect(reread.worksheets.map((ws) => ws.name)).toEqual(Object.values(SHEETS));
  });
});

describe('the shipped release workbook', () => {
  const file = join(ROOT, 'release', releaseFileName(2026));

  it('is the workbook a fresh build produces (run "npm run build:workbook" after changing the generator)', async () => {
    expect(existsSync(file), `${file} exists`).toBe(true);
    const shipped = new ExcelJS.Workbook();
    await shipped.xlsx.readFile(file);
    const fresh = await buildWorkbookWithMap(2026);
    expect(shipped.worksheets.map((ws) => ws.name)).toEqual(fresh.workbook.worksheets.map((ws) => ws.name));

    const freshFormulas = formulasOf(fresh.workbook);
    const shippedFormulas = new Map(formulasOf(shipped).map((entry) => [entry.where, entry.formula]));
    expect(shippedFormulas.size, 'number of formulas').toBe(freshFormulas.length);
    const different = freshFormulas.filter((entry) => shippedFormulas.get(entry.where) !== entry.formula).map((entry) => entry.where);
    expect(different, 'formulas that differ from a fresh build').toEqual([]);

    // Typed-in values (inputs, rule values, labels) are the same too.
    const constants: string[] = [];
    for (const ws of fresh.workbook.worksheets) {
      const other = shipped.getWorksheet(ws.name);
      ws.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (cell.formula || cell.value === null || typeof cell.value === 'object') return;
          const theirs = other?.getCell(cell.address).value ?? null;
          if (theirs !== cell.value) constants.push(`${ws.name}!${cell.address}`);
        });
      });
    }
    expect(constants, 'typed-in values that differ from a fresh build').toEqual([]);
    for (const name of [...INPUT_NAMES, ...Object.keys(fresh.map.outputs), ...Object.keys(fresh.map.rules)]) {
      expect(shipped.definedNames.getRanges(name).ranges, `defined name ${name}`).toEqual(fresh.workbook.definedNames.getRanges(name).ranges);
    }
  });

  it('carries the chart, no macros and no links to other files', async () => {
    const zip = await JSZip.loadAsync(readFileSync(file));
    const names = Object.keys(zip.files);
    const fresh = await buildWorkbookWithMap(2026);
    const spec = fresh.charts[0];
    expect(spec).toBeDefined();
    if (spec) expect(await zip.file('xl/charts/chart1.xml')?.async('string')).toBe(chartXml(spec));
    expect(names.some((name) => /vbaProject|externalLink|activeX|embeddings/i.test(name)), 'macros, external links or embedded objects').toBe(false);
    expect(await zip.file('xl/workbook.xml')?.async('string')).toContain('fullCalcOnLoad="1"');
  });

  it('shows the worked example of SPEC A.1 before any recalculation, when it was built with LibreOffice available', async () => {
    const shipped = new ExcelJS.Workbook();
    await shipped.xlsx.readFile(file);
    const results = new Results(shipped);
    if (results.value('out_taxSaved') === null) {
      console.warn('[workbook] The release file has no cached results (built without LibreOffice); it calculates when opened.');
      return;
    }
    expect(results.value('out_srs')).toBe(15_300);
    expect(results.value('out_cpfSelf')).toBe(8_000);
    expect(results.value('out_taxBefore')).toBe(6_639);
    expect(results.value('out_taxAfter')).toBe(3_959.5);
    expect(results.value('out_taxSaved')).toBe(2_679.5);
    expect(results.value('out_bindingConstraint')).toBe('leverLimits');
    expect(String(results.value('out_plannerBanner'))).toMatch(/^EXAMPLE SHOWN — /);
    expect(results.errors()).toEqual([]);
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

type PlanFor = (input: PlannerInput, rules: YearRules) => PlannerResult;

/**
 * The engine entry point that takes explicit rules is internal (not part of SPEC §7), so it is loaded loosely:
 * if it is ever renamed, only the profiles with edited rules lose their engine comparison.
 */
async function loadPlanFor(): Promise<PlanFor | undefined> {
  try {
    const internalModule = '../src/engine/plan';
    const internal = (await import(/* @vite-ignore */ internalModule)) as { planFor?: unknown };
    if (typeof internal.planFor === 'function') return internal.planFor as PlanFor;
  } catch {
    // fall through
  }
  console.warn(
    '[workbook parity] src/engine/plan.ts does not export planFor(sanitisedInput, rules): the edited-rules profiles ' +
      'are recalculated and checked for errors, but not compared with the engine.',
  );
  return undefined;
}

describe.skipIf(!soffice)('workbook parity with the engine (LibreOffice recalculation)', () => {
  const workDir = join(ROOT, '.tmp', `workbook-test-${process.pid}-${Date.now()}`);
  const loaded = new Map<string, Results>();
  const expectedByName = new Map<string, PlannerResult>();
  /** Edited-rules profiles that could not be given an engine result (see below). */
  const withoutEngineResult = new Set<string>();

  beforeAll(async () => {
    const inDir = join(workDir, 'in');
    const outDir = join(workDir, 'out');
    mkdirSync(inDir, { recursive: true });
    const planFor = await loadPlanFor();

    // One workbook per income year / rule set; each profile is written into it and saved as its own copy.
    // A profile that types over the Rules sheet gets a workbook of its own.
    const builds = new Map<string, BuiltWorkbook>();
    const files: string[] = [];
    for (const [index, profile] of PROFILES.entries()) {
      const rules = profile.rules ? CUSTOM_RULES[profile.rules] : undefined;
      let built: BuiltWorkbook | undefined;
      if (profile.edit) {
        built = await buildWorkbookWithMap(profile.editBase ?? 2026);
        profile.edit(ruleSetter(built));
      } else {
        const key = profile.rules ?? String(profile.input.incomeYear);
        built = builds.get(key);
        if (!built) {
          built = await buildWorkbookWithMap(profile.input.incomeYear, rules ? { rules } : {});
          builds.set(key, built);
        }
      }
      writeInputs(built, profile.input, profile.raw);
      const file = join(inDir, `profile-${String(index).padStart(3, '0')}.xlsx`);
      await built.workbook.xlsx.writeFile(file);
      files.push(file);
      if (profile.compare === false) continue;
      if (!rules) expectedByName.set(profile.name, plan(profile.input));
      else if (planFor) expectedByName.set(profile.name, planFor(sanitiseInput(profile.input), rules));
      else withoutEngineResult.add(profile.name);
    }

    // Every copy is recalculated by LibreOffice: a few processes side by side, each with a private profile directory.
    const recalculated = await recalculateParallel(files, { outDir, profileDir: join(workDir, 'lo-profile'), timeoutMs: 540_000 });
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
      // A deliberately broken tax table may produce anything; those profiles are checked for their warning instead.
      if (profile.compare === false) continue;
      for (const error of loaded.get(profile.name)?.errors() ?? ['not recalculated']) errors.push(`${profile.name}: ${error}`);
    }
    expect(errors).toEqual([]);
  });

  for (const profile of PROFILES) {
    const { name } = profile;
    if (profile.compare === false) continue;
    it(name, (context) => {
      const results = loaded.get(name);
      const expected = expectedByName.get(name);
      expect(results, 'recalculated workbook').toBeDefined();
      if (withoutEngineResult.has(name)) {
        context.skip();
        return;
      }
      expect(expected, 'engine result').toBeDefined();
      if (results && expected) assertParity(results, expected, profile.checks ? { checks: profile.checks } : {});
    });
  }

  it('every boundary the review found unguarded is exercised by a profile', () => {
    const result = (name: string): PlannerResult => {
      const found = expectedByName.get(name);
      if (!found) throw new Error(`No engine result for "${name}"`);
      return found;
    };
    const U = (name: string): Scalar => loaded.get(name)?.value('out_usefulRoom') ?? null;
    // Ties between limits, resolved in the order minimum rate, relief cap, scheme room, cash.
    const tie = (name: string, binding: string, equal: [string, string]): void => {
      const r = loaded.get(name);
      expect(result(name).plan.bindingConstraint, name).toBe(binding);
      const value = (key: string): Scalar =>
        key === 'B' ? (result(name).input.preferences.cashBudget ?? null) : (r?.value(key === 'U' ? 'out_usefulRoom' : key === 'C' ? 'out_reliefCapRoom' : 'out_leverRoom') ?? null);
      expect(value(equal[0]), `${name}: ${equal[0]} = ${equal[1]}`).toBe(value(equal[1]));
      expect(value(equal[0])).toBe(result(name).plan.totalContribution);
    };
    tie('U equals C (tie between minimum rate and relief cap)', 'usefulRoom', ['U', 'C']);
    tie('U equals L (tie between minimum rate and scheme room)', 'usefulRoom', ['U', 'L']);
    tie('C equals L (tie between relief cap and scheme room)', 'reliefCap', ['C', 'L']);
    tie('Budget equals L (tie between scheme room and cash)', 'leverLimits', ['L', 'B']);
    tie('U equals C equals B (three-way tie)', 'usefulRoom', ['U', 'B']);
    tie('Budget 0 and nothing switched on (L = B = 0)', 'leverLimits', ['L', 'B']);
    // One dollar either side of a bracket edge.
    expect(U('CI exactly 80,000, minimum 11.5% (U = 0)')).toBe(0);
    expect(U('CI 80,001, minimum 11.5% (U = 1)')).toBe(1);
    expect(U('CI exactly 120,000, minimum 15% (U = 0)')).toBe(0);
    expect(U('CI 120,001, minimum 15% (U = 1)')).toBe(1);
    expect(U('CI exactly 1,000,000, minimum 24% (U = 0)')).toBe(0);
    expect(U('CI 1,000,001, minimum 24% (U = 1)')).toBe(1);
    // CPF: nothing at exactly 500, the phase-in from 501.
    expect(result('Wage exactly 500 (no employee share)').cpf.employeeContribution).toBe(200);
    expect(result('Wage 501 (phase-in starts)').cpf.employeeContribution).toBe(200);
    expect(loaded.get('Wage exactly 500 (no employee share)')?.value('out_employeeCpf')).toBe(200);
    // SRS opens at exactly the minimum age; months worked never fall below 1.
    expect(result('Age 18 citizen (SRS just open)').levers.srs.eligible).toBe(true);
    expect(result('Age 17 citizen, everything switched on (no SRS, CPF open)').levers.srs.eligible).toBe(false);
    expect(result('RAW months worked 0 (counts as 1)').baseline.employmentIncome).toBe(10_000 + 15_000);
    // Warnings that must NOT fire.
    const codes = (name: string): string[] => result(name).warnings.map((warning) => warning.code);
    expect(codes('Foreigner aged 60, everything switched on, CPF figure above the maximum')).not.toContain('AGE_55_PLUS_TOPUP');
    expect(codes('Foreigner aged 60, everything switched on, CPF figure above the maximum')).not.toContain('CPF_OVERRIDE_ABOVE_MAX');
    expect(codes('Foreigner with existing CPF top-ups above the caps (not open to them, so no warning)')).not.toContain('EXISTING_EXCEEDS_CAP');
    expect(codes('As at 31 December with nothing switched on (no deadline warning)')).not.toContain('DEADLINE_SOON');
    // TRUE in a number cell is the 1 LibreOffice shows for it, no more.
    expect(loaded.get('RAW TRUE in the bonus cell (LibreOffice stores and shows it as 1)')?.value('out_employmentIncome')).toBe(120_001);
    // The simulator reaches the maximum contribution at the smallest step.
    const reaches = (name: string, steps: number, room: number): void => {
      expect(result(name).simulator.length, name).toBe(steps + 1);
      expect(loaded.get(name)?.column('out_sim_contribution')[steps], name).toBe(room);
    };
    reaches('Simulator: L 12,001 at step 100 (was cut off)', 121, 12_001);
    reaches('RAW simulator step 0', 233, 23_300);
    reaches('Simulator: foreigner, L 35,700 at step 100 (357 steps)', 357, 35_700);
  });

  it('words the awkward cases as the review asked', () => {
    const lines = (name: string): string[] => (loaded.get(name)?.column('out_warnings') ?? []).filter((line) => line !== null).map(String);
    const value = (name: string, key: string): string => String(loaded.get(name)?.value(key));
    // The deadline day: no "Only 0 days left".
    expect(value('As at 31 December (the deadline)', 'out_monthlyBanner')).toMatch(/^Today is the deadline\./);
    expect(lines('As at 31 December (the deadline)').join('\n')).toContain('Check — today, 31 December 2026, is the deadline.');
    expect(lines('As at 31 December (the deadline)').join('\n')).not.toMatch(/0 days/);
    // Several schemes over their caps: one sentence each, each on a line of its own.
    expect(lines('Existing contributions one dollar over every cap').filter((line) => line.includes('already put'))).toEqual([
      'Check — you have already put S$15,301 into SRS this year, but only S$15,300 a year earns tax relief; the extra S$1 earns none.',
      'Check — you have already put S$8,001 into your own CPF as cash top-ups this year, but only S$8,000 a year earns tax relief; the extra S$1 earns none.',
      "Check — you have already put S$8,001 into family members' CPF as cash top-ups this year, but only S$8,000 a year earns tax relief; the extra S$1 earns none.",
    ]);
    // No line is longer than the two rows of text a Planner line has room for.
    for (const profile of PROFILES) {
      for (const line of lines(profile.name)) expect(line.length, `${profile.name}: ${line}`).toBeLessThanOrEqual(245);
    }
    // Nothing switched on, and nothing open to the user, are not "no room left".
    expect(value('Nothing switched on', 'out_reason')).toMatch(/^No scheme is switched on/);
    expect(lines('Nothing switched on').join('\n')).toMatch(/Note — no scheme is switched on, so nothing can be contributed\. Switching on the schemes you left off could save up to S\$[\d,.]+ more tax\./);
    const young = 'Foreigner aged 17: nothing open to them';
    expect(value(young, 'out_reason')).toMatch(/^None of the schemes you switched on is open to you/);
    expect(lines(young).join('\n')).toContain('Note — none of the schemes you switched on is open to you, so nothing can be contributed.');
    // …and a foreigner too young for SRS is not told they can put money into SRS.
    expect(lines(young).join('\n')).toContain('Check — you must be at least 18 to contribute to SRS');
    expect(lines(young).join('\n')).not.toMatch(/You can put up to/);
    // …nor shown a cap beside a scheme that is not open to them.
    expect(value(young, 'out_note_useSrs')).toBe('Not open to you: you must be at least 18 to contribute to SRS.');
    expect(value(young, 'out_note_useCpfSelf')).toMatch(/^Not open to you: CPF top-ups are for Singapore Citizens and Permanent Residents\./);
    expect(value(young, 'out_note_useCpfFamily')).toMatch(/^Not open to you: /);
    expect(value('A.1 opening example', 'out_note_useSrs')).toMatch(/^Up to S\$15,300 a year\./);
    expect(value('Foreigner, all schemes switched on', 'out_note_useSrs')).toMatch(/^Up to S\$35,700 a year\./);
    expect(lines('Foreigner, all schemes switched on').join('\n')).toMatch(/You can put up to S\$35,700 a year into SRS\./);
    // A 0 in an optional cell is a figure, and the Planner says so beside the cell.
    expect(value('CPF figure of 0 (counts as a figure, not as blank)', 'out_note_cpfOverride')).toBe('Using your figure of S$0 instead of the worked-out S$20,400. Clear the cell to go back.');
    expect(value('Cash budget of zero', 'out_note_cashBudget')).toBe('A limit of S$0 means nothing is recommended. Clear the cell for no limit.');
    // Why the recommended plan stops, on the Scenarios sheet.
    const comment = (name: string): string => String(loaded.get(name)?.column('out_scen_comment')[SCENARIO_IDS.indexOf('recommended')]);
    expect(comment('A.1 opening example')).toBe('Uses all the room in the schemes you switched on. Never includes a wasted dollar.');
    expect(comment('A.2 older PR with a budget and the relief cap in play')).toBe('Stops at your cash limit. Never includes a wasted dollar.');
    expect(comment('Relief cap binds the plan')).toBe('Stops at the overall relief cap. Never includes a wasted dollar.');
  });

  it('follows the income year when it is typed over, and says so when the deadline is left behind', () => {
    const followed = loaded.get('Typed on Rules: income year 2027 (the deadline follows the year)');
    const deadline = followed?.value('out_deadline');
    expect(deadline instanceof Date ? deadline.toISOString().slice(0, 10) : deadline).toBe('2027-12-31');
    expect(followed?.column('out_workbookCheckFlags')).toEqual([0, 0]);
    expect(String(followed?.value('out_monthlyBanner'))).toMatch(/^Set aside the amounts below in each of the 2 months left/);

    const stale = loaded.get("Typed on Rules: income year 2027 with last year's deadline typed in (check line)");
    const first = String(stale?.column('out_warnings')[0]);
    expect(first).toBe(
      'Check — the last contribution day on the Rules sheet (31 December 2026) is not in income year 2027. Correct it there: it is normally 31 December of the income year. The days left and the deadline messages depend on it.',
    );
    expect(String(stale?.value('out_plannerBanner'))).toMatch(/^CHECK THE RULES SHEET FIRST/);
    // The banner over the instalments no longer says "no instalments are shown" above a list of instalments.
    expect(String(stale?.value('out_monthlyBanner'))).toMatch(/^The deadline for 2027 passed on 31 December 2026\. The amounts below are listed only because the year has not ended/);
    expect(stale?.column('out_sched_total').filter((total) => total !== null).length).toBe(2);

    const cleared = loaded.get('Typed on Rules: the deadline cleared (31 December is used, with a check line)');
    expect(String(cleared?.column('out_warnings')[0])).toMatch(/^Check — the last contribution day on the Rules sheet \(not a date\) is not in income year 2026\./);
  });

  it('flags a tax table that is out of order or incomplete, on the Rules sheet and at the top of the Planner', () => {
    for (const [name, issue] of [
      ['Typed on Rules: two brackets out of order (check line)', /^the brackets must start at 0 and rise from row to row/],
      ['Typed on Rules: a bracket rate cleared (check line)', /^every bracket needs a start and a rate/],
    ] as const) {
      const r = loaded.get(name);
      expect(r, name).toBeDefined();
      expect(r?.column('out_workbookCheckFlags'), name).toEqual([1, 0]);
      expect(String(r?.value('out_rulesIssue')), name).toMatch(issue);
      expect(String(r?.value('rule_bracketCheck')), name).toMatch(/^Check: /);
      expect(String(r?.value('out_plannerBanner')), name).toMatch(/^CHECK THE RULES SHEET FIRST/);
      expect(String(r?.column('out_warnings')[0]), name).toMatch(/^Check — the tax table on the Rules sheet needs fixing: .* Until it is fixed, the figures on every sheet may be wrong\.$/);
    }
    // In order: the Rules sheet says OK and counts its brackets.
    const stock = loaded.get('A.1 opening example');
    expect(stock?.value('rule_bracketCheck')).toBe('OK');
    expect(stock?.value('rule_bracketCount')).toBe(getRules(2026).taxBrackets.length);
  });

  it('merges neighbouring brackets with the same rate into one rung, as the engine does', () => {
    const expected = expectedByName.get('Odd tax table: every rung, any saving');
    const r = loaded.get('Odd tax table: every rung, any saving');
    if (!expected || !r) return; // planFor not available: reported above
    const rates = r.column('out_ladder_rate').filter((rate) => rate !== null);
    expect(rates).toEqual(expected.ladder.map((tier) => tier.rate));
    // The 3% brackets from 10,000 and 20,000 are one rung, and the tax-free band in the middle is labelled.
    const below = expectedByName.get('Odd tax table: chargeable income below the room');
    expect(below?.ladder.some((tier) => tier.rate === 0.03 && tier.amount > 10_000) || below?.ladder.some((tier) => tier.rate === 0.01), 'profile reaches the low brackets').toBe(true);
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
    expect(r.value('out_reason')).toBe('You have used all the room in the schemes you switched on. S$5,300 of your income is still taxed at 11.5%.');
    // 31,300 of room with family top-ups switched on as well: chargeable income 77,300, tax 3,161.00.
    expect(r.value('out_savingIfSwitchedOn')).toBe(798.5);
    expect(r.column('out_warnings').filter((v) => v !== null)).toEqual([
      'Note — the plan uses all S$23,300 of room left in the schemes you switched on. Switching on the schemes you left off could save up to S$798.50 more tax.',
    ]);
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

// ---------------------------------------------------------------------------------------------------------------
// Rows inserted and removed on the Rules sheet, done in LibreOffice as a person would
// ---------------------------------------------------------------------------------------------------------------

/** LibreOffice's scripting bridge for Python (python3-uno), used to edit a workbook inside the application. */
const unoAvailable = Boolean(soffice) && spawnSync('python3', ['-c', 'import uno'], { encoding: 'utf8' }).status === 0;
if (soffice && !unoAvailable) {
  console.warn(
    '[workbook rows] SKIPPED: python3 cannot import "uno" (LibreOffice\'s scripting bridge), so inserting a tax-bracket row ' +
      'cannot be tried inside the application. Install python3-uno to run this test.',
  );
}

interface RowJob {
  name: string;
  input: PlannerInput;
  /** The tax table the engine is given (what the edits are meant to produce). */
  brackets?: (stock: YearRules['taxBrackets']) => YearRules['taxBrackets'];
  /** Operations for workbook/uno/edit_workbook.py, built from where the table is. */
  ops: (table: { sheet: string; first: number; end: number; from: string; rate: string; grey: [string, string] }) => Record<string, unknown>[];
  checks?: number[];
}

const ROW_JOBS: RowJob[] = [
  {
    // The review's own steps, which used to over-rate every bracket above the new row without any warning.
    name: 'a bracket inserted in the middle (100,000 at 13%), grey cells copied from the row above',
    input: make({ income: { monthlyOrdinaryWage: 15_000 } }),
    brackets: (stock) => [...stock.slice(0, 5), { from: 100_000, rate: 0.13 }, ...stock.slice(5)],
    ops: ({ sheet, first, from, rate, grey }) => [
      { op: 'insertRows', sheet, before: first + 5, count: 1 },
      { op: 'set', sheet, cell: `${from}${first + 5}`, value: 100_000 },
      { op: 'set', sheet, cell: `${rate}${first + 5}`, value: 0.13 },
      { op: 'copy', sheet, from: `${grey[0]}${first + 4}:${grey[1]}${first + 4}`, to: `${grey[0]}${first + 5}` },
    ],
  },
  {
    name: 'a new top bracket added just above the end line (2,000,000 at 26%), grey cells copied from the first bracket',
    input: make({
      income: { monthlyOrdinaryWage: 250_000, additionalWages: 100_000 },
      levers: ALL_ON,
      preferences: { minSavingRate: 0.26 },
    }),
    brackets: (stock) => [...stock, { from: 2_000_000, rate: 0.26 }],
    ops: ({ sheet, first, end, from, rate, grey }) => [
      { op: 'insertRows', sheet, before: end, count: 1 },
      { op: 'set', sheet, cell: `${from}${end}`, value: 2_000_000 },
      { op: 'set', sheet, cell: `${rate}${end}`, value: 0.26 },
      { op: 'copy', sheet, from: `${grey[0]}${first}:${grey[1]}${first}`, to: `${grey[0]}${end}` },
    ],
  },
  {
    name: 'a bracket row removed (the 19.5% bracket)',
    input: make({ income: { monthlyOrdinaryWage: 24_000, additionalWages: 40_000 }, levers: ALL_ON }),
    brackets: (stock) => stock.filter((bracket) => bracket.from !== 240_000),
    ops: ({ sheet, first }) => [{ op: 'removeRows', sheet, row: first + 8, count: 1 }],
  },
  {
    name: 'a bracket inserted without its grey formulas (flagged, not silently wrong)',
    input: make({ income: { monthlyOrdinaryWage: 15_000 } }),
    ops: ({ sheet, first, from, rate }) => [
      { op: 'insertRows', sheet, before: first + 5, count: 1 },
      { op: 'set', sheet, cell: `${from}${first + 5}`, value: 100_000 },
      { op: 'set', sheet, cell: `${rate}${first + 5}`, value: 0.13 },
    ],
    checks: [1, 0],
  },
  {
    name: 'a row inserted and left empty (flagged)',
    input: make(),
    ops: ({ sheet, first }) => [{ op: 'insertRows', sheet, before: first + 3, count: 1 }],
    checks: [1, 0],
  },
];

describe.skipIf(!unoAvailable)('rows inserted and removed in the tax table (edited inside LibreOffice)', () => {
  const workDir = join(ROOT, '.tmp', `workbook-rows-${process.pid}-${Date.now()}`);
  const loaded = new Map<string, Results>();
  const expectedByName = new Map<string, PlannerResult>();
  let planForAvailable = true;

  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true });
    const planFor = await loadPlanFor();
    planForAvailable = Boolean(planFor);
    const stock = getRules(2026);
    const jobs: { input: string; output: string; ops: Record<string, unknown>[] }[] = [];
    for (const [index, job] of ROW_JOBS.entries()) {
      // The file a buyer gets: stock rules, chart included.
      const built = await buildWorkbookWithMap(2026);
      writeInputs(built, job.input);
      const input = join(workDir, `rows-${index}-in.xlsx`);
      await writeWorkbook(built, input);
      const from = parseRef(built.map.rules.rule_bracketFrom.ref);
      const rate = parseRef(built.map.rules.rule_bracketRate.ref);
      const step = parseRef(built.map.rules.rule_bracketStep.ref);
      const table = {
        sheet: built.map.rules.rule_bracketFrom.sheet,
        first: from.top,
        end: from.bottom,
        from: colLetters(from.col),
        rate: colLetters(rate.col),
        // The three grey columns: "Up to", "Rate step" and "Tax at the start of the bracket".
        grey: [colLetters(step.col - 1), colLetters(step.col + 1)] as [string, string],
      };
      jobs.push({ input, output: join(workDir, `rows-${index}-out.xlsx`), ops: job.ops(table) });
      if (job.brackets && planFor) {
        expectedByName.set(job.name, planFor(sanitiseInput(job.input), { ...stock, taxBrackets: job.brackets(stock.taxBrackets) }));
      }
    }
    const spec = join(workDir, 'jobs.json');
    writeFileSync(spec, JSON.stringify({ profileDir: join(workDir, 'lo-profile'), jobs }));
    const run = spawnSync('python3', [join(ROOT, 'workbook', 'uno', 'edit_workbook.py'), spec], { encoding: 'utf8', timeout: 240_000 });
    if (run.status !== 0) throw new Error(`edit_workbook.py failed (status ${String(run.status)}): ${run.stderr || run.stdout}`);
    for (const [index, job] of ROW_JOBS.entries()) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(jobs[index]?.output ?? '');
      loaded.set(job.name, new Results(workbook));
    }
  }, 300_000);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  for (const job of ROW_JOBS) {
    it(job.name, (context) => {
      const results = loaded.get(job.name);
      expect(results, 'edited workbook').toBeDefined();
      if (!results) return;
      if (job.brackets) {
        // The table is in order and every sheet agrees with the engine run on the edited table.
        if (!planForAvailable) {
          context.skip();
          return;
        }
        const expected = expectedByName.get(job.name);
        expect(expected, 'engine result').toBeDefined();
        expect(results.errors()).toEqual([]);
        expect(results.value('rule_bracketCheck')).toBe('OK');
        expect(results.value('rule_bracketCount')).toBe(expected?.rules.taxBrackets.length);
        if (expected) assertParity(results, expected);
      } else {
        expect(results.column('out_workbookCheckFlags')).toEqual(job.checks);
        expect(String(results.value('rule_bracketCheck'))).toMatch(/^Check: /);
        expect(String(results.value('out_plannerBanner'))).toMatch(/^CHECK THE RULES SHEET FIRST/);
        expect(String(results.column('out_warnings')[0])).toMatch(/^Check — the tax table on the Rules sheet needs fixing: /);
      }
    });
  }

  it('gives the tax the review worked out by hand for its inserted bracket', () => {
    const r = loaded.get(ROW_JOBS[0]?.name ?? '');
    if (!r) return;
    // Chargeable income 168,600 on the 14-bracket table: 15,798.00 (it showed 16,527.00 before the fix).
    expect(r.value('out_ciBefore')).toBe(168_600);
    expect(r.value('out_taxBefore')).toBe(15_798);
    expect(r.value('out_marginalBefore')).toBeCloseTo(0.18, 12);
    const missing = loaded.get(ROW_JOBS[3]?.name ?? '');
    expect(String(missing?.value('out_rulesIssue'))).toMatch(/^a bracket row is missing its grey formulas/);
  });
});
