/**
 * Small toolkit used by the workbook generator: a registry of named cells, deferred formulas (so sheets can
 * refer to cells on sheets that are laid out later), and the shared look (palette, number formats, styles).
 */
import ExcelJS from 'exceljs';
import type { YearRules } from '../src/engine/types';

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/** Sheet names, in tab order (SPEC §9). */
export const SHEETS = {
  start: 'Start',
  planner: 'Planner',
  ladder: 'Ladder',
  scenarios: 'Scenarios',
  simulator: 'Simulator',
  monthly: 'Monthly Plan',
  working: 'Tax Working',
  rules: 'Rules',
} as const;

export type SheetName = (typeof SHEETS)[keyof typeof SHEETS];

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

/** A restrained slate / cream / ochre palette (ARGB). Deliberately unlike any agency or bank branding. */
export const C = {
  ink: 'FF1F2933',
  muted: 'FF5B6B7B',
  faint: 'FF8A97A6',
  white: 'FFFFFFFF',
  slate: 'FF243B53',
  slateSoft: 'FF486581',
  panel: 'FFF1F4F8',
  band: 'FFE3E9F0',
  line: 'FFCBD5E1',
  inputFill: 'FFFFF7DB',
  inputLine: 'FFD9A441',
  inputInk: 'FF173F8A',
  ochre: 'FF9A6700',
  ochreFill: 'FFFCF0CC',
  good: 'FF1E6B45',
  goodFill: 'FFE6F2EA',
  warn: 'FF9A3412',
  warnFill: 'FFFCEBE3',
} as const;

export const FONT = 'Calibri';

/** Number formats. */
export const NF = {
  dollars: '"S$"#,##0',
  tax: '"S$"#,##0.00',
  int: '#,##0',
  cents: '#,##0.00',
  pct: '0.0%',
  /** A rate where 0 means "any saving". */
  minRate: '0.0%;-0.0%;"Any saving"',
  date: 'd mmm yyyy',
  month: 'mmm yyyy',
  yesNo: '"Yes";"Yes";"No"',
  plain: '0',
  factor: '0.0###',
} as const;

export type Style = Partial<ExcelJS.Style>;

const thin = (argb: string): Partial<ExcelJS.Border> => ({ style: 'thin', color: { argb } });

