/**
 * The Planner sheet: inputs on the left, the recommendation on the right. Every figure on the right is a formula
 * that reads the Tax Working sheet; nothing is typed in.
 */
import type ExcelJS from 'exceljs';
import { Book, C, MAX_MONEY, NF, SHEETS, ST, longDate, mergeRow, pageSetup, setWidths, view } from '../kit';
import type { Resolver, Style } from '../kit';
import { MONTH_LABELS, NO, PRIORITY_PRESETS, PR_YEAR_LABELS, RESIDENCY_LABELS, YES } from './rules';

/** The worked example the workbook opens with (SPEC Appendix A.1). */
export const EXAMPLE = {
  residency: RESIDENCY_LABELS.citizen,
  prYear: PR_YEAR_LABELS[2],
  age: 35,
  birthMonth: MONTH_LABELS[11],
  monthlyWage: 10_000,
  monthsWorked: 12,
  additionalWages: 15_000,
  otherIncome: 0,
  employmentExpenses: 0,
  donations: 0,
  cpfOverride: null,
  existingSrs: 0,
  existingCpfSelf: 0,
  existingCpfFamily: 0,
  otherReliefs: 5_000,
  useSrs: YES,
  useCpfSelf: YES,
  cpfSelfRoom: null,
  useCpfFamily: NO,
  cpfFamilyMax: null,
  minSavingRate: 0.07,
  cashBudget: null,
  priority: PRIORITY_PRESETS[0]!.label,
  simulatorStep: 1_000,
} as const;

/** How many "Things to check" lines the Planner can show (one per warning code, SPEC §6.11). */
export const WARNING_LINES = 16;

type Note = string | (($: Resolver) => string);

