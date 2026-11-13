/**
 * The tax table, band by band, for the "How your tax is worked out" panel.
 *
 * This does not work out tax itself. Every tax figure is the engine's own `grossTax` read at a band edge, and a
 * band's tax is the step between two of those readings, so the rows always add up to the engine's gross tax.
 */
import { grossTax } from '../engine';
import type { YearRules } from '../engine/types';

export interface BandFigures {
  /** Chargeable income that falls inside the band. */
  income: number;
  /** Tax on that income. */
  tax: number;
}

export interface BandRow {
  from: number;
  /** Upper edge of the band; null for the open-ended top band. */
  to: number | null;
  rate: number;
  before: BandFigures;
  after: BandFigures;
}

function inBand(chargeableIncome: number, from: number, to: number | null, rules: YearRules): BandFigures {
  const top = to === null ? chargeableIncome : Math.min(chargeableIncome, to);
  if (top <= from) return { income: 0, tax: 0 };
  const taxCents = Math.round(grossTax(top, rules) * 100) - Math.round(grossTax(from, rules) * 100);
  return { income: top - from, tax: taxCents / 100 };
}

/** One row per band that either chargeable income reaches. */
export function bandRows(rules: YearRules, chargeableBefore: number, chargeableAfter: number): BandRow[] {
  const brackets = rules.taxBrackets;
  const rows: BandRow[] = [];
  brackets.forEach((bracket, i) => {
    const to = brackets[i + 1]?.from ?? null;
    const before = inBand(chargeableBefore, bracket.from, to, rules);
    const after = inBand(chargeableAfter, bracket.from, to, rules);
    if (before.income > 0 || after.income > 0) {
      rows.push({ from: bracket.from, to, rate: bracket.rate, before, after });
    }
  });
  return rows;
}
