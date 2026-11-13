/**
 * The Ladder sheet (SPEC §6.7): the range of possible extra contributions cut into rungs that each save tax at
 * one rate, in the order the dollars would go in, as a chart and as a table.
 *
 * Layout: the working block on the right has one row per tax bracket (from the bracket holding the top dollar of
 * chargeable income downwards, with spare rows for brackets added on the Rules sheet), then a row for dollars
 * beyond chargeable income and a row for dollars over the relief cap. Neighbouring rows that save at the same
 * rate for the same reason form one rung, as in the engine; the table on the left shows the rungs, closed up.
 *
 * The chart is a real chart (added to the file by `workbook/chart.ts`) fed by the "chart points" columns; the
 * in-cell bars in the table say the same thing for applications that do not show the chart.
 */
import type ExcelJS from 'exceljs';
import { Book, C, NF, SHEETS, ST, colLetter, dollarsText, mergeRow, pageSetup, setWidths, styleRow, taxPayable, view } from '../kit';
import type { Resolver } from '../kit';
import { bracketCapacity } from './rules';

const BAR_UNITS = 30;
const RATE_UNITS = 20;
/** Sheet rows the chart covers. */
const CHART_ROWS = 16;

/** Helper columns beside the table: one row per rung shown. */
const D = { pick: 14, reason: 15, from: 16, to: 17, rate: 18 } as const;
/** Columns of the working block: one row per bracket, then "beyond income" and "over the cap". */
const W = {
  k: 20,
  start: 21,
  end: 22,
  dollars: 23,
  ci: 24,
  tax: 25,
  rate: 26,
  reason: 27,
  saved: 28,
  used: 29,
  lastRate: 30,
  lastReason: 31,
  isNew: 32,
  run: 33,
  group: 34,
  count: 35,
} as const;
/**
 * Chart points: four per rung (its start, where the plan stops inside it, twice, and its end). "Every rung" is
 * drawn from `x` / `all`; "Your plan" from `planX` / `plan`, which follow it and stop where the plan stops.
 */
const P = { x: 37, all: 38, planX: 39, plan: 40 } as const;

