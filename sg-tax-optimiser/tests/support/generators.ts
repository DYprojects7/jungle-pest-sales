/**
 * Generators of `PlannerInput` for the property tests and the differential test.
 *
 * One declarative description of the input space (`RECIPE`) drives two interpreters:
 *   (a) fast-check arbitraries (`recipeArb`, `plannerInputArb`, …) — shrinkable, for `tests/properties.test.ts`;
 *   (b) a seeded deterministic generator on mulberry32 (`seededInputs`, …) — for `tests/differential.test.ts`.
 *
 * A *recipe* is a bag of independent draws, each a tagged number. `realise` turns a recipe into a `PlannerInput`,
 * resolving the draws that are relative to something else (the OW ceiling of the year, the AW ceiling left after
 * the ordinary wages, a scheme's relief cap for the residency, a tax-bracket boundary, the plan's own U/C/L).
 * The relative draws use the test author's independent model (`specModel.ts`), never the engine.
 *
 * The space is biased towards boundaries: see `RECIPE` for the clusters.
 */
import fc from 'fast-check';
import type { LeverId, PlannerInput, PrYear, Residency } from '../../src/engine/types';
import {
  SPEC_ANNUAL_WAGE_CEILING,
  SPEC_BRACKETS,
  SPEC_MAX_COMPULSORY_CPF,
  SPEC_OW_CEILING,
  SPEC_RELIEF_CAP,
  SPEC_SRS_CAP,
  SPEC_TOPUP_CAP,
  daysInMonth,
  isSpecYear,
  specPlan,
  specTax,
} from './specModel';
import type { FullInput } from './specModel';

// ---------------------------------------------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------------------------------------------

/** mulberry32: a small, fast, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Uniform integer in [min, max] (inclusive). */
function randomInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function randomPick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new RangeError('randomPick: empty list');
  return item;
}

// ---------------------------------------------------------------------------------------------------------------
// The declarative input space
// ---------------------------------------------------------------------------------------------------------------

/** One draw: `v` interpreted according to `t` by `realise`. */
export interface Draw {
  t: string;
  v: number;
}

/** A weighted alternative: either one of `values` or a uniform integer in `range`, tagged `t`. */
interface Alt {
  w: number;
  t: string;
  values?: readonly number[];
  range?: readonly [number, number];
}

const vals = (w: number, t: string, values: readonly number[]): Alt => ({ w, t, values });
const span = (w: number, t: string, min: number, max: number): Alt => ({ w, t, range: [min, max] });

/** §5.1 bracket boundaries above zero (targets for "chargeable income lands exactly here"). */
export const BRACKET_BOUNDARIES: readonly number[] = SPEC_BRACKETS.filter((b) => b.from > 0).map((b) => b.from);

/** The six orders in which the three levers can be filled. */
export const PRIORITY_PERMUTATIONS: readonly (readonly LeverId[])[] = [
  ['srs', 'cpfSelf', 'cpfFamily'],
  ['cpfSelf', 'srs', 'cpfFamily'],
  ['cpfFamily', 'srs', 'cpfSelf'],
  ['srs', 'cpfFamily', 'cpfSelf'],
  ['cpfSelf', 'cpfFamily', 'srs'],
  ['cpfFamily', 'cpfSelf', 'srs'],
];

/** Minimum saving rates the UI offers, plus values just either side of a bracket rate. */
export const MIN_SAVING_RATES: readonly number[] = [
  0, 0.02, 0.035, 0.07, 0.115, 0.15, 0.18, 0.19, 0.195, 0.2, 0.22, 0.23, 0.24, 0.25,
];
const AWKWARD_RATES: readonly number[] = [
  0.0699999, 0.0700001, 0.1149999, 0.1150001, 0.019999, 0.020001, 0.2399999, 0.2400001, 0.001, 0.5, 1,
];

/** (month, day) pairs worth hitting on purpose: the deadline, the 14-day warning window, year and month ends. */
const SPECIAL_DATES: readonly (readonly [number, number])[] = [
  [12, 31],
  [12, 17],
  [12, 16],
  [12, 18],
  [12, 30],
  [12, 1],
  [1, 1],
  [1, 31],
  [2, 28],
  [2, 29],
  [11, 30],
  [12, 15],
  [6, 30],
  [7, 1],
];

const existingContribution: Alt[] = [
  vals(12, 'abs', [0]),
  span(3, 'capPercent', 1, 99), // somewhere in the middle
  vals(2, 'cap', [0, -1, 1]), // exactly at the cap, a dollar either side
  vals(1, 'cap', [100, 5_000, 20_000, -100]), // above the cap
  span(1, 'abs', 1, 12_000),
];

const optionalLimit: Alt[] = [
  vals(5, 'absent', [0]),
  vals(3, 'null', [0]),
  vals(1, 'abs', [0]),
  span(3, 'abs', 1, 7_999),
  vals(1, 'abs', [8_000, 8_001, 20_000, 50_000]),
];

