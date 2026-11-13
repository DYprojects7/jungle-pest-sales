/**
 * Adversarial review — tests written to kill the mutants that survived BOTH tests/engine and the rest of
 * tests/review in the mutation run (see .tmp/verify/review/mutants.mjs for the mutant list):
 *
 *   sim-08   simulator.taxSaved measured from GROSS tax instead of tax payable          (differs under a rebate)
 *   warn-21  "you could save up to S$0.00 more tax" appended when nothing more can be saved (differs under a rebate)
 *   date-06  century leap-year correction dropped from the day count                   (differs across 1900 / 2100)
 *   date-07  an ISO date found anywhere in `today`, not only at the start
 *   fmt-01   percentages in messages rounded to one decimal (7.01% shown as 7%)        (also in messages.test.ts)
 *
 * Every expected value is hand-computed in the comments.
 */
import { describe, expect, it } from 'vitest';
import { getRules, plan } from '../../src/engine';
import type { PlannerInput, YearRules } from '../../src/engine';
import { planFor } from '../../src/engine/plan';
import { sanitise } from '../../src/engine/sanitise';

function citizen(patch: (input: PlannerInput) => void = () => {}): PlannerInput {
  const input: PlannerInput = {
    incomeYear: 2026,
    today: '2026-06-15',
    profile: { residency: 'citizen', prYear: 3, ageAtYearEnd: 35, birthMonth: 12 },
    income: { monthlyOrdinaryWage: 0, monthsWorked: 12, additionalWages: 0, otherTaxableIncome: 0, employmentExpenses: 0, donations: 0, employeeCpfOverride: null },
    existing: { srs: 0, cpfTopUpSelf: 0, cpfTopUpFamily: 0 },
    otherReliefs: 0,
    levers: { srs: { enabled: true }, cpfSelf: { enabled: true, roomToLimit: null }, cpfFamily: { enabled: false, maxAmount: null } },
    preferences: { cashBudget: null, minSavingRate: 0, priority: ['srs', 'cpfSelf', 'cpfFamily'], simulatorStep: 1_000 },
  };
  patch(input);
  return input;
}

/** The 2026 rules with the YA2025-style rebate: 60% of tax, capped at S$200 (SPEC §5.1 keeps `pitRebate` as data). */
const withRebate = (): YearRules => ({ ...getRules(2026), pitRebate: { rate: 0.6, cap: 200 } });

describe('a year with a Personal Income Tax Rebate (SPEC §6.4, §6.7, §6.8, §6.9: savings are REALISED savings)', () => {
  // S$3,000 a month + S$3,000 bonus, age 25: CPF 7,800, EIR 1,000 -> CI 30,200.
  // Gross 200 + 3.5% x 200 = 207.00. Rebate min(200, 60% x 207 = 124.20) = 124.20. Payable 82.80.
  const r = planFor(
    sanitise(
      citizen((i) => {
        i.profile.ageAtYearEnd = 25;
        i.income.monthlyOrdinaryWage = 3_000;
        i.income.additionalWages = 3_000;
      }),
    ),
    withRebate(),
  );

  it('baseline: gross 207.00, rebate 124.20, payable 82.80', () => {
    expect(r.baseline.grossTax).toBe(207);
    expect(r.baseline.pitRebate).toBe(124.2);
    expect(r.baseline.taxPayable).toBe(82.8);
    expect(r.plan.taxBefore).toBe(82.8);
  });

  it('simulator: taxSaved is measured from tax PAYABLE, so row 0 saves nothing', () => {
    // Row 0: payable 82.80, saved 0.
    // Row 1 (1,000): CI 29,200 -> gross 184.00 -> rebate 110.40 -> payable 73.60; saved 9.20; step rate 0.0092.
    // Row 2 (2,000): CI 28,200 -> gross 164.00 -> rebate 98.40 -> payable 65.60; saved 17.20; step 8.00.
    // Row 10 (10,000): CI 20,200 -> gross 4.00 -> rebate 2.40 -> payable 1.60; saved 81.20.
    // Row 11 (11,000): CI 19,200 -> 0; saved 82.80; step 1.60.
    expect(r.simulator[0]).toMatchObject({ contribution: 0, taxPayable: 82.8, taxSaved: 0, stepSaving: 0, stepRate: 0 });
    expect(r.simulator[1]).toMatchObject({ contribution: 1_000, taxPayable: 73.6, taxSaved: 9.2, stepSaving: 9.2 });
    expect(r.simulator[1]?.stepRate).toBeCloseTo(0.0092, 12);
    expect(r.simulator[2]).toMatchObject({ contribution: 2_000, taxPayable: 65.6, taxSaved: 17.2, stepSaving: 8 });
    expect(r.simulator[10]).toMatchObject({ contribution: 10_000, taxPayable: 1.6, taxSaved: 81.2 });
    expect(r.simulator[11]).toMatchObject({ contribution: 11_000, taxPayable: 0, taxSaved: 82.8, stepSaving: 1.6 });
    for (const row of r.simulator) {
      expect(Math.round((row.taxSaved + row.taxPayable) * 100)).toBe(8_280);
    }
    // The last row saves exactly what the plan and the ladder say can be saved in total.
    expect(r.simulator[r.simulator.length - 1]?.taxSaved).toBe(82.8);
    expect(r.ladder[r.ladder.length - 1]?.cumulativeTaxSaved).toBe(82.8);
  });

  it('scenarios and the plan report realised savings too', () => {
    // cpfSelfOnly 8,000: CI 22,200 -> gross 44.00 -> rebate 26.40 -> payable 17.60; saved 65.20.
    const self = r.scenarios.find((s) => s.id === 'cpfSelfOnly');
    expect(self).toMatchObject({ taxPayable: 17.6, taxSaved: 65.2 });
    expect(r.scenarios.find((s) => s.id === 'none')).toMatchObject({ taxPayable: 82.8, taxSaved: 0, savingRate: 0 });
    expect(r.scenarios.find((s) => s.id === 'srsOnly')).toMatchObject({ taxPayable: 0, taxSaved: 82.8 });
    expect(r.plan).toMatchObject({ totalContribution: 10_200, taxAfter: 0, taxSaved: 82.8 });
    expect(r.plan.savingRate).toBe(82.8 / 10_200);
  });
});

