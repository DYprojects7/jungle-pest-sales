/**
 * The Rules sheet: the single place rule values live. Every value comes from `YearRules`; every other sheet
 * reads them from here, so a buyer can update this sheet for a new year.
 */
import type ExcelJS from 'exceljs';
import { NON_RESIDENT_SRS_COST, lockUpFacts } from '../../src/engine/facts';
import type { LockUpFactId } from '../../src/engine/facts';
import type { CpfAgeBand, LeverId, Residency, YearRules } from '../../src/engine/types';
import { Book, C, NF, SHEETS, ST, a1, abs, heightFor, mergeRow, pageSetup, setWidths, styleRow, view } from '../kit';

/** Labels shown in the Planner dropdowns, in the order the formulas rely on (do not reorder). */
export const RESIDENCY_LABELS: Record<Residency, string> = {
  citizen: 'Singapore Citizen',
  pr: 'Permanent Resident',
  foreigner: 'Foreigner (tax resident)',
};
export const RESIDENCY_ORDER: Residency[] = ['citizen', 'pr', 'foreigner'];
export const PR_YEAR_LABELS = ['1st year', '2nd year', '3rd year onwards'] as const;
export const YES = 'Yes';
export const NO = 'No';
/** How the salary cell on the Planner is read (SPEC §9), in the order the formulas rely on. */
export const SALARY_PERIODS = ['per month', 'per year'] as const;
export const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export interface PriorityPreset {
  label: string;
  /** Lever order, first to last. */
  order: ['srs' | 'cpfSelf' | 'cpfFamily', 'srs' | 'cpfSelf' | 'cpfFamily', 'srs' | 'cpfSelf' | 'cpfFamily'];
  /** The order in words, as the web page writes it. */
  description: string;
}

/** SPEC §8.3 "Which first?": the page's three presets, with its names. */
export const PRIORITY_PRESETS: PriorityPreset[] = [
  { label: 'Flexibility first', order: ['srs', 'cpfSelf', 'cpfFamily'], description: 'SRS, then CPF self, then family.' },
  { label: 'Guaranteed interest first', order: ['cpfSelf', 'srs', 'cpfFamily'], description: 'CPF self, then SRS, then family.' },
  { label: 'Family first', order: ['cpfFamily', 'srs', 'cpfSelf'], description: 'Family, then SRS, then CPF self.' },
];

/** The scheme names the web page uses (SPEC §8.3, §9 "Same story as the page"). */
export const LEVER_NAMES: Record<LeverId, string> = {
  srs: 'SRS',
  cpfSelf: 'CPF cash top-up, self',
  cpfFamily: 'CPF cash top-up, family',
};

/**
 * One sentence of the audited lock-up facts (SPEC §7 `lockUpFacts`) for a citizen below 55: used where the
 * Rules sheet explains a value, so that the sentence is the engine's and not a second copy.
 */
export function factSentence(rules: YearRules, id: LockUpFactId, lever: LeverId): string {
  const row = lockUpFacts(rules, { residency: 'citizen', ageAtYearEnd: 35 }).find((fact) => fact.id === id);
  if (!row) throw new Error(`lockUpFacts has no row "${id}"`);
  return row.values[lever];
}

const COL = { label: 2, c: 3, d: 4, e: 5, f: 6, g: 7, note: 8 };
/** Column widths: margin, label, value, three narrow columns of the tables, a wider one, and the notes column. */
const WIDTHS = [2, 46, 16, 14, 14, 16, 18, 90];
const LABEL_WIDTH = WIDTHS[1] ?? 46;
/** The notes beside a value run from column D to column H. */
const NOTE_WIDTH = WIDTHS.slice(3).reduce((total, width) => total + width, 0);
/** A note longer than this is wrapped inside the printed width instead of running off the page. */
const NOTE_RUN_CHARS = 150;

/**
 * Spare rows for tax brackets beyond those the year starts with: the Tax Working and Ladder sheets lay out this
 * many rows more than the bracket table has, so a buyer can add brackets on this sheet without touching them.
 */
