# Python reference implementation

`sgtax_reference.py` is an independent implementation of the calculation model in `SPEC.md` section 6, used as
the oracle for the differential test (`tests/differential.test.ts`). It was written only from `SPEC.md` and the
field names in `src/engine/types.ts`, and it holds its own hand-transcribed copy of the section 5 rule values for
income years 2025, 2026 and 2027. It never imports or reads the TypeScript engine or its rule files. Keep it that
way: when a rule changes, re-type the value here from the specification (SPEC section 13, step 3).

Python 3 standard library only.

## Run

```
python3 reference/sgtax_reference.py inputs.json     # JSON array of PlannerInput in, JSON array of results out
python3 -m unittest discover -s reference -p 'test_*.py'
```

`-` instead of a file name reads the array from stdin. An element with an unsupported `incomeYear` becomes
`{"error": "unsupported incomeYear"}`. Nothing else is an error: SPEC 6.0 gives every other field a value (an
unparseable `today` is 1 January of the income year).

## Output

Each result mirrors `PlannerResult` (same camelCase keys and nesting) with these differences:

- `rules` and `input` are omitted.
- `warnings` is a list of `{"code", "severity"}` only, sorted by `code`, one entry per code.
- `cpf.employerContribution` follows the SPEC 6.1 formula for the full-rate table and is `0` for first- and
  second-year SPRs (the specification gives no employer rates for them). Do not compare this field.
- `zeroReason` is absent from ladder tiers whose rate is above zero.
- Dollar amounts are JSON integers; tax amounts are numbers with at most two decimals; rates are fractions.
  `donationDeduction` and `assessableIncome` can end in `.5` (donations x 2.5).

## Arithmetic

Dollars are integers, rates are integer per-mille values, tax is summed in integer mills and rounded half-up to
cents once (SPEC 6.0). Nothing is computed in binary floating point except the final conversion of cents to dollars,
the reported rates, and the comparison of `minSavingRate` with a bracket rate (done on doubles so that an input of
`0.07` equals the 7% bracket).

## Readings of the specification

Where SPEC.md leaves room for interpretation this file takes the most literal reading:

| SPEC | Reading |
|---|---|
| 6.0 | Non-numbers count as "not finite" (0 for money, the default for `monthsWorked`, `birthMonth`, `simulatorStep`). Fractional `monthsWorked`, `birthMonth`, `ageAtYearEnd` and `simulatorStep` are floored before clamping. `prYear` other than 1 or 2 is 3. Optional limits given as numbers are sanitised like money (a budget of -5 is a budget of 0). An unknown `residency` is treated as `citizen`. Money inputs (optional limits and the `additional` amounts of `evaluate` included) are clamped to S$10,000,000,000; `simulatorStep` has a minimum but no maximum. A number is a JSON number, i.e. a double: a Python integer too large for a double is "not finite". `NaN` and `±Infinity` are numbers (0 in a clamped field before clamping; a limit of 0). A lever is enabled only when `enabled` is exactly `true`. |
| 6.0 `today` | Parsed only when it is a string starting with `YYYY-MM-DD` (ASCII digits, zero-padded, no leading whitespace, no further digit straight after) that names a real proleptic-Gregorian date (year 0000 included); the rest of the string is ignored. Anything else is 1 January of the income year. Day counts use the file's own integer calendar arithmetic, not `datetime` (which has no year 0). |
| 6.1 | Foreigners: every `cpf` field is 0 and all twelve monthly rates are 0. `monthlyEmployeeRates` reports the band rate for every worked month, also when the wage is in the nil or phase-in range. Additional wages always attract the full December rate. With an override, the wage fields and monthly rates still come from the auto-calculation. |
| 6.3 | An existing contribution to a lever the profile is not eligible for earns no relief (its statutory cap is 0). |
| 6.5 | `cpfFamily` is eligible only for a residency listed in `cpfTopUp.familyGiverResidency` (citizens and PRs); for a foreigner its statutory cap is 0, so an existing family top-up earns no relief and raises no warning. `EXISTING_EXCEEDS_CAP` is emitted once however many levers exceed. |
| 6.6 | `bindingConstraint` is `none` only when the baseline tax is zero; with nothing enabled it is `leverLimits`. `unrealisedSaving` is always `N(X) - N(min(U, C))`. |
| 6.7 | For contributions beyond the relief-cap room, `N` is evaluated at the cap room (those dollars add no allowed relief). |
| 6.8 | `stepRate` divides by the actual step `c_i - c_(i-1)`, which is shorter for the last row. |
| 6.9 | Scenarios are listed in table order; `recommended` uses the same `wastedContribution` formula. |
| 6.10 | `fullYearMonthly` is always computed from the plan, also when the deadline has passed. Before the income year the schedule runs January to December of the income year. Only the date part of `today` is used. |
| 7 | `gross_tax` and `marginal_rate` sanitise their argument (not finite or negative is 0, then floored) and clamp it to S$140,000,000,000. `default_income_year` of an unparseable date is the latest supported year whose rules are final (2026). |