function font(over: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> {
  return { name: FONT, size: 11, color: { argb: C.ink }, ...over };
}

function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

/** Named cell styles. Every style sets its own font so the look does not depend on application defaults. */
export const ST = {
  title: (): Style => ({
    font: font({ size: 18, bold: true, color: { argb: C.white } }),
    fill: fill(C.slate),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1 },
  }),
  titleNote: (): Style => ({
    font: font({ size: 10, color: { argb: C.white } }),
    fill: fill(C.slate),
    alignment: { vertical: 'middle', horizontal: 'right', indent: 1 },
  }),
  subtitle: (): Style => ({
    font: font({ size: 11, color: { argb: C.muted } }),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true },
  }),
  banner: (): Style => ({
    font: font({ size: 11, bold: true, color: { argb: C.ochre } }),
    fill: fill(C.ochreFill),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true },
  }),
  /** Dark column-group heading ("1 · Your details"). */
  block: (): Style => ({
    font: font({ size: 12, bold: true, color: { argb: C.white } }),
    fill: fill(C.slateSoft),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1 },
  }),
  /** Light section heading inside a block. */
  section: (): Style => ({
    font: font({ bold: true, color: { argb: C.slate } }),
    fill: fill(C.band),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1 },
  }),
  label: (): Style => ({
    font: font(),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true },
  }),
  labelIndent: (): Style => ({
    font: font({ color: { argb: C.muted } }),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 3, wrapText: true },
  }),
  labelBold: (): Style => ({
    font: font({ bold: true }),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true },
  }),
  note: (): Style => ({
    font: font({ size: 9, color: { argb: C.muted } }),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true },
  }),
  /** A note that is allowed to run over the empty cells to its right (no wrapping). */
  noteRun: (): Style => ({
    font: font({ size: 9, color: { argb: C.muted } }),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1 },
  }),
  text: (): Style => ({
    font: font(),
    alignment: { vertical: 'top', horizontal: 'left', indent: 1, wrapText: true },
  }),
  textBold: (): Style => ({
    font: font({ bold: true }),
    alignment: { vertical: 'top', horizontal: 'left', indent: 1, wrapText: true },
  }),
  /** A cell the user types into. */
  input: (numFmt?: string, horizontal: 'left' | 'right' | 'center' = 'right'): Style => ({
    font: font({ color: { argb: C.inputInk }, bold: true }),
    fill: fill(C.inputFill),
    border: { top: thin(C.inputLine), bottom: thin(C.inputLine), left: thin(C.inputLine), right: thin(C.inputLine) },
    alignment: { vertical: 'middle', horizontal, indent: horizontal === 'right' ? 0 : 1 },
    protection: { locked: false },
    ...(numFmt ? { numFmt } : {}),
  }),
  /** A calculated value. */
  value: (numFmt?: string, over: Partial<ExcelJS.Font> = {}): Style => ({
    font: font(over),
    alignment: { vertical: 'middle', horizontal: 'right' },
    ...(numFmt ? { numFmt } : {}),
  }),
  valueText: (over: Partial<ExcelJS.Font> = {}): Style => ({
    font: font(over),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1 },
  }),
  /** A headline figure on the Planner. */
  hero: (numFmt: string, argb: string = C.slate): Style => ({
    font: font({ size: 14, bold: true, color: { argb } }),
    fill: fill(C.panel),
    alignment: { vertical: 'middle', horizontal: 'right' },
    numFmt,
  }),
  heroLabel: (): Style => ({
    font: font({ bold: true }),
    fill: fill(C.panel),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true },
  }),
  heroNote: (): Style => ({
    font: font({ size: 9, color: { argb: C.muted } }),
    fill: fill(C.panel),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true },
  }),
  th: (horizontal: 'left' | 'right' | 'center' = 'right'): Style => ({
    font: font({ bold: true, color: { argb: C.white }, size: 10 }),
    fill: fill(C.slateSoft),
    alignment: { vertical: 'middle', horizontal, wrapText: true, indent: horizontal === 'left' ? 1 : 0 },
    border: { bottom: thin(C.slate) },
  }),
  td: (numFmt?: string, horizontal: 'left' | 'right' | 'center' = 'right', over: Partial<ExcelJS.Font> = {}): Style => ({
    font: font(over),
    alignment: { vertical: 'middle', horizontal, indent: horizontal === 'left' ? 1 : 0 },
    border: { bottom: thin(C.band) },
    ...(numFmt ? { numFmt } : {}),
  }),
  total: (numFmt?: string, horizontal: 'left' | 'right' = 'right'): Style => ({
    font: font({ bold: true }),
    fill: fill(C.panel),
    alignment: { vertical: 'middle', horizontal, indent: horizontal === 'left' ? 1 : 0 },
    border: { top: thin(C.slateSoft), bottom: thin(C.slateSoft) },
    ...(numFmt ? { numFmt } : {}),
  }),
  /** A working (helper) cell: correct but not meant to be read first. */
  helper: (numFmt?: string, horizontal: 'left' | 'right' | 'center' = 'right'): Style => ({
    font: font({ size: 9, color: { argb: C.faint } }),
    alignment: { vertical: 'middle', horizontal, indent: horizontal === 'left' ? 1 : 0 },
    ...(numFmt ? { numFmt } : {}),
  }),
  helperHead: (horizontal: 'left' | 'right' | 'center' = 'right'): Style => ({
    font: font({ size: 9, bold: true, color: { argb: C.muted } }),
    fill: fill(C.panel),
    alignment: { vertical: 'middle', horizontal, wrapText: true, indent: horizontal === 'left' ? 1 : 0 },
  }),
  bar: (argb: string = C.slateSoft): Style => ({
    font: font({ size: 9, color: { argb } }),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1 },
    border: { bottom: thin(C.band) },
  }),
  link: (): Style => ({
    font: font({ size: 10, color: { argb: C.inputInk }, underline: true }),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1 },
  }),
};

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** 1 -> "A", 27 -> "AA". */
export function colLetter(col: number): string {
  let n = col;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Relative address, e.g. (3, 12) -> "C12". */
export function a1(col: number, row: number): string {
  return `${colLetter(col)}${row}`;
}

/** Absolute address, e.g. (3, 12) -> "$C$12". */
export function abs(col: number, row: number): string {
  return `$${colLetter(col)}$${row}`;
}

function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

export interface CellLocation {
  sheet: string;
  /** Absolute reference without the sheet, e.g. "$C$12" or "$C$12:$C$24". */
  ref: string;
}

/** Resolves a registered key to a reference usable in a formula on the sheet the resolver was made for. */
export type Resolver = (key: string) => string;

// ---------------------------------------------------------------------------
// Book
// ---------------------------------------------------------------------------

export class Book {
  readonly wb: ExcelJS.Workbook;
  private readonly locations = new Map<string, CellLocation>();
  private readonly pending: Array<() => void> = [];
  /** Workbook-level defined names -> location. */
  readonly names = new Map<string, CellLocation>();

  constructor(readonly rules: YearRules) {
    this.wb = new ExcelJS.Workbook();
    // Create every sheet up front so the tabs are in SPEC order whatever order the sheets are filled in.
    for (const name of Object.values(SHEETS)) this.wb.addWorksheet(name);
  }

  /** The (pre-created) worksheet with this name, with its tab colour set. */
  sheet(name: SheetName, tabColor: string): ExcelJS.Worksheet {
    const ws = this.wb.getWorksheet(name);
    if (!ws) throw new Error(`Missing worksheet: ${name}`);
    ws.properties.tabColor = { argb: tabColor };
    return ws;
  }

  /** Register a single cell under a key. */
  reg(key: string, ws: ExcelJS.Worksheet, col: number, row: number): void {
    this.put(key, { sheet: ws.name, ref: abs(col, row) });
  }

  /** Register a rectangular range under a key. */
  regRange(key: string, ws: ExcelJS.Worksheet, col1: number, row1: number, col2: number, row2: number): void {
    this.put(key, { sheet: ws.name, ref: `${abs(col1, row1)}:${abs(col2, row2)}` });
  }

  private put(key: string, location: CellLocation): void {
    if (this.locations.has(key)) throw new Error(`Workbook key registered twice: ${key}`);
    this.locations.set(key, location);
  }

  has(key: string): boolean {
    return this.locations.has(key);
  }

  location(key: string): CellLocation {
    const found = this.locations.get(key);
    if (!found) throw new Error(`Unknown workbook key: ${key}`);
    return found;
  }

  /** A resolver for formulas that live on `ws`: same-sheet references are left unqualified. */
  resolver(ws: ExcelJS.Worksheet): Resolver {
    return (key: string) => {
      const { sheet, ref } = this.location(key);
      return sheet === ws.name ? ref : `${quoteSheet(sheet)}!${ref}`;
    };
  }

  /**
   * Put a formula in a cell. The formula text is produced after every sheet has been laid out, so it may refer
   * to keys registered later.
   */
  f(ws: ExcelJS.Worksheet, col: number, row: number, build: ($: Resolver) => string, style?: Style): void {
    const cell = ws.getCell(row, col);
    if (style) cell.style = style;
    this.pending.push(() => {
      const formula = build(this.resolver(ws)).replace(/^=/, '');
      cell.value = { formula } as ExcelJS.CellFormulaValue;
    });
  }

  /** Put a constant in a cell. */
  v(ws: ExcelJS.Worksheet, col: number, row: number, value: ExcelJS.CellValue, style?: Style): void {
    const cell = ws.getCell(row, col);
    if (style) cell.style = style;
    cell.value = value;
  }

  /** Give a registered key a workbook-level defined name. */
  define(name: string, key: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) throw new Error(`Invalid defined name: ${name}`);
    if (this.names.has(name)) throw new Error(`Defined name used twice: ${name}`);
    this.names.set(name, this.location(key));
  }

  /** Write the deferred formulas and the defined names. Call once, after every sheet is laid out. */
  finish(): void {
    for (const run of this.pending) run();
    this.pending.length = 0;
    for (const [name, { sheet, ref }] of this.names) {
      this.wb.definedNames.add(`${quoteSheet(sheet)}!${ref}`, name);
    }
  }
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

export function setWidths(ws: ExcelJS.Worksheet, widths: number[]): void {
  widths.forEach((width, index) => {
    ws.getColumn(index + 1).width = width;
  });
}

/** Merge a row span and style every cell in it (so fills and borders cover the whole span). */
export function mergeRow(ws: ExcelJS.Worksheet, row: number, col1: number, col2: number, style?: Style): ExcelJS.Cell {
  if (style) for (let col = col1; col <= col2; col++) ws.getCell(row, col).style = style;
  if (col2 > col1) ws.mergeCells(row, col1, row, col2);
  return ws.getCell(row, col1);
}

/** Style a span of cells in one row without merging. */
export function styleRow(ws: ExcelJS.Worksheet, row: number, col1: number, col2: number, style: Style): void {
  for (let col = col1; col <= col2; col++) ws.getCell(row, col).style = style;
}

export interface PageOptions {
  landscape?: boolean;
  /** Rows repeated at the top of every printed page, e.g. "1:6". */
  titleRows?: string;
  /** Last column to print (letter). */
  lastCol: string;
  /** Last row to print. */
  lastRow: number;
}

/** Print setup: A4, fit to one page wide, modest margins, a footer that keeps the disclaimer with the numbers. */
export function pageSetup(ws: ExcelJS.Worksheet, options: PageOptions): void {
  ws.pageSetup = {
    paperSize: 9,
    orientation: options.landscape ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.25, footer: 0.3 },
    printArea: `A1:${options.lastCol}${options.lastRow}`,
    ...(options.titleRows ? { printTitlesRow: options.titleRows } : {}),
  };
  ws.headerFooter = {
    oddFooter: '&L&8Singapore Tax Optimiser · estimate only, not tax advice&C&8&A&R&8Page &P of &N',
  };
}

