/**
 * Orchestration: one sanitised input and one year's rules in, the whole `PlannerResult` out (SPEC §6, §7).
 *
 * The rules are a parameter, so the model can be run against any rule set (for example a year with a
 * Personal Income Tax Rebate). The public API in `index.ts` sanitises the input and looks the rules up by
 * income year.
 */
import { buildContext, taxWith } from './evaluate';
import { buildLadder } from './ladder';
import { buildMonthlyPlan } from './monthlyPlan';
import { optimise } from './optimiser';
import { money } from './sanitise';
import type { SanitisedInput } from './sanitise';
import { buildScenarios } from './scenarios';
import { buildSimulator } from './simulator';
import type { LeverAmounts, PlannerResult, TaxComputation, YearRules } from './types';
import { buildWarnings } from './warnings';

/** Additional contributions as whole dollars (SPEC §6.0); tolerates a missing or malformed object. */
function sanitiseAmounts(additional: LeverAmounts): LeverAmounts {
  const raw: Partial<Record<keyof LeverAmounts, unknown>> =
    typeof additional === 'object' && additional !== null ? additional : {};
  return { srs: money(raw.srs), cpfSelf: money(raw.cpfSelf), cpfFamily: money(raw.cpfFamily) };
}

/** SPEC §6.4 `evaluate` for a sanitised input. */
export function evaluateFor(input: SanitisedInput, additional: LeverAmounts, rules: YearRules): TaxComputation {
  return taxWith(buildContext(input, rules), sanitiseAmounts(additional));
}

/** SPEC §7 `plan` for a sanitised input. */
export function planFor(input: SanitisedInput, rules: YearRules): PlannerResult {
  const ctx = buildContext(input, rules);
  const optimisation = optimise(ctx);
  const { plan } = optimisation;
  const monthlyPlan = buildMonthlyPlan(ctx.input.today, rules, plan.contributions);

  return {
    rules,
    input: ctx.input,
    cpf: ctx.cpf,
    baseline: ctx.baseline,
    optimised: optimisation.optimised,
    levers: ctx.levers,
    reliefCapRoom: ctx.reliefCapRoom,
    plan,
    ladder: buildLadder(ctx, plan.totalContribution),
    simulator: buildSimulator(ctx, plan.totalContribution),
    scenarios: buildScenarios(ctx, plan),
    monthlyPlan,
    warnings: buildWarnings(ctx, optimisation, monthlyPlan),
  };
}
