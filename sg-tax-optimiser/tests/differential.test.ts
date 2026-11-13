/**
 * Differential test (SPEC §10): the TypeScript engine against the independent Python reference
 * (`reference/sgtax_reference.py`), field by field, on thousands of seeded inputs.
 *
 * Two input sets go through ONE run of the reference:
 *   - CLEAN: 6,500 valid inputs (real ISO dates, money up to S$5,000,000) over the whole input space;
 *   - MESSY: 1,500 inputs that need SPEC §6.0 sanitising (negative, fractional, oversized, mistyped or missing
 *     fields, unreadable dates) — every one a case for which §6.0 prescribes a single result.
 *
 * The comparison is strict: integers exactly, other numbers within 1e-9, every key on both sides. The only
 * normalisation is the one the reference's README prescribes: `rules` and `input` dropped, warnings reduced to
 * sorted {code, severity}, `cpf.employerContribution` dropped on both sides, undefined keys dropped.
 *
 * Environment overrides:  DIFF_COUNT=50000 DIFF_SEED=7 npx vitest run tests/differential.test.ts
 */
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { plan } from '../src/engine';
import type { PlannerInput } from '../src/engine';
import { seededInputs, seededMessyInputs } from './support/generators';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK_DIR = join(ROOT, '.tmp', 'differential');
const INPUTS_FILE = join(WORK_DIR, 'inputs.json');
const OUTPUT_FILE = join(WORK_DIR, 'reference-output.json');
const REFERENCE = join(ROOT, 'reference', 'sgtax_reference.py');

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(parsed) ? parsed : fallback;
}

