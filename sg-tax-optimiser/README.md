# Singapore Tax Optimiser

**SRS + CPF Contribution Planner** — tells a Singapore employee how much to put into SRS and CPF cash top-ups
before 31 December to cut their income tax, and where putting in more stops being worth it.

> Estimate for planning only. Not tax, legal or financial advice, and not affiliated with IRAS or the CPF Board.
> Check your eligibility and limits with IRAS, the CPF Board and your SRS bank before transferring money.
> CPF top-ups cannot be reversed.

Income year **2026 (Year of Assessment 2027)** is the primary year. 2025 (YA2026) is included for checking
against a Notice of Assessment, and 2027 (YA2028) as a clearly flagged projection.

## What it does

Most calculators answer "how much tax do I save if I max out SRS?". This one answers the question people actually
have at year end:

1. **Recommends an allocation** across SRS, a CPF cash top-up to yourself and CPF cash top-ups to family.
2. **Is bracket-aware.** Each extra dollar of relief saves tax at your marginal rate, and that rate steps down as
   your chargeable income falls. The *savings ladder* shows every step so you choose where to stop.
3. **Never recommends a dollar it can see would be wasted.** It respects the S$80,000 relief cap, each scheme's
   cap, the tax-free threshold, the CPF room you enter and your cash budget. It cannot see your CPF balances,
   matching grants or a family member's eligibility, so it asks or warns where those decide the answer.
4. **Shows the price of the saving** — cash locked away, for how long, and the immediate return on it.
5. **Turns it into a plan** — monthly set-aside amounts up to the 31 December deadline.

## What is in this folder

| Path | What |
|------|------|
| [`SPEC.md`](SPEC.md) | Product and technical specification: rules, the exact calculation model, UI and workbook specs, worked examples. |
| `src/engine/` | The calculation engine: pure, dependency-free TypeScript. Rules are data in `src/engine/rules/<year>.ts`; `facts.ts` holds the "before you transfer" wording shared by the page and the workbook. |
| `src/web/` | The web calculator (Preact). Builds to **one self-contained HTML file**. |
| `workbook/` | Generator for the Excel / Google Sheets workbook (live formulas, no macros). See [`workbook/README.md`](workbook/README.md). |
| `reference/` | An independent Python implementation written from the spec alone, used to cross-check the engine. |
| `tests/` | Unit, property, differential, workbook-parity and browser tests. |
| `scripts/` | `copy-release.mjs` (used by `build:release`) and `build-artifact.mjs` (the page as an embeddable fragment). |
| `release/` | Ready-to-use builds: `sg-tax-optimiser.html`, `SG-Tax-Optimiser-YA2027.xlsx`, and [`BUYER-GUIDE.md`](release/BUYER-GUIDE.md), the quick start that ships with them. |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | Where every rule value came from, with sources and verification verdicts. |
| [`CHANGELOG.md`](CHANGELOG.md) | Versions. |

## Use it

- **Web calculator:** open [`release/sg-tax-optimiser.html`](release/sg-tax-optimiser.html) in any current browser.
  It is a single file with no server and no tracking; your numbers stay on your device. When online it asks
  Google Fonts for two typefaces and nothing else, and it works without them. Host it on any static host (GitHub
  Pages, Netlify, S3) by uploading that one file.
- **Workbook:** open [`release/SG-Tax-Optimiser-YA2027.xlsx`](release/SG-Tax-Optimiser-YA2027.xlsx) in Excel, or
  upload it to Google Drive and open it with Google Sheets. Fill in the cream input cells on the *Planner* sheet.

## Develop

Requires Node 22 or later. Three optional tools unlock the cross-checks, which skip themselves with a console
message when a tool is missing:

| Tool | Used for |
|------|----------|
| Python 3 | The engine-vs-reference differential test and the reference's own tests. |
| LibreOffice, with `soffice` on `PATH` | Recalculating the workbook: the parity tests, and the calculated results embedded in the release file. **Build the release workbook with LibreOffice installed**, or previews that do not calculate show no numbers. |
| The `uno` Python module (`python3-uno`) | The tests that insert and remove tax-bracket rows inside LibreOffice. |

```bash
npm install
npm run dev              # web calculator with hot reload
npm test                 # unit, property, differential and workbook-parity tests
npm run test:release     # the same, but a missing tool or a stale release file is a failure, not a skip
npm run test:reference   # the Python reference's own tests
npm run typecheck
npm run build:release    # -> release/sg-tax-optimiser.html
npm run build:workbook   # -> release/SG-Tax-Optimiser-YA2027.xlsx   (-- --year 2025 or 2027 for another year)
node scripts/build-artifact.mjs   # -> dist/artifact.html, the page as an embeddable fragment
npx playwright install chromium   # once, for the browser test
npm run test:e2e         # browser test of the built page
```

