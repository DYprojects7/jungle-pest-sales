/**
 * The optimiser (SPEC §6.6): how much to contribute in total, and to which lever first.
 *
 * Every relief dollar lowers chargeable income by one dollar whichever lever it goes into, and tax is convex in
 * chargeable income, so taking dollars in order until one fails a constraint is optimal.
 */
import { taxPayableAfter, taxWith } from './evaluate';
import type { EngineContext } from './evaluate';
import { allocate } from './levers';
import { subtractMoney } from './money';
import { usefulRoom } from './tax';
import type { BindingConstraint, Plan, TaxComputation } from './types';

export interface Optimisation {
  plan: Plan;
  /** Tax position after the plan. */
  optimised: TaxComputation;
  /** §6.6 U: dollars of relief that each still save at least the user's minimum rate. */
  usefulRoom: number;
}

/**
 * §6.6 "Binding constraint": `'none'` when there is no tax to save; otherwise the smallest of U, C, L and B,
 * ties resolved in the order usefulRoom, reliefCap, leverLimits, cashBudget.
 */
function bindingConstraint(
  taxBefore: number,
  useful: number,
  reliefCapRoom: number,
  leverRoom: number,
  budget: number,
): BindingConstraint {
  if (taxBefore === 0) return 'none';
  const smallest = Math.min(useful, reliefCapRoom, leverRoom, budget);
  if (useful === smallest) return 'usefulRoom';
  if (reliefCapRoom === smallest) return 'reliefCap';
  if (leverRoom === smallest) return 'leverLimits';
  return 'cashBudget';
}

/** SPEC §6.6. */
export function optimise(ctx: EngineContext): Optimisation {
  const { input, rules, baseline, reliefCapRoom, leverRoom } = ctx;
  const { cashBudget, minSavingRate, priority } = input.preferences;

  const useful = usefulRoom(baseline.chargeableIncome, minSavingRate, rules);
  const budget = cashBudget === null ? Infinity : cashBudget;
  const totalContribution = Math.min(useful, reliefCapRoom, leverRoom, budget);

  const contributions = allocate(totalContribution, ctx.rooms, priority);
  const optimised = taxWith(ctx, contributions);
  const taxBefore = baseline.taxPayable;
  const taxAfter = optimised.taxPayable;
  const taxSaved = subtractMoney(taxBefore, taxAfter);

  // Tax payable if only the minimum rate and the relief cap limited the plan (unlimited schemes and budget).
  const taxAtFullUse = taxPayableAfter(ctx, Math.min(useful, reliefCapRoom));

  return {
    plan: {
      contributions,
      totalContribution,
      taxBefore,
      taxAfter,
      taxSaved,
      savingRate: totalContribution === 0 ? 0 : taxSaved / totalContribution,
      chargeableIncomeBefore: baseline.chargeableIncome,
      chargeableIncomeAfter: optimised.chargeableIncome,
      marginalRateBefore: baseline.marginalRate,
      marginalRateAfter: optimised.marginalRate,
      bindingConstraint: bindingConstraint(taxBefore, useful, reliefCapRoom, leverRoom, budget),
      unrealisedSaving: subtractMoney(taxAfter, taxAtFullUse),
    },
    optimised,
    usefulRoom: useful,
  };
}
