/**
 * The Planner sheet: inputs on the left, the recommendation on the right. Every figure on the right is a formula
 * that reads the Tax Working sheet; nothing is typed in. It tells the same story as the web page (SPEC §9): the
 * recommendation as a sentence, how long the cash is locked away, why the plan stops, and the things to check
 * straight under it.
 */
import type ExcelJS from 'exceljs';
import { DISCLAIMER } from '../../src/engine/facts';
import { RETIREMENT_ACCOUNT_AGE } from '../../src/engine/levers';
import {
  Book,
  C,
  MAX_MONEY,
  NF,
  SHEETS,
  ST,
  a1,
  centsNumber,
  charsPerLine,
  dollarsText,
  heightFor,
  heightOfLines,
  isNum,
  lit,
  longDate,
  mergeRow,
  pageSetup,
  rateNumber,
  setWidths,
  view,
} from '../kit';
import type { Resolver, Style } from '../kit';
import { DEFAULT_MIN_RATE, EXAMPLE } from './example';
import { LEVER_NAMES } from './rules';

export { DEFAULT_MIN_RATE, EXAMPLE } from './example';

/**
 * How many "Things to check" lines the Planner can show. Never more than 15 are needed: the two workbook checks,
 * at most eleven of the twenty-one SPEC §6.11 warnings for someone who is not a foreigner (the "no tax", "below
 * your minimum" and three "… limits the plan" lines exclude one another, as do the two deadline lines and the
 * two age-55 lines; the three lines for foreigners and the under-18 line cannot join them), and two more because
 * the over-the-cap check takes a line for each scheme that is over its cap. A foreigner needs fewer.
 */
export const WARNING_LINES = 15;
/** Sheet rows each "Things to check" line spans (merged), so that a line has room without making input rows tall. */
export const WARNING_LINE_ROWS = 2;
/** Lines of text a "Things to check" line has room for. */
const WARNING_TEXT_LINES = 3;
const WARNING_FONT = 10;

/** Column widths: A margin, B label, C input, D note, E gap, F–H the plan. */
const WIDTHS = [2, 50, 25, 52, 3, 41, 19, 50];
const NOTE_WIDTH = WIDTHS[3] ?? 52;
const LABEL_WIDTH = WIDTHS[1] ?? 50;
const PLAN_WIDTH = (WIDTHS[5] ?? 0) + (WIDTHS[6] ?? 0) + (WIDTHS[7] ?? 0);

/**
 * The lock-up block under the plan: how long each scheme in the plan is locked away, then the condition on the SRS
 * age. With all three schemes in the plan that is three lines of text, so it spans two sheet rows.
 */
export const HORIZON_ROWS = 2;
const HORIZON_TEXT_LINES = 3;
const HORIZON_FONT = 10;
/** The longest text the lock-up block shows without clipping (the test holds every profile to it). */
export const HORIZON_CHARS = Math.floor(HORIZON_TEXT_LINES * charsPerLine(PLAN_WIDTH, HORIZON_FONT));
/** The least height (points) of each sheet row the lock-up block spans. */
export const HORIZON_ROW_HEIGHT = Math.ceil(heightOfLines(HORIZON_TEXT_LINES, HORIZON_FONT) / HORIZON_ROWS);

/** The longest text a "Things to check" line shows without clipping (the test holds every message to it). */
export const WARNING_LINE_CHARS = Math.floor(WARNING_TEXT_LINES * charsPerLine(PLAN_WIDTH, WARNING_FONT));
/** The least height (points) of each sheet row a "Things to check" line spans. */
export const WARNING_ROW_HEIGHT = Math.ceil(heightOfLines(WARNING_TEXT_LINES, WARNING_FONT) / WARNING_LINE_ROWS);

type F = ($: Resolver) => string;
type Note = string | F;

/** The word the room cell's note opens with while the room is needed and blank; the cell's colour follows it. */
const ROOM_NEEDED = 'NEEDED';

/** A rate as a number of cents per dollar (or percent), e.g. 0.115 -> "11.5". */
function cents(rate: number): string {
  return String(Math.round(rate * 1000) / 10);
}

