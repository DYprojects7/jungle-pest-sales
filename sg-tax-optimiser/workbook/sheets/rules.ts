/**
 * The Rules sheet: the single place rule values live. Every value comes from `YearRules`; every other sheet
 * reads them from here, so a buyer can update this sheet for a new year.
 */
import type ExcelJS from 'exceljs';
import type { CpfAgeBand, Residency } from '../../src/engine/types';
import { Book, C, NF, SHEETS, ST, mergeRow, pageSetup, setWidths, styleRow, view } from '../kit';

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
  description: string;
}

/** SPEC §8.3 "Which first?". */
export const PRIORITY_PRESETS: PriorityPreset[] = [
  {
    label: 'Flexibility first',
    order: ['srs', 'cpfSelf', 'cpfFamily'],
    description: 'SRS, then your own CPF, then family. SRS can be withdrawn early (taxed, with a 5% penalty); CPF cannot.',
  },
  {
    label: 'Guaranteed interest first',
    order: ['cpfSelf', 'srs', 'cpfFamily'],
    description: 'Your own CPF, then SRS, then family. CPF top-ups earn the CPF interest floor; SRS earns 0.05% unless invested.',
  },
  {
    label: 'Family first',
    order: ['cpfFamily', 'srs', 'cpfSelf'],
    description: "Family members' CPF, then SRS, then your own CPF.",
  },
];

const COL = { label: 2, c: 3, d: 4, e: 5, f: 6, g: 7, note: 8 };

