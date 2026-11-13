/**
 * The Simulator sheet (SPEC §6.8): tax and saving for every extra step of contribution, up to the total room of
 * the schemes that are switched on. It ignores the cash limit and the minimum saving rate.
 */
import type ExcelJS from 'exceljs';
import { Book, C, NF, SHEETS, ST, mergeRow, pageSetup, setWidths, taxPayable, view } from '../kit';
import { EXAMPLE } from './planner';

/** Rows in the table: step 0 (nothing more) plus this many steps. */
export const SIMULATOR_STEPS = 120;

export function buildSimulator(b: Book): ExcelJS.Worksheet {
  const ws = b.sheet(SHEETS.simulator, C.good);
  setWidths(ws, [2, 8, 19, 14, 14, 14, 19, 16, 17, 17, 15, 13]);
  const LAST = 12;

  ws.getRow(1).height = 32;
  mergeRow(ws, 1, 2, LAST, ST.title()).value = 'Every extra step';
  ws.getRow(2).height = 34;
  mergeRow(ws, 2, 2, LAST, ST.subtitle()).value =
    'What each further slice of contribution does to your tax, in the order the schemes are filled. It runs to the total room in the schemes ' +
    'you switched on, ignoring your cash limit and minimum rate, so you can see where the saving per dollar drops.';

  mergeRow(ws, 4, 2, 4, ST.label()).value = 'Size of each step (S$)';
  b.v(ws, 5, 4, EXAMPLE.simulatorStep, ST.input(NF.int));
  ws.getCell(4, 5).dataValidation = {
    type: 'whole',
    operator: 'greaterThanOrEqual',
    formulae: [100],
    allowBlank: true,
    showErrorMessage: true,
    errorStyle: 'stop',
    errorTitle: 'Step size',
    error: 'Enter a whole number of dollars, 100 or more.',
    showInputMessage: true,
    promptTitle: 'Step size',
    prompt: 'How many dollars each row adds. 1,000 is a good start; the smallest is 100.',
  };
  b.reg('in_simulatorStep', ws, 5, 4);
  b.define('in_simulatorStep', 'in_simulatorStep');
  mergeRow(ws, 4, 6, LAST, ST.note());
  b.f(
    ws,
    6,
    4,
    ($) =>
      `IF(${$('s_steps')}>${SIMULATOR_STEPS},"The table shows the first ${SIMULATOR_STEPS} steps. Use a bigger step to reach the full "&"S$"&TEXT(${$('w_L')},"#,##0")&".",` +
      `"Steps of S$"&TEXT(${$('u_step')},"#,##0")&" up to the S$"&TEXT(${$('w_L')},"#,##0")&" of room in your schemes.")`,
  );
  mergeRow(ws, 5, 2, 4, ST.labelIndent()).value = 'Steps needed to reach the total room';
  b.f(ws, 5, 5, ($) => `INT((${$('w_L')}+${$('u_step')}-1)/${$('u_step')})`, ST.helper(NF.int));
  b.reg('s_steps', ws, 5, 5);

  const head = 7;
  ws.getRow(head).height = 32;
  const headers: Array<[number, string, 'left' | 'right' | 'center']> = [
    [2, 'Step', 'center'],
    [3, 'Extra contribution', 'right'],
    [4, 'Into SRS', 'right'],
    [5, 'Into your CPF', 'right'],
    [6, 'Into family CPF', 'right'],
    [7, 'Chargeable income', 'right'],
    [8, 'Tax payable', 'right'],
    [9, 'Tax saved so far', 'right'],
    [10, 'Saved by this step', 'right'],
    [11, 'Per dollar in this step', 'right'],
    [12, 'In your plan?', 'center'],
  ];
  for (const [col, text, align] of headers) b.v(ws, col, head, text, ST.th(align));

  const top = head + 1;
  for (let i = 0; i <= SIMULATOR_STEPS; i++) {
    const row = top + i;
    const split = (lever: string) => ($: (k: string) => string): string =>
      `IF(C${row}="","",MIN(${$(`w_room_${lever}`)},MAX(0,C${row}-${$(`w_ahead_${lever}`)})))`;
    b.f(ws, 2, row, ($) => `IF(${i}>${$('s_steps')},"",${i})`, ST.td(NF.plain, 'center'));
    b.f(ws, 3, row, ($) => `IF(B${row}="","",MIN(B${row}*${$('u_step')},${$('w_L')}))`, ST.td(NF.int));
    b.f(ws, 4, row, split('srs'), ST.td(NF.int));
    b.f(ws, 5, row, split('cpfSelf'), ST.td(NF.int));
    b.f(ws, 6, row, split('cpfFamily'), ST.td(NF.int));
    b.f(ws, 7, row, ($) => `IF(C${row}="","",MAX(0,${$('w_base_ci')}-MIN(C${row},${$('w_C')})))`, ST.td(NF.int));
    b.f(ws, 8, row, ($) => `IF(C${row}="","",${taxPayable($, `G${row}`)})`, ST.td(NF.cents));
    b.f(ws, 9, row, ($) => `IF(C${row}="","",ROUND(${$('w_base_tax')}-H${row},2))`, ST.td(NF.cents));
    b.f(ws, 10, row, () => (i === 0 ? `IF(C${row}="","",0)` : `IF(C${row}="","",ROUND(I${row}-I${row - 1},2))`), ST.td(NF.cents));
    b.f(ws, 11, row, () => (i === 0 ? `IF(C${row}="","",0)` : `IF(C${row}="","",J${row}/(C${row}-C${row - 1}))`), ST.td(NF.pct));
    b.f(ws, 12, row, ($) => `IF(C${row}="","",IF(C${row}<=${$('w_X')},"Yes","No"))`, ST.td(undefined, 'center'));
  }
  const end = top + SIMULATOR_STEPS;

  // Rows inside the plan are tinted; the first row whose step saves less per dollar than the one before stands out.
  ws.addConditionalFormatting({
    ref: `B${top}:L${end}`,
    rules: [
      {
        type: 'expression',
        priority: 1,
        formulae: [`$L${top}="Yes"`],
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.goodFill } } },
      },
    ],
  });

  for (const [name, col] of [
    ['out_sim_step', 2],
    ['out_sim_contribution', 3],
    ['out_sim_srs', 4],
    ['out_sim_cpfSelf', 5],
    ['out_sim_cpfFamily', 6],
    ['out_sim_tax', 8],
    ['out_sim_saved', 9],
    ['out_sim_stepSaving', 10],
    ['out_sim_stepRate', 11],
    ['out_sim_withinPlan', 12],
  ] as const) {
    b.regRange(name, ws, col, top, col, end);
    b.define(name, name);
  }

  view(ws, head);
  pageSetup(ws, { landscape: true, lastCol: 'L', lastRow: end, titleRows: `${head}:${head}` });
  return ws;
}
