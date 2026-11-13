/**
 * The Scenarios sheet (SPEC §6.9): fixed what-ifs on the same inputs, next to the recommended plan.
 */
import type ExcelJS from 'exceljs';
import { Book, C, NF, SHEETS, ST, centsNumber, dollarsText, heightFor, mergeRow, pageSetup, setWidths, taxPayable, view } from '../kit';
import type { Resolver } from '../kit';
import { LEVER_NAMES } from './rules';
import { LEFT_OUT } from './working';

/**
 * Scenario ids in the order of the SPEC's table: the order of the rows on the sheet. The ids themselves are never
 * written on it; tests and tools pair row `i` with `SCENARIO_IDS[i]`.
 */
export const SCENARIO_IDS = ['none', 'srsOnly', 'cpfSelfOnly', 'srsPlusCpfSelf', 'maxAll', 'recommended'] as const;

/** The options under the names the web page gives them (SPEC §9 "Same story as the page"). */
export const SCENARIO_NAMES: Record<(typeof SCENARIO_IDS)[number], string> = {
  none: 'Do nothing more',
  srsOnly: 'SRS only',
  cpfSelfOnly: 'CPF cash top-up to self only',
  srsPlusCpfSelf: 'SRS and CPF cash top-up to self',
  maxAll: 'Everything to the limit',
  recommended: 'Your plan',
};

const COMMENT_WIDTH = 78;

interface ScenarioRow {
  id: (typeof SCENARIO_IDS)[number];
  srs: ($: Resolver) => string;
  cpfSelf: ($: Resolver) => string;
  cpfFamily: ($: Resolver) => string;
}

const zero = (): string => '0';

const ROWS: ScenarioRow[] = [
  { id: 'none', srs: zero, cpfSelf: zero, cpfFamily: zero },
  { id: 'srsOnly', srs: ($) => $('w_roomIfOn_srs'), cpfSelf: zero, cpfFamily: zero },
  { id: 'cpfSelfOnly', srs: zero, cpfSelf: ($) => $('w_roomIfOn_cpfSelf'), cpfFamily: zero },
  { id: 'srsPlusCpfSelf', srs: ($) => $('w_roomIfOn_srs'), cpfSelf: ($) => $('w_roomIfOn_cpfSelf'), cpfFamily: zero },
  { id: 'maxAll', srs: ($) => $('w_roomIfOn_srs'), cpfSelf: ($) => $('w_roomIfOn_cpfSelf'), cpfFamily: ($) => $('w_room_cpfFamily') },
  { id: 'recommended', srs: ($) => $('w_plan_srs'), cpfSelf: ($) => $('w_plan_cpfSelf'), cpfFamily: ($) => $('w_plan_cpfFamily') },
];

