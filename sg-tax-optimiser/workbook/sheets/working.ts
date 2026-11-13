/**
 * The Tax Working sheet: the whole model of SPEC §6 as live formulas — inputs as used (§6.0), employee CPF
 * (§6.1), income, reliefs and tax before and after the plan (§6.2–§6.4), the schemes' room (§6.5), the optimiser
 * (§6.6) and the checks behind the Planner's warnings (§6.11).
 */
import type ExcelJS from 'exceljs';
import {
  Book,
  C,
  NF,
  SHEETS,
  ST,
  dollarsText,
  floorRateTimes,
  grossTax,
  lit,
  longDate,
  marginalRate,
  mergeRow,
  moneyOf,
  pageSetup,
  rateNumber,
  rebateCents,
  setWidths,
  styleRow,
  taxPayable,
  taxText,
  usefulRoom,
  view,
} from '../kit';
import type { Resolver, Style } from '../kit';
import { MONTH_LABELS, YES } from './rules';

type F = ($: Resolver) => string;

const LEVERS = [
  { id: 'srs', title: 'SRS', col: 3 },
  { id: 'cpfSelf', title: 'CPF top-up — self', col: 4 },
  { id: 'cpfFamily', title: 'CPF top-up — family', col: 5 },
] as const;

/** Warning codes in the order of SPEC §6.11. */
export const WARNING_CODES = [
  'NO_TAX_PAYABLE',
  'RELIEF_CAP_EXCEEDED_BASELINE',
  'RELIEF_CAP_LIMITS_PLAN',
  'BELOW_MIN_SAVING_RATE',
  'BUDGET_LIMITS_PLAN',
  'LEVER_LIMITS_PLAN',
  'EXISTING_EXCEEDS_CAP',
  'CPF_OVERRIDE_ABOVE_MAX',
  'FOREIGNER_NO_CPF',
  'PR_GRADUATED_RATES',
  'AGE_55_PLUS_TOPUP',
  'SRS_UNDER_18',
  'DEADLINE_PASSED',
  'DEADLINE_SOON',
  'PROJECTED_RULES',
  'PIT_REBATE_APPLIED',
] as const;

