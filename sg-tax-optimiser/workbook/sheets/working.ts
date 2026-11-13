/**
 * The Tax Working sheet: the whole model of SPEC §6 as live formulas — inputs as used (§6.0), employee CPF
 * (§6.1), income, reliefs and tax before and after the plan (§6.2–§6.4), the schemes' room (§6.5), the optimiser
 * (§6.6), the checks behind the Planner's warnings (§6.11) and, last so it can grow, the tax table bracket by
 * bracket with the working that depends on it.
 */
import type ExcelJS from 'exceljs';
import {
  Book,
  C,
  NF,
  SHEETS,
  ST,
  a1,
  colLetter,
  dollarsText,
  floorRateTimes,
  grossTax,
  isNum,
  lit,
  longDate,
  marginalRate,
  mergeRow,
  moneyOf,
  pageSetup,
  pctText,
  rateNumber,
  rebateCents,
  setWidths,
  styleRow,
  taxPayable,
  taxText,
  view,
} from '../kit';
import type { Resolver, Style } from '../kit';
import { MONTH_LABELS, YES, bracketCapacity } from './rules';

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

/**
 * Checks that only a workbook needs (the engine's rules cannot be edited by hand). They are listed before the
 * SPEC's warnings on the Planner because, while one applies, the figures themselves may be wrong.
 */
export const WORKBOOK_CHECKS = ['RULES_TABLE', 'DEADLINE_YEAR'] as const;

/** When each check fires, in a few words (shown on the Tax Working sheet while the check does not apply). */
const SHOWN_WHEN: Record<(typeof WARNING_CODES)[number], string> = {
  NO_TAX_PAYABLE: 'there is no tax to pay before the plan',
  RELIEF_CAP_EXCEEDED_BASELINE: 'your reliefs are over the overall cap before the plan',
  RELIEF_CAP_LIMITS_PLAN: 'the overall relief cap is what stops the plan',
  BELOW_MIN_SAVING_RATE: 'every possible saving is below your minimum rate',
  BUDGET_LIMITS_PLAN: 'your cash limit is what stops the plan',
  LEVER_LIMITS_PLAN: 'the room in your schemes is what stops the plan',
  EXISTING_EXCEEDS_CAP: "you have already put more than a scheme's yearly cap into it",
  CPF_OVERRIDE_ABOVE_MAX: 'the employee CPF you entered is above the largest possible compulsory contribution',
  FOREIGNER_NO_CPF: 'you are a foreigner on a work pass',
  PR_GRADUATED_RATES: 'you are a Permanent Resident in your first two years',
  AGE_55_PLUS_TOPUP: 'you are 55 or older and top-ups to your own CPF are switched on',
  SRS_UNDER_18: 'you are below the minimum age for SRS',
  DEADLINE_PASSED: 'the contribution deadline has passed',
  DEADLINE_SOON: 'the deadline is 14 days away or less and the plan recommends a contribution',
  PROJECTED_RULES: 'the rules for the year are marked as projected on the Rules sheet',
  PIT_REBATE_APPLIED: 'a personal income tax rebate reduces your tax',
};

