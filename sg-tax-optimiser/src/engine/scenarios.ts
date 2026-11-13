/**
 * Scenario comparison (SPEC §6.9): fixed what-ifs on the same inputs, next to the recommended plan.
 *
 * Scenarios ignore the budget, the minimum saving rate, the priority order and the `enabled` flags of `srs` and
 * `cpfSelf`, but respect eligibility, existing contributions and the user's room limits. `cpfFamily` is included
 * only when it is enabled.
 */
import { taxWith } from './evaluate';
import type { EngineContext } from './evaluate';
import { noContributions, totalOf } from './levers';
import { subtractMoney } from './money';
import { usefulRoom } from './tax';
import type { LeverAmounts, Plan, Scenario, ScenarioId } from './types';

/** One scenario's figures for the given contributions. */
function scenario(ctx: EngineContext, id: ScenarioId, contributions: LeverAmounts): Scenario {
  const totalContribution = totalOf(contributions);
  const taxPayable = taxWith(ctx, contributions).taxPayable;
  const taxSaved = subtractMoney(ctx.baseline.taxPayable, taxPayable);
  // Dollars that still reduce tax: down to the tax-free threshold and up to the overall relief cap.
  const effective = Math.min(
    totalContribution,
    usefulRoom(ctx.baseline.chargeableIncome, 0, ctx.rules),
    ctx.reliefCapRoom,
  );
  return {
    id,
    contributions,
    totalContribution,
    taxPayable,
    taxSaved,
    savingRate: totalContribution === 0 ? 0 : taxSaved / totalContribution,
    wastedContribution: totalContribution - effective,
  };
}

/** SPEC §6.9, in the order of the SPEC's table. */
export function buildScenarios(ctx: EngineContext, plan: Plan): Scenario[] {
  const srs = ctx.roomIfEnabled.srs;
  const cpfSelf = ctx.roomIfEnabled.cpfSelf;
  const cpfFamily = ctx.rooms.cpfFamily;
  return [
    scenario(ctx, 'none', noContributions()),
    scenario(ctx, 'srsOnly', { ...noContributions(), srs }),
    scenario(ctx, 'cpfSelfOnly', { ...noContributions(), cpfSelf }),
    scenario(ctx, 'srsPlusCpfSelf', { ...noContributions(), srs, cpfSelf }),
    scenario(ctx, 'maxAll', { srs, cpfSelf, cpfFamily }),
    scenario(ctx, 'recommended', { ...plan.contributions }),
  ];
}