export function buildPlanner(b: Book): ExcelJS.Worksheet {
  const ws = b.sheet(SHEETS.planner, C.slate);
  setWidths(ws, WIDTHS);
  const $ = b.resolver(ws);

  // ---- Heading ----------------------------------------------------------------------------------------------
  ws.getRow(1).height = 34;
  mergeRow(ws, 1, 2, 6, ST.title()).value = 'Singapore Tax Optimiser';
  mergeRow(ws, 1, 7, 8, ST.titleNote());
  b.f(ws, 7, 1, ($) => `"Year of Assessment "&${$('r_ya')}&IF(${$('r_status')}="projected"," · PROJECTED RULES","")&" · estimate only, not tax advice"`);
  b.reg('p_header', ws, 7, 1);
  ws.getRow(2).height = 22;
  mergeRow(ws, 2, 2, 8, ST.subtitle());
  b.f(
    ws,
    2,
    2,
    ($) =>
      `"How much to put into SRS and CPF cash top-ups before the end of "&${$('r_incomeYear')}&" to cut your income tax. Fill in the cream cells; everything else updates by itself."`,
  );
  ws.getRow(3).height = 24;
  mergeRow(ws, 3, 2, 8, ST.banner());
  b.reg('p_banner', ws, 2, 3);
  ws.addConditionalFormatting({
    ref: 'B3:H3',
    rules: [
      {
        type: 'expression',
        priority: 1,
        formulae: ['OR(LEFT($B$3,5)="CHECK",LEFT($B$3,9)="PROJECTED")'],
        style: { font: { bold: true, color: { argb: C.warn } }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.warnFill } } },
      },
    ],
  });
  ws.getRow(4).height = 6;

  ws.getRow(5).height = 22;
  mergeRow(ws, 5, 2, 4, ST.block()).value = '1 · Your details';
  mergeRow(ws, 5, 6, 8, ST.block()).value = '2 · Your plan';

  // ---- Inputs (left) ----------------------------------------------------------------------------------------
  let r = 6;
  const exampleTests: F[] = [];
  const addExampleTest = (name: string, example: ExcelJS.CellValue): void => {
    exampleTests.push(($) =>
      example === null ? `${$(name)}=""` : typeof example === 'string' ? `${$(name)}="${example}"` : `${$(name)}=${String(example)}`,
    );
  };

  const sectionL = (title: string | F): void => {
    mergeRow(ws, r, 2, 4, ST.section());
    if (typeof title === 'string') ws.getCell(r, 2).value = title;
    else b.f(ws, 2, r, title);
    ws.getRow(r).height = 19;
    r++;
  };

  /** One "label | cream cell | note" row. `noteChars` is the longest a formula note can be (it sets the row height). */
  const input = (
    name: string,
    label: string | F,
    value: ExcelJS.CellValue,
    style: Style,
    note: Note,
    validation: ExcelJS.DataValidation,
    options: { indent?: boolean; noteChars?: number; labelChars?: number; opensWith?: F } = {},
  ): number => {
    const row = r;
    const noteLength = typeof note === 'string' ? note.length : (options.noteChars ?? 60);
    const labelLength = typeof label === 'string' ? label.length : (options.labelChars ?? 40);
    ws.getRow(row).height = Math.max(20, heightFor(noteLength, NOTE_WIDTH, 9), heightFor(labelLength, LABEL_WIDTH - (options.indent ? 4 : 0), 11));
    const labelStyle = options.indent ? ST.labelIndent() : ST.label();
    if (typeof label === 'string') b.v(ws, 2, row, label, labelStyle);
    else b.f(ws, 2, row, label, labelStyle);
    // `opensWith`: the cell starts as a formula (a default that follows another cell) until it is typed over;
    // `value` is then what that formula gives in the opening example.
    if (options.opensWith) b.f(ws, 3, row, options.opensWith, style);
    else b.v(ws, 3, row, value, style);
    ws.getCell(row, 3).dataValidation = validation;
    if (typeof note === 'string') b.v(ws, 4, row, note, ST.note());
    else b.f(ws, 4, row, note, ST.note());
    b.reg(name, ws, 3, row);
    b.reg(`label_${name}`, ws, 2, row);
    b.reg(`note_${name}`, ws, 4, row);
    b.define(name, name);
    addExampleTest(name, value);
    r++;
    return row;
  };

  const money = (title: string, prompt: string): ExcelJS.DataValidation => ({
    type: 'decimal',
    operator: 'between',
    formulae: [0, MAX_MONEY],
    allowBlank: true,
    showErrorMessage: true,
    errorStyle: 'stop',
    errorTitle: 'Dollars only',
    error: 'Enter an amount in Singapore dollars, 0 or more, without the S$ sign.',
    showInputMessage: true,
    promptTitle: title,
    prompt,
  });
  const list = (rangeKey: string, title: string, prompt: string): ExcelJS.DataValidation => ({
    type: 'list',
    allowBlank: false,
    formulae: [$(rangeKey)],
    showErrorMessage: true,
    errorStyle: 'stop',
    errorTitle: 'Pick from the list',
    error: 'Choose one of the options in the dropdown.',
    showInputMessage: true,
    promptTitle: title,
    prompt,
  });
  const whole = (min: number, max: number, title: string, prompt: string): ExcelJS.DataValidation => ({
    type: 'whole',
    operator: 'between',
    formulae: [min, max],
    allowBlank: true,
    showErrorMessage: true,
    errorStyle: 'stop',
    errorTitle: title,
    error: `Enter a whole number from ${min} to ${max}.`,
    showInputMessage: true,
    promptTitle: title,
    prompt,
  });

  sectionL('About you');
  input(
    'in_residency',
    'Residency',
    EXAMPLE.residency,
    ST.input(undefined, 'left'),
    // What a tax resident is, in the page's words, for every choice (SPEC §8.3).
    ($) =>
      `"This tool is for tax residents: people who stayed or worked in Singapore for at least 183 days in "&${$('r_incomeYear')}&"."&IF(${$('u_res')}=3," A non-resident gets no personal reliefs and no SRS relief.","")`,
    list('l_residency', 'Residency', 'Citizens and PRs pay CPF and can top up CPF. Foreigners on work passes cannot, but have a higher SRS cap.'),
    { noteChars: 170 },
  );
  input(
    'in_prYear',
    'If a Permanent Resident: which year as a PR?',
    EXAMPLE.prYear,
    ST.input(undefined, 'left'),
    'Ignored unless you are a PR. Choose "3rd year onwards" if you pay full CPF rates.',
    list('l_prYear', 'Years as a PR', 'PRs pay lower CPF rates in their first two years, so their CPF relief is smaller.'),
    { indent: true },
  );
  input(
    'in_age',
    ($) => `"Age on 31 December "&${$('r_incomeYear')}`,
    EXAMPLE.age,
    ST.input(NF.plain),
    'The age you reach during the year.',
    whole(0, 120, 'Age', 'Your age on 31 December of the income year (the year minus your year of birth).'),
  );
  input(
    'in_birthMonth',
    'Birth month',
    EXAMPLE.birthMonth,
    ST.input(undefined, 'left'),
    'Only matters in the year you turn 55, 60, 65 or 70, when CPF rates change.',
    list('l_months', 'Birth month', 'CPF rates change from the month after your 55th, 60th, 65th and 70th birthday.'),
    { indent: true },
  );

  sectionL(($) => `"Your income in "&${$('r_incomeYear')}`);
  // Salary: the amount, and beside it whether it is a month's or a year's pay (SPEC §9).
  const salaryRow = r;
  ws.getRow(salaryRow).height = 20;
  b.v(ws, 2, salaryRow, 'Salary before CPF (S$)', ST.label());
  b.v(ws, 3, salaryRow, EXAMPLE.salary, ST.input(NF.int));
  ws.getCell(salaryRow, 3).dataValidation = money('Salary', 'Your basic pay plus fixed monthly allowances, before CPF is taken off: for one month, or for the year if you choose "per year" beside it.');
  b.reg('in_salary', ws, 3, salaryRow);
  b.define('in_salary', 'in_salary');
  addExampleTest('in_salary', EXAMPLE.salary);
  b.v(ws, 4, salaryRow, EXAMPLE.salaryPeriod, ST.input(undefined, 'left'));
  ws.getCell(salaryRow, 4).dataValidation = list('l_salaryPeriod', 'Per month or per year?', 'Choose "per year" to type your yearly salary. It is split into twelve equal months, as the web page does.');
  b.reg('in_salaryPeriod', ws, 4, salaryRow);
  b.define('in_salaryPeriod', 'in_salaryPeriod');
  addExampleTest('in_salaryPeriod', EXAMPLE.salaryPeriod);
  r++;
  // How the figure is read: the month's pay the working uses, and what happens to dollars that do not divide.
  ws.getRow(r).height = heightFor(170, NOTE_WIDTH, 9);
  b.v(ws, 2, r, 'Counted as, per month (S$)', ST.labelIndent());
  b.f(ws, 3, r, ($) => $('u_ow'), { ...ST.value(NF.int, { color: { argb: C.muted } }), alignment: { vertical: 'middle', horizontal: 'right', indent: 1 } });
  b.f(
    ws,
    4,
    r,
    ($) =>
      `IF(${$('u_perYear')}=0,${lit('Gross basic pay plus fixed monthly allowances, before CPF. To type a yearly salary instead, choose "per year" beside the figure.')},` +
      `"A yearly salary is split into twelve equal months of whole dollars."&IF(${$('u_odd')}>0," The "&${dollarsText($('u_odd'))}&" left over is counted with your bonus, so your income is right to the dollar.",""))`,
    ST.note(),
  );
  b.reg('note_in_salary', ws, 4, r);
  r++;
  input(
    'in_monthsWorked',
    'Months worked in the year',
    EXAMPLE.monthsWorked,
    ST.input(NF.plain),
    '1 to 12. Part-years count as the last months of the year.',
    whole(1, 12, 'Months worked', 'How many months you are paid for in the income year, 1 to 12.'),
  );
  input(
    'in_additionalWages',
    'Bonus and other additional wages for the year (S$)',
    EXAMPLE.additionalWages,
    ST.input(NF.int),
    'Bonus, 13th month, and commissions or incentives paid less often than monthly. Put those paid every month in your salary.',
    money('Bonus', 'Everything paid on top of monthly salary during the year.'),
  );
  input(
    'in_otherIncome',
    'Other taxable income for the year (S$)',
    EXAMPLE.otherIncome,
    ST.input(NF.int),
    'For example net rent or taxable benefits. No CPF is paid on it.',
    money('Other taxable income', 'Taxable income that does not attract CPF.'),
    { indent: true },
  );
  input(
    'in_employmentExpenses',
    'Employment expenses you can claim (S$)',
    EXAMPLE.employmentExpenses,
    ST.input(NF.int),
    'Allowable work expenses your employer did not reimburse.',
    money('Employment expenses', 'Leave at 0 if you do not claim any.'),
    { indent: true },
  );
  input(
    'in_donations',
    'Donations to approved charities (S$)',
    EXAMPLE.donations,
    ST.input(NF.int),
    ($) => `"Enter what you gave; it is deducted at "&ROUND(${$('r_donationMultiplier')}*100,0)&"%."`,
    money('Donations', 'Cash donations to approved Institutions of a Public Character during the year.'),
    { indent: true },
  );
  input(
    'in_cpfOverride',
    'Your actual employee CPF for the year (S$, optional)',
    EXAMPLE.cpfOverride,
    ST.input(NF.int),
    // Says which figure is in use, so a 0 typed to "clear" the cell does not pass unnoticed.
    ($) =>
      `IF(${$('u_res')}=3,${lit('Not used: foreigners on work passes make no CPF contributions.')},` +
      `IF(${$('u_overrideOn')}=0,"Not filled in, so it is worked out from your pay: "&${dollarsText($('w_cpfAuto'))}&". Fill in to use the figure on your payslips or CPF statement.",` +
      `IF(${$('u_override')}>${$('w_maxCompulsory')},"Above the most possible in a year, so "&${dollarsText($('w_maxCompulsory'))}&" is used. Clear the cell to have it worked out ("&${dollarsText($('w_cpfAuto'))}&").",` +
      `"Using your figure of "&${dollarsText($('u_override'))}&" instead of the worked-out "&${dollarsText($('w_cpfAuto'))}&". Clear the cell to go back.")))`,
    money('Actual employee CPF', 'Optional. Your own compulsory contributions for the whole year. Leave blank (not 0) to have them calculated.'),
    { indent: true, noteChars: 150 },
  );

  sectionL(($) => `"Already contributed in "&${$('r_incomeYear')}`);
  input(
    'in_existingSrs',
    'SRS (S$)',
    EXAMPLE.existingSrs,
    ST.input(NF.int),
    'Already put in this year, including anything your employer paid into your SRS. The plan recommends only the rest.',
    money('SRS so far', 'SRS contributions already made in the income year, by you or your employer.'),
  );
  input(
    'in_existingCpfSelf',
    'CPF cash top-up to yourself (S$)',
    EXAMPLE.existingCpfSelf,
    ST.input(NF.int),
    'Cash top-ups to your own Special, Retirement or MediSave Account, including any your employer made.',
    money('CPF top-ups to yourself so far', 'Cash top-ups already made to your own accounts in the income year.'),
  );
  input(
    'in_existingCpfFamily',
    'CPF cash top-up to family (S$)',
    EXAMPLE.existingCpfFamily,
    ST.input(NF.int),
    'Parents, parents-in-law, grandparents and grandparents-in-law; a spouse or sibling only if they earned no more than S$8,000 in the year before the top-up or have a disability. Leave out any part the Government matches.',
    money('CPF top-ups to family so far', 'Cash top-ups already made to eligible family members in the income year, leaving out any part the Government matched.'),
  );

  sectionL('Other reliefs');
  input(
    'in_otherReliefs',
    'Total of your other reliefs (S$)',
    EXAMPLE.otherReliefs,
    ST.input(NF.int),
    'Spouse, child, parent, NSman and so on (amounts are on the Rules sheet). Leave out CPF, SRS, top-ups and Earned Income Relief.',
    money('Other reliefs', 'The total of every other personal relief you expect. Do not include CPF, SRS, CPF top-ups or Earned Income Relief; those are worked out for you.'),
  );
  input(
    'in_unusedPtr',
    'I have unused Parenthood Tax Rebate',
    EXAMPLE.unusedPtr,
    ST.input(undefined, 'center'),
    'Yes if you have rebate left over from earlier years. It changes no figure; the plan then says what it means.',
    list('l_yesNo', 'Unused Parenthood Tax Rebate?', 'Choose Yes if you still have Parenthood Tax Rebate from earlier years to set against your tax.'),
  );

  sectionL('Your preferences');
  // Asked first: it decides whether the answer is one you can afford (SPEC §8.3).
  input(
    'in_cashBudget',
    'Most cash you can spare this year (S$, optional)',
    EXAMPLE.cashBudget,
    ST.input(NF.int),
    ($) =>
      `IF(${$('u_budgetOn')}=0,"Blank = no limit.",IF(${$('u_budget')}=0,"A limit of S$0 means nothing is recommended. Clear the cell for no limit.",` +
      `"The plan will not go above "&${dollarsText($('u_budget'))}&". Clear the cell for no limit."))`,
    money('Cash limit', 'Optional. The plan will fit inside this amount. Leave blank (not 0) for no limit.'),
    { noteChars: 90 },
  );
  input(
    'in_useSrs',
    'Use SRS?',
    EXAMPLE.useSrs,
    ST.input(undefined, 'center'),
    // A scheme that is not open to the user says so here, instead of quoting a cap they cannot use.
    ($) =>
      `IF(${$('w_eligible_srs')}=0,"Not open to you: you must be at least "&${$('r_srsMinAge')}&" to contribute to SRS.",` +
      `"Up to S$"&TEXT(IF(${$('u_res')}=3,${$('r_srsCapForeigner')},${$('r_srsCapCitizenPr')}),"#,##0")&" a year. "&${lit('Locked until the retirement age in force when you first contributed (62, 63 or 64); half of what you later withdraw is taxable.')})`,
    list('l_yesNo', 'Use SRS?', 'Choose No to leave SRS out of the plan.'),
    { noteChars: 160 },
  );
  input(
    'in_useCpfSelf',
    'Use CPF cash top-up, self?',
    EXAMPLE.useCpfSelf,
    ST.input(undefined, 'center'),
    ($) =>
      `IF(${$('w_eligible_cpfSelf')}=0,${lit('Not open to you: CPF top-ups are for Singapore Citizens and Permanent Residents.')},` +
      `"Up to S$"&TEXT(${$('r_selfCap')},"#,##0")&" a year earns relief: "&${lit('a cash top-up to your Special or Retirement Account or MediSave, not a contribution to all three accounts. It cannot be reversed.')})`,
    list('l_yesNo', 'Use CPF cash top-up, self?', 'Citizens and PRs only. Choose No to leave top-ups to your own CPF out of the plan.'),
    { noteChars: 175 },
  );
  // The room for the person's own CPF: optional below 55, asked for from 55 (SPEC §6.5). While it is needed and
  // blank the label, the note and the cell's colour all say so — but only when top-ups to the person's own CPF
  // are open to them and switched on (exactly when the plan leaves their own CPF out for want of the figure). To
  // a foreigner the cell says it is not used; with the scheme switched off, that it is asked for if switched on.
  const ROOM_LABEL = 'Top-up to your own CPF that can still earn relief (S$';
  const older = ($: Resolver): string => `${$('u_age')}>=${RETIREMENT_ACCOUNT_AGE}`;
  const roomRow = input(
    'in_cpfSelfRoom',
    ($) =>
      `IF(${$('w_eligible_cpfSelf')}=0,"${ROOM_LABEL}) — not used",` +
      `IF(${older($)},IF(${$('u_selfLimitOn')}=1,"${ROOM_LABEL}, needed from age ${RETIREMENT_ACCOUNT_AGE})",` +
      `IF(${$('w_enabled_cpfSelf')}=1,"${ROOM_LABEL}) — ${ROOM_NEEDED} from age ${RETIREMENT_ACCOUNT_AGE}","${ROOM_LABEL}) — needed if switched on")),` +
      `"${ROOM_LABEL}, optional)"))`,
    EXAMPLE.cpfSelfRoom,
    ST.input(NF.int),
    ($) =>
      `IF(${$('w_eligible_cpfSelf')}=0,${lit('Not used: CPF top-ups are not open to you.')},` +
      `IF(${$('u_selfLimitOn')}=1,"Top-ups to yourself are held to "&${dollarsText($('u_selfLimit'))}&"."&IF(${older($)}," Check it against your CPF Retirement dashboard."," Clear the cell if your accounts are far from their limits."),` +
      `IF(${older($)},IF(${$('w_enabled_cpfSelf')}=1,` +
      `${lit(`${ROOM_NEEDED} from age ${RETIREMENT_ACCOUNT_AGE}: your own CPF is left out of the plan until you enter this. Your CPF Retirement dashboard shows it; enter 0 if you have set aside the Full Retirement Sum.`)},` +
      `${lit(`From age ${RETIREMENT_ACCOUNT_AGE} this is asked for only if you switch on top-ups to your own CPF (the row above). Your CPF Retirement dashboard shows it; enter 0 if you have set aside the Full Retirement Sum.`)}),` +
      `${lit('How much you can still top up before the Full Retirement Sum and Basic Healthcare Sum. Blank = not limiting: below 55 the CPF Board does not accept more.')})))`,
    money('Top-up that still earns relief', `Top-ups above the Full Retirement Sum or Basic Healthcare Sum earn no relief. From age ${RETIREMENT_ACCOUNT_AGE} this figure is needed: your CPF Retirement dashboard shows it.`),
    { indent: true, noteChars: 200, labelChars: 80 },
  );
  input(
    'in_useCpfFamily',
    'Use CPF cash top-up, family?',
    EXAMPLE.useCpfFamily,
    ST.input(undefined, 'center'),
    ($) =>
      `IF(${$('w_eligible_cpfFamily')}=0,${lit('Not open to you: family top-ups do not earn you tax relief (see the Rules sheet).')},` +
      `"Up to S$"&TEXT(${$('r_famCap')},"#,##0")&" a year earns relief, for a family member who qualifies (see ""CPF cash top-up to family"" above). It is a gift and cannot be reversed.")`,
    list('l_yesNo', 'Use CPF cash top-up, family?', 'Choose Yes only if you have a family member who qualifies and has a CPF account.'),
    { noteChars: 160 },
  );
  input(
    'in_cpfFamilyMax',
    'Most you would give to family (S$, optional)',
    EXAMPLE.cpfFamilyMax,
    ST.input(NF.int),
    ($) =>
      // Not a limit to fill in for someone family top-ups earn no relief for (a foreigner).
      `IF(${$('w_eligible_cpfFamily')}=0,${lit('Not used: family top-ups are not open to you.')},` +
      `IF(${$('u_famLimitOn')}=1,"Held to "&${dollarsText($('u_famLimit'))}&"; clear the cell to go up to the cap.","Blank = up to the relief cap.")` +
      `&" Leave out what the Government matches: the first "&${dollarsText($('r_matchedRetirement'))}&" a year for a member on the Matched Retirement Savings Scheme"` +
      `&IF(${isNum($('r_matchedMediSave'))},", "&${dollarsText($('r_matchedMediSave'))}&" for MediSave","")&".")`,
    money('Most you would give', 'Optional. The plan will not recommend more than this for family members.'),
    { indent: true, noteChars: 200 },
  );
  input(
    'in_minSavingRate',
    'How far down the ladder? Smallest tax saving per dollar',
    EXAMPLE.minSavingRate,
    ST.input(NF.minRate),
    ($) =>
      `IF(${$('u_minRate')}=0,${lit('Every tax dollar: the plan uses every dollar that saves some tax, however little.')},` +
      `${centsNumber($('u_minRate'))}&" cents or more: the plan uses only dollars that each save at least that much tax.")` +
      // SPEC §8.3: for a foreigner a rung below what leaving costs is a loss, and the control says so; at or above
      // it, the note says why their cell starts higher than a citizen's.
      `&IF(${$('u_res')}=3,IF(ROUND(${$('u_minRate')}*1000,0)<ROUND(${$('r_nrCost')}*1000,0),` +
      `" A foreigner who has left Singapore pays at least "&${rateNumber($('r_nrCost'))}&" cents per dollar in tax to take SRS out, so a smaller saving would be a loss: choose a higher minimum.",` +
      `" For a foreigner this cell starts at ${cents(DEFAULT_MIN_RATE.foreigner)} cents: taking SRS out after leaving Singapore costs at least "&${rateNumber($('r_nrCost'))}&" cents per dollar in tax."),"")`,
    {
      // The choices are plain percentages, so what the dropdown shows is what it puts in the cell in every
      // application; the cell itself shows 0 as "Every tax dollar". A rate that is not in the list can still be typed.
      type: 'list',
      allowBlank: true,
      formulae: [$('l_minRate')],
      showErrorMessage: true,
      errorStyle: 'warning',
      errorTitle: 'Not one of the tax rates',
      error: 'That is not one of the tax rates in the list. You can still use it as your own minimum (for example 10%), or go back and pick from the list.',
      showInputMessage: true,
      promptTitle: 'How far down the ladder?',
      prompt:
        'Each extra dollar saves tax at your top rate first, then at lower rates. Pick the lowest rate still worth locking money away for: 7.0% means 7 cents or more per dollar; 0.0% means every tax dollar. ' +
        `It starts at ${(DEFAULT_MIN_RATE.resident * 100).toFixed(1)}%, or ${(DEFAULT_MIN_RATE.foreigner * 100).toFixed(1)}% for foreigners.`,
    },
    {
      noteChars: 245,
      labelChars: 56,
      // The default follows the residency until a rate is typed or picked: 7 cents, or 11.5 cents for a foreigner
      // (SPEC §8.3; the buyer guide promises it). A rate typed over the formula stays whatever the residency.
      opensWith: ($) => `IF(${$('u_res')}=3,${DEFAULT_MIN_RATE.foreigner},${DEFAULT_MIN_RATE.resident})`,
    },
  );
  input(
    'in_priority',
    'Which scheme first?',
    EXAMPLE.priority,
    ST.input(undefined, 'left'),
    ($) => `INDEX(${$('l_priorityText')},${$('u_preset')})&" The order does not change the tax saved, only where the money goes."`,
    list('l_priority', 'Which scheme first?', 'The order does not change the tax saved, only where the money goes.'),
    { noteChars: 110 },
  );
  const lastInputRow = r - 1;

  // The room cell stands out while it is needed and blank: exactly while the note beside it opens with "NEEDED",
  // so the colour and the words cannot disagree. (It refers to its own sheet only, so every application applies
  // it. The comparison ignores case, so no other opening of the note may begin with the same letters.)
  ws.addConditionalFormatting({
    ref: a1(3, roomRow),
    rules: [
      {
        type: 'expression',
        priority: 1,
        formulae: [`LEFT($D$${roomRow},${ROOM_NEEDED.length})="${ROOM_NEEDED}"`],
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.warnFill } }, border: { top: { style: 'medium', color: { argb: C.warn } }, bottom: { style: 'medium', color: { argb: C.warn } }, left: { style: 'medium', color: { argb: C.warn } }, right: { style: 'medium', color: { argb: C.warn } } } },
      },
    ],
  });

  // The banner: a problem on the Rules sheet first; then PROJECTED RULES; then whether the cream cells still hold
  // the worked example, or which of its figures are still in use (SPEC §9).
  const exampleWords = `age ${EXAMPLE.age}, S$${EXAMPLE.salary.toLocaleString('en-US')} a month, S$${EXAMPLE.additionalWages.toLocaleString('en-US')} bonus, S$${EXAMPLE.otherReliefs.toLocaleString('en-US')} other reliefs`;
  b.f(
    ws,
    2,
    3,
    ($) =>
      // A problem with the Rules sheet outranks everything: the figures below may then be wrong.
      `IF(SUM(${$('w_checkFlags')})>0,"CHECK THE RULES SHEET FIRST — see the first line under ""Things to check"". Until it is fixed, the figures below may be wrong.",` +
      `IF(${$('r_status')}="projected","PROJECTED RULES — the "&${$('r_incomeYear')}&" figures are provisional and may change. ","")&` +
      `IF(AND(${exampleTests.map((test) => test($)).join(',')}),` +
      `"EXAMPLE SHOWN — ${exampleWords}. Type over the cream cells with your own figures.",` +
      `IF(${$('w_exCount')}>0,"Still using the example's "&${$('w_exList')}&". Type your own over "&IF(${$('w_exCount')}=1,"it; leave it if it happens to be right for you.","them; leave any that happens to be right for you."),` +
      `"Your figures — results on the right update as you type. Read the Before You Transfer sheet before you move any money.")))`,
  );

  // ---- Results (right) --------------------------------------------------------------------------------------
  let q = 6;
  const sectionR = (title: string | F): void => {
    mergeRow(ws, q, 6, 8, ST.section());
    if (typeof title === 'string') ws.getCell(q, 6).value = title;
    else b.f(ws, 6, q, title);
    q++;
  };
  const result = (
    name: string,
    label: string,
    source: F,
    valueStyle: Style,
    note: Note = '',
    labelStyle: Style = ST.label(),
    noteStyle: Style = ST.note(),
    noteChars = 0,
  ): void => {
    // The row is shared with an input on the left: tall enough for whichever needs more.
    const needed = heightFor(typeof note === 'string' ? note.length : noteChars, WIDTHS[7] ?? 50, 9);
    ws.getRow(q).height = Math.max(ws.getRow(q).height ?? 0, 20, needed);
    b.v(ws, 6, q, label, labelStyle);
    b.f(ws, 7, q, source, valueStyle);
    if (typeof note === 'string') b.v(ws, 8, q, note, noteStyle);
    else b.f(ws, 8, q, note, noteStyle);
    b.reg(name, ws, 7, q);
    b.define(name, name);
    q++;
  };
  const roomNote =
    (lever: string, extra: F) =>
    ($: Resolver): string =>
      `IF(${$(`w_eligible_${lever}`)}=0,"Not open to you.",IF(${$(`w_enabled_${lever}`)}=0,"Switched off on the left.",${extra($)}))`;
  const ofRoom = (lever: string, $: Resolver): string => `"of S$"&TEXT(${$(`w_room_${lever}`)},"#,##0")&" of room left this year."`;

  sectionR(($) => `IF(${$('m_days')}<0,"What the plan for "&${$('r_incomeYear')}&" would have been","Recommended for "&${$('r_incomeYear')})`);
  // The recommendation as a sentence, in the page's words.
  for (let row = q; row <= q + 2; row++) {
    for (let col = 6; col <= 8; col++) {
      ws.getCell(row, col).style = {
        font: { name: 'Calibri', size: 12, bold: true, color: { argb: C.slate } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: C.panel } },
        alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true },
      };
    }
  }
  ws.mergeCells(q, 6, q + 2, 8);
  b.f(ws, 6, q, ($) => $('w_headline'));
  b.reg('out_headline', ws, 6, q);
  b.define('out_headline', 'out_headline');
  q += 3;
  result('out_srs', LEVER_NAMES.srs, ($) => $('w_plan_srs'), ST.hero(NF.dollars), roomNote('srs', ($) => ofRoom('srs', $)), ST.heroLabel(), ST.heroNote());
  result(
    'out_cpfSelf',
    LEVER_NAMES.cpfSelf,
    ($) => $('w_plan_cpfSelf'),
    ST.hero(NF.dollars),
    roomNote(
      'cpfSelf',
      ($) =>
        `IF(AND(${$('u_age')}>=${RETIREMENT_ACCOUNT_AGE},${$('u_selfLimitOn')}=0),"Left out until you enter the top-up that can still earn relief (on the left).",` +
        `${ofRoom('cpfSelf', $)}&" A cash top-up to your Special or Retirement Account, or MediSave.")`,
    ),
    ST.heroLabel(),
    ST.heroNote(),
    105,
  );
  result(
    'out_cpfFamily',
    LEVER_NAMES.cpfFamily,
    ($) => $('w_plan_cpfFamily'),
    ST.hero(NF.dollars),
    roomNote('cpfFamily', ($) => `${ofRoom('cpfFamily', $)}&" A cash top-up, beyond any part the Government matches."`),
    ST.heroLabel(),
    ST.heroNote(),
    95,
  );
  result(
    'out_total',
    'Total cash to lock away',
    ($) => $('w_X'),
    ST.total(NF.dollars),
    ($) =>
      `IF(${$('m_days')}<0,"The deadline has passed.","To arrive by "&${longDate($, $('m_deadline'))}&": "&${$('m_days')}&IF(${$('m_days')}=1," day"," days")&" left.")`,
    ST.total(undefined, 'left'),
    { ...ST.total(undefined, 'left'), font: ST.note().font },
  );
  // How long it is locked away, for the schemes in the plan, then the condition on the SRS age (SPEC §8.4): the
  // page's lines and the sentence it puts straight after them. Room for three lines of text over two sheet rows.
  for (let row = q; row < q + HORIZON_ROWS; row++) {
    for (let col = 6; col <= 8; col++) {
      ws.getCell(row, col).style = { ...ST.note(), font: { ...ST.note().font, size: HORIZON_FONT, color: { argb: C.ink } } };
    }
    ws.getRow(row).height = Math.max(ws.getRow(row).height ?? 0, HORIZON_ROW_HEIGHT);
  }
  ws.mergeCells(q, 6, q + HORIZON_ROWS - 1, 8);
  b.f(ws, 6, q, ($) => `${$('w_horizon')}&IF(${$('w_horizonNote')}="",""," "&${$('w_horizonNote')})`);
  b.reg('out_horizon', ws, 6, q);
  b.define('out_horizon', 'out_horizon');
  q += HORIZON_ROWS;

  sectionR('What it does to your tax bill');
  result('out_taxBefore', 'Tax without any more contributions', ($) => $('w_base_tax'), ST.value(NF.tax), ($) => `"On chargeable income of S$"&TEXT(${$('w_base_ci')},"#,##0")&"."`);
  result('out_taxAfter', 'Tax with the plan', ($) => $('w_opt_tax'), ST.value(NF.tax), ($) => `"On chargeable income of S$"&TEXT(${$('w_opt_ci')},"#,##0")&"."`);
  result(
    'out_taxSaved',
    'Tax saved',
    ($) => $('w_taxSaved'),
    ST.hero(NF.tax, C.good),
    ($) => `IF(${$('w_X')}=0,"",${centsNumber($('w_savingRate'))}&" cents back for every dollar you lock away.")`,
    ST.heroLabel(),
    ST.heroNote(),
  );
  result(
    'out_savingRate',
    'Saving per dollar locked away',
    ($) => $('w_savingRate'),
    ST.value(NF.rate),
    'Tax saved this year / cash locked away. For SRS, half of what you later withdraw is taxable.',
  );

  sectionR('Why the plan stops here');
  for (let row = q; row <= q + 1; row++) {
    for (let col = 6; col <= 8; col++) {
      ws.getCell(row, col).style = { ...ST.text(), alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true } };
    }
  }
  ws.mergeCells(q, 6, q + 1, 8);
  b.f(ws, 6, q, ($) => $('w_reasonText'));
  b.reg('out_reason', ws, 6, q);
  b.define('out_reason', 'out_reason');
  q += 2;

  // The cautions sit with the recommendation, not further down (SPEC §8.4).
  sectionR('Things to check before you transfer');
  const warnTop = q;
  const lineStyle: Style = {
    ...ST.note(),
    font: { ...ST.note().font, size: WARNING_FONT, color: { argb: C.ink } },
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true },
  };
  for (let k = 1; k <= WARNING_LINES; k++) {
    for (let row = q; row < q + WARNING_LINE_ROWS; row++) {
      for (let col = 6; col <= 8; col++) ws.getCell(row, col).style = lineStyle;
    }
    ws.mergeCells(q, 6, q + WARNING_LINE_ROWS - 1, 8);
    // Line k comes from the first check whose "lines so far" reaches k; a check with several lines gives them in turn.
    b.f(ws, 6, q, ($) => {
      const count = $('w_warnCount');
      const row = `COUNTIF(${count},"<${k}")+1`;
      return `IF(${k}>MAX(${count}),"",INDEX(${$('w_warnLines')},${row},${k}-INDEX(${count},${row})+INDEX(${$('w_warnLineCount')},${row})))`;
    });
    q += WARNING_LINE_ROWS;
  }
  b.regRange('out_warnings', ws, 6, warnTop, 6, q - 1);
  b.define('out_warnings', 'out_warnings');
  const lastRow = Math.max(lastInputRow, q - 1);
  // Every row a line spans is tall enough for its share of three lines of text, whatever sits to its left.
  for (let row = warnTop; row <= q - 1; row++) {
    ws.getRow(row).height = Math.max(ws.getRow(row).height ?? 0, WARNING_ROW_HEIGHT);
  }
  for (let row = 6; row < warnTop; row++) {
    if (!ws.getRow(row).height) ws.getRow(row).height = 20;
  }

  // Disclaimer under the inputs.
  const discRow = lastInputRow + 2;
  ws.mergeCells(discRow, 2, discRow + 2, 4);
  ws.getCell(discRow, 2).style = { ...ST.note(), alignment: { vertical: 'top', horizontal: 'left', indent: 1, wrapText: true } };
  ws.getCell(discRow, 2).value = DISCLAIMER;

  // Soft colour cues for the "Things to check" lines, by their opening word.
  ws.addConditionalFormatting({
    ref: `F${warnTop}:H${q - 1}`,
    rules: [
      {
        type: 'expression',
        priority: 1,
        formulae: [`LEFT($F${warnTop},5)="Check"`],
        style: { font: { color: { argb: C.warn } } },
      },
      {
        type: 'expression',
        priority: 2,
        formulae: [`LEFT($F${warnTop},8)="Too late"`],
        style: { font: { color: { argb: C.warn }, bold: true } },
      },
    ],
  });

  view(ws, 5, { selected: true, activeCell: 'C7' });
  // One page wide; a second page takes the "Things to check" lines that do not fit the first.
  pageSetup(ws, { landscape: true, lastCol: 'H', lastRow, titleRows: '1:5' });
  return ws;
}