describe('BUDGET_LIMITS_PLAN when more cash would save nothing more (possible only with a rebate)', () => {
  // S$8,000 a month (CPF 19,200, EIR 1,000), other income 4,002, other reliefs 59,797.
  // Reliefs 79,997 -> relief-cap room C = 3. Income 100,002 -> CI 20,005.
  // With the 60% rebate, payable tax k dollars above 20,000 is 0.02k - round(0.012k):
  //   k = 5: 0.10 - 0.06 = 0.04    k = 3: 0.06 - 0.04 = 0.02    k = 2: 0.04 - 0.02 = 0.02
  // Budget 2: X = min(U 5, C 3, L 23,300, B 2) = 2 -> cashBudget. Tax after (k = 3) = 0.02.
  // Unrealised: 0.02 - tax after min(U, C) = 3 dollars (k = 2) = 0.02 - 0.02 = 0.00.
  const r = planFor(
    sanitise(
      citizen((i) => {
        i.income.monthlyOrdinaryWage = 8_000;
        i.income.otherTaxableIncome = 4_002;
        i.otherReliefs = 59_797;
        i.preferences.cashBudget = 2;
      }),
    ),
    withRebate(),
  );

  it('numbers', () => {
    expect(r.baseline.chargeableIncome).toBe(20_005);
    expect(r.reliefCapRoom).toBe(3);
    expect(r.baseline.grossTax).toBe(0.1);
    expect(r.baseline.pitRebate).toBe(0.06);
    expect(r.baseline.taxPayable).toBe(0.04);
    expect(r.plan.totalContribution).toBe(2);
    expect(r.plan.taxAfter).toBe(0.02);
    expect(r.plan.taxSaved).toBe(0.02);
    expect(r.plan.bindingConstraint).toBe('cashBudget');
    expect(r.plan.unrealisedSaving).toBe(0);
  });

  it('the message does not dangle "you could save up to S$0.00 more tax"', () => {
    expect(r.warnings.map((w) => w.code)).toEqual(['BUDGET_LIMITS_PLAN', 'PIT_REBATE_APPLIED']);
    const text = r.warnings[0]?.message ?? '';
    expect(text).toContain('S$2');
    // The only dollar figure is the cash limit itself: no "S$0.00 more tax".
    expect([...text.matchAll(/S\$[\d,.]*\d/g)].map((m) => m[0])).toEqual(['S$2']);
    // One more dollar is within reach (C = 3): CI 20,002, gross 0.04, rebate 0.02, payable 0.02 — no change.
    expect(r.warnings[0]?.params).toEqual({ cashBudget: 2, unrealisedSaving: 0, savingWithMoreCash: 0 });
  });

  it('without a rebate the same person has S$0.02 still on the table and is told so', () => {
    // No rebate: tax after X = 2 is 0.06 (CI 20,003); after 3 it is 0.04 -> unrealised 0.02.
    const plain = plan(
      citizen((i) => {
        i.income.monthlyOrdinaryWage = 8_000;
        i.income.otherTaxableIncome = 4_002;
        i.otherReliefs = 59_797;
        i.preferences.cashBudget = 2;
      }),
    );
    expect(plain.plan.unrealisedSaving).toBe(0.02);
    expect(plain.warnings[0]?.message).toContain('S$0.02');
  });
});

