/**
 * UI state for the web calculator, and the one pure function that turns it into the engine's input.
 *
 * UiState holds what the person typed and the presentation-only choices the engine does not know about
 * (monthly or annual pay entry, itemised reliefs, the strategy presets). `toPlannerInput` derives the
 * engine's PlannerInput from it. Nothing here touches the DOM, the clock or storage, so it runs under Vitest.
 */
import {
  NON_RESIDENT_SRS_COST,
  SUPPORTED_INCOME_YEARS,
  defaultIncomeYear,
  defaultInput,
  evaluate,
  getRules,
  plan,
} from '../engine';
import type {
  LeverId,
  Plan,
  PlannerInput,
  PlannerResult,
  PrYear,
  ReliefCatalogItem,
  Residency,
  SimulatorRow,
  YearRules,
} from '../engine/types';

/** localStorage key. The suffix is the schema version: bump both together. */
export const STORAGE_KEY = 'sgto:v1';
export const STATE_VERSION = 1;

/**
 * The default minimum saving per dollar, by residency (SPEC 8.3). Citizens and PRs: 7 cents. Foreigners: 11.5
 * cents, because a foreigner who has left Singapore pays at least 7.5 cents per dollar to take SRS out again
 * (`NON_RESIDENT_SRS_COST`), so a dollar that saves 7 cents today would be a loss.
 */
export const DEFAULT_MIN_RATE: Record<Residency, number> = { citizen: 0.07, pr: 0.07, foreigner: 0.115 };

/** The default minimum saving per dollar for a residency. An unknown residency is treated as a citizen's. */
export function defaultMinRate(residency: Residency): number {
  return DEFAULT_MIN_RATE[residency] ?? DEFAULT_MIN_RATE.citizen;
}

/**
 * The bracket rate a foreigner's default steps over: the highest rate below what leaving costs, e.g. 7%.
 * 0 when the rules have no such bracket.
 */
export function rateBelowLeavingCost(rules: YearRules): number {
  const below = rules.taxBrackets.map((b) => b.rate).filter((r) => r > 0 && r < NON_RESIDENT_SRS_COST.atRetirementOrTenYears);
  return below.length > 0 ? Math.max(...below) : 0;
}

export type PayMode = 'monthly' | 'annual';
export type ReliefMode = 'total' | 'itemised';
/**
 * "How far down the ladder?" 'default' is the preset named by its figure ("7 cents or more"); its rate follows
 * the residency (see `defaultMinRate`).
 */
export type Depth = 'default' | 'top' | 'every' | 'custom';
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
  /**
   * True while the page is still showing the worked example: nothing that describes the person or their plan
   * has been changed. Choices that only change the view (see VIEW_ONLY) leave it true.
   */
  isExample: boolean;
  /**
   * The fields the person has set themselves, by name. A field that is not listed still holds the example's
   * value, and the page says so (see `exampleLeft`).
   */
  edited: string[];

  incomeYear: number;
  residency: Residency;
  prYear: PrYear;
  age: number;
  birthMonth: number;
  /** "I have unused Parenthood Tax Rebate": raises a caution beside the plan; it changes no figure. */
  hasPtr: boolean;

  payMode: PayMode;
  /** Salary in the unit of `payMode`: a month's pay, or twelve months' pay. */
  salary: number;
  /**
   * The figure that was showing in the other pay mode before the last switch, so switching back restores it
   * exactly (S$100,000 a year stays S$100,000). null once `salary` has been edited since.
   */
  salaryOther: number | null;
  bonus: number;
  monthsWorked: number;
  otherIncome: number;
  expenses: number;
  donations: number;
  cpfOverrideOn: boolean;
  /** The person's own figure for the year's employee CPF. null = not given: the estimate is used. */
  cpfOverride: number | null;

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
  /**
   * The top-up to the person's own CPF that can still earn relief. null = not given: below 55 that means "not
   * limiting"; from 55 it means "not confirmed", and their own CPF is left out until a figure is entered.
   */
  cpfSelfRoom: number | null;
  /** Most the person would give to family members. null = up to the relief cap. */
  cpfFamilyMax: number | null;

  depth: Depth;
  /**
   * The minimum saving per dollar the person picked for depth 'custom' (a fraction: 0.035 = 3.5 cents). It
   * counts only once they have picked one (`edited` lists it); until then a custom minimum is their own
   * default (see `customRateOf`).
   */
  customRate: number;
  /** Most cash to lock away this year. null = no limit. */
  cashLimit: number | null;
  order: Order;
  simulatorStep: number;
}

