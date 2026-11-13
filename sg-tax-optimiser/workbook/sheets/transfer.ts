/**
 * The Before You Transfer sheet (SPEC §9 item 8): what locking the money away means for each scheme, and the
 * things only the person can check — the same words as the web page.
 *
 * Nothing here is written by hand. Every sentence is what the engine's `lockUpFacts` and `transferCautions`
 * (SPEC §7) return for this year's rules, taken at build time for each case the wording depends on — residency,
 * below 55 or 55 and over, deadline passed or not — and a formula shows the case that matches the Planner's
 * residency and age and the Monthly Plan's date. A scheme that is not open to the person is left blank, with one
 * line saying so.
 *
 * Because the sentences are fixed when the workbook is made, they quote that year's figures. If the Rules sheet
 * is changed afterwards, a line at the top of the sheet says so.
 */
import type ExcelJS from 'exceljs';
import { DISCLAIMER, NON_RESIDENT_SRS_COST, lockUpFacts, transferCautions } from '../../src/engine/facts';
import { RETIREMENT_ACCOUNT_AGE } from '../../src/engine/levers';
import type { LeverId } from '../../src/engine/types';
import { Book, C, SHEETS, ST, dollarsText, grossTaxCents, heightFor, isNum, lit, mergeRow, pageSetup, setWidths, styleRow, view } from '../kit';
import type { Resolver } from '../kit';
import { LEVER_NAMES, NO, RESIDENCY_ORDER, YES } from './rules';

/** One case the wording can depend on: residency (1 citizen, 2 PR, 3 foreigner), 55 or over, deadline passed. */
interface Variant {
  res: 1 | 2 | 3;
  older: 0 | 1;
  passed: 0 | 1;
}

const RES_VALUES = [1, 2, 3] as const;
const FLAG_VALUES = [0, 1] as const;

/** Ages that stand for "below 55" and "55 and over" when the engine is asked for its text. */
const AGE_FOR = { 0: RETIREMENT_ACCOUNT_AGE - 20, 1: RETIREMENT_ACCOUNT_AGE } as const;

const LEVERS: { id: LeverId; col: number }[] = [
  { id: 'srs', col: 3 },
  { id: 'cpfSelf', col: 4 },
  { id: 'cpfFamily', col: 5 },
];
/** Column widths of the three schemes: SRS is wider, its "Tax later" sentence for a foreigner being the longest. */
const SCHEME_WIDTHS: Record<LeverId, number> = { srs: 64, cpfSelf: 50, cpfFamily: 50 };
const TEXT_FONT = 10;

/**
 * A formula that gives `textOf(variant)` for the case the Planner describes. Cases with the same text share a
 * branch, so a sentence that does not depend on (say) the deadline is written once.
 */
function switchText(textOf: (variant: Variant) => string, $: Resolver): string {
  const byPassed = (res: Variant['res'], older: Variant['older']): string => {
    const [open, closed] = FLAG_VALUES.map((passed) => lit(textOf({ res, older, passed }))) as [string, string];
    return open === closed ? open : `IF(${$('m_days')}<0,${closed},${open})`;
  };
  const byAge = (res: Variant['res']): string => {
    const [younger, older] = FLAG_VALUES.map((flag) => byPassed(res, flag)) as [string, string];
    return younger === older ? younger : `IF(${$('u_age')}>=${RETIREMENT_ACCOUNT_AGE},${older},${younger})`;
  };
  const [citizen, pr, foreigner] = RES_VALUES.map((res) => byAge(res)) as [string, string, string];
  if (citizen === pr) return citizen === foreigner ? citizen : `IF(${$('u_res')}=3,${foreigner},${citizen})`;
  return `CHOOSE(${$('u_res')},${citizen},${pr},${foreigner})`;
}

function allVariants(): Variant[] {
  const out: Variant[] = [];
  for (const res of RES_VALUES) for (const older of FLAG_VALUES) for (const passed of FLAG_VALUES) out.push({ res, older, passed });
  return out;
}

