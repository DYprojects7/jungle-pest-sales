/**
 * The Ladder sheet (SPEC §6.7): the range of possible extra contributions cut into rungs that each save tax at
 * one rate, in the order the dollars would go in. One row per tax bracket crossed, then the over-the-cap row.
 * The "chart" is drawn with in-cell bars so it works the same in Excel, Google Sheets and LibreOffice.
 */
import type ExcelJS from 'exceljs';
import { Book, C, NF, SHEETS, ST, dollarsText, mergeRow, pageSetup, setWidths, styleRow, taxPayable, view } from '../kit';

const BAR_UNITS = 30;
const RATE_UNITS = 20;

export function buildLadder(b: Book): ExcelJS.Worksheet {
  const ws = b.sheet(SHEETS.ladder, C.good);
  setWidths(ws, [2, 7, 15, 15, 16, 13, 16, 17, 16, 36, 25, 46, 3, 10, 12, 12, 12, 14, 14, 18]);
  const LAST = 12;
  const bracketCount = b.rules.taxBrackets.length;

  ws.getRow(1).height = 32;
  mergeRow(ws, 1, 2, LAST, ST.title()).value = 'Your savings ladder';
  ws.getRow(2).height = 34;
  mergeRow(ws, 2, 2, LAST, ST.subtitle()).value =
    'Each extra dollar you lock away saves tax at the rate on your top dollar of income. As your chargeable income falls, ' +
    'that rate steps down a rung at a time. The plan climbs down the ladder and stops at the rung you chose on the Planner.';

  // Facts above the table.
  let r = 4;
  const fact = (key: string | null, label: string, formula: ($: (k: string) => string) => string, numFmt: string): void => {
    mergeRow(ws, r, 2, 5, ST.label()).value = label;
    b.f(ws, 6, r, formula, ST.value(numFmt, { bold: true }));
    ws.mergeCells(r, 6, r, 7);
    if (key) b.reg(key, ws, 6, r);
    r++;
  };
  fact(null, 'Chargeable income before any extra contribution', ($) => $('w_base_ci'), NF.dollars);
  fact(null, 'Room in the schemes you switched on', ($) => $('w_L'), NF.dollars);
  fact(null, 'Room under the overall relief cap', ($) => $('w_C'), NF.dollars);
  fact('lad_within', 'Dollars that can still lower your chargeable income (the smaller of the two)', ($) => `MIN(${$('w_L')},${$('w_C')})`, NF.dollars);
  fact(null, 'Your plan uses', ($) => $('w_X'), NF.dollars);
  // Working cell: the row of the Rules bracket table that holds the top dollar of chargeable income.
  b.v(ws, 14, 4, 'Top bracket row', ST.helperHead());
  b.f(ws, 15, 4, ($) => `MAX(1,SUMPRODUCT((${$('r_from')}<${$('w_base_ci')})*1))`, ST.helper(NF.plain));
  b.reg('lad_k0', ws, 15, 4);
  b.v(ws, 14, 5, 'Top rate in table', ST.helperHead());
  b.f(ws, 15, 5, ($) => `MAX(${$('r_rate')})`, ST.helper(NF.pct));
  b.reg('lad_maxRate', ws, 15, 5);
  r++;

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
    [14, 'Bracket row'],
    [15, 'Start'],
    [16, 'End'],
    [17, 'Dollars'],
    [18, 'Chargeable income at end'],
    [19, 'Tax payable at end'],
    [20, 'Zero-saving reason'],
  ];
  for (const [col, text] of helperHeads) b.v(ws, col, head, text, ST.helperHead());
  r++;

  const top = r;
  const capRow = top + bracketCount;
  for (let i = 1; i <= bracketCount + 1; i++) {
    const row = r;
    const isCapRow = i === bracketCount + 1;
    const prevTax = ($: (k: string) => string): string => (i === 1 ? $('w_base_tax') : `S${row - 1}`);

    // Working columns (always numbers).
    if (isCapRow) {
      b.v(ws, 14, row, '', ST.helper());
      b.f(ws, 15, row, ($) => $('lad_within'), ST.helper(NF.int));
      b.f(ws, 16, row, ($) => $('w_L'), ST.helper(NF.int));
    } else {
      b.f(ws, 14, row, ($) => `MAX(0,${$('lad_k0')}-${i - 1})`, ST.helper(NF.plain));
      b.f(ws, 15, row, () => (i === 1 ? '0' : `P${row - 1}`), ST.helper(NF.int));
      b.f(
        ws,
        16,
        row,
        ($) =>
          `IF(N${row}=0,O${row},IF(N${row}=1,${$('lad_within')},MAX(O${row},MIN(${$('lad_within')},${$('w_base_ci')}-INDEX(${$('r_from')},N${row})))))`,
        ST.helper(NF.int),
      );
    }
    b.f(ws, 17, row, () => `P${row}-O${row}`, ST.helper(NF.int));
    b.f(ws, 18, row, ($) => `MAX(0,${$('w_base_ci')}-MIN(P${row},${$('w_C')}))`, ST.helper(NF.int));
    b.f(ws, 19, row, ($) => taxPayable($, `R${row}`), ST.helper(NF.cents));
    b.f(
      ws,
      20,
      row,
      () => (isCapRow ? `IF(Q${row}>0,"reliefCap","")` : `IF(Q${row}>0,IF(F${row}=0,"belowTaxThreshold",""),"")`),
      ST.helper(undefined, 'left'),
    );

    // Display columns (blank when the rung is empty).
    b.f(ws, 2, row, () => `IF(Q${row}>0,COUNTIF(Q$${top}:Q${row},">0"),"")`, ST.td(NF.plain, 'left'));
    b.f(ws, 3, row, () => `IF(Q${row}>0,O${row},"")`, ST.td(NF.int));
    b.f(ws, 4, row, () => `IF(Q${row}>0,P${row},"")`, ST.td(NF.int));
    b.f(ws, 5, row, () => `IF(Q${row}>0,Q${row},"")`, ST.td(NF.int));
    b.f(ws, 6, row, ($) => (isCapRow ? `IF(Q${row}>0,0,"")` : `IF(Q${row}>0,INDEX(${$('r_rate')},N${row}),"")`), ST.td(NF.pct));
    b.f(ws, 7, row, ($) => `IF(Q${row}>0,ROUND(${prevTax($)}-S${row},2),"")`, ST.td(NF.cents));
    b.f(ws, 8, row, ($) => `IF(Q${row}>0,ROUND(${$('w_base_tax')}-S${row},2),"")`, ST.td(NF.cents));
    b.f(ws, 9, row, ($) => `IF(Q${row}>0,MAX(0,MIN(P${row},${$('w_X')})-O${row}),"")`, ST.td(NF.int));
    b.f(
      ws,
      10,
      row,
      ($) => {
        const units = `MAX(1,ROUND(Q${row}/${$('w_L')}*${BAR_UNITS},0))`;
        const used = `IF(I${row}=0,0,MIN(${units},MAX(1,ROUND(I${row}/${$('w_L')}*${BAR_UNITS},0))))`;
        return `IF(Q${row}>0,REPT("█",${used})&REPT("░",${units}-${used}),"")`;
      },
      ST.bar(C.slateSoft),
    );
    b.f(
      ws,
      11,
      row,
      ($) => `IF(Q${row}>0,IF(F${row}=0,"–",REPT("█",MAX(1,ROUND(F${row}/${$('lad_maxRate')}*${RATE_UNITS},0)))),"")`,
      ST.bar(C.good),
    );
    b.f(
      ws,
      12,
      row,
      ($) =>
        `IF(Q${row}>0,IF(T${row}="reliefCap","No tax saved: over the "&${dollarsText($('r_reliefCap'))}&" overall relief cap.",` +
        `IF(T${row}="belowTaxThreshold","No tax saved: this income is already tax-free.",` +
        `IF(I${row}>=Q${row},"In your plan: "&ROUND(F${row}*1000,0)/10&" cents back per dollar.",` +
        `IF(I${row}>0,"Partly in your plan.","Not in your plan: "&ROUND(F${row}*1000,0)/10&" cents back per dollar.")))),"")`,
      ST.td(undefined, 'left', { size: 10, color: { argb: C.muted } }),
    );
    r++;
  }
  const end = r - 1;
  b.v(ws, 2, r, 'All rungs', ST.total(undefined, 'left'));
  styleRow(ws, r, 3, LAST, ST.total());
  b.f(ws, 5, r, () => `SUM(Q${top}:Q${end})`, ST.total(NF.int));
  b.f(ws, 7, r, ($) => `ROUND(${$('w_base_tax')}-S${end},2)`, ST.total(NF.cents));
  b.f(ws, 9, r, () => `SUM(I${top}:I${end})`, ST.total(NF.int));
  r += 2;
  mergeRow(ws, r, 2, LAST, ST.note());
  b.f(
    ws,
    2,
    r,
    ($) =>
      `IF(${$('w_L')}=0,"No scheme with room is switched on, so there is no ladder to show. Switch a scheme on in the Planner.",` +
      `"How to read it: the ladder ignores your cash limit and your minimum rate, so you can see every rung. Rungs marked 'No tax saved' are money locked away for nothing.")`,
  );
  ws.getRow(r).height = 20;
  void capRow;

  for (const [name, col] of [
    ['out_ladder_from', 3],
    ['out_ladder_to', 4],
    ['out_ladder_amount', 5],
    ['out_ladder_rate', 6],
    ['out_ladder_taxSaved', 7],
    ['out_ladder_cumulative', 8],
    ['out_ladder_used', 9],
    ['out_ladder_reason', 20],
  ] as const) {
    b.regRange(name, ws, col, top, col, end);
    b.define(name, name);
  }

  view(ws, head);
  pageSetup(ws, { landscape: true, lastCol: 'L', lastRow: r });
  return ws;
}
