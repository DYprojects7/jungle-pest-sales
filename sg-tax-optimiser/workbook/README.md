# Workbook generator

`npm run build:workbook` writes `release/SG-Tax-Optimiser-YA2027.xlsx` (income year 2026) from the same rule data
as the engine. `-- --year 2025` or `2027` builds another year. `npx vitest run tests/workbook.test.ts` checks it.

| File | What it does |
|---|---|
| `build.ts` | Entry point: builds the nine sheets, names the cells (`in_*`, `out_*`, `rule_*`), writes the file |
| `kit.ts` | Named-cell registry, shared formula fragments, styles, row heights for wrapped text |
| `sheets/*.ts` | One file per sheet. `working.ts` holds the model of SPEC §6; `transfer.ts` the Before You Transfer sheet |
| `sheets/example.ts` | The worked example the cream cells open with, and the minimum saving per dollar each residency starts at |
| `chart.ts` | Adds the Ladder chart to the written file (ExcelJS cannot write charts) and gives every part of the file a fixed date |
| `recalc.ts` | Recalculation with headless LibreOffice, for the build's cached results and for the tests |
| `uno/edit_workbook.py` | Edits a workbook inside LibreOffice (insert or remove rows), for the tests |

The nine sheets, in tab order: Start, Planner, Ladder, Scenarios, Simulator, Monthly Plan, Tax Working, Before You
Transfer, Rules.

## Where the words come from

- **Before You Transfer** is not written by hand. Every sentence is what the engine's `lockUpFacts` and
  `transferCautions` (`src/engine/facts.ts`) return, taken when the workbook is built for each case the wording
  depends on (residency; below 55 or 55 and over; deadline passed or not) and switched by formula. The Start
  sheet's "What it does not model" list and every disclaimer are the engine's `NOT_MODELLED` and `DISCLAIMER`.
  To change one of these sentences, change it in the engine: both the page and the workbook follow.
- Because those sentences are fixed at build time, they quote the figures of the year the file was built for. If a
  buyer changes a figure they quote on the Rules sheet, a line at the top of Before You Transfer says so.
- **"Things to check"** on the Planner repeats the engine's warning messages (SPEC §6.11) word for word, by
  formula; the test compares every line with the engine.
- **No internal code is written on a sheet** (SPEC §9): no warning code, no constraint or scenario identifier.
  Where a formula needs one it is a number explained in a heading. A test scans every sheet, typed-in and
  calculated, for anything that reads like a code.
- The recommendation sentence, the lock-up line (with the 10-year rule for a foreigner and the sentence about an
  earlier first SRS contribution), the affordability note and the names of schemes and options are the web
  page's; a test compares them with the page's own functions in `src/web/text.ts`, so a rewording there fails the
  workbook tests until the workbook follows.
- **"How far down the ladder?" starts where the page starts**: 7 cents per dollar, or 11.5 cents for a foreigner
  (who pays at least 7.5 cents per dollar to take SRS out after leaving). The cell opens as a formula that
  follows the Residency cell; a rate typed or picked over it stays. A test holds both figures to the page's
  `defaultMinRate` and to the sentence in `release/BUYER-GUIDE.md`. A cleared cell means every tax dollar (SPEC
  §6.0), and the note beside it says so.

## Building

- **Build with LibreOffice installed** (`soffice` on `PATH`). The build recalculates the file so that it carries
  its results; previews and viewers that do not calculate would otherwise show empty cells. Without LibreOffice
  the build still writes the file but prints a loud warning, and `SGTO_STRICT=1 npm run build:workbook` refuses.
  `npm run test:release` fails if the file in `release/` has no calculated results.
- **The file is reproducible.** Every part of the zip carries the same fixed date, so an unchanged build on the
  same day leaves `release/*.xlsx` byte for byte the same. The results stored in the file are worked out "as at"
  the day of the build (days to the deadline, the monthly instalments), so a build on another day differs in
  those cached values only; every spreadsheet application works them out again on opening. The build prints the
  day it used. To reproduce a file on a later day (for example to check that the tracked release file is what
  the generator produces), give the build that day: `SGTO_AS_AT=2026-11-13 npm run build:workbook`. The file's
  own "as at" cell stays `=TODAY()` either way.
- The version on the Start sheet is the `version` in `package.json`.

## What the tests prove, and what they cannot

Every figure is compared with the engine after recalculation in **LibreOffice**, for more than 300 sets of
entries. The tests also insert and remove tax-bracket rows inside LibreOffice and check the result against the
engine. Nothing in this repository can open the file in **Microsoft Excel** or **Google Sheets**, so that check is
done by hand before each release.