/**
 * The input space. The first alternative of each field is the simplest one (fast-check shrinks towards it).
 * Tags: 'abs' = the value itself; 'absent' = leave the optional field out; 'null' = explicit null; the others
 * are relative and documented where `realise` resolves them.
 */
const RECIPE = {
  year: [vals(4, 'abs', [2026]), vals(3, 'abs', [2025]), vals(3, 'abs', [2027])],
  residency: [vals(9, 'abs', [0]), vals(6, 'abs', [1]), vals(5, 'abs', [2])], // citizen, pr, foreigner
  prYear: [vals(4, 'abs', [3]), vals(2, 'abs', [1]), vals(2, 'abs', [2]), vals(1, 'absent', [0])],
  age: [
    span(3, 'abs', 25, 50),
    vals(3, 'abs', [18, 17, 16, 19]),
    vals(3, 'abs', [55, 54, 56, 53]),
    // SPEC §6.5: from 55 the room for a top-up to one's own CPF must be entered — the boundary, both sides
    vals(3, 'abs', [54, 55]),
    vals(2, 'abs', [60, 59, 61]),
    vals(2, 'abs', [65, 64, 66]),
    vals(2, 'abs', [70, 69, 71]),
    vals(1, 'abs', [80, 79, 75]),
    span(4, 'abs', 16, 80),
  ],
  birthMonth: [span(10, 'abs', 1, 12), vals(1, 'absent', [0])],
  // SPEC §6.11: a foreigner who worked 6 months or fewer is asked to check tax residency — both sides of 6
  monthsWorked: [vals(9, 'abs', [12]), span(5, 'abs', 1, 12), vals(1, 'absent', [0]), vals(3, 'abs', [6, 7, 5, 1])],
  wage: [
    span(11, 'abs', 3_000, 7_300),
    span(3, 'abs', 752, 3_000),
    vals(1, 'abs', [0]),
    vals(1, 'abs', [50]),
    vals(2, 'abs', [500, 499, 501]),
    span(2, 'abs', 502, 748), // inside the employee phase-in range
    vals(2, 'abs', [750, 749, 751]),
    vals(5, 'owCeiling', [0, -1, 1]), // the year's OW ceiling ± 1
    vals(1, 'abs', [7_399, 7_400, 7_401, 7_999, 8_000, 8_001, 8_500]),
    span(16, 'abs', 8_002, 20_000),
    span(5, 'abs', 20_000, 100_000),
    span(1, 'abs', 100_000, 5_000_000),
  ],
  additionalWages: [
    vals(4, 'abs', [0]),
    span(6, 'abs', 1, 60_000),
    vals(4, 'awCeiling', [0, -1, 1]), // the AW ceiling left after ordinary wages ± 1
    vals(1, 'awCeiling', [-1_000, 1_000]),
    vals(1, 'abs', [5_999, 6_000, 6_001, 13_200, 101_999, 102_000, 102_001]),
    span(2, 'abs', 60_000, 300_000),
    span(1, 'abs', 300_000, 5_000_000),
  ],
  otherTaxableIncome: [
    vals(8, 'abs', [0]),
    vals(1, 'absent', [0]),
    span(4, 'abs', 1, 50_000),
    span(2, 'abs', 50_000, 400_000),
    span(1, 'abs', 400_000, 5_000_000),
  ],
  employmentExpenses: [
    vals(10, 'abs', [0]),
    vals(1, 'absent', [0]),
    span(3, 'abs', 1, 5_000),
    span(1, 'abs', 5_000, 100_000),
    vals(1, 'employmentIncome', [0, -1, 1, 1_000]), // around the whole employment income
  ],
  donations: [
    vals(10, 'abs', [0]),
    vals(1, 'absent', [0]),
    vals(3, 'abs', [1, 3, 5, 99, 101, 333, 1_001, 4_999]), // odd amounts: the deduction ends in .50
    span(3, 'abs', 1, 20_000),
    span(1, 'abs', 20_000, 200_000),
    vals(1, 'wipeOut', [0, -1, 1, 2]), // deduction about equal to total income
  ],
  employeeCpfOverride: [
    vals(12, 'absent', [0]),
    vals(3, 'null', [0]),
    vals(1, 'abs', [0]),
    span(3, 'abs', 1, 20_399),
    vals(2, 'maxCpf', [0, -1, 1]), // the maximum compulsory contribution ± 1
    vals(1, 'abs', [25_000, 50_000, 102_000]),
  ],
  existingSrs: existingContribution,
  existingSelf: existingContribution,
  existingFamily: existingContribution,
  otherReliefs: [
    vals(6, 'abs', [0]),
    span(10, 'abs', 1, 30_000),
    span(2, 'abs', 30_000, 79_999),
    vals(1, 'abs', [80_000, 79_999, 80_001]),
    span(1, 'abs', 80_001, 150_000),
    // 'toCap': baseline reliefs before the cap = S$80,000 + v (so the relief-cap room C is −v when v < 0).
    vals(1, 'toCap', [0, 1, 500, 5_000]),
    vals(3, 'toCap', [-1, -500, -1_000, -8_000, -15_300, -16_000, -23_300, -31_300]),
    span(2, 'toCap', -36_000, -1),
    // 'toBoundary': baseline chargeable income = a reachable bracket boundary + boundaryOffset.
    span(6, 'toBoundary', 0, 11), // v picks among the boundaries that are reachable for the profile
  ],
  boundaryOffset: [
    vals(3, 'abs', [0]),
    vals(3, 'abs', [1, -1]),
    vals(1, 'abs', [2, -2]),
    span(2, 'abs', -600, 600),
    vals(2, 'abs', [500, 1_000, 8_000, 15_300, 16_000, 23_300, 31_300, 35_700]),
    span(2, 'abs', 1, 36_000),
  ],
  srsEnabled: [vals(3, 'abs', [1]), vals(1, 'abs', [0])],
  selfEnabled: [vals(3, 'abs', [1]), vals(1, 'abs', [0])],
  familyEnabled: [vals(1, 'abs', [0]), vals(1, 'abs', [1])],
  roomToLimit: optionalLimit,
  maxAmount: optionalLimit,
  cashBudget: [
    vals(5, 'null', [0]),
    vals(2, 'absent', [0]),
    vals(1, 'abs', [0]),
    span(2, 'abs', 1, 2_000),
    span(3, 'abs', 2_000, 30_000),
    span(1, 'abs', 30_000, 100_000),
    vals(1, 'abs', [1_000_000, 5_000_000]),
    vals(2, 'tieLeverRoom', [0, -1, 1]), // exactly L, a dollar either side
    span(1, 'tieLeverRoom', -5_000, -2),
    vals(1, 'tieUsefulRoom', [0, -1, 1]),
    vals(1, 'tieReliefCapRoom', [0, -1, 1]),
  ],
  minSavingRate: [
    vals(6, 'abs', [0]),
    vals(6, 'abs', [0.07]),
    vals(6, 'abs', MIN_SAVING_RATES),
    vals(1, 'abs', AWKWARD_RATES),
    span(2, 'millionths', 0, 250_000), // arbitrary values on a 1e-6 grid across the bracket rates
    span(1, 'millionths', 0, 1_000_000),
  ],
  priority: [span(1, 'abs', 0, PRIORITY_PERMUTATIONS.length - 1)],
  simulatorStep: [
    vals(4, 'abs', [1_000]),
    vals(2, 'abs', [500]),
    vals(2, 'abs', [5_000]),
    vals(1, 'abs', [100]), // up to 358 simulator rows per input: kept rarer so the differential run stays quick
    vals(1, 'absent', [0]),
  ],
  todayYearOffset: [vals(8, 'abs', [0]), vals(2, 'abs', [-1]), vals(2, 'abs', [1]), vals(1, 'abs', [-2, 2, -6, 3])],
  todayMonth: [span(6, 'abs', 1, 12), span(4, 'special', 0, SPECIAL_DATES.length - 1)],
  todayDay: [span(1, 'abs', 1, 31)],
  // profile.hasUnusedParenthoodTaxRebate: left out, false (0) or true (1)
  parenthoodRebate: [vals(5, 'absent', [0]), vals(3, 'abs', [0]), vals(3, 'abs', [1])],
} satisfies Record<string, Alt[]>;

