# Workbook generator

`npm run build:workbook` writes `release/SG-Tax-Optimiser-YA2027.xlsx` (income year 2026) from the same rule data
as the engine. `-- --year 2025` or `2027` builds another year. `npx vitest run tests/workbook.test.ts` checks it.

| File | What it does |
|---|---|
| `build.ts` | Entry point: builds the eight sheets, names the cells (`in_*`, `out_*`, `rule_*`), writes the file |
| `kit.ts` | Named-cell registry, shared formula fragments, styles |
| `sheets/*.ts` | One file per sheet. `working.ts` holds the model of SPEC §6 |
| `chart.ts` | Adds the Ladder chart to the written file (ExcelJS cannot write charts) |
| `recalc.ts` | Recalculation with headless LibreOffice, for the build's cached results and for the tests |
| `uno/edit_workbook.py` | Edits a workbook inside LibreOffice (insert or remove rows), for the tests |

## What the tests prove, and what they cannot

Every figure is compared with the engine after recalculation in **LibreOffice**. The tests also insert and remove
tax-bracket rows inside LibreOffice and check the result against the engine. Nothing in this repository can open
the file in **Microsoft Excel** or **Google Sheets**, so that check is done by hand before each release.

## Before each release: open it in Excel and in Google Sheets

Do this with the file from `release/`, once in desktop Excel (2016 or Microsoft 365) and once in Google Sheets
(File › Import › Upload).

1. **It opens cleanly.** No "We found a problem with some content" repair prompt in Excel; no import warning in Sheets.
2. **The example is right.** Planner shows S$15,300 into SRS, S$8,000 into your own CPF and S$2,679.50 tax saved,
   with the "EXAMPLE SHOWN" banner.
3. **The dropdowns work.** Change Residency to Foreigner and back. Set the minimum rate to `0.0%` (the cell should
   read "Any saving") and to `7.0%`. Type `10%` into the minimum-rate cell: it should be accepted after a warning.
4. **Every cream cell takes a value.** Type a number in each cream cell on the Planner, the as-at date on Monthly
   Plan and the step on Simulator. Clear the optional cells again; the notes beside them should say "Blank…" (or "Not filled in…" beside the CPF figure).
5. **The Ladder chart is there.** Monthly salary 4,600, bonus 9,000, other reliefs 0, family top-ups Yes, minimum
   rate 0.0%: the chart steps down 7% → 3.5% → 2% → 0%, and the thick line stops at S$30,360. In Google Sheets
   the chart may be drawn differently or left out; the bars in the table beside it are the fallback.
6. **Adding a tax bracket works.** On Rules, insert a row above "Bracket 6", type 100,000 and 13%, and copy the
   three grey cells from the row above into the new row. With a monthly salary of 15,000 the Planner's "Tax without
   any more contributions" should read S$15,798.00 and the check under the table should say OK. Undo.
7. **Nothing is clipped.** Read the Start sheet, the Planner notes and the Tax Working messages: no cut-off text,
   no `#####`.
8. **It prints.** Print preview of Planner (one landscape page) and Ladder (chart and table on one page).

If something differs in Excel or Sheets, fix the generator, not the file, and add a test for it.

## Updating for a new year

Follow SPEC §13, then `npm run build:workbook -- --year <year>`. A buyer can also update the file itself on the
Rules sheet: the deadline follows the income year, new tax brackets are inserted above the grey end line, and a
check under the table (repeated at the top of the Planner) says when the table is out of order.
