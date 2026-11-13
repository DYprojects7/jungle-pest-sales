/**
 * The Simulator sheet (SPEC §6.8): tax and saving for every extra step of contribution, up to the total room of
 * the schemes that are switched on. It ignores the cash limit and the minimum saving rate.
 */
import type ExcelJS from 'exceljs';
import type { YearRules } from '../../src/engine/types';
import { Book, C, NF, SHEETS, ST, mergeRow, pageSetup, setWidths, taxPayable, view } from '../kit';
import { EXAMPLE } from './example';
import { LEVER_NAMES } from './rules';

/** The smallest step the simulator accepts (SPEC §6.8). */
const MIN_STEP = 100;
/** The table never has fewer step rows than this. */
const MIN_STEPS = 360;
const PRINTED_STEPS = 44;

/**
 * Steps laid out in the table (it also has row 0, "nothing more"): enough for the smallest step to reach the
 * largest room any user can have under these rules, so the last row is always the maximum contribution
 * (SPEC §9). Under the 2026 caps that is a foreigner's S$35,700 of SRS: 357 steps of S$100.
 */
export function simulatorSteps(rules: YearRules): number {
  const family = (residency: 'citizen' | 'pr' | 'foreigner'): number =>
    rules.cpfTopUp.familyGiverResidency.includes(residency) ? rules.cpfTopUp.familyReliefCap : 0;
  const largestRoom = Math.max(
    rules.srs.capCitizenPr + rules.cpfTopUp.selfReliefCap + Math.max(family('citizen'), family('pr')),
    rules.srs.capForeigner + family('foreigner'),
  );
  return Math.max(MIN_STEPS, Math.ceil(largestRoom / MIN_STEP / 20) * 20);
}

export function buildSimulator(b: Book): ExcelJS.Worksheet {
  const ws = b.sheet(SHEETS.simulator, C.good);
  setWidths(ws, [2, 8, 19, 14, 21, 22, 19, 16, 17, 17, 15, 13]);
  const LAST = 12;
  const steps = simulatorSteps(b.rules);
  b.sizes.simulatorSteps = steps;

  ws.getRow(1).height = 32;
  mergeRow(ws, 1, 2, LAST, ST.title()).value = 'Every extra step';
  ws.getRow(2).height = 34;
  mergeRow(ws, 2, 2, LAST, ST.subtitle()).value =
    'What each further slice of contribution does to your tax, in the order the schemes are filled. It runs to the total room in the schemes ' +
    'you switched on, ignoring your cash limit and your minimum, so you can see where the saving per dollar drops.';

  mergeRow(ws, 4, 2, 4, ST.label()).value = 'Size of each step (S$)';
  b.v(ws, 5, 4, EXAMPLE.simulatorStep, ST.input(NF.int));
  ws.getCell(4, 5).dataValidation = {
    type: 'whole',
    operator: 'greaterThanOrEqual',
    formulae: [MIN_STEP],
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
  b.reg('s_note', ws, 6, 4);
  b.f(
    ws,
    6,
    4,
    ($) =>
      // Only reachable when the caps on the Rules sheet have been raised: the table is sized for the caps it was built with.
      `IF(${$('s_steps')}>${steps},"The table has room for ${steps} steps, so it stops at S$"&TEXT(${steps}*${$('u_step')},"#,##0")&" of the S$"&TEXT(${$('w_L')},"#,##0")&" you could put in. A step of S$"&TEXT(INT((${$('w_L')}+${steps - 1})/${steps}),"#,##0")&" or more shows it all.",` +
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
    [4, LEVER_NAMES.srs, 'right'],
    [5, LEVER_NAMES.cpfSelf, 'right'],
    [6, LEVER_NAMES.cpfFamily, 'right'],
    [7, 'Chargeable income', 'right'],
    [8, 'Tax payable', 'right'],
    [9, 'Tax saved so far', 'right'],
    [10, 'Saved by this step', 'right'],
    [11, 'Saved per dollar in this step', 'right'],
    [12, 'In your plan?', 'center'],
  ];
  for (const [col, text, align] of headers) b.v(ws, col, head, text, ST.th(align));

  const top = head + 1;
  for (let i = 0; i <= steps; i++) {
    const row = top + i;
    const split = (lever: string) => ($: (k: string) => string): string =>
      `IF(C${row}="","",MIN(${$(`w_room_${lever}`)},MAX(0,C${row}-${$(`w_ahead_${lever}`)})))`;
    b.f(ws, 2, row, ($) => `IF(${i}>${$('s_steps')},"",${i})`, ST.tdBare(NF.plain, 'center'));
    b.f(ws, 3, row, ($) => `IF(B${row}="","",MIN(B${row}*${$('u_step')},${$('w_L')}))`, ST.tdBare(NF.int));
    b.f(ws, 4, row, split('srs'), ST.tdBare(NF.int));
    b.f(ws, 5, row, split('cpfSelf'), ST.tdBare(NF.int));
    b.f(ws, 6, row, split('cpfFamily'), ST.tdBare(NF.int));
    b.f(ws, 7, row, ($) => `IF(C${row}="","",MAX(0,${$('w_base_ci')}-MIN(C${row},${$('w_C')})))`, ST.tdBare(NF.int));
    b.f(ws, 8, row, ($) => `IF(C${row}="","",${taxPayable($, `G${row}`)})`, ST.tdBare(NF.cents));
    b.f(ws, 9, row, ($) => `IF(C${row}="","",ROUND(${$('w_base_tax')}-H${row},2))`, ST.tdBare(NF.cents));
    b.f(ws, 10, row, () => (i === 0 ? `IF(C${row}="","",0)` : `IF(C${row}="","",ROUND(I${row}-I${row - 1},2))`), ST.tdBare(NF.cents));
    b.f(ws, 11, row, () => (i === 0 ? `IF(C${row}="","",0)` : `IF(C${row}="","",J${row}/(C${row}-C${row - 1}))`), ST.tdBare(NF.rate));
    b.f(ws, 12, row, ($) => `IF(C${row}="","",IF(C${row}<=${$('w_X')},"Yes","No"))`, ST.tdBare(undefined, 'center'));
  }
  const end = top + steps;

  // Rows inside the plan are tinted; every row in use gets a rule under it (unused rows stay blank).
  ws.addConditionalFormatting({
    ref: `B${top}:L${end}`,
    rules: [
      {
        type: 'expression',
        priority: 1,
        formulae: [`$L${top}="Yes"`],
        // Carries the rule line as well: some applications apply only the first matching rule.
        style: {
          fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.goodFill } },
          border: { bottom: { style: 'thin', color: { argb: C.line } } },
        },
      },
      {
        type: 'expression',
        priority: 2,
        formulae: [`$C${top}<>""`],
        style: { border: { bottom: { style: 'thin', color: { argb: C.line } } } },
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
  // Print the first 44 steps: enough for the default S$1,000 step whatever the schemes' room. With a smaller
  // step, widen the print area (Page Layout › Print Area) to print more rows.
  pageSetup(ws, { landscape: true, lastCol: 'L', lastRow: top + PRINTED_STEPS, onePage: true });
  return ws;
}
