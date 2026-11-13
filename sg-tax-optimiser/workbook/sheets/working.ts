/**
 * The Tax Working sheet: the whole model of SPEC §6 as live formulas, in plain words (SPEC §9) — the tax
 * computation before and after the plan (§6.2–§6.4), employee CPF (§6.1), the schemes' room (§6.5), the optimiser
 * (§6.6), the checks behind the Planner's "Things to check" (§6.11), the tax table bracket by bracket and, last
 * and out of the way, the working cells: the Planner's entries as the formulas read them (§6.0) and the pieces
 * of the sentences shown on the Planner.
 *
 * No internal code appears on the sheet: a check is described by when it is shown, the limit that stops the plan
 * is a sentence, and where a formula needs a code it is a number explained beside it.
 */
import type ExcelJS from 'exceljs';
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
  colLetter,
  dollarsText,
  floorRateTimes,
  grossTax,
  heightFor,
  heightOfLines,
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
import { EXAMPLE } from './example';
import { LEVER_NAMES, MONTH_LABELS, SALARY_PERIODS, YES, bracketCapacity, factSentence } from './rules';

type F = ($: Resolver) => string;

const LEVERS = [
  { id: 'srs', title: LEVER_NAMES.srs, col: 3 },
  { id: 'cpfSelf', title: LEVER_NAMES.cpfSelf, col: 4 },
  { id: 'cpfFamily', title: LEVER_NAMES.cpfFamily, col: 5 },
] as const;

/** Age from which the room for a person's own CPF top-up must be entered (SPEC §6.5). */
const ROOM_AGE = RETIREMENT_ACCOUNT_AGE;

/** What the web page says wherever a plan leaves the person's own CPF out (SPEC §8.4). */
export const LEFT_OUT = 'Your own CPF is left out until you enter how much you can still top up with relief.';

/**
 * The page's words for the two things its lock-up line leaves unsaid (SPEC §8.4; the test holds both to the
 * page's own `horizonLines` and `horizonNote`): a foreigner may reach the 10-year rule before the SRS age, and
 * someone who has contributed before keeps the age set then. The second is written around the age.
 */
const TEN_YEAR_RULE = ', or until you can use the 10-year rule for foreigners if that comes first';
const SRS_AGE_NOTE = ['If you have paid into SRS before, your SRS age was set by your first contribution and may be lower than ', '.'] as const;

/**
 * The engine's warning codes in the order of SPEC §6.11: the order of the rows in section 5. The codes themselves
 * are never written on a sheet; tests and tools pair row `i` with `WARNING_CODES[i]`.
 */
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
  'TAX_RESIDENCY_CHECK',
  'SRS_NON_RESIDENT_WITHDRAWAL',
  'PR_GRADUATED_RATES',
  'CPF_SELF_ROOM_UNCONFIRMED',
  'AGE_55_PLUS_TOPUP',
  'FAMILY_TOPUP_CHECKS',
  'PARENTHOOD_TAX_REBATE',
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

/**
 * The number the sheet uses for the limit that stops the plan (SPEC §6.6 `bindingConstraint`), in the order ties
 * are resolved. Index = the number in the working cell; the sheet shows the sentence, never these names.
 */
export const BINDING_NUMBERS = ['none', 'usefulRoom', 'reliefCap', 'leverLimits', 'cashBudget'] as const;

/** How the sheet says where the employee CPF figure comes from (SPEC §6.1 `source`). */
export const CPF_SOURCE_WORDS = {
  auto: 'worked out from your pay',
  override: 'your own figure',
  none: 'none: foreigners on work passes make no CPF contributions',
} as const;

/**
 * Lines of text each message on this sheet has room for (two unless listed). The row heights are fixed, so each
 * is sized for the longest its message can be; the test holds every message the engine produces to it.
 */
const MESSAGE_LINES: Partial<Record<(typeof WARNING_CODES)[number] | (typeof WORKBOOK_CHECKS)[number], number>> = {
  RULES_TABLE: 3,
  EXISTING_EXCEEDS_CAP: 5,
  CPF_OVERRIDE_ABOVE_MAX: 3,
  TAX_RESIDENCY_CHECK: 3,
  SRS_NON_RESIDENT_WITHDRAWAL: 3,
  CPF_SELF_ROOM_UNCONFIRMED: 3,
  AGE_55_PLUS_TOPUP: 3,
  FAMILY_TOPUP_CHECKS: 3,
  DEADLINE_SOON: 3,
  PIT_REBATE_APPLIED: 3,
};
/** The message column of section 5: six columns of 17, at 9 points. */
const MESSAGE_WIDTH = 17 * 6;
const MESSAGE_FONT = 9;

/** The longest message (with its "Check — " lead) the row for a warning shows without clipping. */
export function messageRoom(code: (typeof WARNING_CODES)[number] | (typeof WORKBOOK_CHECKS)[number]): number {
  return Math.floor((MESSAGE_LINES[code] ?? 2) * charsPerLine(MESSAGE_WIDTH, MESSAGE_FONT));
}

/** When each check is shown, in a few words: the first column of section 5. */
const SHOWN_WHEN: Record<(typeof WARNING_CODES)[number], string> = {
  NO_TAX_PAYABLE: 'there is no tax to pay before the plan',
  RELIEF_CAP_EXCEEDED_BASELINE: 'your reliefs are over the overall cap before the plan',
  RELIEF_CAP_LIMITS_PLAN: 'the overall relief cap is what stops the plan',
  BELOW_MIN_SAVING_RATE: 'every possible saving is below your minimum',
  BUDGET_LIMITS_PLAN: 'your cash limit is what stops the plan',
  LEVER_LIMITS_PLAN: 'the room in your schemes is what stops the plan',
  EXISTING_EXCEEDS_CAP: "you have already put more than a scheme's yearly cap into it",
  CPF_OVERRIDE_ABOVE_MAX: 'the employee CPF you entered is above the largest possible compulsory contribution',
  FOREIGNER_NO_CPF: 'you are a foreigner on a work pass',
  TAX_RESIDENCY_CHECK: 'you are a foreigner who worked here for six months of the year or fewer',
  SRS_NON_RESIDENT_WITHDRAWAL: 'you are a foreigner and SRS is switched on',
  PR_GRADUATED_RATES: 'you are a Permanent Resident in your first two years',
  CPF_SELF_ROOM_UNCONFIRMED: `you are ${ROOM_AGE} or older, top-ups to your own CPF are switched on and their room is blank`,
  AGE_55_PLUS_TOPUP: `you are ${ROOM_AGE} or older and have entered the room for top-ups to your own CPF`,
  FAMILY_TOPUP_CHECKS: 'a family top-up is in the plan or already made',
  PARENTHOOD_TAX_REBATE: 'you chose Yes for unused Parenthood Tax Rebate',
  SRS_UNDER_18: 'you are below the minimum age for SRS',
  DEADLINE_PASSED: 'the contribution deadline has passed',
  DEADLINE_SOON: 'the deadline is 14 days away or less and the plan recommends a contribution',
  PROJECTED_RULES: 'the rules for the year are marked as projected on the Rules sheet',
  PIT_REBATE_APPLIED: 'a personal income tax rebate reduces your tax',
};