The npm scripts use POSIX shell syntax (macOS, Linux, WSL). `npm install` may report audit warnings; they are in
development tooling only, and nothing in `release/` contains those packages.

Use the engine directly:

```ts
import { plan, defaultInput } from './src/engine';

const result = plan({
  ...defaultInput('2026-11-13'),
  income: { monthlyOrdinaryWage: 10_000, monthsWorked: 12, additionalWages: 15_000 },
  otherReliefs: 5_000,
});

result.plan.contributions; // { srs: 15300, cpfSelf: 8000, cpfFamily: 0 }
result.plan.taxSaved;      // 2679.5
result.ladder;             // the savings ladder tiers
result.warnings;           // cautions to show beside the recommendation
```

## How the numbers are checked

| Check | What it proves |
|-------|----------------|
| Unit tests | Each part of the model matches the spec on hand-computed cases, including the spec's worked examples. |
| Official vectors | The engine reproduces IRAS's published sample tax calculations and the CPF Board's contribution figures. |
| Property tests | Invariants hold for arbitrary inputs: the plan never exceeds a cap, room or budget; no recommended dollar saves less than the chosen minimum; no feasible allocation saves more. |
| Differential test | The TypeScript engine and the independent Python reference agree, field by field, on thousands of random inputs. |
| Workbook parity | The spreadsheet's formulas, recalculated by LibreOffice, equal the engine's results on more than 200 profiles. |
| Browser test | The built page shows the engine's numbers, reacts to input, follows the calendar, and does not overflow on a phone. |
| Rule audit | A tax-practitioner review of the model and a claim-by-claim check of every user-facing statement (`docs/RESEARCH.md`). |

## Before you sell or publish it

1. **Open the workbook in desktop Excel and in Google Sheets** and run the checklist in
   [`workbook/README.md`](workbook/README.md). Everything so far was calculated in LibreOffice; nothing here can
   open the file in Excel or Sheets.
2. **Re-read the primary sources.** Official `*.gov.sg` pages could not be fetched directly when the rules were
   verified, so each value was confirmed from search extracts of those pages. The pages are listed in the app
   under *Sources* and in `docs/RESEARCH.md`.
3. **Choose a licence.** `package.json` says `UNLICENSED` (all rights reserved) and the folder carries no licence
   file. If this folder sits inside another repository, that repository's licence does not describe it.
4. **Review the Terms** at the end of [`release/BUYER-GUIDE.md`](release/BUYER-GUIDE.md).
5. To measure interest, build the hosted page with a shop or waiting-list address
   (`VITE_BUY_URL=https://… npm run build:release`): the page then shows one link to the workbook. See `SPEC.md` §12.

## Updating for a new year

Rule values live in three places on purpose: the engine, and two independent copies that exist to catch a mistake
in it. Update all three, or the new year gets no cross-checking.

1. Update `SPEC.md` §5 with the new figures and sources.
2. Copy `src/engine/rules/2026.ts` to the new year and update the values; mark `status: 'projected'` until every
   value is confirmed from IRAS / CPF Board / MOF. Review `src/engine/rules/shared.ts` and the dated sentences in
   `src/engine/facts.ts`.
3. Register the year in `src/engine/rules/index.ts`.
4. Mirror the values in `reference/sgtax_reference.py` and in `tests/support/specModel.ts`, and update the tests
   that pin the list of supported years.
5. When the primary year rolls over, check the year wording in `src/web/text.ts` and the release file name
   wherever this README, the tests and `release/BUYER-GUIDE.md` name it.
6. Run `npm run test:release`, `npm run build:release`, `npm run build:workbook -- --year <year>` and
   `npm run test:e2e`, then open the workbook in Excel and Google Sheets.

Things to re-check every year: the Budget (rates, rebates, relief caps), the CPF contribution rate table and wage
ceilings, the retirement sums and Basic Healthcare Sum, the matched top-up amounts, and the SRS caps.

## Scope

Covers Singapore **tax-resident employees**. It does not cover self-employed income, non-residents, Parenthood
Tax Rebate balances, employer SRS contributions, the tax on SRS withdrawals, or investment returns inside
SRS/CPF. See `SPEC.md` §1.