/** Sheet view: no gridlines, optional frozen header rows. */
export function view(ws: ExcelJS.Worksheet, frozenRows: number, options: { selected?: boolean; activeCell?: string } = {}): void {
  const base: Record<string, unknown> = {
    showGridLines: false,
    zoomScale: 100,
    ...(options.activeCell ? { activeCell: options.activeCell } : {}),
    ...(options.selected ? { tabSelected: true } : {}),
  };
  ws.views = [
    (frozenRows > 0
      ? { ...base, state: 'frozen', xSplit: 0, ySplit: frozenRows, topLeftCell: `A${frozenRows + 1}` }
      : { ...base, state: 'normal' }) as unknown as ExcelJS.WorksheetView,
  ];
}

/** Protect a sheet WITHOUT a password: guards formulas against slips, and anyone can switch it off. */
export async function softProtect(ws: ExcelJS.Worksheet): Promise<void> {
  await ws.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: true,
    formatColumns: true,
    formatRows: true,
    sort: false,
    autoFilter: false,
  });
}

// ---------------------------------------------------------------------------
// Formula fragments shared by several sheets
// ---------------------------------------------------------------------------

/** Largest money input the workbook accepts (the engine's MAX_MONEY, SPEC §6.0). */
export const MAX_MONEY = 10_000_000_000;