/** "a, b and c" for cells that may hold empty text: `items` are references to them, in order. */
function joinList(items: string[]): string {
  return items
    .map((item, index) => {
      const later = items.slice(index + 1);
      if (later.length === 0) return item;
      // How many of the later items are present decides what follows this one.
      const remaining = later.map((other) => `IF(${other}="",0,1)`).join('+');
      return `${item}&IF(${item}="","",IF(${remaining}>=2,", ",IF(${remaining}=1," and ","")))`;
    })
    .join('&');
}

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
    options: { note?: string | F; bold?: boolean; indent?: boolean } = {},
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
    const noteStyle = options.bold ? { ...ST.total(undefined, 'left'), font: ST.note().font } : ST.noteRun();
    if (typeof options.note === 'string') b.v(ws, 5, row, options.note, noteStyle);
    else if (options.note) b.f(ws, 5, row, options.note, noteStyle);
    r++;
    return row;
  };

  sub('Income');
  const rSalary = pair('salary', 'Salary for the year (monthly salary × months worked)', (_c, $) => `${$('u_ow')}*${$('u_months')}`, 'same', NF.int, {
    note: ($) =>
      `IF(${$('u_perYear')}=1,"Your yearly salary, counted as "&${dollarsText($('u_ow'))}&" a month.","")`,
  });
  const rBonus = pair('bonus', 'Bonus and other additional wages', (_c, $) => $('u_aw'), 'same', NF.int, {
    note: ($) => `IF(${$('u_odd')}>0,"Includes the "&${dollarsText($('u_odd'))}&" left over when your yearly salary was split into whole-dollar months.","")`,
  });
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
    'CPF cash top-up relief — self',
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
  const rGross = pair('gross', 'Tax on chargeable income', (c, $) => grossTax($, `${c}${rCi}`), undefined, NF.cents, { note: 'Bracket by bracket in section 6; rounded to cents once.' });
  pair('rebate', 'Less: personal income tax rebate', (c, $) => `${rebateCents($, `ROUND(${c}${rGross}*100,0)`)}/100`, undefined, NF.cents, { indent: true });
  const rTax = pair('tax', 'Tax payable', (c, $) => taxPayable($, `${c}${rCi}`), undefined, NF.cents, { bold: true });
  pair('marginal', 'Tax rate on your top dollar', (c, $) => marginalRate($, `${c}${rCi}`), undefined, NF.pct, { note: 'What one more dollar of relief saves.' });
  pair('effective', 'Tax as a share of total income', (c) => `IF(${c}${rTotal}=0,0,${c}${rTax}/${c}${rTotal})`, undefined, '0.00%');
  b.v(ws, 2, r, 'Tax saved by the plan', ST.total(undefined, 'left'));
  styleRow(ws, r, 3, LAST, ST.total(NF.cents));
  b.f(ws, 4, r, () => `ROUND(C${rTax}-D${rTax},2)`, ST.total(NF.cents));
  b.reg('w_taxSaved', ws, 4, r);
  r++;
  b.v(ws, 2, r, 'Saving per dollar locked away', ST.labelIndent());
  b.f(ws, 4, r, ($) => `IF(${$('w_X')}=0,0,${$('w_taxSaved')}/${$('w_X')})`, ST.value(NF.rate));
  b.reg('w_savingRate', ws, 4, r);
  b.v(ws, 5, r, 'Tax saved this year / cash locked away. For SRS, half of what you later withdraw is taxable.', ST.noteRun());
  r += 2;

  // ======================================================================================================
  // 2. Employee CPF
  // ======================================================================================================
  section('2 · Your compulsory CPF contributions (this is your CPF relief)');
  const bandCount = rules.cpf.fullRates.length;
  b.v(ws, 2, r, 'Rate table that applies to you', ST.label());
  mergeRow(ws, r, 3, LAST, ST.valueText());
  b.f(
    ws,
    3,
    r,
    ($) =>
      `IF(${$('u_res')}=3,"None: foreigners on work passes make no CPF contributions.",CHOOSE(${$('w_cpfTable')},"Citizens, and PRs from their 3rd year","PRs in their 1st year (graduated rates)","PRs in their 2nd year (graduated rates)"))`,
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

  ws.getRow(r).height = 44;
  b.v(ws, 2, r, 'Month', ST.th('left'));
  b.v(ws, 3, r, 'Worked?', ST.th());
  b.v(ws, 4, r, 'Age used for the CPF rate that month', ST.th());
  b.v(ws, 5, r, 'Employee rate', ST.th());
  b.v(ws, 6, r, 'Salary that attracts CPF', ST.th());
  b.v(ws, 7, r, 'Your share (cents dropped)', ST.th());
  // Which row of the rate table above applies: a working column, beside the table.
  const BAND = 11;
  b.v(ws, BAND, r, 'Row of the rate table used', ST.helperHead());
  r++;
  const mTop = r;
  MONTH_LABELS.forEach((month, index) => {
    const row = r;
    const m = index + 1;
    const band = a1(BAND, row);
    b.v(ws, 2, row, month, ST.td(undefined, 'left'));
    b.f(ws, 3, row, ($) => `IF(${m}>=13-${$('u_months')},1,0)`, ST.td(NF.yesNo));
    b.f(ws, 4, row, ($) => `IF(${m}<=${$('u_birthMonth')},${$('u_age')}-1,${$('u_age')})`, ST.td(NF.plain));
    b.f(ws, BAND, row, ($) => `MIN(${bandCount},1+COUNTIF(${$('w_effMax')},"<="&D${row}))`, ST.helper(NF.plain));
    b.f(ws, 5, row, ($) => `IF(AND(C${row}=1,${$('u_res')}<>3),INDEX(${$('w_effRate')},${band}),0)`, ST.td('0.0#%'));
    b.f(ws, 6, row, ($) => `IF(AND(C${row}=1,${$('u_res')}<>3),MIN(${$('u_ow')},${$('r_owCeiling')}),0)`, ST.td(NF.int));
    b.f(
      ws,
      7,
      row,
      ($) =>
        `IF(OR(C${row}=0,${$('u_res')}=3,${$('u_ow')}<=${$('r_nil')}),0,IF(${$('u_ow')}<=${$('r_phaseTo')},` +
        `${floorRateTimes(`INDEX(${$('w_effPhase')},${band})`, `(${$('u_ow')}-${$('r_nil')})`)},` +
        `${floorRateTimes(`E${row}`, `F${row}`)}))`,
      ST.td(NF.int),
    );
    r++;
  });
  const mEnd = r - 1;
  b.reg('w_decRate', ws, 5, mEnd);
  b.regRange('w_monthRates', ws, 5, mTop, 5, mEnd);
  b.v(
    ws,
    2,
    r,
    'The age is the one you had reached before the month began: a new CPF rate applies from the month after your 55th, 60th, 65th or 70th birthday.',
    ST.noteRun(),
  );
  r += 2;
  line('w_owSubject', 'Salary that attracted CPF in the year', () => `SUM(F${mTop}:F${mEnd})`, ST.value(NF.int));
  line(
    'w_awCeiling',
    'Ceiling for bonus (annual wage ceiling less the line above)',
    ($) => `IF(${$('u_res')}=3,0,MAX(0,${$('r_annualCeiling')}-${$('w_owSubject')}))`,
    ST.value(NF.int),
  );
  line('w_awSubject', 'Bonus that attracts CPF', ($) => `MIN(${$('u_aw')},${$('w_awCeiling')})`, ST.value(NF.int));
  line('w_empOW', 'Your share on salary', () => `SUM(G${mTop}:G${mEnd})`, ST.value(NF.int));
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
  b.f(
    ws,
    4,
    r,
    ($) => `IF(${$('u_res')}=3,${lit(CPF_SOURCE_WORDS.none)},IF(${$('u_overrideOn')}=1,${lit(CPF_SOURCE_WORDS.override)},${lit(CPF_SOURCE_WORDS.auto)}))`,
    { ...ST.total(undefined, 'left'), font: ST.note().font },
  );
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
  ws.getRow(r).height = 30;
  for (const lever of LEVERS) b.v(ws, lever.col, r, lever.title, ST.th());
  styleRow(ws, r, 6, LAST, ST.th('left'));
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
        ? `"no limit of your own"`
        : lever.id === 'cpfSelf'
          ? `IF(${$('u_selfLimitOn')}=1,${$('u_selfLimit')},IF(${$('u_age')}>=${ROOM_AGE},"needed: blank","none entered"))`
          : `IF(${$('u_famLimitOn')}=1,${$('u_famLimit')},"none entered")`,
    ST.value(NF.int),
    `Self: the top-up that can still earn relief, needed from age ${ROOM_AGE}. Family: the most you would give.`,
  );
  const rRoomIf = leverRow(
    'w_roomIfOn',
    'Room left if switched on',
    (lever, $, col) => {
      const statutory = `MAX(0,${col}${rCap}-${col}${rUsed})`;
      if (lever.id === 'srs') return statutory;
      if (lever.id === 'cpfFamily') return `IF(${$('u_famLimitOn')}=1,MIN(${statutory},${$('u_famLimit')}),${statutory})`;
      // SPEC §6.5: from age 55 a blank room means "not confirmed", so the room is 0 until a figure is entered.
      return `IF(${$('u_selfLimitOn')}=1,MIN(${statutory},${$('u_selfLimit')}),IF(${$('u_age')}>=${ROOM_AGE},0,${statutory}))`;
    },
    ST.value(NF.int),
    `From age ${ROOM_AGE}, your own CPF has no room until you enter it on the Planner.`,
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
  /** 1 when the person's own CPF is switched on, open to them and waiting for its room (SPEC §6.5, §6.11). */
  const awaitingRoom = ($: Resolver): string =>
    `AND(${$('u_age')}>=${ROOM_AGE},${$('u_selfLimitOn')}=0,${$('w_enabled_cpfSelf')}=1,${$('w_eligible_cpfSelf')}=1)`;

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
    'Limit 1: dollars that would each save at least your minimum',
    ($) => `MAX(${$('w_brRoomMin')})`,
    ST.value(NF.int),
    'Chargeable income above the start of the lowest bracket taxed at your minimum or more (section 6).',
  );
  line('w_C', 'Limit 2: room left under the overall relief cap', ($) => `MAX(0,${$('r_reliefCap')}-${$('w_base_totalBeforeCap')})`, ST.value(NF.int));
  line('w_L', 'Limit 3: room in the schemes you switched on', ($) => `SUM(${$('w_room_all')})`, ST.value(NF.int));
  line('w_B', 'Limit 4: your cash limit', ($) => `IF(${$('u_budgetOn')}=1,${$('u_budget')},"no limit")`, ST.value(NF.int));
  b.v(ws, 2, r, 'Plan total: the smallest of the four', ST.total(undefined, 'left'));
  styleRow(ws, r, 3, LAST, ST.total(undefined, 'left'));
  b.f(
    ws,
    3,
    r,
    ($) => `MIN(${$('w_U')},${$('w_C')},${$('w_L')},IF(${$('u_budgetOn')}=1,${$('u_budget')},${$('w_L')}))`,
    ST.total(NF.int),
  );
  b.reg('w_X', ws, 3, r);
  b.v(ws, 4, r, 'When two limits tie, the earlier one is named as the reason.', { ...ST.total(undefined, 'left'), font: ST.note().font });
  r++;
  b.v(ws, 2, r, 'Why the plan stops here', ST.label());
  b.f(ws, 3, r, ($) => {
    const X = $('w_X');
    const binding = $('w_binding');
    const optMarginal = $('w_opt_marginal');
    const moreCash = `IF(${$('w_saveMoreCash')}>0," With more cash you could save up to "&${taxText($('w_saveMoreCash'))}&" more.","")`;
    return (
      `IF(${binding}=0,${lit('You have no tax to pay for this year, so contributing more would not save anything.')},` +
      `IF(${binding}=1,IF(${X}=0,` +
      // "The minimum set on the Planner", not "the minimum you asked for": the cell starts at a default nobody chose.
      `"Nothing is recommended: each extra dollar would save "&${centsNumber($('w_base_marginal'))}&" cents or less, below the "&${centsNumber($('u_minRate'))}&" cents minimum set on the Planner. Choose a lower minimum there to see the smaller savings.",` +
      `IF(${optMarginal}=0,${lit('The plan takes your chargeable income down to the tax-free band. Anything more would save no tax.')},` +
      `"Beyond this, each extra dollar would save "&${centsNumber(optMarginal)}&" cents or less, below the "&${centsNumber($('u_minRate'))}&" cents minimum set on the Planner.")),` +
      `IF(${binding}=2,IF(${X}=0,` +
      `"Your reliefs have already reached the "&${dollarsText($('r_reliefCap'))}&" overall cap, so further contributions would earn no tax relief.",` +
      `"The plan stops where your total reliefs reach the "&${dollarsText($('r_reliefCap'))}&" overall cap. Anything more would earn no tax relief and cannot be refunded."),` +
      `IF(${binding}=3,IF(${$('w_L')}=0,` +
      `IF(SUM(${$('w_enabled_all')})=0,${lit('No scheme is switched on, so there is nothing to recommend. Switch on SRS or a CPF top-up on the left.')},` +
      `IF(SUMPRODUCT(${$('w_enabled_all')}*${$('w_eligible_all')})=0,${lit('None of the schemes you switched on is open to you, so nothing can be contributed.')},` +
      `IF(${awaitingRoom($)},${lit('Nothing can be contributed yet: your own CPF is left out until you enter its room, and no other scheme you switched on has room left.')},` +
      `${lit('The schemes you switched on have no room left this year, so nothing more can be contributed.')}))),` +
      `"You have used all the room in the schemes you switched on."&IF(${optMarginal}>0," "&${dollarsText(`(${$('w_opt_ci')}-${$('w_optBandFrom')})`)}&" of your income is still taxed at "&${centsNumber(optMarginal)}&"%.","")),` +
      `"Your cash limit of "&${dollarsText($('u_budget'))}&" is used up."&${moreCash}))))` +
      // The page's sentence for a plan that leaves the person's own CPF out, unless the reason above already says so.
      `&IF(AND(${awaitingRoom($)},NOT(AND(${binding}=3,${$('w_L')}=0)))," ${LEFT_OUT}","")`
    );
  });
  ws.getRow(r).height = 30;
  mergeRow(ws, r, 3, LAST, { ...ST.note(), font: { ...ST.note().font, size: 10, color: { argb: C.ink } } });
  b.reg('w_reasonText', ws, 3, r);
  r++;
  // What ONE change of setting could still save (SPEC §6.11): figures the person can actually reach.
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
    'Still held to your minimum, the relief cap and your cash limit.',
  );
  line(
    'w_saveSwitchOn',
    '… and the extra tax that would save',
    ($) => `ROUND(${$('w_opt_tax')}-${taxPayable($, `MAX(0,${$('w_base_ci')}-${$('w_reachSwitch')})`)},2)`,
    ST.value(NF.cents),
  );
  r++;

  // ======================================================================================================
  // 5. Warnings
  // ======================================================================================================
  section('5 · The checks behind "Things to check" on the Planner');
  b.v(ws, 2, r, 'Shown when …', ST.th('left'));
  b.v(ws, 3, r, 'Applies now?', ST.th());
  mergeRow(ws, r, 4, LAST, ST.th('left')).value = 'What the Planner says when it applies';
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
  /** "7.5 cents": a rate as the engine writes cents per dollar. */
  const centsOf = (ref: string): string => `${rateNumber(ref)}&" cents"`;

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
      when: ($) => `${$('w_binding')}=2`,
      text: ($) =>
        `IF(${$('w_X')}>0,"the plan stops at "&${dollarsText($('w_X'))}&" because that brings your total reliefs to the "&${cap($)}&" overall cap. Anything you contribute beyond that earns no tax relief and cannot be refunded.",` +
        `"your reliefs have already reached the "&${cap($)}&" overall cap, so further SRS or CPF contributions would earn no tax relief.")`,
    },
    BELOW_MIN_SAVING_RATE: {
      severity: 'info',
      when: ($) => `AND(${$('w_base_tax')}>0,${$('w_U')}=0)`,
      text: ($) =>
        `"every extra dollar you contribute would save at most "&${pctText($('w_base_marginal'))}&" in tax, below your "&${pctText($('u_minRate'))}&" minimum, so nothing is recommended. Lower the minimum to see these smaller savings."`,
    },
    BUDGET_LIMITS_PLAN: {
      severity: 'info',
      when: ($) => `AND(${$('w_binding')}=4,${$('u_budgetOn')}=1)`,
      text: ($) => `"your cash limit of "&${dollarsText($('u_budget'))}&" is what stops the plan."&${couldSave($, 'w_saveMoreCash', 'With more cash you')}`,
    },
    LEVER_LIMITS_PLAN: {
      severity: 'info',
      when: ($) => `${$('w_binding')}=3`,
      // Why there is no more room, in words that are true for this person, then what the schemes left off could add.
      text: ($) =>
        `IF(${$('w_L')}>0,"the plan uses all "&${dollarsText($('w_L'))}&" of room left in the schemes you switched on.",` +
        `IF(SUM(${$('w_enabled_all')})=0,"no scheme is switched on, so nothing can be contributed.",` +
        `IF(SUMPRODUCT(${$('w_enabled_all')}*${$('w_eligible_all')})=0,"none of the schemes you switched on is open to you, so nothing can be contributed.",` +
        `IF(${awaitingRoom($)},${lit('nothing can be contributed yet: your own CPF is left out until you enter its room, and no other scheme you switched on has room left.')},` +
        `"the schemes you switched on have no room left this year, so nothing more can be contributed."))))&${couldSave($, 'w_saveSwitchOn', 'Switching on the schemes you left off')}`,
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
        `"the employee CPF you entered ("&${dollarsText($('u_override'))}&") is more than the largest compulsory contribution possible in a year ("&${dollarsText($('w_maxCompulsory'))}&"), so "&${dollarsText($('w_maxCompulsory'))}&" is used. "&` +
        lit("Voluntary contributions to your three CPF accounts earn no relief; a cash top-up to your MediSave, Special or Retirement Account does — enter it under 'Already contributed'."),
    },
    FOREIGNER_NO_CPF: {
      severity: 'info',
      when: ($) => `${$('u_res')}=3`,
      // The SRS sentence is left out when SRS is not open to the user either (below the minimum age).
      text: ($) =>
        `"foreigners on work passes do not contribute to CPF, so there is no CPF relief and CPF top-ups do not earn tax relief."&IF(${$('w_eligible_srs')}=1," You can put up to "&${dollarsText($('w_cap_srs'))}&" a year into SRS.","")`,
    },
    TAX_RESIDENCY_CHECK: {
      severity: 'caution',
      when: ($) => `AND(${$('u_res')}=3,${$('u_months')}<=6)`,
      text: () =>
        lit(
          'you worked here for half the year or less. You are a tax resident only if you were in Singapore for at least 183 days (IRAS has further rules for stays that span two years). Non-residents get no reliefs, so this plan would not apply.',
        ),
    },
    SRS_NON_RESIDENT_WITHDRAWAL: {
      severity: 'caution',
      when: ($) => `AND(${$('u_res')}=3,${$('w_enabled_srs')}=1,${$('w_eligible_srs')}=1)`,
      text: ($) =>
        `"if you have left Singapore when you withdraw, SRS is taxed as a non-resident's: at least "&${centsOf($('r_nrCost'))}&" per dollar withdrawn at retirement age or under the 10-year rule for foreigners, and at least "&${centsOf($('r_nrCostEarly'))}&" if earlier."` +
        `&IF(${$('w_lowValue')}>0," "&${dollarsText($('w_lowValue'))}&" of this plan saves less than "&${centsOf($('r_nrCost'))}&" per dollar today.","")`,
    },
    PR_GRADUATED_RATES: {
      severity: 'info',
      when: ($) => `AND(${$('u_res')}=2,${$('u_prYear')}<3)`,
      text: ($) =>
        `"as a permanent resident in your "&IF(${$('u_prYear')}=1,"1st","2nd")&" year you pay reduced (graduated) CPF rates, so your CPF relief is smaller than at full rates. If you have opted to pay full rates, choose ""3rd year onwards""."`,
    },
    CPF_SELF_ROOM_UNCONFIRMED: {
      severity: 'caution',
      when: ($) => awaitingRoom($),
      text: ($) =>
        `"from age ${ROOM_AGE} the CPF Board accepts top-ups up to the Enhanced Retirement Sum ("&${dollarsText($('r_ers'))}&"), but only the part up to the Full Retirement Sum ("&${dollarsText($('r_frs'))}&") earns relief, and a top-up cannot be reversed. "&` +
        lit('Your own CPF is left out until you enter how much you can still top up with relief (S$0 if you have set aside the Full Retirement Sum).'),
    },
    AGE_55_PLUS_TOPUP: {
      severity: 'info',
      when: ($) => `AND(${$('u_age')}>=${ROOM_AGE},${$('u_selfLimitOn')}=1,${$('w_enabled_cpfSelf')}=1,${$('w_eligible_cpfSelf')}=1)`,
      text: ($) =>
        `"from age ${ROOM_AGE}, cash top-ups go to your Retirement Account and earn relief only up to the Full Retirement Sum ("&${dollarsText($('r_frs'))}&" in "&${$('r_incomeYear')}&"). The plan uses the room you entered ("&${dollarsText($('u_selfLimit'))}&"); check it against your CPF Retirement dashboard."`,
    },
    FAMILY_TOPUP_CHECKS: {
      severity: 'caution',
      when: ($) => `AND(${$('w_eligible_cpfFamily')}=1,OR(${$('w_plan_cpfFamily')}>0,${$('u_exFam')}>0))`,
      text: ($) =>
        `"family top-ups: the part the Government matches earns you no relief — the first "&${dollarsText($('r_matchedRetirement'))}&" a year for a member on the Matched Retirement Savings Scheme"` +
        `&IF(${isNum($('r_matchedMediSave'))},", "&${dollarsText($('r_matchedMediSave'))}&" for MediSave","")&". The amounts here are top-ups beyond that, to a family member who qualifies."`,
    },
    PARENTHOOD_TAX_REBATE: {
      severity: 'caution',
      when: ($) => `${$('u_ptr')}=1`,
      text: () =>
        lit(
          'with unused Parenthood Tax Rebate your tax bill this year may already be S$0. This plan would then save no cash now: it makes the rebate last longer, so the benefit arrives in a later year.',
        ),
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
      // Only the cut-off of a scheme that is in the plan is mentioned (SPEC §6.11).
      text: ($) =>
        `IF(${$('m_days')}=0,"today, "&${deadlineText($)}&", is the deadline.","only "&${$('m_days')}&IF(${$('m_days')}=1," day"," days")&" left until the "&${deadlineText($)}&" deadline.")&" "&${$('w_cutOffs')}&", so transfer as soon as you can."`,
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
  /** Working columns beside the table: how many Planner lines the row gives, the running total, and their text. */
  const LINES = { count: 11, soFar: 12, first: 13, last: 15 } as const;
  const checkRow = (code: (typeof WARNING_CODES)[number] | (typeof WORKBOOK_CHECKS)[number], check: Omit<Check, 'shownWhen'>, shownWhen: string): void => {
    const row = r;
    const label = `When ${shownWhen}`;
    b.v(ws, 2, row, label, ST.tdWrap({ size: 10, color: { argb: C.muted } }));
    b.f(ws, 3, row, ($) => `IF(${check.when($)},1,0)`, ST.td(NF.yesNo));
    b.f(ws, LINES.soFar, row, () => `SUM(${colLetter(LINES.count)}$${wTop}:${colLetter(LINES.count)}${row})`, ST.helper(NF.plain));
    // Room for the longest this message can be (see MESSAGE_LINES).
    ws.getRow(row).height = Math.max(heightOfLines(MESSAGE_LINES[code] ?? 2, MESSAGE_FONT), heightFor(label, 58, 10));
    mergeRow(ws, row, 4, LAST, ST.tdWrap({ size: MESSAGE_FONT, color: { argb: C.faint } }));
    b.f(ws, 4, row, ($) => `IF(C${row}=1,"${lead[check.severity]}"&${check.text($)},"")`);
    const lines = check.lines;
    if (lines) {
      b.f(ws, LINES.count, row, ($) => `IF(C${row}=1,${lines.count($)},0)`, ST.helper(NF.plain));
      lines.text.forEach((text, index) => {
        b.f(ws, LINES.first + index, row, ($) => `IF(${a1(LINES.count, row)}>${index},"${lead[check.severity]}"&${text($)},"")`, ST.helper(undefined, 'left'));
      });
    } else {
      b.f(ws, LINES.count, row, () => `C${row}`, ST.helper(NF.plain));
      b.f(ws, LINES.first, row, () => `IF(C${row}=1,D${row},"")`, ST.helper(undefined, 'left'));
      // A message of one sentence has no second or third line.
    }
    r++;
  };
  ws.getRow(wTop - 1).height = 30;
  b.v(ws, LINES.count, wTop - 1, 'Lines it gives on the Planner', ST.helperHead());
  b.v(ws, LINES.soFar, wTop - 1, 'Lines so far', ST.helperHead());
  b.v(ws, LINES.first, wTop - 1, 'Line 1', ST.helperHead('left'));
  b.v(ws, LINES.first + 1, wTop - 1, 'Line 2', ST.helperHead('left'));
  b.v(ws, LINES.last, wTop - 1, 'Line 3', ST.helperHead('left'));
  for (const code of WORKBOOK_CHECKS) checkRow(code, workbookChecks[code], workbookChecks[code].shownWhen);
  const codesTop = r;
  for (const code of WARNING_CODES) checkRow(code, warnings[code], SHOWN_WHEN[code]);
  const wEnd = r - 1;
  // Messages that apply right now stand out; the rows that do not apply stay grey.
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
  b.regRange('w_warnShownWhen', ws, 2, codesTop, 2, wEnd);
  b.regRange('w_warnFlags', ws, 3, codesTop, 3, wEnd);
  b.regRange('w_warnMessages', ws, 4, codesTop, 4, wEnd);
  b.regRange('w_warnCount', ws, LINES.soFar, wTop, LINES.soFar, wEnd);
  b.regRange('w_warnLineCount', ws, LINES.count, wTop, LINES.count, wEnd);
  b.regRange('w_warnLines', ws, LINES.first, wTop, LINES.last, wEnd);
  r += 1;

  // ======================================================================================================
  // 6. Tax by bracket
  // ======================================================================================================
  section('6 · Tax by bracket');
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
  ws.getRow(r).height = 44;
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
  const printEnd = brTop + rules.taxBrackets.length - 1;
  r = brEnd + 2;

  // ======================================================================================================
  // 7. Working cells (out of the way: below everything a reader needs, and outside the printed pages)
  // ======================================================================================================
  section('7 · Working cells: what the formulas read and build (you can skip this)');
  b.v(
    ws,
    2,
    r,
    'Your Planner entries as the formulas read them: blanks, text and negative numbers count as 0, cents are dropped, and out-of-range entries are pulled back into range.',
    ST.noteRun(),
  );
  r++;
  const used = (key: string, label: string, formula: F, numFmt: string | undefined, note = ''): void => {
    line(key, label, formula, numFmt === undefined ? ST.helper(undefined, 'left') : ST.helper(numFmt), note, ST.labelIndent());
  };
  const optional = (onKey: string, valueKey: string, label: string, inputKey: string): void => {
    used(onKey, `${label}: entered? (1 = yes)`, ($) => `IF(${isNum($(inputKey))},1,0)`, NF.plain);
    used(valueKey, `${label}: amount`, ($) => moneyOf($(inputKey)), NF.int);
  };
  used('u_res', 'Residency (1 Citizen, 2 PR, 3 foreigner)', ($) => `IFERROR(MATCH(${$('in_residency')},${$('l_residency')},0),1)`, NF.plain);
  used('u_prYear', 'PR year (3 = third year onwards)', ($) => `IF(${$('u_res')}=2,IFERROR(MATCH(${$('in_prYear')},${$('l_prYear')},0),3),3)`, NF.plain);
  used('w_cpfTable', 'CPF rate table (1 full rates, 2 PR 1st year, 3 PR 2nd year)', ($) => `IF(${$('u_res')}=2,CHOOSE(${$('u_prYear')},2,3,1),1)`, NF.plain);
  used('u_age', 'Age on 31 December', ($) => `IF(${isNum($('in_age'))},MIN(120,MAX(0,INT(${$('in_age')}))),0)`, NF.plain);
  used('u_birthMonth', 'Birth month (1–12)', ($) => `IFERROR(MATCH(${$('in_birthMonth')},${$('l_months')},0),12)`, NF.plain);
  used('u_salary', 'Salary as typed', ($) => moneyOf($('in_salary')), NF.int);
  used('u_perYear', 'Salary typed per year? (1 = yes)', ($) => `IF(${$('in_salaryPeriod')}="${SALARY_PERIODS[1]}",1,0)`, NF.plain);
  used(
    'u_ow',
    'Monthly salary',
    ($) => `IF(${$('u_perYear')}=1,INT(${$('u_salary')}/12),${$('u_salary')})`,
    NF.int,
    'A yearly salary is split into twelve equal months of whole dollars.',
  );
  used('u_months', 'Months worked (1–12)', ($) => `IF(${isNum($('in_monthsWorked'))},MIN(12,MAX(1,INT(${$('in_monthsWorked')}))),12)`, NF.plain);
  used(
    'u_odd',
    'Dollars of a yearly salary left over by the split',
    ($) => `IF(${$('u_perYear')}=1,MAX(0,INT(${$('u_salary')}*${$('u_months')}/12)-${$('u_ow')}*${$('u_months')}),0)`,
    NF.int,
    'Counted with the bonus, so your income is right to the dollar.',
  );
  used('u_bonus', 'Bonus as typed', ($) => moneyOf($('in_additionalWages')), NF.int);
  used('u_aw', 'Bonus and other additional wages, with the left-over dollars', ($) => `MIN(${MAX_MONEY},${$('u_bonus')}+${$('u_odd')})`, NF.int);
  used('u_otherIncome', 'Other taxable income', ($) => moneyOf($('in_otherIncome')), NF.int);
  used('u_expenses', 'Employment expenses', ($) => moneyOf($('in_employmentExpenses')), NF.int);
  used('u_donations', 'Donations', ($) => moneyOf($('in_donations')), NF.int);
  // SPEC §6.0: the CPF figure replaces a calculated one, so only a number of 0 or more counts as entered. A negative
  // number is "not entered" (the worked-out figure is used) rather than a figure of 0, which would remove the relief.
  used('u_overrideOn', 'Actual employee CPF: entered? (1 = yes)', ($) => `IF(${isNum($('in_cpfOverride'))},IF(${$('in_cpfOverride')}>=0,1,0),0)`, NF.plain);
  used('u_override', 'Actual employee CPF: amount', ($) => moneyOf($('in_cpfOverride')), NF.int);
  used('u_exSrs', 'Already in SRS', ($) => moneyOf($('in_existingSrs')), NF.int);
  used('u_exSelf', 'Already topped up, self', ($) => moneyOf($('in_existingCpfSelf')), NF.int);
  used('u_exFam', 'Already topped up, family', ($) => moneyOf($('in_existingCpfFamily')), NF.int);
  used('u_otherReliefs', 'Other reliefs', ($) => moneyOf($('in_otherReliefs')), NF.int);
  used('u_ptr', 'Unused Parenthood Tax Rebate? (1 = yes)', ($) => `IF(${$('in_unusedPtr')}="${YES}",1,0)`, NF.plain);
  optional('u_budgetOn', 'u_budget', 'Cash limit', 'in_cashBudget');
  used('u_enSrs', 'Use SRS? (1 = yes)', ($) => `IF(${$('in_useSrs')}="${YES}",1,0)`, NF.plain);
  used('u_enSelf', 'Use CPF top-up, self? (1 = yes)', ($) => `IF(${$('in_useCpfSelf')}="${YES}",1,0)`, NF.plain);
  optional('u_selfLimitOn', 'u_selfLimit', 'Top-up to your own CPF that can still earn relief', 'in_cpfSelfRoom');
  used('u_enFam', 'Use CPF top-up, family? (1 = yes)', ($) => `IF(${$('in_useCpfFamily')}="${YES}",1,0)`, NF.plain);
  optional('u_famLimitOn', 'u_famLimit', 'Most you would give to family', 'in_cpfFamilyMax');
  used('u_minRate', 'Smallest saving per dollar', ($) => `IF(${isNum($('in_minSavingRate'))},MIN(1,MAX(0,${$('in_minSavingRate')})),0)`, NF.pct);
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

  b.v(ws, 2, r, 'Working figures behind the plan and the sentences on the Planner.', ST.noteRun());
  r++;
  used(
    'w_binding',
    'Limit that stops the plan (1 to 4 as in section 4; 0 = there is no tax to save)',
    ($) => `IF(${$('w_base_tax')}=0,0,IF(${$('w_U')}<=${$('w_X')},1,IF(${$('w_C')}<=${$('w_X')},2,IF(${$('w_L')}<=${$('w_X')},3,4))))`,
    NF.plain,
  );
  used(
    'w_selfUnconfirmed',
    `Room for your own CPF needed and not entered? (1 = yes: ${ROOM_AGE} or over, open to you, cell blank)`,
    ($) => `IF(AND(${$('u_age')}>=${ROOM_AGE},${$('u_selfLimitOn')}=0,${$('w_eligible_cpfSelf')}=1),1,0)`,
    NF.plain,
  );
  used('w_U0', 'Dollars of relief before your income is tax-free', ($) => `MAX(${$('w_brRoomAny')})`, NF.int, 'Used on the Scenarios sheet to count wasted dollars.');
  used('w_optBandFrom', 'Start of the bracket your top dollar is in, after the plan', ($) => `MAX(${$('w_brStartOpt')})`, NF.int);
  used(
    'w_lowValue',
    'Dollars of the plan that save less than a non-resident pays to take SRS out',
    ($) => `SUMPRODUCT((ROUND(${$('lad_wRate')}*1000,0)<ROUND(${$('r_nrCost')}*1000,0))*${$('lad_wUsed')})`,
    NF.int,
    'From the rungs on the Ladder sheet.',
  );
  used(
    'w_cutOffs',
    'Cut-offs of the schemes in the plan (for the deadline messages)',
    ($) => {
      const banks = lit('Banks stop taking same-day SRS contributions before midnight on the last day, some as early as 7pm');
      const board = lit('CPF top-up counts on the day the CPF Board receives it');
      return `IF(AND(${$('w_plan_srs')}>0,${$('w_plan_cpfSelf')}+${$('w_plan_cpfFamily')}>0),${banks}&", and a "&${board},IF(${$('w_plan_srs')}>0,${banks},"A "&${board}))`;
    },
    undefined,
  );
  // The recommendation as a sentence, as the web page words it (SPEC §9): one part per scheme in the plan, in the
  // order the schemes are filled.
  const PART: Record<(typeof LEVERS)[number]['id'], string> = {
    srs: 'into SRS',
    cpfSelf: 'into your CPF as a cash top-up',
    cpfFamily: "into family members' CPF as a cash top-up",
  };
  for (const lever of LEVERS) {
    used(
      `w_part_${lever.id}`,
      `Sentence part: ${lever.title}`,
      ($) => `IF(${$(`w_plan_${lever.id}`)}>0,${dollarsText($(`w_plan_${lever.id}`))}&" ${PART[lever.id]}","")`,
      undefined,
    );
  }
  for (const position of [1, 2, 3]) {
    used(
      `w_slot_${position}`,
      `Sentence part filled ${['first', 'second', 'third'][position - 1]}`,
      ($) => `IF(${$('w_rank_srs')}=${position},${$('w_part_srs')},IF(${$('w_rank_cpfSelf')}=${position},${$('w_part_cpfSelf')},${$('w_part_cpfFamily')}))`,
      undefined,
    );
  }
  used('w_slotCount', 'Schemes in the plan', ($) => [1, 2, 3].map((position) => `IF(${$(`w_slot_${position}`)}="",0,1)`).join('+'), NF.plain);
  used('w_planList', 'The plan as a list', ($) => joinList([$('w_slot_1'), $('w_slot_2'), $('w_slot_3')]), undefined);
  used(
    'w_headline',
    'The recommendation as a sentence',
    ($) => {
      const ya = `"YA"&${$('r_ya')}`;
      const shortDeadline = `DAY(${$('m_deadline')})&" "&LEFT(INDEX(${$('l_months')},MONTH(${$('m_deadline')})),3)&" "&YEAR(${$('m_deadline')})`;
      return (
        `IF(${$('m_days')}<0,"The deadline for "&${ya}&" has passed. "&IF(${$('w_slotCount')}=0,"On these numbers there was nothing more worth putting in for "&${ya}&".",` +
        `"Putting "&${$('w_planList')}&" by "&${shortDeadline}&" would have saved "&${taxText($('w_taxSaved'))}&" in tax for "&${ya}&"."),` +
        // "Nothing more this year" would be wrong while the person's own CPF is only waiting for a figure.
        `IF(${$('w_slotCount')}=0,IF(AND(${awaitingRoom($)},${$('w_binding')}=3),"Nothing to put in yet.","Nothing more to put in this year."),` +
        `"Put "&${$('w_planList')}&". You save "&${taxText($('w_taxSaved'))}&" in tax."))`
      );
    },
    undefined,
  );
  // How long the cash is locked away (SPEC §8.4, `lockUpHorizon`), only for the schemes in the plan.
  used('w_srsYears', 'Years until SRS can be withdrawn without penalty', ($) => `MAX(0,${$('r_srsRetAge')}-${$('u_age')})`, NF.plain);
  used('w_cpfYears', 'Years until CPF payouts can start', ($) => `MAX(0,${$('r_payoutAge')}-${$('u_age')})`, NF.plain);
  const span = (key: string, $: Resolver): string =>
    `IF(${$(key)}>0,"about "&${$(key)}&IF(${$(key)}=1," year"," years"),"an age you have already reached")`;
  const horizonOf: Record<(typeof LEVERS)[number]['id'], F> = {
    // The age is the one a first contribution made this year locks in. A foreigner can also take SRS out under
    // the 10-year rule for foreigners, which for most comes first: their line names it, as the page's does.
    srs: ($) =>
      `"SRS: locked until "&${$('r_srsRetAge')}&", "&${span('w_srsYears', $)}&IF(AND(${$('u_res')}=3,${$('w_srsYears')}>0),"${TEN_YEAR_RULE}","")&"."`,
    cpfSelf: ($) => `"CPF: paid out monthly from "&${$('r_payoutAge')}&", "&${span('w_cpfYears', $)}&"."`,
    // A family top-up is not locked for a time, it is given away: the engine's own sentence for "if you need it
    // sooner" (`lockUpFacts`), as on the web page.
    cpfFamily: () => lit(`Family top-up: ${factSentence(rules, 'sooner', 'cpfFamily')}`),
  };
  for (const lever of LEVERS) {
    used(`w_hz_${lever.id}`, `Lock-up line: ${lever.title}`, ($) => `IF(${$(`w_plan_${lever.id}`)}>0,${horizonOf[lever.id]($)},"")`, undefined);
  }
  for (const position of [1, 2, 3]) {
    used(
      `w_hzSlot_${position}`,
      `Lock-up line shown ${['first', 'second', 'third'][position - 1]}`,
      ($) => `IF(${$('w_rank_srs')}=${position},${$('w_hz_srs')},IF(${$('w_rank_cpfSelf')}=${position},${$('w_hz_cpfSelf')},${$('w_hz_cpfFamily')}))`,
      undefined,
    );
  }
  used(
    'w_horizon',
    'How long the cash is locked away, in words',
    ($) => {
      const [first, second, third] = [1, 2, 3].map((position) => $(`w_hzSlot_${position}`)) as [string, string, string];
      return (
        `IF(${$('m_days')}<0,"",${first}&IF(AND(${first}<>"",OR(${second}<>"",${third}<>""))," ","")&${second}&IF(AND(${second}<>"",${third}<>"")," ","")&${third})`
      );
    },
    undefined,
  );
  // Said straight after the lines, as on the page: the SRS age shown is for a first contribution made now.
  used(
    'w_horizonNote',
    'The condition on the SRS age, in words',
    ($) =>
      `IF(AND(${$('m_days')}>=0,${$('w_plan_srs')}>0,${$('w_srsYears')}>0),"${SRS_AGE_NOTE[0]}"&${$('r_srsRetAge')}&"${SRS_AGE_NOTE[1]}","")`,
    undefined,
  );
  // Which of the example's figures are still in the cream cells (SPEC §9: the banner names them).
  const exampleFigures: Array<[string, string, F]> = [
    ['age', 'age', ($) => `${$('in_age')}=${EXAMPLE.age}`],
    ['salary', 'salary', ($) => `AND(${$('in_salary')}=${EXAMPLE.salary},${$('u_perYear')}=0)`],
    ['bonus', 'bonus', ($) => `${$('in_additionalWages')}=${EXAMPLE.additionalWages}`],
    ['reliefs', 'other reliefs', ($) => `${$('in_otherReliefs')}=${EXAMPLE.otherReliefs}`],
  ];
  for (const [key, name, same] of exampleFigures) {
    used(`w_ex_${key}`, `Still the example's ${name}?`, ($) => `IF(${same($)},"${name}","")`, undefined);
  }
  used('w_exCount', "Example figures still in use", ($) => exampleFigures.map(([key]) => `IF(${$(`w_ex_${key}`)}="",0,1)`).join('+'), NF.plain);
  used(
    'w_exList',
    'Their names as a list',
    ($) =>
      joinList(exampleFigures.map(([key]) => $(`w_ex_${key}`))),
    undefined,
  );

  view(ws, 2);
  // Print down to the brackets the year starts with; widen the print area if you add brackets. The working cells
  // of section 7 are below it and are not printed.
  pageSetup(ws, { landscape: true, lastCol: 'I', lastRow: printEnd, titleRows: '1:1' });
  return ws;
}