describe('calendar arithmetic across century boundaries (1900 and 2100 are not leap years; 2000 and 2400 are)', () => {
  const utcDay = (y: number, m: number, d: number): number => Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
  const deadline = utcDay(2026, 12, 31);

  it.each([
    ['1899-12-31', 1899, 12, 31],
    ['1900-02-28', 1900, 2, 28],
    ['1900-03-01', 1900, 3, 1],
    ['1999-12-31', 1999, 12, 31],
    ['2000-02-29', 2000, 2, 29],
    ['2000-03-01', 2000, 3, 1],
    ['2099-12-31', 2099, 12, 31],
    ['2100-02-28', 2100, 2, 28],
    ['2100-03-01', 2100, 3, 1],
    ['2101-01-01', 2101, 1, 1],
    ['2400-02-29', 2400, 2, 29],
    ['2400-03-01', 2400, 3, 1],
    ['9999-12-31', 9999, 12, 31],
  ])('today %s', (today, y, m, d) => {
    const r = plan(citizen((i) => (i.today = today)));
    expect(r.input.today).toBe(today);
    expect(r.monthlyPlan.daysToDeadline).toBe(deadline - utcDay(y, m, d));
  });

  it('hand-checked: 1 March 2100 is 26,723 days after 31 December 2026', () => {
    // 2027..2099 is 73 years with 18 leap years (2028, 2032, ..., 2096): 73 x 365 + 18 = 26,663 days to 31 Dec 2099.
    // 2100 is NOT a leap year: 31 (Jan) + 28 (Feb) + 1 = 60 more days. Total 26,723.
    expect(plan(citizen((i) => (i.today = '2100-03-01'))).monthlyPlan.daysToDeadline).toBe(-26_723);
    // 1 March 1900 -> 31 December 2026: rest of 1900 after 1 March = 365 - 60 = 305 days;
    // 1901..2026 = 126 years with 31 leap years (1904 ... 2024) = 46,021 days. Total 46,326.
    expect(plan(citizen((i) => (i.today = '1900-03-01'))).monthlyPlan.daysToDeadline).toBe(46_326);
  });

  it('29 February: valid in 2000 and 2400, not in 1900 or 2100', () => {
    expect(plan(citizen((i) => (i.today = '2000-02-29'))).input.today).toBe('2000-02-29');
    expect(plan(citizen((i) => (i.today = '2400-02-29'))).input.today).toBe('2400-02-29');
    expect(plan(citizen((i) => (i.today = '1900-02-29'))).input.today).toBe('2026-01-01');
    expect(plan(citizen((i) => (i.today = '2100-02-29'))).input.today).toBe('2026-01-01');
  });
});

describe('`today` is read as its LEADING YYYY-MM-DD only (SPEC §6.0)', () => {
  it.each([' 2026-11-13', 'x2026-11-13', 'on 2026-11-13', 'T2026-11-13', '12026-11-13', '\n2026-11-13', 'due 2027-03-01 or 2026-11-13'])(
    '%j is not a date: 1 January of the income year is used',
    (today) => {
      const r = plan(citizen((i) => (i.today = today)));
      expect(r.input.today).toBe('2026-01-01');
      expect(r.monthlyPlan.monthsRemaining).toBe(12);
      expect(r.monthlyPlan.daysToDeadline).toBe(364);
    },
  );

  it.each([
    ['2026-11-13', '2026-11-13'],
    ['2026-11-13T08:00:00+08:00', '2026-11-13'],
    ['2026-11-13 and later', '2026-11-13'],
    ['2026-11-13-2027-01-01', '2026-11-13'],
    ['2026-11-13/2026-12-31', '2026-11-13'],
  ])('%j is read as %s', (today, expected) => {
    expect(plan(citizen((i) => (i.today = today))).input.today).toBe(expected);
  });
});

describe('percentages in messages keep two decimals', () => {
  it('a 7.01% minimum is not shown as 7%', () => {
    // S$3,500 a month + S$3,500 bonus (Appendix A.3): CI 35,400, marginal 3.5%.
    const r = plan(
      citizen((i) => {
        i.profile.ageAtYearEnd = 28;
        i.income.monthlyOrdinaryWage = 3_500;
        i.income.additionalWages = 3_500;
        i.preferences.minSavingRate = 0.0701;
      }),
    );
    expect(r.warnings.map((w) => w.code)).toEqual(['BELOW_MIN_SAVING_RATE']);
    expect(r.warnings[0]?.message).toContain('3.5%');
    expect(r.warnings[0]?.message).toContain('7.01%');
    expect(r.warnings[0]?.params).toEqual({ marginalRate: 0.035, minSavingRate: 0.0701 });
    // 19.5% and 11.5% keep their half-point.
    const high = plan(
      citizen((i) => {
        i.income.monthlyOrdinaryWage = 22_000; // income 264,000; CPF 19,200; EIR 1,000 -> CI 243,800 (19.5% band)
        i.preferences.minSavingRate = 0.2;
      }),
    );
    expect(high.baseline.chargeableIncome).toBe(243_800);
    expect(high.warnings[0]?.message).toContain('19.5%');
    expect(high.warnings[0]?.message).toMatch(/\b20%/);
  });
});