export function buildLadder(b: Book): ExcelJS.Worksheet {
  const ws = b.sheet(SHEETS.ladder, C.good);
  setWidths(ws, [
    2, 7, 15, 15, 16, 13, 16, 17, 16, 36, 25, 48, 3,
    9, 18, 11, 11, 9, 3,
    11, 11, 11, 11, 13, 13, 9, 18, 11, 11, 9, 18, 7, 7, 7, 7, 3,
    13, 12, 13, 14,
  ]);
  const LAST = 12;
  const bracketCount = b.rules.taxBrackets.length;
  const capacity = bracketCapacity(bracketCount);
  /** Working rows, and so the most rungs there can be. */
  const rows = capacity + 2;
  b.sizes.ladderRows = rows;

  ws.getRow(1).height = 32;
  mergeRow(ws, 1, 2, LAST, ST.title()).value = 'Your savings ladder';
  ws.getRow(2).height = 34;
  mergeRow(ws, 2, 2, LAST, ST.subtitle()).value =
    'Each extra dollar you lock away saves tax at the rate on your top dollar of income. As your chargeable income falls, ' +
    'that rate steps down a rung at a time. The plan climbs down the ladder and stops at the rung you chose on the Planner.';

  // Facts above the chart.
  let r = 4;
  const fact = (key: string | null, label: string, formula: ($: Resolver) => string): void => {
    // Every row above the chart has a fixed height: a row that grew to fit its text when the file is opened
    // would slide the rows below it under the chart in applications that place the chart before sizing rows.
    ws.getRow(r).height = label.length > 60 ? 30 : 16;
    mergeRow(ws, r, 2, 5, ST.label()).value = label;
    ws.getCell(r, 7).style = ST.value(NF.dollars, { bold: true });
    b.f(ws, 6, r, formula, ST.value(NF.dollars, { bold: true }));
    ws.mergeCells(r, 6, r, 7);
    if (key) b.reg(key, ws, 6, r);
    r++;
  };
  fact(null, 'Chargeable income before any extra contribution', ($) => $('w_base_ci'));
  fact(null, 'Room in the schemes you switched on', ($) => $('w_L'));
  fact(null, 'Room under the overall relief cap', ($) => $('w_C'));
  fact('lad_within', 'Dollars that can still lower your chargeable income (the smaller of the two)', ($) => `MIN(${$('w_L')},${$('w_C')})`);
  fact(null, 'Your plan uses', ($) => $('w_X'));
  // Totals beside the facts (the table has no total row, so short ladders leave no gap).
  const sideFact = (row: number, label: string, formula: ($: Resolver) => string, argb: string): void => {
    mergeRow(ws, row, 9, 11, ST.label()).value = label;
    b.f(ws, 12, row, formula, { ...ST.value(NF.tax, { bold: true, color: { argb } }), alignment: { vertical: 'middle', horizontal: 'left', indent: 1 } });
  };
  sideFact(4, 'Tax your plan saves', ($) => $('w_taxSaved'), C.good);
  sideFact(5, 'Tax saved by climbing every rung', ($) => `ROUND(${$('w_base_tax')}-${$('lad_taxAtBottom')},2)`, C.ink);
  sideFact(6, 'Dollars on rungs that save nothing', ($) => `${$('w_L')}-MIN(${$('w_L')},${$('w_U0')},${$('w_C')})`, C.warn);
  ws.getCell(6, 12).numFmt = NF.dollars;
  ws.getRow(3).height = 8;
  ws.getRow(r).height = 8;
  r++;
  ws.getRow(r).height = 30;
  mergeRow(ws, r, 2, LAST, ST.note());
  b.f(
    ws,
    2,
    r,
    ($) =>
      `IF(${$('w_L')}=0,"No scheme with room is switched on, so there is no ladder to show. Switch a scheme on in the Planner.",` +
      `"How to read it: the ladder ignores your cash limit and your minimum rate, so you can see every rung. The chart shows the tax saved by each extra dollar; the thick line is your plan. Rungs marked 'No tax saved' are money locked away for nothing.")`,
  );
  r++;

  // The chart sits here, above the table, so it stays in view however many rungs there are.
  const chartTop = r;
  for (let row = chartTop; row < chartTop + CHART_ROWS; row++) ws.getRow(row).height = 16;
  r = chartTop + CHART_ROWS + 1;

  // Working cells: the highest rate in the tax table (scales the rate bars).
  b.v(ws, W.k, 4, 'Working', ST.helperHead('left'));
  styleRow(ws, 4, W.k + 1, W.count, ST.helperHead('left'));
  b.v(ws, W.k, 5, 'Bracket row of your top dollar', ST.helper(undefined, 'left'));
  b.f(ws, W.dollars, 5, ($) => $('w_k0'), ST.helper(NF.plain));
  b.v(ws, W.k, 6, 'Highest rate in the tax table', ST.helper(undefined, 'left'));
  b.f(ws, W.dollars, 6, ($) => `MAX(${$('r_rate')})`, ST.helper(NF.pct));
  b.reg('lad_maxRate', ws, W.dollars, 6);

  // Table header.
  const head = r;
  ws.getRow(head).height = 32;
  const headers: Array<[number, string, 'left' | 'right']> = [
    [2, 'Rung', 'left'],
    [3, 'Extra dollars: from', 'right'],
    [4, 'to', 'right'],
    [5, 'Dollars in this rung', 'right'],
    [6, 'Tax saved per dollar', 'right'],
    [7, 'Tax saved by this rung', 'right'],
    [8, 'Tax saved so far', 'right'],
    [9, 'Used by your plan', 'right'],
    [10, 'Size of the rung (dark = in your plan)', 'left'],
    [11, 'Saving per dollar', 'left'],
    [12, 'What it means', 'left'],
  ];
  for (const [col, text, align] of headers) b.v(ws, col, head, text, ST.th(align));
  const helperHeads: Array<[number, string]> = [
    [D.pick, 'Working row shown'],
    [D.reason, 'Zero-saving reason'],
    [D.from, 'Rung from'],
    [D.to, 'Rung to'],
    [D.rate, 'Rung rate'],
    [W.k, 'Bracket row'],
    [W.start, 'Start'],
    [W.end, 'End'],
    [W.dollars, 'Dollars'],
    [W.ci, 'Chargeable income at end'],
    [W.tax, 'Tax payable at end'],
    [W.rate, 'Rate'],
    [W.reason, 'Zero-saving reason'],
    [W.saved, 'Tax saved'],
    [W.used, 'Used by plan'],
    [W.lastRate, 'Rate of the last row with dollars'],
    [W.lastReason, 'Its zero-saving reason'],
    [W.isNew, 'New rung?'],
    [W.run, 'Rungs so far'],
    [W.group, 'Rung no.'],
    [W.count, 'Rung starts here'],
    [P.x, 'Chart: extra contribution'],
    [P.planX, 'Chart: extra contribution, your plan'],
  ];
  for (const [col, text] of helperHeads) b.v(ws, col, head, text, ST.helperHead());
  // The chart's legend reads these two headings.
  b.v(ws, P.all, head, 'Every rung', ST.helperHead());
  b.f(ws, P.plan, head, ($) => `"Your plan (stops at S$"&TEXT(${$('w_X')},"#,##0")&")"`, ST.helperHead());
  b.reg('lad_chartAllName', ws, P.all, head);
  b.reg('lad_chartPlanName', ws, P.plan, head);
  r++;

  const top = r;
  const end = top + rows - 1;
  const L = (col: number): string => colLetter(col);
  const whole = (col: number): string => `$${L(col)}$${top}:$${L(col)}$${end}`;

  for (let i = 1; i <= rows; i++) {
    const row = top + i - 1;
    const kind = i <= capacity ? 'bracket' : i === capacity + 1 ? 'beyond' : 'cap';
    const at = (col: number, r0: number = row): string => `${L(col)}${r0}`;
    const previous = row - 1;

    // ---- Working block: always numbers -------------------------------------------------------------------
    if (i === 1) b.v(ws, W.start, row, 0, ST.helper(NF.int));
    else b.f(ws, W.start, row, () => at(W.end, previous), ST.helper(NF.int));
    if (kind === 'bracket') {
      b.f(ws, W.k, row, ($) => `MAX(0,${$('w_k0')}-${i - 1})`, ST.helper(NF.plain));
      // Bracket k ends where chargeable income reaches its start.
      b.f(
        ws,
        W.end,
        row,
        ($) => `IF(${at(W.k)}=0,${at(W.start)},MAX(${at(W.start)},MIN(${$('lad_within')},${$('w_base_ci')}-INDEX(${$('r_from')},${at(W.k)}))))`,
        ST.helper(NF.int),
      );
      b.f(ws, W.rate, row, ($) => `IF(${at(W.k)}=0,0,INDEX(${$('r_rate')},${at(W.k)}))`, ST.helper(NF.pct));
      b.f(ws, W.reason, row, () => `IF(AND(${at(W.dollars)}>0,${at(W.rate)}=0),"belowTaxThreshold","")`, ST.helper(undefined, 'left'));
    } else if (kind === 'beyond') {
      // Dollars beyond chargeable income: there is nothing left to tax.
      b.v(ws, W.k, row, 'beyond income', ST.helper(undefined, 'right'));
      b.f(ws, W.end, row, ($) => `MAX(${at(W.start)},${$('lad_within')})`, ST.helper(NF.int));
      b.v(ws, W.rate, row, 0, ST.helper(NF.pct));
      b.f(ws, W.reason, row, () => `IF(${at(W.dollars)}>0,"belowTaxThreshold","")`, ST.helper(undefined, 'left'));
    } else {
      b.v(ws, W.k, row, 'over cap', ST.helper(undefined, 'right'));
      b.f(ws, W.end, row, ($) => `MAX(${at(W.start)},${$('w_L')})`, ST.helper(NF.int));
      b.v(ws, W.rate, row, 0, ST.helper(NF.pct));
      b.f(ws, W.reason, row, () => `IF(${at(W.dollars)}>0,"reliefCap","")`, ST.helper(undefined, 'left'));
    }
    b.f(ws, W.dollars, row, () => `${at(W.end)}-${at(W.start)}`, ST.helper(NF.int));
    b.f(ws, W.ci, row, ($) => `MAX(0,${$('w_base_ci')}-MIN(${at(W.end)},${$('w_C')}))`, ST.helper(NF.int));
    b.f(ws, W.tax, row, ($) => taxPayable($, at(W.ci)), ST.helper(NF.cents));
    b.f(ws, W.saved, row, ($) => `ROUND(${i === 1 ? $('w_base_tax') : at(W.tax, previous)}-${at(W.tax)},2)`, ST.helper(NF.cents));
    b.f(ws, W.used, row, ($) => `MAX(0,MIN(${at(W.end)},${$('w_X')})-${at(W.start)})`, ST.helper(NF.int));
    // A row starts a new rung unless the last row with dollars saved at the same rate for the same reason.
    if (i === 1) {
      b.f(ws, W.lastRate, row, () => `IF(${at(W.dollars)}>0,${at(W.rate)},0)`, ST.helper(NF.pct));
      b.f(ws, W.lastReason, row, () => `IF(${at(W.dollars)}>0,${at(W.reason)},"")`, ST.helper(undefined, 'left'));
      b.f(ws, W.isNew, row, () => `IF(${at(W.dollars)}>0,1,0)`, ST.helper(NF.plain));
      b.f(ws, W.run, row, () => at(W.isNew), ST.helper(NF.plain));
    } else {
      b.f(ws, W.lastRate, row, () => `IF(${at(W.dollars)}>0,${at(W.rate)},${at(W.lastRate, previous)})`, ST.helper(NF.pct));
      b.f(ws, W.lastReason, row, () => `IF(${at(W.dollars)}>0,${at(W.reason)},${at(W.lastReason, previous)})`, ST.helper(undefined, 'left'));
      b.f(
        ws,
        W.isNew,
        row,
        () =>
          `IF(${at(W.dollars)}=0,0,IF(OR(${at(W.run, previous)}=0,${at(W.rate)}<>${at(W.lastRate, previous)},${at(W.reason)}<>${at(W.lastReason, previous)}),1,0))`,
        ST.helper(NF.plain),
      );
      b.f(ws, W.run, row, () => `${at(W.run, previous)}+${at(W.isNew)}`, ST.helper(NF.plain));
    }
    b.f(ws, W.group, row, () => `IF(${at(W.dollars)}>0,${at(W.run)},0)`, ST.helper(NF.plain));
    b.f(ws, W.count, row, () => `IF(${at(W.isNew)}=1,${at(W.run)},0)`, ST.helper(NF.plain));

    // ---- The table: the i-th rung ----------------------------------------------------------------------------
    const pick = `$${L(D.pick)}${row}`;
    const inRung = `(${whole(W.group)}=${i})`;
    b.f(ws, D.pick, row, () => `IFERROR(MATCH(${i},${whole(W.count)},0),0)`, ST.helper(NF.plain));
    b.f(ws, D.reason, row, () => `IF(${pick}=0,"",INDEX(${whole(W.reason)},${pick}))`, ST.helper(undefined, 'left'));
    b.f(ws, D.from, row, () => `IF(${pick}=0,0,INDEX(${whole(W.start)},${pick}))`, ST.helper(NF.int));
    b.f(ws, D.to, row, () => `${at(D.from)}+SUMPRODUCT(${inRung}*${whole(W.dollars)})`, ST.helper(NF.int));
    b.f(ws, D.rate, row, () => `IF(${pick}=0,0,INDEX(${whole(W.rate)},${pick}))`, ST.helper(NF.pct));
    b.f(ws, 2, row, () => `IF(${pick}=0,"",${i})`, ST.tdBare(NF.plain, 'left'));
    b.f(ws, 3, row, () => `IF(${pick}=0,"",${at(D.from)})`, ST.tdBare(NF.int));
    b.f(ws, 4, row, () => `IF(${pick}=0,"",${at(D.to)})`, ST.tdBare(NF.int));
    b.f(ws, 5, row, () => `IF(${pick}=0,"",${at(D.to)}-${at(D.from)})`, ST.tdBare(NF.int));
    b.f(ws, 6, row, () => `IF(${pick}=0,"",${at(D.rate)})`, ST.tdBare(NF.pct));
    b.f(ws, 7, row, () => `IF(${pick}=0,"",ROUND(SUMPRODUCT(${inRung}*${whole(W.saved)}),2))`, ST.tdBare(NF.cents));
    b.f(
      ws,
      8,
      row,
      () => `IF(${pick}=0,"",ROUND(SUMPRODUCT((${whole(W.group)}>0)*(${whole(W.group)}<=${i})*${whole(W.saved)}),2))`,
      ST.tdBare(NF.cents),
    );
    b.f(ws, 9, row, () => `IF(${pick}=0,"",SUMPRODUCT(${inRung}*${whole(W.used)}))`, ST.tdBare(NF.int));
    b.f(
      ws,
      10,
      row,
      ($) => {
        const units = `MAX(1,ROUND(E${row}/${$('w_L')}*${BAR_UNITS},0))`;
        const used = `IF(I${row}=0,0,MIN(${units},MAX(1,ROUND(I${row}/${$('w_L')}*${BAR_UNITS},0))))`;
        return `IF(${pick}=0,"",REPT("█",${used})&REPT("░",${units}-${used}))`;
      },
      { ...ST.bar(C.slateSoft), border: {} },
    );
    b.f(
      ws,
      11,
      row,
      ($) => `IF(${pick}=0,"",IF(F${row}=0,"–",REPT("█",MAX(1,ROUND(F${row}/${$('lad_maxRate')}*${RATE_UNITS},0)))))`,
      { ...ST.bar(C.good), border: {} },
    );
    b.f(
      ws,
      12,
      row,
      ($) =>
        `IF(${pick}=0,"",IF(${L(D.reason)}${row}="reliefCap","No tax saved: over the "&${dollarsText($('r_reliefCap'))}&" overall relief cap.",` +
        `IF(${L(D.reason)}${row}="belowTaxThreshold","No tax saved: this income is already tax-free.",` +
        `IF(I${row}>=E${row},"In your plan: "&ROUND(F${row}*1000,0)/10&" cents back per dollar.",` +
        `IF(I${row}>0,"Partly in your plan: "&ROUND(F${row}*1000,0)/10&" cents back per dollar.","Not in your plan: "&ROUND(F${row}*1000,0)/10&" cents back per dollar.")))))`,
      ST.tdBare(undefined, 'left', { size: 10, color: { argb: C.muted } }),
    );
  }
  b.reg('lad_taxAtBottom', ws, W.tax, end);

  // ---- Chart points --------------------------------------------------------------------------------------------
  // "Every rung" is the ladder. "Your plan" follows it, drops to zero where the plan stops and ends there: its x
  // values never pass the plan total. (Read against the ladder's own x values, as an application that gives a
  // chart a single x column would, it runs on along the axis instead, which is still true.) Rows for rungs that
  // do not exist repeat the last point, so the lines simply end.
  const pointsEnd = top + rows * 4 - 1;
  for (let i = 1; i <= rows; i++) {
    const rung = top + i - 1;
    const shown = `$${L(D.pick)}$${rung}>0`;
    const from = `$${L(D.from)}$${rung}`;
    const to = `$${L(D.to)}$${rung}`;
    const rate = `$${L(D.rate)}$${rung}`;
    for (let q = 1; q <= 4; q++) {
      const row = top + (i - 1) * 4 + q - 1;
      const before = (col: number): string => (row === top ? '0' : `${L(col)}${row - 1}`);
      b.f(
        ws,
        P.x,
        row,
        ($) => {
          const stop = `MAX(${from},MIN(${to},${$('w_X')}))`;
          return `IF(${shown},${q === 1 ? from : q === 4 ? to : stop},${before(P.x)})`;
        },
        ST.helper(NF.int),
      );
      b.f(ws, P.all, row, () => `IF(${shown},${rate},${before(P.all)})`, ST.helper(NF.pct));
      b.f(ws, P.planX, row, ($) => `MIN(${L(P.x)}${row},${$('w_X')})`, ST.helper(NF.int));
      b.f(
        ws,
        P.plan,
        row,
        ($) => `IF(${shown},IF(${q <= 2 ? `${from}<${$('w_X')}` : `${to}<=${$('w_X')}`},${rate},0),${before(P.plan)})`,
        ST.helper(NF.pct),
      );
    }
  }
  b.regRange('lad_chartX', ws, P.x, top, P.x, pointsEnd);
  b.regRange('lad_chartAll', ws, P.all, top, P.all, pointsEnd);
  b.regRange('lad_chartPlanX', ws, P.planX, top, P.planX, pointsEnd);
  b.regRange('lad_chartPlan', ws, P.plan, top, P.plan, pointsEnd);
  b.charts.push({
    sheet: SHEETS.ladder,
    from: { col: 1, row: chartTop - 1 },
    to: { col: LAST, row: chartTop - 1 + CHART_ROWS },
    title: 'Tax saved by each extra dollar you put in',
    xTitle: 'Extra contribution this year (S$)',
    yTitle: 'Tax saved per dollar',
    xNumFmt: '#,##0',
    yNumFmt: '0.0%',
    series: [
      // The whole ladder is a thin dark line; the plan is drawn over it, thick, as far as it goes.
      { nameKey: 'lad_chartAllName', xKey: 'lad_chartX', yKey: 'lad_chartAll', color: C.slate.slice(2), widthPt: 1.5 },
      { nameKey: 'lad_chartPlanName', xKey: 'lad_chartPlanX', yKey: 'lad_chartPlan', color: C.good.slice(2), widthPt: 4.5 },
    ],
  });

  // A rule under each rung that is shown.
  ws.addConditionalFormatting({
    ref: `B${top}:L${end}`,
    rules: [
      {
        type: 'expression',
        priority: 1,
        formulae: [`$${L(D.pick)}${top}>0`],
        style: { border: { bottom: { style: 'thin', color: { argb: C.line } } } },
      },
    ],
  });

  for (const [name, col] of [
    ['out_ladder_from', 3],
    ['out_ladder_to', 4],
    ['out_ladder_amount', 5],
    ['out_ladder_rate', 6],
    ['out_ladder_taxSaved', 7],
    ['out_ladder_cumulative', 8],
    ['out_ladder_used', 9],
    ['out_ladder_reason', D.reason],
  ] as const) {
    b.regRange(name, ws, col, top, col, end);
    b.define(name, name);
  }
  for (const [name, key] of [
    ['out_chart_x', 'lad_chartX'],
    ['out_chart_all', 'lad_chartAll'],
    ['out_chart_planX', 'lad_chartPlanX'],
    ['out_chart_plan', 'lad_chartPlan'],
  ] as const) {
    b.define(name, key);
  }

  view(ws, 2);
  // Print the chart and as many rungs as the year's own tax table can give; widen the print area for more.
  pageSetup(ws, { landscape: true, lastCol: 'L', lastRow: top + bracketCount + 1 });
  return ws;
}
