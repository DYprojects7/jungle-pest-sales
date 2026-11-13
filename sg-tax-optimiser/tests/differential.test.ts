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
 * {code, severity} IN THE ORDER EMITTED (the reference is run with `--warning-order=table`, so the codes, their
 * severities and their order — SPEC §6.11: "in the order of the table" — are all compared; message text and
 * params are not), `cpf.employerContribution` dropped on both sides, undefined keys dropped.
 *
 * Both sets carry the inputs of the rule audit: `profile.hasUnusedParenthoodTaxRebate` (true, false, missing and,
 * in the messy set, values that are not booleans), people aged 54, 55 and older with and without a room for their
 * own CPF (SPEC §6.5), foreigners on both sides of six months worked, and family top-ups existing and planned.
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
import { specPlan, specSanitise } from './support/specModel';

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
    // In the order the engine emits them: SPEC §6.11 fixes it, and the reference prints the table order.
    warnings: warnings.map(({ code, severity }) => ({ code, severity })),
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

/** "CODE/severity" for each warning of a normalised result, in order; null when the result has no warnings list. */
function warningTags(result: Json | undefined): string[] | null {
  if (!isObject(result) || !Array.isArray(result.warnings)) return null;
  return result.warnings.map((warning) => (isObject(warning) ? `${String(warning.code)}/${String(warning.severity)}` : JSON.stringify(warning)));
}

/**
 * The warnings of the two sides, compared as SPEC §6.11 states them: first which codes are present with which
 * severity (`$.warnings{codes}` lists what only one side has), then — when those agree — their order
 * (`$.warnings{order}`). Returns false when either side has no warnings list (the generic comparison reports it).
 */
function compareWarnings(engine: Json | undefined, reference: Json | undefined, out: Difference[]): boolean {
  const mine = warningTags(engine);
  const theirs = warningTags(reference);
  if (mine === null || theirs === null) return false;
  const onlyEngine = mine.filter((tag) => !theirs.includes(tag));
  const onlyReference = theirs.filter((tag) => !mine.includes(tag));
  if (onlyEngine.length > 0 || onlyReference.length > 0 || mine.length !== theirs.length) {
    out.push({ path: '$.warnings{codes}', engine: { onlyHere: onlyEngine, all: mine }, reference: { onlyHere: onlyReference, all: theirs } });
  } else if (mine.some((tag, index) => tag !== theirs[index])) {
    out.push({ path: '$.warnings{order}', engine: mine, reference: theirs });
  }
  return true;
}

function withoutWarnings(result: Json | undefined): Json | undefined {
  if (!isObject(result)) return result;
  const { warnings: _warnings, ...rest } = result;
  return rest;
}

