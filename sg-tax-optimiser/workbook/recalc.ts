/**
 * Recalculation with headless LibreOffice.
 *
 * ExcelJS writes formulas without cached results. Converting a file xlsx -> xlsx with LibreOffice makes it
 * calculate every formula and store the results, which ExcelJS can then read back as `cell.result`. Used by the
 * build (to ship a workbook whose numbers show in previews before any recalculation) and by the parity test.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
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

/**
 * Recalculate many .xlsx files with several LibreOffice processes side by side (each with its own profile
 * directory, `<profileDir>-1`, `-2`, …). Returns the recalculated copies in the same order as `files`.
 */
export async function recalculateParallel(files: string[], options: RecalcOptions & { workers?: number }): Promise<string[]> {
  const soffice = findSoffice();
  if (!soffice) throw new Error('soffice (LibreOffice) is not on PATH.');
  if (files.length === 0) return [];
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const inputs = files.map((file) => resolve(file));
  const names = new Set(inputs.map((file) => basename(file)));
  if (names.size !== inputs.length) throw new Error('Files to recalculate must have different names.');
  const workers = Math.max(1, Math.min(options.workers ?? Math.min(4, availableParallelism()), inputs.length));

  const runs = Array.from({ length: workers }, (_unused, worker) => {
    const share = inputs.filter((_file, index) => index % workers === worker);
    const profileDir = resolve(`${options.profileDir}-${worker + 1}`);
    mkdirSync(profileDir, { recursive: true });
    return new Promise<void>((done, fail) => {
      const child = spawn(
        soffice,
        [`-env:UserInstallation=${pathToFileURL(profileDir).href}`, '--headless', '--calc', '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', outDir, ...share],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 300_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        fail(new Error(`LibreOffice could not be run: ${error.message}`));
      });
      child.on('close', (status) => {
        clearTimeout(timer);
        if (status === 0) done();
        else fail(new Error(`LibreOffice exited with status ${String(status)}: ${output}`));
      });
    });
  });
  await Promise.all(runs);

  const outputs = inputs.map((file) => join(outDir, basename(file)));
  const missing = outputs.filter((file) => !existsSync(file));
  if (missing.length > 0) throw new Error(`LibreOffice did not write ${missing.length} of ${outputs.length} files, e.g. ${missing[0] ?? ''}.`);
  return outputs;
}