/** SPEC §6.0 for a money input cell: blanks, text and negatives count as 0; cents are dropped. */
export function moneyOf(ref: string): string {
  return `IF(ISNUMBER(${ref}),MIN(${MAX_MONEY},MAX(0,INT(${ref}))),0)`;
}

/**
 * Gross tax on a whole-dollar chargeable income, in cents (a whole number): the bracket sum is done in mills
 * (dollars × rate per mille) and rounded to cents once (SPEC §6.0, §6.4). `$('r_from')` is the column of bracket
 * starts and `$('r_step')` the column of per-mille rate steps (rate − previous rate) on the Rules sheet, so
 * Σ (ci − from) × step over the brackets below ci equals Σ rate × dollars in each bracket.
 */
export function grossTaxCents($: Resolver, ci: string): string {
  return `ROUND(SUMPRODUCT((${ci}>${$('r_from')})*(${ci}-${$('r_from')})*${$('r_step')})/10,0)`;
}

/** Gross tax in dollars for a whole-dollar chargeable income. */
export function grossTax($: Resolver, ci: string): string {
  return `${grossTaxCents($, ci)}/100`;
}

/** The personal income tax rebate in cents for a gross tax in cents: min(cap, rate × gross), half-up. */
export function rebateCents($: Resolver, grossCents: string): string {
  return `MIN(ROUND(${$('r_rebateCap')}*100,0),ROUND(ROUND(${$('r_rebateRate')}*1000,0)*${grossCents}/1000,0))`;
}

