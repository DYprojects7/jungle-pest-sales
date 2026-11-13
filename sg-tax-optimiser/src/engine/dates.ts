/**
 * Calendar arithmetic on ISO date strings (SPEC §6.10). Pure integer maths: the engine never constructs a
 * `Date` and never reads the system clock.
 */

export interface CivilDate {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Parse a string that starts with a real calendar date written `YYYY-MM-DD` (a time suffix is ignored).
 * Returns null for anything else, including impossible dates such as 2026-02-30.
 */
export function parseIsoDate(text: unknown): CivilDate | null {
  if (typeof text !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** `YYYY-MM-DD`. */
export function formatIsoDate(date: CivilDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** `YYYY-MM`. */
export function formatIsoMonth(year: number, month: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}`;
}

/** A date as written in messages, e.g. "31 December 2026". */
export function formatLongDate(date: CivilDate): string {
  return `${date.day} ${MONTH_NAMES[date.month - 1]} ${date.year}`;
}

/** Number of days from 0001-01-01 (day 1) to the given date in the proleptic Gregorian calendar. */
function dayNumber(date: CivilDate): number {
  const priorYears = date.year - 1;
  const leapDays = Math.floor(priorYears / 4) - Math.floor(priorYears / 100) + Math.floor(priorYears / 400);
  let dayOfYear = date.day;
  for (let month = 1; month < date.month; month++) dayOfYear += daysInMonth(date.year, month);
  return priorYears * 365 + leapDays + dayOfYear;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: CivilDate, to: CivilDate): number {
  return dayNumber(to) - dayNumber(from);
}
