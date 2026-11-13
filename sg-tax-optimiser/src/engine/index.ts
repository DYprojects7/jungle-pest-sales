/**
 * Singapore Tax Optimiser — engine API (SPEC §7).
 *
 * Pure and dependency-free: no I/O, no clock, the same code in the browser and in Node.
 */
import { computeCpfFor } from './cpf';
import { evaluateFor, planFor } from './plan';
import { getRules } from './rules';
import { sanitise } from './sanitise';
import type {
  CpfComputation,
  LeverAmounts,
  PlannerInput,
  PlannerResult,
  TaxComputation,
  YearRules,
} from './types';

export * from './types';
export { SUPPORTED_INCOME_YEARS, defaultIncomeYear, getRules } from './rules';
export { defaultInput } from './defaults';
export { grossTax, marginalRate } from './tax';
export { DISCLAIMER, NON_RESIDENT_SRS_COST, NOT_MODELLED, lockUpFacts, lockUpHorizon, transferCautions } from './facts';
export type { FactsProfile, LockUpFactId, LockUpFactRow, LockUpHorizon } from './facts';

/**
 * Everything in one call: CPF, baseline tax, the recommended plan, ladder, simulator, scenarios, monthly plan
 * and warnings. Never throws for a sanitisable input; throws a RangeError for an unsupported `incomeYear`.
 */
export function plan(input: PlannerInput): PlannerResult {
  const rules = rulesFor(input);
  return planFor(sanitise(input), rules);
}

/**
 * The rule set named by an input as the caller gave it. Looked up before sanitising, so that an `incomeYear` of
 * the wrong type (or no input at all) is reported as what it is rather than as "income year NaN".
 */
function rulesFor(input: PlannerInput): YearRules {
  const raw: unknown = input;
  const given = typeof raw === 'object' && raw !== null ? (raw as { incomeYear?: unknown }).incomeYear : undefined;
  return getRules(given as number);
}

/**
 * The full tax computation for the profile with `additional` contributions on top of the existing ones
 * (SPEC §6.4). Throws a RangeError for an unsupported `incomeYear`.
 */
export function evaluate(input: PlannerInput, additional: LeverAmounts): TaxComputation {
  const rules = rulesFor(input);
  return evaluateFor(sanitise(input), additional, rules);
}

/** The year's compulsory employee CPF contribution under the given rules (SPEC §6.1). */
export function computeCpf(input: PlannerInput, rules: YearRules): CpfComputation {
  return computeCpfFor(sanitise(input), rules);
}

/** The input after sanitising and defaulting (SPEC §6.0): what the engine actually uses. Never throws. */
export function sanitiseInput(input: PlannerInput): PlannerInput {
  return sanitise(input);
}