export function buildRules(b: Book): ExcelJS.Worksheet {
  const rules = b.rules;
  const ws = b.sheet(SHEETS.rules, C.ochre);
  setWidths(ws, [2, 46, 16, 14, 14, 16, 18, 90]);

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
    'against the official source listed at the bottom. Nothing else needs to change.';
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
    if (note) b.v(ws, COL.d, r, note, ST.noteRun());
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
    '"projected" means some values are announced or carried forward, not yet final. The Planner then shows a caution.',
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
  item(
    'r_deadline',
    'Last day a contribution counts for this year',
    new Date(Date.UTC(dy, dm - 1, dd)),
    NF.date,
    'SRS banks and the CPF Board can stop taking contributions earlier on the day (for example 7pm).',
  );
  rules.statusNotes.forEach((text, index) => {
    b.v(ws, COL.label, r, index === 0 ? 'Notes for this year' : '', ST.label());
    b.v(ws, COL.c, r, text, ST.noteRun());
    r++;
  });
  r++;

  // ---- Income tax -------------------------------------------------------------------------------------------
  section('Income tax for residents');
  const brackets = rules.taxBrackets;
  ws.getRow(r).height = 30;
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
      'To add a bracket, insert a row inside the table and copy the grey formulas down.',
    ST.note(),
  );
  r++;
  const b1 = r;
  brackets.forEach((bracket, index) => {
    const last = index === brackets.length - 1;
    b.v(ws, COL.label, r, `Bracket ${index + 1}`, ST.td(undefined, 'left'));
    b.v(ws, COL.c, r, bracket.from, ST.input(NF.int));
    b.v(ws, COL.d, r, bracket.rate, ST.input(NF.pct));
    if (last) b.v(ws, COL.e, r, 'and above', ST.helper(undefined, 'right'));
    else b.f(ws, COL.e, r, () => `C${r0(index) + 1}`, ST.helper(NF.int));
    b.f(
      ws,
      COL.f,
      r,
      () => (index === 0 ? `ROUND(D${r0(index)}*1000,0)` : `ROUND(D${r0(index)}*1000,0)-ROUND(D${r0(index) - 1}*1000,0)`),
      ST.helper(NF.plain),
    );
    b.f(
      ws,
      COL.g,
      r,
      ($) => `ROUND(SUMPRODUCT((C${r0(index)}>${$('r_from')})*(C${r0(index)}-${$('r_from')})*${$('r_step')})/10,0)/100`,
      ST.helper(NF.cents),
    );
    b.reg(`r_from_${index + 1}`, ws, COL.c, r);
    b.reg(`r_rate_${index + 1}`, ws, COL.d, r);
    b.reg(`r_to_${index + 1}`, ws, COL.e, r);
    r++;
  });
  function r0(index: number): number {
    return b1 + index;
  }
  const bN = r - 1;
  b.regRange('r_from', ws, COL.c, b1, COL.c, bN);
  b.regRange('r_rate', ws, COL.d, b1, COL.d, bN);
  b.regRange('r_step', ws, COL.f, b1, COL.f, bN);
  r++;

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
  item(
    'r_rebateRate',
    'Personal income tax rebate — share of tax',
    rules.pitRebate ? rules.pitRebate.rate : 0,
    NF.pct,
    rules.pitRebate
      ? 'A rebate applies for this Year of Assessment.'
      : 'None for this Year of Assessment. If one is announced, enter the rate here and the cap below.',
  );
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
    'Retirement age locked in by a first contribution this year',
    rules.srs.statutoryRetirementAge,
    NF.plain,
    'For reference: withdrawals before this age are fully taxable with a 5% penalty.',
  );
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
  item('r_frs', 'Full Retirement Sum', rules.cpfTopUp.fullRetirementSum, NF.dollars, 'For reference: top-ups to your own Special/Retirement Account earn relief only up to this balance.');
  item('r_ers', 'Enhanced Retirement Sum', rules.cpfTopUp.enhancedRetirementSum, NF.dollars, 'For reference.');
  item('r_bhs', 'Basic Healthcare Sum', rules.cpfTopUp.basicHealthcareSum, NF.dollars, 'For reference: the most your MediSave Account can hold.');
  item('r_interest', 'Interest floor on Special, MediSave and Retirement Accounts', rules.cpfTopUp.interestRateSmra, NF.pct, 'For reference.');
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
  const minRates = [0, ...brackets.map((bracket) => bracket.rate).filter((rate) => rate > 0)];
  const listRows = Math.max(MONTH_LABELS.length, minRates.length);
  for (let i = 0; i < listRows; i++) {
    const residency = RESIDENCY_ORDER[i];
    if (residency) b.v(ws, 2, r, RESIDENCY_LABELS[residency], ST.td(undefined, 'left'));
    const prYear = PR_YEAR_LABELS[i];
    if (prYear) b.v(ws, 3, r, prYear, ST.td(undefined, 'left'));
    if (i < 2) b.v(ws, 4, r, i === 0 ? YES : NO, ST.td(undefined, 'left'));
    const month = MONTH_LABELS[i];
    if (month) b.v(ws, 5, r, month, ST.td(undefined, 'left'));
    if (i === 0) {
      b.v(ws, 6, r, 0, ST.td(NF.minRate, 'left'));
    } else if (i < minRates.length) {
      // Linked to the bracket table so the choices follow the rates.
      const bracketIndex = brackets.findIndex((bracket) => bracket.rate === minRates[i]);
      b.f(ws, 6, r, ($) => $(`r_rate_${bracketIndex + 1}`), ST.td(NF.minRate, 'left'));
    }
    r++;
  }
  b.regRange('l_residency', ws, 2, listTop, 2, listTop + RESIDENCY_ORDER.length - 1);
  b.regRange('l_prYear', ws, 3, listTop, 3, listTop + PR_YEAR_LABELS.length - 1);
  b.regRange('l_yesNo', ws, 4, listTop, 4, listTop + 1);
  b.regRange('l_months', ws, 5, listTop, 5, listTop + MONTH_LABELS.length - 1);
  b.regRange('l_minRate', ws, 6, listTop, 6, listTop + minRates.length - 1);
  r++;

  ws.getRow(r).height = 30;
  b.v(ws, 2, r, 'Which scheme first?', ST.helperHead('left'));
  b.v(ws, 3, r, 'SRS is filled', ST.helperHead('right'));
  b.v(ws, 4, r, 'CPF self is filled', ST.helperHead('right'));
  b.v(ws, 5, r, 'CPF family is filled', ST.helperHead('right'));
  b.v(ws, 6, r, 'In words', ST.helperHead('left'));
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
    const amount =
      relief.amountPerUnit > 0
        ? relief.amountPerUnit
        : relief.options
          ? relief.options
              .filter((option) => option.amount > 0)
              .map((option) => option.amount.toLocaleString('en-SG'))
              .filter((text, index, all) => all.indexOf(text) === index)
              .join(' / ')
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
    b.v(ws, 4, r, relief.help, ST.noteRun());
    r++;
  }
  r++;

  // ---- Sources ----------------------------------------------------------------------------------------------
  section('Official sources for these values');
  for (const source of rules.sources) {
    b.v(ws, 2, r, source.label, ST.td(undefined, 'left'));
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