export function buildScenarios(b: Book): ExcelJS.Worksheet {
  const ws = b.sheet(SHEETS.scenarios, C.good);
  setWidths(ws, [2, 34, 14, 21, 22, 16, 16, 16, 16, 16, COMMENT_WIDTH, 3, 18]);
  const LAST = 11;

  ws.getRow(1).height = 32;
  mergeRow(ws, 1, 2, LAST, ST.title()).value = 'Compare your options';
  ws.getRow(2).height = 34;
  mergeRow(ws, 2, 2, LAST, ST.subtitle()).value =
    'Ready-made choices on the same numbers. The first five ignore your cash limit and your minimum saving, and they use SRS and the CPF cash top-up to yourself ' +
    'even if you switched them off (the family top-up counts only if switched on), so you can see what each scheme does at its limit. Wasted dollars are locked away without saving any tax.';

  const head = 4;
  ws.getRow(head).height = 32;
  const headers: Array<[number, string, 'left' | 'right']> = [
    [2, 'Option', 'left'],
    [3, LEVER_NAMES.srs, 'right'],
    [4, LEVER_NAMES.cpfSelf, 'right'],
    [5, LEVER_NAMES.cpfFamily, 'right'],
    [6, 'Cash locked away', 'right'],
    [7, 'Tax', 'right'],
    [8, 'Tax saved', 'right'],
    [9, 'Saved per dollar (cents)', 'right'],
    [10, 'Wasted dollars', 'right'],
    [11, 'Comment', 'left'],
  ];
  for (const [col, text, align] of headers) b.v(ws, col, head, text, ST.th(align));
  b.v(ws, 13, head, 'Chargeable income', ST.helperHead());

  let r = head + 1;
  const top = r;
  for (const scenario of ROWS) {
    const row = r;
    const isPlan = scenario.id === 'recommended';
    const cell = (numFmt: string) => (isPlan ? ST.total(numFmt) : ST.td(numFmt));
    b.v(ws, 2, row, SCENARIO_NAMES[scenario.id], isPlan ? ST.total(undefined, 'left') : ST.td(undefined, 'left'));
    b.f(ws, 3, row, scenario.srs, cell(NF.int));
    b.f(ws, 4, row, scenario.cpfSelf, cell(NF.int));
    b.f(ws, 5, row, scenario.cpfFamily, cell(NF.int));
    b.f(ws, 6, row, () => `SUM(C${row}:E${row})`, cell(NF.int));
    b.f(ws, 7, row, ($) => taxPayable($, `M${row}`), cell(NF.cents));
    b.f(ws, 8, row, ($) => `ROUND(${$('w_base_tax')}-G${row},2)`, cell(NF.cents));
    // Cents per dollar to two decimals, as the page shows it; "n/a" when nothing is put in.
    b.f(ws, 9, row, () => `IF(F${row}=0,"n/a",${centsNumber(`(H${row}/F${row})`)})`, { ...cell('General'), alignment: { vertical: 'middle', horizontal: 'right' } });
    b.f(ws, 10, row, ($) => `F${row}-MIN(F${row},${$('w_U0')},${$('w_C')})`, cell(NF.int));
    b.f(
      ws,
      11,
      row,
      ($) =>
        isPlan
          ? // Why the plan stops is taken from the limit that stopped it.
            `IF(F${row}=0,"Nothing more is recommended; see the Planner for why.",` +
            `IF(${$('w_binding')}=1,"Stops where the next dollar would save less than your minimum.",` +
            `IF(${$('w_binding')}=2,"Stops at the overall relief cap.",` +
            `IF(${$('w_binding')}=4,"Stops at your cash limit.",` +
            `IF(${$('w_binding')}=3,"Uses all the room in the schemes you switched on.","Your plan."))))&" Has no dollars above the caps. Check your CPF room and family eligibility yourself.")`
          : `IF(J${row}>0,${dollarsText(`J${row}`)}&" would be locked away without saving any tax.",IF(AND(F${row}>0,F${row}=${$('w_X')},H${row}=${$('w_taxSaved')}),"Saves the same tax as your plan.",""))` +
            // From 55 the room for the person's own CPF must be entered: say why an option that uses it shows nothing for it.
            (scenario.cpfSelf === zero ? '' : `&IF(${$('w_selfUnconfirmed')}=1,IF(OR(J${row}>0,AND(F${row}>0,F${row}=${$('w_X')},H${row}=${$('w_taxSaved')}))," ","")&"${LEFT_OUT}","")`),
      isPlan
        ? { ...ST.total(undefined, 'left'), font: ST.note().font, alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true } }
        : { ...ST.td(undefined, 'left', { size: 9, color: { argb: C.muted } }), alignment: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true } },
    );
    // The longest comment (why the plan stops, and what to check yourself) takes two lines.
    ws.getRow(row).height = isPlan || scenario.cpfSelf !== zero ? heightFor(150, COMMENT_WIDTH, 9) : 18;
    b.f(ws, 13, row, ($) => `MAX(0,${$('w_base_ci')}-MIN(F${row},${$('w_C')}))`, ST.helper(NF.int));
    r++;
  }
  const end = r - 1;
  r++;
  mergeRow(ws, r, 2, LAST, ST.note()).value =
    'Tax saved depends only on the total that earns relief, not on which scheme it goes into. The schemes differ in what happens to the money afterwards: ' +
    'the Before You Transfer sheet sets that out for each of them.';
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