Row heights are fixed (merged cells never grow, and no application re-fits a row when a formula's text changes).
They are sized from a cautious estimate of how much text fits a line (`charsPerLine` in `kit.ts`, measured against
Carlito, the metric twin of Calibri), and the tests hold every message the engine can produce to that room.

## Before each release: open it in Excel and in Google Sheets

Do this with the file from `release/`, once in desktop Excel (2016 or Microsoft 365) and once in Google Sheets
(File › Import › Upload).

1. **It opens cleanly.** No "We found a problem with some content" repair prompt in Excel; no import warning in Sheets.
2. **The example is right.** Planner says "Put S$15,300 into SRS and S$8,000 into your CPF as a cash top-up. You
   save S$2,679.50 in tax.", then "SRS: locked until 64, about 29 years. CPF: paid out monthly from 65, about 30
   years. If you have paid into SRS before, your SRS age was set by your first contribution and may be lower
   than 64.", with the "EXAMPLE SHOWN" banner.
3. **The dropdowns work.** Change Residency to Foreigner: "How far down the ladder?" should go from 7.0% to 11.5%
   by itself, the lock-up line should add "or until you can use the 10-year rule for foreigners if that comes
   first", and the room cell for your own CPF should say "not used". Change it back: 7.0% again. Set the salary to "per year" and type 100,000:
   the line under it should read 8,333 and say S$4 is counted with the bonus. Set the minimum to `0.0%` (the cell
   should read "Every tax dollar") and to `7.0%`. Type `10%` into that cell: it should be accepted after a warning.
   (Once a rate has been typed or picked, the cell no longer follows the Residency; that is intended.)
4. **Every cream cell takes a value.** Type a number in each cream cell on the Planner, the as-at date on Monthly
   Plan and the step on Simulator. Clear the optional cells again; the notes beside them should say "Blank…" (or "Not filled in…" beside the CPF figure).
5. **The room for your own CPF is asked for from 55.** Set the age to 57 and leave "Top-up to your own CPF that
   can still earn relief" blank: the cell turns red, its label and note say NEEDED, the plan shows S$0 for "CPF
   cash top-up, self" and "Things to check" explains why. Set "Use CPF cash top-up, self?" to No: the red goes and
   the label reads "needed if switched on". Set it back to Yes and type 3,000: the plan uses S$3,000. With
   Residency = Foreigner the cell is never red and says "not used". Set the age back to 35.
6. **The example banner names what is left.** Change only the salary to 8,500: the banner should read "Still using
   the example's age, bonus and other reliefs. Type your own over them; …". With only one figure left it says "it".
7. **Before You Transfer follows the Planner.** Its title bar says who it is shown for. With Residency =
   Foreigner the sheet shows the SRS column only, with one line above the table saying CPF top-ups are not open; with age 57 the "Account limits" row speaks of the Retirement
   Account; with the as-at date in January after the year, the last caution says the deadline has passed.
8. **The Ladder chart is there.** On the example it is one dark block at 11.5% that ends at S$23,300, short of the
   right-hand edge. With salary 4,600 per month, bonus 9,000, other reliefs 0, family top-up Yes and minimum
   `0.0%`: blocks step down 7% → 3.5% → 2%, and the dark block stops at S$30,360. The axis should show about
   ten round figures. In Google Sheets the chart may be drawn differently or left out; the bars in the table under
   it are the fallback. With age 57, SRS switched off and the room for your own CPF blank, the chart is empty (no
   figures under its axis) and the note above it says your own CPF is left out until you enter the figure.
9. **Adding a tax bracket works.** On Rules, insert a row above "Bracket 6", type 100,000 and 13%, and copy the
   three grey cells from the row above into the new row. With a salary of 15,000 a month the Planner's "Tax without
   any more contributions" should read S$15,798.00 and the check under the table should say OK. Undo.
10. **Nothing is clipped.** Read the Start sheet, the Planner notes, the "Things to check" lines (try the age-57
    case above with family top-ups on and an as-at date of 20 December: four or five long lines), the Tax Working
    messages and every row of Before You Transfer: no cut-off text, no `#####`.
11. **It prints.** Print preview of Planner (landscape, one page wide: the last few inputs and any further check
    lines run on to a second page), Ladder (chart and table on one page) and Before You Transfer (two pages: all
    nine rows of the table on the first, down to "Deadline", and the list of checks on the second).

If something differs in Excel or Sheets, fix the generator, not the file, and add a test for it.

## Updating for a new year

Follow SPEC §13, then `npm run build:workbook -- --year <year>`. A buyer can also update the file itself on the
Rules sheet: the deadline follows the income year, new tax brackets are inserted above the grey end line, and a
check under the table (repeated at the top of the Planner) says when the table is out of order. The sentences on
Before You Transfer cannot follow such edits (they are the engine's, fixed at build time); the sheet says so when
a figure it quotes has been changed, and a new edition built from the new year's rules puts them right.