export type Recipe = Record<keyof typeof RECIPE, Draw>;
const RECIPE_KEYS = Object.keys(RECIPE) as (keyof typeof RECIPE)[];

// ---------------------------------------------------------------------------------------------------------------
// Interpreter (b): seeded draws
// ---------------------------------------------------------------------------------------------------------------

function drawFrom(rng: () => number, alternatives: readonly Alt[]): Draw {
  const totalWeight = alternatives.reduce((sum, alternative) => sum + alternative.w, 0);
  let ticket = rng() * totalWeight;
  let chosen = alternatives[alternatives.length - 1]!;
  for (const alternative of alternatives) {
    if (ticket < alternative.w) {
      chosen = alternative;
      break;
    }
    ticket -= alternative.w;
  }
  if (chosen.values) return { t: chosen.t, v: randomPick(rng, chosen.values) };
  const [min, max] = chosen.range ?? [0, 0];
  return { t: chosen.t, v: randomInt(rng, min, max) };
}

/** One recipe from a PRNG. */
export function drawRecipe(rng: () => number): Recipe {
  const recipe = {} as Recipe;
  for (const key of RECIPE_KEYS) recipe[key] = drawFrom(rng, RECIPE[key]);
  return recipe;
}

// ---------------------------------------------------------------------------------------------------------------
// Interpreter (a): fast-check
// ---------------------------------------------------------------------------------------------------------------

function altArb(alternative: Alt): fc.Arbitrary<Draw> {
  const tag = alternative.t;
  if (alternative.values) return fc.constantFrom(...alternative.values).map((v) => ({ t: tag, v }));
  const [min, max] = alternative.range ?? [0, 0];
  return fc.integer({ min, max }).map((v) => ({ t: tag, v }));
}

