/**
 * Exact-arithmetic helpers (SPEC §6.0).
 *
 * Money inputs are whole dollars and every rate is a short decimal, so the engine does its rate arithmetic on
 * integers (per-mille for tax, millionths for CPF, cents for money) and converts to dollars only at the end.
 * Nothing here accumulates binary floating-point error.
 */

/**
 * Largest value accepted for any money input (S$10 billion, SPEC §6.0). The bound exists only so that every
 * intermediate integer (the largest is tax in cents × a rebate rate per mille) stays below 2^53 and the
 * arithmetic remains exact. No realistic input is affected.
 */
export const MAX_MONEY = 10_000_000_000;

const RATE_MILLIONTHS = 1_000_000;

/** SPEC §6.0 numeric sanitising: not a finite number, or negative -> 0; otherwise rounded down to a whole number. */
export function wholeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** floor(a / b) for a non-negative integer `a` and a positive integer `b`, without a floating-point quotient. */
export function floorDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}

/** A tax rate as a whole number per mille (0.115 -> 115). Exact because rates have at most one decimal of a percent. */
export function ratePerMille(rate: number): number {
  return Math.round(rate * 1000);
}

/** A CPF rate or phase-in factor as a whole number of millionths (0.155 -> 155,000). */
export function rateInMillionths(rate: number): number {
  return Math.round(rate * RATE_MILLIONTHS);
}

/** floor(rate × dollars) for a CPF rate and a whole-dollar amount, computed exactly. */
export function floorRateTimesDollars(rate: number, dollars: number): number {
  return floorDiv(rateInMillionths(rate) * dollars, RATE_MILLIONTHS);
}

/** A sum of (rate in millionths × whole dollars) rounded half-up to the nearest dollar. */
export function roundMillionthsToDollars(millionths: number): number {
  return floorDiv(millionths + RATE_MILLIONTHS / 2, RATE_MILLIONTHS);
}

/** Dollars (at most two decimal places) as a whole number of cents. */
export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** A whole number of cents as dollars. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** `a − b` for two dollar amounts, exact to the cent (the SPEC's `round2` of a difference). */
export function subtractMoney(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b));
}