/** Tax payable in dollars for a whole-dollar chargeable income: gross tax less the rebate, never below 0. */
export function taxPayable($: Resolver, ci: string): string {
  const gross = grossTaxCents($, ci);
  return `MAX(0,${gross}-${rebateCents($, gross)})/100`;
}

/** Marginal rate: the rate of the bracket holding the last dollar of chargeable income (0 when it is 0). */
export function marginalRate($: Resolver, ci: string): string {
  return `SUMPRODUCT((${ci}>${$('r_from')})*${$('r_step')})/1000`;
}

/** floor(rate × dollars) done on whole numbers (rate in millionths), so it is exact in every spreadsheet. */
export function floorRateTimes(rate: string, dollars: string): string {
  return `INT(ROUND(${rate}*1000000,0)*${dollars}/1000000)`;
}

/** A formula string literal. Excel limits each literal to 255 characters, so long text is split and joined. */
export function lit(text: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 240) chunks.push(text.slice(i, i + 240));
  if (chunks.length === 0) chunks.push('');
  return chunks.map((chunk) => `"${chunk.replace(/"/g, '""')}"`).join('&');
}

/** A whole-dollar amount as text, e.g. "S$15,300". */
export function dollarsText(ref: string): string {
  return `"S$"&TEXT(${ref},"#,##0")`;
}

/** A tax amount as text, e.g. "S$2,679.50". */
export function taxText(ref: string): string {
  return `"S$"&TEXT(${ref},"#,##0.00")`;
}

/** A rate as a plain number of percent / cents per dollar, e.g. 0.115 -> 11.5 (joins to text as "11.5"). */
export function rateNumber(ref: string): string {
  return `ROUND(${ref}*1000,0)/10`;
}

/** A date as text without locale-dependent format codes, e.g. "31 December 2026". */
export function longDate($: Resolver, ref: string): string {
  return `DAY(${ref})&" "&INDEX(${$('l_months')},MONTH(${ref}))&" "&YEAR(${ref})`;
}

/** SPEC §6.6 usefulRoom(r): dollars chargeable income can fall before a relief dollar saves less than `rate`. */
export function usefulRoom($: Resolver, ci: string, rate: string): string {
  const from = $('r_from');
  const rates = $('r_rate');
  return `SUMPRODUCT(MAX((${rates}>0)*(${rates}>=${rate})*(${ci}>${from})*(${ci}-${from})))`;
}