function drawArb(alternatives: readonly Alt[]): fc.Arbitrary<Draw> {
  return fc.oneof(
    { withCrossShrink: true },
    ...alternatives.map((alternative) => ({ arbitrary: altArb(alternative), weight: alternative.w })),
  );
}

/** Recipes as a fast-check arbitrary. `fixed` pins individual draws (e.g. `{ residency: { t: 'abs', v: 2 } }`). */
export function recipeArb(fixed: Partial<Recipe> = {}): fc.Arbitrary<Recipe> {
  const shape = {} as { [K in keyof Recipe]: fc.Arbitrary<Draw> };
  for (const key of RECIPE_KEYS) {
    const pinned = fixed[key];
    shape[key] = pinned ? fc.constant(pinned) : drawArb(RECIPE[key]);
  }
  return fc.record(shape);
}

// ---------------------------------------------------------------------------------------------------------------
// Recipe -> PlannerInput
// ---------------------------------------------------------------------------------------------------------------

export interface RealiseOptions {
  /** Upper bound applied to every money input. */
  maxMoney: number;
}

const DEFAULT_OPTIONS: RealiseOptions = { maxMoney: 5_000_000 };

const RESIDENCIES: readonly Residency[] = ['citizen', 'pr', 'foreigner'];

function absOr(draw: Draw, fallback: number): number {
  return draw.t === 'abs' ? draw.v : fallback;
}

