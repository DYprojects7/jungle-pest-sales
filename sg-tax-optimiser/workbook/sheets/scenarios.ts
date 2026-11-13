/**
 * The Scenarios sheet (SPEC §6.9): fixed what-ifs on the same inputs, next to the recommended plan.
 */
import type ExcelJS from 'exceljs';
import { Book, C, NF, SHEETS, ST, dollarsText, mergeRow, pageSetup, setWidths, taxPayable, view } from '../kit';
import type { Resolver } from '../kit';

/** Scenario ids in the order of the SPEC's table. */
export const SCENARIO_IDS = ['none', 'srsOnly', 'cpfSelfOnly', 'srsPlusCpfSelf', 'maxAll', 'recommended'] as const;

interface ScenarioRow {
  id: (typeof SCENARIO_IDS)[number];
  label: string;
  srs: ($: Resolver) => string;
  cpfSelf: ($: Resolver) => string;
  cpfFamily: ($: Resolver) => string;
}

const zero = (): string => '0';

const ROWS: ScenarioRow[] = [
  { id: 'none', label: 'Do nothing more', srs: zero, cpfSelf: zero, cpfFamily: zero },
  { id: 'srsOnly', label: 'Fill SRS only', srs: ($) => $('w_roomIfOn_srs'), cpfSelf: zero, cpfFamily: zero },
  { id: 'cpfSelfOnly', label: 'Top up your own CPF only', srs: zero, cpfSelf: ($) => $('w_roomIfOn_cpfSelf'), cpfFamily: zero },
  {
    id: 'srsPlusCpfSelf',
    label: 'Fill SRS and top up your own CPF',
    srs: ($) => $('w_roomIfOn_srs'),
    cpfSelf: ($) => $('w_roomIfOn_cpfSelf'),
    cpfFamily: zero,
  },
  {
    id: 'maxAll',
    label: 'Everything, including family if switched on',
    srs: ($) => $('w_roomIfOn_srs'),
    cpfSelf: ($) => $('w_roomIfOn_cpfSelf'),
    cpfFamily: ($) => $('w_room_cpfFamily'),
  },
  {
    id: 'recommended',
    label: 'The recommended plan',
    srs: ($) => $('w_plan_srs'),
    cpfSelf: ($) => $('w_plan_cpfSelf'),
    cpfFamily: ($) => $('w_plan_cpfFamily'),
  },
];