export const SPARE_BRACKET_ROWS = 12;

/** How many tax brackets the workbook can use (rows laid out on the Tax Working and Ladder sheets). */
export function bracketCapacity(bracketCount: number): number {
  return bracketCount + SPARE_BRACKET_ROWS;
}

export function buildRules(b: Book): ExcelJS.Worksheet {
  const rules = b.rules;
  const ws = b.sheet(SHEETS.rules, C.ochre);
  setWidths(ws, WIDTHS);

  let r = 1;
  ws.getRow(r).height = 32;
  mergeRow(ws, r, 2, 8, ST.title()).value = 'Rules';
  b.f(
    ws,
    2,
    r,
    ($) => `"Rules for income year "&${$('r_incomeYear')}&" (Year of Assessment "&${$('r_ya')}&")"`,
  );
  r++;
  ws.getRow(r).height = 46;
  mergeRow(ws, r, 2, 8, ST.subtitle()).value =
    'Every rule value used by this workbook lives on this sheet, and every other sheet reads it from here. ' +
    'To update for a new year, type over the cream cells (grey cells are worked out for you) and check each value ' +
    'against the official source listed at the bottom. The deadline follows the income year by itself, and a check ' +
    'under the tax table tells you if the table is no longer in order.';
  r += 2;

  const section = (title: string): void => {
    mergeRow(ws, r, 2, 8, ST.section()).value = title;
    r++;
  };
  /** A "label | value | note" row; returns the row used. */
  const item = (
    key: string,
    label: string,
    value: ExcelJS.CellValue,
    numFmt: string | undefined,
    note = '',
    align: 'left' | 'right' = 'right',
  ): number => {
    b.v(ws, COL.label, r, label, ST.label());
    b.v(ws, COL.c, r, value, ST.input(numFmt, align));
    b.reg(key, ws, COL.c, r);
    // The row is as tall as its label needs; a long note is wrapped across the notes columns, a short one runs on.
    let height = heightFor(label, LABEL_WIDTH, 11);
    if (note.length > NOTE_RUN_CHARS) {
      mergeRow(ws, r, COL.d, COL.note, ST.note()).value = note;
      height = Math.max(height, heightFor(note, NOTE_WIDTH, 9));
    } else if (note) {
      b.v(ws, COL.d, r, note, ST.noteRun());
    }
    if (height > 20) ws.getRow(r).height = height;
    return r++;
  };

  // ---- Year -------------------------------------------------------------------------------------------------
  section('The year');
  item('r_incomeYear', 'Income year (the calendar year you earn and contribute in)', rules.incomeYear, NF.plain);
  b.v(ws, COL.label, r, 'Year of Assessment (when that income is taxed)', ST.label());
  b.f(ws, COL.c, r, ($) => `${$('r_incomeYear')}+1`, ST.helper(NF.plain));
  b.reg('r_ya', ws, COL.c, r);
  r++;
  const statusRow = item(
    'r_status',
    'Status of these rules',
    rules.status,
    undefined,
    '"final" = confirmed from official sources, with one exception: a personal income tax rebate, if there is one, is announced only at the Budget in February of the Year of Assessment (see the rebate cells below). ' +
      '"projected" = some values are announced or carried forward, not yet final: the Planner then says PROJECTED RULES.',
    'left',
  );
  ws.getCell(statusRow, COL.c).dataValidation = {
    type: 'list',
    allowBlank: false,
    formulae: ['"final,projected"'],
    showErrorMessage: true,
    errorTitle: 'Status',
    error: 'Choose final or projected.',
  };
  const [dy, dm, dd] = rules.contributionDeadline.split('-').map(Number) as [number, number, number];
  const deadlineRow = item(
    'r_deadline',
    'Last day a contribution counts for this year',
    new Date(Date.UTC(dy, dm - 1, dd)),
    NF.date,
    '31 December of the income year, worked out from the year above; type a date over it only if the rule changes.',
  );
  // What "by the last day" means for each scheme, in the engine's own sentences.
  b.v(ws, COL.d, r, `SRS: ${factSentence(rules, 'deadline', 'srs')}`, ST.noteRun());
  r++;
  b.v(ws, COL.d, r, `CPF top-ups: ${factSentence(rules, 'deadline', 'cpfSelf')}`, ST.noteRun());
  r++;
  if (dy === rules.incomeYear && dm === 12 && dd === 31) {
    // The usual rule follows the income year, so changing the year cannot leave last year's deadline behind.
    b.f(ws, COL.c, deadlineRow, ($) => `DATE(${$('r_incomeYear')},12,31)`);
  }
  rules.statusNotes.forEach((text, index) => {
    b.v(ws, COL.label, r, index === 0 ? 'Notes for this year' : '', ST.label());
    b.v(ws, COL.c, r, text, ST.noteRun());
    r++;
  });
  r++;

  // ---- Income tax -------------------------------------------------------------------------------------------
  section('Income tax for residents');
  const brackets = rules.taxBrackets;
  ws.getRow(r).height = 54;
  b.v(ws, COL.label, r, 'Tax bracket', ST.th('left'));
  b.v(ws, COL.c, r, 'Chargeable income from (S$)', ST.th());
  b.v(ws, COL.d, r, 'Rate', ST.th());
  b.v(ws, COL.e, r, 'Up to (S$)', ST.th());
  b.v(ws, COL.f, r, 'Rate step (per mille)', ST.th());
  b.v(ws, COL.g, r, 'Tax at the start of the bracket (S$)', ST.th());
  b.v(
    ws,
    COL.note,
    r,
    'Keep the brackets in ascending order, starting at 0 with the tax-free band. The three grey columns are worked out. ' +
      'To add a bracket: insert a row anywhere above the grey "End of the table" line, type where it starts and its rate, ' +
      'then copy the three grey cells from any other bracket row into the new row. Nothing else needs copying, and the check below says OK when the table is in order.',
    ST.note(),
  );
  const bHead = r;
  r++;
  const b1 = r;
  // The sentinel ("End of the table") row sits inside every range below, so a row inserted anywhere above it,
  // including straight after the last bracket, becomes part of the table in Excel, Google Sheets and LibreOffice.
  const bEnd = b1 + brackets.length;
  const fromRange = `${abs(COL.c, b1)}:${abs(COL.c, bEnd)}`;
  const rateWithHead = `${abs(COL.d, bHead)}:${abs(COL.d, bEnd)}`;
  brackets.forEach((bracket) => {
    const row = r;
    // Every grey cell finds its neighbours from its own position, so the same three formulas are right in any
    // row and stay right when rows are inserted or removed around them.
    b.f(ws, COL.label, row, () => `"Bracket "&(ROW()-ROW(${abs(COL.label, bHead)}))`, ST.td(undefined, 'left'));
    b.v(ws, COL.c, row, bracket.from, ST.input(NF.int));
    b.v(ws, COL.d, row, bracket.rate, ST.input(NF.pct));
    ws.getCell(row, COL.c).dataValidation = {
      type: 'decimal',
      operator: 'greaterThanOrEqual',
      formulae: [0],
      allowBlank: true,
      showErrorMessage: true,
      errorStyle: 'stop',
      errorTitle: 'Start of the bracket',
      error: 'Enter the chargeable income this bracket starts at, in dollars (0 for the first bracket).',
    };
    ws.getCell(row, COL.d).dataValidation = {
      type: 'decimal',
      operator: 'between',
      formulae: [0, 1],
      allowBlank: true,
      showErrorMessage: true,
      errorStyle: 'stop',
      errorTitle: 'Tax rate',
      error: 'Enter the rate as a percentage from 0% to 100%, for example 11.5%.',
    };
    const next = `INDEX(${fromRange},ROW()-ROW(${abs(COL.c, b1)})+2)`;
    b.f(ws, COL.e, row, () => `IF(ISNUMBER(${next}),${next},"and above")`, ST.helper(NF.int));
    b.f(
      ws,
      COL.f,
      row,
      () => `ROUND(D${row}*1000,0)-ROUND(N(INDEX(${rateWithHead},ROW()-ROW(${abs(COL.d, bHead)})))*1000,0)`,
      ST.helper(NF.plain),
    );
    b.f(
      ws,
      COL.g,
      row,
      ($) => `ROUND(SUMPRODUCT((C${row}>${$('r_from')})*(C${row}-${$('r_from')})*${$('r_step')})/10,0)/100`,
      ST.helper(NF.cents),
    );
    r++;
  });
  // The end line: its value cells stay empty (an empty cell counts as 0 and adds nothing to the tax sum).
  styleRow(ws, r, COL.label, COL.g, { ...ST.helper(undefined, 'left'), border: { top: { style: 'thin', color: { argb: C.line } } } });
  ws.getCell(r, COL.label).value = 'End of the table (insert new bracket rows above this line)';
  r++;
  b.regRange('r_from', ws, COL.c, b1, COL.c, bEnd);
  b.regRange('r_rate', ws, COL.d, b1, COL.d, bEnd);
  b.regRange('r_step', ws, COL.f, b1, COL.f, bEnd);
  // From the heading down: a number here that `r_from` does not count is a row typed above the first bracket.
  b.regRange('r_fromWithHead', ws, COL.c, bHead, COL.c, bEnd);

  b.v(ws, COL.label, r, 'Number of brackets', ST.label());
  b.f(ws, COL.c, r, ($) => `COUNT(${$('r_from')})`, ST.helper(NF.plain));
  b.reg('r_bracketCount', ws, COL.c, r);
  b.v(ws, COL.d, r, `Worked out. This workbook can use up to ${bracketCapacity(brackets.length)}.`, ST.noteRun());
  r++;
  b.v(ws, COL.label, r, 'Check on the table above', ST.label());
  ws.getRow(r).height = 26;
  mergeRow(ws, r, COL.c, COL.note, {
    ...ST.helper(undefined, 'left'),
    font: { ...ST.helper().font, bold: true, color: { argb: C.good } },
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true },
  });
  b.f(ws, COL.c, r, ($) => `IF(${$('w_rulesIssue')}="","OK","Check: "&${$('w_rulesIssue')}&". Tax figures may be wrong until this is fixed.")`);
  b.reg('r_bracketCheck', ws, COL.c, r);
  ws.addConditionalFormatting({
    ref: `${a1(COL.c, r)}:${a1(COL.note, r)}`,
    rules: [{ type: 'expression', priority: 1, formulae: [`${abs(COL.c, r)}<>"OK"`], style: { font: { bold: true, color: { argb: C.warn } } } }],
  });
  r += 2;

  item(
    'r_reliefCap',
    'Overall cap on personal reliefs',
    rules.personalReliefCap,
    NF.dollars,
    'Includes CPF relief, Earned Income Relief, SRS and CPF top-up relief. Relief above the cap is lost.',
  );
  item('r_eirBelow55', 'Earned Income Relief — below 55', rules.earnedIncomeRelief.below55, NF.dollars, 'By age on 31 December of the income year; limited to earned income.');
  item('r_eir55to59', 'Earned Income Relief — 55 to 59', rules.earnedIncomeRelief.age55to59, NF.dollars);
  item('r_eir60plus', 'Earned Income Relief — 60 and above', rules.earnedIncomeRelief.age60plus, NF.dollars);
  item(
    'r_donationMultiplier',
    'Deduction for each dollar of qualifying donations',
    rules.donationDeductionMultiplier,
    '0.0#"×"',
    '2.5 means donations are deducted at 250%.',
  );
  const rebateRow = item('r_rebateRate', 'Personal income tax rebate — share of tax', rules.pitRebate ? rules.pitRebate.rate : 0, NF.pct);
  mergeRow(ws, rebateRow, COL.d, COL.note, ST.note());
  ws.getRow(rebateRow).height = heightFor(170, NOTE_WIDTH, 9);
  // What can still happen depends on the date: a rebate is announced, if at all, at the Budget in February of the
  // Year of Assessment itself, which is after the contribution deadline (SPEC §5.1).
  b.f(
    ws,
    COL.d,
    rebateRow,
    ($) =>
      `IF(${$('r_rebateRate')}>0,"A rebate is entered for this Year of Assessment: it takes this share of your tax off the bill, up to the cap below.",` +
      `IF(${$('u_today')}<DATE(${$('r_ya')},3,1),"None announced for this Year of Assessment. One could still be announced at the Budget in February; if so, enter the rate here and the cap below.",` +
      `"None for this Year of Assessment. If one was announced after this workbook was made, enter the rate here and the cap below."))`,
  );
  b.reg('r_rebateNote', ws, COL.d, rebateRow);
  item('r_rebateCap', 'Personal income tax rebate — most it can be', rules.pitRebate ? rules.pitRebate.cap : 0, NF.dollars);
  r++;

  // ---- CPF --------------------------------------------------------------------------------------------------
  section('Compulsory CPF contributions (the employee share is your CPF relief)');
  item('r_owCeiling', 'Ordinary Wage ceiling, per month', rules.cpf.owCeilingMonthly, NF.dollars, 'Monthly pay above this attracts no CPF.');
  item(
    'r_annualCeiling',
    'Annual wage ceiling',
    rules.cpf.annualWageCeiling,
    NF.dollars,
    'Bonus attracts CPF only up to this ceiling less the ordinary wages that attracted CPF in the year.',
  );
  item('r_nil', 'No employee share on monthly wages up to', rules.cpf.employeeNilUpTo, NF.dollars);
  item(
    'r_phaseTo',
    'Full employee rate applies to monthly wages above',
    rules.cpf.phaseInUpTo,
    NF.dollars,
    'Between the two, the employee share is the phase-in factor × (wage − the lower figure).',
  );
  r++;

  const tables: { id: number; title: string; bands: CpfAgeBand[] }[] = [
    { id: 1, title: 'Singapore Citizens, and Permanent Residents from their 3rd year', bands: rules.cpf.fullRates },
    { id: 2, title: 'Permanent Residents in their 1st year (graduated rates)', bands: rules.cpf.prYear1Rates },
    { id: 3, title: 'Permanent Residents in their 2nd year (graduated rates)', bands: rules.cpf.prYear2Rates },
  ];
  const bandCount = rules.cpf.fullRates.length;
  for (const table of tables) {
    if (table.bands.length !== bandCount) {
      throw new Error('The three CPF rate tables must have the same number of age bands.');
    }
    ws.getRow(r).height = 30;
    b.v(ws, COL.label, r, table.title, ST.th('left'));
    b.v(ws, COL.c, r, 'Up to age (blank = no upper limit)', ST.th());
    b.v(ws, COL.d, r, 'Employee rate', ST.th());
    b.v(ws, COL.e, r, 'Employer rate', ST.th());
    b.v(ws, COL.f, r, 'Phase-in factor', ST.th());
    if (table.id === 1) {
      b.v(
        ws,
        COL.note,
        r,
        'A new band applies from the month after the birthday. The phase-in factor is normally 3 × the employee rate. ' +
          'The employer rate is shown for reference; it does not affect tax.',
        ST.note(),
      );
    }
    r++;
    table.bands.forEach((band, index) => {
      const row = r;
      b.f(
        ws,
        COL.label,
        row,
        () =>
          index === 0
            ? `IF(C${row}="","Any age",C${row}&" and below")`
            : `IF(C${row}="","Above "&C${row - 1},"Above "&C${row - 1}&" to "&C${row})`,
        ST.td(undefined, 'left'),
      );
      b.v(ws, COL.c, row, band.maxAge, ST.input(NF.plain));
      b.v(ws, COL.d, row, band.employeeRate, ST.input('0.0#%'));
      b.v(ws, COL.e, row, band.employerRate, ST.input('0.0#%'));
      b.v(ws, COL.f, row, band.phaseInFactor, ST.input(NF.factor));
      b.reg(`r_cpf${table.id}_label_${index + 1}`, ws, COL.label, row);
      b.reg(`r_cpf${table.id}_max_${index + 1}`, ws, COL.c, row);
      b.reg(`r_cpf${table.id}_emp_${index + 1}`, ws, COL.d, row);
      b.reg(`r_cpf${table.id}_phase_${index + 1}`, ws, COL.f, row);
      r++;
    });
    r++;
  }

  // ---- SRS --------------------------------------------------------------------------------------------------
  section('SRS (Supplementary Retirement Scheme)');
  item('r_srsCapCitizenPr', 'Yearly contribution cap — Citizens and Permanent Residents', rules.srs.capCitizenPr, NF.dollars);
  item('r_srsCapForeigner', 'Yearly contribution cap — foreigners', rules.srs.capForeigner, NF.dollars);
  item('r_srsMinAge', 'Minimum age to contribute', rules.srs.minAge, NF.plain);
  item(
    'r_srsRetAge',
    'Retirement age a first SRS contribution locks in: 64 if made on or after 1 July 2026, 63 if 1 July 2022 to 30 June 2026, 62 if earlier',
    rules.srs.statutoryRetirementAge,
    NF.plain,
    'The age for a first contribution at the end of this income year; the Planner counts the years to it. Withdrawals before your own age are fully taxable with a 5% penalty.',
  );
  item(
    'r_nrCost',
    'Least tax a non-resident pays per dollar taken out of SRS — at retirement age, or under the 10-year rule for foreigners',
    NON_RESIDENT_SRS_COST.atRetirementOrTenYears,
    NF.rate,
    '15% on the taxable half. Used for the caution shown to foreigners on the Planner.',
  );
  item('r_nrCostEarly', '… and if taken out earlier', NON_RESIDENT_SRS_COST.early, NF.rate, '15% on the whole amount plus the 5% penalty.');
  r++;

  // ---- CPF top-ups ------------------------------------------------------------------------------------------
  section('CPF cash top-ups');
  item('r_selfCap', 'Relief cap — top-ups to your own Special/Retirement and MediSave accounts', rules.cpfTopUp.selfReliefCap, NF.dollars);
  item('r_famCap', "Relief cap — top-ups to family members' accounts", rules.cpfTopUp.familyReliefCap, NF.dollars);
  const giverFirst = r;
  RESIDENCY_ORDER.forEach((residency, index) => {
    const row = item(
      `r_famGiver_${index + 1}`,
      `Can claim relief for family top-ups — ${RESIDENCY_LABELS[residency]}`,
      rules.cpfTopUp.familyGiverResidency.includes(residency) ? YES : NO,
      undefined,
      index === 0 ? 'The giver must be a Singapore Citizen or Permanent Resident to claim CPF Cash Top-up Relief.' : '',
      'left',
    );
    ws.getCell(row, COL.c).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: [`"${YES},${NO}"`],
      showErrorMessage: true,
      errorTitle: 'Yes or No',
      error: 'Choose Yes or No.',
    };
  });
  b.regRange('r_famGiver', ws, COL.c, giverFirst, COL.c, r - 1);
  item('r_frs', 'Full Retirement Sum', rules.cpfTopUp.fullRetirementSum, NF.dollars, 'Top-ups to your own Special or Retirement Account earn relief only up to this.');
  item('r_ers', 'Enhanced Retirement Sum', rules.cpfTopUp.enhancedRetirementSum, NF.dollars, 'From age 55 the CPF Board accepts top-ups up to this, but relief stops at the Full Retirement Sum.');
  item(
    'r_bhs',
    'Basic Healthcare Sum (members aged 65 or under)',
    rules.cpfTopUp.basicHealthcareSum,
    NF.dollars,
    'The most a MediSave Account can hold. Older members keep the figure fixed in the year they turned 65.',
  );
  item('r_interest', 'Interest floor on Special, MediSave and Retirement Accounts', rules.cpfTopUp.interestRateSmra, NF.pct, factSentence(rules, 'earns', 'cpfSelf'));
  item(
    'r_matchedRetirement',
    'Part of a top-up the Government matches (earns no relief), per member per year — retirement',
    rules.cpfTopUp.matchedTopUps.retirementAnnualCap,
    NF.dollars,
    'Matched Retirement Savings Scheme. Family top-up amounts in this workbook mean the part beyond it.',
  );
  item(
    'r_matchedMediSave',
    '… and MediSave',
    rules.cpfTopUp.matchedTopUps.mediSaveAnnualCap,
    NF.dollars,
    'Matched MediSave Scheme. Leave blank for a year the scheme does not apply.',
  );
  item('r_payoutAge', 'CPF payout eligibility age', rules.cpfTopUp.payoutEligibilityAge, NF.plain, 'A top-up to the Special or Retirement Account comes back as monthly payouts from this age.');
  r++;

  // ---- Lists ------------------------------------------------------------------------------------------------
  section('Choices offered in the dropdowns (the formulas rely on the order; reword with care)');
  styleRow(ws, r, 2, 7, ST.helperHead('left'));
  b.v(ws, 2, r, 'Residency', ST.helperHead('left'));
  b.v(ws, 3, r, 'If a PR', ST.helperHead('left'));
  b.v(ws, 4, r, 'Yes / No', ST.helperHead('left'));
  b.v(ws, 5, r, 'Birth month', ST.helperHead('left'));
  b.v(ws, 6, r, 'Smallest saving worth it', ST.helperHead('left'));
  r++;
  const listTop = r;
  // The salary choices sit under the rate list's notes, in the same column.
  const periodTop = listTop + 3;
  // "Any saving" (0) and then the rate of each bracket after the first, read from the table by position so the
  // choices follow the rates. Plain percentages: what a dropdown shows is then exactly what it puts in the cell.
  const minRateCount = brackets.length;
  const listRows = Math.max(MONTH_LABELS.length, minRateCount);
  for (let i = 0; i < listRows; i++) {
    const residency = RESIDENCY_ORDER[i];
    if (residency) b.v(ws, 2, r, RESIDENCY_LABELS[residency], ST.td(undefined, 'left'));
    const prYear = PR_YEAR_LABELS[i];
    if (prYear) b.v(ws, 3, r, prYear, ST.td(undefined, 'left'));
    if (i < 2) b.v(ws, 4, r, i === 0 ? YES : NO, ST.td(undefined, 'left'));
    const month = MONTH_LABELS[i];
    if (month) b.v(ws, 5, r, month, ST.td(undefined, 'left'));
    if (i === 0) {
      b.v(ws, 6, r, 0, ST.td(NF.pct, 'left'));
      b.v(ws, 7, r, '0.0% = every tax dollar: any saving counts', ST.noteRun());
    } else if (i < minRateCount) {
      if (i === 1) b.v(ws, 7, r, 'The rest follow the tax table. A rate that is not listed can still be typed on the Planner.', ST.noteRun());
      b.f(ws, 6, r, ($) => `IF(${i + 1}<=${$('r_bracketCount')},INDEX(${$('r_rate')},${i + 1}),0)`, ST.td(NF.pct, 'left'));
    }
    if (i === 2) b.v(ws, 7, r, 'Salary is entered', ST.helperHead('left'));
    const period = SALARY_PERIODS[i - 3];
    if (period) b.v(ws, 7, r, period, ST.td(undefined, 'left'));
    r++;
  }
  b.regRange('l_salaryPeriod', ws, 7, periodTop, 7, periodTop + SALARY_PERIODS.length - 1);
  b.regRange('l_residency', ws, 2, listTop, 2, listTop + RESIDENCY_ORDER.length - 1);
  b.regRange('l_prYear', ws, 3, listTop, 3, listTop + PR_YEAR_LABELS.length - 1);
  b.regRange('l_yesNo', ws, 4, listTop, 4, listTop + 1);
  b.regRange('l_months', ws, 5, listTop, 5, listTop + MONTH_LABELS.length - 1);
  b.regRange('l_minRate', ws, 6, listTop, 6, listTop + minRateCount - 1);
  r++;

  ws.getRow(r).height = 30;
  b.v(ws, 2, r, 'Which scheme first?', ST.helperHead('left'));
  b.v(ws, 3, r, 'SRS is filled', ST.helperHead('right'));
  b.v(ws, 4, r, 'CPF self is filled', ST.helperHead('right'));
  b.v(ws, 5, r, 'CPF family is filled', ST.helperHead('right'));
  b.v(ws, 6, r, 'The order in words', ST.helperHead('left'));
  styleRow(ws, r, 7, 7, ST.helperHead('left'));
  r++;
  const presetTop = r;
  for (const preset of PRIORITY_PRESETS) {
    b.v(ws, 2, r, preset.label, ST.td(undefined, 'left'));
    b.v(ws, 3, r, preset.order.indexOf('srs') + 1, ST.td(NF.plain));
    b.v(ws, 4, r, preset.order.indexOf('cpfSelf') + 1, ST.td(NF.plain));
    b.v(ws, 5, r, preset.order.indexOf('cpfFamily') + 1, ST.td(NF.plain));
    b.v(ws, 6, r, preset.description, ST.noteRun());
    r++;
  }
  const presetEnd = r - 1;
  b.regRange('l_priority', ws, 2, presetTop, 2, presetEnd);
  b.regRange('l_rank_srs', ws, 3, presetTop, 3, presetEnd);
  b.regRange('l_rank_cpfSelf', ws, 4, presetTop, 4, presetEnd);
  b.regRange('l_rank_cpfFamily', ws, 5, presetTop, 5, presetEnd);
  b.regRange('l_priorityText', ws, 6, presetTop, 6, presetEnd);
  r++;

  // ---- Common reliefs ---------------------------------------------------------------------------------------
  section('Common personal reliefs — to help you fill in "Other reliefs" on the Planner (amounts only; eligibility is not checked)');
  b.v(ws, 2, r, 'Relief', ST.th('left'));
  b.v(ws, 3, r, 'Amount (S$)', ST.th());
  mergeRow(ws, r, 4, 8, ST.th('left')).value = 'When it applies';
  r++;
  for (const relief of rules.reliefCatalog) {
    const choices = (relief.options ?? []).map((option) => option.amount).filter((value) => value > 0);
    const amount =
      relief.amountPerUnit > 0
        ? relief.amountPerUnit
        : choices.length > 0
          ? `${Math.min(...choices).toLocaleString('en-SG')} to ${Math.max(...choices).toLocaleString('en-SG')}`
          : 'varies';
    const suffix = relief.input === 'count' ? ' each' : '';
    b.v(ws, 2, r, relief.label, ST.td(undefined, 'left'));
    b.v(
      ws,
      3,
      r,
      typeof amount === 'number' ? `${amount.toLocaleString('en-SG')}${suffix}` : amount,
      ST.td(undefined, 'right'),
    );
    // A long explanation is wrapped inside the printed width; a short one runs on.
    if (relief.help.length > NOTE_RUN_CHARS) {
      mergeRow(ws, r, 4, 8, ST.note()).value = relief.help;
      ws.getRow(r).height = heightFor(relief.help, NOTE_WIDTH, 9);
    } else {
      b.v(ws, 4, r, relief.help, ST.noteRun());
    }
    r++;
  }
  r++;

  // ---- Sources ----------------------------------------------------------------------------------------------
  section('Official sources for these values');
  for (const source of rules.sources) {
    // Long labels take two lines so the link beside them is never covered.
    ws.getRow(r).height = source.label.length > 50 ? 30 : 16;
    b.v(ws, 2, r, source.label, ST.tdWrap());
    b.v(ws, 3, r, { text: source.url, hyperlink: source.url }, ST.link());
    r++;
  }
  r++;
  mergeRow(ws, r, 2, 8, ST.note()).value =
    'This workbook is an estimate for planning, not tax, legal or financial advice. It is not affiliated with IRAS or the CPF Board.';
  ws.getRow(r).height = 18;

  view(ws, 2);
  pageSetup(ws, { landscape: true, lastCol: 'H', lastRow: r, titleRows: '1:1' });
  return ws;
}