/** `PlannerInput.today` from the three date draws: a real calendar date in the income year ± the offset. */
function realiseToday(recipe: Recipe, incomeYear: number): string {
  const year = incomeYear + recipe.todayYearOffset.v;
  let month = recipe.todayMonth.v;
  let day = recipe.todayDay.v;
  if (recipe.todayMonth.t === 'special') {
    const special = SPECIAL_DATES[recipe.todayMonth.v] ?? [12, 31];
    month = special[0];
    day = special[1];
  }
  day = Math.min(day, daysInMonth(year, month));
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Turn a recipe into a `PlannerInput` (optional fields drawn as 'absent' are left out). */
export function realise(recipe: Recipe, options: RealiseOptions = DEFAULT_OPTIONS): PlannerInput {
  const money = (value: number): number => Math.max(0, Math.min(options.maxMoney, Math.floor(value)));
  const incomeYear = recipe.year.v;
  if (!isSpecYear(incomeYear)) throw new RangeError(`generators: unsupported year ${incomeYear}`);
  const residency = RESIDENCIES[recipe.residency.v] ?? 'citizen';
  const prYear = (recipe.prYear.t === 'abs' ? recipe.prYear.v : 3) as PrYear;
  const monthsWorked = absOr(recipe.monthsWorked, 12);

  // Wages. 'owCeiling': the year's Ordinary Wage ceiling plus v. 'awCeiling': the Additional Wage ceiling
  // (annual ceiling less ordinary wages subject to CPF) plus v.
  const owCeiling = SPEC_OW_CEILING[incomeYear];
  const wage = money(recipe.wage.t === 'owCeiling' ? owCeiling + recipe.wage.v : recipe.wage.v);
  const awCeiling = Math.max(0, SPEC_ANNUAL_WAGE_CEILING - Math.min(wage, owCeiling) * monthsWorked);
  const additionalWages = money(
    recipe.additionalWages.t === 'awCeiling' ? awCeiling + recipe.additionalWages.v : recipe.additionalWages.v,
  );
  const employmentIncome = wage * monthsWorked + additionalWages;
  const otherTaxableIncome = money(absOr(recipe.otherTaxableIncome, 0));

  // 'employmentIncome': expenses equal to the whole employment income plus v.
  const employmentExpenses = money(
    recipe.employmentExpenses.t === 'employmentIncome'
      ? employmentIncome + recipe.employmentExpenses.v
      : absOr(recipe.employmentExpenses, 0),
  );
  // 'wipeOut': the 250% deduction is as close as possible to total income (plus v dollars of donation).
  const totalIncome = Math.max(0, employmentIncome - employmentExpenses) + otherTaxableIncome;
  const donations = money(
    recipe.donations.t === 'wipeOut' ? Math.ceil(totalIncome / 2.5) + recipe.donations.v : absOr(recipe.donations, 0),
  );

  // 'maxCpf': the maximum compulsory employee contribution plus v.
  const override = recipe.employeeCpfOverride;
  const employeeCpfOverride =
    override.t === 'abs' ? money(override.v) : override.t === 'maxCpf' ? SPEC_MAX_COMPULSORY_CPF + override.v : null;

  // Existing contributions. 'cap': the scheme's relief cap for this residency plus v. 'capPercent': v% of it.
  const existingAmount = (draw: Draw, cap: number): number =>
    money(draw.t === 'cap' ? cap + draw.v : draw.t === 'capPercent' ? Math.floor((cap * draw.v) / 100) : draw.v);
  const srsCap = residency === 'foreigner' ? SPEC_SRS_CAP.foreigner : SPEC_SRS_CAP.citizenPr;

  const limit = (draw: Draw): number | null => (draw.t === 'abs' ? money(draw.v) : null);
  const minSavingRate =
    recipe.minSavingRate.t === 'millionths' ? recipe.minSavingRate.v / 1_000_000 : recipe.minSavingRate.v;

  const full: FullInput = {
    incomeYear,
    today: realiseToday(recipe, incomeYear),
    profile: {
      residency,
      prYear,
      ageAtYearEnd: recipe.age.v,
      birthMonth: absOr(recipe.birthMonth, 12),
      hasUnusedParenthoodTaxRebate: recipe.parenthoodRebate.t === 'abs' && recipe.parenthoodRebate.v === 1,
    },
    income: {
      monthlyOrdinaryWage: wage,
      monthsWorked,
      additionalWages,
      otherTaxableIncome,
      employmentExpenses,
      donations,
      employeeCpfOverride,
    },
    existing: {
      srs: existingAmount(recipe.existingSrs, srsCap),
      cpfTopUpSelf: existingAmount(recipe.existingSelf, SPEC_TOPUP_CAP),
      cpfTopUpFamily: existingAmount(recipe.existingFamily, SPEC_TOPUP_CAP),
    },
    otherReliefs: 0,
    levers: {
      srs: { enabled: recipe.srsEnabled.v === 1 },
      cpfSelf: { enabled: recipe.selfEnabled.v === 1, roomToLimit: limit(recipe.roomToLimit) },
      cpfFamily: { enabled: recipe.familyEnabled.v === 1, maxAmount: limit(recipe.maxAmount) },
    },
    preferences: {
      cashBudget: null,
      minSavingRate,
      priority: [...(PRIORITY_PERMUTATIONS[recipe.priority.v] ?? PRIORITY_PERMUTATIONS[0]!)],
      simulatorStep: absOr(recipe.simulatorStep, 1_000),
    },
  };

  // Other reliefs. 'toCap': chosen so that the baseline reliefs before the cap equal the S$80,000 cap plus v.
  // 'toBoundary': chosen so that the baseline chargeable income is a bracket boundary plus boundaryOffset.
  const withoutOther = specTax(full);
  const reliefsWithoutOther = withoutOther.reliefs.totalBeforeCap;
  if (recipe.otherReliefs.t === 'toCap') {
    full.otherReliefs = money(SPEC_RELIEF_CAP + recipe.otherReliefs.v - reliefsWithoutOther);
  } else if (recipe.otherReliefs.t === 'toBoundary') {
    // Other reliefs that put the baseline chargeable income on boundary + offset, for the boundaries that can be
    // reached with a non-negative amount and without exceeding the overall relief cap.
    const wholeAssessable = Math.floor(withoutOther.assessableIncome);
    const needed = (boundary: number): number => wholeAssessable - reliefsWithoutOther - (boundary + recipe.boundaryOffset.v);
    const reachable = BRACKET_BOUNDARIES.filter(
      (boundary) => needed(boundary) >= 0 && reliefsWithoutOther + needed(boundary) <= SPEC_RELIEF_CAP,
    );
    const boundary = reachable[recipe.otherReliefs.v % Math.max(1, reachable.length)];
    full.otherReliefs = boundary === undefined ? 0 : money(needed(boundary));
  } else {
    full.otherReliefs = money(recipe.otherReliefs.v);
  }

  // Cash budget. 'tie…': the plan's own lever room L / useful room U / relief-cap room C plus v, so that the
  // budget ties with (or sits a dollar either side of) another constraint.
  const budget = recipe.cashBudget;
  if (budget.t === 'abs') {
    full.preferences.cashBudget = money(budget.v);
  } else if (budget.t.startsWith('tie')) {
    const unconstrained = specPlan(full);
    const anchor =
      budget.t === 'tieLeverRoom'
        ? unconstrained.leverRoom
        : budget.t === 'tieUsefulRoom'
          ? unconstrained.usefulRoom
          : unconstrained.reliefCapRoom;
    full.preferences.cashBudget = money(anchor + budget.v);
  }

  // Assemble the PlannerInput, leaving out the optional fields that were drawn as absent.
  const input: PlannerInput = {
    incomeYear,
    today: full.today,
    profile: { residency, ageAtYearEnd: full.profile.ageAtYearEnd },
    income: { monthlyOrdinaryWage: wage, additionalWages },
    existing: { ...full.existing },
    otherReliefs: full.otherReliefs,
    levers: {
      srs: { enabled: full.levers.srs.enabled },
      cpfSelf: { enabled: full.levers.cpfSelf.enabled },
      cpfFamily: { enabled: full.levers.cpfFamily.enabled },
    },
    preferences: { minSavingRate, priority: full.preferences.priority },
  };
  if (recipe.prYear.t !== 'absent') input.profile.prYear = prYear;
  if (recipe.birthMonth.t !== 'absent') input.profile.birthMonth = full.profile.birthMonth;
  if (recipe.parenthoodRebate.t !== 'absent') {
    input.profile.hasUnusedParenthoodTaxRebate = full.profile.hasUnusedParenthoodTaxRebate;
  }
  if (recipe.monthsWorked.t !== 'absent') input.income.monthsWorked = monthsWorked;
  if (recipe.otherTaxableIncome.t !== 'absent') input.income.otherTaxableIncome = otherTaxableIncome;
  if (recipe.employmentExpenses.t !== 'absent') input.income.employmentExpenses = employmentExpenses;
  if (recipe.donations.t !== 'absent') input.income.donations = donations;
  if (override.t !== 'absent') input.income.employeeCpfOverride = employeeCpfOverride;
  if (recipe.roomToLimit.t !== 'absent') input.levers.cpfSelf.roomToLimit = full.levers.cpfSelf.roomToLimit;
  if (recipe.maxAmount.t !== 'absent') input.levers.cpfFamily.maxAmount = full.levers.cpfFamily.maxAmount;
  if (budget.t !== 'absent') input.preferences.cashBudget = full.preferences.cashBudget;
  if (recipe.simulatorStep.t !== 'absent') input.preferences.simulatorStep = full.preferences.simulatorStep;
  return input;
}

// ---------------------------------------------------------------------------------------------------------------
// (a) fast-check arbitraries
// ---------------------------------------------------------------------------------------------------------------

/** Valid planner inputs over the whole space, biased towards boundaries. */
export const plannerInputArb: fc.Arbitrary<PlannerInput> = recipeArb().map((recipe) => realise(recipe));

/** Valid planner inputs with some draws pinned. */
export function plannerInputWith(fixed: Partial<Recipe>): fc.Arbitrary<PlannerInput> {
  return recipeArb(fixed).map((recipe) => realise(recipe));
}

/** A copy of an input with some preferences replaced. */
export function withPreferences(input: PlannerInput, preferences: Partial<PlannerInput['preferences']>): PlannerInput {
  return { ...input, preferences: { ...input.preferences, ...preferences } };
}

/** Whole-dollar chargeable incomes: every bracket boundary ± a little, the tax-free band, and large values. */
export const chargeableIncomeArb: fc.Arbitrary<number> = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: 1_300_000 }), weight: 6 },
  {
    arbitrary: fc
      .tuple(fc.constantFrom(...BRACKET_BOUNDARIES), fc.integer({ min: -3, max: 3 }))
      .map(([boundary, offset]) => boundary + offset),
    weight: 4,
  },
  { arbitrary: fc.integer({ min: 0, max: 20_001 }), weight: 1 },
  { arbitrary: fc.integer({ min: 1_000_000, max: 140_000_000_000 }), weight: 1 },
);