export function buildScenarios(b: Book): ExcelJS.Worksheet {
  const ws = b.sheet(SHEETS.scenarios, C.good);
  setWidths(ws, [2, 42, 14, 14, 14, 16, 16, 16, 14, 16, 66, 3, 16, 18]);
  const LAST = 11;

  ws.getRow(1).height = 32;
  mergeRow(ws, 1, 2, LAST, ST.title()).value = 'Compare your options';
  ws.getRow(2).height = 34;
  mergeRow(ws, 2, 2, LAST, ST.subtitle()).value =
    'The same income and reliefs under six choices. The first five ignore your cash limit, minimum rate and scheme switches ' +
    '(family top-ups count only if switched on), so you can see what "just max everything" would really do. Wasted dollars are locked away without saving any tax.';

  const head = 4;
  ws.getRow(head).height = 32;
  const headers: Array<[number, string, 'left' | 'right']> = [
    [2, 'Option', 'left'],
    [3, 'Into SRS', 'right'],
    [4, 'Into your CPF', 'right'],
    [5, 'Into family CPF', 'right'],
    [6, 'Cash locked away', 'right'],
    [7, 'Tax payable', 'right'],
    [8, 'Tax saved', 'right'],
    [9, 'Saved per dollar', 'right'],
    [10, 'Wasted dollars', 'right'],
    [11, 'Comment', 'left'],
  ];
  for (const [col, text, align] of headers) b.v(ws, col, head, text, ST.th(align));
  b.v(ws, 13, head, 'Scenario id', ST.helperHead('left'));
  b.v(ws, 14, head, 'Chargeable income', ST.helperHead());

  let r = head + 1;
  const top = r;
  for (const scenario of ROWS) {
    const row = r;
    const isPlan = scenario.id === 'recommended';
    const cell = (numFmt: string) => (isPlan ? ST.total(numFmt) : ST.td(numFmt));
    b.v(ws, 2, row, scenario.label, isPlan ? ST.total(undefined, 'left') : ST.td(undefined, 'left'));
    b.f(ws, 3, row, scenario.srs, cell(NF.int));
    b.f(ws, 4, row, scenario.cpfSelf, cell(NF.int));
    b.f(ws, 5, row, scenario.cpfFamily, cell(NF.int));
    b.f(ws, 6, row, () => `SUM(C${row}:E${row})`, cell(NF.int));
    b.f(ws, 7, row, ($) => taxPayable($, `N${row}`), cell(NF.cents));
    b.f(ws, 8, row, ($) => `ROUND(${$('w_base_tax')}-G${row},2)`, cell(NF.cents));
    b.f(ws, 9, row, () => `IF(F${row}=0,0,H${row}/F${row})`, cell(NF.pct));
    b.f(ws, 10, row, ($) => `F${row}-MIN(F${row},${$('w_U0')},${$('w_C')})`, cell(NF.int));
    b.f(
      ws,
      11,
      row,
      ($) =>
        isPlan
          ? // Why the plan stops is taken from the limit that stopped it.
            `IF(F${row}=0,"Nothing more is recommended; see the Planner for why.",` +
            `IF(${$('w_binding')}="usefulRoom","Stops where the next dollar would save less than your minimum.",` +
            `IF(${$('w_binding')}="reliefCap","Stops at the overall relief cap.",` +
            `IF(${$('w_binding')}="cashBudget","Stops at your cash limit.",` +
            `IF(${$('w_binding')}="leverLimits","Uses all the room in the schemes you switched on.","The recommended plan."))))&" Never includes a wasted dollar.")`
          : `IF(J${row}>0,${dollarsText(`J${row}`)}&" would be locked away without saving any tax.",IF(AND(F${row}>0,F${row}=${$('w_X')},H${row}=${$('w_taxSaved')}),"Saves the same tax as the recommended plan.",""))`,
      isPlan ? { ...ST.total(undefined, 'left'), font: ST.note().font } : ST.td(undefined, 'left', { size: 9, color: { argb: C.muted } }),
    );
    b.v(ws, 13, row, scenario.id, ST.helper(undefined, 'left'));
    b.f(ws, 14, row, ($) => `MAX(0,${$('w_base_ci')}-MIN(F${row},${$('w_C')}))`, ST.helper(NF.int));
    r++;
  }
  const end = r - 1;
  r++;
  mergeRow(ws, r, 2, LAST, ST.note()).value =
    'Tax saved depends only on the total that earns relief, not on which scheme it goes into. The schemes differ in what happens to the money afterwards: ' +
    'SRS can be withdrawn early (taxed, with a 5% penalty); CPF top-ups cannot be reversed; a family top-up is a gift.';
  ws.getRow(r).height = 30;

  ws.addConditionalFormatting({
    ref: `J${top}:J${end}`,
    rules: [
      {
        type: 'cellIs',
        operator: 'greaterThan',
        priority: 1,
        formulae: [0],
        style: { font: { color: { argb: C.warn }, bold: true }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: C.warnFill } } },
      },
    ],
  });

  for (const [name, col] of [
    ['out_scen_id', 13],
    ['out_scen_srs', 3],
    ['out_scen_cpfSelf', 4],
    ['out_scen_cpfFamily', 5],
    ['out_scen_total', 6],
    ['out_scen_tax', 7],
    ['out_scen_saved', 8],
    ['out_scen_rate', 9],
    ['out_scen_wasted', 10],
  ] as const) {
    b.regRange(name, ws, col, top, col, end);
    b.define(name, name);
  }
  b.regRange('sc_comment', ws, 11, top, 11, end);

  view(ws, head);
  pageSetup(ws, { landscape: true, lastCol: 'K', lastRow: r });
  return ws;
}
