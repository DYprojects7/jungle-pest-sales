/**
 * The simulator (SPEC §6.8): tax payable and tax saved for every extra step of contribution, up to the total
 * room of the enabled levers. It ignores the cash budget and the minimum saving rate.
 */
import { taxWith } from './evaluate';
import type { EngineContext } from './evaluate';
import { allocate } from './levers';
import { subtractMoney } from './money';
import type { SimulatorRow } from './types';

/**
 * SPEC §6.8. Rows for contributions `c_i = min(i × step, L)`, `i = 0 … ceil(L / step)`.
 * @param planTotal X, the plan's total additional contribution (for `withinPlan`)
 */
export function buildSimulator(ctx: EngineContext, planTotal: number): SimulatorRow[] {
  const { simulatorStep, priority } = ctx.input.preferences;
  const totalRoom = ctx.leverRoom;
  const rows: SimulatorRow[] = [];
  let previous: SimulatorRow | undefined;

  for (let i = 0; i <= Math.ceil(totalRoom / simulatorStep); i++) {
    const contribution = Math.min(i * simulatorStep, totalRoom);
    const split = allocate(contribution, ctx.rooms, priority);
    const taxPayable = taxWith(ctx, split).taxPayable;
    const taxSaved = subtractMoney(ctx.baseline.taxPayable, taxPayable);
    const stepSaving = previous ? subtractMoney(taxSaved, previous.taxSaved) : 0;
    const row: SimulatorRow = {
      contribution,
      split,
      taxPayable,
      taxSaved,
      stepSaving,
      stepRate: previous ? stepSaving / (contribution - previous.contribution) : 0,
      withinPlan: contribution <= planTotal,
    };
    rows.push(row);
    previous = row;
  }
  return rows;
}
