/**
 * The Start sheet: what the workbook is, three steps, what it covers and does not cover, and the disclaimer
 * (SPEC §9, §11).
 */
import type ExcelJS from 'exceljs';
import { Book, C, SHEETS, ST, mergeRow, pageSetup, setWidths, view } from '../kit';
import type { Style } from '../kit';

export const DISCLAIMER =
  'This is an estimate for planning, not tax, legal or financial advice. It is not affiliated with IRAS or the CPF Board. ' +
  'Check your eligibility and limits with IRAS, the CPF Board and your SRS bank before transferring money. CPF top-ups cannot be reversed.';

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
      `"SRS + CPF contribution planner · Year of Assessment "&${$('r_ya')}&" (income earned and contributions made in "&${$('r_incomeYear')}&") · workbook version ${version}"`,
  );
  r++;
  ws.getRow(r).height = 22;
  mergeRow(ws, r, 2, LAST, ST.banner());
  b.f(
    ws,
    2,
    r,
    ($) =>
      `IF(${$('r_status')}="projected","PROJECTED RULES — the "&${$('r_incomeYear')}&" values are based on what has been announced so far and may change. Treat every figure as provisional.",` +
      `"Tell it your income and it tells you how much to put into SRS and CPF before 31 December to cut your tax — and not a dollar more than is worth locking away.")`,
  );
  r += 2;

  /**
   * Row height for wrapped text in a column `width` characters wide. Row heights are fixed because merged cells
   * never grow by themselves, so the estimate errs on the tall side: it assumes fewer characters per line than
   * Calibri fits, which leaves room for other fonts and applications.
   */
  const heightFor = (text: string, width: number, lineHeight = 15.5): number =>
    Math.max(1, Math.ceil(text.length / (width * 0.98))) * lineHeight + 4;

  const heading = (text: string): void => {
    ws.getRow(r).height = 22;
    mergeRow(ws, r, 2, LAST, ST.block()).value = text;
    r++;
  };
  const para = (text: string, style: Style = ST.text()): void => {
    ws.getRow(r).height = heightFor(text, TEXT_WIDTH + 30);
    mergeRow(ws, r, 2, LAST, style).value = text;
    r++;
  };
  const item = (marker: string, title: string, text: string): void => {
    ws.getRow(r).height = Math.max(20, heightFor(text, TEXT_WIDTH));
    b.v(ws, 2, r, marker, { ...ST.textBold(), alignment: { vertical: 'top', horizontal: 'center' }, font: { ...ST.textBold().font, color: { argb: C.ochre } } });
    b.v(ws, 3, r, title, ST.textBold());
    b.v(ws, 4, r, text, ST.text());
    r++;
  };
  const gap = (): void => {
    ws.getRow(r).height = 8;
    r++;
  };

  heading('What this workbook does');
  para(
    'Every extra dollar of tax relief saves tax at the rate on your top dollar of income, and that rate steps down as your chargeable income falls. ' +
      'This workbook works out your tax, then recommends how much to put into SRS, your own CPF and family members\' CPF this year: enough to earn every saving that is ' +
      'worth it to you, without wasting money above the overall relief cap, the scheme caps or the point where your income is already tax-free.',
  );
  gap();

  heading('Three steps');
  item('1', 'Fill in the Planner', 'Open the Planner sheet and type your own figures over the cream cells. They start with a worked example (age 35, S$10,000 a month, S$15,000 bonus) so you can see how it works.');
  item('2', 'Read your plan', 'The right-hand side of the Planner shows how much to put into each scheme, your tax before and after, the tax saved, the saving per dollar, and a sentence on why the plan stops where it does. "Things to check" lists anything you should confirm first.');
  item('3', 'Decide and act', 'Use the Ladder, Scenarios and Simulator sheets to see where more money stops being worth it, then follow the Monthly Plan to get the money in before the deadline.');
  gap();

  heading('What is on each sheet');
  item('›', 'Planner', 'Your details on the left, the recommendation on the right.');
  item('›', 'Ladder', 'The savings ladder as a chart and a table: how many cents of tax each further slice of contribution saves, and which slices the plan uses.');
  item('›', 'Scenarios', 'Side by side: do nothing, SRS only, CPF only, both, everything, and the recommended plan, with any wasted dollars called out.');
  item('›', 'Simulator', 'Tax and saving for every extra S$1,000 (or the step you choose).');
  item('›', 'Monthly Plan', 'Instalments from this month to December, the days left, and a "start in January" figure for next year.');
  item('›', 'Tax Working', 'The full computation, before and after the plan, line by line, with the working behind it.');
  item('›', 'Rules', 'Every rate, cap and ceiling the workbook uses, with sources. Edit the cream cells to update it for a new year.');
  gap();

  heading('What it covers');
  item('✓', 'Employees', 'Singapore tax residents with employment income: Citizens, Permanent Residents (including the first two years of PR status) and foreigners on work passes.');
  item('✓', 'The calculation', 'Compulsory employee CPF (with the wage ceilings and age bands), Earned Income Relief, your other reliefs as a total, donations, the overall relief cap, resident tax rates, and the three ways to earn more relief: SRS, CPF cash top-ups to yourself and CPF cash top-ups to family.');
  item('✓', 'Your limits', 'What you have already contributed this year, the room left in your CPF accounts, how much you are willing to give family, a cash limit, and the smallest saving per dollar you think is worth locking money away for.');
  gap();

  heading('What it does not cover');
  item('×', 'Other taxpayers', 'Self-employed income and its MediSave obligations; non-residents for tax purposes.');
  item('×', 'Other rules', 'The Parenthood Tax Rebate (a credit carried forward: with unused rebate you will pay less than shown this year), employer SRS contributions, the Not Ordinarily Resident scheme, foreign-sourced income and rental expenses.');
  item('×', 'Eligibility checks', 'It adds up the reliefs you enter; it cannot check that you qualify, that a family member is eligible, that a top-up attracts no matching grant, or how much room your CPF accounts have. Enter those limits yourself.');
  item('×', 'Investing', 'What SRS or CPF money earns afterwards, tax on SRS withdrawals in retirement, or projections of your balances.');
  gap();

  heading('Good to know');
  item('•', 'Cream cells', 'Cream cells with blue text are yours to change. Everything else is a formula. The sheets are protected without a password so formulas are not overwritten by accident; switch protection off under Review › Unprotect Sheet if you want to explore.');
  item('•', 'Where it works', 'Made for Excel 2016 or later, Google Sheets (File › Import) and LibreOffice, using only functions all three share. No macros, no add-ins, no internet connection; nothing leaves your computer. Every figure is checked against the calculator by recalculating in LibreOffice; if another application shows something odd, the Tax Working sheet has every step.');
  item('•', 'Accuracy', 'CPF is worked out month by month from your salary; real payslips can differ by a few dollars. Enter your actual employee CPF on the Planner to be exact. Your Notice of Assessment from IRAS is the final word.');
  item('•', 'A new year', 'Each year has its own rates and ceilings. Update the cream cells on the Rules sheet from the official sources listed there (it says how to add a tax bracket, and checks the table for you), or use the edition for that Year of Assessment.');
  gap();

  heading('Important');
  para(DISCLAIMER, { ...ST.textBold(), fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: C.ochreFill } } });
  ws.getRow(r - 1).height = 38;
  para('The workbook never asks for your NRIC, name or account numbers. Information about tax relief is general information, not a recommendation to buy any investment product.', ST.note());

  view(ws, 0);
  pageSetup(ws, { landscape: false, lastCol: 'D', lastRow: r - 1, onePage: true });
  return ws;
}
