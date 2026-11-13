/**
 * The Monthly Plan sheet (SPEC §6.10): the recommended contributions as instalments from the "as at" month to
 * December, the days left, and what the same plan would cost per month over a full year.
 */
import type ExcelJS from 'exceljs';
import { DISCLAIMER } from '../../src/engine/facts';
import { Book, C, NF, SHEETS, ST, dollarsText, isNum, longDate, mergeRow, pageSetup, setWidths, styleRow, view } from '../kit';
import type { Resolver } from '../kit';
import { LEVER_NAMES } from './rules';

const LEVERS = [
  { id: 'srs', title: LEVER_NAMES.srs, col: 3 },
  { id: 'cpfSelf', title: LEVER_NAMES.cpfSelf, col: 4 },
  { id: 'cpfFamily', title: LEVER_NAMES.cpfFamily, col: 5 },
] as const;

export function buildMonthly(b: Book): ExcelJS.Worksheet {
  const ws = b.sheet(SHEETS.monthly, C.good);
  setWidths(ws, [2, 44, 17, 21, 22, 19, 62, 3, 10]);
  const LAST = 7;

  ws.getRow(1).height = 32;
  mergeRow(ws, 1, 2, LAST, ST.title()).value = 'Your monthly plan';
  ws.getRow(2).height = 34;
  mergeRow(ws, 2, 2, LAST, ST.subtitle()).value =
    'The recommended contributions spread evenly over the months left this year, counting the current month. ' +
    'You can also pay it all at once: what matters is that the money arrives before the deadline.';

  let r = 4;
  b.v(ws, 2, r, 'As at (today, unless you type another date)', ST.label());
  b.v(ws, 3, r, { formula: 'TODAY()' } as ExcelJS.CellFormulaValue, ST.input(NF.date));
  ws.getCell(r, 3).dataValidation = {
    type: 'date',
    operator: 'between',
    formulae: [new Date(Date.UTC(2000, 0, 1)), new Date(Date.UTC(2100, 11, 31))],
    allowBlank: true,
    showErrorMessage: true,
    errorStyle: 'stop',
    errorTitle: 'Date',
    error: 'Enter a date, for example 15/11/2026.',
    showInputMessage: true,
    promptTitle: 'As at',
    prompt: 'Starts as today (=TODAY()). Type a date to plan as if it were that day; clear the cell to go back to today.',
  };
  b.reg('in_asAtDate', ws, 3, r);
  b.define('in_asAtDate', 'in_asAtDate');
  b.v(ws, 4, r, 'The plan counts instalments from this month.', ST.noteRun());
  r++;

  const fact = (key: string, name: string | null, label: string, formula: ($: Resolver) => string, numFmt: string, note = ''): void => {
    b.v(ws, 2, r, label, ST.label());
    b.f(ws, 3, r, formula, ST.value(numFmt, { bold: true }));
    b.reg(key, ws, 3, r);
    if (name) b.define(name, key);
    if (note) b.v(ws, 4, r, note, ST.noteRun());
    r++;
  };
  fact(
    'm_deadline',
    'out_deadline',
    'Last day a contribution counts for this year',
    // From the Rules sheet; 31 December of the income year if the cell there does not hold a date.
    ($) => `IF(${isNum($('r_deadline'))},INT(${$('r_deadline')}),DATE(${$('r_incomeYear')},12,31))`,
    NF.date,
    "The Before You Transfer sheet gives the banks' and the CPF Board's cut-offs.",
  );
  fact('m_days', null, 'Days to the deadline', ($) => `${$('m_deadline')}-${$('u_today')}`, NF.int);
  fact(
    'm_monthsRemaining',
    null,
    'Months left to contribute (this month counts)',
    ($) =>
      `IF(YEAR(${$('u_today')})<${$('r_incomeYear')},12,IF(YEAR(${$('u_today')})>${$('r_incomeYear')},0,12-MONTH(${$('u_today')})+1))`,
    NF.plain,
  );
  fact('m_total', null, 'Total to contribute (from the Planner)', ($) => $('w_X'), NF.dollars);
  ws.getRow(r).height = 30;
  mergeRow(ws, r, 2, LAST, ST.banner());
  b.reg('m_banner', ws, 2, r);
  b.f(
    ws,
    2,
    r,
    ($) =>
      // After the deadline the table is empty unless the deadline was moved earlier than 31 December and the
      // year has not ended (SPEC §6.10 counts months, not the deadline); the banner says which.
      `IF(${$('m_days')}<0,IF(AND(${$('m_monthsRemaining')}>0,${$('w_X')}>0),` +
      `"The deadline for "&${$('r_incomeYear')}&" passed on "&${longDate($, $('m_deadline'))}&". The amounts below are listed only because the year has not ended: money paid in now counts for the following year.",` +
      `"The deadline for "&${$('r_incomeYear')}&" has passed ("&${longDate($, $('m_deadline'))}&"). Contributions made now count for next year, so no instalments are shown."),` +
      `IF(${$('w_X')}=0,"Nothing more is recommended for "&${$('r_incomeYear')}&", so there are no instalments. The Planner explains why.",` +
      // The cut-offs are the engine's words, and only for the schemes that are in the plan (SPEC §6.11, §8.4).
      `IF(${$('m_days')}=0,"Today is the deadline. "&${$('w_cutOffs')}&", so transfer now.",` +
      `IF(${$('m_days')}<=14,"Only "&${$('m_days')}&IF(${$('m_days')}=1," day"," days")&" left. "&${$('w_cutOffs')}&", so transfer as soon as you can.",` +
      `"Set aside the amounts below in each of the "&${$('m_monthsRemaining')}&IF(${$('m_monthsRemaining')}=1," month"," months")&" left to reach S$"&TEXT(${$('w_X')},"#,##0")&" by "&${longDate($, $('m_deadline'))}&". Aim to transfer a few working days early."))))`,
  );
  r++;
  // The affordability note (SPEC §8.4): said only when a month's instalment is more than a month's salary.
  ws.getRow(r).height = 30;
  mergeRow(ws, r, 2, LAST, { ...ST.note(), font: { ...ST.note().font, size: 10, bold: true, color: { argb: C.warn } } });
  b.reg('m_afford', ws, 2, r);
  b.define('out_affordability', 'm_afford');
  b.f(
    ws,
    2,
    r,
    ($) =>
      `IF(AND(${$('m_days')}>=0,${$('u_ow')}>0,COUNT(${$('out_sched_total')})>0),IF(MAX(${$('out_sched_total')})>${$('u_ow')},` +
      `${dollarsText(`MAX(${$('out_sched_total')})`)}&" a month is more than your monthly salary. It would have to come from your bonus or savings. ` +
      `If that is more than you can spare, enter the most you can under ""Most cash you can spare this year"" on the Planner.",""),"")`,
  );
  r += 2;

  // Schedule.
  const head = r;
  ws.getRow(head).height = 26;
  b.v(ws, 2, head, 'Month', ST.th('left'));
  for (const lever of LEVERS) b.v(ws, lever.col, head, lever.title, ST.th());
  b.v(ws, 6, head, 'Total for the month', ST.th());
  b.v(ws, 7, head, '', ST.th('left'));
  b.v(ws, 9, head, 'Counted?', ST.helperHead());
  r++;
  const top = r;
  for (let m = 1; m <= 12; m++) {
    const row = r;
    b.f(ws, 2, row, ($) => `DATE(${$('r_incomeYear')},${m},1)`, ST.td(NF.month, 'left'));
    b.f(
      ws,
      9,
      row,
      ($) => `IF(AND(${$('m_monthsRemaining')}>0,${$('w_X')}>0,${m}>=13-${$('m_monthsRemaining')}),1,0)`,
      ST.helper(NF.plain),
    );
    for (const lever of LEVERS) {
      b.f(
        ws,
        lever.col,
        row,
        ($) => {
          const x = $(`w_plan_${lever.id}`);
          const n = $('m_monthsRemaining');
          // base = INT(x / n); the first (x − base × n) instalments carry one extra dollar.
          return `IF(I${row}=0,"",INT(${x}/${n})+IF(${m}-(12-${n})<=${x}-INT(${x}/${n})*${n},1,0))`;
        },
        ST.td(NF.int),
      );
    }
    b.f(ws, 6, row, () => `IF(I${row}=0,"",SUM(C${row}:E${row}))`, ST.td(NF.int, 'right', { bold: true }));
    b.f(
      ws,
      7,
      row,
      ($) =>
        `IF(I${row}=1,"",IF(AND(${$('w_X')}>0,${$('m_monthsRemaining')}>0),"already passed",""))`,
      ST.td(undefined, 'left', { size: 9, color: { argb: C.faint } }),
    );
    r++;
  }
  const end = r - 1;
  b.v(ws, 2, r, 'Total', ST.total(undefined, 'left'));
  for (const col of [3, 4, 5, 6]) {
    const letter = String.fromCharCode(64 + col);
    b.f(ws, col, r, () => `SUM(${letter}${top}:${letter}${end})`, ST.total(NF.int));
  }
  styleRow(ws, r, 7, 7, ST.total());
  r += 2;

  // Start in January.
  mergeRow(ws, r, 2, LAST, ST.section()).value = 'If you start in January next time';
  r++;
  b.v(ws, 2, r, 'The same plan spread over 12 months, per month', ST.label());
  for (const lever of LEVERS) {
    b.f(ws, lever.col, r, ($) => `INT((${$(`w_plan_${lever.id}`)}+11)/12)`, ST.value(NF.int));
    b.reg(`m_fullYear_${lever.id}`, ws, lever.col, r);
    b.define(`out_fullYear_${lever.id}`, `m_fullYear_${lever.id}`);
  }
  const fullYearRow = r;
  b.f(ws, 6, fullYearRow, () => `SUM(C${fullYearRow}:E${fullYearRow})`, ST.value(NF.int, { bold: true }));
  b.reg('m_fullYear_total', ws, 6, r);
  b.define('out_fullYear_total', 'm_fullYear_total');
  b.v(ws, 7, r, 'Rounded up to whole dollars. A standing order makes it painless.', ST.noteRun());
  r += 2;
  mergeRow(ws, r, 2, LAST, ST.note()).value = DISCLAIMER;
  ws.getRow(r).height = 30;

  for (const [name, col] of [
    ['out_sched_month', 2],
    ['out_sched_srs', 3],
    ['out_sched_cpfSelf', 4],
    ['out_sched_cpfFamily', 5],
    ['out_sched_total', 6],
  ] as const) {
    b.regRange(name, ws, col, top, col, end);
    b.define(name, name);
  }

  view(ws, 2);
  pageSetup(ws, { landscape: false, lastCol: 'G', lastRow: r });
  return ws;
}
