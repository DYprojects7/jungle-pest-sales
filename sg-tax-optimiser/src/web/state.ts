/**
 * UI state for the web calculator, and the one pure function that turns it into the engine's input.
 *
 * UiState holds what the person typed and the presentation-only choices the engine does not know about
 * (monthly or annual pay entry, itemised reliefs, the strategy presets). `toPlannerInput` derives the
 * engine's PlannerInput from it. Nothing here touches the DOM, the clock or storage, so it runs under Vitest.
 */
import { SUPPORTED_INCOME_YEARS, defaultInput, getRules, plan } from '../engine';
import type {
  LeverId,
  PlannerInput,
  PlannerResult,
  PrYear,
  ReliefCatalogItem,
  Residency,
  YearRules,
} from '../engine/types';

/** localStorage key. The suffix is the schema version: bump both together. */
export const STORAGE_KEY = 'sgto:v1';
export const STATE_VERSION = 1;

/** "Worth it": only lock away dollars that save at least 7 cents each (SPEC 8.3). */
export const WORTH_IT_RATE = 0.07;

export type PayMode = 'monthly' | 'annual';
export type ReliefMode = 'total' | 'itemised';
/** "How far down the ladder?" */
export type Depth = 'worth' | 'top' | 'every' | 'custom';
/** "Which first?" */
export type Order = 'flexibility' | 'interest' | 'family';
export type ThemeChoice = 'system' | 'light' | 'dark';

export const ORDER_PRESETS: Record<Order, LeverId[]> = {
  flexibility: ['srs', 'cpfSelf', 'cpfFamily'],
  interest: ['cpfSelf', 'srs', 'cpfFamily'],
  family: ['cpfFamily', 'srs', 'cpfSelf'],
};

export const SIMULATOR_STEPS = [250, 500, 1000, 2000, 5000];

export interface UiState {
  /** True until the person changes an input: the page is still showing the worked example. */
  isExample: boolean;

  incomeYear: number;
  residency: Residency;
  prYear: PrYear;
  age: number;
  birthMonth: number;

  payMode: PayMode;
  /** Salary in the unit of `payMode`: a month's pay, or twelve months' pay. */
  salary: number;
  bonus: number;
  monthsWorked: number;
  otherIncome: number;
  expenses: number;
  donations: number;
  cpfOverrideOn: boolean;
  cpfOverride: number;

  existingSrs: number;
  existingCpfSelf: number;
  existingCpfFamily: number;

  reliefMode: ReliefMode;
  reliefTotal: number;
  /** Itemised helper values by catalogue id: a count, an amount, 0/1 for a toggle, or an option index. */
  reliefItems: Record<string, number>;

  useSrs: boolean;
  useCpfSelf: boolean;
  useCpfFamily: boolean;
  /** Room left before the Full Retirement Sum / Basic Healthcare Sum. null = not given. */
  cpfSelfRoom: number | null;
  /** Most the person would give to family members. null = up to the relief cap. */
  cpfFamilyMax: number | null;

  depth: Depth;
  /** Minimum saving per dollar used when depth is 'custom' (a fraction: 0.035 = 3.5 cents). */
  customRate: number;
  /** Most cash to lock away this year. null = no limit. */
  cashLimit: number | null;
  order: Order;
  simulatorStep: number;
}

export interface Saved {
  v: number;
  theme: ThemeChoice;
  ui: UiState;
}

// ---------------------------------------------------------------------------
// Example state
// ---------------------------------------------------------------------------

function orderFor(priority: LeverId[]): Order {
  const key = priority.join('>');
  const match = (Object.keys(ORDER_PRESETS) as Order[]).find((o) => ORDER_PRESETS[o].join('>') === key);
  return match ?? 'flexibility';
}

