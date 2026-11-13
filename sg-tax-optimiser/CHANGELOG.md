# Changelog

## 1.0.0 — 13 November 2026

First complete version, for income year 2026 (Year of Assessment 2027).

- Calculation engine: employee CPF, reliefs and the S$80,000 cap, resident tax, a bracket-aware optimiser across
  SRS and CPF cash top-ups, the savings ladder, scenario comparison, a simulator, a monthly plan and warnings.
- Web calculator as one self-contained HTML file.
- Excel / Google Sheets workbook with live formulas, built from the same rule data.
- Independent Python reference implementation; property, differential, workbook-parity and browser tests.
- Rules for income years 2025 and 2026 (final) and 2027 (projected), with sources in `docs/RESEARCH.md`.
- Safeguards from the final rule audit: the CPF top-up room is asked for from age 55; cautions for foreigners who
  may leave Singapore, family top-ups matched by the Government, tax residency and unused Parenthood Tax Rebate.

Known limits: the workbook has been calculated in LibreOffice only and must be opened in Excel and Google Sheets
before it is sold (`workbook/README.md`); official pages could not be fetched directly when the rules were
verified (`docs/RESEARCH.md`).
