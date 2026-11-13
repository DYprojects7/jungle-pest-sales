/**
 * Workbook parity (SPEC §9, §10): the spreadsheet formulas must equal the engine.
 *
 * The test builds the workbook, writes a set of input profiles into copies, recalculates ALL copies with headless
 * LibreOffice (a few processes side by side), reads the results back through the workbook's named ranges (`out_*`) and compares
 * them with `plan()` — money to the cent, and the warning lines word for word. The Before You Transfer sheet is
 * compared, for every profile, with the engine's `lockUpFacts` and `transferCautions`, and the sentences the
 * Planner shares with the web page with the page's own functions. It is skipped, with a console message, when
 * `soffice` is not on PATH.
 *
 * It also checks the things only a workbook can get wrong: the shipped release file against a fresh build, the
 * chart added to the file, that no internal code is written on a sheet, that the file is the same byte for byte
 * when built twice, what happens when the Rules sheet is typed over, and — through LibreOffice's own scripting
 * interface — what happens when a row is inserted in or removed from the tax table.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISCLAIMER, NON_RESIDENT_SRS_COST, NOT_MODELLED, defaultInput, getRules, lockUpFacts, lockUpHorizon, plan, sanitiseInput, transferCautions } from '../src/engine/index';
import type { LeverId, PlannerInput, PlannerResult, PlannerWarning, YearRules } from '../src/engine/index';
// The web page's own split of a yearly salary: the workbook must split it "exactly as the page does" (SPEC §9);
// and its default for "How far down the ladder?", which the workbook's cell must start at for each residency.
import { defaultMinRate, monthlyWage, oddPay } from '../src/web/state';
import {
  BINDING_NUMBERS,
  CHART_LABEL_EVERY,
  CHART_STEPS,
  CPF_SOURCE_WORDS,
  DEFAULT_MIN_RATE,
  EXAMPLE,
  HORIZON_CHARS,
  HORIZON_ROWS,
  HORIZON_ROW_HEIGHT,
  INPUT_NAMES,
  LEVER_NAMES,
  MONTH_LABELS,
  NO,
  NO_LADDER,
  PRIORITY_PRESETS,
  PR_YEAR_LABELS,
  RESIDENCY_LABELS,
  SALARY_PERIODS,
  SCENARIO_IDS,
  SCENARIO_NAMES,
  SHEETS,
  WARNING_CODES,
  WARNING_LINES,
  WARNING_LINE_CHARS,
  WARNING_LINE_ROWS,
  WARNING_ROW_HEIGHT,
  WORKBOOK_CHECKS,
  WORKBOOK_VERSION,
  YES,
  ZERO_REASON_NUMBERS,
  messageRoom,
  bracketCapacity,
  buildWorkbook,
  buildWorkbookWithMap,
  chartXml,
  findSoffice,
  pinnedAsAt,
  recalculateParallel,
  releaseFileName,
  simulatorSteps,
  workbookBuffer,
  writeRelease,
  writeWorkbook,
} from '../workbook/build';
import type { BuiltWorkbook, InputName, RuleName } from '../workbook/build';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-11-13';
/** `npm run test:release`: nothing may be skipped or waved through (SPEC §10). */
const STRICT = process.env.SGTO_STRICT === '1';

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
  /**
   * Salary typed per year on the Planner, with the bonus typed beside it. `input` then holds what the web page
   * gives the engine for the same entries (see `yearly`).
   */
  perYear?: { salary: number; bonus: number };
  /**
   * True when the "Smallest tax saving per dollar" cell is left as the workbook opens with it: a formula that
   * follows the residency. `input` then holds the web page's default for that residency (see `untouched`).
   */
  untouchedMinimum?: boolean;
  /** True when the edits typed over the Rules sheet change a figure the Before You Transfer sheet quotes. */
  rulesChanged?: boolean;
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

/**
 * A profile whose salary is typed per year. The engine input is what the web page derives from the same entries
 * (src/web/state.ts): twelve equal whole-dollar months, the left-over dollars counted with the extra pay.
 */
function yearly(name: string, salary: number, bonus: number, overrides: Overrides = {}): Profile {
  const months = overrides.income?.monthsWorked;
  const ui = { payMode: 'annual' as const, salary, monthsWorked: typeof months === 'number' ? months : 12 };
  return {
    name,
    perYear: { salary, bonus },
    input: make({ ...overrides, income: { ...overrides.income, monthlyOrdinaryWage: monthlyWage(ui), additionalWages: bonus + oddPay(ui) } }),
  };
}

/**
 * A profile that leaves the minimum-saving cell as the workbook opens with it. The engine is given what the web
 * page starts with for the same residency (`defaultMinRate` in src/web/state.ts), so the two free-standing
 * products must give the same plan on default settings.
 */
function untouched(name: string, input: PlannerInput): Profile {
  return { name, untouchedMinimum: true, input: { ...input, preferences: { ...input.preferences, minSavingRate: defaultMinRate(input.profile.residency) } } };
}

/** A foreigner on S$7,000 a month with a S$7,000 bonus and no other reliefs (the rule audit's example). */
function foreigner(overrides: Overrides = {}): PlannerInput {
  return make({
    ...overrides,
    profile: { residency: 'foreigner', ageAtYearEnd: 32, ...overrides.profile },
    income: { monthlyOrdinaryWage: 7_000, additionalWages: 7_000, ...overrides.income },
    otherReliefs: 0,
  });
}

