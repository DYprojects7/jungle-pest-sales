/**
 * The Ladder sheet (SPEC §6.7): the range of possible extra contributions cut into rungs that each save tax at
 * one rate, in the order the dollars would go in, as a chart and as a table.
 *
 * Layout: the working block on the right has one row per tax bracket (from the bracket holding the top dollar of
 * chargeable income downwards, with spare rows for brackets added on the Rules sheet), then a row for dollars
 * beyond chargeable income and a row for dollars over the relief cap. Neighbouring rows that save at the same
 * rate for the same reason form one rung, as in the engine; the table on the left shows the rungs, closed up.
 *
 * The chart is a real chart (added to the file by `workbook/chart.ts`): two filled series, "Your plan" and "Not
 * in your plan", stacked, so each rung is a block whose area is the tax it saves and the plan's block ends where
 * the plan stops — a ladder of one rung is still one clear block. It is fed by the "chart points" columns:
 * evenly spaced amounts from 0 to a round figure just past the schemes' room, each with the saving per dollar
 * there. The in-cell bars in the table say the same thing for applications that do not show the chart.
 *
 * No internal code is written on the sheet: why a rung saves nothing is a number in a working column
 * (1 = that income is already tax-free, 2 = over the overall relief cap), explained in its heading.
 */
import type ExcelJS from 'exceljs';
import { Book, C, NF, SHEETS, ST, centsNumber, colLetter, dollarsText, lit, mergeRow, pageSetup, setWidths, styleRow, taxPayable, view } from '../kit';
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
 * Chart points: the amount, the saving per dollar there if the plan uses that dollar and if it does not, and the
 * label under the axis (the amount at every CHART_LABEL_EVERY-th point, nothing in between, so every application
 * shows the same few round figures however it thins labels).
 */
const P = { x: 37, plan: 38, rest: 39, label: 40 } as const;
/** Steps along the chart's bottom axis (so one more point than this). */
export const CHART_STEPS = 200;
/** One axis label for every this many points. */
export const CHART_LABEL_EVERY = 20;
/** Why a rung saves nothing, as the number kept in the working columns. */
export const ZERO_REASON_NUMBERS = { belowTaxThreshold: 1, reliefCap: 2 } as const;

/**
 * What the sheet says above the chart when the schemes have no room, so there is nothing to draw. Someone whose
 * own CPF is switched on and waiting for its room (SPEC §6.5) is told to enter it, not to "switch a scheme on".
 */
export const NO_LADDER = {
  nothingOn: 'No scheme is switched on, so there is no ladder to show. Switch on SRS or a CPF top-up on the Planner.',
  notOpen: 'None of the schemes you switched on is open to you, so there is no ladder to show.',
  roomAwaited:
    'Your own CPF is left out until you enter how much you can still top up with relief, and nothing else you switched on has room left, so there is no ladder to show yet. Enter the figure on the Planner.',
  full: 'The schemes you switched on have no room left this year, so there is no ladder to show.',
} as const;

