/**
 * Two facts about the build, fixed when the page is built (vite.config.ts):
 * - the version, from package.json;
 * - the shop address for the paid workbook, from VITE_BUY_URL. The committed release file is built without one,
 *   and then the page shows no link at all. (A value that is empty or not a web address is built as no value:
 *   vite.config.ts normalises it, so such a build is the same file, byte for byte.)
 */
import { safeWebAddress } from './address';

export { safeWebAddress };

declare const __APP_VERSION__: string | undefined;

/** The version in package.json, e.g. "1.0.0". Empty when the code runs outside a build (unit tests). */
export const VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

function readBuyUrl(): string {
  try {
    return safeWebAddress(import.meta.env.VITE_BUY_URL);
  } catch {
    return '';
  }
}

/** Where the paid workbook is sold, or '' when the build was given no address. */
export const BUY_URL: string = readBuyUrl();

export const BUY_LABEL = 'Get the Excel / Google Sheets workbook';