/** The UI state that reproduces a PlannerInput (used to open on the engine's worked example). */
export function uiStateFromInput(input: PlannerInput): UiState {
  const rate = input.preferences.minSavingRate;
  const depth: Depth = rate === WORTH_IT_RATE ? 'worth' : rate === 0 ? 'every' : 'custom';
  const override = input.income.employeeCpfOverride;
  return {
    isExample: true,
    incomeYear: input.incomeYear,
    residency: input.profile.residency,
    prYear: input.profile.prYear ?? 3,
    age: input.profile.ageAtYearEnd,
    birthMonth: input.profile.birthMonth ?? 12,
    payMode: 'monthly',
    salary: input.income.monthlyOrdinaryWage,
    bonus: input.income.additionalWages,
    monthsWorked: input.income.monthsWorked ?? 12,
    otherIncome: input.income.otherTaxableIncome ?? 0,
    expenses: input.income.employmentExpenses ?? 0,
    donations: input.income.donations ?? 0,
    cpfOverrideOn: typeof override === 'number',
    cpfOverride: typeof override === 'number' ? override : 0,
    existingSrs: input.existing.srs,
    existingCpfSelf: input.existing.cpfTopUpSelf,
    existingCpfFamily: input.existing.cpfTopUpFamily,
    reliefMode: 'total',
    reliefTotal: input.otherReliefs,
    reliefItems: {},
    useSrs: input.levers.srs.enabled,
    useCpfSelf: input.levers.cpfSelf.enabled,
    useCpfFamily: input.levers.cpfFamily.enabled,
    cpfSelfRoom: input.levers.cpfSelf.roomToLimit ?? null,
    cpfFamilyMax: input.levers.cpfFamily.maxAmount ?? null,
    depth,
    customRate: depth === 'custom' ? rate : WORTH_IT_RATE,
    cashLimit: input.preferences.cashBudget ?? null,
    order: orderFor(input.preferences.priority),
    simulatorStep: input.preferences.simulatorStep ?? 1000,
  };
}

/** The opening state: the engine's worked example for `today`. */
export function exampleState(today: string): UiState {
  return uiStateFromInput(defaultInput(today));
}

// ---------------------------------------------------------------------------
// UiState -> PlannerInput
// ---------------------------------------------------------------------------

/** Rules for the state's income year, falling back to the newest supported year. */
export function rulesFor(incomeYear: number): YearRules {
  const year = SUPPORTED_INCOME_YEARS.includes(incomeYear)
    ? incomeYear
    : (SUPPORTED_INCOME_YEARS[SUPPORTED_INCOME_YEARS.length - 1] ?? incomeYear);
  return getRules(year);
}

/** The month's pay the engine works with. An annual figure is twelve months' pay. */
export function monthlyWage(ui: Pick<UiState, 'payMode' | 'salary'>): number {
  return ui.payMode === 'annual' ? Math.floor(ui.salary / 12) : ui.salary;
}

/** Dollar amount of one itemised relief line. The helper only adds up; it does not check eligibility. */
export function reliefItemAmount(item: ReliefCatalogItem, value: number | undefined): number {
  const v = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  switch (item.input) {
    case 'count':
      return Math.min(v, item.max ?? v) * item.amountPerUnit;
    case 'amount':
      return Math.min(v, item.max ?? v);
    case 'toggle':
      return v > 0 ? item.amountPerUnit : 0;
    case 'select':
      return item.options?.[v]?.amount ?? 0;
    default:
      return 0;
  }
}

/** Total of the itemised relief helper. */
export function itemisedReliefTotal(catalog: ReliefCatalogItem[], values: Record<string, number>): number {
  return catalog.reduce((sum, item) => sum + reliefItemAmount(item, values[item.id]), 0);
}

/** The "other reliefs" figure sent to the engine: the single total, or the itemised helper's sum. */
export function otherReliefsOf(ui: UiState, rules: YearRules): number {
  return ui.reliefMode === 'itemised' ? itemisedReliefTotal(rules.reliefCatalog, ui.reliefItems) : ui.reliefTotal;
}