/** Values no caller should pass but some will: used to show that the engine neither throws nor emits NaN. */
const weirdNumber = fc.constantFrom(
  Number.NaN,
  Infinity,
  -Infinity,
  -0,
  -1,
  -0.5,
  0.5,
  1e-9,
  99.999,
  1e10,
  1e10 + 1,
  1e15,
  2 ** 53,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  -Number.MAX_VALUE,
);

const weirdValue: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: weirdNumber, weight: 4 },
  { arbitrary: fc.double(), weight: 2 },
  { arbitrary: fc.integer(), weight: 2 },
  { arbitrary: fc.constantFrom<unknown>(null, undefined, true, false, '', '0', '5000', 'abc', '2026-11-13', [], {}), weight: 3 },
  {
    arbitrary: fc.anything({
      withBigInt: true,
      withBoxedValues: true,
      withDate: true,
      withMap: true,
      withNullPrototype: true,
      withObjectString: true,
      withSet: true,
      withSparseArray: true,
      withTypedArray: true,
    }),
    weight: 3,
  },
);

/** Any of the given keys may be missing; every present value is garbage. */
function garbageRecord(keys: readonly string[]): fc.Arbitrary<unknown> {
  const shape: Record<string, fc.Arbitrary<unknown>> = {};
  for (const key of keys) shape[key] = weirdValue;
  return fc.oneof({ arbitrary: fc.record(shape, { requiredKeys: [] }), weight: 4 }, { arbitrary: weirdValue, weight: 1 });
}

const supportedYear = fc.constantFrom(2025, 2026, 2027);

/**
 * Objects shaped like a `PlannerInput` whose every field (and every section) is `fc.anything()`-style garbage.
 * Only `incomeYear` is kept valid, because an unsupported year is the one documented reason for `plan` to throw.
 */
export const garbageShapedInputArb: fc.Arbitrary<unknown> = fc.record(
  {
    incomeYear: supportedYear,
    today: weirdValue,
    profile: garbageRecord(['residency', 'prYear', 'ageAtYearEnd', 'birthMonth', 'hasUnusedParenthoodTaxRebate']),
    income: garbageRecord([
      'monthlyOrdinaryWage',
      'monthsWorked',
      'additionalWages',
      'otherTaxableIncome',
      'employmentExpenses',
      'donations',
      'employeeCpfOverride',
    ]),
    existing: garbageRecord(['srs', 'cpfTopUpSelf', 'cpfTopUpFamily']),
    otherReliefs: weirdValue,
    levers: fc.oneof(
      fc.record(
        {
          srs: garbageRecord(['enabled']),
          cpfSelf: garbageRecord(['enabled', 'roomToLimit']),
          cpfFamily: garbageRecord(['enabled', 'maxAmount']),
        },
        { requiredKeys: [] },
      ),
      weirdValue,
    ),
    preferences: garbageRecord(['cashBudget', 'minSavingRate', 'priority', 'simulatorStep']),
  },
  { requiredKeys: ['incomeYear'] },
);

