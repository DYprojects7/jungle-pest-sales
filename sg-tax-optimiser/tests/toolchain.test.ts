/**
 * Which verification layers can run on this machine.
 *
 * The differential test needs python3, the workbook parity test needs LibreOffice ("soffice" on PATH), and the
 * tests that insert and remove rows inside the workbook need the "uno" Python module (package python3-uno). Each
 * skips itself with a console message when its tool is missing, so a plain `npm test` stays usable on a laptop.
 * That also means a green run does not by itself prove those layers ran. Before a release, run
 * `npm run test:release` (SGTO_STRICT=1): a missing tool is then a failure instead of a skip.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { findSoffice } from '../workbook/build';

const STRICT = process.env.SGTO_STRICT === '1';

function runs(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

describe('verification toolchain', () => {
  const python = runs('python3', ['--version']);
  const soffice = findSoffice();
  const uno = python && runs('python3', ['-c', 'import uno']);

  it('reports which layers will run', () => {
    const layers = [
      `engine-vs-reference differential (python3): ${python ? 'runs' : 'SKIPPED'}`,
      `workbook parity (LibreOffice): ${soffice ? 'runs' : 'SKIPPED'}`,
      `workbook row edits (python3-uno): ${soffice && uno ? 'runs' : 'SKIPPED'}`,
    ];
    if (!python || !soffice || !uno) {
      console.warn(`[toolchain] ${layers.join('; ')}. Use "npm run test:release" to require all of them.`);
    }
    expect(layers).toHaveLength(3);
  });

  it.runIf(STRICT)('strict mode: python3 is available, so the differential test cannot be skipped', () => {
    expect(python, 'python3 must be on PATH for a release run').toBe(true);
  });

  it.runIf(STRICT)('strict mode: LibreOffice is available, so the workbook parity test cannot be skipped', () => {
    expect(soffice, '"soffice" (LibreOffice) must be on PATH for a release run').toBeTruthy();
  });

  it.runIf(STRICT)('strict mode: the uno Python module is available, so the row-edit tests cannot be skipped', () => {
    expect(uno, 'python3 must be able to "import uno" (package python3-uno) for a release run').toBe(true);
  });
});
