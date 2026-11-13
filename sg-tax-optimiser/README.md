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

1. **Recommends an allocation** across SRS, CPF top-up (self) and CPF top-up (family).
2. **Is bracket-aware.** Each extra dollar of relief saves tax at your marginal rate, and that rate steps down as
   your chargeable income falls. The *savings ladder* shows every step so you choose where to stop.
3. **Never recommends a wasted dollar.** It respects the S$80,000 relief cap, each scheme's cap, the tax-free
   threshold, your CPF top-up room and your cash budget.
4. **Shows the price of the saving** — cash locked away, for how long, and the immediate return on it.
5. **Turns it into a plan** — monthly set-aside amounts up to the 31 December deadline.

## What is in this folder

| Path | What |
|------|------|
| [`SPEC.md`](SPEC.md) | Product and technical specification: rules, the exact calculation model, UI and workbook specs, worked examples. |
| `src/engine/` | The calculation engine: pure, dependency-free TypeScript. Rules are data in `src/engine/rules/<year>.ts`. |
| `src/web/` | The web calculator (Preact). Builds to **one self-contained HTML file**. |
| `workbook/` | Generator for the Excel / Google Sheets workbook (live formulas, no macros). |
| `reference/` | An independent Python implementation written from the spec alone, used to cross-check the engine. |
| `tests/` | Unit, property, differential, workbook-parity and browser tests. |
| `release/` | Ready-to-use builds: `sg-tax-optimiser.html` and `SG-Tax-Optimiser-YA2027.xlsx`. |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | Where every rule value came from, with sources and verification verdicts. |

## Use it

- **Web calculator:** open [`release/sg-tax-optimiser.html`](release/sg-tax-optimiser.html) in any browser. It is a
  single file with no server and no tracking; your numbers stay on your device. Host it on any static host
  (GitHub Pages, Netlify, S3) by uploading that one file.
- **Workbook:** open [`release/SG-Tax-Optimiser-YA2027.xlsx`](release/SG-Tax-Optimiser-YA2027.xlsx) in Excel, or
  upload it to Google Drive and open it with Google Sheets. Fill in the input cells on the *Planner* sheet.

## Develop

Requires Node 22+. Python 3 and LibreOffice are optional (used by the differential and workbook-parity tests,
which skip themselves when those are missing).

```bash
npm install
npm run dev              # web calculator with hot reload
npm test                 # unit, property, differential and workbook-parity tests
npm run test:reference   # the Python reference's own tests
npm run typecheck
npm run build:release    # -> release/sg-tax-optimiser.html
npm run build:workbook   # -> release/SG-Tax-Optimiser-YA2027.xlsx
npm run test:e2e         # browser test against the built file (needs Playwright + Chromium)
```

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
```

## How the numbers are checked

| Check | What it proves |
|-------|----------------|
| Unit tests | Each part of the model matches the spec on hand-computed cases, including the spec's worked examples. |
| Official vectors | The engine reproduces IRAS's published sample tax calculations and the CPF Board's contribution figures. |
| Property tests | Invariants hold for arbitrary inputs: the plan never exceeds a cap, room or budget; no recommended dollar saves less than the chosen minimum; no feasible allocation saves more. |
| Differential test | The TypeScript engine and the independent Python reference agree, field by field, on thousands of random inputs. |
| Workbook parity | The spreadsheet's formulas, recalculated by LibreOffice, equal the engine's results. |
| Browser test | The built page shows the engine's numbers, reacts to input, and does not overflow on a phone. |

## Updating for a new year

1. Copy `src/engine/rules/2026.ts` to the new year and update the values; mark `status: 'projected'` until every
   value is confirmed from IRAS / CPF Board / MOF.
2. Register it in `src/engine/rules/index.ts`.
3. Mirror the values in `reference/sgtax_reference.py` (it keeps its own copy on purpose).
4. Run `npm test`, `npm run build:release` and `npm run build:workbook -- --year <year>`.

Things to re-check every year: the Budget (rates, rebates, relief caps), the CPF contribution rate table and wage
ceilings, the retirement sums and Basic Healthcare Sum, and the SRS caps.

## Scope

Covers Singapore **tax-resident employees**. It does not cover self-employed income, non-residents, Parenthood
Tax Rebate balances, employer SRS contributions, or investment returns inside SRS/CPF. See `SPEC.md` §1.