/** Paths of the fields a mutation may hit. `enabled` flags are left alone (SPEC §6.0 does not cover them). */
const MUTABLE_PATHS: readonly (readonly string[])[] = [
  ['today'],
  ['profile', 'residency'],
  ['profile', 'prYear'],
  ['profile', 'ageAtYearEnd'],
  ['profile', 'birthMonth'],
  ['profile', 'hasUnusedParenthoodTaxRebate'],
  ['income', 'monthlyOrdinaryWage'],
  ['income', 'monthsWorked'],
  ['income', 'additionalWages'],
  ['income', 'otherTaxableIncome'],
  ['income', 'employmentExpenses'],
  ['income', 'donations'],
  ['income', 'employeeCpfOverride'],
  ['existing', 'srs'],
  ['existing', 'cpfTopUpSelf'],
  ['existing', 'cpfTopUpFamily'],
  ['otherReliefs'],
  ['levers', 'cpfSelf', 'roomToLimit'],
  ['levers', 'cpfFamily', 'maxAmount'],
  ['preferences', 'cashBudget'],
  ['preferences', 'minSavingRate'],
  ['preferences', 'priority'],
  ['preferences', 'simulatorStep'],
];

/** Mutation value meaning "delete the key". */
const DELETE = Symbol('delete');

function setPath(target: unknown, path: readonly string[], value: unknown): void {
  let node = target as Record<string, unknown>;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== 'object' || next === null) return;
    node = next as Record<string, unknown>;
  }
  const last = path[path.length - 1]!;
  if (value === DELETE) delete node[last];
  else node[last] = value;
}

function mutated(input: PlannerInput, mutations: readonly (readonly [readonly string[], unknown])[]): unknown {
  const copy = JSON.parse(JSON.stringify(input)) as unknown;
  for (const [path, value] of mutations) setPath(copy, path, value);
  return copy;
}

/** A valid input with one to four fields replaced by garbage of any kind (including NaN and non-JSON values). */
export const mutatedInputArb: fc.Arbitrary<unknown> = fc
  .tuple(
    plannerInputArb,
    fc.array(fc.tuple(fc.constantFrom(...MUTABLE_PATHS), fc.oneof(weirdValue, fc.constant<unknown>(DELETE))), {
      minLength: 1,
      maxLength: 4,
    }),
  )
  .map(([input, mutations]) => mutated(input, mutations));

/** Garbage of both kinds. */
export const garbageInputArb: fc.Arbitrary<unknown> = fc.oneof(garbageShapedInputArb, mutatedInputArb);

// ---------------------------------------------------------------------------------------------------------------
// (b) seeded generators
// ---------------------------------------------------------------------------------------------------------------

/** `count` valid inputs, deterministic in `seed`. */
export function seededInputs(count: number, seed: number, options: RealiseOptions = DEFAULT_OPTIONS): PlannerInput[] {
  const rng = mulberry32(seed);
  const inputs: PlannerInput[] = [];
  for (let i = 0; i < count; i++) inputs.push(realise(drawRecipe(rng), options));
  return inputs;
}

/**
 * JSON-representable values for which SPEC §6.0 gives one unambiguous sanitised result, per kind of field.
 * (No NaN/Infinity/undefined — they cannot be written to a JSON file.) Since §6.0 was clarified it also settles
 * non-boolean `enabled` flags (only the boolean true enables a lever) and malformed-but-nearly-valid dates
 * (impossible dates, unpadded fields, leading whitespace and a trailing digit cannot be parsed), so both are here.
 * It also says that `hasUnusedParenthoodTaxRebate` is true only for the boolean true, and §6.5 that a room for the
 * person's own CPF counts as provided only when it is a number — which decides the plan from age 55.
 */