export function buildWorking(b: Book): ExcelJS.Worksheet {
  const rules = b.rules;
  const ws = b.sheet(SHEETS.working, C.slateSoft);
  setWidths(ws, [2, 58, 17, 17, 17, 17, 17, 17, 17, 3]);
  const LAST = 9;

  let r = 1;
  ws.getRow(r).height = 32;
  mergeRow(ws, r, 2, LAST, ST.title()).value = 'How your tax is worked out';
  r++;
  ws.getRow(r).height = 34;
  mergeRow(ws, r, 2, LAST, ST.subtitle()).value =
    'Every step from your pay to your tax bill, before and after the recommended plan, followed by the working behind it: ' +
    'tax by bracket, your CPF contributions, the room in each scheme and how the plan total is chosen. All of it is formulas.';
  r += 2;

  const section = (title: string): void => {
    mergeRow(ws, r, 2, LAST, ST.block()).value = title;
    ws.getRow(r).height = 22;
    r++;
  };
  const sub = (title: string): void => {
    mergeRow(ws, r, 2, LAST, ST.section()).value = title;
    r++;
  };
  /** One "label | value | note" row; registers `key` on the value cell. */
  const line = (key: string, label: string, formula: F, style: Style, note = '', labelStyle: Style = ST.label()): number => {
    b.v(ws, 2, r, label, labelStyle);
    b.f(ws, 3, r, formula, style);
    b.reg(key, ws, 3, r);
    if (note) b.v(ws, 4, r, note, ST.noteRun());
    return r++;
  };

  // ======================================================================================================
  // 1. The tax computation, before and after
  // ======================================================================================================
  section('1 · Your tax computation');
  b.v(ws, 2, r, 'S$', ST.th('left'));
  b.v(ws, 3, r, 'Before the plan', ST.th());
  b.v(ws, 4, r, 'After the plan', ST.th());
  styleRow(ws, r, 5, LAST, ST.th('left'));
  r++;

  /**
   * A row with a "before" (column C) and an "after" (column D) value. `after` defaults to the same formula
   * with column D; pass 'same' when the plan cannot change the figure (D simply repeats C).
   */
  const pair = (
    key: string,
    label: string,
    before: (col: string, $: Resolver) => string,
    after: ((col: string, $: Resolver) => string) | 'same' | undefined,
    numFmt: string,
    options: { note?: string; bold?: boolean; indent?: boolean } = {},
  ): number => {
    const row = r;
    const labelStyle = options.bold ? ST.total(undefined, 'left') : options.indent ? ST.labelIndent() : ST.label();
    const valueStyle = options.bold ? ST.total(numFmt) : ST.value(numFmt);
    b.v(ws, 2, row, label, labelStyle);
    b.f(ws, 3, row, ($) => before('C', $), valueStyle);
    b.f(ws, 4, row, ($) => (after === 'same' ? `C${row}` : (after ?? before)('D', $)), valueStyle);
    b.reg(`w_base_${key}`, ws, 3, row);
    b.reg(`w_opt_${key}`, ws, 4, row);
    if (options.bold) styleRow(ws, row, 5, LAST, ST.total(undefined, 'left'));
    if (options.note) b.v(ws, 5, row, options.note, options.bold ? { ...ST.total(undefined, 'left'), font: ST.note().font } : ST.noteRun());
    r++;
    return row;
  };

  sub('Income');
  const rSalary = pair('salary', 'Salary for the year (monthly salary × months worked)', (_c, $) => `${$('u_ow')}*${$('u_months')}`, 'same', NF.int);
  const rBonus = pair('bonus', 'Bonus and other additional wages', (_c, $) => $('u_aw'), 'same', NF.int);
  const rEmp = pair('employment', 'Employment income', (c) => `${c}${rSalary}+${c}${rBonus}`, undefined, NF.int, { bold: true });
  const rExp = pair('expenses', 'Less: employment expenses', (_c, $) => $('u_expenses'), 'same', NF.int, { indent: true });
  const rOther = pair('otherIncome', 'Add: other taxable income', (_c, $) => $('u_otherIncome'), 'same', NF.int, { indent: true });
  const rTotal = pair('totalIncome', 'Total income', (c) => `MAX(0,${c}${rEmp}-${c}${rExp})+${c}${rOther}`, undefined, NF.int, { bold: true });
  const rDon = pair(
    'donationDeduction',
    'Less: deduction for donations',
    (_c, $) => `ROUND(${$('u_donations')}*${$('r_donationMultiplier')},2)`,
    'same',
    NF.cents,
    { indent: true, note: 'Donations × the deduction multiplier on the Rules sheet.' },
  );
  const rAssess = pair('assessable', 'Assessable income', (c) => `MAX(0,ROUND(${c}${rTotal}-${c}${rDon},2))`, undefined, NF.cents, { bold: true });

  sub('Personal reliefs');
  const rEir = pair(
    'eir',
    'Earned Income Relief',
    (c, $) =>
      `MIN(IF(${$('u_age')}<55,${$('r_eirBelow55')},IF(${$('u_age')}<=59,${$('r_eir55to59')},${$('r_eir60plus')})),MAX(0,${c}${rEmp}-${c}${rExp}))`,
    undefined,
    NF.int,
    { note: 'By age on 31 December; never more than your earned income.' },
  );
  pair('cpf', 'CPF relief (your compulsory employee contributions)', (_c, $) => $('w_employeeCpf'), 'same', NF.int, { note: 'Worked out in section 3 below.' });
  pair(
    'srs',
    'SRS relief',
    (_c, $) => `MIN(${$('u_exSrs')},${$('w_cap_srs')})`,
    (_c, $) => `MIN(${$('u_exSrs')}+${$('w_plan_srs')},${$('w_cap_srs')})`,
    NF.int,
    { note: 'Already contributed, plus the plan; never more than the scheme cap.' },
  );
  pair(
    'cpfSelf',
    'CPF cash top-up relief — yourself',
    (_c, $) => `MIN(${$('u_exSelf')},${$('w_cap_cpfSelf')})`,
    (_c, $) => `MIN(${$('u_exSelf')}+${$('w_plan_cpfSelf')},${$('w_cap_cpfSelf')})`,
    NF.int,
  );
  pair(
    'cpfFamily',
    'CPF cash top-up relief — family',
    (_c, $) => `MIN(${$('u_exFam')},${$('w_cap_cpfFamily')})`,
    (_c, $) => `MIN(${$('u_exFam')}+${$('w_plan_cpfFamily')},${$('w_cap_cpfFamily')})`,
    NF.int,
  );
  const rOtherRel = pair('other', 'Other reliefs', (_c, $) => $('u_otherReliefs'), 'same', NF.int);
  const rTbc = pair('totalBeforeCap', 'Total reliefs before the cap', (c) => `SUM(${c}${rEir}:${c}${rOtherRel})`, undefined, NF.int, { bold: true });
  const rAllowed = pair('totalAllowed', 'Reliefs allowed (the overall cap applies)', (c, $) => `MIN(${c}${rTbc},${$('r_reliefCap')})`, undefined, NF.int, { bold: true });
  pair('lostToCap', 'Reliefs lost to the cap', (c) => `${c}${rTbc}-${c}${rAllowed}`, undefined, NF.int, { indent: true });

  sub('Tax');
  const rCi = pair(
    'ci',
    'Chargeable income (assessable income less reliefs, cents dropped)',
    (c) => `INT(ROUND(MAX(0,${c}${rAssess}-${c}${rAllowed}),2))`,
    undefined,
    NF.int,
    { bold: true },
  );
  const rGross = pair('gross', 'Tax on chargeable income', (c, $) => grossTax($, `${c}${rCi}`), undefined, NF.cents, { note: 'Bracket by bracket in section 2; rounded to cents once.' });
  pair('rebate', 'Less: personal income tax rebate', (c, $) => `${rebateCents($, `ROUND(${c}${rGross}*100,0)`)}/100`, undefined, NF.cents, { indent: true });
  const rTax = pair('tax', 'Tax payable', (c, $) => taxPayable($, `${c}${rCi}`), undefined, NF.cents, { bold: true });
  pair('marginal', 'Tax rate on your top dollar (marginal rate)', (c, $) => marginalRate($, `${c}${rCi}`), undefined, NF.pct, { note: 'What one more dollar of relief saves.' });
  pair('effective', 'Tax as a share of total income', (c) => `IF(${c}${rTotal}=0,0,${c}${rTax}/${c}${rTotal})`, undefined, '0.00%');
  b.v(ws, 2, r, 'Tax saved by the plan', ST.total(undefined, 'left'));
  styleRow(ws, r, 3, LAST, ST.total(NF.cents));
  b.f(ws, 4, r, () => `ROUND(C${rTax}-D${rTax},2)`, ST.total(NF.cents));
  b.reg('w_taxSaved', ws, 4, r);
  r++;
  b.v(ws, 2, r, 'Saving per dollar locked away', ST.labelIndent());
  b.f(ws, 4, r, ($) => `IF(${$('w_X')}=0,0,${$('w_taxSaved')}/${$('w_X')})`, ST.value(NF.pct));
  b.reg('w_savingRate', ws, 4, r);
  r += 2;

  // ======================================================================================================
  // 2. Tax by bracket
  // ======================================================================================================
  section('2 · Tax by bracket');
  ws.getRow(r).height = 30;
  b.v(ws, 2, r, 'Slice of chargeable income', ST.th('left'));
  b.v(ws, 3, r, 'From (S$)', ST.th());
  b.v(ws, 4, r, 'Up to (S$)', ST.th());
  b.v(ws, 5, r, 'Rate', ST.th());
  b.v(ws, 6, r, 'Before: income in this slice', ST.th());
  b.v(ws, 7, r, 'Before: tax', ST.th());
  b.v(ws, 8, r, 'After: income in this slice', ST.th());
  b.v(ws, 9, r, 'After: tax', ST.th());
  r++;
  const brTop = r;
  rules.taxBrackets.forEach((_bracket, index) => {
    const row = r;
    const k = index + 1;
    b.f(
      ws,
      2,
      row,
      () => `IF(D${row}="","Above S$"&TEXT(C${row},"#,##0"),"S$"&TEXT(C${row},"#,##0")&" to S$"&TEXT(D${row},"#,##0"))`,
      ST.td(undefined, 'left'),
    );
    b.f(ws, 3, row, ($) => $(`r_from_${k}`), ST.td(NF.int));
    b.f(ws, 4, row, ($) => `IF(ISNUMBER(${$(`r_to_${k}`)}),${$(`r_to_${k}`)},"")`, ST.td(NF.int));
    b.f(ws, 5, row, ($) => $(`r_rate_${k}`), ST.td(NF.pct));
    b.f(ws, 6, row, ($) => `MAX(0,IF(D${row}="",${$('w_base_ci')},MIN(${$('w_base_ci')},D${row}))-C${row})`, ST.td(NF.int));
    b.f(ws, 7, row, () => `F${row}*E${row}`, ST.td(NF.cents));
    b.f(ws, 8, row, ($) => `MAX(0,IF(D${row}="",${$('w_opt_ci')},MIN(${$('w_opt_ci')},D${row}))-C${row})`, ST.td(NF.int));
    b.f(ws, 9, row, () => `H${row}*E${row}`, ST.td(NF.cents));
    r++;
  });
  const brEnd = r - 1;
  b.v(ws, 2, r, 'Total (tax rounded to cents once, on the whole sum)', ST.total(undefined, 'left'));
  styleRow(ws, r, 3, 5, ST.total());
  b.f(ws, 6, r, () => `SUM(F${brTop}:F${brEnd})`, ST.total(NF.int));
  b.f(ws, 7, r, ($) => $('w_base_gross'), ST.total(NF.cents));
  b.f(ws, 8, r, () => `SUM(H${brTop}:H${brEnd})`, ST.total(NF.int));
  b.f(ws, 9, r, ($) => $('w_opt_gross'), ST.total(NF.cents));
  r++;
  b.v(
    ws,
    2,
    r,
    'These rows mirror the bracket table on the Rules sheet. If you add or remove a bracket there, do the same here; the totals above always use the full Rules table.',
    ST.noteRun(),
  );
  r += 2;

  // ======================================================================================================
  // 3. Employee CPF
  // ======================================================================================================
  section('3 · Your compulsory CPF contributions (this is your CPF relief)');
  const bandCount = rules.cpf.fullRates.length;
  b.v(ws, 2, r, 'Rate table that applies to you', ST.label());
  b.f(ws, 3, r, ($) => `IF(${$('u_res')}=2,CHOOSE(${$('u_prYear')},2,3,1),1)`, ST.helper(NF.plain));
  b.reg('w_cpfTable', ws, 3, r);
  b.f(
    ws,
    4,
    r,
    ($) =>
      `IF(${$('u_res')}=3,"Foreigners on work passes make no CPF contributions.",CHOOSE(${$('w_cpfTable')},"Citizens, and PRs from their 3rd year","PRs in their 1st year (graduated rates)","PRs in their 2nd year (graduated rates)"))`,
    ST.noteRun(),
  );
  r++;
  b.v(ws, 2, r, 'Age band', ST.th('left'));
  b.v(ws, 3, r, 'Up to age', ST.th());
  b.v(ws, 4, r, 'Employee rate', ST.th());
  b.v(ws, 5, r, 'Phase-in factor', ST.th());
  r++;
  const effTop = r;
  for (let i = 1; i <= bandCount; i++) {
    const pick = (field: string) => ($: Resolver): string =>
      `CHOOSE(${$('w_cpfTable')},${$(`r_cpf1_${field}_${i}`)},${$(`r_cpf2_${field}_${i}`)},${$(`r_cpf3_${field}_${i}`)})`;
    b.f(ws, 2, r, pick('label'), ST.td(undefined, 'left'));
    b.f(ws, 3, r, ($) => `IF(ISNUMBER(${pick('max')($)}),${pick('max')($)},"")`, ST.td(NF.plain));
    b.f(ws, 4, r, pick('emp'), ST.td('0.0#%'));
    b.f(ws, 5, r, pick('phase'), ST.td(NF.factor));
    r++;
  }
  const effEnd = r - 1;
  b.regRange('w_effMax', ws, 3, effTop, 3, effEnd);
  b.regRange('w_effRate', ws, 4, effTop, 4, effEnd);
  b.regRange('w_effPhase', ws, 5, effTop, 5, effEnd);
  r++;

  ws.getRow(r).height = 30;
  b.v(ws, 2, r, 'Month', ST.th('left'));
  b.v(ws, 3, r, 'Worked?', ST.th());
  b.v(ws, 4, r, 'Age reached', ST.th());
  b.v(ws, 5, r, 'Age band (row above)', ST.th());
  b.v(ws, 6, r, 'Employee rate', ST.th());
  b.v(ws, 7, r, 'Salary that attracts CPF', ST.th());
  b.v(ws, 8, r, 'Your share (cents dropped)', ST.th());
  r++;
  const mTop = r;
  MONTH_LABELS.forEach((month, index) => {
    const row = r;
    const m = index + 1;
    b.v(ws, 2, row, month, ST.td(undefined, 'left'));
    b.f(ws, 3, row, ($) => `IF(${m}>=13-${$('u_months')},1,0)`, ST.td(NF.yesNo));
    b.f(ws, 4, row, ($) => `IF(${m}<=${$('u_birthMonth')},${$('u_age')}-1,${$('u_age')})`, ST.td(NF.plain));
    b.f(ws, 5, row, ($) => `MIN(${bandCount},1+COUNTIF(${$('w_effMax')},"<="&D${row}))`, ST.td(NF.plain));
    b.f(ws, 6, row, ($) => `IF(AND(C${row}=1,${$('u_res')}<>3),INDEX(${$('w_effRate')},E${row}),0)`, ST.td('0.0#%'));
    b.f(ws, 7, row, ($) => `IF(AND(C${row}=1,${$('u_res')}<>3),MIN(${$('u_ow')},${$('r_owCeiling')}),0)`, ST.td(NF.int));
    b.f(
      ws,
      8,
      row,
      ($) =>
        `IF(OR(C${row}=0,${$('u_res')}=3,${$('u_ow')}<=${$('r_nil')}),0,IF(${$('u_ow')}<=${$('r_phaseTo')},` +
        `${floorRateTimes(`INDEX(${$('w_effPhase')},E${row})`, `(${$('u_ow')}-${$('r_nil')})`)},` +
        `${floorRateTimes(`F${row}`, `G${row}`)}))`,
      ST.td(NF.int),
    );
    r++;
  });
  const mEnd = r - 1;
  b.reg('w_decRate', ws, 6, mEnd);
  b.regRange('w_monthRates', ws, 6, mTop, 6, mEnd);
  r++;
  line('w_owSubject', 'Salary that attracted CPF in the year', () => `SUM(G${mTop}:G${mEnd})`, ST.value(NF.int));
  line(
    'w_awCeiling',
    'Ceiling for bonus (annual wage ceiling less the line above)',
    ($) => `IF(${$('u_res')}=3,0,MAX(0,${$('r_annualCeiling')}-${$('w_owSubject')}))`,
    ST.value(NF.int),
  );
  line('w_awSubject', 'Bonus that attracts CPF', ($) => `MIN(${$('u_aw')},${$('w_awCeiling')})`, ST.value(NF.int));
  line('w_empOW', 'Your share on salary', () => `SUM(H${mTop}:H${mEnd})`, ST.value(NF.int));
  line(
    'w_empAW',
    'Your share on bonus (at the December rate)',
    ($) => floorRateTimes($('w_decRate'), $('w_awSubject')),
    ST.value(NF.int),
    'Bonus is treated as paid in December.',
  );
  line('w_cpfAuto', 'Worked-out employee CPF for the year', ($) => `${$('w_empOW')}+${$('w_empAW')}`, ST.value(NF.int));
  line(
    'w_maxCompulsory',
    'Largest compulsory employee contribution possible in a year',
    ($) => floorRateTimes($('r_cpf1_emp_1'), $('r_annualCeiling')),
    ST.value(NF.int),
  );
  line(
    'w_overrideShown',
    'Your own figure from the Planner, if you entered one',
    ($) => `IF(${$('u_overrideOn')}=1,${$('u_override')},"not entered")`,
    ST.value(NF.int),
    'Used instead of the worked-out figure, up to the largest possible contribution.',
  );
  b.v(ws, 2, r, 'Employee CPF used (your CPF relief)', ST.total(undefined, 'left'));
  styleRow(ws, r, 3, LAST, ST.total(undefined, 'left'));
  b.f(
    ws,
    3,
    r,
    ($) => `IF(${$('u_res')}=3,0,IF(${$('u_overrideOn')}=1,MIN(${$('u_override')},${$('w_maxCompulsory')}),${$('w_cpfAuto')}))`,
    ST.total(NF.int),
  );
  b.reg('w_employeeCpf', ws, 3, r);
  b.f(ws, 4, r, ($) => `IF(${$('u_res')}=3,"none",IF(${$('u_overrideOn')}=1,"override","auto"))`, { ...ST.total(undefined, 'left'), font: ST.helper().font });
  b.reg('w_cpfSource', ws, 4, r);
  r++;
  b.v(
    ws,
    2,
    r,
    'An approximation: real payslips combine salary and bonus in the month paid and can differ by a few dollars. Enter your actual figure on the Planner to be exact.',
    ST.noteRun(),
  );
  r += 2;

  // ======================================================================================================
  // 4. The schemes
  // ======================================================================================================
  section('4 · The three schemes: caps and room');
  b.v(ws, 2, r, '', ST.th('left'));
  for (const lever of LEVERS) b.v(ws, lever.col, r, lever.title, ST.th());
  r++;
  const leverRow = (
    keyPrefix: string,
    label: string,
    formula: (lever: (typeof LEVERS)[number], $: Resolver, col: string) => string,
    style: Style,
    note = '',
    bold = false,
  ): number => {
    const row = r;
    b.v(ws, 2, row, label, bold ? ST.total(undefined, 'left') : ST.label());
    for (const lever of LEVERS) {
      const col = String.fromCharCode(64 + lever.col);
      b.f(ws, lever.col, row, ($) => formula(lever, $, col), bold ? ST.total(style.numFmt) : style);
      b.reg(`${keyPrefix}_${lever.id}`, ws, lever.col, row);
    }
    b.regRange(`${keyPrefix}_all`, ws, LEVERS[0].col, row, LEVERS[2].col, row);
    if (bold) styleRow(ws, row, 6, LAST, ST.total(undefined, 'left'));
    if (note) b.v(ws, 6, row, note, bold ? { ...ST.total(undefined, 'left'), font: ST.note().font } : ST.noteRun());
    r++;
    return row;
  };
  const rElig = leverRow(
    'w_eligible',
    'Open to you?',
    (lever, $) =>
      lever.id === 'srs'
        ? `IF(${$('u_age')}>=${$('r_srsMinAge')},1,0)`
        : lever.id === 'cpfSelf'
          ? `IF(${$('u_res')}<=2,1,0)`
          : `IF(INDEX(${$('r_famGiver')},${$('u_res')})="${YES}",1,0)`,
    ST.value(NF.yesNo),
    'SRS: minimum age. CPF top-ups: Citizens and PRs (see the Rules sheet).',
  );
  const rEn = leverRow(
    'w_enabled',
    'Switched on in the Planner?',
    (lever, $) => $(lever.id === 'srs' ? 'u_enSrs' : lever.id === 'cpfSelf' ? 'u_enSelf' : 'u_enFam'),
    ST.value(NF.yesNo),
  );
  const rCap = leverRow(
    'w_cap',
    'Yearly cap on relief, for you',
    (lever, $, col) =>
      lever.id === 'srs'
        ? `IF(${col}${rElig}=1,IF(${$('u_res')}=3,${$('r_srsCapForeigner')},${$('r_srsCapCitizenPr')}),0)`
        : `IF(${col}${rElig}=1,${$(lever.id === 'cpfSelf' ? 'r_selfCap' : 'r_famCap')},0)`,
    ST.value(NF.int),
  );
  const rExist = leverRow(
    'w_existing',
    'Already contributed this year',
    (lever, $) => $(lever.id === 'srs' ? 'u_exSrs' : lever.id === 'cpfSelf' ? 'u_exSelf' : 'u_exFam'),
    ST.value(NF.int),
  );
  const rUsed = leverRow('w_used', '… of which counts for relief', (_lever, _$, col) => `MIN(${col}${rExist},${col}${rCap})`, ST.value(NF.int));
  leverRow(
    'w_limit',
    'Your own limit on further contributions',
    (lever, $) =>
      lever.id === 'srs'
        ? `"n/a"`
        : lever.id === 'cpfSelf'
          ? `IF(${$('u_selfLimitOn')}=1,${$('u_selfLimit')},"none")`
          : `IF(${$('u_famLimitOn')}=1,${$('u_famLimit')},"none")`,
    ST.value(NF.int),
    'Room before your CPF limits (self); the most you would give (family).',
  );
  const rRoomIf = leverRow(
    'w_roomIfOn',
    'Room left if switched on',
    (lever, $, col) => {
      const statutory = `MAX(0,${col}${rCap}-${col}${rUsed})`;
      if (lever.id === 'srs') return statutory;
      const on = $(lever.id === 'cpfSelf' ? 'u_selfLimitOn' : 'u_famLimitOn');
      const limit = $(lever.id === 'cpfSelf' ? 'u_selfLimit' : 'u_famLimit');
      return `IF(${on}=1,MIN(${statutory},${limit}),${statutory})`;
    },
    ST.value(NF.int),
  );
  const rRoom = leverRow(
    'w_room',
    'Room the plan can use',
    (_lever, _$, col) => `IF(AND(${col}${rElig}=1,${col}${rEn}=1),${col}${rRoomIf},0)`,
    ST.value(NF.int),
    'Zero when the scheme is switched off or not open to you.',
    true,
  );
  const rRank = leverRow(
    'w_rank',
    'Order it is filled in (1 = first)',
    (lever, $) => `INDEX(${$(`l_rank_${lever.id}`)},${$('u_preset')})`,
    ST.value(NF.plain),
    'From "Which scheme first?" on the Planner.',
  );
  const rAhead = leverRow(
    'w_ahead',
    'Room in the schemes filled before it',
    (_lever, _$, col) => `SUMPRODUCT(($C$${rRank}:$E$${rRank}<${col}${rRank})*$C$${rRoom}:$E$${rRoom})`,
    ST.value(NF.int),
  );
  leverRow(
    'w_plan',
    'Recommended extra contribution',
    (_lever, $, col) => `MIN(${col}${rRoom},MAX(0,${$('w_X')}-${col}${rAhead}))`,
    ST.value(NF.int),
    'Each scheme takes what is left of the plan total, up to its room.',
    true,
  );
  r++;

  // ======================================================================================================
  // 5. The optimiser
  // ======================================================================================================
  section('5 · How the plan total is chosen');
  b.v(
    ws,
    2,
    r,
    'Every relief dollar lowers chargeable income by one dollar whichever scheme it goes into, so the plan total is simply the smallest of four limits.',
    ST.noteRun(),
  );
  r++;
  line(
    'w_U',
    'U · dollars that would each save at least your minimum rate',
    ($) => usefulRoom($, $('w_base_ci'), $('u_minRate')),
    ST.value(NF.int),
    'Chargeable income above the start of the lowest bracket taxed at your minimum rate or more.',
  );
  line('w_C', 'C · room left under the overall relief cap', ($) => `MAX(0,${$('r_reliefCap')}-${$('w_base_totalBeforeCap')})`, ST.value(NF.int));
  line('w_L', 'L · room in the schemes you switched on', ($) => `SUM(${$('w_room_all')})`, ST.value(NF.int));
  line('w_B', 'B · your cash limit', ($) => `IF(${$('u_budgetOn')}=1,${$('u_budget')},"no limit")`, ST.value(NF.int));
  b.v(ws, 2, r, 'X · total extra contribution (the smallest of the four)', ST.total(undefined, 'left'));
  styleRow(ws, r, 3, LAST, ST.total(undefined, 'left'));
  b.f(
    ws,
    3,
    r,
    ($) => `MIN(${$('w_U')},${$('w_C')},${$('w_L')},IF(${$('u_budgetOn')}=1,${$('u_budget')},${$('w_L')}))`,
    ST.total(NF.int),
  );
  b.reg('w_X', ws, 3, r);
  r++;
  line(
    'w_binding',
    'Which limit stopped the plan',
    ($) =>
      `IF(${$('w_base_tax')}=0,"none",IF(${$('w_U')}<=${$('w_X')},"usefulRoom",IF(${$('w_C')}<=${$('w_X')},"reliefCap",IF(${$('w_L')}<=${$('w_X')},"leverLimits","cashBudget"))))`,
    ST.value(undefined),
    'Ties go to the first of: minimum rate, relief cap, scheme room, cash limit. "none" = no tax to save.',
  );
  line(
    'w_U0',
    'Dollars of relief before your income is tax-free',
    ($) => usefulRoom($, $('w_base_ci'), '0'),
    ST.value(NF.int),
    'Used on the Scenarios sheet to count wasted dollars.',
  );
  line(
    'w_ciFull',
    'Chargeable income if only your minimum rate and the relief cap limited you',
    ($) => `MAX(0,${$('w_base_ci')}-MIN(${$('w_U')},${$('w_C')}))`,
    ST.value(NF.int),
  );
  line('w_taxFull', '… and the tax payable then', ($) => taxPayable($, $('w_ciFull')), ST.value(NF.cents));
  line(
    'w_unrealised',
    'Further saving out of reach (needs more scheme room or cash)',
    ($) => `ROUND(${$('w_opt_tax')}-${$('w_taxFull')},2)`,
    ST.value(NF.cents),
  );
  line(
    'w_optBandFrom',
    'Start of the bracket your top dollar is in, after the plan',
    ($) => `SUMPRODUCT(MAX((${$('r_from')}<${$('w_opt_ci')})*${$('r_from')}))`,
    ST.value(NF.int),
  );
  b.v(ws, 2, r, 'In words (shown on the Planner)', ST.label());
  b.f(
    ws,
    3,
    r,
    ($) => {
      const X = $('w_X');
      const binding = $('w_binding');
      const optMarginal = $('w_opt_marginal');
      const more = (lead: string): string =>
        `IF(${$('w_unrealised')}>0," ${lead} you could save up to "&${taxText($('w_unrealised'))}&" more.","")`;
      return (
        `IF(${binding}="none",${lit('You have no tax to pay for this year, so contributing more would not save anything.')},` +
        `IF(${binding}="usefulRoom",IF(${X}=0,` +
        `"Nothing is recommended: each extra dollar would save "&${rateNumber($('w_base_marginal'))}&" cents or less, below the "&${rateNumber($('u_minRate'))}&" cents you asked for. Choose a lower minimum on the left to see the smaller savings.",` +
        `IF(${optMarginal}=0,${lit('The plan takes your chargeable income down to the tax-free band. Anything more would save no tax.')},` +
        `"Beyond this, each extra dollar would save "&${rateNumber(optMarginal)}&" cents or less, below the minimum you set.")),` +
        `IF(${binding}="reliefCap",IF(${X}=0,` +
        `"Your reliefs have already reached the "&${dollarsText($('r_reliefCap'))}&" overall cap, so further contributions would earn no tax relief.",` +
        `"The plan stops where your total reliefs reach the "&${dollarsText($('r_reliefCap'))}&" overall cap. Anything more would earn no tax relief and cannot be refunded."),` +
        `IF(${binding}="leverLimits",IF(${$('w_L')}=0,` +
        `${lit('The schemes you switched on have no room left this year, so nothing more can be contributed.')},` +
        `"You have used all the room in the schemes you switched on."&IF(${optMarginal}>0," "&${dollarsText(`(${$('w_opt_ci')}-${$('w_optBandFrom')})`)}&" of your income is still taxed at "&${rateNumber(optMarginal)}&"%.","")),` +
        `"Your cash limit of "&${dollarsText($('u_budget'))}&" is used up."&${more('With more cash')}))))`
      );
    },
    ST.noteRun(),
  );
  b.reg('w_reasonText', ws, 3, r);
  r += 2;

  // ======================================================================================================
  // 6. Inputs as used
  // ======================================================================================================
  section('6 · Your Planner entries as the formulas use them');
  b.v(
    ws,
    2,
    r,
    'Blanks, text and negative numbers count as 0, cents are dropped, and out-of-range entries are pulled back into range.',
    ST.noteRun(),
  );
  r++;
  const used = (key: string, label: string, formula: F, numFmt: string, note = ''): void => {
    line(key, label, formula, ST.value(numFmt), note);
  };
  const optional = (onKey: string, valueKey: string, label: string, inputKey: string): void => {
    used(onKey, `${label} — entered? (1 = yes)`, ($) => `IF(ISNUMBER(${$(inputKey)}),1,0)`, NF.plain);
    used(valueKey, `${label} — amount`, ($) => moneyOf($(inputKey)), NF.int);
  };
  used('u_res', 'Residency (1 Citizen, 2 PR, 3 foreigner)', ($) => `IFERROR(MATCH(${$('in_residency')},${$('l_residency')},0),1)`, NF.plain);
  used('u_prYear', 'PR year (3 = third year onwards)', ($) => `IF(${$('u_res')}=2,IFERROR(MATCH(${$('in_prYear')},${$('l_prYear')},0),3),3)`, NF.plain);
  used('u_age', 'Age on 31 December', ($) => `IF(ISNUMBER(${$('in_age')}),MIN(120,MAX(0,INT(${$('in_age')}))),0)`, NF.plain);
  used('u_birthMonth', 'Birth month (1–12)', ($) => `IFERROR(MATCH(${$('in_birthMonth')},${$('l_months')},0),12)`, NF.plain);
  used('u_ow', 'Monthly salary', ($) => moneyOf($('in_monthlyWage')), NF.int);
  used('u_months', 'Months worked (1–12)', ($) => `IF(ISNUMBER(${$('in_monthsWorked')}),MIN(12,MAX(1,INT(${$('in_monthsWorked')}))),12)`, NF.plain);
  used('u_aw', 'Bonus and other additional wages', ($) => moneyOf($('in_additionalWages')), NF.int);
  used('u_otherIncome', 'Other taxable income', ($) => moneyOf($('in_otherIncome')), NF.int);
  used('u_expenses', 'Employment expenses', ($) => moneyOf($('in_employmentExpenses')), NF.int);
  used('u_donations', 'Donations', ($) => moneyOf($('in_donations')), NF.int);
  optional('u_overrideOn', 'u_override', 'Actual employee CPF', 'in_cpfOverride');
  used('u_exSrs', 'Already in SRS', ($) => moneyOf($('in_existingSrs')), NF.int);
  used('u_exSelf', 'Already topped up — self', ($) => moneyOf($('in_existingCpfSelf')), NF.int);
  used('u_exFam', 'Already topped up — family', ($) => moneyOf($('in_existingCpfFamily')), NF.int);
  used('u_otherReliefs', 'Other reliefs', ($) => moneyOf($('in_otherReliefs')), NF.int);
  used('u_enSrs', 'Use SRS? (1 = yes)', ($) => `IF(${$('in_useSrs')}="${YES}",1,0)`, NF.plain);
  used('u_enSelf', 'Use CPF top-ups to yourself? (1 = yes)', ($) => `IF(${$('in_useCpfSelf')}="${YES}",1,0)`, NF.plain);
  used('u_enFam', 'Use CPF top-ups to family? (1 = yes)', ($) => `IF(${$('in_useCpfFamily')}="${YES}",1,0)`, NF.plain);
  optional('u_selfLimitOn', 'u_selfLimit', 'Room before your CPF limits', 'in_cpfSelfRoom');
  optional('u_famLimitOn', 'u_famLimit', 'Most you would give to family', 'in_cpfFamilyMax');
  used('u_minRate', 'Smallest saving per dollar worth it', ($) => `IF(ISNUMBER(${$('in_minSavingRate')}),MIN(1,MAX(0,${$('in_minSavingRate')})),0)`, NF.pct);
  optional('u_budgetOn', 'u_budget', 'Cash limit', 'in_cashBudget');
  used('u_preset', 'Which scheme first (row of the list on the Rules sheet)', ($) => `IFERROR(MATCH(${$('in_priority')},${$('l_priority')},0),1)`, NF.plain);
  used(
    'u_today',
    '"As at" date (Monthly Plan sheet)',
    ($) => `IF(ISNUMBER(${$('in_asAtDate')}),INT(${$('in_asAtDate')}),TODAY())`,
    NF.date,
    'Today, unless you typed another date on the Monthly Plan sheet.',
  );
  used('u_step', 'Simulator step', ($) => `IF(ISNUMBER(${$('in_simulatorStep')}),MAX(100,INT(${$('in_simulatorStep')})),1000)`, NF.int);
  r++;

  // ======================================================================================================
  // 7. Warnings
  // ======================================================================================================
  section('7 · The checks behind "Things to check" on the Planner');
  b.v(ws, 2, r, 'Code', ST.th('left'));
  b.v(ws, 3, r, 'Applies? (1 = yes)', ST.th());
  b.v(ws, 4, r, 'Running count', ST.th());
  b.v(ws, 5, r, 'Kind', ST.th('left'));
  b.v(ws, 6, r, 'Message (shown on the Planner when it applies)', ST.th('left'));
  styleRow(ws, r, 7, LAST, ST.th('left'));
  r++;
  const wTop = r;
  const cap = ($: Resolver): string => dollarsText($('r_reliefCap'));
  const moreSaving = ($: Resolver, lead: string): string =>
    `IF(${$('w_unrealised')}>0," ${lead} you could save up to "&${taxText($('w_unrealised'))}&" more tax.","")`;
  const overCap = (lever: string, $: Resolver): string =>
    `AND(${$(`w_cap_${lever}`)}>0,${$(`w_existing_${lever}`)}>${$(`w_cap_${lever}`)})`;
  const warnings: Record<(typeof WARNING_CODES)[number], { severity: 'info' | 'caution' | 'blocker'; when: F; text: F }> = {
    NO_TAX_PAYABLE: {
      severity: 'info',
      when: ($) => `${$('w_base_tax')}=0`,
      text: ($) =>
        `"your estimated tax for YA"&${$('r_ya')}&" is already S$0, so extra SRS or CPF contributions would not save any tax this year."`,
    },
    RELIEF_CAP_EXCEEDED_BASELINE: {
      severity: 'caution',
      when: ($) => `${$('w_base_lostToCap')}>0`,
      text: ($) =>
        `"your reliefs already add up to "&${dollarsText($('w_base_totalBeforeCap'))}&", more than the "&${cap($)}&" overall cap. The "&${dollarsText($('w_base_lostToCap'))}&" above the cap is lost, and further SRS or CPF contributions would earn no tax relief."`,
    },
    RELIEF_CAP_LIMITS_PLAN: {
      severity: 'caution',
      when: ($) => `${$('w_binding')}="reliefCap"`,
      text: ($) =>
        `IF(${$('w_X')}>0,"the plan stops at "&${dollarsText($('w_X'))}&" because that brings your total reliefs to the "&${cap($)}&" overall cap. Anything beyond that earns no tax relief and cannot be refunded.",` +
        `"your reliefs have already reached the "&${cap($)}&" overall cap, so further SRS or CPF contributions would earn no tax relief.")`,
    },
    BELOW_MIN_SAVING_RATE: {
      severity: 'info',
      when: ($) => `AND(${$('w_base_tax')}>0,${$('w_U')}=0)`,
      text: ($) =>
        `"every extra dollar you contribute would save at most "&${rateNumber($('w_base_marginal'))}&"% in tax, below the "&${rateNumber($('u_minRate'))}&"% minimum you set, so nothing is recommended. Lower the minimum to see these smaller savings."`,
    },
    BUDGET_LIMITS_PLAN: {
      severity: 'info',
      when: ($) => `AND(${$('w_binding')}="cashBudget",${$('u_budgetOn')}=1)`,
      text: ($) => `"your cash limit of "&${dollarsText($('u_budget'))}&" is what stops the plan."&${moreSaving($, 'With more cash')}`,
    },
    LEVER_LIMITS_PLAN: {
      severity: 'info',
      when: ($) => `${$('w_binding')}="leverLimits"`,
      text: ($) =>
        `IF(${$('w_L')}>0,"the plan uses all "&${dollarsText($('w_L'))}&" of room left in the schemes you switched on.",` +
        `"the schemes you switched on have no room left this year, so nothing more can be contributed.")&${moreSaving($, 'With more room')}`,
    },
    EXISTING_EXCEEDS_CAP: {
      severity: 'caution',
      when: ($) => `OR(${overCap('srs', $)},${overCap('cpfSelf', $)},${overCap('cpfFamily', $)})`,
      text: ($) =>
        `"you have already put more into "&` +
        `IF(${overCap('srs', $)},"SRS ("&${dollarsText($('w_existing_srs'))}&" against a cap of "&${dollarsText($('w_cap_srs'))}&") ","")&` +
        `IF(${overCap('cpfSelf', $)},"your own CPF ("&${dollarsText($('w_existing_cpfSelf'))}&" against "&${dollarsText($('w_cap_cpfSelf'))}&") ","")&` +
        `IF(${overCap('cpfFamily', $)},"family CPF ("&${dollarsText($('w_existing_cpfFamily'))}&" against "&${dollarsText($('w_cap_cpfFamily'))}&") ","")&` +
        `"than earns tax relief in a year. The amount above the cap earns none."`,
    },
    CPF_OVERRIDE_ABOVE_MAX: {
      severity: 'caution',
      when: ($) => `AND(${$('u_res')}<>3,${$('u_overrideOn')}=1,${$('u_override')}>${$('w_maxCompulsory')})`,
      text: ($) =>
        `"the employee CPF you entered ("&${dollarsText($('u_override'))}&") is more than the largest compulsory contribution possible in a year, so "&${dollarsText($('w_maxCompulsory'))}&" is used. Voluntary contributions do not earn CPF relief."`,
    },
    FOREIGNER_NO_CPF: {
      severity: 'info',
      when: ($) => `${$('u_res')}=3`,
      text: ($) =>
        `"foreigners on work passes do not contribute to CPF, so there is no CPF relief and CPF top-ups do not earn tax relief. You can put up to "&${dollarsText($('r_srsCapForeigner'))}&" a year into SRS."`,
    },
    PR_GRADUATED_RATES: {
      severity: 'info',
      when: ($) => `AND(${$('u_res')}=2,${$('u_prYear')}<3)`,
      text: ($) =>
        `"as a Permanent Resident in your "&IF(${$('u_prYear')}=1,"1st","2nd")&" year you pay reduced CPF rates, so your CPF relief is smaller than at full rates. If you have opted to pay full rates, choose ""3rd year onwards""."`,
    },
    AGE_55_PLUS_TOPUP: {
      severity: 'info',
      when: ($) => `AND(${$('u_age')}>=55,${$('w_enabled_cpfSelf')}=1,${$('w_eligible_cpfSelf')}=1)`,
      text: ($) =>
        `"from age 55, cash top-ups go to your Retirement Account and earn tax relief only up to the Full Retirement Sum ("&${dollarsText($('r_frs'))}&" in "&${$('r_incomeYear')}&"). Check your balance and enter the room you have left."`,
    },
    SRS_UNDER_18: {
      severity: 'caution',
      when: ($) => `${$('u_age')}<${$('r_srsMinAge')}`,
      text: ($) => `"you must be at least "&${$('r_srsMinAge')}&" to contribute to SRS, so SRS is left out of the plan."`,
    },
    DEADLINE_PASSED: {
      severity: 'blocker',
      when: ($) => `${$('m_days')}<0`,
      text: ($) =>
        `"the deadline for contributions that count for YA"&${$('r_ya')}&" was "&${longDate($, $('r_deadline'))}&", "&(-${$('m_days')})&IF(${$('m_days')}=-1," day"," days")&" ago. Money you put in now counts for the following year instead."`,
    },
    DEADLINE_SOON: {
      severity: 'caution',
      when: ($) => `AND(${$('m_days')}>=0,${$('m_days')}<=14,${$('w_X')}>0)`,
      text: ($) =>
        `IF(${$('m_days')}=0,"today is the deadline.","only "&${$('m_days')}&IF(${$('m_days')}=1," day"," days")&" left until the "&${longDate($, $('r_deadline'))}&" deadline.")&" Banks and the CPF Board can stop taking contributions earlier, so transfer as soon as you can."`,
    },
    PROJECTED_RULES: {
      severity: 'caution',
      when: ($) => `${$('r_status')}="projected"`,
      text: ($) =>
        `"the rules for income year "&${$('r_incomeYear')}&" (YA"&${$('r_ya')}&") are projected from what has been announced so far and may change, for example at the Budget. Treat these figures as provisional."`,
    },
    PIT_REBATE_APPLIED: {
      severity: 'info',
      when: ($) => `${$('w_base_rebate')}>0`,
      text: ($) =>
        `"a Personal Income Tax Rebate takes "&${taxText($('w_base_rebate'))}&" off your bill. Because the rebate shrinks as your tax falls, the tax actually saved can be less than the bracket rate suggests."`,
    },
  };
  const lead = { info: 'Note — ', caution: 'Check — ', blocker: 'Too late — ' } as const;
  for (const code of WARNING_CODES) {
    const warning = warnings[code];
    const row = r;
    b.v(ws, 2, row, code, ST.td(undefined, 'left', { size: 9, color: { argb: C.muted } }));
    b.f(ws, 3, row, ($) => `IF(${warning.when($)},1,0)`, ST.td(NF.plain));
    b.f(ws, 4, row, () => `SUM(C$${wTop}:C${row})`, ST.td(NF.plain));
    b.v(ws, 5, row, warning.severity, ST.td(undefined, 'left', { size: 9, color: { argb: C.muted } }));
    b.f(ws, 6, row, ($) => `"${lead[warning.severity]}"&${warning.text($)}`, ST.noteRun());
    r++;
  }
  const wEnd = r - 1;
  b.regRange('w_warnCodes', ws, 2, wTop, 2, wEnd);
  b.regRange('w_warnFlags', ws, 3, wTop, 3, wEnd);
  b.regRange('w_warnCount', ws, 4, wTop, 4, wEnd);
  b.regRange('w_warnText', ws, 6, wTop, 6, wEnd);

  view(ws, 2);
  pageSetup(ws, { landscape: true, lastCol: 'I', lastRow: wEnd, titleRows: '1:1' });
  return ws;
}