export function buildTransfer(b: Book): ExcelJS.Worksheet {
  const rules = b.rules;
  const ws = b.sheet(SHEETS.transfer, C.ochre);
  setWidths(ws, [2, 22, SCHEME_WIDTHS.srs, SCHEME_WIDTHS.cpfSelf, SCHEME_WIDTHS.cpfFamily, 2]);
  const LAST = 5;
  const LIST_WIDTH = SCHEME_WIDTHS.srs + SCHEME_WIDTHS.cpfSelf + SCHEME_WIDTHS.cpfFamily;
  const FULL_WIDTH = 22 + LIST_WIDTH;
  const variants = allVariants();
  const profileOf = (variant: Variant) => ({ residency: RESIDENCY_ORDER[variant.res - 1] ?? 'citizen', ageAtYearEnd: AGE_FOR[variant.older] });
  const factsOf = (variant: Variant) => lockUpFacts(rules, profileOf(variant));
  const cautionsOf = (variant: Variant) => transferCautions(rules, profileOf(variant), { deadlinePassed: variant.passed === 1 });

  let r = 1;
  ws.getRow(r).height = 30;
  mergeRow(ws, r, 2, 3, ST.title()).value = 'Before you transfer';
  // Who the sheet is written for right now, so a reader can see it has followed the Planner. It sits in the title
  // bar (which stays in view, and is printed on every page) and so takes no row of its own: the nine rows of the
  // table then still fit the first printed page with the line for foreigners above them.
  mergeRow(ws, r, 4, LAST, { ...ST.titleNote(), font: { ...ST.titleNote().font, bold: true } });
  b.f(
    ws,
    4,
    r,
    ($) =>
      `"Shown for: "&INDEX(${$('l_residency')},${$('u_res')})&", "&IF(${$('u_age')}>=${RETIREMENT_ACCOUNT_AGE},"aged ${RETIREMENT_ACCOUNT_AGE} or over","below ${RETIREMENT_ACCOUNT_AGE}")&` +
      `", income year "&${$('r_incomeYear')}&IF(${$('m_days')}<0," (the deadline has passed)","")&"."`,
  );
  b.reg('t_shownFor', ws, 4, r);
  r++;
  ws.getRow(r).height = 22;
  mergeRow(ws, r, 2, LAST, ST.subtitle()).value =
    'What locking the money away means for each scheme, and the things only you can check. It follows the residency and age on the Planner ' +
    'and the date on the Monthly Plan sheet, and says the same as the web calculator.';
  r++;

  // The sentences quote the figures of the year the workbook was made for: say so if the Rules sheet has moved on.
  ws.getRow(r).height = 18;
  mergeRow(ws, r, 2, LAST, { ...ST.note(), font: { ...ST.note().font, size: 10, bold: true, color: { argb: C.warn } } });
  b.f(ws, 2, r, ($) => {
    const [dy, dm, dd] = rules.contributionDeadline.split('-').map(Number) as [number, number, number];
    const { cpfTopUp, srs } = rules;
    const firstTaxed = rules.taxBrackets.find((bracket) => bracket.rate > 0);
    const same: string[] = [
      `${$('r_incomeYear')}=${rules.incomeYear}`,
      `${$('r_status')}="${rules.status}"`,
      `${$('m_deadline')}=DATE(${dy},${dm},${dd})`,
      `${$('r_srsCapCitizenPr')}=${srs.capCitizenPr}`,
      `${$('r_srsCapForeigner')}=${srs.capForeigner}`,
      `${$('r_srsMinAge')}=${srs.minAge}`,
      `ROUND(${$('r_nrCost')}*1000,0)=${Math.round(NON_RESIDENT_SRS_COST.atRetirementOrTenYears * 1000)}`,
      `ROUND(${$('r_nrCostEarly')}*1000,0)=${Math.round(NON_RESIDENT_SRS_COST.early * 1000)}`,
      `${$('r_selfCap')}=${cpfTopUp.selfReliefCap}`,
      `${$('r_famCap')}=${cpfTopUp.familyReliefCap}`,
      `${$('r_frs')}=${cpfTopUp.fullRetirementSum}`,
      `${$('r_ers')}=${cpfTopUp.enhancedRetirementSum}`,
      `${$('r_bhs')}=${cpfTopUp.basicHealthcareSum}`,
      `ROUND(${$('r_interest')}*10000,0)=${Math.round(cpfTopUp.interestRateSmra * 10_000)}`,
      `${$('r_matchedRetirement')}=${cpfTopUp.matchedTopUps.retirementAnnualCap}`,
      cpfTopUp.matchedTopUps.mediSaveAnnualCap === null
        ? `NOT(${isNum($('r_matchedMediSave'))})`
        : `${$('r_matchedMediSave')}=${cpfTopUp.matchedTopUps.mediSaveAnnualCap}`,
      `${$('r_payoutAge')}=${cpfTopUp.payoutEligibilityAge}`,
      ...RESIDENCY_ORDER.map(
        (residency, index) => `INDEX(${$('r_famGiver')},${index + 1})="${cpfTopUp.familyGiverResidency.includes(residency) ? YES : NO}"`,
      ),
    ];
    // The tax-free band (it sets the S$40,000 a year that comes out of SRS tax-free) still ends where it did.
    if (firstTaxed) same.push(`${grossTaxCents($, String(firstTaxed.from))}=0`, `${grossTaxCents($, String(firstTaxed.from + 1))}>0`);
    return (
      `IF(AND(${same.join(',')}),"",` +
      `"CHECK — the Rules sheet has been changed since this workbook was made. The sentences below still quote the figures for income year ${rules.incomeYear} as issued: read them against the Rules sheet.")`
    );
  });
  b.reg('t_stale', ws, 2, r);
  r += 1;

  // ---- What locking the money away means -----------------------------------------------------------------------
  mergeRow(ws, r, 2, LAST, ST.block()).value = 'What locking the money away means';
  ws.getRow(r).height = 20;
  r++;
  // Above the table, one line for a person to whom no CPF top-up is open (a foreigner): they see SRS only. As on
  // the web page, the line is the engine's own note for foreigners (SPEC §6.11); the test holds it to the engine's
  // message. It sits above the table, not under it, so that it is never printed on a different page from the
  // columns it explains.
  ws.getRow(r).height = 18;
  mergeRow(ws, r, 2, LAST, { ...ST.label(), font: { ...ST.label().font, color: { argb: C.warn } } });
  b.f(
    ws,
    2,
    r,
    ($) =>
      `IF(AND(${$('w_eligible_srs')}=0,${$('w_eligible_cpfSelf')}=0,${$('w_eligible_cpfFamily')}=0),"None of the schemes is open to you on these numbers. ","")&` +
      `IF(AND(${$('w_eligible_cpfSelf')}=0,${$('w_eligible_cpfFamily')}=0),` +
      `"Foreigners on work passes do not contribute to CPF, so there is no CPF relief and CPF top-ups do not earn tax relief."&IF(${$('w_eligible_srs')}=1," You can put up to "&${dollarsText($('w_cap_srs'))}&" a year into SRS.",""),"")`,
  );
  b.reg('t_cpfLine', ws, 2, r);
  r++;
  ws.getRow(r).height = 20;
  b.v(ws, 2, r, '', ST.th('left'));
  // Only the schemes that are open to the person are filled in, as on the web page.
  const openTo: Record<LeverId, ($: Resolver) => string> = {
    srs: ($) => `${$('w_eligible_srs')}=1`,
    cpfSelf: ($) => `${$('w_eligible_cpfSelf')}=1`,
    cpfFamily: ($) => `${$('w_eligible_cpfFamily')}=1`,
  };
  for (const lever of LEVERS) {
    b.f(ws, lever.col, r, ($) => `IF(${openTo[lever.id]($)},"${LEVER_NAMES[lever.id]}","${LEVER_NAMES[lever.id]} (not open to you)")`, ST.th('left'));
  }
  b.regRange('t_factsHead', ws, 3, r, 5, r);
  r++;
  const factsTop = r;
  const sample = factsOf({ res: 1, older: 0, passed: 0 });
  const cellStyle = { ...ST.tdWrap({ size: TEXT_FONT }), alignment: { vertical: 'top' as const, horizontal: 'left' as const, indent: 1, wrapText: true } };
  sample.forEach((row, index) => {
    // The row heading is the same in every case; the engine's own label.
    for (const variant of variants) {
      if (factsOf(variant)[index]?.label !== row.label) throw new Error(`lockUpFacts row ${index} changes its label between cases`);
    }
    b.v(ws, 2, r, row.label, { ...ST.tdWrap({ bold: true }), alignment: { vertical: 'top', horizontal: 'left', indent: 1, wrapText: true } });
    let height = 20;
    for (const lever of LEVERS) {
      const textOf = (variant: Variant): string => factsOf(variant)[index]?.values[lever.id] ?? '';
      // Tall enough for the longest sentence any case puts in this cell.
      const longest = Math.max(...variants.map((variant) => textOf(variant).length));
      height = Math.max(height, heightFor(longest, SCHEME_WIDTHS[lever.id], TEXT_FONT));
      b.f(ws, lever.col, r, ($) => `IF(${openTo[lever.id]($)},${switchText(textOf, $)},"")`, cellStyle);
    }
    ws.getRow(r).height = height;
    r++;
  });
  const factsEnd = r - 1;
  b.regRange('t_factsLabel', ws, 2, factsTop, 2, factsEnd);
  for (const lever of LEVERS) b.regRange(`t_facts_${lever.id}`, ws, lever.col, factsTop, lever.col, factsEnd);

  ws.getRow(r).height = 8;
  r++;

  // ---- Things only you can check -------------------------------------------------------------------------------
  mergeRow(ws, r, 2, LAST, ST.block()).value = 'Check before you move money';
  ws.getRow(r).height = 22;
  r++;
  const cautionRows = Math.max(...variants.map((variant) => cautionsOf(variant).length));
  const cautionsTop = r;
  for (let index = 0; index < cautionRows; index++) {
    const textOf = (variant: Variant): string => cautionsOf(variant)[index] ?? '';
    const longest = Math.max(...variants.map((variant) => textOf(variant).length));
    ws.getRow(r).height = Math.max(20, heightFor(longest, LIST_WIDTH, TEXT_FONT));
    const row = r;
    styleRow(ws, row, 2, LAST, cellStyle);
    // Numbered, and only while the line has text: a case with fewer lines leaves the last rows empty.
    b.f(ws, 2, row, () => `IF(C${row}="","",${index + 1})`, {
      ...cellStyle,
      alignment: { vertical: 'top', horizontal: 'right', indent: 1 },
      font: { ...cellStyle.font, bold: true, color: { argb: C.ochre } },
    });
    ws.mergeCells(row, 3, row, LAST);
    b.f(ws, 3, row, ($) => switchText(textOf, $));
    r++;
  }
  b.regRange('t_cautions', ws, 3, cautionsTop, 3, r - 1);
  ws.getRow(r).height = 8;
  r++;

  ws.getRow(r).height = heightFor(DISCLAIMER, FULL_WIDTH, 9);
  mergeRow(ws, r, 2, LAST, ST.note()).value = DISCLAIMER;

  b.sizes.factRows = sample.length;
  b.sizes.cautionRows = cautionRows;

  view(ws, 2);
  pageSetup(ws, { landscape: true, lastCol: 'E', lastRow: r, titleRows: '1:1' });
  return ws;
}
