/**
 * The one check on the shop address of the paid workbook (VITE_BUY_URL). It is used twice: when the page is
 * built (vite.config.ts), so that a value that is not a web address is built exactly like no value at all, and
 * in the page itself (build.ts), so that nothing but a web address is ever turned into a link.
 *
 * Kept free of anything that only exists in the browser or in a Vite build, so both can import it.
 */

/** Only a web address is ever turned into a link. Anything else is treated as "no shop address". */
export function safeWebAddress(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(text) ? text : '';
}