export interface Saved {
  v: number;
  theme: ThemeChoice;
  /** The person's own numbers. null when only the untouched example was showing: that is never restored. */
  ui: UiState | null;
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
  const depth: Depth = rate === defaultMinRate(input.profile.residency) ? 'default' : rate === 0 ? 'every' : 'custom';
  const override = input.income.employeeCpfOverride;
  return {
    isExample: true,
    // A minimum that is neither the default nor zero can only be one somebody picked.
    edited: depth === 'custom' ? ['customRate'] : [],
    incomeYear: input.incomeYear,
    residency: input.profile.residency,
    prYear: input.profile.prYear ?? 3,
    age: input.profile.ageAtYearEnd,
    birthMonth: input.profile.birthMonth ?? 12,
    hasPtr: input.profile.hasUnusedParenthoodTaxRebate === true,
    payMode: 'monthly',
    salary: input.income.monthlyOrdinaryWage,
    salaryOther: null,
    bonus: input.income.additionalWages,
    monthsWorked: input.income.monthsWorked ?? 12,
    otherIncome: input.income.otherTaxableIncome ?? 0,
    expenses: input.income.employmentExpenses ?? 0,
    donations: input.income.donations ?? 0,
    cpfOverrideOn: typeof override === 'number',
    cpfOverride: typeof override === 'number' ? override : null,
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
    customRate: depth === 'custom' ? rate : DEFAULT_MIN_RATE.citizen,
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
// Edits: what is still the example, and what is the person's own
// ---------------------------------------------------------------------------

/**
 * Choices that change what is shown, not whose numbers they are: the step of the simulator, the income year,
 * the order the schemes fill in, and whether other reliefs are entered as one total or itemised. Changing one
 * of these alone leaves the page labelled as the example.
 */
export const VIEW_ONLY: readonly (keyof UiState)[] = ['simulatorStep', 'incomeYear', 'order', 'reliefMode'];

/** Apply a change from the form: record which fields were set, and stop calling the page an example. */
export function applyEdit(prev: UiState, patch: Partial<UiState>): UiState {
  const keys = (Object.keys(patch) as (keyof UiState)[]).filter((k) => k !== 'isExample' && k !== 'edited');
  const own = keys.some((k) => !VIEW_ONLY.includes(k));
  const edited = [...prev.edited];
  for (const key of keys) if (!edited.includes(key)) edited.push(key);
  return { ...prev, ...patch, edited, isExample: prev.isExample && !own };
}

/** The example figures a person is most likely to leave in by accident, with the words used to name them. */
const EXAMPLE_FIGURES: { name: string; keys: (keyof UiState)[]; same: (ui: UiState, example: UiState) => boolean }[] = [
  { name: 'age', keys: ['age'], same: (ui, ex) => ui.age === ex.age },
  { name: 'salary', keys: ['salary', 'payMode'], same: (ui, ex) => ui.salary === ex.salary && ui.payMode === ex.payMode },
  { name: 'bonus', keys: ['bonus'], same: (ui, ex) => ui.bonus === ex.bonus },
  {
    // Switching between one total and the helper is not the person setting the figure: the example's total
    // stays in the plan, and stays named, until they type a total or enter something in the helper.
    name: 'other reliefs',
    keys: ['reliefTotal', 'reliefItems'],
    same: (ui, ex) => ui.reliefTotal === ex.reliefTotal,
  },
];

/**
 * Which of the example's figures are still in a plan the person has started to make their own: "bonus",
 * "other reliefs". Empty while the whole page is still the example (it is labelled as one) and once each has
 * been set. Someone who changes only their salary is told the plan still includes the example's S$15,000 bonus.
 */
export function exampleLeft(ui: UiState, example: UiState): string[] {
  if (ui.isExample) return [];
  return EXAMPLE_FIGURES.filter((f) => !f.keys.some((k) => ui.edited.includes(k)) && f.same(ui, example)).map(
    (f) => f.name,
  );
}

/**
 * The untouched example follows the calendar: when the date moves on while the page is open, it becomes the
 * example for the new date, keeping the person's view-only choices. The income year they picked is kept too,
 * unless the year the example opens on has itself changed. Somebody's own numbers are never touched.
 */
export function followCalendar(ui: UiState, example: UiState, previousExample: UiState): UiState {
  if (!ui.isExample) return ui;
  const yearMoved = example.incomeYear !== previousExample.incomeYear;
  return {
    ...example,
    edited: ui.edited,
    simulatorStep: ui.simulatorStep,
    order: ui.order,
    reliefMode: ui.reliefMode,
    incomeYear: yearMoved ? example.incomeYear : ui.incomeYear,
  };
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

/**
 * Dollars of an annual salary that a whole monthly wage cannot carry. The engine takes pay as whole dollars a
 * month, so S$100,000 a year is S$8,333 a month and S$4 is left over. Those dollars are passed on with the
 * extra pay, so the income the engine counts is the figure the person typed. Always 0 for monthly entry.
 */
export function oddPay(ui: Pick<UiState, 'payMode' | 'salary' | 'monthsWorked'>): number {
  if (ui.payMode !== 'annual') return 0;
  const months = Math.min(12, Math.max(1, Math.floor(ui.monthsWorked) || 12));
  const counted = Math.floor((ui.salary * months) / 12);
  return Math.max(0, counted - monthlyWage(ui) * months);
}

/** The salary to show after switching pay mode: the figure remembered from before, or the same pay converted. */
export function switchPayMode(
  ui: Pick<UiState, 'payMode' | 'salary' | 'salaryOther'>,
  mode: PayMode,
): Pick<UiState, 'payMode' | 'salary' | 'salaryOther'> {
  if (mode === ui.payMode) return { payMode: ui.payMode, salary: ui.salary, salaryOther: ui.salaryOther };
  const converted = mode === 'annual' ? ui.salary * 12 : Math.floor(ui.salary / 12);
  return { payMode: mode, salary: ui.salaryOther ?? converted, salaryOther: ui.salary };
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

/**
 * True while the "other reliefs" figure is still the example's: the person has neither typed a total nor
 * entered anything in the itemised helper. (Numbers restored from storage without a record of what was edited
 * are all treated as the person's own.)
 */
export function reliefsUntouched(ui: Pick<UiState, 'edited'>): boolean {
  return !ui.edited.includes('reliefTotal') && !ui.edited.includes('reliefItems');
}

/**
 * The "other reliefs" figure sent to the engine: the single total, or the itemised helper's sum. While the
 * helper is open on an untouched example, the example's total is still the figure in use (and the page says
 * so); the helper's own sum takes over as soon as something is entered in it.
 */
export function otherReliefsOf(ui: UiState, rules: YearRules): number {
  if (ui.reliefMode !== 'itemised' || reliefsUntouched(ui)) return ui.reliefTotal;
  return itemisedReliefTotal(rules.reliefCatalog, ui.reliefItems);
}

/**
 * The change to make when the person switches between one total and the itemised helper.
 *
 * A figure the person typed is kept, the way switching between monthly and annual pay keeps the pay:
 * - to the helper with nothing itemised yet: the typed total goes into the catalogue's free amount ("Any other
 *   relief"), so the plan does not change;
 * - back to one total: the field takes the itemised sum.
 * A list the person has already filled in is left as it is.
 *
 * The untouched example total is NOT the person's figure, so it is never carried into the helper: only the
 * view changes. The helper opens empty, the example's total stays in the plan and stays labelled as the
 * example's, and nothing is recorded as set by the person.
 */
export function switchReliefMode(
  ui: Pick<UiState, 'reliefMode' | 'reliefTotal' | 'reliefItems' | 'edited'>,
  mode: ReliefMode,
  rules: YearRules,
): Partial<Pick<UiState, 'reliefMode' | 'reliefTotal' | 'reliefItems'>> {
  if (mode === ui.reliefMode) return {};
  if (reliefsUntouched(ui)) return { reliefMode: mode };
  const itemised = itemisedReliefTotal(rules.reliefCatalog, ui.reliefItems);
  if (mode === 'itemised') {
    const free = rules.reliefCatalog.find((item) => item.id === 'other' && item.input === 'amount');
    if (itemised > 0 || ui.reliefTotal <= 0 || !free) {
      return { reliefMode: mode, reliefItems: ui.reliefItems };
    }
    return { reliefMode: mode, reliefItems: { ...ui.reliefItems, [free.id]: ui.reliefTotal } };
  }
  return { reliefMode: mode, reliefTotal: Math.min(itemised, rules.personalReliefCap) };
}

/**
 * The custom minimum saving per dollar: the rate the person picked from the list, or, until they have picked
 * one, the default for their residency. Opening "Custom" is not picking a rate, so a foreigner who opens it
 * starts from 11.5 cents and a citizen from 7 cents whatever either looked at before, and the starting figure
 * moves with the residency the way the default preset does. Nobody lands on a minimum they never chose.
 */
export function customRateOf(ui: Pick<UiState, 'customRate' | 'residency' | 'edited'>): number {
  const picked = ui.edited.includes('customRate') && Number.isFinite(ui.customRate) && ui.customRate >= 0;
  return picked ? ui.customRate : defaultMinRate(ui.residency);
}

/**
 * The minimum saving per dollar for the chosen depth.
 * `currentMarginalRate` is the engine's baseline marginal rate; it is only used for "Top bracket only".
 */
export function minSavingRateOf(
  ui: Pick<UiState, 'depth' | 'customRate' | 'residency' | 'edited'>,
  currentMarginalRate: number,
): number {
  switch (ui.depth) {
    case 'every':
      return 0;
    case 'top':
      return Number.isFinite(currentMarginalRate) && currentMarginalRate > 0 ? currentMarginalRate : 0;
    case 'custom':
      return customRateOf(ui);
    case 'default':
    default:
      // Follows the residency: switching to Foreigner while this preset is selected moves the rate with it.
      return defaultMinRate(ui.residency);
  }
}

/**
 * True while the default preset is the one selected, whether the person never touched the control or came
 * back to it. The page then calls the minimum "the default minimum", not "the minimum you asked for": the
 * figure is the page's, and it moves with the residency.
 */
export function minimumIsDefault(ui: Pick<UiState, 'depth'>): boolean {
  return ui.depth === 'default';
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
      hasUnusedParenthoodTaxRebate: ui.hasPtr,
    },
    income: {
      monthlyOrdinaryWage: monthlyWage(ui),
      monthsWorked: ui.monthsWorked,
      additionalWages: ui.bonus + oddPay(ui),
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

// ---------------------------------------------------------------------------
// "What if" plans: the engine run again with one setting changed
// ---------------------------------------------------------------------------

const USE_FLAG: Record<LeverId, 'useSrs' | 'useCpfSelf' | 'useCpfFamily'> = {
  srs: 'useSrs',
  cpfSelf: 'useCpfSelf',
  cpfFamily: 'useCpfFamily',
};

/**
 * What the person could change to save more, with the plan the engine returns for that change. Used instead of
 * the engine's `unrealisedSaving`, which assumes room no setting on the page can create (every scheme has a
 * yearly cap), so the card only ever quotes a saving the person can actually reach.
 */
export interface WhatIf {
  /** 'noCashLimit': the cash limit lifted. 'switchOn': the switched-off schemes switched on. */
  kind: 'noCashLimit' | 'switchOn';
  /**
   * The schemes to switch on (empty for 'noCashLimit'): only those that receive money in `plan`. A scheme that
   * would be switched on and get nothing is not named, so no saving is credited to it. From 55 that is the
   * person's own CPF while the top-up that can still earn relief has not been entered.
   */
  levers: LeverId[];
  /** The engine's plan with exactly that change. */
  plan: Plan;
}

/**
 * The change that would save more than the current plan, if there is one: lifting the cash limit when that is
 * what stops the plan, or switching on schemes the person left off when the ones in use are full. Returns null
 * when the change would not save a cent more. Every figure is the engine's own.
 */
export function whatIf(ui: UiState, today: string, result: PlannerResult): WhatIf | null {
  const { plan: current, levers } = result;
  const switchedOn = (which: LeverId[]): UiState => {
    const changed = { ...ui };
    for (const lever of which) changed[USE_FLAG[lever]] = true;
    return changed;
  };
  try {
    if (current.bindingConstraint === 'cashBudget') {
      const alt = computePlan({ ...ui, cashLimit: null }, today).plan;
      return alt.taxSaved > current.taxSaved ? { kind: 'noCashLimit', levers: [], plan: alt } : null;
    }
    if (current.bindingConstraint !== 'leverLimits') return null;
    const off = result.input.preferences.priority.filter((l) => levers[l].eligible && !levers[l].enabled);
    if (off.length === 0) return null;
    // With everything that was left off switched on, see which of those schemes the engine puts money into.
    const all = computePlan(switchedOn(off), today).plan;
    const gaining = off.filter((l) => all.contributions[l] > current.contributions[l]);
    if (gaining.length === 0) return null;
    // The plan quoted is the engine's for exactly the change named: those schemes on, and no others.
    const alt = gaining.length === off.length ? all : computePlan(switchedOn(gaining), today).plan;
    return alt.taxSaved > current.taxSaved ? { kind: 'switchOn', levers: gaining, plan: alt } : null;
  } catch {
    return null;
  }
}

/**
 * When nothing is recommended, the engine's result with no minimum saving at all ("Every tax dollar"), if that
 * would put something in. The card offers that view from it, in the engine's own figures and with the
 * engine's own cautions for that plan. null when the plan on screen is not S$0, when it already is the Every
 * tax dollar view, once the deadline has passed, and when going all the way down finds nothing either.
 */
export function deeperPlan(ui: UiState, today: string, result: PlannerResult): PlannerResult | null {
  if (result.plan.totalContribution > 0 || ui.depth === 'every' || result.monthlyPlan.daysToDeadline < 0) return null;
  try {
    const deeper = computePlan({ ...ui, depth: 'every' }, today);
    return deeper.plan.totalContribution > 0 ? deeper : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Simulator rows, with one at the plan's own total
// ---------------------------------------------------------------------------

/** A simulator row. `planTotal` marks the row added at the plan's own total. */
export type SimulatorStep = SimulatorRow & { planTotal?: boolean };

function toCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * The engine's simulator rows, with one more at the plan's own total when the step does not land on it.
 *
 * A plan of S$17,240 seen in S$1,000 steps has rows at S$17,000 and S$18,000; the second mixes S$240 that the
 * plan takes with S$760 it leaves, so its "per dollar" is neither rate. With a row at S$17,240 the last step
 * inside the plan and the first one beyond it each show their own rate. The added row is the engine's
 * `evaluate()` of the plan's own contributions; the row after it is re-based on it.
 */
export function simulatorSteps(result: PlannerResult): SimulatorStep[] {
  const rows: SimulatorStep[] = result.simulator.map((row) => ({ ...row }));
  const total = result.plan.totalContribution;
  if (total <= 0 || rows.some((row) => row.contribution === total)) {
    return rows.map((row) => (row.contribution === total && total > 0 ? { ...row, planTotal: true } : row));
  }
  const at = rows.findIndex((row) => row.contribution > total);
  const previous = at > 0 ? rows[at - 1] : undefined;
  const next = at >= 0 ? rows[at] : undefined;
  // The plan never exceeds the schemes' room, so there is always a step beyond it; without one, leave the rows be.
  if (!previous || !next) return rows;
  let taxPayable: number;
  try {
    taxPayable = evaluate(result.input, result.plan.contributions).taxPayable;
  } catch {
    return rows;
  }
  const taxSaved = toCents(result.baseline.taxPayable - taxPayable);
  const stepSaving = toCents(taxSaved - previous.taxSaved);
  const added: SimulatorStep = {
    contribution: total,
    split: { ...result.plan.contributions },
    taxPayable,
    taxSaved,
    stepSaving,
    stepRate: stepSaving / (total - previous.contribution),
    withinPlan: true,
    planTotal: true,
  };
  const beyond = toCents(next.taxSaved - taxSaved);
  rows[at] = { ...next, stepSaving: beyond, stepRate: beyond / (next.contribution - total) };
  rows.splice(at, 0, added);
  return rows;
}

/**
 * Set when the device's date is in a year later than every income year this build has rules for. A copy of
 * the calculator opened a few years on cannot plan the current year; the page says so plainly.
 */
export function beyondRules(today: string): { year: number; newest: number } | null {
  const year = Number(today.slice(0, 4));
  const newest = SUPPORTED_INCOME_YEARS[SUPPORTED_INCOME_YEARS.length - 1];
  return Number.isFinite(year) && newest !== undefined && year > newest ? { year, newest } : null;
}

/**
 * The income year to offer when the one on screen has closed: the year the device's date falls in, when it is
 * supported, is a different year and its own deadline has not passed. null when there is nothing to switch to.
 */
export function openIncomeYear(today: string, shownYear: number): number | null {
  const year = defaultIncomeYear(today);
  if (year === shownYear || !SUPPORTED_INCOME_YEARS.includes(year)) return null;
  return today.slice(0, 10) <= getRules(year).contributionDeadline ? year : null;
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
  // Numbers saved before edits were tracked are all the person's own: nothing in them is flagged as an example.
  const known = Object.keys(example);
  const edited = Array.isArray(raw.edited)
    ? raw.edited.filter((k): k is string => typeof k === 'string' && known.includes(k))
    : known.filter((k) => k !== 'isExample' && k !== 'edited');
  return {
    isExample: boolOr(raw.isExample, false),
    edited: [...new Set(edited)],
    incomeYear: oneOf(raw.incomeYear, SUPPORTED_INCOME_YEARS, example.incomeYear),
    residency: oneOf<Residency>(raw.residency, ['citizen', 'pr', 'foreigner'], example.residency),
    prYear: oneOf<PrYear>(raw.prYear, [1, 2, 3], example.prYear),
    age: wholeOr(raw.age, example.age, 0, 120),
    birthMonth: wholeOr(raw.birthMonth, example.birthMonth, 1, 12),
    // Not in numbers saved by earlier versions: nobody had ticked a box that was not there.
    hasPtr: boolOr(raw.hasPtr, false),
    payMode: oneOf<PayMode>(raw.payMode, ['monthly', 'annual'], example.payMode),
    salary: wholeOr(raw.salary, example.salary),
    salaryOther: wholeOrNull(raw.salaryOther),
    bonus: wholeOr(raw.bonus, example.bonus),
    monthsWorked: wholeOr(raw.monthsWorked, example.monthsWorked, 1, 12),
    otherIncome: wholeOr(raw.otherIncome, example.otherIncome),
    expenses: wholeOr(raw.expenses, example.expenses),
    donations: wholeOr(raw.donations, example.donations),
    cpfOverrideOn: boolOr(raw.cpfOverrideOn, example.cpfOverrideOn),
    cpfOverride: wholeOrNull(raw.cpfOverride),
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
    // Earlier versions called the default preset 'worth'. It was the default then and is the default now.
    depth: oneOf<Depth>(raw.depth === 'worth' ? 'default' : raw.depth, ['default', 'top', 'every', 'custom'], example.depth),
    customRate,
    cashLimit: wholeOrNull(raw.cashLimit),
    order: oneOf<Order>(raw.order, ['flexibility', 'interest', 'family'], example.order),
    simulatorStep: oneOf(raw.simulatorStep, SIMULATOR_STEPS, example.simulatorStep),
  };
}

/**
 * Parse what was stored under STORAGE_KEY. Anything unparseable or from another version is ignored.
 *
 * The untouched example is not somebody's numbers, so it is never restored (`ui` is null): a returning visitor
 * gets the example for today's date, not the one from the day they first opened the page. The theme is kept.
 */
export function parseSaved(text: string | null | undefined, example: UiState): Saved | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== STATE_VERSION) return null;
  const theme = oneOf<ThemeChoice>(raw.theme, ['system', 'light', 'dark'], 'system');
  if (raw.ui === null || raw.ui === undefined) return { v: STATE_VERSION, theme, ui: null };
  const ui = reviveUiState(raw.ui, example);
  if (!ui) return null;
  return { v: STATE_VERSION, theme, ui: ui.isExample ? null : ui };
}

export function serialiseSaved(ui: UiState, theme: ThemeChoice): string {
  const saved: Saved = { v: STATE_VERSION, theme, ui: ui.isExample ? null : ui };
  return JSON.stringify(saved);
}