/**
 * The minimum saving per dollar for the chosen depth.
 * `currentMarginalRate` is the engine's baseline marginal rate; it is only used for "Top bracket only".
 */
export function minSavingRateOf(ui: Pick<UiState, 'depth' | 'customRate'>, currentMarginalRate: number): number {
  switch (ui.depth) {
    case 'worth':
      return WORTH_IT_RATE;
    case 'every':
      return 0;
    case 'top':
      return Number.isFinite(currentMarginalRate) && currentMarginalRate > 0 ? currentMarginalRate : 0;
    case 'custom':
      return Number.isFinite(ui.customRate) && ui.customRate > 0 ? ui.customRate : 0;
    default:
      return WORTH_IT_RATE;
  }
}

/**
 * Derive the engine input from the UI state. Pure.
 *
 * @param today the device's local date, YYYY-MM-DD
 * @param currentMarginalRate the baseline marginal rate from a first `plan()` pass; needed only when
 *   `ui.depth === 'top'` (see `computePlan`)
 */
export function toPlannerInput(ui: UiState, today: string, currentMarginalRate = 0): PlannerInput {
  const rules = rulesFor(ui.incomeYear);
  return {
    incomeYear: rules.incomeYear,
    today,
    profile: {
      residency: ui.residency,
      prYear: ui.prYear,
      ageAtYearEnd: ui.age,
      birthMonth: ui.birthMonth,
    },
    income: {
      monthlyOrdinaryWage: monthlyWage(ui),
      monthsWorked: ui.monthsWorked,
      additionalWages: ui.bonus,
      otherTaxableIncome: ui.otherIncome,
      employmentExpenses: ui.expenses,
      donations: ui.donations,
      employeeCpfOverride: ui.cpfOverrideOn && ui.residency !== 'foreigner' ? ui.cpfOverride : null,
    },
    existing: {
      srs: ui.existingSrs,
      cpfTopUpSelf: ui.existingCpfSelf,
      cpfTopUpFamily: ui.existingCpfFamily,
    },
    otherReliefs: otherReliefsOf(ui, rules),
    levers: {
      srs: { enabled: ui.useSrs },
      cpfSelf: { enabled: ui.useCpfSelf, roomToLimit: ui.cpfSelfRoom },
      cpfFamily: { enabled: ui.useCpfFamily, maxAmount: ui.cpfFamilyMax },
    },
    preferences: {
      cashBudget: ui.cashLimit,
      minSavingRate: minSavingRateOf(ui, currentMarginalRate),
      priority: [...ORDER_PRESETS[ui.order]],
      simulatorStep: ui.simulatorStep,
    },
  };
}

/**
 * Run the engine for a UI state. "Top bracket only" needs the baseline marginal rate, which the engine
 * reports, so that depth takes two passes; every other depth takes one.
 */
export function computePlan(ui: UiState, today: string): PlannerResult {
  const first = plan(toPlannerInput(ui, today));
  if (ui.depth !== 'top') return first;
  return plan(toPlannerInput(ui, today, first.baseline.marginalRate));
}

/**
 * Minimum-saving choices for the custom depth: the bracket rates at or below the current marginal rate,
 * highest first. The current choice is always included so the control never shows a blank.
 */
export function customRateOptions(rules: YearRules, currentMarginalRate: number, selected: number): number[] {
  const rates = new Set<number>();
  for (const bracket of rules.taxBrackets) {
    if (bracket.rate > 0 && bracket.rate <= currentMarginalRate) rates.add(bracket.rate);
  }
  if (selected > 0) rates.add(selected);
  return [...rates].sort((a, b) => b - a);
}

// ---------------------------------------------------------------------------
// Persistence (the storage access itself lives in storage.ts)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wholeOr(value: unknown, fallback: number, min = 0, max = 10_000_000_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function wholeOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Rebuild a UiState from stored data. Returns null when the data is not a state object at all; individual
 * fields that are missing or of the wrong type fall back to the example's value.
 */
