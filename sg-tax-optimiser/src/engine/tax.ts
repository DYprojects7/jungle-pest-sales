/**
 * Tax on a chargeable income (SPEC §6.4).
 *
 * The bracket sum is done in integer "mills" (dollars × rate per mille = thousandths of a dollar) and rounded
 * to cents half-up exactly once (§6.0), so there is no floating-point drift.
 */
import { MAX_MONEY, floorDiv, fromCents, ratePerMille, toCents, wholeNumber } from './money';
import type { TaxBracket, YearRules } from './types';

/**
 * The largest chargeable income the engine can produce: twelve months' wages, additional wages and other
 * income, each at MAX_MONEY. The public tax functions clamp their argument to it so the mills stay exact.
 */
const MAX_CHARGEABLE_INCOME = 14 * MAX_MONEY;

/**
 * Chargeable income is a whole-dollar amount (§6.3 floors it), so an argument from outside the engine is
 * sanitised like every money input (§6.0): not finite or negative -> 0, otherwise rounded down.
 */
function chargeableIncomeArgument(value: number): number {
  return Math.min(wholeNumber(value), MAX_CHARGEABLE_INCOME);
}

/** The three tax figures for one chargeable income, in dollars rounded to cents. */
export interface TaxDue {
  grossTax: number;
  pitRebate: number;
  taxPayable: number;
}

/**
 * Gross tax in whole cents for a whole-dollar chargeable income:
 * `Σ rate_k × max(0, min(ci, from_{k+1}) − from_k)`, rounded half-up to the cent.
 */
function grossTaxCents(chargeableIncome: number, brackets: readonly TaxBracket[]): number {
  let mills = 0;
  brackets.forEach((bracket, k) => {
    const nextFrom = brackets[k + 1]?.from ?? Infinity;
    const dollarsInBracket = Math.max(0, Math.min(chargeableIncome, nextFrom) - bracket.from);
    mills += ratePerMille(bracket.rate) * dollarsInBracket;
  });
  return floorDiv(mills + 5, 10);
}

/** SPEC §6.4 `grossTax`: tax from the rate table, in dollars rounded to cents. */
export function grossTax(chargeableIncome: number, rules: YearRules): number {
  return fromCents(grossTaxCents(chargeableIncomeArgument(chargeableIncome), rules.taxBrackets));
}

/**
 * SPEC §6.4 `marginalRate`: 0 when chargeable income is 0, otherwise the rate of the bracket that the LAST dollar
 * falls in (the bracket with the largest `from` below the chargeable income).
 */
export function marginalRate(chargeableIncome: number, rules: YearRules): number {
  const ci = chargeableIncomeArgument(chargeableIncome);
  let rate = 0;
  for (const bracket of rules.taxBrackets) {
    if (bracket.from < ci) rate = bracket.rate;
  }
  return rate;
}

/**
 * SPEC §6.4: gross tax, the Personal Income Tax Rebate (`min(cap, round2(rate × grossTax))`, 0 when the year has
 * none) and tax payable (`max(0, grossTax − pitRebate)`) for a whole-dollar chargeable income.
 */
export function taxDue(chargeableIncome: number, rules: YearRules): TaxDue {
  const grossCents = grossTaxCents(chargeableIncome, rules.taxBrackets);
  const rebateCents =
    rules.pitRebate === null
      ? 0
      : Math.min(
          toCents(rules.pitRebate.cap),
          floorDiv(ratePerMille(rules.pitRebate.rate) * grossCents + 500, 1000),
        );
  return {
    grossTax: fromCents(grossCents),
    pitRebate: fromCents(rebateCents),
    taxPayable: fromCents(Math.max(0, grossCents - rebateCents)),
  };
}

/**
 * SPEC §6.6 `usefulRoom(r)`: how many dollars chargeable income can fall before the next relief dollar would
 * save less than `minRate` (or nothing). `floorCI(r)` is the `from` of the lowest bracket whose rate is
 * positive and at least `r`; when no bracket qualifies there is no useful room.
 */
export function usefulRoom(chargeableIncome: number, minRate: number, rules: YearRules): number {
  const floorBracket = rules.taxBrackets.find((bracket) => bracket.rate > 0 && bracket.rate >= minRate);
  return floorBracket ? Math.max(0, chargeableIncome - floorBracket.from) : 0;
}
