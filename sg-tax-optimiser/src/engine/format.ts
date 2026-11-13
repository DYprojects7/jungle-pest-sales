/**
 * Number formatting for warning messages (SPEC §6.11). Written out by hand so the text is identical in every
 * browser and in Node, whatever the locale.
 */
import { floorDiv, toCents } from './money';

function groupThousands(wholeDollars: number): string {
  return String(wholeDollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A whole-dollar amount, e.g. "S$15,300". */
export function formatDollars(amount: number): string {
  return `S$${groupThousands(amount)}`;
}

/** A tax amount with cents, e.g. "S$2,679.50". */
export function formatTax(amount: number): string {
  const cents = toCents(amount);
  return `S$${groupThousands(floorDiv(cents, 100))}.${String(cents % 100).padStart(2, '0')}`;
}

/** A rate as a percentage with up to two decimals, e.g. 0.115 -> "11.5%". */
export function formatPercent(rate: number): string {
  return `${Math.round(rate * 10_000) / 100}%`;
}