/** Compare one set; returns the mismatching cases in input order. */
function compareSet(inputs: readonly unknown[], reference: readonly Json[], offset: number): Mismatch[] {
  const mismatches: Mismatch[] = [];
  inputs.forEach((input, i) => {
    const differences: Difference[] = [];
    const engine = normaliseEngine(input);
    const expected = normaliseReference(reference[offset + i] ?? null);
    if (compareWarnings(engine, expected, differences)) compare(withoutWarnings(engine), withoutWarnings(expected), '$', differences);
    else compare(engine, expected, '$', differences);
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
      // --warning-order=table: the warnings in the order of the SPEC §6.11 table (the default sorts them by code).
      execFileSync('python3', [REFERENCE, '--warning-order=table', INPUTS_FILE], { maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', stdout, 'inherit'] });
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

  it('both sets carry the inputs of the rule audit: the PTR flag, 54/55 with and without a room, foreigners around six months, family top-ups', () => {
    const count = (items: readonly unknown[], test: (input: PlannerInput) => boolean): number => items.filter((item) => test(item as PlannerInput)).length;
    const hasRoom = (input: PlannerInput): boolean => typeof input.levers.cpfSelf.roomToLimit === 'number';
    const months = (input: PlannerInput): number => input.income.monthsWorked ?? 12;

    // The Parenthood Tax Rebate tick: true, false and left out.
    expect(count(clean, (input) => input.profile.hasUnusedParenthoodTaxRebate === true)).toBeGreaterThan(1_200);
    expect(count(clean, (input) => input.profile.hasUnusedParenthoodTaxRebate === false)).toBeGreaterThan(1_200);
    expect(count(clean, (input) => !('hasUnusedParenthoodTaxRebate' in input.profile))).toBeGreaterThan(2_000);

    // SPEC §6.5: the age-55 boundary and older, each with a room entered, with null and with the field left out.
    for (const [label, inBand, minimum] of [
      ['54', (age: number) => age === 54, 60],
      ['55', (age: number) => age === 55, 60],
      ['over 55', (age: number) => age > 55, 300],
    ] as const) {
      const band = clean.filter((input) => inBand(input.profile.ageAtYearEnd));
      expect(count(band, hasRoom), `${label}, room entered`).toBeGreaterThan(minimum);
      expect(count(band, (input) => input.levers.cpfSelf.roomToLimit === null), `${label}, room null`).toBeGreaterThan(minimum / 2);
      expect(count(band, (input) => !('roomToLimit' in input.levers.cpfSelf)), `${label}, room left out`).toBeGreaterThan(minimum);
      // …with the person's own CPF switched on for a citizen or PR, so that the room decides the plan.
      const decisive = band.filter((input) => input.levers.cpfSelf.enabled && input.profile.residency !== 'foreigner');
      expect(count(decisive, hasRoom), `${label}, own CPF on, room entered`).toBeGreaterThan(minimum / 2);
      expect(count(decisive, (input) => !hasRoom(input)), `${label}, own CPF on, room blank`).toBeGreaterThan(minimum / 2);
    }
    // A room at or above the S$8,000 cap from 55 ("entering any number confirms it"), and a room of S$0.
    const from55 = clean.filter((input) => input.profile.ageAtYearEnd >= 55);
    expect(count(from55, (input) => (input.levers.cpfSelf.roomToLimit ?? -1) >= 8_000)).toBeGreaterThan(40);
    expect(count(from55, (input) => input.levers.cpfSelf.roomToLimit === 0)).toBeGreaterThan(40);

    // SPEC §6.11: foreigners who worked six months or fewer, exactly six, exactly seven, and longer.
    const foreigners = clean.filter((input) => input.profile.residency === 'foreigner');
    expect(count(foreigners, (input) => months(input) < 6)).toBeGreaterThan(150);
    expect(count(foreigners, (input) => months(input) === 6)).toBeGreaterThan(40);
    expect(count(foreigners, (input) => months(input) === 7)).toBeGreaterThan(40);
    expect(count(foreigners, (input) => months(input) > 7)).toBeGreaterThan(600);
    expect(count(foreigners, (input) => input.levers.srs.enabled && input.profile.ageAtYearEnd >= 18)).toBeGreaterThan(700);
    expect(count(foreigners, (input) => !input.levers.srs.enabled)).toBeGreaterThan(200);

    // Family top-ups: already made (scheme on and off) and planned (by the test's own model of SPEC §6.6, not the engine).
    const givers = clean.filter((input) => input.profile.residency !== 'foreigner');
    const planned = (input: PlannerInput): number => specPlan(specSanitise(input)).contributions.cpfFamily;
    expect(count(givers, (input) => input.existing.cpfTopUpFamily > 0 && input.levers.cpfFamily.enabled)).toBeGreaterThan(500);
    expect(count(givers, (input) => input.existing.cpfTopUpFamily > 0 && !input.levers.cpfFamily.enabled)).toBeGreaterThan(500);
    expect(count(givers, (input) => planned(input) > 0)).toBeGreaterThan(400);
    expect(count(givers, (input) => planned(input) > 0 && input.existing.cpfTopUpFamily > 0)).toBeGreaterThan(100);
    // …and people from 55 whose own CPF gets money because a room was entered.
    expect(count(from55, (input) => specPlan(specSanitise(input)).contributions.cpfSelf > 0)).toBeGreaterThan(100);
    expect(count(foreigners, (input) => input.existing.cpfTopUpFamily > 0)).toBeGreaterThan(300);

    // The messy set: the flag and the room as something that is not a boolean / not a number, and odd ages and months.
    const shaped = messy as { profile: Record<string, unknown>; income: Record<string, unknown>; levers: { cpfSelf: Record<string, unknown> } }[];
    const flags = shaped.filter((input) => 'hasUnusedParenthoodTaxRebate' in input.profile).map((input) => input.profile.hasUnusedParenthoodTaxRebate);
    expect(flags.filter((flag) => flag === true).length).toBeGreaterThan(150);
    expect(flags.filter((flag) => flag === false).length).toBeGreaterThan(150);
    expect(flags.filter((flag) => typeof flag !== 'boolean').length).toBeGreaterThan(15);
    expect(shaped.filter((input) => !('hasUnusedParenthoodTaxRebate' in input.profile)).length).toBeGreaterThan(300);
    const rooms = shaped.filter((input) => 'roomToLimit' in input.levers.cpfSelf).map((input) => input.levers.cpfSelf.roomToLimit);
    expect(rooms.filter((room) => room !== null && typeof room !== 'number').length).toBeGreaterThan(10);
    expect(rooms.filter((room) => typeof room === 'number' && (room < 0 || !Number.isInteger(room))).length).toBeGreaterThan(5);
    expect(shaped.filter((input) => typeof input.profile.ageAtYearEnd === 'number' && !Number.isInteger(input.profile.ageAtYearEnd)).length).toBeGreaterThan(10);
    expect(shaped.filter((input) => typeof input.income.monthsWorked === 'number' && !Number.isInteger(input.income.monthsWorked)).length).toBeGreaterThan(10);
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