const MESSY = {
  money: [-1, -5_000.5, 0.9, 1_234.56, 99.999, 10_000_000_001, 1e12, 9e15, '5000', true, null, DELETE, [], {}],
  limit: [-1, -0.5, 0.5, 2_499.99, 10_000_000_001, '5000', false, DELETE, []],
  monthsWorked: [0, -1, 13, 100, 6.9, 7.2, 0.5, 11.999, '6', null, DELETE],
  birthMonth: [0, -3, 13, 6.5, '6', null, DELETE],
  age: [-5, 121, 500, 17.9, 54.99, 55.01, 59.5, '35', '55', null, DELETE],
  prYear: [0, 4, 1.5, 2.0001, '1', '2', null, true, DELETE],
  residency: ['PR', 'Citizen', '', 'foreigner ', 'non-resident', 5, null, DELETE],
  minSavingRate: [-0.1, 1.5, 2, 1.0000001, '0.07', null, true, DELETE],
  priority: [
    [],
    ['cpfFamily'],
    ['srs', 'srs', 'cpfSelf'],
    ['bogus', 'cpfFamily', 3, null],
    ['cpfSelf', 'cpfFamily', 'srs', 'cpfSelf', 'srs'],
    'srs',
    null,
    DELETE,
  ],
  simulatorStep: [0, 1, 99, 99.9, 100.5, 250.7, -100, '500', null, 1_000_000_000, DELETE],
  enabled: [true, false, 1, 0, 'true', 'false', 'yes', '', null, [], {}, [true], DELETE],
  // SPEC §6.0: `hasUnusedParenthoodTaxRebate` is true only for the boolean true; everything else is false
  flag: [true, true, false, 1, 0, 'true', 'false', 'yes', '', null, [], {}, [true], DELETE],
  // SPEC §6.5: a room is "provided" only when it is a number (then sanitised like money, so a negative room is 0)
  room: [0, 1, 3_000, 8_000, 50_000, -1, 0.5, 2_499.99, 10_000_000_001, '8000', '', true, false, null, [], {}, DELETE],
  today: [
    '',
    'garbage',
    '13/11/2026',
    '2026/11/13',
    'tomorrow',
    null,
    20261113,
    true,
    DELETE,
    'T',
    '2026-11-13T23:59:59+08:00',
    '2026-12-31T00:00:00.000Z',
    '2027-01-01 08:00',
    '2025-06-30T12:00',
    // nearly valid: SPEC §6.0 says none of these can be parsed
    '2026-02-30',
    '2026-13-01',
    '2026-1-5',
    ' 2026-11-13',
    '2026-11-135',
    '2026-11-31',
    '2026-00-10',
    '2027-02-29',
    '2100-02-29',
    '26-11-13',
    // unusual but parseable: leap days, year 0000, text straight after the date
    '2028-02-29',
    '2024-02-29',
    '0000-02-29',
    '2026-12-31x',
    '2026-11-13-05',
  ],
} as const;

const MESSY_FIELDS: readonly (readonly [readonly string[], readonly unknown[]])[] = [
  [['income', 'monthlyOrdinaryWage'], MESSY.money],
  [['income', 'additionalWages'], MESSY.money],
  [['income', 'otherTaxableIncome'], MESSY.money],
  [['income', 'employmentExpenses'], MESSY.money],
  [['income', 'donations'], MESSY.money],
  [['existing', 'srs'], MESSY.money],
  [['existing', 'cpfTopUpSelf'], MESSY.money],
  [['existing', 'cpfTopUpFamily'], MESSY.money],
  [['otherReliefs'], MESSY.money],
  [['income', 'employeeCpfOverride'], MESSY.limit],
  [['levers', 'cpfSelf', 'roomToLimit'], MESSY.room],
  [['levers', 'cpfFamily', 'maxAmount'], MESSY.limit],
  [['preferences', 'cashBudget'], MESSY.limit],
  [['income', 'monthsWorked'], MESSY.monthsWorked],
  [['profile', 'birthMonth'], MESSY.birthMonth],
  [['profile', 'ageAtYearEnd'], MESSY.age],
  [['profile', 'prYear'], MESSY.prYear],
  [['profile', 'residency'], MESSY.residency],
  [['preferences', 'minSavingRate'], MESSY.minSavingRate],
  [['preferences', 'priority'], MESSY.priority],
  [['preferences', 'simulatorStep'], MESSY.simulatorStep],
  [['today'], MESSY.today],
  [['levers', 'srs', 'enabled'], MESSY.enabled],
  [['levers', 'cpfSelf', 'enabled'], MESSY.enabled],
  [['levers', 'cpfFamily', 'enabled'], MESSY.enabled],
  [['profile', 'hasUnusedParenthoodTaxRebate'], MESSY.flag],
];

/**
 * `count` inputs that need SPEC §6.0 sanitising: valid inputs with one to three fields replaced by negative,
 * fractional, oversized, wrongly-typed or missing values. Everything stays JSON-representable. Deterministic.
 */
export function seededMessyInputs(count: number, seed: number): unknown[] {
  const rng = mulberry32(seed);
  const inputs: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const base = realise(drawRecipe(rng));
    const mutations: [readonly string[], unknown][] = [];
    const howMany = randomInt(rng, 1, 3);
    for (let m = 0; m < howMany; m++) {
      const [path, values] = randomPick(rng, MESSY_FIELDS);
      mutations.push([path, randomPick(rng, values)]);
    }
    inputs.push(mutated(base, mutations));
  }
  return inputs;
}

/** The same mutations as `seededMessyInputs`, as a fast-check arbitrary. */
export const messyInputArb: fc.Arbitrary<unknown> = fc
  .tuple(
    plannerInputArb,
    fc.array(
      fc.constantFrom(...MESSY_FIELDS).chain(([path, values]) => fc.constantFrom(...values).map((value) => [path, value] as const)),
      { minLength: 1, maxLength: 3 },
    ),
  )
  .map(([input, mutations]) => mutated(input, mutations));
