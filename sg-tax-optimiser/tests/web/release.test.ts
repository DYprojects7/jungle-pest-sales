/**
 * Release-file freshness (SPEC section 10): release/sg-tax-optimiser.html must be the current build of src/web.
 *
 * Strict mode only (`npm run test:release`, SGTO_STRICT=1): the page is built again into a scratch folder and
 * compared byte for byte with the file that ships. The build is deterministic, so any difference means the
 * source has changed since `npm run build:release` was last run (or the release file was edited by hand).
 *
 * The shipped file is built WITHOUT a shop address. A build is "without" one when VITE_BUY_URL is not set, is
 * set but empty, or is not a web address: vite.config.ts builds all three to the same bytes, and the checks
 * below hold it to that, so a shell that exports an empty VITE_BUY_URL cannot make a fresh release look stale.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const RELEASE = resolve(ROOT, 'release/sg-tax-optimiser.html');
const SCRATCH = resolve(ROOT, '.tmp/release-check');
const VITE = resolve(ROOT, 'node_modules/vite/bin/vite.js');
const STRICT = process.env.SGTO_STRICT === '1';

/**
 * Build the page into a scratch folder exactly as `npm run build` does. `buyUrl` is the value VITE_BUY_URL has
 * in the build's environment; undefined takes the variable out altogether.
 */
function build(name: string, buyUrl?: string): Buffer {
  const outDir = resolve(SCRATCH, name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  delete env.VITE_BUY_URL;
  if (buyUrl !== undefined) env.VITE_BUY_URL = buyUrl;
  execFileSync(process.execPath, [VITE, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: ROOT,
    env,
    stdio: 'pipe',
  });
  return readFileSync(resolve(outDir, 'index.html'));
}

describe.skipIf(!STRICT)('release/sg-tax-optimiser.html is the current build of src/web', () => {
  it('is byte-identical to a fresh build', () => {
    expect(existsSync(RELEASE), 'release/sg-tax-optimiser.html is missing: run "npm run build:release"').toBe(true);
    const shipped = readFileSync(RELEASE);
    const fresh = build('dist');
    // Compared as a boolean first, so a mismatch is reported in one line and not as a 190 kB diff.
    const same = shipped.equals(fresh);
    expect(
      same,
      `release/sg-tax-optimiser.html (${shipped.length} bytes) is not the current build of src/web ` +
        `(${fresh.length} bytes). Run "npm run build:release" and commit the result.`,
    ).toBe(true);
  });

  it('carries the version number in package.json', () => {
    const html = readFileSync(RELEASE, 'utf8');
    const { version } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(html.includes(`"${version}"`), `the version ${version} is not in the release file`).toBe(true);
  });

  it('is not the same file as a build that was given a shop address', () => {
    // Shows that the comparison above would catch a release built with VITE_BUY_URL set: such a build differs.
    const shipped = readFileSync(RELEASE);
    const withShop = build('dist-shop', 'https://example.com/workbook');
    expect(withShop.includes('https://example.com/workbook')).toBe(true);
    expect(shipped.includes('https://example.com/workbook')).toBe(false);
    expect(shipped.equals(withShop)).toBe(false);
  });

  it('a shop address that is empty, blank or not a web address builds the same file as none at all', () => {
    // Otherwise a release built in a shell that exports VITE_BUY_URL="" would fail the first check for no
    // visible reason, and one built with a mistyped address would carry the mistake into the file.
    const none = build('dist');
    for (const [name, value] of [
      ['dist-empty', ''],
      ['dist-blank', '   '],
      ['dist-not-web', 'javascript:alert(1)'],
    ] as const) {
      const built = build(name, value);
      expect(built.equals(none), `a build with VITE_BUY_URL=${JSON.stringify(value)} differs from one without`).toBe(true);
      expect(built.includes('javascript:alert')).toBe(false);
    }
  });
});
