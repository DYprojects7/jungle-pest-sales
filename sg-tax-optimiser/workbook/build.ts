/**
 * Workbook generator (SPEC §9): the tax optimiser as an Excel / Google Sheets / LibreOffice workbook made of
 * live formulas, built from the same `YearRules` data as the engine.
 *
 *   npm run build:workbook                 -> release/SG-Tax-Optimiser-YA2027.xlsx (income year 2026)
 *   npm run build:workbook -- --year 2025  -> release/SG-Tax-Optimiser-YA2026.xlsx
 *
 * `buildWorkbook(incomeYear)` returns the ExcelJS workbook; `buildWorkbookWithMap` also returns a map of the
 * named input and output cells (the same names are defined in the workbook as `in_*` / `out_*`).
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import { SUPPORTED_INCOME_YEARS, getRules } from '../src/engine/rules/index';
import type { YearRules } from '../src/engine/types';
import { Book, SHEETS, softProtect } from './kit';
import type { CellLocation } from './kit';
import { findSoffice, recalculate } from './recalc';
import { buildLadder } from './sheets/ladder';
import { buildMonthly } from './sheets/monthly';
import { buildPlanner } from './sheets/planner';
import { buildRules } from './sheets/rules';
import { buildScenarios } from './sheets/scenarios';
import { buildSimulator } from './sheets/simulator';
import { buildStart } from './sheets/start';
import { buildWorking } from './sheets/working';

export { SHEETS } from './kit';
export type { CellLocation } from './kit';
export { EXAMPLE, WARNING_LINES } from './sheets/planner';
export { MONTH_LABELS, NO, PRIORITY_PRESETS, PR_YEAR_LABELS, RESIDENCY_LABELS, YES } from './sheets/rules';
export { SCENARIO_IDS } from './sheets/scenarios';
export { SIMULATOR_STEPS } from './sheets/simulator';
export { WARNING_CODES } from './sheets/working';
export { findSoffice, recalculate } from './recalc';

export const WORKBOOK_VERSION = '1.0';

/** Income year the release workbook is built for when no `--year` is given (SPEC: 2026, YA2027). */
export const DEFAULT_INCOME_YEAR = 2026;

/** Every named input cell. The names are defined in the workbook; `in_asAtDate` and `in_simulatorStep` live on their own sheets. */
export const INPUT_NAMES = [
  'in_residency',
  'in_prYear',
  'in_age',
  'in_birthMonth',
  'in_monthlyWage',
  'in_monthsWorked',
  'in_additionalWages',
  'in_otherIncome',
  'in_employmentExpenses',
  'in_donations',
  'in_cpfOverride',
  'in_existingSrs',
  'in_existingCpfSelf',
  'in_existingCpfFamily',
  'in_otherReliefs',
  'in_useSrs',
  'in_useCpfSelf',
  'in_cpfSelfRoom',
  'in_useCpfFamily',
  'in_cpfFamilyMax',
  'in_minSavingRate',
  'in_cashBudget',
  'in_priority',
  'in_asAtDate',
  'in_simulatorStep',
] as const;
export type InputName = (typeof INPUT_NAMES)[number];

/** Machine-readable map of the workbook's named cells. */
export interface WorkbookMap {
  incomeYear: number;
  ya: number;
  /** Sheet names in tab order. */
  sheets: string[];
  /** `in_*` names -> the single input cell. */
  inputs: Record<InputName, CellLocation>;
  /** `out_*` names -> a single cell or a one-column range of results. */
  outputs: Record<string, CellLocation>;
}

export interface BuiltWorkbook {
  workbook: ExcelJS.Workbook;
  map: WorkbookMap;
}

export interface BuildOptions {
  /**
   * Rule values to build from instead of `getRules(incomeYear)`. For tests of what happens when a buyer edits
   * the Rules sheet (for example a year with a Personal Income Tax Rebate).
   */
  rules?: YearRules;
}

