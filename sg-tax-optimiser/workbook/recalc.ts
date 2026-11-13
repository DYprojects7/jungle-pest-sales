/**
 * Recalculation with headless LibreOffice.
 *
 * ExcelJS writes formulas without cached results. Converting a file xlsx -> xlsx with LibreOffice makes it
 * calculate every formula and store the results, which ExcelJS can then read back as `cell.result`. Used by the
 * build (to ship a workbook whose numbers show in previews before any recalculation) and by the parity test.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Full path of `soffice` if it is on PATH, otherwise null. */
export function findSoffice(): string | null {
  const names = process.platform === 'win32' ? ['soffice.exe', 'soffice.com', 'soffice'] : ['soffice'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface RecalcOptions {
  /** Directory the recalculated copies are written to (same file names). */
  outDir: string;
  /** A private LibreOffice profile directory, so parallel runs do not fight over the user profile lock. */
  profileDir: string;
  /** Kill LibreOffice after this many milliseconds. Default 5 minutes. */
  timeoutMs?: number;
}

/**
 * Recalculate the given .xlsx files in ONE LibreOffice run. Returns the paths of the recalculated copies, in the
 * same order. Throws when LibreOffice is missing, fails, or does not produce every file.
 */
export function recalculate(files: string[], options: RecalcOptions): string[] {
  const soffice = findSoffice();
  if (!soffice) throw new Error('soffice (LibreOffice) is not on PATH.');
  if (files.length === 0) return [];
  mkdirSync(options.outDir, { recursive: true });
  mkdirSync(options.profileDir, { recursive: true });

  const inputs = files.map((file) => resolve(file));
  const run = spawnSync(
    soffice,
    [
      `-env:UserInstallation=${pathToFileURL(resolve(options.profileDir)).href}`,
      '--headless',
      '--calc',
      '--convert-to',
      'xlsx:Calc MS Excel 2007 XML',
      '--outdir',
      resolve(options.outDir),
      ...inputs,
    ],
    { encoding: 'utf8', timeout: options.timeoutMs ?? 300_000 },
  );
  if (run.error) throw new Error(`LibreOffice could not be run: ${run.error.message}`);
  if (run.status !== 0) {
    throw new Error(`LibreOffice exited with status ${String(run.status)}: ${run.stderr || run.stdout}`);
  }
  const outputs = inputs.map((file) => join(resolve(options.outDir), basename(file)));
  const missing = outputs.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`LibreOffice did not write ${missing.length} of ${outputs.length} files, e.g. ${missing[0] ?? ''}.\n${run.stdout}\n${run.stderr}`);
  }
  return outputs;
}