export function buildPlanner(b: Book): ExcelJS.Worksheet {
  const ws = b.sheet(SHEETS.planner, C.slate);
  setWidths(ws, [2, 43, 19, 50, 3, 41, 19, 44]);
  const $ = b.resolver(ws);

  // ---- Heading ----------------------------------------------------------------------------------------------
  ws.getRow(1).height = 34;
  mergeRow(ws, 1, 2, 6, ST.title()).value = 'Singapore Tax Optimiser';
  mergeRow(ws, 1, 7, 8, ST.titleNote());
  b.f(ws, 7, 1, ($) => `"Year of Assessment "&${$('r_ya')}&" · estimate only, not tax advice"`);
  ws.getRow(2).height = 22;
  mergeRow(ws, 2, 2, 8, ST.subtitle());
  b.f(
    ws,
    2,
    2,
    ($) =>
      `"How much to put into SRS and CPF before the end of "&${$('r_incomeYear')}&" to cut your income tax. Fill in the cream cells; everything else updates by itself."`,
  );
  ws.getRow(3).height = 22;
  mergeRow(ws, 3, 2, 8, ST.banner());
  ws.getRow(4).height = 6;

  ws.getRow(5).height = 22;
  mergeRow(ws, 5, 2, 4, ST.block()).value = '1 · Your details';
  mergeRow(ws, 5, 6, 8, ST.block()).value = '2 · Your plan';

  // ---- Inputs (left) ----------------------------------------------------------------------------------------
  let r = 6;
  const exampleTests: Array<($: Resolver) => string> = [];

  const sectionL = (title: string | (($: Resolver) => string)): void => {
    mergeRow(ws, r, 2, 4, ST.section());
    if (typeof title === 'string') ws.getCell(r, 2).value = title;
    else b.f(ws, 2, r, title);
    ws.getRow(r).height = 19;
    r++;
  };

  const input = (
    name: string,
    label: string,
    value: ExcelJS.CellValue,
    style: Style,
    note: Note,
    validation: ExcelJS.DataValidation,
    options: { indent?: boolean; height?: number } = {},
  ): void => {
    ws.getRow(r).height = options.height ?? 20;
    b.v(ws, 2, r, label, options.indent ? ST.labelIndent() : ST.label());
    b.v(ws, 3, r, value, style);
    ws.getCell(r, 3).dataValidation = validation;
    if (typeof note === 'string') b.v(ws, 4, r, note, ST.note());
    else b.f(ws, 4, r, note, ST.note());
    b.reg(name, ws, 3, r);
    b.define(name, name);
    const example = value;
    exampleTests.push(($) =>
      example === null ? `${$(name)}=""` : typeof example === 'string' ? `${$(name)}="${example}"` : `${$(name)}=${String(example)}`,
    );
    r++;
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
    'For Singapore tax residents only.',
    list('l_residency', 'Residency', 'Citizens and PRs pay CPF and can top up CPF. Foreigners on work passes cannot, but have a higher SRS cap.'),
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
    '',
    EXAMPLE.age,
    ST.input(NF.plain),
    'The age you reach during the year.',
    whole(0, 120, 'Age', 'Your age on 31 December of the income year (the year minus your year of birth).'),
  );
  b.f(ws, 2, r - 1, ($) => `"Age on 31 December "&${$('r_incomeYear')}`);
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
  input(
    'in_monthlyWage',
    'Monthly salary (S$)',
    EXAMPLE.monthlyWage,
    ST.input(NF.int),
    'Gross basic pay plus fixed monthly allowances, before CPF.',
    money('Monthly salary', 'Your ordinary wage for one month, before CPF is taken off.'),
  );
  input(
    'in_monthsWorked',
    'Months worked in the year',
    EXAMPLE.monthsWorked,
    ST.input(NF.plain),
    '1 to 12. Part-years are counted as the last months of the year.',
    whole(1, 12, 'Months worked', 'How many months you are paid for in the income year, 1 to 12.'),
  );
  input(
    'in_additionalWages',
    'Bonus and other additional wages for the year (S$)',
    EXAMPLE.additionalWages,
    ST.input(NF.int),
    'Bonus, 13th month, commissions and incentives, in total.',
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
    'Leave blank and it is worked out from your pay. Fill in to use the figure on your payslips or CPF statement.',
    money('Actual employee CPF', 'Optional. Your own compulsory contributions for the whole year. Leave blank to have them calculated.'),
    { indent: true, height: 26 },
  );

  sectionL(($) => `"Already contributed in "&${$('r_incomeYear')}`);
  input(
    'in_existingSrs',
    'SRS (S$)',
    EXAMPLE.existingSrs,
    ST.input(NF.int),
    'What you have already put in this year. The plan only recommends the rest.',
    money('SRS so far', 'SRS contributions already made in the income year.'),
  );
  input(
    'in_existingCpfSelf',
    'CPF cash top-up to yourself (S$)',
    EXAMPLE.existingCpfSelf,
    ST.input(NF.int),
    'Cash top-ups to your own Special, Retirement or MediSave Account.',
    money('CPF top-ups to yourself so far', 'Cash top-ups already made to your own accounts in the income year.'),
  );
  input(
    'in_existingCpfFamily',
    'CPF cash top-up to family (S$)',
    EXAMPLE.existingCpfFamily,
    ST.input(NF.int),
    'Cash top-ups to parents, grandparents, in-laws, or a low-income spouse or sibling.',
    money('CPF top-ups to family so far', 'Cash top-ups already made to eligible family members in the income year.'),
  );

  sectionL('Other reliefs');
  input(
    'in_otherReliefs',
    'Total of your other reliefs (S$)',
    EXAMPLE.otherReliefs,
    ST.input(NF.int),
    'Spouse, child, parent, NSman and so on (amounts are listed on the Rules sheet). Leave out CPF, SRS, top-ups and Earned Income Relief.',
    money('Other reliefs', 'The total of every other personal relief you expect. Do not include CPF, SRS, CPF top-ups or Earned Income Relief; those are worked out for you.'),
    { height: 26 },
  );

  sectionL('Your preferences');
  input(
    'in_useSrs',
    'Use SRS?',
    EXAMPLE.useSrs,
    ST.input(undefined, 'center'),
    ($) =>
      `"Up to S$"&TEXT(IF(${$('u_res')}=3,${$('r_srsCapForeigner')},${$('r_srsCapCitizenPr')}),"#,##0")&" a year. Locked until retirement age; early withdrawals are taxed with a 5% penalty."`,
    list('l_yesNo', 'Use SRS?', 'Choose No to leave SRS out of the plan.'),
    { height: 26 },
  );
  input(
    'in_useCpfSelf',
    'Use CPF cash top-ups to yourself?',
    EXAMPLE.useCpfSelf,
    ST.input(undefined, 'center'),
    ($) => `"Up to S$"&TEXT(${$('r_selfCap')},"#,##0")&" a year earns relief. CPF top-ups cannot be reversed."`,
    list('l_yesNo', 'Use CPF top-ups to yourself?', 'Citizens and PRs only. Choose No to leave them out of the plan.'),
  );
  input(
    'in_cpfSelfRoom',
    'Room left before your CPF limits (S$, optional)',
    EXAMPLE.cpfSelfRoom,
    ST.input(NF.int),
    'How much you can still top up before the Full Retirement Sum and Basic Healthcare Sum. Blank = plenty of room.',
    money('Room left in your CPF accounts', 'Optional. Top-ups above the Full Retirement Sum (Special/Retirement Account) or Basic Healthcare Sum (MediSave) earn no relief.'),
    { indent: true, height: 26 },
  );
  input(
    'in_useCpfFamily',
    'Use CPF cash top-ups to family?',
    EXAMPLE.useCpfFamily,
    ST.input(undefined, 'center'),
    ($) => `"Up to S$"&TEXT(${$('r_famCap')},"#,##0")&" a year earns relief. It is a gift: the money becomes theirs."`,
    list('l_yesNo', 'Use CPF top-ups to family?', 'Choose Yes only if you have an eligible family member with a CPF account.'),
  );
  input(
    'in_cpfFamilyMax',
    'Most you would give to family (S$, optional)',
    EXAMPLE.cpfFamilyMax,
    ST.input(NF.int),
    'Blank = up to the relief cap.',
    money('Most you would give', 'Optional. The plan will not recommend more than this for family members.'),
    { indent: true },
  );
  input(
    'in_minSavingRate',
    'Smallest tax saving per dollar worth locking money away for',
    EXAMPLE.minSavingRate,
    ST.input(NF.minRate),
    'The plan only uses dollars that save at least this much tax each. Choose "Any saving" to chase every tax dollar.',
    {
      type: 'list',
      allowBlank: false,
      formulae: [$('l_minRate')],
      showErrorMessage: true,
      errorStyle: 'stop',
      errorTitle: 'Pick from the list',
      error: 'Choose one of the tax rates in the dropdown.',
      showInputMessage: true,
      promptTitle: 'How far down the ladder?',
      prompt: 'Each extra dollar saves tax at your top rate first, then at lower rates. 7% is a sensible minimum for money you cannot touch for years.',
    },
    { height: 26 },
  );
  input(
    'in_cashBudget',
    'Most cash you can lock away this year (S$, optional)',
    EXAMPLE.cashBudget,
    ST.input(NF.int),
    'Blank = no limit.',
    money('Cash limit', 'Optional. The plan will fit inside this amount.'),
  );
  input(
    'in_priority',
    'Which scheme first?',
    EXAMPLE.priority,
    ST.input(undefined, 'left'),
    ($) => `INDEX(${$('l_priorityText')},${$('u_preset')})`,
    list('l_priority', 'Which scheme first?', 'The order does not change the tax saved, only where the money goes.'),
    { height: 26 },
  );
  const lastInputRow = r - 1;

  // The banner says "example" only while the cream cells still hold the worked example.
  b.f(
    ws,
    2,
    3,
    ($) =>
      `IF(AND(${exampleTests.map((test) => test($)).join(',')}),` +
      `"EXAMPLE SHOWN — age 35, S$10,000 a month, S$15,000 bonus, S$5,000 other reliefs. Type over the cream cells with your own figures.",` +
      `"Your figures — results on the right update as you type. Other sheets show the ladder, comparisons, a monthly plan and the full working.")`,
  );

  // ---- Results (right) --------------------------------------------------------------------------------------
  let q = 6;
  const sectionR = (title: string | (($: Resolver) => string)): void => {
    mergeRow(ws, q, 6, 8, ST.section());
    if (typeof title === 'string') ws.getCell(q, 6).value = title;
    else b.f(ws, 6, q, title);
    q++;
  };
  const result = (
    name: string,
    label: string,
    source: ($: Resolver) => string,
    valueStyle: Style,
    note: Note = '',
    labelStyle: Style = ST.label(),
    noteStyle: Style = ST.note(),
  ): void => {
    b.v(ws, 6, q, label, labelStyle);
    b.f(ws, 7, q, source, valueStyle);
    if (typeof note === 'string') b.v(ws, 8, q, note, noteStyle);
    else b.f(ws, 8, q, note, noteStyle);
    b.reg(name, ws, 7, q);
    b.define(name, name);
    q++;
  };
  const roomNote =
    (lever: string, what: string) =>
    ($: Resolver): string =>
      `IF(${$(`w_eligible_${lever}`)}=0,"Not available to you.",IF(${$(`w_enabled_${lever}`)}=0,"Switched off on the left.","of S$"&TEXT(${$(`w_room_${lever}`)},"#,##0")&" ${what}"))`;

  sectionR(($) => `"Recommended extra contributions for "&${$('r_incomeYear')}`);
  result('out_srs', 'Put into SRS', ($) => $('w_plan_srs'), ST.hero(NF.dollars), roomNote('srs', 'of room left this year'), ST.heroLabel(), ST.heroNote());
  result('out_cpfSelf', 'Top up your own CPF (cash)', ($) => $('w_plan_cpfSelf'), ST.hero(NF.dollars), roomNote('cpfSelf', 'of room left this year'), ST.heroLabel(), ST.heroNote());
  result('out_cpfFamily', "Top up family members' CPF (cash)", ($) => $('w_plan_cpfFamily'), ST.hero(NF.dollars), roomNote('cpfFamily', 'of room left this year'), ST.heroLabel(), ST.heroNote());
  result(
    'out_total',
    'Total cash to lock away',
    ($) => $('w_X'),
    ST.total(NF.dollars),
    ($) => `IF(${$('m_days')}<0,"The deadline has passed.","Transfer by "&${longDate($, $('r_deadline'))}&"; banks may cut off earlier.")`,
    ST.total(undefined, 'left'),
    { ...ST.total(undefined, 'left'), font: ST.note().font },
  );

  sectionR('What it does to your tax bill');
  result('out_taxBefore', 'Tax without any more contributions', ($) => $('w_base_tax'), ST.value(NF.tax), ($) => `"On chargeable income of S$"&TEXT(${$('w_base_ci')},"#,##0")&"."`);
  result('out_taxAfter', 'Tax with the plan', ($) => $('w_opt_tax'), ST.value(NF.tax), ($) => `"On chargeable income of S$"&TEXT(${$('w_opt_ci')},"#,##0")&"."`);
  result(
    'out_taxSaved',
    'Tax saved',
    ($) => $('w_taxSaved'),
    ST.hero(NF.tax, C.good),
    ($) => `IF(${$('w_X')}=0,"",ROUND(${$('w_savingRate')}*1000,0)/10&" cents back for every dollar you lock away.")`,
    ST.heroLabel(),
    ST.heroNote(),
  );
  result('out_savingRate', 'Saving per dollar locked away', ($) => $('w_savingRate'), ST.value(NF.pct), 'Tax saved ÷ cash locked away: an immediate return.');

  sectionR('Why the plan stops here');
  for (let row = q; row <= q + 1; row++) {
    ws.getRow(row).height = Math.max(ws.getRow(row).height ?? 0, 26);
    for (let col = 6; col <= 8; col++) {
      ws.getCell(row, col).style = { ...ST.text(), alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true } };
    }
  }
  ws.mergeCells(q, 6, q + 1, 8);
  b.f(ws, 6, q, ($) => $('w_reasonText'));
  b.reg('out_reason', ws, 6, q);
  b.define('out_reason', 'out_reason');
  q += 2;

  sectionR('More detail');
  result('out_ciBefore', 'Chargeable income before', ($) => $('w_base_ci'), ST.value(NF.dollars), 'Income less deductions and reliefs: what tax is charged on.');
  result('out_ciAfter', 'Chargeable income after the plan', ($) => $('w_opt_ci'), ST.value(NF.dollars));
  result('out_marginalBefore', 'Tax rate on your top dollar, before', ($) => $('w_base_marginal'), ST.value(NF.pct), 'What the next dollar of relief saves.');
  result('out_marginalAfter', 'Tax rate on your top dollar, after', ($) => $('w_opt_marginal'), ST.value(NF.pct));
  result(
    'out_unrealisedSaving',
    'Further saving out of reach',
    ($) => $('w_unrealised'),
    ST.value(NF.tax),
    'What more room in the schemes, or more cash, could still save at or above your minimum.',
  );
  result('out_reliefCapRoom', 'Room left under the overall relief cap', ($) => $('w_C'), ST.value(NF.dollars), ($) => `"Before the plan. The cap is S$"&TEXT(${$('r_reliefCap')},"#,##0")&" a year."`);
  result('out_monthsRemaining', 'Months left to contribute', ($) => $('m_monthsRemaining'), ST.value(NF.plain), 'Counting this month. See the Monthly Plan sheet.');
  result('out_daysToDeadline', 'Days to the deadline', ($) => $('m_days'), ST.value(NF.int), ($) => `"As at the date on the Monthly Plan sheet."`);

  sectionR('Things to check');
  const warnTop = q;
  for (let k = 1; k <= WARNING_LINES; k++) {
    ws.getRow(q).height = Math.max(ws.getRow(q).height ?? 0, 30);
    mergeRow(ws, q, 6, 8, {
      ...ST.note(),
      font: { ...ST.note().font, size: 10, color: { argb: C.ink } },
      alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true },
    });
    b.f(ws, 6, q, ($) => `IFERROR(INDEX(${$('w_warnText')},MATCH(${k},${$('w_warnCount')},0)),"")`);
    q++;
  }
  b.regRange('out_warnings', ws, 6, warnTop, 6, q - 1);
  b.define('out_warnings', 'out_warnings');

  const lastRow = Math.max(lastInputRow, q - 1);
  // Disclaimer under the inputs.
  const discRow = lastInputRow + 2;
  ws.mergeCells(discRow, 2, discRow + 3, 4);
  ws.getCell(discRow, 2).style = { ...ST.note(), alignment: { vertical: 'top', horizontal: 'left', indent: 1, wrapText: true } };
  ws.getCell(discRow, 2).value =
    'This is an estimate for planning, not tax, legal or financial advice. It is not affiliated with IRAS or the CPF Board. ' +
    'Check your eligibility and limits with IRAS, the CPF Board and your SRS bank before transferring money. CPF top-ups cannot be reversed.';

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
  pageSetup(ws, { landscape: true, lastCol: 'H', lastRow });
  return ws;
}