export function reviveUiState(raw: unknown, example: UiState): UiState | null {
  if (!isRecord(raw)) return null;
  const items: Record<string, number> = {};
  if (isRecord(raw.reliefItems)) {
    for (const [id, value] of Object.entries(raw.reliefItems)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) items[id] = Math.floor(value);
    }
  }
  const customRate =
    typeof raw.customRate === 'number' && Number.isFinite(raw.customRate) && raw.customRate >= 0 && raw.customRate <= 1
      ? raw.customRate
      : example.customRate;
  return {
    isExample: boolOr(raw.isExample, false),
    incomeYear: oneOf(raw.incomeYear, SUPPORTED_INCOME_YEARS, example.incomeYear),
    residency: oneOf<Residency>(raw.residency, ['citizen', 'pr', 'foreigner'], example.residency),
    prYear: oneOf<PrYear>(raw.prYear, [1, 2, 3], example.prYear),
    age: wholeOr(raw.age, example.age, 0, 120),
    birthMonth: wholeOr(raw.birthMonth, example.birthMonth, 1, 12),
    payMode: oneOf<PayMode>(raw.payMode, ['monthly', 'annual'], example.payMode),
    salary: wholeOr(raw.salary, example.salary),
    bonus: wholeOr(raw.bonus, example.bonus),
    monthsWorked: wholeOr(raw.monthsWorked, example.monthsWorked, 1, 12),
    otherIncome: wholeOr(raw.otherIncome, example.otherIncome),
    expenses: wholeOr(raw.expenses, example.expenses),
    donations: wholeOr(raw.donations, example.donations),
    cpfOverrideOn: boolOr(raw.cpfOverrideOn, example.cpfOverrideOn),
    cpfOverride: wholeOr(raw.cpfOverride, example.cpfOverride),
    existingSrs: wholeOr(raw.existingSrs, example.existingSrs),
    existingCpfSelf: wholeOr(raw.existingCpfSelf, example.existingCpfSelf),
    existingCpfFamily: wholeOr(raw.existingCpfFamily, example.existingCpfFamily),
    reliefMode: oneOf<ReliefMode>(raw.reliefMode, ['total', 'itemised'], example.reliefMode),
    reliefTotal: wholeOr(raw.reliefTotal, example.reliefTotal),
    reliefItems: items,
    useSrs: boolOr(raw.useSrs, example.useSrs),
    useCpfSelf: boolOr(raw.useCpfSelf, example.useCpfSelf),
    useCpfFamily: boolOr(raw.useCpfFamily, example.useCpfFamily),
    cpfSelfRoom: wholeOrNull(raw.cpfSelfRoom),
    cpfFamilyMax: wholeOrNull(raw.cpfFamilyMax),
    depth: oneOf<Depth>(raw.depth, ['worth', 'top', 'every', 'custom'], example.depth),
    customRate,
    cashLimit: wholeOrNull(raw.cashLimit),
    order: oneOf<Order>(raw.order, ['flexibility', 'interest', 'family'], example.order),
    simulatorStep: oneOf(raw.simulatorStep, SIMULATOR_STEPS, example.simulatorStep),
  };
}

/** Parse what was stored under STORAGE_KEY. Anything unparseable or from another version is ignored. */
export function parseSaved(text: string | null | undefined, example: UiState): Saved | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== STATE_VERSION) return null;
  const ui = reviveUiState(raw.ui, example);
  if (!ui) return null;
  return { v: STATE_VERSION, theme: oneOf<ThemeChoice>(raw.theme, ['system', 'light', 'dark'], 'system'), ui };
}

export function serialiseSaved(ui: UiState, theme: ThemeChoice): string {
  const saved: Saved = { v: STATE_VERSION, theme, ui };
  return JSON.stringify(saved);
}
