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

/**
 * 0.115 -> "11.5 cents", 0.07 -> "7 cents", 0.01 -> "1 cent", 0.02526 -> "2.53 cents".
 * Two decimals at most, the same precision as `pct`, so one rate never shows two ways on a page.
 */
export function centsPerDollar(rate: number | null | undefined): string {
  const v = Math.round(finite(rate) * 10000) / 100;
  return `${v} ${v === 1 ? 'cent' : 'cents'}`;
}

/** 0.115 -> "11.5": the cents-per-dollar figure on its own, for a column whose heading names the unit. */
export function centsFigure(rate: number | null | undefined): string {
  return String(Math.round(finite(rate) * 10000) / 100);
}

/**
 * Digits and separators typed on a Chinese or Japanese keyboard (full-width forms) as their plain equivalents,
 * so "１２，０００" reads the same as "12,000".
 */
export function toPlainDigits(text: string): string {
  return String(text ?? '')
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\uFF0C\u3001]/g, ',')
    .replace(/[\uFF0E\u3002]/g, '.')
    .replace(/\uFF4B|\uFF2B/g, 'k');
}

/**
 * Read a typed amount as whole dollars. Empty or unreadable text is 0. Never returns NaN.
 * - Commas are thousands separators; anything after a decimal point is dropped ("1,234.56" is 1,234).
 * - Dots that can only be thousands separators are read as such ("10.000" is 10,000, not 10).
 * - A trailing "k" means thousands ("12k" is 12,000, "1.5k" is 1,500).
 * - Full-width digits are accepted. A minus sign is ignored: no amount here can be negative.
 */
export function parseAmount(text: string): number {
  const raw = toPlainDigits(text).trim();
  const whole = (digits: string): number => {
    const n = Number(digits.replace(/\D/g, '').slice(0, 12));
    return Number.isFinite(n) ? n : 0;
  };
  const thousands = /^[^\d]*([\d.,\s]*\d)\s*k$/i.exec(raw);
  if (thousands) {
    const body = (thousands[1] ?? '').replace(/\s/g, '');
    // One separator followed by one or two digits is a decimal part: "1.5k", "12,5k".
    const decimal = /^(\d+)[.,](\d{1,2})$/.exec(body);
    if (decimal) {
      const n = Math.round(Number(`${decimal[1]}.${decimal[2]}`) * 1000);
      return Number.isFinite(n) ? Math.min(n, 999_999_999_999) : 0;
    }
    return Math.min(whole(body.split('.')[0] ?? '') * 1000, 999_999_999_999);
  }
  const body = raw.replace(/[^\d.,]/g, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(body)) return whole(body);
  return whole(body.split('.')[0] ?? '');
}

/** True when the text holds no digits at all. */
export function isBlank(text: string): boolean {
  return !/\d/.test(toPlainDigits(text));
}

/**
 * What a number field keeps of typed text: plain digits and separators, plus one trailing "k" in money fields.
 * `dropped` is true when something else was typed (letters, a minus sign), so the field can say what it read.
 */
export function cleanAmountText(text: string, allowK: boolean): { text: string; dropped: boolean } {
  const body = toPlainDigits(text)
    .trim()
    .replace(/^S?\$/i, '');
  const endsK = allowK && /\d\s*k$/i.test(body);
  const core = endsK ? body.replace(/\s*k$/i, '') : body;
  return { text: core.replace(/[^\d,.]/g, '') + (endsK ? 'k' : ''), dropped: /[^\d,.\s]/.test(core) };
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