export function buildLadder(b: Book): ExcelJS.Worksheet {
  const ws = b.sheet(SHEETS.ladder, C.good);
  setWidths(ws, [
    2, 7, 15, 15, 16, 13, 16, 17, 16, 36, 25, 48, 3,
    9, 18, 11, 11, 9, 3,
    11, 11, 11, 11, 13, 13, 9, 18, 11, 11, 9, 18, 7, 7, 7, 7, 3,
    15, 15, 17, 12,
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
      // Why there is no ladder, as the Planner's reason tells it apart (SPEC §6.11): nothing switched on, nothing
      // open to the person, their own CPF waiting for its room, or every scheme already full.
      `IF(${$('w_L')}=0,` +
      `IF(SUM(${$('w_enabled_all')})=0,${lit(NO_LADDER.nothingOn)},` +
      `IF(SUMPRODUCT(${$('w_enabled_all')}*${$('w_eligible_all')})=0,${lit(NO_LADDER.notOpen)},` +
      `IF(AND(${$('w_selfUnconfirmed')}=1,${$('w_enabled_cpfSelf')}=1),${lit(NO_LADDER.roomAwaited)},${lit(NO_LADDER.full)}))),` +
      `${lit("How to read it: the ladder ignores your cash limit and your minimum, so you can see every rung. In the chart each rung is a block: its height is the tax saved per dollar, its area the tax saved. The dark block is your plan. Rungs marked 'No tax saved' have no height: money locked away for nothing.")})`,
  );
  b.reg('lad_note', ws, 2, r);
  b.define('out_ladderNote', 'lad_note');
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
  // The chart's bottom axis runs to a round figure just past the schemes' room, so the last block visibly ends.
  b.v(ws, W.k, 7, 'Chart: size of the round steps on the axis', ST.helper(undefined, 'left'));
  b.f(
    ws,
    W.dollars,
    7,
    ($) => {
      const room = $('w_L');
      const steps: Array<[number, number]> = [
        [20_000, 5_000],
        [8_000, 2_000],
        [4_000, 1_000],
        [2_000, 500],
        [800, 200],
        [400, 100],
        [200, 50],
        [80, 20],
        [40, 10],
        [20, 5],
        [8, 2],
      ];
      return steps.reduceRight((otherwise, [from, unit]) => `IF(${room}>=${from},${unit},${otherwise})`, '1');
    },
    ST.helper(NF.int),
  );
  b.reg('lad_chartUnit', ws, W.dollars, 7);
  b.v(ws, W.k, 8, 'Chart: where the axis ends', ST.helper(undefined, 'left'));
  b.f(ws, W.dollars, 8, ($) => `IF(${$('w_L')}=0,0,(INT(${$('w_L')}*21/(20*${$('lad_chartUnit')}))+1)*${$('lad_chartUnit')})`, ST.helper(NF.int));
  b.reg('lad_chartMax', ws, W.dollars, 8);

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
    [D.reason, 'Why it saves nothing (1 = already tax-free, 2 = over the relief cap)'],
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
    [W.reason, 'Why it saves nothing (1 or 2, as on the left)'],
    [W.saved, 'Tax saved'],
    [W.used, 'Used by plan'],
    [W.lastRate, 'Rate of the last row with dollars'],
    [W.lastReason, 'Its reason for saving nothing'],
    [W.isNew, 'New rung?'],
    [W.run, 'Rungs so far'],
    [W.group, 'Rung no.'],
    [W.count, 'Rung starts here'],
    [P.x, 'Chart: extra contribution'],
    [P.label, 'Chart: label under the axis'],
  ];
  for (const [col, text] of helperHeads) b.v(ws, col, head, text, ST.helperHead());
  // The chart's legend reads these two headings.
  b.f(ws, P.plan, head, ($) => `"Your plan (stops at S$"&TEXT(${$('w_X')},"#,##0")&")"`, ST.helperHead());
  b.v(ws, P.rest, head, 'Not in your plan', ST.helperHead());
  b.reg('lad_chartPlanName', ws, P.plan, head);
  b.reg('lad_chartRestName', ws, P.rest, head);
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
      b.f(ws, W.reason, row, () => `IF(AND(${at(W.dollars)}>0,${at(W.rate)}=0),${ZERO_REASON_NUMBERS.belowTaxThreshold},0)`, ST.helper(NF.plain));
    } else if (kind === 'beyond') {
      // Dollars beyond chargeable income: there is nothing left to tax.
      b.v(ws, W.k, row, 'beyond income', ST.helper(undefined, 'right'));
      b.f(ws, W.end, row, ($) => `MAX(${at(W.start)},${$('lad_within')})`, ST.helper(NF.int));
      b.v(ws, W.rate, row, 0, ST.helper(NF.pct));
      b.f(ws, W.reason, row, () => `IF(${at(W.dollars)}>0,${ZERO_REASON_NUMBERS.belowTaxThreshold},0)`, ST.helper(NF.plain));
    } else {
      b.v(ws, W.k, row, 'over cap', ST.helper(undefined, 'right'));
      b.f(ws, W.end, row, ($) => `MAX(${at(W.start)},${$('w_L')})`, ST.helper(NF.int));
      b.v(ws, W.rate, row, 0, ST.helper(NF.pct));
      b.f(ws, W.reason, row, () => `IF(${at(W.dollars)}>0,${ZERO_REASON_NUMBERS.reliefCap},0)`, ST.helper(NF.plain));
    }
    b.f(ws, W.dollars, row, () => `${at(W.end)}-${at(W.start)}`, ST.helper(NF.int));
    b.f(ws, W.ci, row, ($) => `MAX(0,${$('w_base_ci')}-MIN(${at(W.end)},${$('w_C')}))`, ST.helper(NF.int));
    b.f(ws, W.tax, row, ($) => taxPayable($, at(W.ci)), ST.helper(NF.cents));
    b.f(ws, W.saved, row, ($) => `ROUND(${i === 1 ? $('w_base_tax') : at(W.tax, previous)}-${at(W.tax)},2)`, ST.helper(NF.cents));
    b.f(ws, W.used, row, ($) => `MAX(0,MIN(${at(W.end)},${$('w_X')})-${at(W.start)})`, ST.helper(NF.int));
    // A row starts a new rung unless the last row with dollars saved at the same rate for the same reason.
    if (i === 1) {
      b.f(ws, W.lastRate, row, () => `IF(${at(W.dollars)}>0,${at(W.rate)},0)`, ST.helper(NF.pct));
      b.f(ws, W.lastReason, row, () => `IF(${at(W.dollars)}>0,${at(W.reason)},0)`, ST.helper(NF.plain));
      b.f(ws, W.isNew, row, () => `IF(${at(W.dollars)}>0,1,0)`, ST.helper(NF.plain));
      b.f(ws, W.run, row, () => at(W.isNew), ST.helper(NF.plain));
    } else {
      b.f(ws, W.lastRate, row, () => `IF(${at(W.dollars)}>0,${at(W.rate)},${at(W.lastRate, previous)})`, ST.helper(NF.pct));
      b.f(ws, W.lastReason, row, () => `IF(${at(W.dollars)}>0,${at(W.reason)},${at(W.lastReason, previous)})`, ST.helper(NF.plain));
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
    b.f(ws, D.reason, row, () => `IF(${pick}=0,0,INDEX(${whole(W.reason)},${pick}))`, ST.helper(NF.plain));
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
        `IF(${pick}=0,"",IF(${L(D.reason)}${row}=${ZERO_REASON_NUMBERS.reliefCap},"No tax saved: over the "&${dollarsText($('r_reliefCap'))}&" overall relief cap.",` +
        `IF(${L(D.reason)}${row}=${ZERO_REASON_NUMBERS.belowTaxThreshold},"No tax saved: this income is already tax-free.",` +
        `IF(I${row}>=E${row},"In your plan: "&${centsNumber(`F${row}`)}&" cents back per dollar.",` +
        `IF(I${row}>0,"Partly in your plan: "&${centsNumber(`F${row}`)}&" cents back per dollar.","Not in your plan: "&${centsNumber(`F${row}`)}&" cents back per dollar.")))))`,
      ST.tdBare(undefined, 'left', { size: 10, color: { argb: C.muted } }),
    );
  }
  b.reg('lad_taxAtBottom', ws, W.tax, end);

  // The working rows' rates and the dollars of each that the plan uses (for the caution shown to foreigners).
  b.regRange('lad_wRate', ws, W.rate, top, W.rate, end);
  b.regRange('lad_wUsed', ws, W.used, top, W.used, end);

  // ---- Chart points --------------------------------------------------------------------------------------------
  // Point i is at i/CHART_STEPS of the axis. Whether a point lies inside a rung, or inside the plan, is decided on
  // whole numbers (i × axis end against CHART_STEPS × the rung's ends), so every application agrees to the dollar.
  const pointsEnd = top + CHART_STEPS;
  const rungFrom = whole(D.from);
  const rungTo = whole(D.to);
  const rungRate = whole(D.rate);
  for (let i = 0; i <= CHART_STEPS; i++) {
    const row = top + i;
    const at = ($: Resolver): string => `${i}*${$('lad_chartMax')}`;
    b.f(ws, P.x, row, ($) => `${at($)}/${CHART_STEPS}`, ST.helper(NF.int));
    // With no room there is no axis to label (a row of "0" under an empty chart would read as a scale).
    if (i % CHART_LABEL_EVERY === 0) b.f(ws, P.label, row, ($) => `IF(${$('lad_chartMax')}=0,"",TEXT(${L(P.x)}${row},"#,##0"))`, ST.helper(undefined, 'right'));
    else b.v(ws, P.label, row, '', ST.helper(undefined, 'right'));
    b.f(
      ws,
      P.plan,
      row,
      ($) => `IF(${at($)}<${CHART_STEPS}*${$('w_X')},SUMPRODUCT((${CHART_STEPS}*${rungFrom}<=${at($)})*(${at($)}<${CHART_STEPS}*${rungTo})*${rungRate}),0)`,
      ST.helper(NF.pct),
    );
    b.f(
      ws,
      P.rest,
      row,
      ($) => `IF(${at($)}<${CHART_STEPS}*${$('w_X')},0,SUMPRODUCT((${CHART_STEPS}*${rungFrom}<=${at($)})*(${at($)}<${CHART_STEPS}*${rungTo})*${rungRate}))`,
      ST.helper(NF.pct),
    );
  }
  b.regRange('lad_chartX', ws, P.x, top, P.x, pointsEnd);
  b.regRange('lad_chartPlan', ws, P.plan, top, P.plan, pointsEnd);
  b.regRange('lad_chartRest', ws, P.rest, top, P.rest, pointsEnd);
  b.regRange('lad_chartLabel', ws, P.label, top, P.label, pointsEnd);
  b.charts.push({
    sheet: SHEETS.ladder,
    from: { col: 1, row: chartTop - 1 },
    to: { col: LAST, row: chartTop - 1 + CHART_ROWS },
    title: 'Tax saved by each extra dollar you put in',
    xTitle: 'Extra contribution this year (S$)',
    yTitle: 'Tax saved per dollar',
    xNumFmt: '#,##0',
    yNumFmt: '0.0%',
    categoriesKey: 'lad_chartLabel',
    labelEvery: CHART_LABEL_EVERY,
    series: [
      // Stacked, so the two never hide one another: the plan is the dark block, the rest of the ladder the pale one.
      { nameKey: 'lad_chartPlanName', valuesKey: 'lad_chartPlan', color: C.good.slice(2) },
      { nameKey: 'lad_chartRestName', valuesKey: 'lad_chartRest', color: C.line.slice(2) },
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
    ['out_chart_plan', 'lad_chartPlan'],
    ['out_chart_rest', 'lad_chartRest'],
    ['out_chart_max', 'lad_chartMax'],
    ['out_chart_label', 'lad_chartLabel'],
  ] as const) {
    b.define(name, key);
  }

  view(ws, 2);
  // Print the chart and as many rungs as the year's own tax table can give; widen the print area for more.
  pageSetup(ws, { landscape: true, lastCol: 'L', lastRow: top + bracketCount + 1 });
  return ws;
}