export function buildWorking(b: Book): ExcelJS.Worksheet {
  const rules = b.rules;
  const ws = b.sheet(SHEETS.working, C.slateSoft);
  setWidths(ws, [2, 58, 17, 17, 17, 17, 17, 17, 17, 3, 15, 15, 15, 15, 15]);
  const LAST = 9;

  let r = 1;
  ws.getRow(r).height = 32;
  mergeRow(ws, r, 2, LAST, ST.title()).value = 'How your tax is worked out';
  r++;
  ws.getRow(r).height = 34;
  mergeRow(ws, r, 2, LAST, ST.subtitle()).value =
    'Every step from your pay to your tax bill, before and after the recommended plan, followed by the working behind it: ' +
    'your CPF contributions, the room in each scheme, how the plan total is chosen and the tax bracket by bracket. All of it is formulas.';
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
  pair('cpf', 'CPF relief (your compulsory employee contributions)', (_c, $) => $('w_employeeCpf'), 'same', NF.int, { note: 'Worked out in section 2 below.' });
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
  const rGross = pair('gross', 'Tax on chargeable income', (c, $) => grossTax($, `${c}${rCi}`), undefined, NF.cents, { note: 'Bracket by bracket in section 7; rounded to cents once.' });
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
  // 2. Employee CPF
  // ======================================================================================================
  section('2 · Your compulsory CPF contributions (this is your CPF relief)');
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
  b.v(ws, 5, r, 'Age band no.', ST.th());
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
  // 3. The schemes
  // ======================================================================================================
  section('3 · The three schemes: caps and room');
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
  // 4. The optimiser
  // ======================================================================================================
  section('4 · How the plan total is chosen');
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
    ($) => `MAX(${$('w_brRoomMin')})`,
    ST.value(NF.int),
    'Chargeable income above the start of the lowest bracket taxed at your minimum rate or more (worked out in section 7).',
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
    ($) => `MAX(${$('w_brRoomAny')})`,
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
    'Further saving out of reach (if neither the schemes nor your cash had a limit)',
    ($) => `ROUND(${$('w_opt_tax')}-${$('w_taxFull')},2)`,
    ST.value(NF.cents),
  );
  // What ONE change of setting could still save (SPEC §6.11): these, not the figure above, are quoted in messages.
  line(
    'w_reachCash',
    'Plan total if your cash limit were lifted',
    ($) => `MAX(${$('w_X')},MIN(${$('w_U')},${$('w_C')},${$('w_L')}))`,
    ST.value(NF.int),
    'The smallest of the other three limits.',
  );
  line(
    'w_saveMoreCash',
    '… and the extra tax that would save',
    ($) => `ROUND(${$('w_opt_tax')}-${taxPayable($, `MAX(0,${$('w_base_ci')}-${$('w_reachCash')})`)},2)`,
    ST.value(NF.cents),
  );
  line(
    'w_reachSwitch',
    'Plan total if every scheme open to you were switched on',
    ($) =>
      `MAX(${$('w_X')},IF(${$('u_budgetOn')}=1,MIN(${$('w_U')},${$('w_C')},${$('u_budget')},SUM(${$('w_roomIfOn_all')})),MIN(${$('w_U')},${$('w_C')},SUM(${$('w_roomIfOn_all')}))))`,
    ST.value(NF.int),
    'Still held to your minimum rate, the relief cap and your cash limit.',
  );
  line(
    'w_saveSwitchOn',
    '… and the extra tax that would save',
    ($) => `ROUND(${$('w_opt_tax')}-${taxPayable($, `MAX(0,${$('w_base_ci')}-${$('w_reachSwitch')})`)},2)`,
    ST.value(NF.cents),
  );
  line(
    'w_optBandFrom',
    'Start of the bracket your top dollar is in, after the plan',
    ($) => `MAX(${$('w_brStartOpt')})`,
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
      const moreCash = `IF(${$('w_saveMoreCash')}>0," With more cash you could save up to "&${taxText($('w_saveMoreCash'))}&" more.","")`;
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
        `IF(SUM(${$('w_enabled_all')})=0,${lit('No scheme is switched on, so there is nothing to recommend. Switch on SRS or CPF top-ups on the left.')},` +
        `IF(SUMPRODUCT(${$('w_enabled_all')}*${$('w_eligible_all')})=0,${lit('None of the schemes you switched on is open to you, so nothing can be contributed.')},` +
        `${lit('The schemes you switched on have no room left this year, so nothing more can be contributed.')})),` +
        `"You have used all the room in the schemes you switched on."&IF(${optMarginal}>0," "&${dollarsText(`(${$('w_opt_ci')}-${$('w_optBandFrom')})`)}&" of your income is still taxed at "&${rateNumber(optMarginal)}&"%.","")),` +
        `"Your cash limit of "&${dollarsText($('u_budget'))}&" is used up."&${moreCash}))))`
      );
    },
  );
  ws.getRow(r).height = 30;
  mergeRow(ws, r, 3, LAST, ST.note());
  b.reg('w_reasonText', ws, 3, r);
  r += 2;

  // ======================================================================================================
  // 5. Inputs as used
  // ======================================================================================================
  section('5 · Your Planner entries as the formulas use them');
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
    used(onKey, `${label} — entered? (1 = yes)`, ($) => `IF(${isNum($(inputKey))},1,0)`, NF.plain);
    used(valueKey, `${label} — amount`, ($) => moneyOf($(inputKey)), NF.int);
  };
  used('u_res', 'Residency (1 Citizen, 2 PR, 3 foreigner)', ($) => `IFERROR(MATCH(${$('in_residency')},${$('l_residency')},0),1)`, NF.plain);
  used('u_prYear', 'PR year (3 = third year onwards)', ($) => `IF(${$('u_res')}=2,IFERROR(MATCH(${$('in_prYear')},${$('l_prYear')},0),3),3)`, NF.plain);
  used('u_age', 'Age on 31 December', ($) => `IF(${isNum($('in_age'))},MIN(120,MAX(0,INT(${$('in_age')}))),0)`, NF.plain);
  used('u_birthMonth', 'Birth month (1–12)', ($) => `IFERROR(MATCH(${$('in_birthMonth')},${$('l_months')},0),12)`, NF.plain);
  used('u_ow', 'Monthly salary', ($) => moneyOf($('in_monthlyWage')), NF.int);
  used('u_months', 'Months worked (1–12)', ($) => `IF(${isNum($('in_monthsWorked'))},MIN(12,MAX(1,INT(${$('in_monthsWorked')}))),12)`, NF.plain);
  used('u_aw', 'Bonus and other additional wages', ($) => moneyOf($('in_additionalWages')), NF.int);
  used('u_otherIncome', 'Other taxable income', ($) => moneyOf($('in_otherIncome')), NF.int);
  used('u_expenses', 'Employment expenses', ($) => moneyOf($('in_employmentExpenses')), NF.int);
  used('u_donations', 'Donations', ($) => moneyOf($('in_donations')), NF.int);
  // SPEC §6.0: the CPF figure replaces a calculated one, so only a number of 0 or more counts as entered. A negative
  // number is "not entered" (the worked-out figure is used) rather than a figure of 0, which would remove the relief.
  used('u_overrideOn', 'Actual employee CPF — entered? (1 = yes)', ($) => `IF(${isNum($('in_cpfOverride'))},IF(${$('in_cpfOverride')}>=0,1,0),0)`, NF.plain);
  used('u_override', 'Actual employee CPF — amount', ($) => moneyOf($('in_cpfOverride')), NF.int);
  used('u_exSrs', 'Already in SRS', ($) => moneyOf($('in_existingSrs')), NF.int);
  used('u_exSelf', 'Already topped up — self', ($) => moneyOf($('in_existingCpfSelf')), NF.int);
  used('u_exFam', 'Already topped up — family', ($) => moneyOf($('in_existingCpfFamily')), NF.int);
  used('u_otherReliefs', 'Other reliefs', ($) => moneyOf($('in_otherReliefs')), NF.int);
  used('u_enSrs', 'Use SRS? (1 = yes)', ($) => `IF(${$('in_useSrs')}="${YES}",1,0)`, NF.plain);
  used('u_enSelf', 'Use CPF top-ups to yourself? (1 = yes)', ($) => `IF(${$('in_useCpfSelf')}="${YES}",1,0)`, NF.plain);
  used('u_enFam', 'Use CPF top-ups to family? (1 = yes)', ($) => `IF(${$('in_useCpfFamily')}="${YES}",1,0)`, NF.plain);
  optional('u_selfLimitOn', 'u_selfLimit', 'Room before your CPF limits', 'in_cpfSelfRoom');
  optional('u_famLimitOn', 'u_famLimit', 'Most you would give to family', 'in_cpfFamilyMax');
  used('u_minRate', 'Smallest saving per dollar worth it', ($) => `IF(${isNum($('in_minSavingRate'))},MIN(1,MAX(0,${$('in_minSavingRate')})),0)`, NF.pct);
  optional('u_budgetOn', 'u_budget', 'Cash limit', 'in_cashBudget');
  used('u_preset', 'Which scheme first (row of the list on the Rules sheet)', ($) => `IFERROR(MATCH(${$('in_priority')},${$('l_priority')},0),1)`, NF.plain);
  used(
    'u_today',
    '"As at" date (Monthly Plan sheet)',
    ($) => `IF(${isNum($('in_asAtDate'))},INT(${$('in_asAtDate')}),TODAY())`,
    NF.date,
    'Today, unless you typed another date on the Monthly Plan sheet.',
  );
  used('u_step', 'Simulator step', ($) => `IF(${isNum($('in_simulatorStep'))},MAX(100,INT(${$('in_simulatorStep')})),1000)`, NF.int);
  r++;

  // ======================================================================================================
  // 6. Warnings
  // ======================================================================================================
  section('6 · The checks behind "Things to check" on the Planner');
  b.v(ws, 2, r, 'Code', ST.th('left'));
  b.v(ws, 3, r, 'Applies? (1 = yes)', ST.th());
  b.v(ws, 4, r, 'Lines so far', ST.th());
  mergeRow(ws, r, 5, LAST, ST.th('left')).value = 'Message (shown on the Planner when it applies)';
  r++;
  const wTop = r;
  const cap = ($: Resolver): string => dollarsText($('r_reliefCap'));
  /** " <lead> could save up to S$X more tax." when one change of setting would save more (SPEC §6.11), else nothing. */
  const couldSave = ($: Resolver, key: string, lead: string): string =>
    `IF(${$(key)}>0," ${lead} could save up to "&${taxText($(key))}&" more tax.","")`;
  const overCap = (lever: string, $: Resolver): string =>
    `AND(${$(`w_cap_${lever}`)}>0,${$(`w_existing_${lever}`)}>${$(`w_cap_${lever}`)})`;
  /** The engine's sentence for one scheme that is over its cap, from "have already put …" on. */
  const overCapSentence = (lever: string, destination: string, $: Resolver): string =>
    `" have already put "&${dollarsText($(`w_existing_${lever}`))}&" into ${destination} this year, but only "&` +
    `${dollarsText($(`w_cap_${lever}`))}&" a year earns tax relief; the extra "&${dollarsText(`(${$(`w_existing_${lever}`)}-${$(`w_cap_${lever}`)})`)}&" earns none."`;
  const OVER_CAP: Array<[string, string]> = [
    ['srs', 'SRS'],
    ['cpfSelf', 'your own CPF as cash top-ups'],
    ['cpfFamily', "family members' CPF as cash top-ups"],
  ];
  const deadlineText = ($: Resolver): string => longDate($, $('m_deadline'));

  interface Check {
    severity: 'info' | 'caution' | 'blocker';
    when: F;
    text: F;
    shownWhen: string;
    /**
     * For a message of several sentences that the Planner shows one per line: how many lines apply now, and
     * the text of each (without the "Check — " lead, blank when there are fewer).
     */
    lines?: { count: F; text: [F, F, F] };
  }
  // Checks on the workbook itself come first: while one applies, the figures cannot be trusted.
  const workbookChecks: Record<(typeof WORKBOOK_CHECKS)[number], Check> = {
    RULES_TABLE: {
      severity: 'caution',
      when: ($) => `${$('w_rulesIssue')}<>""`,
      text: ($) =>
        `"the tax table on the Rules sheet needs fixing: "&${$('w_rulesIssue')}&". Until it is fixed, the figures on every sheet may be wrong."`,
      shownWhen: 'the tax table on the Rules sheet is out of order or incomplete',
    },
    DEADLINE_YEAR: {
      severity: 'caution',
      when: ($) => `IF(${isNum($('r_deadline'))},YEAR(${$('r_deadline')})<>${$('r_incomeYear')},1=1)`,
      text: ($) =>
        `"the last contribution day on the Rules sheet ("&IF(${isNum($('r_deadline'))},${longDate($, $('r_deadline'))},"not a date")&") is not in income year "&${$('r_incomeYear')}&". ` +
        `Correct it there: it is normally 31 December of the income year. The days left and the deadline messages depend on it."`,
      shownWhen: 'the last contribution day on the Rules sheet is not a date in the income year',
    },
  };
  const warnings: Record<(typeof WARNING_CODES)[number], Omit<Check, 'shownWhen'>> = {
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
        `IF(${$('w_X')}>0,"the plan stops at "&${dollarsText($('w_X'))}&" because that brings your total reliefs to the "&${cap($)}&" overall cap. Anything you contribute beyond that earns no tax relief and cannot be refunded.",` +
        `"your reliefs have already reached the "&${cap($)}&" overall cap, so further SRS or CPF contributions would earn no tax relief.")`,
    },
    BELOW_MIN_SAVING_RATE: {
      severity: 'info',
      when: ($) => `AND(${$('w_base_tax')}>0,${$('w_U')}=0)`,
      text: ($) =>
        `"every extra dollar you contribute would save at most "&${pctText($('w_base_marginal'))}&" in tax, below the "&${pctText($('u_minRate'))}&" minimum you set, so nothing is recommended. Lower the minimum to see these smaller savings."`,
    },
    BUDGET_LIMITS_PLAN: {
      severity: 'info',
      when: ($) => `AND(${$('w_binding')}="cashBudget",${$('u_budgetOn')}=1)`,
      text: ($) => `"your cash limit of "&${dollarsText($('u_budget'))}&" is what stops the plan."&${couldSave($, 'w_saveMoreCash', 'With more cash you')}`,
    },
    LEVER_LIMITS_PLAN: {
      severity: 'info',
      when: ($) => `${$('w_binding')}="leverLimits"`,
      // Why there is no more room, in words that are true for this person, then what the schemes left off could add.
      text: ($) =>
        `IF(${$('w_L')}>0,"the plan uses all "&${dollarsText($('w_L'))}&" of room left in the schemes you switched on.",` +
        `IF(SUM(${$('w_enabled_all')})=0,"no scheme is switched on, so nothing can be contributed.",` +
        `IF(SUMPRODUCT(${$('w_enabled_all')}*${$('w_eligible_all')})=0,"none of the schemes you switched on is open to you, so nothing can be contributed.",` +
        `"the schemes you switched on have no room left this year, so nothing more can be contributed.")))&${couldSave($, 'w_saveSwitchOn', 'Switching on the schemes you left off')}`,
    },
    EXISTING_EXCEEDS_CAP: {
      severity: 'caution',
      when: ($) => `OR(${overCap('srs', $)},${overCap('cpfSelf', $)},${overCap('cpfFamily', $)})`,
      // The engine's message: one sentence for each scheme that is over its cap.
      text: ($) =>
        OVER_CAP.map(([lever, destination], index) => {
          const earlier = OVER_CAP.slice(0, index).map(([other]) => overCap(other, $));
          const first = earlier.length === 0 ? '1=1' : `NOT(OR(${earlier.join(',')}))`;
          return `IF(${overCap(lever, $)},IF(${first},"you"," You")&${overCapSentence(lever, destination, $)},"")`;
        }).join('&'),
      // On the Planner each sentence gets a line of its own (three together would not fit one).
      lines: {
        count: ($) => OVER_CAP.map(([lever]) => `IF(${overCap(lever, $)},1,0)`).join('+'),
        text: [
          // 1st line: the first scheme over its cap; 2nd: the second; 3rd: only when all three are.
          ($) =>
            `"you"&IF(${overCap('srs', $)},${overCapSentence('srs', 'SRS', $)},IF(${overCap('cpfSelf', $)},${overCapSentence('cpfSelf', 'your own CPF as cash top-ups', $)},${overCapSentence('cpfFamily', "family members' CPF as cash top-ups", $)}))`,
          ($) =>
            `"you"&IF(AND(${overCap('srs', $)},${overCap('cpfSelf', $)}),${overCapSentence('cpfSelf', 'your own CPF as cash top-ups', $)},${overCapSentence('cpfFamily', "family members' CPF as cash top-ups", $)})`,
          ($) => `"you"&${overCapSentence('cpfFamily', "family members' CPF as cash top-ups", $)}`,
        ],
      },
    },
    CPF_OVERRIDE_ABOVE_MAX: {
      severity: 'caution',
      when: ($) => `AND(${$('u_res')}<>3,${$('u_overrideOn')}=1,${$('u_override')}>${$('w_maxCompulsory')})`,
      text: ($) =>
        `"the employee CPF you entered ("&${dollarsText($('u_override'))}&") is more than the largest compulsory contribution possible in a year ("&${dollarsText($('w_maxCompulsory'))}&"), so "&${dollarsText($('w_maxCompulsory'))}&" is used. Voluntary contributions do not earn CPF relief."`,
    },
    FOREIGNER_NO_CPF: {
      severity: 'info',
      when: ($) => `${$('u_res')}=3`,
      // The SRS sentence is left out when SRS is not open to the user either (below the minimum age).
      text: ($) =>
        `"foreigners on work passes do not contribute to CPF, so there is no CPF relief and CPF top-ups do not earn tax relief."&IF(${$('w_eligible_srs')}=1," You can put up to "&${dollarsText($('w_cap_srs'))}&" a year into SRS.","")`,
    },
    PR_GRADUATED_RATES: {
      severity: 'info',
      when: ($) => `AND(${$('u_res')}=2,${$('u_prYear')}<3)`,
      text: ($) =>
        `"as a permanent resident in your "&IF(${$('u_prYear')}=1,"1st","2nd")&" year you pay reduced (graduated) CPF rates, so your CPF relief is smaller than at full rates. If you have opted to pay full rates, choose ""3rd year onwards""."`,
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
        `"the deadline for contributions that count for YA"&${$('r_ya')}&" was "&${deadlineText($)}&", "&(-${$('m_days')})&IF(${$('m_days')}=-1," day"," days")&" ago. Money you put in now counts for the following year instead."`,
    },
    DEADLINE_SOON: {
      severity: 'caution',
      when: ($) => `AND(${$('m_days')}>=0,${$('m_days')}<=14,${$('w_X')}>0)`,
      text: ($) =>
        `IF(${$('m_days')}=0,"today, "&${deadlineText($)}&", is the deadline.","only "&${$('m_days')}&IF(${$('m_days')}=1," day"," days")&" left until the "&${deadlineText($)}&" deadline.")&" Banks and the CPF Board can stop taking contributions earlier, so transfer as soon as you can."`,
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
        `"a Personal Income Tax Rebate of "&${pctText($('r_rebateRate'))}&" of tax (at most "&${dollarsText($('r_rebateCap'))}&") applies for YA"&${$('r_ya')}&" and takes "&${taxText($('w_base_rebate'))}&" off your bill. Because the rebate shrinks as your tax falls, the tax actually saved can be less than the bracket rate suggests."`,
    },
  };
  const lead = { info: 'Note — ', caution: 'Check — ', blocker: 'Too late — ' } as const;
  /** Working columns beside the table: how many Planner lines the row gives, and their text. */
  const LINES = { count: 11, first: 12, last: 14 } as const;
  const checkRow = (code: string, check: Omit<Check, 'shownWhen'>, shownWhen: string): void => {
    const row = r;
    b.v(ws, 2, row, code, ST.td(undefined, 'left', { size: 9, color: { argb: C.muted } }));
    b.f(ws, 3, row, ($) => `IF(${check.when($)},1,0)`, ST.td(NF.plain));
    b.f(ws, 4, row, () => `SUM(${colLetter(LINES.count)}$${wTop}:${colLetter(LINES.count)}${row})`, ST.td(NF.plain));
    // Room for two lines of text; four for a message the Planner spreads over several lines.
    ws.getRow(row).height = check.lines ? 54 : 27;
    mergeRow(ws, row, 5, LAST, ST.tdWrap({ size: 9, color: { argb: C.faint } }));
    b.f(ws, 5, row, ($) => `IF(C${row}=1,"${lead[check.severity]}"&${check.text($)},${lit(`Does not apply now. Shown when ${shownWhen}.`)})`);
    const lines = check.lines;
    if (lines) {
      b.f(ws, LINES.count, row, ($) => `IF(C${row}=1,${lines.count($)},0)`, ST.helper(NF.plain));
      lines.text.forEach((text, index) => {
        b.f(ws, LINES.first + index, row, ($) => `IF(${a1(LINES.count, row)}>${index},"${lead[check.severity]}"&${text($)},"")`, ST.helper(undefined, 'left'));
      });
    } else {
      b.f(ws, LINES.count, row, () => `C${row}`, ST.helper(NF.plain));
      b.f(ws, LINES.first, row, () => `IF(C${row}=1,E${row},"")`, ST.helper(undefined, 'left'));
      // A message of one sentence has no second or third line.
    }
    r++;
  };
  b.v(ws, LINES.count, wTop - 1, 'Lines on the Planner', ST.helperHead());
  b.v(ws, LINES.first, wTop - 1, 'Line 1', ST.helperHead('left'));
  b.v(ws, LINES.first + 1, wTop - 1, 'Line 2', ST.helperHead('left'));
  b.v(ws, LINES.last, wTop - 1, 'Line 3', ST.helperHead('left'));
  for (const code of WORKBOOK_CHECKS) checkRow(`WORKBOOK · ${code}`, workbookChecks[code], workbookChecks[code].shownWhen);
  const codesTop = r;
  for (const code of WARNING_CODES) checkRow(code, warnings[code], SHOWN_WHEN[code]);
  const wEnd = r - 1;
  // Messages that apply right now stand out; the others are greyed.
  ws.addConditionalFormatting({
    ref: `B${wTop}:I${wEnd}`,
    rules: [
      {
        type: 'expression',
        priority: 1,
        formulae: [`$C${wTop}=1`],
        style: { font: { bold: true, color: { argb: C.ink } } },
      },
    ],
  });
  b.regRange('w_checkFlags', ws, 3, wTop, 3, codesTop - 1);
  b.regRange('w_warnCodes', ws, 2, codesTop, 2, wEnd);
  b.regRange('w_warnFlags', ws, 3, codesTop, 3, wEnd);
  b.regRange('w_warnMessages', ws, 5, codesTop, 5, wEnd);
  b.regRange('w_warnCount', ws, 4, wTop, 4, wEnd);
  b.regRange('w_warnLineCount', ws, LINES.count, wTop, LINES.count, wEnd);
  b.regRange('w_warnLines', ws, LINES.first, wTop, LINES.last, wEnd);
  r += 1;

  // ======================================================================================================
  // 7. Tax by bracket (last, so the table can grow with the Rules sheet)
  // ======================================================================================================
  section('7 · Tax by bracket');
  const capacity = bracketCapacity(rules.taxBrackets.length);
  b.sizes.bracketRows = capacity;
  const n = ($: Resolver): string => $('r_bracketCount');
  b.v(ws, 2, r, 'Brackets in the tax table on the Rules sheet', ST.label());
  b.f(ws, 3, r, ($) => n($), ST.value(NF.plain));
  b.v(ws, 4, r, `This sheet has room for ${capacity}: rows below fill in by themselves when you add brackets on the Rules sheet.`, ST.noteRun());
  r++;
  b.v(ws, 2, r, 'Check on the Rules sheet tax table (blank = in order)', ST.label());
  mergeRow(ws, r, 3, LAST, { ...ST.valueText({ bold: true, color: { argb: C.warn } }) });
  b.reg('w_rulesIssue', ws, 3, r);
  const issueRow = r;
  r++;
  ws.getRow(r).height = 30;
  b.v(ws, 2, r, 'Slice of chargeable income', ST.th('left'));
  b.v(ws, 3, r, 'From (S$)', ST.th());
  b.v(ws, 4, r, 'Up to (S$)', ST.th());
  b.v(ws, 5, r, 'Rate', ST.th());
  b.v(ws, 6, r, 'Before: income in this slice', ST.th());
  b.v(ws, 7, r, 'Before: tax', ST.th());
  b.v(ws, 8, r, 'After: income in this slice', ST.th());
  b.v(ws, 9, r, 'After: tax', ST.th());
  const H = { below: 11, roomMin: 12, roomAny: 13, startOpt: 14, ok: 15 } as const;
  b.v(ws, H.below, r, 'Starts below your top dollar? (before)', ST.helperHead());
  b.v(ws, H.roomMin, r, 'Room down to its start, if taxed at your minimum or more', ST.helperHead());
  b.v(ws, H.roomAny, r, 'Room down to its start, if taxed at all', ST.helperHead());
  b.v(ws, H.startOpt, r, 'Its start, if below your top dollar after the plan', ST.helperHead());
  b.v(ws, H.ok, r, 'Row in order? (1 = yes)', ST.helperHead());
  r++;
  // The total comes first so the unused rows under the table leave no gap before it.
  const totalRow = r;
  const brTop = r + 1;
  const brEnd = brTop + capacity - 1;
  b.v(ws, 2, totalRow, 'All brackets (tax rounded to cents once, on the whole sum)', ST.total(undefined, 'left'));
  styleRow(ws, totalRow, 3, 5, ST.total());
  b.f(ws, 6, totalRow, () => `SUM(F${brTop}:F${brEnd})`, ST.total(NF.int));
  b.f(ws, 7, totalRow, ($) => $('w_base_gross'), ST.total(NF.cents));
  b.f(ws, 8, totalRow, () => `SUM(H${brTop}:H${brEnd})`, ST.total(NF.int));
  b.f(ws, 9, totalRow, ($) => $('w_opt_gross'), ST.total(NF.cents));
  b.f(ws, H.below, totalRow, () => `MAX(1,SUM(${a1(H.below, brTop)}:${a1(H.below, brEnd)}))`, ST.helper(NF.plain));
  b.reg('w_k0', ws, H.below, totalRow);
  r = brTop;
  for (let i = 1; i <= capacity; i++) {
    const row = r;
    const off = ($: Resolver): string => `${i}>${n($)}`;
    const ci0 = ($: Resolver): string => $('w_base_ci');
    const ci1 = ($: Resolver): string => $('w_opt_ci');
    b.f(
      ws,
      2,
      row,
      ($) => `IF(${off($)},"",IF(D${row}="","Above S$"&TEXT(C${row},"#,##0"),"S$"&TEXT(C${row},"#,##0")&" to S$"&TEXT(D${row},"#,##0")))`,
      ST.tdBare(undefined, 'left'),
    );
    b.f(ws, 3, row, ($) => `IF(${off($)},"",INDEX(${$('r_from')},${i}))`, ST.tdBare(NF.int));
    b.f(ws, 4, row, ($) => `IF(${i}>=${n($)},"",INDEX(${$('r_from')},${i + 1}))`, ST.tdBare(NF.int));
    b.f(ws, 5, row, ($) => `IF(${off($)},"",INDEX(${$('r_rate')},${i}))`, ST.tdBare(NF.pct));
    b.f(ws, 6, row, ($) => `IF(${off($)},"",MAX(0,IF(D${row}="",${ci0($)},MIN(${ci0($)},D${row}))-C${row}))`, ST.tdBare(NF.int));
    b.f(ws, 7, row, ($) => `IF(${off($)},"",F${row}*E${row})`, ST.tdBare(NF.cents));
    b.f(ws, 8, row, ($) => `IF(${off($)},"",MAX(0,IF(D${row}="",${ci1($)},MIN(${ci1($)},D${row}))-C${row}))`, ST.tdBare(NF.int));
    b.f(ws, 9, row, ($) => `IF(${off($)},"",H${row}*E${row})`, ST.tdBare(NF.cents));
    // Working columns: plain numbers on every row, so the limits in section 4 are an ordinary MAX of a column.
    b.f(ws, H.below, row, ($) => `IF(${off($)},0,IF(C${row}<${ci0($)},1,0))`, ST.helper(NF.plain));
    b.f(ws, H.roomMin, row, ($) => `IF(${off($)},0,IF(AND(E${row}>0,E${row}>=${$('u_minRate')},${ci0($)}>C${row}),${ci0($)}-C${row},0))`, ST.helper(NF.int));
    b.f(ws, H.roomAny, row, ($) => `IF(${off($)},0,IF(AND(E${row}>0,${ci0($)}>C${row}),${ci0($)}-C${row},0))`, ST.helper(NF.int));
    b.f(ws, H.startOpt, row, ($) => `IF(${off($)},0,IF(C${row}<${ci1($)},C${row},0))`, ST.helper(NF.int));
    const inOrder = i === 1 ? `C${row}=0` : `C${row}>C${row - 1}`;
    b.f(
      ws,
      H.ok,
      row,
      ($) =>
        `IF(${off($)},1,IF(AND(ISNUMBER(C${row}),ISNUMBER(E${row})),` +
        `IF(AND(E${row}>=0,E${row}<=1,ROUND(E${row}*1000,6)=ROUND(E${row}*1000,0),${inOrder}),1,0),0))`,
      ST.helper(NF.plain),
    );
    r++;
  }
  b.regRange('w_brBelow', ws, H.below, brTop, H.below, brEnd);
  b.regRange('w_brRoomMin', ws, H.roomMin, brTop, H.roomMin, brEnd);
  b.regRange('w_brRoomAny', ws, H.roomAny, brTop, H.roomAny, brEnd);
  b.regRange('w_brStartOpt', ws, H.startOpt, brTop, H.startOpt, brEnd);
  b.regRange('w_brOk', ws, H.ok, brTop, H.ok, brEnd);
  b.regRange('w_brFrom', ws, 3, brTop, 3, brEnd);
  b.regRange('w_brRate', ws, 5, brTop, 5, brEnd);
  b.regRange('w_brBaseIncome', ws, 6, brTop, 6, brEnd);
  b.regRange('w_brBaseTax', ws, 7, brTop, 7, brEnd);
  // What is wrong with the Rules table, in words; blank when it is in order.
  b.f(ws, 3, issueRow, ($) => {
    const count = n($);
    return (
      `IF(${count}<1,"it has no brackets",` +
      `IF(${count}>${capacity},"it has more than ${capacity} brackets, the most this workbook can use",` +
      `IF(OR(COUNT(${$('r_rate')})<>${count},COUNT(${$('r_fromWithHead')})<>${count}),"every bracket needs a start and a rate, on a row between the table heading and the grey end line",` +
      `IF(MIN(${$('w_brOk')})=0,"the brackets must start at 0 and rise from row to row, with rates from 0% to 100% and no more than one decimal place",` +
      `IF(OR(COUNT(${$('r_step')})<>${count},SUM(${$('r_step')})<>ROUND(INDEX(${$('r_rate')},${count})*1000,0)),"a bracket row is missing its grey formulas (copy them from another bracket row)",` +
      `"")))))`
    );
  });
  // A rule under each bracket row in use.
  ws.addConditionalFormatting({
    ref: `B${brTop}:I${brEnd}`,
    rules: [{ type: 'expression', priority: 1, formulae: [`$C${brTop}<>""`], style: { border: { bottom: { style: 'thin', color: { argb: C.band } } } } }],
  });

  view(ws, 2);
  // Print down to the brackets the year starts with; widen the print area if you add brackets.
  pageSetup(ws, { landscape: true, lastCol: 'I', lastRow: brTop + rules.taxBrackets.length - 1, titleRows: '1:1' });
  return ws;
}
