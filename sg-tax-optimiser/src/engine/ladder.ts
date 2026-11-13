/**
 * The savings ladder (SPEC §6.7): the range [0, L] of possible additional contributions cut into tiers that each
 * save tax at one rate, in the order the dollars would be contributed.
 */
import { taxPayableAfter } from './evaluate';
import type { EngineContext } from './evaluate';
import { subtractMoney } from './money';
import type { LadderTier } from './types';

/** A slice [from, to) of additional contribution with one statutory saving rate. */
interface Piece {
  from: number;
  to: number;
  rate: number;
  zeroReason?: 'belowTaxThreshold' | 'reliefCap';
}

/**
 * §6.7 steps 1 and 2: the pieces before merging.
 * Contribution dollar `c` (counting from 0) takes chargeable income from `CI0 − c` to `CI0 − c − 1`, so it saves
 * tax at the rate of the bracket holding dollar `CI0 − c`; bracket k therefore ends at contribution `CI0 − from_k`.
 */
function pieces(ctx: EngineContext): Piece[] {
  const bracketsFromTop = [...ctx.rules.taxBrackets].reverse();
  const startingIncome = ctx.baseline.chargeableIncome;
  const totalRoom = ctx.leverRoom;
  const withinCap = Math.min(totalRoom, ctx.reliefCapRoom);
  const result: Piece[] = [];
  let cursor = 0;

  // Step 1: dollars that reduce chargeable income, from the bracket holding CI0 downwards.
  for (const bracket of bracketsFromTop) {
    const end = Math.min(withinCap, startingIncome - bracket.from);
    if (end > cursor) {
      result.push(
        bracket.rate === 0
          ? { from: cursor, to: end, rate: 0, zeroReason: 'belowTaxThreshold' }
          : { from: cursor, to: end, rate: bracket.rate },
      );
      cursor = end;
    }
  }
  // Still step 1: dollars beyond CI0, when chargeable income is already zero.
  if (cursor < withinCap) {
    result.push({ from: cursor, to: withinCap, rate: 0, zeroReason: 'belowTaxThreshold' });
  }
  // Step 2: dollars beyond the overall relief cap.
  if (withinCap < totalRoom) {
    result.push({ from: withinCap, to: totalRoom, rate: 0, zeroReason: 'reliefCap' });
  }
  return result;
}

/** §6.7: adjacent pieces with the same rate and the same zero reason become one tier. */
function merge(all: Piece[]): Piece[] {
  const merged: Piece[] = [];
  for (const piece of all) {
    const previous = merged[merged.length - 1];
    if (previous && previous.rate === piece.rate && previous.zeroReason === piece.zeroReason) {
      previous.to = piece.to;
    } else {
      merged.push({ ...piece });
    }
  }
  return merged;
}

/**
 * SPEC §6.7.
 * @param planTotal X, the plan's total additional contribution (for `usedByPlan`)
 */
export function buildLadder(ctx: EngineContext, planTotal: number): LadderTier[] {
  const taxAtStart = taxPayableAfter(ctx, 0);
  return merge(pieces(ctx)).map((piece) => {
    const taxAtEnd = taxPayableAfter(ctx, piece.to);
    const tier: LadderTier = {
      fromContribution: piece.from,
      toContribution: piece.to,
      amount: piece.to - piece.from,
      rate: piece.rate,
      taxSaved: subtractMoney(taxPayableAfter(ctx, piece.from), taxAtEnd),
      cumulativeTaxSaved: subtractMoney(taxAtStart, taxAtEnd),
      usedByPlan: Math.max(0, Math.min(piece.to, planTotal) - piece.from),
    };
    if (piece.zeroReason !== undefined) tier.zeroReason = piece.zeroReason;
    return tier;
  });
}