/** SPEC Appendix A.2: the older PR, with the room for their own CPF as given. */
function olderPr(roomToLimit: number | null | undefined, overrides: Overrides = {}): PlannerInput {
  return make({
    ...overrides,
    profile: { residency: 'pr', prYear: 3, ageAtYearEnd: 57, birthMonth: 6, ...overrides.profile },
    income: { monthlyOrdinaryWage: 14_000, additionalWages: 40_000, ...overrides.income },
    existing: { srs: 5_000, ...overrides.existing },
    otherReliefs: 30_000,
    levers: { srs: { enabled: true }, cpfSelf: { enabled: true, roomToLimit }, cpfFamily: { enabled: true, maxAmount: 8_000 }, ...overrides.levers },
    preferences: { cashBudget: 20_000, minSavingRate: 0, priority: INTEREST, ...overrides.preferences },
  });
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
  { name: 'A.2 older PR with a budget and the relief cap in play', input: olderPr(50_000) },
  { name: 'A.2b the same person with the CPF room left blank', input: olderPr(null) },
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
  { name: 'RAW text in monthly salary', input: make({ income: { monthlyOrdinaryWage: Number.NaN } }), raw: { in_salary: 'ten thousand' } },
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

  // ---- The safeguards from the rule audit (SPEC §6.5, §6.11) --------------------------------------------------
  // The room for the person's own CPF: blank is "not limiting" below 55 and "not confirmed" from 55.
  ...[54, 55, 57].flatMap((age) =>
    ([undefined, 0, 3_000, 50_000] as const).map(
      (room): Profile => ({
        name: `Age ${age}, own CPF room ${room === undefined ? 'blank' : room.toLocaleString('en-US')}`,
        input: make({
          profile: { ageAtYearEnd: age, birthMonth: 3 },
          income: { monthlyOrdinaryWage: 12_000, additionalWages: 24_000 },
          levers: { ...ALL_ON, cpfSelf: { enabled: true, roomToLimit: room } },
        }),
      }),
    ),
  ),
  { name: 'Age 57, room blank, only own CPF switched on (nothing can go in yet)', input: make({ profile: { ageAtYearEnd: 57 }, levers: { srs: { enabled: false }, cpfSelf: { enabled: true }, cpfFamily: { enabled: false } } }) },
  { name: 'Age 57, room blank, own CPF switched off (no room question)', input: make({ profile: { ageAtYearEnd: 57 }, levers: { srs: { enabled: true }, cpfSelf: { enabled: false }, cpfFamily: { enabled: false } } }) },
  { name: 'Age 57, room blank, cash limit stops the plan', input: make({ profile: { ageAtYearEnd: 57 }, preferences: { cashBudget: 4_000 } }) },
  { name: 'Age 57, room blank, nothing clears the minimum', input: make({ profile: { ageAtYearEnd: 57 }, preferences: { minSavingRate: 0.24 } }) },
  { name: 'Age 57, room blank, existing SRS and family at their caps (nothing can go in yet)', input: make({ profile: { ageAtYearEnd: 57 }, existing: { srs: 15_300, cpfTopUpFamily: 8_000 }, levers: ALL_ON }) },
  { name: 'Age 55, room typed as text (not a number, so not confirmed)', input: make({ profile: { ageAtYearEnd: 55 }, levers: { cpfSelf: { enabled: true, roomToLimit: 'plenty' } } }), raw: { in_cpfSelfRoom: 'plenty' } },
  { name: 'Age 120, room 1', input: make({ profile: { ageAtYearEnd: 120, birthMonth: 5 }, levers: { ...ALL_ON, cpfSelf: { enabled: true, roomToLimit: 1 } } }) },
  { name: 'A.2b with SRS first and no cash limit', input: olderPr(null, { preferences: { cashBudget: null, priority: FLEX } }) },
  { name: 'A.2 with a room of S$0', input: olderPr(0) },

  // Foreigners: tax residency, and SRS dollars that save less than leaving costs.
  ...[5, 6, 7].flatMap((monthsWorked) =>
    [true, false].flatMap((srsOn) =>
      [0.07, 0.115].map(
        (minSavingRate): Profile => ({
          name: `Foreigner, ${monthsWorked} months worked, SRS ${srsOn ? 'on' : 'off'}, minimum ${minSavingRate === 0.07 ? '7' : '11.5'}%`,
          input: foreigner({ income: { monthsWorked }, levers: { srs: { enabled: srsOn } }, preferences: { minSavingRate } }),
        }),
      ),
    ),
  ),
  { name: 'Foreigner, full year, minimum 7% (S$25,700 of the plan saves less than leaving costs)', input: foreigner({ preferences: { minSavingRate: 0.07 } }) },
  { name: 'Foreigner, full year, minimum 11.5% (no low-value dollars)', input: foreigner({ preferences: { minSavingRate: 0.115 } }) },
  { name: 'Foreigner, full year, every tax dollar', input: foreigner({ preferences: { minSavingRate: 0 } }) },
  { name: 'Foreigner, full year, cash limit inside the 11.5% rung', input: foreigner({ preferences: { minSavingRate: 0.07, cashBudget: 6_000 } }) },
  { name: 'Foreigner aged 58, as at the deadline day', input: foreigner({ today: '2026-12-31', profile: { ageAtYearEnd: 58 } }) },

  // The minimum left as the workbook opens with it: 7 cents, or 11.5 cents for a foreigner, as on the web page
  // and as the buyer guide says. The foreigner's default plan is the page's: S$10,000 into SRS, not S$35,700.
  untouched('Minimum untouched: the example as the file opens', make()),
  untouched('Minimum untouched: PR in the 2nd year, all schemes switched on', make({ profile: { residency: 'pr', prYear: 2 }, levers: ALL_ON })),
  untouched('Minimum untouched: foreigner on S$7,000 a month (starts at 11.5 cents)', foreigner()),
  untouched('Minimum untouched: foreigner aged 57, own CPF switched on, five months worked', foreigner({ profile: { ageAtYearEnd: 57 }, income: { monthsWorked: 5 }, levers: ALL_ON })),
  untouched('Minimum untouched: foreigner in 2025 on a high income', foreigner({ incomeYear: 2025, today: '2025-11-13', income: { monthlyOrdinaryWage: 25_000, additionalWages: 60_000 } })),
  untouched('Minimum untouched: foreigner in 2027 (projected rules)', foreigner({ incomeYear: 2027, today: '2027-03-01' })),

  // The room cell says NEEDED only when the person's own CPF is open to them and switched on.
  { name: 'Foreigner aged 57, own CPF switched on, room blank (not open to them: nothing is needed)', input: foreigner({ profile: { ageAtYearEnd: 57 }, levers: ALL_ON, preferences: { minSavingRate: 0.115 } }) },
  { name: 'Foreigner aged 57, a room typed in all the same (not used)', input: foreigner({ profile: { ageAtYearEnd: 57 }, levers: { ...ALL_ON, cpfSelf: { enabled: true, roomToLimit: 4_000 } }, preferences: { minSavingRate: 0.115 } }) },
  { name: 'Age 55, own CPF switched off, room blank (needed only if switched on)', input: make({ profile: { ageAtYearEnd: 55, birthMonth: 9 }, levers: { ...ALL_ON, cpfSelf: { enabled: false } } }) },
  { name: 'Age 55, own CPF switched off, room 2,000 entered', input: make({ profile: { ageAtYearEnd: 55, birthMonth: 9 }, levers: { ...ALL_ON, cpfSelf: { enabled: false, roomToLimit: 2_000 } } }) },

  // Family top-ups: already made, planned, and neither; 2025 has no MediSave matching figure.
  ...[2025, 2026].flatMap((incomeYear) => [
    { name: `${incomeYear}: family top-up already made, none planned`, input: make({ incomeYear, today: `${incomeYear}-10-01`, existing: { cpfTopUpFamily: 2_500 } }) },
    { name: `${incomeYear}: family top-up planned`, input: make({ incomeYear, today: `${incomeYear}-10-01`, levers: ALL_ON }) },
    { name: `${incomeYear}: family switched on but nothing planned or made`, input: make({ incomeYear, today: `${incomeYear}-10-01`, levers: ALL_ON, preferences: { cashBudget: 9_000 } }) },
  ] satisfies Profile[]),
  { name: 'Family top-up already at its cap and switched on', input: make({ existing: { cpfTopUpFamily: 8_000 }, levers: ALL_ON }) },

  // The banner names the example figures still in use (the review's case: only the salary was changed).
  { name: 'Only the salary changed (S$8,500 a month)', input: make({ income: { monthlyOrdinaryWage: 8_500 } }) },
  { name: 'Only the age and the other reliefs changed', input: make({ profile: { ageAtYearEnd: 41 }, otherReliefs: 9_000 }) },
  { name: 'Only the age is still the example\'s', input: make({ income: { monthlyOrdinaryWage: 9_000, additionalWages: 1_000 }, otherReliefs: 100 }) },

  // The tick-box for unused Parenthood Tax Rebate.
  { name: 'Unused Parenthood Tax Rebate ticked', input: make({ profile: { hasUnusedParenthoodTaxRebate: true } }) },
  { name: 'Unused Parenthood Tax Rebate ticked, no tax to pay', input: make({ profile: { hasUnusedParenthoodTaxRebate: true }, income: { monthlyOrdinaryWage: 1_500, additionalWages: 0 } }) },
  { name: 'RAW blank Parenthood Tax Rebate cell (means No)', input: make(), raw: { in_unusedPtr: null } },
  { name: 'RAW "yes" in lower case in the Parenthood Tax Rebate cell', input: make({ profile: { hasUnusedParenthoodTaxRebate: true } }), raw: { in_unusedPtr: 'yes' } },

  // Salary typed per year: split as the web page splits it.
  yearly('Per year: S$120,000 (divides by 12)', 120_000, 15_000),
  yearly('Per year: S$100,000 (S$4 left over)', 100_000, 15_000),
  yearly('Per year: S$100,000 over 5 months (S$1 left over)', 100_000, 0, { income: { monthsWorked: 5 } }),
  yearly('Per year: S$123,457 over 7 months', 123_457, 9_999, { income: { monthsWorked: 7 }, levers: ALL_ON }),
  yearly('Per year: S$96,011 at the wage ceiling', 96_011, 6_000),
  yearly('Per year: S$11 (less than a dollar a month)', 11, 60_000, { preferences: { minSavingRate: 0 } }),
  yearly('Per year: S$8,999 in the phase-in band, 11 months', 8_999, 500, { income: { monthsWorked: 11, otherTaxableIncome: 50_000 }, preferences: { minSavingRate: 0 } }),
  yearly('Per year: foreigner on S$91,007', 91_007, 0, { profile: { residency: 'foreigner' }, otherReliefs: 0 }),
  { name: 'RAW unknown text in the salary-period cell (means per month)', input: make(), raw: { in_salaryPeriod: 'fortnightly' } },
  { name: 'RAW blank salary-period cell (means per month)', input: make(), raw: { in_salaryPeriod: null } },

  // Each ending of the deadline caution: both cut-offs, the bank's alone, the CPF Board's alone.
  { name: 'Deadline soon: SRS and CPF in the plan', input: make({ today: '2026-12-20' }) },
  { name: 'Deadline soon: SRS only in the plan', input: make({ today: '2026-12-20', levers: { cpfSelf: { enabled: false } } }) },
  { name: 'Deadline soon: CPF only in the plan', input: make({ today: '2026-12-20', levers: { srs: { enabled: false } } }) },
  { name: 'Deadline soon: family top-up only in the plan', input: make({ today: '2026-12-30', levers: { srs: { enabled: false }, cpfSelf: { enabled: false }, cpfFamily: { enabled: true } } }) },
  { name: 'Deadline day: SRS only in the plan', input: make({ today: '2026-12-31', levers: { cpfSelf: { enabled: false } } }) },

  // The lock-up line: an age already reached, one year to go, and a family top-up.
  { name: 'Age 63: one year to the SRS age', input: make({ profile: { ageAtYearEnd: 63, birthMonth: 2 }, levers: { ...ALL_ON, cpfSelf: { enabled: true, roomToLimit: 8_000 } } }) },
  { name: 'Age 66: both ages already reached, family first', input: make({ profile: { ageAtYearEnd: 66, birthMonth: 2 }, levers: { ...ALL_ON, cpfSelf: { enabled: true, roomToLimit: 8_000 } }, preferences: { priority: FAMILY } }) },

  // Before You Transfer: every case the wording depends on (residency, below 55 or not, deadline passed or not).
  ...(['citizen', 'pr', 'foreigner'] as const).flatMap((residency) =>
    [40, 60].flatMap((age) =>
      ['2026-11-13', '2027-01-05'].map(
        (today): Profile => ({
          name: `Before You Transfer: ${residency}, age ${age}, as at ${today}`,
          input: make({ today, profile: { residency, ageAtYearEnd: age, birthMonth: 4 }, levers: { ...ALL_ON, cpfSelf: { enabled: true, roomToLimit: 5_000 } } }),
        }),
      ),
    ),
  ),

  // The same safeguards in the other years, under edited rules, and where they meet one another.
  { name: '2027: older PR with the CPF room left blank (projected rules)', input: olderPr(null, { incomeYear: 2027, today: '2027-12-20' }) },
  { name: '2027: foreigner, minimum 7%', input: foreigner({ incomeYear: 2027, today: '2027-06-01', preferences: { minSavingRate: 0.07 } }) },
  { name: '2025: foreigner, every tax dollar, looked at after the deadline', input: foreigner({ incomeYear: 2025, today: '2026-01-10', preferences: { minSavingRate: 0 } }) },
  { name: '2025: age 56 with the CPF room left blank', input: make({ incomeYear: 2025, today: '2025-11-13', profile: { ageAtYearEnd: 56, birthMonth: 8 }, levers: ALL_ON }) },
  {
    name: 'Edited rules: foreigner aged 60 who may top up family (a CPF column is open to them)',
    rules: 'edited',
    input: make({ profile: { residency: 'foreigner', ageAtYearEnd: 60 }, income: { monthlyOrdinaryWage: 9_000, additionalWages: 12_000, monthsWorked: 6 }, existing: { cpfTopUpFamily: 500 }, levers: ALL_ON }),
  },
  { name: 'Rebate year: age 57 with the CPF room left blank', rules: 'rebate', input: make({ profile: { ageAtYearEnd: 57 }, levers: ALL_ON }) },
  {
    name: 'PR in 2nd year turning 55 in June, room blank, Parenthood Tax Rebate ticked',
    input: make({ profile: { residency: 'pr', prYear: 2, ageAtYearEnd: 55, birthMonth: 6, hasUnusedParenthoodTaxRebate: true }, levers: ALL_ON, preferences: { priority: FAMILY } }),
  },
  { name: 'Foreigner aged 17, three months worked (nothing open, residency caution)', input: foreigner({ profile: { ageAtYearEnd: 17 }, income: { monthsWorked: 3 } }) },

  // Values typed over the Rules sheet of the stock workbook, as a buyer would.
  {
    name: 'Typed on Rules: income year 2027 (the deadline follows the year)',
    rules: 'retyped2027',
    input: make({ incomeYear: 2027, today: '2027-11-13' }),
    edit: (set) => set('rule_incomeYear', 2027),
    rulesChanged: true,
  },
  {
    name: 'Typed on Rules: income year 2027, looked at the day after its deadline',
    rules: 'retyped2027',
    input: make({ incomeYear: 2027, today: '2028-01-01' }),
    edit: (set) => set('rule_incomeYear', 2027),
    rulesChanged: true,
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
    rulesChanged: true,
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
    in_salary: cell(income.monthlyOrdinaryWage),
    in_salaryPeriod: SALARY_PERIODS[0],
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
    in_unusedPtr: yesNo(profile.hasUnusedParenthoodTaxRebate),
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

type Cells = Record<InputName, ExcelJS.CellValue>;

/** What a profile puts in the cream cells: the engine input as typed per month, or the yearly salary and bonus. */
function profileCells(profile: Pick<Profile, 'input' | 'raw' | 'perYear'>): Cells {
  const perYear: Partial<Cells> = profile.perYear
    ? { in_salary: profile.perYear.salary, in_salaryPeriod: SALARY_PERIODS[1], in_additionalWages: profile.perYear.bonus }
    : {};
  return { ...cellValues(profile.input), ...perYear, ...profile.raw };
}

function writeInputs(built: BuiltWorkbook, values: Cells): void {
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

/**
 * SPEC §9: internal codes (warning codes, constraint names, scheme and scenario identifiers) never appear on a
 * sheet. A code is a word in UPPER_SNAKE_CASE or in camelCase; ordinary words and names (MediSave) are neither.
 * Web addresses are left out: they are not ours to word.
 */
const UPPER_SNAKE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const CAMEL_CASE = /\b[a-z]+[A-Z][A-Za-z]*\b/;
function looksLikeCode(text: string): boolean {
  if (/^https?:\/\//.test(text)) return false;
  return UPPER_SNAKE.test(text) || CAMEL_CASE.test(text);
}

/** What a cell shows: its calculated result or typed-in value. The lower cells of a merged block show nothing. */
function scalarOf(cell: ExcelJS.Cell): Scalar {
  if (cell.isMerged && cell.master.address !== cell.address) return null;
  const raw: unknown = cell.formula ? cell.result : cell.value;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean' || raw instanceof Date) return raw;
  if (typeof raw === 'object' && 'error' in raw) return String((raw as { error: unknown }).error);
  if (typeof raw === 'object' && 'text' in raw) return String((raw as { text: unknown }).text);
  throw new Error(`Unexpected cell content at ${cell.address}: ${JSON.stringify(raw)}`);
}

/**
 * A recalculated workbook, read by defined name. Everything the tests ask for is taken out when the workbook is
 * read, so the workbook itself (several megabytes of cells) is not kept: some three hundred of them are compared.
 */
class Results {
  private readonly named = new Map<string, Scalar[]>();
  private readonly errorList: string[] = [];
  private readonly codeList: string[] = [];

  constructor(wb: ExcelJS.Workbook) {
    for (const { name, ranges } of wb.definedNames.model) {
      const reference = ranges[0];
      if (!reference) continue;
      const match = /^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(reference);
      if (!match) continue;
      const ws = wb.getWorksheet((match[1] ?? match[2] ?? '').replace(/''/g, "'"));
      if (!ws) continue;
      const first = ws.getCell(`${match[3] ?? ''}${match[4] ?? ''}`);
      const last = match[5] ? ws.getCell(`${match[5]}${match[6] ?? ''}`) : first;
      const out: Scalar[] = [];
      for (let row = Number(first.row); row <= Number(last.row); row++) {
        for (let col = Number(first.col); col <= Number(last.col); col++) out.push(scalarOf(ws.getCell(row, col)));
      }
      this.named.set(name, out);
    }
    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (cell.isMerged && cell.master.address !== cell.address) return;
          const shown: unknown = cell.formula ? cell.result : cell.value;
          for (const candidate of [cell.value, shown]) {
            if (candidate !== null && typeof candidate === 'object' && 'error' in candidate) {
              this.errorList.push(`${ws.name}!${cell.address} ${String((candidate as { error: unknown }).error)}`);
            } else if (typeof candidate === 'string' && ERROR_TEXT.test(candidate)) {
              this.errorList.push(`${ws.name}!${cell.address} ${candidate}`);
            }
          }
          if (typeof shown === 'string' && looksLikeCode(shown)) this.codeList.push(`${ws.name}!${cell.address} ${shown.slice(0, 80)}`);
        });
      });
    }
  }

  private cells(name: string): Scalar[] {
    const found = this.named.get(name);
    if (!found) throw new Error(`The recalculated workbook has no defined name "${name}"`);
    return found;
  }

  value(name: string): Scalar {
    const cells = this.cells(name);
    if (cells.length !== 1) throw new Error(`"${name}" is not a single cell`);
    return cells[0] ?? null;
  }

  /** The cells of a named range, top to bottom. `every` takes each n-th cell (the first row of merged lines). */
  column(name: string, every = 1): Scalar[] {
    return this.cells(name).filter((_cell, index) => index % every === 0);
  }

  /** Every cell that evaluates to an error, as "Sheet!A1 #ERR". */
  errors(): string[] {
    return this.errorList;
  }

  /** Every piece of text a sheet shows (typed-in or calculated) that reads like an internal code, as "Sheet!A1 text". */
  codes(): string[] {
    return this.codeList;
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

/** A tax amount with cents, e.g. "S$2,679.50". */
function taxAmount(amount: number): string {
  return `S$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "a, b and c". */
function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** True when the plan leaves the person's own CPF out because its room was not entered (SPEC §6.5). */
function ownCpfLeftOut(expected: PlannerResult): boolean {
  return expected.warnings.some((warning) => warning.code === 'CPF_SELF_ROOM_UNCONFIRMED');
}

/** Completes "Put S$X into …" as the web page does (SPEC §8.4, §9). */
const INTO: Record<LeverId, string> = {
  srs: 'SRS',
  cpfSelf: 'your CPF as a cash top-up',
  cpfFamily: "family members' CPF as a cash top-up",
};

/**
 * The recommendation as a sentence, written out here from SPEC §8.4 and §9 ("Put S$X into SRS and S$Y into your
 * CPF as a cash top-up. You save S$Z in tax."). A separate test holds it to the web page's own `headline()`.
 */
function expectedHeadline(expected: PlannerResult): string {
  const { plan: p, input, rules, monthlyPlan } = expected;
  const parts = input.preferences.priority.filter((lever) => p.contributions[lever] > 0).map((lever) => `${dollars(p.contributions[lever])} into ${INTO[lever]}`);
  if (monthlyPlan.daysToDeadline < 0) {
    const [year, month, day] = monthlyPlan.deadline.split('-').map(Number) as [number, number, number];
    const by = `${day} ${(MONTH_LABELS[month - 1] ?? '').slice(0, 3)} ${year}`;
    return (
      `The deadline for YA${rules.ya} has passed. ` +
      (parts.length === 0
        ? `On these numbers there was nothing more worth putting in for YA${rules.ya}.`
        : `Putting ${listOf(parts)} by ${by} would have saved ${taxAmount(p.taxSaved)} in tax for YA${rules.ya}.`)
    );
  }
  if (parts.length === 0) return ownCpfLeftOut(expected) && p.bindingConstraint === 'leverLimits' ? 'Nothing to put in yet.' : 'Nothing more to put in this year.';
  return `Put ${listOf(parts)}. You save ${taxAmount(p.taxSaved)} in tax.`;
}

/**
 * The sentence the page puts straight after its lock-up lines (`horizonNote` in src/web/text.ts), written out once
 * here: the age shown is for a first contribution made now. A test holds it to the page's own function.
 */
function earlierContributionNote(srsAge: number): string {
  return `If you have paid into SRS before, your SRS age was set by your first contribution and may be lower than ${srsAge}.`;
}

/**
 * How long the cash is locked away, for the schemes in the plan and in the plan's order (SPEC §8.4): the ages and
 * years are the engine's `lockUpHorizon`, and a family top-up is described by the engine's own sentence. Then the
 * two things the SRS age leaves unsaid, as the page says them: the 10-year rule for a foreigner, and the age set
 * by an earlier first contribution. A separate test holds all of it to the page's own functions.
 */
function expectedHorizon(expected: PlannerResult, builtRules: YearRules): string {
  const { plan: p, input, rules, monthlyPlan } = expected;
  if (monthlyPlan.daysToDeadline < 0) return '';
  const horizon = lockUpHorizon(rules, input.profile.ageAtYearEnd);
  const span = (years: number): string => (years > 0 ? `about ${years} ${years === 1 ? 'year' : 'years'}` : 'an age you have already reached');
  // A family top-up is given away, not locked for a time: the engine's sentence for "if you need it sooner".
  const gift = lockUpFacts(builtRules, { residency: 'citizen', ageAtYearEnd: 35 }).find((row) => row.id === 'sooner')?.values.cpfFamily ?? '';
  const line: Record<LeverId, string> = {
    // A foreigner can also take SRS out under the 10-year rule for foreigners, which for most comes first.
    srs: `SRS: locked until ${horizon.srsAge}, ${span(horizon.srsYears)}${
      input.profile.residency === 'foreigner' && horizon.srsYears > 0 ? ', or until you can use the 10-year rule for foreigners if that comes first' : ''
    }.`,
    cpfSelf: `CPF: paid out monthly from ${horizon.cpfPayoutAge}, ${span(horizon.cpfYears)}.`,
    cpfFamily: `Family top-up: ${gift}`,
  };
  const lines = input.preferences.priority.filter((lever) => p.contributions[lever] > 0).map((lever) => line[lever]);
  // Said straight after the lines: the SRS age shown is the one a first contribution made now locks in.
  const note =
    p.contributions.srs > 0 && horizon.srsYears > 0
      ? earlierContributionNote(horizon.srsAge)
      : '';
  return [...lines, note].filter((sentence) => sentence !== '').join(' ');
}

/** The Planner's banner for the cells a profile typed in (SPEC §9: it names the example figures still in use). */
function expectedBanner(cells: Cells, rules: YearRules): string {
  const prefix = rules.status === 'projected' ? `PROJECTED RULES — the ${rules.incomeYear} figures are provisional and may change. ` : '';
  const example: Partial<Cells> = {
    in_residency: EXAMPLE.residency,
    in_prYear: EXAMPLE.prYear,
    in_age: EXAMPLE.age,
    in_birthMonth: EXAMPLE.birthMonth,
    in_salary: EXAMPLE.salary,
    in_salaryPeriod: EXAMPLE.salaryPeriod,
    in_monthsWorked: EXAMPLE.monthsWorked,
    in_additionalWages: EXAMPLE.additionalWages,
    in_otherIncome: EXAMPLE.otherIncome,
    in_employmentExpenses: EXAMPLE.employmentExpenses,
    in_donations: EXAMPLE.donations,
    in_cpfOverride: EXAMPLE.cpfOverride,
    in_existingSrs: EXAMPLE.existingSrs,
    in_existingCpfSelf: EXAMPLE.existingCpfSelf,
    in_existingCpfFamily: EXAMPLE.existingCpfFamily,
    in_otherReliefs: EXAMPLE.otherReliefs,
    in_unusedPtr: EXAMPLE.unusedPtr,
    in_cashBudget: EXAMPLE.cashBudget,
    in_useSrs: EXAMPLE.useSrs,
    in_useCpfSelf: EXAMPLE.useCpfSelf,
    in_cpfSelfRoom: EXAMPLE.cpfSelfRoom,
    in_useCpfFamily: EXAMPLE.useCpfFamily,
    in_cpfFamilyMax: EXAMPLE.cpfFamilyMax,
    in_minSavingRate: EXAMPLE.minSavingRate,
    in_priority: EXAMPLE.priority,
  };
  // The minimum cell left as the workbook opens with it shows the default for the residency typed in.
  const shown = (name: InputName): ExcelJS.CellValue => {
    const value = cells[name] ?? null;
    if (name !== 'in_minSavingRate' || value === null || typeof value !== 'object' || !('formula' in value)) return value;
    return cells.in_residency === RESIDENCY_LABELS.foreigner ? DEFAULT_MIN_RATE.foreigner : DEFAULT_MIN_RATE.resident;
  };
  const same = (name: InputName): boolean => shown(name) === (example[name] ?? null);
  if ((Object.keys(example) as InputName[]).every(same)) {
    return `${prefix}EXAMPLE SHOWN — age 35, S$10,000 a month, S$15,000 bonus, S$5,000 other reliefs. Type over the cream cells with your own figures.`;
  }
  const left = [
    same('in_age') ? 'age' : '',
    same('in_salary') && cells.in_salaryPeriod !== SALARY_PERIODS[1] ? 'salary' : '',
    same('in_additionalWages') ? 'bonus' : '',
    same('in_otherReliefs') ? 'other reliefs' : '',
  ].filter((name) => name !== '');
  return left.length > 0
    ? `${prefix}Still using the example's ${listOf(left)}. Type your own over ${left.length === 1 ? 'it; leave it if it happens to be right for you.' : 'them; leave any that happens to be right for you.'}`
    : `${prefix}Your figures — results on the right update as you type. Read the Before You Transfer sheet before you move any money.`;
}

/** The round figure the Ladder chart's bottom axis runs to: just past the schemes' room, so the last block ends in view. */
function chartAxisEnd(room: number): number {
  if (room === 0) return 0;
  const steps: Array<[number, number]> = [
    [20_000, 5_000],
    [8_000, 2_000],
    [4_000, 1_000],
    [2_000, 500],
    [800, 200],
    [400, 100],
    [200, 50],
    [80, 20],
    [40, 10],
    [20, 5],
    [8, 2],
  ];
  const unit = steps.find(([from]) => room >= from)?.[1] ?? 1;
  return (Math.floor((room * 21) / (20 * unit)) + 1) * unit;
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
      // "The minimum set on the Planner", never "the minimum you asked for" or "you set": the cell starts at a default.
      if (p.totalContribution === 0) return /^Nothing is recommended: each extra dollar would save [\d.]+ cents or less, below the [\d.]+ cents minimum set on the Planner\. Choose a lower minimum there to see the smaller savings\.(?: |$)/;
      return p.marginalRateAfter === 0 ? /^The plan takes your chargeable income down to the tax-free band\./ : /^Beyond this, each extra dollar would save [\d.]+ cents or less, below the [\d.]+ cents minimum set on the Planner\./;
    case 'reliefCap':
      return p.totalContribution === 0 ? /^Your reliefs have already reached the S\$[\d,]+ overall cap/ : /^The plan stops where your total reliefs reach the S\$[\d,]+ overall cap\./;
    case 'leverLimits': {
      if (room > 0) return /^You have used all the room in the schemes you switched on\./;
      const switchedOn = LEVERS.filter((lever) => levers[lever].enabled);
      if (switchedOn.length === 0) return /^No scheme is switched on, so there is nothing to recommend\./;
      if (switchedOn.every((lever) => !levers[lever].eligible)) return /^None of the schemes you switched on is open to you/;
      // From 55 a blank room is "not confirmed", never "no room left" (SPEC §6.11).
      return ownCpfLeftOut(expected)
        ? /^Nothing can be contributed yet: your own CPF is left out until you enter its room, and no other scheme you switched on has room left\.$/
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
  /** What was typed into the cream cells, for the banner that names the example figures still in use. */
  cells?: Cells;
  /** The rules the workbook was built from (the sentences of Before You Transfer are fixed then). Default: the engine's. */
  builtRules?: YearRules;
  /** True when the Rules sheet was typed over in a way that changes a figure Before You Transfer quotes. */
  rulesChanged?: boolean;
}

function assertParity(results: Results, expected: PlannerResult, options: ParityOptions = {}): void {
  const { cpf, baseline, optimised, plan: p, levers, ladder, simulator, scenarios, monthlyPlan, warnings, rules } = expected;
  const leverRoom = levers.srs.room + levers.cpfSelf.room + levers.cpfFamily.room;
  const builtRules = options.builtRules ?? rules;

  // §6.1 CPF
  expectDollars(results.value('out_employeeCpf'), cpf.employeeContribution, 'employee CPF');
  expect(results.value('out_cpfSourceWords'), 'where the CPF figure comes from').toBe(CPF_SOURCE_WORDS[cpf.source]);
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
  expectDollars(results.value('out_base_ci'), p.chargeableIncomeBefore, 'chargeable income before');
  expectDollars(results.value('out_opt_ci'), p.chargeableIncomeAfter, 'chargeable income after');
  expectRate(results.value('out_base_marginal'), p.marginalRateBefore, 'marginal rate before');
  expectRate(results.value('out_opt_marginal'), p.marginalRateAfter, 'marginal rate after');
  // The limit that stops the plan is a number in a working cell (never the engine's name for it).
  expect(BINDING_NUMBERS[num(results.value('out_bindingNumber'), 'limit that stops the plan')], 'binding constraint').toBe(p.bindingConstraint);
  const reason = text(results.value('out_reason'), 'reason sentence');
  expect(reason, 'reason sentence').toMatch(reasonPattern(expected));
  // A plan that leaves the person's own CPF out says so, in the page's words, unless the reason already does.
  const leftOutSentence = ' Your own CPF is left out until you enter how much you can still top up with relief.';
  const saysLeftOut = ownCpfLeftOut(expected) && !(p.bindingConstraint === 'leverLimits' && leverRoom === 0);
  expect(reason.endsWith(leftOutSentence), `reason says the person's own CPF is left out: ${reason}`).toBe(saysLeftOut);

  // SPEC §9 "Same story as the page": the recommendation as a sentence, and how long the cash is locked away.
  expect(results.value('out_headline'), 'the recommendation as a sentence').toBe(expectedHeadline(expected));
  expect(results.value('out_horizon') ?? '', 'how long the cash is locked away').toBe(expectedHorizon(expected, builtRules));
  expect(String(results.value('out_horizon') ?? '').length, 'the lock-up block fits the three lines it has room for').toBeLessThanOrEqual(HORIZON_CHARS);
  expectDollars(results.value('out_srsYears'), lockUpHorizon(rules, expected.input.profile.ageAtYearEnd).srsYears, 'years to the SRS age');
  expectDollars(results.value('out_cpfYears'), lockUpHorizon(rules, expected.input.profile.ageAtYearEnd).cpfYears, 'years to the CPF payout age');

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
    // Why a rung saves nothing is a number in a working column, never the engine's name for it.
    expect(ladderCols.reason[index] ?? null, `${label} zero reason`).toBe(tier.zeroReason ? ZERO_REASON_NUMBERS[tier.zeroReason] : 0);
  });

  // The chart's points: evenly spaced amounts from 0 to a round figure just past the room; at each, the saving
  // per dollar there, in "Your plan" if the plan uses that dollar and in "Not in your plan" if it does not.
  const chart = {
    x: results.column('out_chart_x'),
    plan: results.column('out_chart_plan'),
    rest: results.column('out_chart_rest'),
  };
  const axisEnd = chartAxisEnd(leverRoom);
  expectDollars(results.value('out_chart_max'), axisEnd, 'where the chart axis ends');
  if (leverRoom > 0) expect(axisEnd, 'the last block ends before the edge of the chart').toBeGreaterThan(leverRoom);
  expect(chart.x.length, 'chart points').toBe(CHART_STEPS + 1);
  const X = p.totalContribution;
  for (let i = 0; i <= CHART_STEPS; i++) {
    const label = `chart point ${i}`;
    // Decided on whole numbers, as the sheet does: i × axis end against CHART_STEPS × the rung's ends.
    const tier = ladder.find((candidate) => CHART_STEPS * candidate.fromContribution <= i * axisEnd && i * axisEnd < CHART_STEPS * candidate.toContribution);
    const rate = tier?.rate ?? 0;
    const inPlan = i * axisEnd < CHART_STEPS * X;
    expectRate(chart.x[i] ?? null, (i * axisEnd) / CHART_STEPS, `${label} amount`);
    expectRate(chart.plan[i] ?? null, inPlan ? rate : 0, `${label} your plan`);
    expectRate(chart.rest[i] ?? null, inPlan ? 0 : rate, `${label} not in your plan`);
  }

  // The labels under the axis: the amount at every CHART_LABEL_EVERY-th point, and none at all when there is no room
  // (a row of "0" under an empty chart would read as a scale).
  const axisLabels = results.column('out_chart_label');
  expect(axisLabels.length, 'chart labels').toBe(CHART_STEPS + 1);
  for (let i = 0; i <= CHART_STEPS; i++) {
    const amount = (i * axisEnd) / CHART_STEPS;
    if (leverRoom === 0 || i % CHART_LABEL_EVERY !== 0) expect(axisLabels[i] ?? null, `axis label ${i}`).toBeNull();
    else if (Number.isInteger(amount)) expect(axisLabels[i], `axis label ${i}`).toBe(amount.toLocaleString('en-US'));
    else expect(String(axisLabels[i]), `axis label ${i}`).toMatch(/^[\d,]+$/);
  }
  // Above the chart: how to read it, or why there is no ladder — told apart as the Planner's reason tells it
  // (SPEC §6.11): nothing switched on, nothing open, the person's own CPF waiting for its room, or no room left.
  const ladderNote = text(results.value('out_ladderNote'), 'note above the ladder chart');
  if (leverRoom > 0) expect(ladderNote).toMatch(/^How to read it: /);
  else {
    const switchedOn = LEVERS.filter((lever) => levers[lever].enabled);
    expect(ladderNote, 'why there is no ladder').toBe(
      switchedOn.length === 0
        ? NO_LADDER.nothingOn
        : switchedOn.every((lever) => !levers[lever].eligible)
          ? NO_LADDER.notOpen
          : ownCpfLeftOut(expected)
            ? NO_LADDER.roomAwaited
            : NO_LADDER.full,
    );
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

  // §6.9 scenarios: the rows are in the order of the SPEC's table
  const scen = {
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
  expect(scen.total.length).toBe(SCENARIO_IDS.length);
  expect(scenarios.map((scenario) => scenario.id)).toEqual([...SCENARIO_IDS]);
  scenarios.forEach((scenario, index) => {
    const label = `scenario ${scenario.id}`;
    expectDollars(scen.srs[index] ?? null, scenario.contributions.srs, `${label} SRS`);
    expectDollars(scen.cpfSelf[index] ?? null, scenario.contributions.cpfSelf, `${label} CPF self`);
    expectDollars(scen.cpfFamily[index] ?? null, scenario.contributions.cpfFamily, `${label} CPF family`);
    expectDollars(scen.total[index] ?? null, scenario.totalContribution, `${label} total`);
    expectCents(scen.tax[index] ?? null, scenario.taxPayable, `${label} tax payable`);
    expectCents(scen.saved[index] ?? null, scenario.taxSaved, `${label} tax saved`);
    // Saved per dollar in cents, to the two decimals the page shows; "n/a" when nothing is put in.
    if (scenario.totalContribution === 0) expect(scen.rate[index], `${label} saved per dollar`).toBe('n/a');
    else expectRate(scen.rate[index] ?? null, Math.round(scenario.savingRate * 10_000) / 100, `${label} saved per dollar (cents)`);
    expectDollars(scen.wasted[index] ?? null, scenario.wastedContribution, `${label} wasted`);
  });
  // The comment on the plan's row names the limit that stopped it, and no longer promises "never a wasted dollar".
  const planComment = text(scen.comment[SCENARIO_IDS.indexOf('recommended')] ?? null, 'comment on the plan');
  const stops = {
    none: /^Your plan\./,
    usefulRoom: /^Stops where the next dollar would save less than your minimum\./,
    reliefCap: /^Stops at the overall relief cap\./,
    leverLimits: /^Uses all the room in the schemes you switched on\./,
    cashBudget: /^Stops at your cash limit\./,
  } as const;
  if (p.totalContribution === 0) expect(planComment).toMatch(/^Nothing more is recommended/);
  else {
    expect(planComment).toMatch(stops[p.bindingConstraint]);
    expect(planComment.endsWith(' Has no dollars above the caps. Check your CPF room and family eligibility yourself.'), planComment).toBe(true);
  }
  // An option that uses the person's own CPF says why it shows nothing for it while the room is awaited (SPEC §6.5).
  const roomAwaited = levers.cpfSelf.eligible && expected.input.profile.ageAtYearEnd >= 55 && (expected.input.levers.cpfSelf.roomToLimit ?? null) === null;
  expect(results.value('out_ownCpfRoomAwaited'), 'room for own CPF needed and not entered').toBe(roomAwaited ? 1 : 0);
  for (const id of ['cpfSelfOnly', 'srsPlusCpfSelf', 'maxAll'] as const) {
    const comment = String(scen.comment[SCENARIO_IDS.indexOf(id)] ?? '');
    expect(comment.endsWith('Your own CPF is left out until you enter how much you can still top up with relief.'), `${id}: ${comment}`).toBe(roomAwaited);
  }

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
  // The banner above the instalments agrees with the table under it. Near the deadline it gives the engine's
  // cut-offs, and only for the schemes that are in the plan.
  const days = monthlyPlan.daysToDeadline;
  const soon = warnings.find((warning) => warning.code === 'DEADLINE_SOON');
  const cutOffs = soon ? soon.message.replace(/^.*? (?:is the deadline|deadline)\. /, '').replace(/, so transfer as soon as you can\.$/, '') : '';
  const actualBanner = text(results.value('out_monthlyBanner'), 'monthly banner');
  if (days < 0) {
    expect(actualBanner).toMatch(
      monthlyPlan.schedule.length > 0
        ? /^The deadline for \d{4} passed on \d+ \w+ \d{4}\. The amounts below are listed only because the year has not ended/
        : /^The deadline for \d{4} has passed \(\d+ \w+ \d{4}\)\. .* no instalments are shown\.$/,
    );
  } else if (p.totalContribution === 0) {
    expect(actualBanner).toMatch(/^Nothing more is recommended for \d{4}, so there are no instalments\./);
  } else if (days === 0) {
    expect(actualBanner).toBe(`Today is the deadline. ${cutOffs}, so transfer now.`);
  } else if (days <= 14) {
    expect(actualBanner).toBe(`Only ${days} day${days === 1 ? '' : 's'} left. ${cutOffs}, so transfer as soon as you can.`);
  } else {
    expect(actualBanner).toMatch(
      new RegExp(`^Set aside the amounts below in each of the ${monthlyPlan.monthsRemaining} month${monthlyPlan.monthsRemaining === 1 ? '' : 's'} left to reach ${escapeRegExp(dollars(p.totalContribution))} by `),
    );
  }
  // The affordability note (SPEC §8.4): only when an instalment is more than the monthly salary entered.
  const salary = expected.input.income.monthlyOrdinaryWage;
  const largest = monthlyPlan.schedule.reduce((most, row) => Math.max(most, row.total), 0);
  const affordability = results.value('out_affordability');
  if (days >= 0 && salary > 0 && largest > salary) {
    expect(text(affordability, 'affordability note')).toMatch(
      new RegExp(`^${escapeRegExp(dollars(largest))} a month is more than your monthly salary\\. It would have to come from your bonus or savings\\. .*Most cash you can spare this year`),
    );
  } else {
    expect(affordability, 'no affordability note').toBeNull();
  }

  // §6.11 warnings: the same checks fire (row i of the table is WARNING_CODES[i]; the codes are not on the sheet),
  // and the Planner shows the engine's message for each, in order, after a line for each workbook check that applies
  const flags = results.column('out_warningFlags');
  expect(flags.length, 'one row for each of the SPEC §6.11 warnings').toBe(WARNING_CODES.length);
  const fired = WARNING_CODES.filter((_code, index) => flags[index] === 1);
  expect(fired, 'warnings that fire').toEqual(warnings.map((warning) => warning.code));
  const checks = options.checks ?? WORKBOOK_CHECKS.map(() => 0);
  expect(results.column('out_workbookCheckFlags'), 'workbook checks that apply').toEqual(checks);
  const checkCount = checks.reduce((total, flag) => total + flag, 0);
  // Each line spans WARNING_LINE_ROWS merged rows; the first holds the text.
  const lineCells = results.column('out_warnings', WARNING_LINE_ROWS);
  expect(lineCells.length).toBe(WARNING_LINES);
  const lines = lineCells.filter((line) => line !== null).map(String);
  expect(lines.slice(checkCount), 'warning lines on the Planner').toEqual(warnings.flatMap(plannerLines));
  for (const line of lines) expect(line.length, `fits the room a Planner line has: ${line}`).toBeLessThanOrEqual(WARNING_LINE_CHARS);
  // …and the Tax Working sheet gives each message whole, beside when it is shown.
  const messages = results.column('out_warningMessages');
  WARNING_CODES.forEach((code, index) => {
    const warning = warnings.find((candidate) => candidate.code === code);
    const whole = warning ? LEAD[warning.severity] + warning.message.charAt(0).toLowerCase() + warning.message.slice(1) : null;
    expect(messages[index] ?? null, `${code} on the Tax Working sheet`).toBe(whole);
    if (whole) expect(whole.length, `${code} fits its row on the Tax Working sheet`).toBeLessThanOrEqual(messageRoom(code));
  });
  // SPEC §6.11: the further savings a message may quote are the ones a single change of setting can reach.
  for (const warning of warnings) {
    if (warning.code === 'BUDGET_LIMITS_PLAN') expectCents(results.value('out_savingWithMoreCash'), Number(warning.params?.savingWithMoreCash), 'saving with more cash');
    if (warning.code === 'LEVER_LIMITS_PLAN') expectCents(results.value('out_savingIfSwitchedOn'), Number(warning.params?.savingIfSwitchedOn), 'saving with every scheme switched on');
    if (warning.code === 'SRS_NON_RESIDENT_WITHDRAWAL') expectDollars(results.value('out_lowValueAmount'), Number(warning.params?.lowValueAmount), 'plan dollars that save less than leaving costs');
  }
  for (const line of lines.slice(0, checkCount)) expect(line).toMatch(/^Check — the (tax table|last contribution day) on the Rules sheet /);
  expect(lineCells.slice(lines.length).every((line) => line === null), 'warning lines are closed up').toBe(true);

  // The Planner says so at the top when the Rules sheet needs attention or the rules are projected; otherwise it
  // says whether the cream cells still hold the example, or which of its figures are still in use.
  const banner = text(results.value('out_plannerBanner'), 'Planner banner');
  if (checkCount > 0) expect(banner).toMatch(/^CHECK THE RULES SHEET FIRST/);
  else if (options.cells) expect(banner).toBe(expectedBanner(options.cells, rules));
  else expect(banner).toMatch(/^(PROJECTED RULES — the \d{4} figures are provisional and may change\. )?(EXAMPLE SHOWN — |Still using the example's |Your figures — )/);
  expect(text(results.value('out_plannerHeader'), 'Planner header')).toBe(
    `Year of Assessment ${rules.ya}${rules.status === 'projected' ? ' · PROJECTED RULES' : ''} · estimate only, not tax advice`,
  );
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
  const minRateNote = text(results.value('out_note_minSavingRate'), 'note beside the minimum');
  expect(minRateNote).toMatch(input.preferences.minSavingRate === 0 ? /^Every tax dollar: / : /^[\d.]+ cents or more: the plan uses only dollars that each save at least that much tax\./);
  // SPEC §8.3: a foreigner is told when the minimum is below what leaving costs; at or above it, why their cell
  // starts higher than a citizen's.
  const isForeigner = input.profile.residency === 'foreigner';
  expect(/A foreigner who has left Singapore pays at least 7\.5 cents per dollar in tax to take SRS out/.test(minRateNote), minRateNote).toBe(
    isForeigner && input.preferences.minSavingRate < 0.075,
  );
  expect(
    minRateNote.endsWith(' For a foreigner this cell starts at 11.5 cents: taking SRS out after leaving Singapore costs at least 7.5 cents per dollar in tax.'),
    minRateNote,
  ).toBe(isForeigner && input.preferences.minSavingRate >= 0.075);
  // The room for the person's own CPF (SPEC §6.5). Its label and note say NEEDED exactly when the engine leaves the
  // person's own CPF out for want of the figure: 55 or over, open to them, switched on, cell blank. To someone it is
  // not open to (a foreigner) the cell says it is not used; with the scheme switched off, that it is asked for only
  // if it is switched on.
  const roomNote = text(results.value('out_note_cpfSelfRoom'), 'note beside the room for own CPF');
  const roomLabel = text(results.value('out_label_cpfSelfRoom'), 'label of the room for own CPF');
  const room = input.levers.cpfSelf.roomToLimit ?? null;
  const from55 = input.profile.ageAtYearEnd >= 55;
  const ROOM_LABEL = 'Top-up to your own CPF that can still earn relief (S$';
  const roomNeeded = ownCpfLeftOut(expected);
  expect(roomNote.startsWith('NEEDED'), `the note says NEEDED: ${roomNote}`).toBe(roomNeeded);
  expect(/NEEDED/.test(roomLabel), `the label says NEEDED: ${roomLabel}`).toBe(roomNeeded);
  if (!levers.cpfSelf.eligible) {
    expect(roomLabel).toBe(`${ROOM_LABEL}) — not used`);
    expect(roomNote).toBe('Not used: CPF top-ups are not open to you.');
  } else if (room !== null) {
    expect(roomLabel).toBe(from55 ? `${ROOM_LABEL}, needed from age 55)` : `${ROOM_LABEL}, optional)`);
    expect(roomNote).toMatch(new RegExp(`^Top-ups to yourself are held to ${escapeRegExp(dollars(room))}\\.`));
  } else if (!from55) {
    expect(roomLabel).toBe(`${ROOM_LABEL}, optional)`);
    expect(roomNote).toMatch(/Blank = not limiting/);
  } else if (levers.cpfSelf.enabled) {
    expect(roomLabel).toBe(`${ROOM_LABEL}) — NEEDED from age 55`);
    expect(roomNote).toMatch(/^NEEDED from age 55: your own CPF is left out of the plan until you enter this\./);
  } else {
    expect(roomLabel).toBe(`${ROOM_LABEL}) — needed if switched on`);
    expect(roomNote).toMatch(/^From age 55 this is asked for only if you switch on top-ups to your own CPF \(the row above\)\./);
  }

  // Before You Transfer (SPEC §9 item 8): exactly the engine's lock-up facts and cautions for this person, the
  // schemes that are not open to them left blank, and one line saying so when no CPF top-up is open.
  const who = { residency: input.profile.residency, ageAtYearEnd: input.profile.ageAtYearEnd };
  const facts = lockUpFacts(builtRules, who);
  expect(results.column('out_facts_label'), 'lock-up fact headings').toEqual(facts.map((row) => row.label));
  for (const lever of LEVERS) {
    expect(results.column(`out_facts_${lever}`), `lock-up facts, ${lever}`).toEqual(
      facts.map((row) => (levers[lever].eligible ? row.values[lever] : null)),
    );
  }
  expect(results.column('out_facts_head'), 'scheme headings').toEqual(
    LEVERS.map((lever) => (levers[lever].eligible ? LEVER_NAMES[lever] : `${LEVER_NAMES[lever]} (not open to you)`)),
  );
  const cautions = transferCautions(builtRules, who, { deadlinePassed: days < 0 });
  const cautionCells = results.column('out_cautions');
  expect(cautionCells.slice(0, cautions.length), 'things only you can check').toEqual(cautions);
  expect(cautionCells.slice(cautions.length).every((cell) => cell === null), 'no caution beyond the engine\'s list').toBe(true);
  const cpfOpen = levers.cpfSelf.eligible || levers.cpfFamily.eligible;
  const noneOpen = LEVERS.every((lever) => !levers[lever].eligible);
  const notOpenLine = cpfOpen
    ? null
    : (noneOpen ? 'None of the schemes is open to you on these numbers. ' : '') + (warnings.find((warning) => warning.code === 'FOREIGNER_NO_CPF')?.message ?? '');
  expect(results.value('out_transferCpfLine'), 'the line for someone no CPF top-up is open to').toBe(notOpenLine);
  const changed = results.value('out_transferRulesChanged');
  if (options.rulesChanged) expect(text(changed, 'note that the Rules sheet has changed')).toMatch(/^CHECK — the Rules sheet has been changed since this workbook was made\./);
  else expect(changed, 'the Rules sheet is as the workbook was made').toBeNull();
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
  'LEFT',
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
  // CT_PlotArea: the charts, then the axes (category before value here), in the order the schema lists them.
  'c:plotArea': ['c:layout', 'c:areaChart', 'c:catAx', 'c:valAx', 'c:dTable', 'c:spPr', 'c:extLst'],
  // CT_AreaChart and CT_AreaSer.
  'c:areaChart': ['c:grouping', 'c:varyColors', 'c:ser', 'c:dLbls', 'c:dropLines', 'c:axId', 'c:extLst'],
  'c:ser': ['c:idx', 'c:order', 'c:tx', 'c:spPr', 'c:pictureOptions', 'c:dPt', 'c:dLbls', 'c:trendline', 'c:errBars', 'c:cat', 'c:val', 'c:extLst'],
  'c:cat': ['c:multiLvlStrRef', 'c:numRef', 'c:numLit', 'c:strRef', 'c:strLit'],
  'c:val': ['c:numRef', 'c:numLit'],
  'c:tx': ['c:strRef', 'c:rich'],
  // CT_CatAx.
  'c:catAx': ['c:axId', 'c:scaling', 'c:delete', 'c:axPos', 'c:majorGridlines', 'c:minorGridlines', 'c:title', 'c:numFmt', 'c:majorTickMark', 'c:minorTickMark', 'c:tickLblPos', 'c:spPr', 'c:txPr', 'c:crossAx', 'c:crosses', 'c:crossesAt', 'c:auto', 'c:lblAlgn', 'c:lblOffset', 'c:tickLblSkip', 'c:tickMarkSkip', 'c:noMultiLvlLbl', 'c:extLst'],
  'c:valAx': ['c:axId', 'c:scaling', 'c:delete', 'c:axPos', 'c:majorGridlines', 'c:minorGridlines', 'c:title', 'c:numFmt', 'c:majorTickMark', 'c:minorTickMark', 'c:tickLblPos', 'c:spPr', 'c:txPr', 'c:crossAx', 'c:crosses', 'c:crossesAt', 'c:crossBetween', 'c:majorUnit', 'c:minorUnit', 'c:dispUnits', 'c:extLst'],
  'c:title': ['c:tx', 'c:layout', 'c:overlay', 'c:spPr', 'c:txPr'],
  'c:legend': ['c:legendPos', 'c:legendEntry', 'c:layout', 'c:overlay', 'c:spPr', 'c:txPr'],
  'c:scaling': ['c:logBase', 'c:orientation', 'c:max', 'c:min'],
  'c:dLbls': ['c:dLbl', 'c:delete', 'c:numFmt', 'c:spPr', 'c:txPr', 'c:dLblPos', 'c:showLegendKey', 'c:showVal', 'c:showCatName', 'c:showSerName', 'c:showPercent', 'c:showBubbleSize', 'c:separator', 'c:showLeaderLines'],
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
  it('has the nine sheets of SPEC §9 in order and opens on the Planner', async () => {
    const workbook = await buildWorkbook(2026);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(['Start', 'Planner', 'Ladder', 'Scenarios', 'Simulator', 'Monthly Plan', 'Tax Working', 'Before You Transfer', 'Rules']);
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
      if (name === 'in_minSavingRate') continue; // a formula that follows the residency: see the next test
      const location = map.inputs[name];
      const cell = workbook.getWorksheet(location.sheet)?.getCell(location.ref.replace(/\$/g, ''));
      expect(cell?.value ?? null, name).toEqual(expected[name]);
    }
    // The example's own minimum is what that formula gives for a citizen.
    expect(expected.in_minSavingRate).toBe(DEFAULT_MIN_RATE.resident);
    expect(EXAMPLE.minSavingRate).toBe(DEFAULT_MIN_RATE.resident);
    expect(EXAMPLE.salary).toBe(10_000);
    expect(EXAMPLE.salaryPeriod).toBe('per month');
    expect(EXAMPLE.unusedPtr).toBe(NO);
    const asAt = workbook.getWorksheet(map.inputs.in_asAtDate.sheet)?.getCell(map.inputs.in_asAtDate.ref.replace(/\$/g, ''));
    expect(asAt?.formula).toBe('TODAY()');
  });

  it('starts "How far down the ladder?" at the page\'s default for the residency: 7 cents, or 11.5 cents for a foreigner', async () => {
    // The same starting point as the free page (src/web/state.ts), so the paid workbook never recommends more on
    // default settings; and for a foreigner it is not below what taking SRS out costs after leaving.
    expect(DEFAULT_MIN_RATE.resident).toBe(defaultMinRate('citizen'));
    expect(DEFAULT_MIN_RATE.resident).toBe(defaultMinRate('pr'));
    expect(DEFAULT_MIN_RATE.foreigner).toBe(defaultMinRate('foreigner'));
    expect(DEFAULT_MIN_RATE.foreigner).toBeGreaterThanOrEqual(NON_RESIDENT_SRS_COST.atRetirementOrTenYears);
    expect(DEFAULT_MIN_RATE.resident).toBeLessThan(DEFAULT_MIN_RATE.foreigner);
    for (const year of [2025, 2026, 2027]) {
      const { workbook, map } = await buildWorkbookWithMap(year);
      const location = map.inputs.in_minSavingRate;
      const cell = workbook.getWorksheet(location.sheet)?.getCell(location.ref.replace(/\$/g, ''));
      // Residency 3 is the foreigner (the third item of the dropdown). The cell is an ordinary cream cell: typing a
      // rate over the formula keeps that rate whatever the residency.
      expect(cell?.formula, `${year}`).toMatch(/^IF\('Tax Working'!\$C\$\d+=3,0\.115,0\.07\)$/);
      expect(cell?.protection?.locked).toBe(false);
      expect(cell?.dataValidation?.prompt ?? '').toContain('It starts at 7.0%, or 11.5% for foreigners.');
    }
    // The buyer guide that ships with the workbook promises exactly this.
    const guide = readFileSync(join(ROOT, 'release', 'BUYER-GUIDE.md'), 'utf8').replace(/\s+/g, ' ');
    const promised = /less than ([\d.]+) cents \(([\d.]+) cents for foreigners\)/.exec(guide);
    expect(promised, 'the buyer guide states the two defaults').not.toBeNull();
    expect([Number(promised?.[1]) / 100, Number(promised?.[2]) / 100]).toEqual([DEFAULT_MIN_RATE.resident, DEFAULT_MIN_RATE.foreigner]);
    expect(guide).toContain('uses a more cautious default for foreigners');
  });

  it('marks the room for your own CPF in red only while the note beside it says NEEDED', async () => {
    const { workbook, map } = await buildWorkbookWithMap(2026);
    const planner = workbook.getWorksheet(SHEETS.planner);
    const room = parseRef(map.inputs.in_cpfSelfRoom.ref);
    const note = parseRef(map.outputs.out_note_cpfSelfRoom?.ref ?? '');
    expect(note.top).toBe(room.top);
    const formats = (planner as unknown as { conditionalFormattings: { ref: string; rules: { formulae?: unknown[] }[] }[] }).conditionalFormattings;
    const format = formats.find((candidate) => candidate.ref === `${colLetters(room.col)}${room.top}`);
    // The colour follows the words, on the same sheet, so the two cannot disagree: no longer "55 or over and blank",
    // which also marked the cell for a foreigner and for someone who had switched top-ups to themselves off.
    expect(format?.rules.map((rule) => rule.formulae)).toEqual([[`LEFT($${colLetters(note.col)}$${note.top},6)="NEEDED"`]]);
    // Spreadsheet comparisons ignore case, so no other opening of the note may begin with the same six letters.
    const formula = planner?.getCell(note.top, note.col).formula ?? '';
    const openings = (formula.match(/"(?:[^"]|"")*"/g) ?? []).map((literal) => literal.slice(1, 7).toLowerCase());
    expect(openings.filter((opening) => opening === 'needed').length, formula).toBe(1);
    // The parity profiles show when the note opens with it: exactly when the engine leaves the person's own CPF out.
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

  it('adds the savings ladder as a real chart of filled blocks, with parts in the order the file format requires', async () => {
    const built = await buildWorkbookWithMap(2026);
    expect(built.charts.length).toBe(1);
    const spec = built.charts[0];
    if (!spec) return;
    expect(spec.sheet).toBe(SHEETS.ladder);
    // The series read the chart-point columns that the parity test checks against the engine.
    const reference = (name: string): string => `${built.map.outputs[name]?.sheet}!${built.map.outputs[name]?.ref}`;
    // "Your plan" first and the rest of the ladder stacked on it: neither can hide the other, whatever the order an
    // application draws them in, and a ladder of one rung is still one filled block that ends where the plan stops.
    expect(spec.series.map((series) => series.valuesRef)).toEqual([reference('out_chart_plan'), reference('out_chart_rest')]);
    expect(new Set(spec.series.map((series) => series.color)).size, 'the two blocks have different fills').toBe(2);
    const xml = chartXml(spec);
    expectChartOrder(xml);
    expect(xml).toContain('<c:areaChart><c:grouping val="stacked"/>');
    expect((xml.match(/<a:solidFill>/g) ?? []).length, 'the series are filled').toBeGreaterThanOrEqual(4);
    // The axis is labelled at every labelEvery-th point only: those cells hold the amount as text, the rest nothing.
    expect(spec.categoriesRef).toBe(reference('out_chart_label'));
    expect(xml).toContain(`<c:tickLblSkip val="${spec.labelEvery}"/>`);
    const ladderSheet = built.workbook.getWorksheet(SHEETS.ladder);
    const labels = parseRef(built.map.outputs.out_chart_label?.ref ?? '');
    for (let i = 0; i <= built.map.sizes.chartSteps; i++) {
      const cell = ladderSheet?.getCell(labels.top + i, labels.col);
      // …and no amount at all when there is no room to draw.
      if (i % spec.labelEvery === 0) expect(cell?.formula, `label ${i}`).toMatch(/^IF\(\$[A-Z]+\$\d+=0,"",TEXT\(/);
      else expect(cell?.value, `label ${i}`).toBe('');
    }
    expect(built.map.sizes.chartSteps % spec.labelEvery, 'the last point of the axis carries a label').toBe(0);
    expect(spec.labelEvery).toBe(CHART_LABEL_EVERY);
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

  it('is the same file, byte for byte, when built twice: every part carries the same fixed date', async () => {
    const first = await workbookBuffer(await buildWorkbookWithMap(2026));
    await new Promise((done) => setTimeout(done, 2100)); // zip times have a two-second grain
    const built = await buildWorkbookWithMap(2026);
    const second = await workbookBuffer(built);
    expect(first.equals(second), 'two builds of the same workbook are identical').toBe(true);
    const zip = await JSZip.loadAsync(second);
    const dates = new Set(Object.values(zip.files).map((entry) => entry.date.toISOString()));
    expect([...dates], 'every part of the file has the one fixed date').toEqual([built.workbook.created.toISOString()]);
    expect(Object.keys(zip.files).length).toBeGreaterThan(20);
  });

  it('writes no internal code on any sheet: not as text, not in a formula', async () => {
    for (const year of [2025, 2026, 2027]) {
      const workbook = await buildWorkbook(year);
      const found: string[] = [];
      for (const ws of workbook.worksheets) {
        ws.eachRow({ includeEmpty: false }, (row) => {
          row.eachCell({ includeEmpty: false }, (cell) => {
            if (cell.isMerged && cell.master.address !== cell.address) return;
            // What is typed in, and every piece of text a formula can produce.
            const texts = cell.formula ? (cell.formula.match(/"(?:[^"]|"")*"/g) ?? []) : typeof cell.value === 'string' ? [cell.value] : [];
            for (const piece of texts) if (looksLikeCode(piece)) found.push(`${ws.name}!${cell.address} ${piece.slice(0, 60)}`);
          });
        });
      }
      expect(found, `code-like text in the ${year} workbook`).toEqual([]);
    }
    // The detector does know a code when it sees one.
    for (const code of [...WARNING_CODES, ...WORKBOOK_CHECKS, 'usefulRoom', 'reliefCap', 'leverLimits', 'cashBudget', 'cpfSelf', 'cpfFamily', 'srsOnly', 'maxAll', 'belowTaxThreshold']) {
      expect(looksLikeCode(code), code).toBe(true);
    }
    for (const words of ['MediSave', 'CHECK THE RULES SHEET FIRST', 'S$15,300 into SRS', 'CPF cash top-up, self', 'iras.gov.sg']) {
      expect(looksLikeCode(words), words).toBe(false);
    }
  });

  it('tells the same story as the web page: the same names for the schemes, the options and the order', async () => {
    // The page's own words, read from its source so that a rename there is caught here.
    const page = (await import('../src/web/text')) as {
      LEVER_NAME: Record<LeverId, string>;
      SCENARIO_NAME: Record<string, string>;
      ORDER_LABEL: Record<string, { title: string; route: string }>;
    };
    expect(LEVER_NAMES).toEqual(page.LEVER_NAME);
    expect(SCENARIO_NAMES).toEqual(page.SCENARIO_NAME);
    expect(PRIORITY_PRESETS.map((preset) => preset.label)).toEqual(Object.values(page.ORDER_LABEL).map((order) => order.title));
    expect(PRIORITY_PRESETS.map((preset) => preset.description)).toEqual(Object.values(page.ORDER_LABEL).map((order) => `${order.route}.`));

    const { workbook } = await buildWorkbookWithMap(2026);
    const column = (sheet: string, col: number): string[] => {
      const out: string[] = [];
      workbook.getWorksheet(sheet)?.eachRow((row) => {
        const value = row.getCell(col).value;
        if (typeof value === 'string') out.push(value);
      });
      return out;
    };
    // Planner: the three amounts are named as the page names the schemes; Scenarios: the page's option names.
    for (const name of Object.values(LEVER_NAMES)) expect(column(SHEETS.planner, 6), name).toContain(name);
    for (const name of Object.values(SCENARIO_NAMES)) expect(column(SHEETS.scenarios, 2), name).toContain(name);
    // The saving-per-dollar note carries the audited sentence about SRS.
    expect(column(SHEETS.planner, 8)).toContain('Tax saved this year / cash locked away. For SRS, half of what you later withdraw is taxable.');
    // No "further saving out of reach" figure anywhere: it assumes room no setting can create (SPEC §9).
    for (const ws of workbook.worksheets) {
      ws.eachRow((row) => {
        row.eachCell((cell) => {
          const shown = typeof cell.value === 'string' ? cell.value : (cell.formula ?? '');
          expect(/out of reach|unrealised/i.test(shown), `${ws.name}!${cell.address}`).toBe(false);
        });
      });
    }
  });

  it('gives each "Things to check" line room for three lines of text, and says how much text that is', async () => {
    const { workbook, map } = await buildWorkbookWithMap(2026);
    const planner = workbook.getWorksheet(SHEETS.planner);
    const range = parseRef(map.outputs.out_warnings?.ref ?? '');
    expect(range.bottom - range.top + 1).toBe(WARNING_LINES * WARNING_LINE_ROWS);
    expect(map.sizes.warningLines).toBe(WARNING_LINES);
    expect(map.sizes.warningLineRows).toBe(WARNING_LINE_ROWS);
    // Three lines of 10-point text need about 40 points; no line is shorter, whatever sits in the rows to its left.
    for (let line = 0; line < WARNING_LINES; line++) {
      let height = 0;
      for (let row = 0; row < WARNING_LINE_ROWS; row++) {
        const sheetRow = planner?.getRow(range.top + line * WARNING_LINE_ROWS + row);
        expect(sheetRow?.height ?? 0, `row ${range.top + line * WARNING_LINE_ROWS + row}`).toBeGreaterThanOrEqual(WARNING_ROW_HEIGHT);
        height += sheetRow?.height ?? 0;
      }
      expect(height, `line ${line + 1}`).toBeGreaterThanOrEqual(3 * 10 * 1.3);
      const first = planner?.getCell(range.top + line * WARNING_LINE_ROWS, range.col);
      expect(first?.isMerged, `line ${line + 1} is one merged block`).toBe(true);
      expect(first?.alignment?.wrapText, `line ${line + 1} wraps`).toBe(true);
    }
    // The block is 110 column-width units wide (columns F to H). Measured with Carlito, the metric twin of Calibri,
    // 10-point prose takes 5.4 pixels a character against 7 pixels a unit: about 143 characters a line. The limit
    // the lines are held to allows 121 a line, which leaves room for word wrap and for other fonts.
    const width = [6, 7, 8].reduce((total, col) => total + (planner?.getColumn(col).width ?? 0), 0);
    expect(width).toBe(110);
    expect(WARNING_LINE_CHARS).toBeLessThanOrEqual(Math.floor(3 * ((width * 7) / 5.4) * 0.87));
    expect(WARNING_LINE_CHARS).toBeGreaterThanOrEqual(355);
    // The lock-up block under the plan (the lines for up to three schemes, then the sentence about an earlier first
    // contribution) is the same width and font, and has the same room: three lines over its merged rows.
    const horizon = parseRef(map.outputs.out_horizon?.ref ?? '');
    let horizonHeight = 0;
    for (let row = 0; row < HORIZON_ROWS; row++) {
      const sheetRow = planner?.getRow(horizon.top + row);
      expect(sheetRow?.height ?? 0, `lock-up row ${horizon.top + row}`).toBeGreaterThanOrEqual(HORIZON_ROW_HEIGHT);
      horizonHeight += sheetRow?.height ?? 0;
    }
    expect(horizonHeight).toBeGreaterThanOrEqual(3 * 10 * 1.3);
    const horizonCell = planner?.getCell(horizon.top, horizon.col);
    expect(horizonCell?.isMerged).toBe(true);
    expect(planner?.getCell(horizon.top + HORIZON_ROWS - 1, horizon.col + 2).master.address, 'one block over the rows and the three columns').toBe(horizonCell?.address);
    expect(horizonCell?.alignment?.wrapText).toBe(true);
    expect(horizonCell?.font?.size).toBe(10);
    expect(HORIZON_CHARS).toBeLessThanOrEqual(Math.floor(3 * ((width * 7) / 5.4) * 0.87));
    expect(HORIZON_CHARS).toBeGreaterThanOrEqual(300);
  });

  it('shows the version from package.json on the Start sheet, and PROJECTED RULES on a projected year', async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(WORKBOOK_VERSION).toBe(pkg.version);
    const { workbook, map } = await buildWorkbookWithMap(2026);
    const start = workbook.getWorksheet(SHEETS.start);
    const versionCell = start?.getCell((map.outputs.out_startVersion?.ref ?? '').replace(/\$/g, ''));
    expect(versionCell?.formula).toContain(`version ${pkg.version}"`);
    // Start names the Before You Transfer sheet, and its lists are the engine's own text.
    const startText: string[] = [];
    start?.eachRow((row) => row.eachCell((cell) => typeof cell.value === 'string' && startText.push(cell.value)));
    expect(startText.some((line) => /Read the Before You Transfer sheet before you move any money/.test(line))).toBe(true);
    expect(startText).toContain('Before You Transfer');
    for (const line of NOT_MODELLED) expect(startText, line).toContain(line);
    expect(startText).toContain(DISCLAIMER);
    // The disclaimer is the engine's on every sheet that carries one.
    for (const sheet of [SHEETS.planner, SHEETS.monthly, SHEETS.transfer]) {
      const texts: string[] = [];
      workbook.getWorksheet(sheet)?.eachRow((row) => row.eachCell((cell) => typeof cell.value === 'string' && texts.push(cell.value)));
      expect(texts, sheet).toContain(DISCLAIMER);
    }
    // The header and banner formulas of the Planner switch on the status cell of the Rules sheet.
    const header = workbook.getWorksheet(SHEETS.planner)?.getCell((map.outputs.out_plannerHeader?.ref ?? '').replace(/\$/g, ''));
    expect(header?.formula).toContain('PROJECTED RULES');
    const banner = workbook.getWorksheet(SHEETS.planner)?.getCell((map.outputs.out_plannerBanner?.ref ?? '').replace(/\$/g, ''));
    expect(banner?.formula).toContain('PROJECTED RULES');
  });

  it('puts the line for someone no CPF top-up is open to straight above the lock-up table, so that print never parts them', async () => {
    for (const year of [2025, 2026, 2027]) {
      const { map } = await buildWorkbookWithMap(year);
      const line = parseRef(map.outputs.out_transferCpfLine?.ref ?? '');
      const head = parseRef(map.outputs.out_facts_head?.ref ?? '');
      // It used to sit under the nine rows of the table, which put it at the top of the second printed page.
      expect(line.top, `${year}`).toBe(head.top - 1);
      // The rows above the table are no taller than before the line moved up (128 points: "Shown for" went into the
      // title bar to make room), so the nine rows of the table still fit the first printed page.
      const { workbook } = await buildWorkbookWithMap(year);
      const sheet = workbook.getWorksheet(SHEETS.transfer);
      let above = 0;
      for (let row = 1; row <= head.top; row++) above += sheet?.getRow(row).height ?? 15;
      expect(above, `${year}: height of the rows down to the table heading`).toBeLessThanOrEqual(128);
      const shownFor = parseRef(map.outputs.out_transferShownFor?.ref ?? '');
      expect(shownFor.top, 'who the sheet is shown for is in the title row, printed on every page').toBe(1);
      expect(sheet?.pageSetup.printTitlesRow).toBe('1:1');
    }
  });

  it('names the matched top-up amounts, the payout age and the SRS ages on the Rules sheet, in the audited words', async () => {
    for (const year of [2025, 2026, 2027]) {
      const rules = getRules(year);
      const { workbook, map } = await buildWorkbookWithMap(year);
      const sheet = workbook.getWorksheet(SHEETS.rules);
      const valueOf = (name: RuleName): ExcelJS.CellValue => sheet?.getCell(map.rules[name].ref.replace(/\$/g, '')).value ?? null;
      expect(valueOf('rule_matchedRetirement')).toBe(rules.cpfTopUp.matchedTopUps.retirementAnnualCap);
      expect(valueOf('rule_matchedMediSave')).toBe(rules.cpfTopUp.matchedTopUps.mediSaveAnnualCap);
      expect(valueOf('rule_payoutAge')).toBe(rules.cpfTopUp.payoutEligibilityAge);
      expect(valueOf('rule_srsRetirementAge')).toBe(rules.srs.statutoryRetirementAge);
      expect(valueOf('rule_nonResidentSrsCost')).toBe(0.075);
      expect(valueOf('rule_nonResidentSrsCostEarly')).toBe(0.2);
      const texts: string[] = [];
      sheet?.eachRow((row) => row.eachCell((cell) => typeof cell.value === 'string' && texts.push(cell.value)));
      // Which first-contribution dates give 64, 63 and 62.
      expect(texts.some((line) => /64 if made on or after 1 July 2026, 63 if 1 July 2022 to 30 June 2026, 62 if earlier/.test(line))).toBe(true);
      // The interest floor is dated, in the engine's sentence.
      expect(texts).toContain(`At least ${rules.cpfTopUp.interestRateSmra * 100}% a year until the end of 2027, the date to which the floor has been extended.`);
      // The deadline is described in the engine's words: banks' cut-offs for SRS, the day of receipt for CPF.
      expect(texts.some((line) => line.includes('Banks stop taking same-day contributions before midnight on the last day, some as early as 7pm.'))).toBe(true);
      expect(texts.some((line) => line.includes('A top-up counts on the day the Board receives it.'))).toBe(true);
      expect(texts.some((line) => /Banks and the CPF Board can stop/.test(line)), 'no cut-off hour is put on the CPF Board').toBe(false);
      // Beside the rebate rate: what can still be announced.
      const note = sheet?.getCell(map.rules.rule_rebateNote.ref.replace(/\$/g, ''));
      expect(note?.formula).toContain('None announced for this Year of Assessment. One could still be announced at the Budget in February; if so, enter the rate here and the cap below.');
    }
  });
});

describe('the shipped release workbook', () => {
  // SGTO_RELEASE_DIR points these checks at another folder (for example a build made on a machine being set up).
  const file = join(process.env.SGTO_RELEASE_DIR ? resolve(process.env.SGTO_RELEASE_DIR) : join(ROOT, 'release'), releaseFileName(2026));

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

  it('shows the worked example of SPEC A.1 before any recalculation (required in strict mode: it must be built with LibreOffice)', async () => {
    const shipped = new ExcelJS.Workbook();
    await shipped.xlsx.readFile(file);
    const results = new Results(shipped);
    if (results.value('out_taxSaved') === null) {
      // A file built without LibreOffice still calculates when opened, but previews show empty cells. A release
      // run (SGTO_STRICT=1) must not pass with such a file in release/.
      if (STRICT) expect.fail('The release workbook has no calculated results: build it with LibreOffice installed ("npm run build:workbook").');
      console.warn('[workbook] The release file has no cached results (built without LibreOffice); it calculates when opened.');
      return;
    }
    expect(results.value('out_srs')).toBe(15_300);
    expect(results.value('out_cpfSelf')).toBe(8_000);
    expect(results.value('out_taxBefore')).toBe(6_639);
    expect(results.value('out_taxAfter')).toBe(3_959.5);
    expect(results.value('out_taxSaved')).toBe(2_679.5);
    expect(results.value('out_headline')).toBe('Put S$15,300 into SRS and S$8,000 into your CPF as a cash top-up. You save S$2,679.50 in tax.');
    expect(String(results.value('out_plannerBanner'))).toMatch(/^EXAMPLE SHOWN — /);
    expect(String(results.value('out_startVersion'))).toContain(`version ${WORKBOOK_VERSION}`);
    expect(results.errors()).toEqual([]);
    expect(results.codes()).toEqual([]);
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
  /** What each profile typed into the cream cells, and the rules its workbook was built from. */
  const cellsByName = new Map<string, Cells>();
  const builtRulesByName = new Map<string, YearRules>();
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
    // What the minimum-saving cell holds in a fresh workbook (a formula), kept before any profile types over it.
    const openingMinimum = new Map<BuiltWorkbook, ExcelJS.CellValue>();
    const remember = (fresh: BuiltWorkbook): BuiltWorkbook => {
      const location = fresh.map.inputs.in_minSavingRate;
      openingMinimum.set(fresh, fresh.workbook.getWorksheet(location.sheet)?.getCell(location.ref.replace(/\$/g, '')).value ?? null);
      return fresh;
    };
    const files: string[] = [];
    for (const [index, profile] of PROFILES.entries()) {
      const rules = profile.rules ? CUSTOM_RULES[profile.rules] : undefined;
      let built: BuiltWorkbook | undefined;
      if (profile.edit) {
        built = remember(await buildWorkbookWithMap(profile.editBase ?? 2026));
        profile.edit(ruleSetter(built));
      } else {
        const key = profile.rules ?? String(profile.input.incomeYear);
        built = builds.get(key);
        if (!built) {
          built = remember(await buildWorkbookWithMap(profile.input.incomeYear, rules ? { rules } : {}));
          builds.set(key, built);
        }
      }
      const cells = profileCells(profile);
      if (profile.untouchedMinimum) {
        // Left as the workbook opens with it: the formula that follows the residency, not a number.
        const opening = openingMinimum.get(built) ?? null;
        if (opening === null || typeof opening !== 'object' || !('formula' in opening)) throw new Error('The minimum-saving cell of a fresh workbook should hold a formula');
        cells.in_minSavingRate = { formula: opening.formula } as ExcelJS.CellFormulaValue;
      }
      writeInputs(built, cells);
      cellsByName.set(profile.name, cells);
      builtRulesByName.set(profile.name, profile.edit ? getRules(profile.editBase ?? 2026) : (rules ?? getRules(profile.input.incomeYear)));
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

  it('covers more than 300 profiles with unique names, in all three income years', () => {
    expect(PROFILES.length).toBeGreaterThan(300);
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

  it('no sheet shows an internal code, whatever is typed in (SPEC §9)', () => {
    const codes: string[] = [];
    for (const profile of PROFILES) {
      for (const found of loaded.get(profile.name)?.codes() ?? ['not recalculated']) codes.push(`${profile.name}: ${found}`);
    }
    expect(codes).toEqual([]);
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
      if (results && expected) {
        assertParity(results, expected, {
          ...(profile.checks ? { checks: profile.checks } : {}),
          ...(profile.rulesChanged ? { rulesChanged: true } : {}),
          cells: cellsByName.get(name) ?? profileCells(profile),
          builtRules: builtRulesByName.get(name) ?? expected.rules,
        });
      }
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
    const lines = (name: string): string[] => (loaded.get(name)?.column('out_warnings', WARNING_LINE_ROWS) ?? []).filter((line) => line !== null).map(String);
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
    // No line is longer than the three lines of text a Planner line has room for, and the longest messages the
    // engine has are among the profiles (so the room is not merely enough for short ones).
    let longest = 0;
    for (const profile of PROFILES) {
      for (const line of lines(profile.name)) {
        expect(line.length, `${profile.name}: ${line}`).toBeLessThanOrEqual(WARNING_LINE_CHARS);
        longest = Math.max(longest, line.length);
      }
    }
    expect(longest, 'a message longer than the 245 characters a line used to hold is exercised').toBeGreaterThan(300);
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
    // The notes beside the schemes carry the audited wording.
    expect(value('A.1 opening example', 'out_note_useSrs')).toBe(
      'Up to S$15,300 a year. Locked until the retirement age in force when you first contributed (62, 63 or 64); half of what you later withdraw is taxable.',
    );
    expect(value('A.1 opening example', 'out_note_useCpfSelf')).toBe(
      'Up to S$8,000 a year earns relief: a cash top-up to your Special or Retirement Account or MediSave, not a contribution to all three accounts. It cannot be reversed.',
    );
    expect(value('A.1 opening example', 'out_note_existingCpfFamily')).toBe(
      'Parents, parents-in-law, grandparents and grandparents-in-law; a spouse or sibling only if they earned no more than S$8,000 in the year before the top-up or have a disability. Leave out any part the Government matches.',
    );
    expect(value('A.1 opening example', 'out_note_cpfFamilyMax')).toBe(
      'Blank = up to the relief cap. Leave out what the Government matches: the first S$2,000 a year for a member on the Matched Retirement Savings Scheme, S$1,000 for MediSave.',
    );
    expect(value('2025: family top-up planned', 'out_note_cpfFamilyMax')).toBe(
      'Blank = up to the relief cap. Leave out what the Government matches: the first S$2,000 a year for a member on the Matched Retirement Savings Scheme.',
    );
    expect(value('A.1 opening example', 'out_note_residency')).toBe('This tool is for tax residents: people who stayed or worked in Singapore for at least 183 days in 2026.');
    expect(value('Foreigner, all schemes switched on', 'out_note_residency')).toBe(
      'This tool is for tax residents: people who stayed or worked in Singapore for at least 183 days in 2026. A non-resident gets no personal reliefs and no SRS relief.',
    );
    expect(value('Foreigner, all schemes switched on', 'out_note_useSrs')).toMatch(/^Up to S\$35,700 a year\./);
    expect(lines('Foreigner, all schemes switched on').join('\n')).toMatch(/You can put up to S\$35,700 a year into SRS\./);
    // A 0 in an optional cell is a figure, and the Planner says so beside the cell.
    expect(value('CPF figure of 0 (counts as a figure, not as blank)', 'out_note_cpfOverride')).toBe('Using your figure of S$0 instead of the worked-out S$20,400. Clear the cell to go back.');
    expect(value('Cash budget of zero', 'out_note_cashBudget')).toBe('A limit of S$0 means nothing is recommended. Clear the cell for no limit.');
    // Why the recommended plan stops, on the Scenarios sheet.
    const comment = (name: string): string => String(loaded.get(name)?.column('out_scen_comment')[SCENARIO_IDS.indexOf('recommended')]);
    const checkYourself = 'Has no dollars above the caps. Check your CPF room and family eligibility yourself.';
    expect(comment('A.1 opening example')).toBe(`Uses all the room in the schemes you switched on. ${checkYourself}`);
    expect(comment('A.2 older PR with a budget and the relief cap in play')).toBe(`Stops at your cash limit. ${checkYourself}`);
    expect(comment('Relief cap binds the plan')).toBe(`Stops at the overall relief cap. ${checkYourself}`);
  });

  it('words the safeguards from the rule audit as the engine does (SPEC §6.11)', () => {
    const lines = (name: string): string[] => (loaded.get(name)?.column('out_warnings', WARNING_LINE_ROWS) ?? []).filter((line) => line !== null).map(String);
    const value = (name: string, key: string): Scalar => loaded.get(name)?.value(key) ?? null;
    const codes = (name: string): string[] => expectedByName.get(name)?.warnings.map((warning) => warning.code) ?? [];

    // A foreigner on S$7,000 a month with a S$7,000 bonus: S$25,700 of the default plan saves less than leaving
    // costs; at 11.5 cents or more, none of it does.
    const low = 'Foreigner, full year, minimum 7% (S$25,700 of the plan saves less than leaving costs)';
    expect(value(low, 'out_lowValueAmount')).toBe(25_700);
    expect(value(low, 'out_srs')).toBe(35_700);
    expect(lines(low)).toContain(
      "Check — if you have left Singapore when you withdraw, SRS is taxed as a non-resident's: at least 7.5 cents per dollar withdrawn at retirement age or under the 10-year rule for foreigners, and at least 20 cents if earlier. S$25,700 of this plan saves less than 7.5 cents per dollar today.",
    );
    const none = 'Foreigner, full year, minimum 11.5% (no low-value dollars)';
    expect(value(none, 'out_lowValueAmount')).toBe(0);
    expect(value(none, 'out_srs')).toBe(10_000);
    expect(lines(none)).toContain(
      "Check — if you have left Singapore when you withdraw, SRS is taxed as a non-resident's: at least 7.5 cents per dollar withdrawn at retirement age or under the 10-year rule for foreigners, and at least 20 cents if earlier.",
    );
    // Half the year or less: the residency caution, at 5 and 6 months and not at 7; no SRS caution with SRS off.
    const residency =
      'Check — you worked here for half the year or less. You are a tax resident only if you were in Singapore for at least 183 days (IRAS has further rules for stays that span two years). Non-residents get no reliefs, so this plan would not apply.';
    expect(lines('Foreigner, 5 months worked, SRS on, minimum 7%')).toContain(residency);
    expect(lines('Foreigner, 6 months worked, SRS off, minimum 11.5%')).toContain(residency);
    expect(lines('Foreigner, 7 months worked, SRS on, minimum 7%')).not.toContain(residency);
    expect(codes('Foreigner, 6 months worked, SRS off, minimum 7%')).not.toContain('SRS_NON_RESIDENT_WITHDRAWAL');
    expect(codes('Foreigner, 6 months worked, SRS on, minimum 7%')).toEqual(expect.arrayContaining(['FOREIGNER_NO_CPF', 'TAX_RESIDENCY_CHECK', 'SRS_NON_RESIDENT_WITHDRAWAL']));
    expect(value('Foreigner, 6 months worked, SRS on, minimum 7%', 'out_lowValueAmount')).toBe(8_000);

    // From 55 a blank room is not confirmed: nothing for the person's own CPF, and the reason is the first thing said.
    for (const age of [55, 57]) {
      const blank = `Age ${age}, own CPF room blank`;
      expect(value(blank, 'out_cpfSelf'), blank).toBe(0);
      expect(value(blank, 'out_room_cpfSelf'), blank).toBe(0);
      expect(lines(blank), blank).toContain(
        'Check — from age 55 the CPF Board accepts top-ups up to the Enhanced Retirement Sum (S$440,800), but only the part up to the Full Retirement Sum (S$220,400) earns relief, and a top-up cannot be reversed. Your own CPF is left out until you enter how much you can still top up with relief (S$0 if you have set aside the Full Retirement Sum).',
      );
      expect(value(`Age ${age}, own CPF room 0`, 'out_cpfSelf')).toBe(0);
      expect(value(`Age ${age}, own CPF room 3,000`, 'out_cpfSelf')).toBe(3_000);
      // Any number confirms it, including one above the cap.
      expect(value(`Age ${age}, own CPF room 50,000`, 'out_cpfSelf')).toBe(8_000);
      expect(lines(`Age ${age}, own CPF room 3,000`)).toContain(
        'Note — from age 55, cash top-ups go to your Retirement Account and earn relief only up to the Full Retirement Sum (S$220,400 in 2026). The plan uses the room you entered (S$3,000); check it against your CPF Retirement dashboard.',
      );
      expect(codes(`Age ${age}, own CPF room 0`)).toContain('AGE_55_PLUS_TOPUP');
      expect(codes(blank)).not.toContain('AGE_55_PLUS_TOPUP');
    }
    // Below 55 a blank room still means "not limiting", and neither line appears.
    expect(value('Age 54, own CPF room blank', 'out_cpfSelf')).toBe(8_000);
    expect(value('Age 54, own CPF room 3,000', 'out_cpfSelf')).toBe(3_000);
    expect(codes('Age 54, own CPF room blank')).not.toContain('CPF_SELF_ROOM_UNCONFIRMED');
    expect(codes('Age 54, own CPF room 50,000')).not.toContain('AGE_55_PLUS_TOPUP');
    // The Planner's own words while the room is awaited.
    const waiting = 'Age 57, room blank, only own CPF switched on (nothing can go in yet)';
    expect(value(waiting, 'out_headline')).toBe('Nothing to put in yet.');
    expect(value(waiting, 'out_reason')).toBe(
      'Nothing can be contributed yet: your own CPF is left out until you enter its room, and no other scheme you switched on has room left.',
    );
    // By hand: at 57 the employee CPF is 18% (S$18,360) and Earned Income Relief S$6,000, so chargeable income is
    // 135,000 − 29,360 = 105,640 and tax 3,350 + 11.5% × 25,640 = 6,298.60. With SRS and the family top-up switched
    // on (23,300) it would be 82,340 → 3,619.10: S$2,679.50 less.
    expect(lines(waiting)[0]).toBe(
      'Note — nothing can be contributed yet: your own CPF is left out until you enter its room, and no other scheme you switched on has room left. Switching on the schemes you left off could save up to S$2,679.50 more tax.',
    );
    // The Ladder sheet says the same, not "switch a scheme on": the scheme is on, and its room is what is missing.
    expect(value(waiting, 'out_ladderNote')).toBe(
      'Your own CPF is left out until you enter how much you can still top up with relief, and nothing else you switched on has room left, so there is no ladder to show yet. Enter the figure on the Planner.',
    );
    expect(value('Age 57, room blank, existing SRS and family at their caps (nothing can go in yet)', 'out_ladderNote')).toBe(value(waiting, 'out_ladderNote'));
    // Every scheme already full is neither "nothing switched on" nor "waiting for the room".
    expect(value('Existing contributions exactly at every cap', 'out_ladderNote')).toBe('The schemes you switched on have no room left this year, so there is no ladder to show.');
    expect(value('Nothing switched on', 'out_ladderNote')).toBe('No scheme is switched on, so there is no ladder to show. Switch on SRS or a CPF top-up on the Planner.');
    expect(value('Foreigner aged 17: nothing open to them', 'out_ladderNote')).toBe('None of the schemes you switched on is open to you, so there is no ladder to show.');
    expect(String(value('A.1 opening example', 'out_ladderNote'))).toMatch(/^How to read it: /);
    // With no room the chart has no figures under its axis (it used to print "0" eleven times).
    expect(loaded.get(waiting)?.column('out_chart_label').every((label) => label === null)).toBe(true);
    expect(loaded.get('A.1 opening example')?.column('out_chart_label').filter((label) => label !== null)).toEqual([
      '0', '2,500', '5,000', '7,500', '10,000', '12,500', '15,000', '17,500', '20,000', '22,500', '25,000',
    ]);

    // The room cell asks only those it concerns. While it is needed: 55 or over, open to them, switched on, blank.
    const LABEL = 'Top-up to your own CPF that can still earn relief (S$';
    expect(value(waiting, 'out_label_cpfSelfRoom')).toBe(`${LABEL}) — NEEDED from age 55`);
    expect(value(waiting, 'out_note_cpfSelfRoom')).toBe(
      'NEEDED from age 55: your own CPF is left out of the plan until you enter this. Your CPF Retirement dashboard shows it; enter 0 if you have set aside the Full Retirement Sum.',
    );
    // A foreigner of 57 with "Use CPF cash top-up, self?" at Yes: CPF top-ups are not open to them, so nothing is needed.
    const notOpen = 'Foreigner aged 57, own CPF switched on, room blank (not open to them: nothing is needed)';
    expect(value(notOpen, 'out_note_cpfFamilyMax')).toBe('Not used: family top-ups are not open to you.');
    expect(expectedByName.get(notOpen)?.levers.cpfSelf).toMatchObject({ eligible: false, enabled: true });
    expect(value(notOpen, 'out_label_cpfSelfRoom')).toBe(`${LABEL}) — not used`);
    expect(value(notOpen, 'out_note_cpfSelfRoom')).toBe('Not used: CPF top-ups are not open to you.');
    expect(value('Foreigner aged 57, a room typed in all the same (not used)', 'out_note_cpfSelfRoom')).toBe('Not used: CPF top-ups are not open to you.');
    // Someone of 55 who chose No for their own CPF: asked for only if they switch it on.
    const off = 'Age 55, own CPF switched off, room blank (needed only if switched on)';
    expect(value(off, 'out_label_cpfSelfRoom')).toBe(`${LABEL}) — needed if switched on`);
    expect(value(off, 'out_note_cpfSelfRoom')).toBe(
      'From age 55 this is asked for only if you switch on top-ups to your own CPF (the row above). Your CPF Retirement dashboard shows it; enter 0 if you have set aside the Full Retirement Sum.',
    );
    expect(value('Age 55, own CPF switched off, room 2,000 entered', 'out_label_cpfSelfRoom')).toBe(`${LABEL}, needed from age 55)`);
    expect(value('Age 57, own CPF room 3,000', 'out_label_cpfSelfRoom')).toBe(`${LABEL}, needed from age 55)`);
    expect(value('Age 54, own CPF room blank', 'out_label_cpfSelfRoom')).toBe(`${LABEL}, optional)`);
    // …and across every profile the word NEEDED appears exactly when the engine leaves the person's own CPF out.
    let needed = 0;
    for (const profile of PROFILES) {
      const expected = expectedByName.get(profile.name);
      if (!expected) continue;
      const says = String(value(profile.name, 'out_note_cpfSelfRoom')).startsWith('NEEDED');
      expect(says, profile.name).toBe(codes(profile.name).includes('CPF_SELF_ROOM_UNCONFIRMED'));
      if (says) needed++;
    }
    expect(needed).toBeGreaterThanOrEqual(10);

    // SRS alone: 105,640 − 15,300 = 90,340 → 3,350 + 11.5% × 10,340 = 4,539.10, saving 1,759.50.
    expect(value('Age 57, room blank, own CPF switched off (no room question)', 'out_headline')).toBe('Put S$15,300 into SRS. You save S$1,759.50 in tax.');
    // A S$4,000 cash limit: tax at 101,640 is 5,838.60; lifting the limit reaches SRS's 15,300 and 4,539.10.
    expect(String(value('Age 57, room blank, cash limit stops the plan', 'out_reason'))).toBe(
      'Your cash limit of S$4,000 is used up. With more cash you could save up to S$1,299.50 more. Your own CPF is left out until you enter how much you can still top up with relief.',
    );

    // Family top-ups: the matched part, with the MediSave figure only in a year that has one.
    const family2026 =
      'Check — family top-ups: the part the Government matches earns you no relief — the first S$2,000 a year for a member on the Matched Retirement Savings Scheme, S$1,000 for MediSave. The amounts here are top-ups beyond that, to a family member who qualifies.';
    const family2025 =
      'Check — family top-ups: the part the Government matches earns you no relief — the first S$2,000 a year for a member on the Matched Retirement Savings Scheme. The amounts here are top-ups beyond that, to a family member who qualifies.';
    expect(lines('2026: family top-up planned')).toContain(family2026);
    expect(lines('2026: family top-up already made, none planned')).toContain(family2026);
    expect(lines('2025: family top-up planned')).toContain(family2025);
    expect(lines('2025: family top-up already made, none planned')).toContain(family2025);
    for (const year of [2025, 2026]) expect(codes(`${year}: family switched on but nothing planned or made`)).not.toContain('FAMILY_TOPUP_CHECKS');

    // The tick-box.
    expect(lines('Unused Parenthood Tax Rebate ticked')).toContain(
      'Check — with unused Parenthood Tax Rebate your tax bill this year may already be S$0. This plan would then save no cash now: it makes the rebate last longer, so the benefit arrives in a later year.',
    );
    expect(codes('RAW blank Parenthood Tax Rebate cell (means No)')).not.toContain('PARENTHOOD_TAX_REBATE');

    // The deadline caution names only the cut-off of a scheme that is in the plan.
    const lead = 'Check — only 11 days left until the 31 December 2026 deadline. ';
    expect(lines('Deadline soon: SRS and CPF in the plan')).toContain(
      `${lead}Banks stop taking same-day SRS contributions before midnight on the last day, some as early as 7pm, and a CPF top-up counts on the day the CPF Board receives it, so transfer as soon as you can.`,
    );
    expect(lines('Deadline soon: SRS only in the plan')).toContain(
      `${lead}Banks stop taking same-day SRS contributions before midnight on the last day, some as early as 7pm, so transfer as soon as you can.`,
    );
    expect(lines('Deadline soon: CPF only in the plan')).toContain(`${lead}A CPF top-up counts on the day the CPF Board receives it, so transfer as soon as you can.`);
    expect(String(value('Deadline soon: SRS only in the plan', 'out_monthlyBanner'))).not.toMatch(/CPF/);
    expect(String(value('Deadline soon: CPF only in the plan', 'out_monthlyBanner'))).not.toMatch(/Banks/);
    expect(value('Deadline day: SRS only in the plan', 'out_monthlyBanner')).toBe(
      'Today is the deadline. Banks stop taking same-day SRS contributions before midnight on the last day, some as early as 7pm, so transfer now.',
    );
    // An employee CPF figure above the maximum: the audited ending.
    expect(lines('CPF override above the maximum').some((line) => line.endsWith("Voluntary contributions to your three CPF accounts earn no relief; a cash top-up to your MediSave, Special or Retirement Account does — enter it under 'Already contributed'."))).toBe(true);
  });

  it('reproduces SPEC Appendix A.2b: the same person with the CPF room left blank', () => {
    const r = loaded.get('A.2b the same person with the CPF room left blank');
    const expected = expectedByName.get('A.2b the same person with the CPF room left blank');
    expect(r).toBeDefined();
    if (!r || !expected) return;
    expect([r.value('out_room_srs'), r.value('out_room_cpfSelf'), r.value('out_room_cpfFamily')]).toEqual([10_300, 0, 8_000]);
    expect([r.value('out_usefulRoom'), r.value('out_reliefCapRoom'), r.value('out_leverRoom')]).toEqual([128_640, 20_640, 18_300]);
    expect(r.value('out_total')).toBe(18_300);
    expect(BINDING_NUMBERS[Number(r.value('out_bindingNumber'))]).toBe('leverLimits');
    expect([r.value('out_srs'), r.value('out_cpfFamily'), r.value('out_cpfSelf')]).toEqual([10_300, 8_000, 0]);
    expect(r.value('out_opt_ci')).toBe(130_340);
    expect(r.value('out_taxAfter')).toBe(9_501);
    expect(r.value('out_taxSaved')).toBe(2_745);
    expect(expected.warnings.map((warning) => warning.code)).toEqual(['LEVER_LIMITS_PLAN', 'CPF_SELF_ROOM_UNCONFIRMED', 'FAMILY_TOPUP_CHECKS']);
    const shown = r.column('out_warnings', WARNING_LINE_ROWS).filter((line) => line !== null).map(String);
    expect(shown.length).toBe(3);
    expect(shown[0]).toMatch(/^Note — the plan uses all S\$18,300 of room left in the schemes you switched on\./);
    expect(shown[1]).toMatch(/^Check — from age 55 the CPF Board accepts top-ups up to the Enhanced Retirement Sum \(S\$440,800\)/);
    expect(shown[2]).toMatch(/^Check — family top-ups: the part the Government matches earns you no relief/);
    expect(r.value('out_headline')).toBe("Put S$10,300 into SRS and S$8,000 into family members' CPF as a cash top-up. You save S$2,745.00 in tax.");
    expect(r.value('out_horizon')).toBe(
      `SRS: locked until 64, about 7 years. Family top-up: You cannot take it back. A top-up cannot be reversed. ${earlierContributionNote(64)}`,
    );
  });

  it('reads a yearly salary exactly as the web page does: twelve equal months, the left-over dollars with the extra pay', () => {
    const value = (name: string, key: string): Scalar => loaded.get(name)?.value(key) ?? null;
    // S$100,000 a year: S$8,333 a month and S$4 over, which joins the S$15,000 bonus.
    const even = 'Per year: S$100,000 (S$4 left over)';
    expect(value(even, 'out_monthlyWageUsed')).toBe(8_333);
    expect(value(even, 'out_salaryLeftOver')).toBe(4);
    expect(value(even, 'out_additionalWagesUsed')).toBe(15_004);
    expect(value(even, 'out_employmentIncome')).toBe(115_000);
    expect(value(even, 'out_note_salary')).toBe(
      'A yearly salary is split into twelve equal months of whole dollars. The S$4 left over is counted with your bonus, so your income is right to the dollar.',
    );
    // Five months of a S$100,000 salary: S$41,666 earned, S$41,665 in whole months, S$1 over.
    const part = 'Per year: S$100,000 over 5 months (S$1 left over)';
    expect(value(part, 'out_monthlyWageUsed')).toBe(8_333);
    expect(value(part, 'out_salaryLeftOver')).toBe(1);
    expect(value(part, 'out_employmentIncome')).toBe(41_666);
    // Divides by 12: nothing over, and the same result as S$10,000 a month.
    const whole = 'Per year: S$120,000 (divides by 12)';
    expect(value(whole, 'out_salaryLeftOver')).toBe(0);
    expect(value(whole, 'out_taxSaved')).toBe(2_679.5);
    expect(value(whole, 'out_note_salary')).toBe('A yearly salary is split into twelve equal months of whole dollars.');
    expect(value('Per year: S$11 (less than a dollar a month)', 'out_monthlyWageUsed')).toBe(0);
    expect(value('Per year: S$11 (less than a dollar a month)', 'out_salaryLeftOver')).toBe(11);
    // The engine inputs behind these profiles are the page's own split (src/web/state.ts).
    for (const profile of PROFILES) {
      if (!profile.perYear) continue;
      const months = profile.input.income.monthsWorked ?? 12;
      const ui = { payMode: 'annual' as const, salary: profile.perYear.salary, monthsWorked: months };
      expect(value(profile.name, 'out_monthlyWageUsed'), profile.name).toBe(monthlyWage(ui));
      expect(value(profile.name, 'out_salaryLeftOver'), profile.name).toBe(oddPay(ui));
      expect(value(profile.name, 'out_employmentIncome'), profile.name).toBe(Math.floor((profile.perYear.salary * months) / 12) + profile.perYear.bonus);
    }
    expect(PROFILES.filter((profile) => profile.perYear && profile.perYear.salary % 12 !== 0).length).toBeGreaterThanOrEqual(5);
    // Typed per month, the note says how to switch.
    expect(String(value('A.1 opening example', 'out_note_salary'))).toMatch(/choose "per year" beside the figure\.$/);
  });

  it('names the example figures still in use, instead of switching the example notice off after one edit', () => {
    const banner = (name: string): string => String(loaded.get(name)?.value('out_plannerBanner'));
    expect(banner('A.1 opening example')).toMatch(/^EXAMPLE SHOWN — age 35, S\$10,000 a month, S\$15,000 bonus, S\$5,000 other reliefs\./);
    expect(banner('Only the salary changed (S$8,500 a month)')).toMatch(/^Still using the example's age, bonus and other reliefs\./);
    expect(banner('Only the age and the other reliefs changed')).toMatch(/^Still using the example's salary and bonus\./);
    expect(banner('Cash budget of zero')).toMatch(/^Still using the example's age, salary, bonus and other reliefs\./);
    // One figure left is "it", not "them".
    expect(banner("Only the age is still the example's")).toBe("Still using the example's age. Type your own over it; leave it if it happens to be right for you.");
    expect(banner('Only the age and the other reliefs changed')).toBe(
      "Still using the example's salary and bonus. Type your own over them; leave any that happens to be right for you.",
    );
    expect(banner('Per year: S$120,000 (divides by 12)')).toMatch(/^Still using the example's age, bonus and other reliefs\./);
    expect(banner('A.2 older PR with a budget and the relief cap in play')).toMatch(/^Your figures — /);
    expect(banner('2027: the example, planned from 2026')).toMatch(/^PROJECTED RULES — the 2027 figures are provisional and may change\. EXAMPLE SHOWN — /);
    expect(String(loaded.get('2027: the example, planned from 2026')?.value('out_plannerHeader'))).toBe('Year of Assessment 2028 · PROJECTED RULES · estimate only, not tax advice');
  });

  it('Before You Transfer shows exactly the engine\'s text for every case the wording depends on', () => {
    const seen = new Set<string>();
    const texts = new Map<string, string>();
    for (const residency of ['citizen', 'pr', 'foreigner'] as const) {
      for (const age of [40, 60]) {
        for (const today of ['2026-11-13', '2027-01-05']) {
          const name = `Before You Transfer: ${residency}, age ${age}, as at ${today}`;
          const r = loaded.get(name);
          const expected = expectedByName.get(name);
          expect(r, name).toBeDefined();
          expect(expected, name).toBeDefined();
          if (!r || !expected) continue;
          const rules = getRules(2026);
          const who = { residency, ageAtYearEnd: age };
          const passed = today > rules.contributionDeadline;
          expect(expected.monthlyPlan.daysToDeadline < 0, name).toBe(passed);
          const facts = lockUpFacts(rules, who);
          const open = (lever: LeverId): boolean => lever === 'srs' || residency !== 'foreigner';
          for (const lever of LEVERS) {
            expect(r.column(`out_facts_${lever}`), `${name}: ${lever}`).toEqual(facts.map((row) => (open(lever) ? row.values[lever] : null)));
          }
          const cautions = transferCautions(rules, who, { deadlinePassed: passed });
          expect(r.column('out_cautions').filter((cell) => cell !== null), name).toEqual(cautions);
          expect(String(r.value('out_transferShownFor')), name).toBe(
            `Shown for: ${RESIDENCY_LABELS[residency]}, ${age >= 55 ? 'aged 55 or over' : 'below 55'}, income year 2026${passed ? ' (the deadline has passed)' : ''}.`,
          );
          // A foreigner sees SRS only, with the one line saying CPF top-ups are not open to them.
          expect(r.value('out_transferCpfLine'), name).toBe(
            residency === 'foreigner'
              ? 'Foreigners on work passes do not contribute to CPF, so there is no CPF relief and CPF top-ups do not earn tax relief. You can put up to S$35,700 a year into SRS.'
              : null,
          );
          seen.add(`${residency === 'foreigner' ? 'foreigner' : 'resident'}/${age >= 55}/${passed}`);
          texts.set(name, JSON.stringify([facts, cautions]));
        }
      }
    }
    // Residency (citizen or PR against foreigner) × below 55 or not × deadline passed or not: all eight, and the
    // engine's wording really does differ along each of the three.
    expect(seen.size).toBe(8);
    const of = (residency: string, age: number, today: string): string => texts.get(`Before You Transfer: ${residency}, age ${age}, as at ${today}`) ?? '';
    expect(of('citizen', 40, '2026-11-13')).toBe(of('pr', 40, '2026-11-13'));
    expect(of('citizen', 40, '2026-11-13')).not.toBe(of('foreigner', 40, '2026-11-13'));
    expect(of('citizen', 40, '2026-11-13')).not.toBe(of('citizen', 60, '2026-11-13'));
    expect(of('citizen', 40, '2026-11-13')).not.toBe(of('citizen', 40, '2027-01-05'));
    // Other years carry their own figures: 2025 has no Matched MediSave Scheme.
    const r2025 = loaded.get('2025: family top-up planned');
    expect(r2025?.column('out_facts_cpfFamily')).toEqual(lockUpFacts(getRules(2025), { residency: 'citizen', ageAtYearEnd: 35 }).map((row) => row.values.cpfFamily));
    expect(String(r2025?.column('out_facts_cpfFamily').join(' '))).not.toMatch(/Matched MediSave/);
    // Typing a new year over the Rules sheet cannot rewrite the sentences, so the sheet says so.
    const retyped = loaded.get('Typed on Rules: income year 2027 (the deadline follows the year)');
    expect(String(retyped?.value('out_transferRulesChanged'))).toBe(
      'CHECK — the Rules sheet has been changed since this workbook was made. The sentences below still quote the figures for income year 2026 as issued: read them against the Rules sheet.',
    );
  });

  it('says the same as the web page: its own sentence, lock-up line and affordability note for every profile', async () => {
    const page = (await import('../src/web/text')) as {
      headline: (result: PlannerResult) => string;
      horizonLines: (result: PlannerResult) => string[];
      horizonNote: (result: PlannerResult) => string;
      affordabilityNote: (result: PlannerResult) => { amount: number; text: string } | null;
    };
    let notes = 0;
    let tenYearRule = 0;
    let earlierContribution = 0;
    for (const profile of PROFILES) {
      const expected = expectedByName.get(profile.name);
      const r = loaded.get(profile.name);
      // The page only knows the registered years' own rules; profiles with edited rules are held to SPEC wording above.
      if (!expected || !r || profile.rules || profile.compare === false) continue;
      expect(r.value('out_headline'), profile.name).toBe(page.headline(expected));
      // The lock-up lines, then the sentence the page puts straight after them (its card shows neither once the
      // deadline has passed). The Planner shows the two together; the working cells hold each on its own.
      const past = expected.monthlyPlan.daysToDeadline < 0;
      const lines = past ? '' : page.horizonLines(expected).join(' ');
      const after = past ? '' : page.horizonNote(expected);
      expect(r.value('out_horizonLines') ?? '', profile.name).toBe(lines);
      expect(r.value('out_horizonNote') ?? '', profile.name).toBe(after);
      expect(r.value('out_horizon') ?? '', profile.name).toBe([lines, after].filter((sentence) => sentence !== '').join(' '));
      if (/10-year rule for foreigners/.test(lines)) tenYearRule++;
      if (after !== '') earlierContribution++;
      const note = page.affordabilityNote(expected);
      const shown = r.value('out_affordability');
      if (note) {
        notes++;
        expect(String(shown).startsWith(`${note.text} `), `${profile.name}: ${String(shown)}`).toBe(true);
      } else {
        expect(shown, profile.name).toBeNull();
      }
    }
    expect(notes, 'profiles with an instalment above the monthly salary').toBeGreaterThan(10);
    expect(tenYearRule, 'foreigners whose SRS line names the 10-year rule').toBeGreaterThan(10);
    expect(earlierContribution, 'plans that say an earlier first contribution may have set a lower age').toBeGreaterThan(100);
    // In full, for the rule audit's foreigner and for the opening example.
    expect(loaded.get('Foreigner, full year, minimum 11.5% (no low-value dollars)')?.value('out_horizon')).toBe(
      `SRS: locked until 64, about 32 years, or until you can use the 10-year rule for foreigners if that comes first. ${earlierContributionNote(64)}`,
    );
    expect(loaded.get('A.1 opening example')?.value('out_horizon')).toBe(
      `SRS: locked until 64, about 29 years. CPF: paid out monthly from 65, about 30 years. ${earlierContributionNote(64)}`,
    );
    // An age already reached is not "or until…", and nobody who has reached it is told their age may be lower.
    expect(loaded.get('Age 66: both ages already reached, family first')?.value('out_horizonNote') ?? '').toBe('');
  });

  it('opens on the same plan as the web page for a foreigner: the minimum starts at 11.5 cents, not 7', () => {
    const value = (name: string, key: string): Scalar => loaded.get(name)?.value(key) ?? null;
    // The rule audit's foreigner (S$7,000 a month, S$7,000 bonus) with the minimum cell left alone: S$10,000 into
    // SRS, the 11.5% rung only. At a citizen's 7 cents it would be S$35,700, of which S$25,700 would be a loss on
    // leaving — the workbook must not open on that.
    const cautious = 'Minimum untouched: foreigner on S$7,000 a month (starts at 11.5 cents)';
    expect(expectedByName.get(cautious)?.input.preferences.minSavingRate).toBe(0.115);
    expect(value(cautious, 'in_minSavingRate')).toBe(0.115);
    expect(value(cautious, 'out_srs')).toBe(10_000);
    expect(value(cautious, 'out_taxSaved')).toBe(1_150);
    expect(value(cautious, 'out_lowValueAmount')).toBe(0);
    expect(value(cautious, 'out_headline')).toBe('Put S$10,000 into SRS. You save S$1,150.00 in tax.');
    // The reason names the figure and where it is, and does not say the person set it.
    expect(value(cautious, 'out_reason')).toBe('Beyond this, each extra dollar would save 7 cents or less, below the 11.5 cents minimum set on the Planner.');
    expect(value(cautious, 'out_note_minSavingRate')).toBe(
      '11.5 cents or more: the plan uses only dollars that each save at least that much tax. For a foreigner this cell starts at 11.5 cents: taking SRS out after leaving Singapore costs at least 7.5 cents per dollar in tax.',
    );
    // A citizen and a PR still start at 7 cents, and the untouched example is the example.
    const example = 'Minimum untouched: the example as the file opens';
    expect(value(example, 'in_minSavingRate')).toBe(0.07);
    expect(value(example, 'out_taxSaved')).toBe(2_679.5);
    expect(String(value(example, 'out_plannerBanner'))).toMatch(/^EXAMPLE SHOWN — /);
    expect(value('Minimum untouched: PR in the 2nd year, all schemes switched on', 'in_minSavingRate')).toBe(0.07);
    // A rate the person types stays, whatever the residency: 7% typed by a foreigner is still honoured, with the caution.
    const typed = 'Foreigner, full year, minimum 7% (S$25,700 of the plan saves less than leaving costs)';
    expect(value(typed, 'in_minSavingRate')).toBe(0.07);
    expect(value(typed, 'out_srs')).toBe(35_700);
    expect(String(value(typed, 'out_note_minSavingRate'))).toMatch(/so a smaller saving would be a loss: choose a higher minimum\.$/);
    // Every profile that leaves the cell alone is held to the page's default for its residency.
    const left = PROFILES.filter((profile) => profile.untouchedMinimum);
    expect(left.length).toBeGreaterThanOrEqual(6);
    for (const profile of left) {
      const residency = profile.input.profile.residency;
      expect(profile.input.preferences.minSavingRate, profile.name).toBe(defaultMinRate(residency));
      expect(value(profile.name, 'in_minSavingRate'), profile.name).toBe(residency === 'foreigner' ? 0.115 : 0.07);
    }
    expect(new Set(left.map((profile) => profile.input.incomeYear))).toEqual(new Set([2025, 2026, 2027]));
  });

  it('can store its results as at a given day, so that a release file can be reproduced byte for byte on a later day', async () => {
    // The results stored in the file are worked out for the day of the build, so a build on another day differs in
    // them. Given the day (SGTO_AS_AT=2026-12-20 on the command line), two builds are the same file again.
    const asAt = new Date(Date.UTC(2026, 11, 20));
    const first = await writeRelease(2026, join(workDir, 'pinned-a'), { asAt });
    const second = await writeRelease(2026, join(workDir, 'pinned-b'), { asAt });
    expect(readFileSync(first).equals(readFileSync(second)), 'two builds as at the same day are identical').toBe(true);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(first);
    const results = new Results(workbook);
    // Eleven days before the deadline: the stored results are that day's, cut-off caution included…
    expect(results.value('out_daysToDeadline')).toBe(11);
    expect(String(results.value('out_monthlyBanner'))).toMatch(/^Only 11 days left\./);
    expect(results.column('out_warnings', WARNING_LINE_ROWS).filter((line) => line !== null).map(String).some((line) => line.startsWith('Check — only 11 days left until the 31 December 2026 deadline.'))).toBe(true);
    expect(results.value('out_taxSaved')).toBe(2_679.5);
    expect(results.errors()).toEqual([]);
    // …but the cell itself is still =TODAY(): opened in a spreadsheet application, the file is as at that day.
    const fresh = await buildWorkbookWithMap(2026);
    const location = fresh.map.inputs.in_asAtDate;
    const cell = workbook.getWorksheet(location.sheet)?.getCell(location.ref.replace(/\$/g, ''));
    expect(cell?.formula).toBe('TODAY()');
    expect(cell?.result).toEqual(asAt);
    // The day is given as YYYY-MM-DD; anything else is refused rather than guessed at.
    expect(pinnedAsAt('2026-11-13')).toEqual(new Date(Date.UTC(2026, 10, 13)));
    expect(pinnedAsAt('')).toBeNull();
    for (const bad of ['13/11/2026', '2026-02-30', '2026-11', 'today']) expect(() => pinnedAsAt(bad), bad).toThrow(RangeError);
  }, 240_000);

  it('follows the income year when it is typed over, and says so when the deadline is left behind', () => {
    const followed = loaded.get('Typed on Rules: income year 2027 (the deadline follows the year)');
    const deadline = followed?.value('out_deadline');
    expect(deadline instanceof Date ? deadline.toISOString().slice(0, 10) : deadline).toBe('2027-12-31');
    expect(followed?.column('out_workbookCheckFlags')).toEqual([0, 0]);
    expect(String(followed?.value('out_monthlyBanner'))).toMatch(/^Set aside the amounts below in each of the 2 months left/);

    const stale = loaded.get("Typed on Rules: income year 2027 with last year's deadline typed in (check line)");
    const first = String(stale?.column('out_warnings', WARNING_LINE_ROWS)[0]);
    expect(first).toBe(
      'Check — the last contribution day on the Rules sheet (31 December 2026) is not in income year 2027. Correct it there: it is normally 31 December of the income year. The days left and the deadline messages depend on it.',
    );
    expect(String(stale?.value('out_plannerBanner'))).toMatch(/^CHECK THE RULES SHEET FIRST/);
    // The banner over the instalments no longer says "no instalments are shown" above a list of instalments.
    expect(String(stale?.value('out_monthlyBanner'))).toMatch(/^The deadline for 2027 passed on 31 December 2026\. The amounts below are listed only because the year has not ended/);
    expect(stale?.column('out_sched_total').filter((total) => total !== null).length).toBe(2);

    const cleared = loaded.get('Typed on Rules: the deadline cleared (31 December is used, with a check line)');
    expect(String(cleared?.column('out_warnings', WARNING_LINE_ROWS)[0])).toMatch(/^Check — the last contribution day on the Rules sheet \(not a date\) is not in income year 2026\./);
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
      expect(String(r?.column('out_warnings', WARNING_LINE_ROWS)[0]), name).toMatch(/^Check — the tax table on the Rules sheet needs fixing: .* Until it is fixed, the figures on every sheet may be wrong\.$/);
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
    expect(r.value('out_base_ci')).toBe(108_600);
    expect(r.value('out_taxBefore')).toBe(6_639);
    expect(r.value('out_usefulRoom')).toBe(68_600);
    expect(r.value('out_reliefCapRoom')).toBe(53_600);
    expect(r.value('out_leverRoom')).toBe(23_300);
    expect(r.value('out_total')).toBe(23_300);
    expect(BINDING_NUMBERS[Number(r.value('out_bindingNumber'))]).toBe('leverLimits');
    expect(r.value('out_srs')).toBe(15_300);
    expect(r.value('out_cpfSelf')).toBe(8_000);
    expect(r.value('out_opt_ci')).toBe(85_300);
    expect(r.value('out_taxAfter')).toBe(3_959.5);
    expect(r.value('out_taxSaved')).toBe(2_679.5);
    expect(r.value('out_savingRate')).toBeCloseTo(0.115, 12);
    expect(r.column('out_ladder_amount').filter((v) => v !== null)).toEqual([23_300]);
    expect(r.column('out_sched_srs').filter((v) => v !== null)).toEqual([7_650, 7_650]);
    expect(r.column('out_sched_cpfSelf').filter((v) => v !== null)).toEqual([4_000, 4_000]);
    expect(r.value('out_reason')).toBe('You have used all the room in the schemes you switched on. S$5,300 of your income is still taxed at 11.5%.');
    // 31,300 of room with family top-ups switched on as well: chargeable income 77,300, tax 3,161.00.
    expect(r.value('out_savingIfSwitchedOn')).toBe(798.5);
    expect(r.column('out_warnings', WARNING_LINE_ROWS).filter((v) => v !== null)).toEqual([
      'Note — the plan uses all S$23,300 of room left in the schemes you switched on. Switching on the schemes you left off could save up to S$798.50 more tax.',
    ]);
    expect(r.value('out_headline')).toBe('Put S$15,300 into SRS and S$8,000 into your CPF as a cash top-up. You save S$2,679.50 in tax.');
    expect(r.value('out_horizon')).toBe(`SRS: locked until 64, about 29 years. CPF: paid out monthly from 65, about 30 years. ${earlierContributionNote(64)}`);
  });

  it('reproduces SPEC Appendix A.2 to the cent', () => {
    const r = loaded.get('A.2 older PR with a budget and the relief cap in play');
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.value('out_employeeCpf')).toBe(18_360);
    expect(r.value('out_employmentIncome')).toBe(208_000);
    expect(r.value('out_base_totalBeforeCap')).toBe(59_360);
    expect(r.value('out_base_ci')).toBe(148_640);
    expect(r.value('out_taxBefore')).toBe(12_246);
    expect([r.value('out_room_srs'), r.value('out_room_cpfSelf'), r.value('out_room_cpfFamily')]).toEqual([10_300, 8_000, 8_000]);
    expect([r.value('out_usefulRoom'), r.value('out_reliefCapRoom'), r.value('out_leverRoom')]).toEqual([128_640, 20_640, 26_300]);
    expect(r.value('out_total')).toBe(20_000);
    expect(BINDING_NUMBERS[Number(r.value('out_bindingNumber'))]).toBe('cashBudget');
    expect([r.value('out_cpfSelf'), r.value('out_srs'), r.value('out_cpfFamily')]).toEqual([8_000, 10_300, 1_700]);
    expect(r.value('out_taxAfter')).toBe(9_246);
    expect(r.value('out_taxSaved')).toBe(3_000);
    expect(r.column('out_ladder_amount').filter((v) => v !== null)).toEqual([20_640, 5_660]);
    expect(r.column('out_ladder_taxSaved').filter((v) => v !== null)).toEqual([3_096, 0]);
    expect(r.column('out_ladder_reason')).toContain(ZERO_REASON_NUMBERS.reliefCap);
    // Warnings in the order of SPEC Appendix A.2.
    expect(expectedByName.get('A.2 older PR with a budget and the relief cap in play')?.warnings.map((warning) => warning.code)).toEqual(['BUDGET_LIMITS_PLAN', 'AGE_55_PLUS_TOPUP', 'FAMILY_TOPUP_CHECKS']);
    expect(r.column('out_warnings', WARNING_LINE_ROWS).filter((line) => line !== null)[1]).toBe(
      'Note — from age 55, cash top-ups go to your Retirement Account and earn relief only up to the Full Retirement Sum (S$220,400 in 2026). The plan uses the room you entered (S$50,000); check it against your CPF Retirement dashboard.',
    );
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
    expect(none.value('out_base_ci')).toBe(35_400);
    expect(none.value('out_taxBefore')).toBe(389);
    expect(none.value('out_base_marginal')).toBeCloseTo(0.035, 12);
    expect(none.value('out_usefulRoom')).toBe(0);
    expect(none.value('out_total')).toBe(0);
    expect(BINDING_NUMBERS[Number(none.value('out_bindingNumber'))]).toBe('usefulRoom');
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
    expect(heng.value('out_base_ci')).toBe(34_750);
    expect(heng.value('out_taxBefore')).toBe(366.25);
    expect(high.value('out_employeeCpf')).toBe(7_650);
    expect(high.value('out_base_totalBeforeCap')).toBe(15_650);
    expect(high.value('out_base_ci')).toBe(234_100);
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
  const cellsByName = new Map<string, Cells>();
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
      const cells = cellValues(job.input);
      writeInputs(built, cells);
      cellsByName.set(job.name, cells);
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
        // The sentences of Before You Transfer are those of the stock rules the file was built from; a new tax
        // bracket higher up does not touch a figure they quote.
        if (expected) assertParity(results, expected, { builtRules: getRules(2026), ...(cellsByName.has(job.name) ? { cells: cellsByName.get(job.name) as Cells } : {}) });
      } else {
        expect(results.column('out_workbookCheckFlags')).toEqual(job.checks);
        expect(String(results.value('rule_bracketCheck'))).toMatch(/^Check: /);
        expect(String(results.value('out_plannerBanner'))).toMatch(/^CHECK THE RULES SHEET FIRST/);
        expect(String(results.column('out_warnings', WARNING_LINE_ROWS)[0])).toMatch(/^Check — the tax table on the Rules sheet needs fixing: /);
      }
    });
  }

  it('gives the tax the review worked out by hand for its inserted bracket', () => {
    const r = loaded.get(ROW_JOBS[0]?.name ?? '');
    if (!r) return;
    // Chargeable income 168,600 on the 14-bracket table: 15,798.00 (it showed 16,527.00 before the fix).
    expect(r.value('out_base_ci')).toBe(168_600);
    expect(r.value('out_taxBefore')).toBe(15_798);
    expect(r.value('out_base_marginal')).toBeCloseTo(0.18, 12);
    const missing = loaded.get(ROW_JOBS[3]?.name ?? '');
    expect(String(missing?.value('out_rulesIssue'))).toMatch(/^a bracket row is missing its grey formulas/);
  });
});