const SEED = envInt('DIFF_SEED', 20_261_113);
const CLEAN_COUNT = Math.max(6_000, envInt('DIFF_COUNT', 6_500));
const MESSY_COUNT = Math.max(1, envInt('DIFF_MESSY_COUNT', 1_500));
const TOLERANCE = 1e-9;
/** How many mismatching cases the failure message spells out. */
const SHOW_CASES = 10;
/** How many differing fields are listed per case. */
const SHOW_PATHS_PER_CASE = 6;

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_PYTHON = pythonAvailable();
if (!HAVE_PYTHON) {
  console.warn('[differential] python3 is not available: the differential test against reference/sgtax_reference.py is SKIPPED.');
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The engine's result in the shape the reference prints (see reference/README.md). */
function normaliseEngine(input: unknown): Json {
  let result;
  try {
    result = plan(input as PlannerInput);
  } catch (error) {
    return { error: `engine threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}` };
  }
  const { rules: _rules, input: _input, warnings, cpf, ...rest } = result;
  const { employerContribution: _employer, ...cpfRest } = cpf;
  const normalised = {
    ...rest,
    cpf: cpfRest,
    warnings: warnings
      .map(({ code, severity }) => ({ code, severity }))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
  };
  // A JSON round trip drops undefined keys (e.g. zeroReason on a tier that saves tax) exactly as printing would.
  return JSON.parse(JSON.stringify(normalised)) as Json;
}

function normaliseReference(result: Json): Json {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
  const cpf = result.cpf;
  if (typeof cpf === 'object' && cpf !== null && !Array.isArray(cpf)) {
    const { employerContribution: _employer, ...cpfRest } = cpf;
    return { ...result, cpf: cpfRest };
  }
  return result;
}

interface Difference {
  path: string;
  engine: Json | undefined;
  reference: Json | undefined;
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep comparison: integers exactly, other numbers within 1e-9, everything else strictly. */
function compare(engine: Json | undefined, reference: Json | undefined, path: string, out: Difference[]): void {
  if (typeof engine === 'number' && typeof reference === 'number') {
    const equal =
      Number.isInteger(engine) && Number.isInteger(reference) ? engine === reference : Math.abs(engine - reference) <= TOLERANCE;
    if (!equal) out.push({ path, engine, reference });
    return;
  }
  if (Array.isArray(engine) && Array.isArray(reference)) {
    if (engine.length !== reference.length) out.push({ path: `${path}.length`, engine: engine.length, reference: reference.length });
    const shared = Math.min(engine.length, reference.length);
    for (let i = 0; i < shared; i++) compare(engine[i], reference[i], `${path}[${i}]`, out);
    return;
  }
  if (isObject(engine) && isObject(reference)) {
    const keys = [...new Set([...Object.keys(engine), ...Object.keys(reference)])].sort();
    for (const key of keys) compare(engine[key], reference[key], `${path}.${key}`, out);
    return;
  }
  if (engine !== reference) out.push({ path, engine, reference });
}

function show(value: Json | undefined): string {
  if (value === undefined) return '(absent)';
  const text = JSON.stringify(value);
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

interface Mismatch {
  index: number;
  input: unknown;
  differences: Difference[];
}

/** Compare one set; returns the mismatching cases in input order. */
function compareSet(inputs: readonly unknown[], reference: readonly Json[], offset: number): Mismatch[] {
  const mismatches: Mismatch[] = [];
  inputs.forEach((input, i) => {
    const differences: Difference[] = [];
    compare(normaliseEngine(input), normaliseReference(reference[offset + i] ?? null), '$', differences);
    if (differences.length > 0) mismatches.push({ index: offset + i, input, differences });
  });
  return mismatches;
}

/** The assertion message: a count by JSON path, then the first cases with input, path and both values. */
function report(label: string, total: number, mismatches: readonly Mismatch[]): string {
  const byPath = new Map<string, number>();
  for (const mismatch of mismatches) {
    const patterns = new Set(mismatch.differences.map((difference) => difference.path.replace(/\[\d+\]/g, '[*]')));
    for (const pattern of patterns) byPath.set(pattern, (byPath.get(pattern) ?? 0) + 1);
  }
  const lines = [
    `${label}: ${mismatches.length} of ${total} inputs differ between the engine and reference/sgtax_reference.py (seed ${SEED}).`,
    '',
    'Mismatching cases by JSON path:',
    ...[...byPath.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([path, count]) => `  ${String(count).padStart(6)}  ${path}`),
    '',
    `First ${Math.min(SHOW_CASES, mismatches.length)} mismatching cases:`,
  ];
  for (const mismatch of mismatches.slice(0, SHOW_CASES)) {
    lines.push(`  #${mismatch.index} input: ${JSON.stringify(mismatch.input)}`);
    for (const difference of mismatch.differences.slice(0, SHOW_PATHS_PER_CASE)) {
      lines.push(`      ${difference.path}: engine ${show(difference.engine)} | reference ${show(difference.reference)}`);
    }
    if (mismatch.differences.length > SHOW_PATHS_PER_CASE) {
      lines.push(`      … and ${mismatch.differences.length - SHOW_PATHS_PER_CASE} more differing fields`);
    }
  }
  return lines.join('\n');
}

describe.skipIf(!HAVE_PYTHON)('differential: TypeScript engine vs independent Python reference', () => {
  const clean = seededInputs(CLEAN_COUNT, SEED, { maxMoney: 5_000_000 });
  const messy = seededMessyInputs(MESSY_COUNT, SEED + 1);
  let reference: Json[] = [];

  beforeAll(() => {
    mkdirSync(WORK_DIR, { recursive: true });
    writeFileSync(INPUTS_FILE, JSON.stringify([...clean, ...messy]));
    // ONE run of the reference for every input. Its stdout (about 90 MB of JSON) goes straight to a file:
    // reading that much through a synchronous pipe takes Node three times as long as the reference itself.
    const stdout = openSync(OUTPUT_FILE, 'w');
    try {
      execFileSync('python3', [REFERENCE, INPUTS_FILE], { maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', stdout, 'inherit'] });
    } finally {
      closeSync(stdout);
    }
    reference = JSON.parse(readFileSync(OUTPUT_FILE, 'utf8')) as Json[];
  }, 240_000);

  it('the reference returns one result per input', () => {
    expect(reference).toHaveLength(clean.length + messy.length);
  });

  it('the clean set spans the input space', () => {
    const tally = (key: (input: PlannerInput) => string): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const input of clean) counts[key(input)] = (counts[key(input)] ?? 0) + 1;
      return counts;
    };
    expect(clean.length).toBeGreaterThanOrEqual(6_000);
    for (const count of Object.values(tally((input) => String(input.incomeYear)))) expect(count).toBeGreaterThan(1_200);
    for (const count of Object.values(tally((input) => input.profile.residency))) expect(count).toBeGreaterThan(1_000);
    expect(Object.keys(tally((input) => input.preferences.priority.join('>')))).toHaveLength(6);
    expect(Object.keys(tally((input) => String(input.preferences.simulatorStep))).sort()).toEqual(['100', '1000', '500', '5000', 'undefined']);
    expect(Object.keys(tally((input) => [input.levers.srs.enabled, input.levers.cpfSelf.enabled, input.levers.cpfFamily.enabled].join()))).toHaveLength(8);
    for (const input of clean) {
      expect(input.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${input.today}T00:00:00Z`))).toBe(false);
      const money = [
        input.income.monthlyOrdinaryWage,
        input.income.additionalWages,
        input.income.otherTaxableIncome ?? 0,
        input.income.employmentExpenses ?? 0,
        input.income.donations ?? 0,
        input.existing.srs,
        input.existing.cpfTopUpSelf,
        input.existing.cpfTopUpFamily,
        input.otherReliefs,
        input.preferences.cashBudget ?? 0,
      ];
      expect(Math.max(...money)).toBeLessThanOrEqual(5_000_000);
    }
  });

  it(`engine and reference agree on every field for ${CLEAN_COUNT} valid inputs`, () => {
    const mismatches = compareSet(clean, reference, 0);
    writeFileSync(join(WORK_DIR, 'mismatches-clean.json'), JSON.stringify(mismatches.slice(0, 500), null, 1));
    if (mismatches.length > 0) expect.fail(report('VALID INPUTS', clean.length, mismatches));
  });

  it(`engine and reference agree on every field for ${MESSY_COUNT} inputs that need SPEC §6.0 sanitising`, () => {
    const mismatches = compareSet(messy, reference, clean.length);
    writeFileSync(join(WORK_DIR, 'mismatches-messy.json'), JSON.stringify(mismatches.slice(0, 500), null, 1));
    if (mismatches.length > 0) expect.fail(report('INPUTS NEEDING SANITISING', messy.length, mismatches));
  });
});
