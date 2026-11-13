# Singapore Tax Optimiser — quick start

**SRS + CPF Contribution Planner for income year 2026 (Year of Assessment 2027).**

It answers one question: *how much should I put into SRS and CPF cash top-ups before 31 December to cut my income
tax, and where does putting in more stop being worth it?*

> This is an estimate for planning, not tax, legal or financial advice. It is not affiliated with IRAS or the CPF
> Board. Check your eligibility and limits with IRAS, the CPF Board and your SRS bank before transferring money.
> CPF top-ups cannot be reversed.

## What you have

| File | What it is |
|------|------------|
| `SG-Tax-Optimiser-YA2027.xlsx` | The workbook. Live formulas, no macros. Opens in Excel 2016 or later, Google Sheets and LibreOffice. |
| `sg-tax-optimiser.html` | The same planner as a web page in one file. Double-click to open it in your browser; it works offline. |

## In three steps

1. **Open the workbook** and go to the **Planner** sheet. In Google Sheets: upload the file to Google Drive, then
   *File › Save as Google Sheets*.
2. **Replace the example** in the cream-coloured cells with your own figures: residency, age, monthly salary (or
   yearly — there is a switch), bonus, anything you have already put into SRS or topped up to CPF this year, and
   your other reliefs. Everything else updates by itself.
3. **Read the plan** on the right: how much to put where, the tax before and after, what you save, and why the
   plan stops where it does. Then read **Before You Transfer** before you move any money.

## The sheets

- **Planner** — your figures and the recommendation.
- **Ladder** — each extra dollar saves tax at your top rate, and that rate steps down as your taxable income
  falls. This sheet shows every step, so you can see where a dollar stops being worth locking away.
- **Scenarios** — the plan next to the obvious alternatives (nothing, SRS only, CPF only, everything).
- **Simulator** — tax and saving for every extra S$1,000 (or a step you choose).
- **Monthly Plan** — what to set aside each month until 31 December.
- **Tax Working** — the whole calculation, line by line, before and after the plan.
- **Before You Transfer** — what locking the money away means for each scheme, and what only you can check.
- **Rules** — every rate, cap and limit the workbook uses, with its source. You can edit them for a new year.

## Three things only you can check

1. **Your CPF room.** The tool cannot see your CPF balances. From age 55 it asks for the amount you can still top
   up with tax relief, and leaves your own CPF out of the plan until you enter it.
2. **Family top-ups.** Count only what the Government does not match, to a family member who qualifies.
3. **If you may leave Singapore.** SRS withdrawals are taxed more heavily for non-residents. The planner says so
   and uses a more cautious default for foreigners.

## Choices that change the answer

- **How far down the ladder.** By default the plan stops when an extra dollar would save less than 7 cents
  (11.5 cents for foreigners). Choose a different floor if you want to save more tax or lock away less cash.
- **Cash limit.** Enter the most you can spare this year and the plan stays inside it.
- **Which scheme first.** SRS first keeps more flexibility; CPF first earns the CPF rate (at least 4% a year until
  the end of 2027); family first helps a parent before yourself.

## Next year

Rates and limits change. The **Rules** sheet can be updated by hand, and its notes say where each figure comes
from. Income year 2027 figures are not final until the Government's Budget and the CPF Board's announcements.

## Terms

For your own personal use. Please do not redistribute or resell the files. The planner is provided as is, with no
warranty; you are responsible for your own tax filing and for checking limits before you transfer money.
