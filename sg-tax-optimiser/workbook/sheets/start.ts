/**
 * The Start sheet: what the workbook is, three steps, what is on each sheet, what it covers and what it leaves
 * out, and the disclaimer (SPEC §9, §11). The list of what is not modelled and the disclaimer are the engine's
 * own text (`NOT_MODELLED`, `DISCLAIMER`), the same words the web page shows.
 */
import type ExcelJS from 'exceljs';
import { DISCLAIMER, NOT_MODELLED } from '../../src/engine/facts';
import { Book, C, SHEETS, ST, heightFor, mergeRow, pageSetup, setWidths, view } from '../kit';
import type { Style } from '../kit';
import { EXAMPLE } from './example';

export function buildStart(b: Book, version: string): ExcelJS.Worksheet {
  const ws = b.sheet(SHEETS.start, C.slate);
  const TEXT_WIDTH = 104;
  setWidths(ws, [2, 6, 26, TEXT_WIDTH, 2]);
  const LAST = 4;

  let r = 1;
  ws.getRow(r).height = 40;
  mergeRow(ws, r, 2, LAST, ST.title()).value = 'Singapore Tax Optimiser';
  r++;
  ws.getRow(r).height = 24;
  mergeRow(ws, r, 2, LAST, { ...ST.subtitle(), font: { ...ST.subtitle().font, size: 12 } });
  b.f(
    ws,
    2,
    r,
    ($) =>
      `"SRS + CPF contribution planner · Year of Assessment "&${$('r_ya')}&" (income earned and contributions made in "&${$('r_incomeYear')}&") · version ${version}"`,
  );
  b.reg('st_version', ws, 2, r);
  r++;
  ws.getRow(r).height = 36;
  mergeRow(ws, r, 2, LAST, ST.banner());
  b.f(
    ws,
    2,
    r,
    ($) =>
      `IF(${$('r_status')}="projected","PROJECTED RULES — the "&${$('r_incomeYear')}&" values are based on what has been announced so far and may change. Treat every figure as provisional.",` +
      `"Tell it your income and it tells you how much to put into SRS and CPF cash top-ups before 31 December to cut your tax — and where more stops being worth locking away.")`,
  );
  r += 2;

  const heading = (text: string): void => {
    ws.getRow(r).height = 22;
    mergeRow(ws, r, 2, LAST, ST.block()).value = text;
    r++;
  };
  const para = (text: string, style: Style = ST.text()): void => {
    ws.getRow(r).height = heightFor(text, TEXT_WIDTH + 32, 11);
    mergeRow(ws, r, 2, LAST, style).value = text;
    r++;
  };
  const item = (marker: string, title: string, text: string): void => {
    ws.getRow(r).height = Math.max(20, heightFor(text, TEXT_WIDTH, 11));
    b.v(ws, 2, r, marker, { ...ST.textBold(), alignment: { vertical: 'top', horizontal: 'center' }, font: { ...ST.textBold().font, color: { argb: C.ochre } } });
    b.v(ws, 3, r, title, ST.textBold());
    b.v(ws, 4, r, text, ST.text());
    r++;
  };
  /** A list line that runs the full width (the engine's sentences, unchanged). */
  const bullet = (marker: string, text: string): void => {
    ws.getRow(r).height = Math.max(20, heightFor(text, TEXT_WIDTH + 26, 11));
    b.v(ws, 2, r, marker, { ...ST.textBold(), alignment: { vertical: 'top', horizontal: 'center' }, font: { ...ST.textBold().font, color: { argb: C.ochre } } });
    mergeRow(ws, r, 3, LAST, ST.text()).value = text;
    r++;
  };
  const gap = (): void => {
    ws.getRow(r).height = 8;
    r++;
  };

  heading('What this workbook does');
  para(
    'Every extra dollar of tax relief saves tax at the rate on your top dollar of income, and that rate steps down as your chargeable income falls. ' +
      "This workbook works out your tax, then recommends how much to put into SRS, a cash top-up to your own CPF and cash top-ups to family members' CPF this year: every saving that is " +
      'worth it to you, and no dollar above the overall relief cap, the scheme caps or the point where your income is already tax-free. ' +
      'It cannot see your CPF balances, a matching grant or whether a family member qualifies, so it tells you where to check.',
  );
  gap();

  heading('Three steps');
  item(
    '1',
    'Fill in the Planner',
    `Open the Planner sheet and type your own figures over the cream cells. They start with a worked example (age ${EXAMPLE.age}, S$${EXAMPLE.salary.toLocaleString('en-US')} a month, S$${EXAMPLE.additionalWages.toLocaleString('en-US')} bonus) so you can see how it works. Salary can be typed per month or per year.`,
  );
  item(
    '2',
    'Read your plan',
    'The right-hand side of the Planner says how much to put where and what you save, how long the cash is locked away, your tax before and after, and why the plan stops where it does. "Things to check before you transfer" lists what you should confirm first.',
  );
  item(
    '3',
    'Check, then act',
    'Read the Before You Transfer sheet before you move any money: what locking it away means for each scheme, and what only you can check. Use the Ladder, Scenarios and Simulator sheets to see where more stops being worth it, and the Monthly Plan to get the money in before the deadline.',
  );
  gap();

  heading('What is on each sheet');
  item('›', 'Planner', 'Your details on the left, the recommendation on the right.');
  item('›', 'Ladder', 'The savings ladder as a chart and a table: how many cents of tax each further slice of contribution saves, and which slices the plan uses.');
  item('›', 'Scenarios', 'Side by side: do nothing more, SRS only, CPF top-up only, both, everything to the limit, and your plan, with any wasted dollars called out.');
  item('›', 'Simulator', 'Tax and saving for every extra S$1,000 (or the step you choose).');
  item('›', 'Monthly Plan', 'Instalments from this month to December, the days left, and a "start in January" figure for next year.');
  item('›', 'Tax Working', 'The full computation, before and after the plan, line by line, with the working behind it.');
  item('›', 'Before You Transfer', 'What locking the money away means for SRS and for CPF top-ups, and the things only you can check. Read it before you transfer.');
  item('›', 'Rules', 'Every rate, cap and ceiling the workbook uses, with sources. Edit the cream cells to update it for a new year.');
  gap();

  heading('What it covers');
  item('✓', 'Employees', 'Singapore tax residents with employment income: Citizens, Permanent Residents (including the first two years of PR status) and foreigners on work passes.');
  item('✓', 'The calculation', 'Compulsory employee CPF (with the wage ceilings and age bands), Earned Income Relief, your other reliefs as a total, donations, the overall relief cap, resident tax rates, and the three ways to earn more relief: SRS, a cash top-up to your own CPF and cash top-ups to family.');
  item('✓', 'Your limits', 'What you have already contributed this year, the top-up to your own CPF that can still earn relief (needed from age 55), how much you would give family, a cash limit, and the smallest saving per dollar you think is worth locking money away for.');
  gap();

  heading('What it does not model');
  for (const line of NOT_MODELLED) bullet('×', line);
  gap();

  heading('Good to know');
  item('•', 'Cream cells', 'Cream cells with blue text are yours to change. Everything else is a formula. The sheets are protected without a password so formulas are not overwritten by accident; switch protection off under Review › Unprotect Sheet if you want to explore.');
  item('•', 'Where it works', 'Made for Excel 2016 or later, Google Sheets (File › Import) and LibreOffice, using only functions all three share. No macros, no add-ins, no internet connection; nothing leaves your computer. Every figure is checked against the calculator by recalculating in LibreOffice; if another application shows something odd, the Tax Working sheet has every step.');
  item('•', 'Accuracy', 'CPF is worked out month by month from your salary; real payslips can differ by a few dollars. Enter your actual employee CPF on the Planner to be exact. Your Notice of Assessment from IRAS is the final word.');
  item('•', 'A new year', 'Each year has its own rates and ceilings. Update the cream cells on the Rules sheet from the official sources listed there (it says how to add a tax bracket, and checks the table for you), or use the edition for that Year of Assessment. The sentences on the Before You Transfer sheet are written for the year this edition was made for.');
  gap();

  heading('Important');
  para(DISCLAIMER, { ...ST.textBold(), fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: C.ochreFill } } });
  ws.getRow(r - 1).height = 38;
  para('The workbook never asks for your NRIC, name or account numbers. Information about tax relief is general information, not a recommendation to buy any investment product.', ST.note());

  view(ws, 0);
  pageSetup(ws, { landscape: false, lastCol: 'D', lastRow: r - 1, onePage: true });
  return ws;
}