/** Extra working cells that tests and tools read; each gets an `out_*` defined name. */
const WORKING_OUTPUTS: Record<string, string> = {
  out_bindingConstraint: 'w_binding',
  out_employeeCpf: 'w_employeeCpf',
  out_cpfSource: 'w_cpfSource',
  out_owSubject: 'w_owSubject',
  out_awCeiling: 'w_awCeiling',
  out_awSubject: 'w_awSubject',
  out_monthlyEmployeeRates: 'w_monthRates',
  out_employmentIncome: 'w_base_employment',
  out_totalIncome: 'w_base_totalIncome',
  out_donationDeduction: 'w_base_donationDeduction',
  out_assessableIncome: 'w_base_assessable',
  out_usefulRoom: 'w_U',
  out_leverRoom: 'w_L',
  out_warningCodes: 'w_warnCodes',
  out_warningFlags: 'w_warnFlags',
};
const RELIEF_LINES = ['eir', 'cpf', 'srs', 'cpfSelf', 'cpfFamily', 'other', 'totalBeforeCap', 'totalAllowed', 'lostToCap'] as const;
const TAX_LINES = ['ci', 'gross', 'rebate', 'tax', 'marginal', 'effective'] as const;
const LEVER_IDS = ['srs', 'cpfSelf', 'cpfFamily'] as const;
const LEVER_LINES = ['eligible', 'enabled', 'cap', 'used', 'roomIfOn', 'room'] as const;

/** Build the workbook for an income year, with the map of its named cells. */
export async function buildWorkbookWithMap(incomeYear: number, options: BuildOptions = {}): Promise<BuiltWorkbook> {
  const rules = options.rules ?? getRules(incomeYear);
  const b = new Book(rules);
  const wb = b.wb;
  wb.creator = 'Singapore Tax Optimiser';
  wb.lastModifiedBy = 'Singapore Tax Optimiser';
  wb.title = `Singapore Tax Optimiser — SRS + CPF Contribution Planner (YA${rules.ya})`;
  wb.subject = 'Estimate for planning; not tax advice.';
  wb.created = new Date(Date.UTC(rules.incomeYear, 0, 1));
  wb.modified = new Date(Date.UTC(rules.incomeYear, 0, 1));
  wb.calcProperties.fullCalcOnLoad = true;

  // Rules first: the Planner's dropdowns point at its lists. Tab order is fixed by the Book.
  buildRules(b);
  buildStart(b, WORKBOOK_VERSION);
  buildPlanner(b);
  buildWorking(b);
  buildLadder(b);
  buildScenarios(b);
  buildSimulator(b);
  buildMonthly(b);

  for (const [name, key] of Object.entries(WORKING_OUTPUTS)) b.define(name, key);
  for (const side of ['base', 'opt'] as const) {
    for (const line of [...RELIEF_LINES, ...TAX_LINES]) b.define(`out_${side}_${line}`, `w_${side}_${line}`);
  }
  for (const lever of LEVER_IDS) {
    for (const line of LEVER_LINES) b.define(`out_${line}_${lever}`, `w_${line}_${lever}`);
  }
  b.finish();

  // Protection without a password: only the cream input cells can be typed in until the user unprotects.
  // The Rules sheet stays open so it can be updated (and rows inserted) for a new year.
  for (const name of Object.values(SHEETS)) {
    if (name === SHEETS.rules) continue;
    const ws = wb.getWorksheet(name);
    if (ws) await softProtect(ws);
  }

  // Open on the Planner (second tab).
  wb.views = [{ x: 0, y: 0, width: 28000, height: 16000, firstSheet: 0, activeTab: 1, visibility: 'visible' }];

  const inputs = {} as Record<InputName, CellLocation>;
  for (const name of INPUT_NAMES) {
    const location = b.names.get(name);
    if (!location) throw new Error(`Input name not defined in the workbook: ${name}`);
    inputs[name] = location;
  }
  const outputs: Record<string, CellLocation> = {};
  for (const [name, location] of b.names) {
    if (name.startsWith('out_')) outputs[name] = location;
  }
  return {
    workbook: wb,
    map: { incomeYear: rules.incomeYear, ya: rules.ya, sheets: Object.values(SHEETS), inputs, outputs },
  };
}

