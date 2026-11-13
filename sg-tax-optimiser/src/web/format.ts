/**
 * Number, money and date formatting for the web calculator.
 * Pure functions: no DOM, no locale lookups that vary by device.
 */

const WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const CENTS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
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

/** Never let NaN or Infinity reach the screen. */
export function finite(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** "23,300" — whole number with thousands separators. */
export function plain(n: number | null | undefined): string {
  const v = Math.round(finite(n));
  return (v < 0 ? '−' : '') + WHOLE.format(Math.abs(v));
}

/** "S$23,300" — whole dollars (contributions, income, reliefs). */
export function dollars(n: number | null | undefined): string {
  const v = Math.round(finite(n));
  return (v < 0 ? '−' : '') + 'S$' + WHOLE.format(Math.abs(v));
}

/** "S$2,679.50" — dollars and cents (tax amounts). */
export function cents(n: number | null | undefined): string {
  const v = Math.round(finite(n) * 100) / 100;
  return (v < 0 ? '−' : '') + 'S$' + CENTS.format(Math.abs(v));
}

/** 0.115 -> "11.5%", 0.07 -> "7%", 0.02526 -> "2.53%". */
export function pct(rate: number | null | undefined, maxDecimals = 2): string {
  const scale = 10 ** maxDecimals;
  const v = Math.round(finite(rate) * 100 * scale) / scale;
  return `${v}%`;
}

/** 0.115 -> "11.5 cents", 0.07 -> "7 cents", 0.01 -> "1 cent". */
export function centsPerDollar(rate: number | null | undefined): string {
  const v = Math.round(finite(rate) * 1000) / 10;
  return `${v} ${v === 1 ? 'cent' : 'cents'}`;
}

/**
 * Read a typed amount: digits and thousands separators, anything after a decimal point dropped.
 * Empty or unreadable text is 0. Never returns NaN.
 */
export function parseAmount(text: string): number {
  const head = String(text ?? '').split('.')[0] ?? '';
  const digits = head.replace(/\D/g, '').slice(0, 12);
  if (digits === '') return 0;
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
}

/** True when the text holds no digits at all. */
export function isBlank(text: string): boolean {
  return !/\d/.test(String(text ?? ''));
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parts(iso: string): DateParts | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(iso ?? ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = m[3] ? Number(m[3]) : 1;
  if (month < 1 || month > 12) return null;
  return { year, month, day };
}

/** "2026-12-31" -> "31 Dec 2026". */
export function shortDate(iso: string): string {
  const p = parts(iso);
  if (!p) return iso;
  return `${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}`;
}

/** "2026-12-31" -> "31 December 2026". */
export function longDate(iso: string): string {
  const p = parts(iso);
  if (!p) return iso;
  return `${p.day} ${MONTHS_LONG[p.month - 1]} ${p.year}`;
}

/** "2026-12-31" -> "31 December". */
export function dayAndMonth(iso: string): string {
  const p = parts(iso);
  if (!p) return iso;
  return `${p.day} ${MONTHS_LONG[p.month - 1]}`;
}

/** "2026-11" -> "Nov 2026". */
export function monthLabel(yearMonth: string): string {
  const p = parts(yearMonth);
  if (!p) return yearMonth;
  return `${MONTHS_SHORT[p.month - 1]} ${p.year}`;
}

/** 1 -> "January". */
export function monthName(month: number): string {
  return MONTHS_LONG[Math.min(12, Math.max(1, Math.round(finite(month)))) - 1] ?? '';
}

/** The device's local calendar date as YYYY-MM-DD. */
export function localIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "1 day", "48 days". */
export function countOf(n: number, singular: string, plural = `${singular}s`): string {
  const v = Math.round(finite(n));
  return `${plain(v)} ${Math.abs(v) === 1 ? singular : plural}`;
}

/** ["a", "b", "c"] -> "a, b and c". */
export function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