/** Build the workbook for an income year (2025, 2026 or 2027). */
export async function buildWorkbook(incomeYear: number = DEFAULT_INCOME_YEAR): Promise<ExcelJS.Workbook> {
  return (await buildWorkbookWithMap(incomeYear)).workbook;
}

/** The named input and output cells of the workbook for an income year. */
export async function workbookMap(incomeYear: number = DEFAULT_INCOME_YEAR): Promise<WorkbookMap> {
  return (await buildWorkbookWithMap(incomeYear)).map;
}

/** `SG-Tax-Optimiser-YA2027.xlsx` for income year 2026. */
export function releaseFileName(incomeYear: number): string {
  return `SG-Tax-Optimiser-YA${getRules(incomeYear).ya}.xlsx`;
}

/**
 * Copy calculated results from a recalculated copy into the formulas of `target`, so the file shows its numbers
 * in previews and viewers that do not calculate. Spreadsheet applications recalculate on opening regardless.
 */
export function embedResults(target: ExcelJS.Workbook, recalculated: ExcelJS.Workbook): number {
  let embedded = 0;
  for (const ws of target.worksheets) {
    const source = recalculated.getWorksheet(ws.name);
    if (!source) continue;
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value;
        if (value === null || typeof value !== 'object' || !('formula' in value)) return;
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const calculated = source.getCell(cell.address);
        if (!calculated.formula) return;
        // LibreOffice stores an empty-text result as no value at all.
        const result = calculated.result ?? '';
        if (typeof result === 'object' && 'error' in result) return;
        cell.value = { formula: value.formula, result } as ExcelJS.CellFormulaValue;
        embedded++;
      });
    });
  }
  return embedded;
}

/** Build and write the release workbook. Returns the path written. */
export async function writeRelease(incomeYear: number, outDir: string): Promise<string> {
  const { workbook } = await buildWorkbookWithMap(incomeYear);
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, releaseFileName(incomeYear));

  if (findSoffice()) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const work = join(root, '.tmp', `workbook-build-${process.pid}`);
    try {
      mkdirSync(work, { recursive: true });
      const raw = join(work, 'in', releaseFileName(incomeYear));
      mkdirSync(dirname(raw), { recursive: true });
      await workbook.xlsx.writeFile(raw);
      const [calculated] = recalculate([raw], { outDir: join(work, 'out'), profileDir: join(work, 'lo-profile') });
      if (calculated && existsSync(calculated)) {
        const recalculated = new ExcelJS.Workbook();
        await recalculated.xlsx.readFile(calculated);
        const count = embedResults(workbook, recalculated);
        console.log(`  calculated results embedded for ${count} formulas (LibreOffice)`);
      }
    } catch (error) {
      console.warn(`  could not pre-calculate with LibreOffice (${(error as Error).message}); the workbook will calculate when opened.`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } else {
    console.log('  soffice not found: results are not pre-calculated; the workbook calculates when opened.');
  }

  await workbook.xlsx.writeFile(target);
  return target;
}

function parseYear(argv: string[]): number {
  const index = argv.indexOf('--year');
  const inline = argv.find((arg) => arg.startsWith('--year='));
  const text = inline ? inline.slice('--year='.length) : index >= 0 ? argv[index + 1] : undefined;
  if (text === undefined) return DEFAULT_INCOME_YEAR;
  const year = Number(text);
  if (!SUPPORTED_INCOME_YEARS.includes(year)) {
    throw new RangeError(`--year must be one of ${SUPPORTED_INCOME_YEARS.join(', ')} (got "${text}").`);
  }
  return year;
}

async function main(): Promise<void> {
  const year = parseYear(process.argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(`Building the workbook for income year ${year} (YA${getRules(year).ya})…`);
  const written = await writeRelease(year, join(root, 'release'));
  console.log(`release/${releaseFileName(year)} written (${written})`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
