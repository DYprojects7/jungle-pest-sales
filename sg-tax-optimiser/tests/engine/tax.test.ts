/**
 * SPEC §6.2–§6.4: income, reliefs, the rate table (integer mills, rounded half-up once), marginal rate,
 * the Personal Income Tax Rebate and usefulRoom.
 */
import { describe, expect, it } from 'vitest';
import { defaultInput, evaluate, getRules, grossTax, marginalRate } from '../../src/engine';
import type { PlannerInput, YearRules } from '../../src/engine';
import { evaluateFor } from '../../src/engine/plan';
import { sanitise } from '../../src/engine/sanitise';
import { taxDue, usefulRoom } from '../../src/engine/tax';

const RULES = getRules(2026);
const NOTHING = { srs: 0, cpfSelf: 0, cpfFamily: 0 };

type Sections = {
  profile?: Partial<PlannerInput['profile']>;
  income?: Partial<PlannerInput['income']>;
  existing?: Partial<PlannerInput['existing']>;
  otherReliefs?: number;
};

/** The opening example (2026) with some fields replaced. */
function input(overrides: Sections = {}): PlannerInput {
  const base = defaultInput('2026-11-13');
  return {
    ...base,
    profile: { ...base.profile, ...overrides.profile },
    income: { ...base.income, ...overrides.income },
    existing: { ...base.existing, ...overrides.existing },
    otherReliefs: overrides.otherReliefs ?? base.otherReliefs,
  };
}

describe('grossTax — bracket boundaries (§5.1, §6.4)', () => {
  it('is zero up to S$20,000', () => {
    expect(grossTax(0, RULES)).toBe(0);
    expect(grossTax(1, RULES)).toBe(0);
    expect(grossTax(19_999, RULES)).toBe(0);
    expect(grossTax(20_000, RULES)).toBe(0);
  });

  // [boundary, cumulative tax at the boundary, rate above it]
  const boundaries: [number, number, number][] = [
    [20_000, 0, 0.02],
    [30_000, 200, 0.035],
    [40_000, 550, 0.07],
    [80_000, 3_350, 0.115],
    [120_000, 7_950, 0.15],
    [160_000, 13_950, 0.18],
    [200_000, 21_150, 0.19],
    [240_000, 28_750, 0.195],
    [280_000, 36_550, 0.2],
    [320_000, 44_550, 0.22],
    [500_000, 84_150, 0.23],
    [1_000_000, 199_150, 0.24],
  ];

  it.each(boundaries)('at %i the cumulative tax is %i', (boundary, cumulative) => {
    expect(grossTax(boundary, RULES)).toBe(cumulative);
  });

  it.each(boundaries)('S$100 above %i adds 100 x the next rate', (boundary, cumulative, rate) => {
    // e.g. 80,100 -> 3,350 + 11.50 = 3,361.50
    expect(grossTax(boundary + 100, RULES)).toBe(cumulative + Math.round(rate * 100 * 100) / 100);
  });

  it('one dollar below a boundary is taxed at the lower rate', () => {
    expect(grossTax(29_999, RULES)).toBe(199.98); // 2% x 9,999
    expect(grossTax(39_999, RULES)).toBe(549.97); // 200 + 349.965 -> half-up
    expect(grossTax(79_999, RULES)).toBe(3_349.93); // 550 + 7% x 39,999 = 550 + 2,799.93
    expect(grossTax(119_999, RULES)).toBe(7_949.89); // 3,350 + 4,599.885 -> half-up
  });

  it('rounds to cents half-up exactly once', () => {
    expect(grossTax(20_001, RULES)).toBe(0.02);
    expect(grossTax(30_001, RULES)).toBe(200.04); // 200.035 -> 200.04
    expect(grossTax(30_003, RULES)).toBe(200.11); // 200.105 -> 200.11
    expect(grossTax(40_001, RULES)).toBe(550.07);
    expect(grossTax(80_001, RULES)).toBe(3_350.12); // 3,350.115 -> 3,350.12
    expect(grossTax(80_003, RULES)).toBe(3_350.35); // 3,350.345 -> 3,350.35
    expect(grossTax(240_001, RULES)).toBe(28_750.2); // 28,750.195 -> 28,750.20
    expect(grossTax(240_003, RULES)).toBe(28_750.59); // 28,750.585 -> 28,750.59
  });

  it('handles very large incomes exactly', () => {
    // 199,150 + 24% x 9,000,000 = 2,359,150
    expect(grossTax(10_000_000, RULES)).toBe(2_359_150);
    // 199,150 + 24% x 999,000,001 = 199,150 + 239,760,000.24
    expect(grossTax(1_000_000_001, RULES)).toBe(239_959_150.24);
  });

  it('sanitises its argument like any money input', () => {
    expect(grossTax(-5_000, RULES)).toBe(0);
    expect(grossTax(Number.NaN, RULES)).toBe(0);
    expect(grossTax(Number.POSITIVE_INFINITY, RULES)).toBe(0);
    expect(grossTax(34_750.99, RULES)).toBe(366.25); // chargeable income is whole dollars
  });

  it('clamps its argument to S$140,000,000,000, the largest chargeable income the inputs can produce (SPEC §7)', () => {
    // 199,150 + 24% x (140,000,000,000 - 1,000,000) = 199,150 + 33,599,760,000 = 33,599,959,150.00
    expect(grossTax(140_000_000_000, RULES)).toBe(33_599_959_150);
    expect(grossTax(140_000_000_001, RULES)).toBe(33_599_959_150);
    expect(grossTax(200_000_000_000, RULES)).toBe(33_599_959_150);
    expect(grossTax(1e300, RULES)).toBe(33_599_959_150);
    // One dollar below the clamp is still exact: 24 cents less.
    expect(grossTax(139_999_999_999, RULES)).toBe(33_599_959_149.76);
    // The clamp is NOT the S$10bn clamp of a money input: 199,150 + 24% x 19,999,000,000 = 4,799,959,150.00
    expect(grossTax(20_000_000_000, RULES)).toBe(4_799_959_150);
    expect(marginalRate(200_000_000_000, RULES)).toBe(0.24);
    expect(marginalRate(Number.POSITIVE_INFINITY, RULES)).toBe(0); // not finite -> 0 (§6.0), then no tax
  });

  it('never decreases as income rises', () => {
    let previous = 0;
    for (let income = 0; income <= 1_100_000; income += 937) {
      const tax = grossTax(income, RULES);
      expect(tax).toBeGreaterThanOrEqual(previous);
      previous = tax;
    }
  });
});

describe('marginalRate (§6.4)', () => {
  it('is 0 when chargeable income is 0', () => {
    expect(marginalRate(0, RULES)).toBe(0);
  });

  it.each([
    [1, 0],
    [20_000, 0],
    [20_001, 0.02],
    [30_000, 0.02],
    [30_001, 0.035],
    [40_000, 0.035],
    [40_001, 0.07],
    [80_000, 0.07],
    [80_001, 0.115],
    [108_600, 0.115],
    [120_000, 0.115],
    [120_001, 0.15],
    [160_000, 0.15],
    [160_001, 0.18],
    [200_000, 0.18],
    [200_001, 0.19],
    [240_000, 0.19],
    [240_001, 0.195],
    [280_000, 0.195],
    [280_001, 0.2],
    [320_000, 0.2],
    [320_001, 0.22],
    [500_000, 0.22],
    [500_001, 0.23],
    [1_000_000, 0.23],
    [1_000_001, 0.24],
    [50_000_000, 0.24],
  ])('the last dollar of %i is taxed at %f', (chargeableIncome, rate) => {
    expect(marginalRate(chargeableIncome, RULES)).toBe(rate);
  });

  it('sanitises its argument', () => {
    expect(marginalRate(-1, RULES)).toBe(0);
    expect(marginalRate(Number.NaN, RULES)).toBe(0);
    expect(marginalRate(20_000.9, RULES)).toBe(0);
  });
});

describe('Personal Income Tax Rebate (§6.4) — rules with a rebate', () => {
  const withRebate = (rate: number, cap: number): YearRules => ({ ...RULES, pitRebate: { rate, cap } });

  it('no rebate when the year has none', () => {
    expect(taxDue(34_750, RULES)).toEqual({ grossTax: 366.25, pitRebate: 0, taxPayable: 366.25 });
  });

  it('60% of tax, capped at S$200', () => {
    const rules = withRebate(0.6, 200);
    // 100 x 60% = 60
    expect(taxDue(25_000, rules)).toEqual({ grossTax: 100, pitRebate: 60, taxPayable: 40 });
    // 366.25 x 60% = 219.75 -> capped at 200
    expect(taxDue(34_750, rules)).toEqual({ grossTax: 366.25, pitRebate: 200, taxPayable: 166.25 });
    // 0.02 x 60% = 0.012 -> 0.01
    expect(taxDue(20_001, rules)).toEqual({ grossTax: 0.02, pitRebate: 0.01, taxPayable: 0.01 });
    expect(taxDue(20_000, rules)).toEqual({ grossTax: 0, pitRebate: 0, taxPayable: 0 });
  });

  it('rounds the rebate to cents half-up', () => {
    // 550.07 x 50% = 275.035 -> 275.04; payable 550.07 - 275.04 = 275.03
    expect(taxDue(40_001, withRebate(0.5, 1_000))).toEqual({ grossTax: 550.07, pitRebate: 275.04, taxPayable: 275.03 });
  });

  it('tax payable never goes below zero', () => {
    expect(taxDue(25_000, withRebate(1, 500))).toEqual({ grossTax: 100, pitRebate: 100, taxPayable: 0 });
  });

  it('flows through the full computation', () => {
    // Appendix A.3 profile: gross 389.00 -> rebate min(200, 233.40) = 200 -> payable 189.00
    const profile = sanitise(
      input({ profile: { ageAtYearEnd: 28 }, income: { monthlyOrdinaryWage: 3_500, additionalWages: 3_500 }, otherReliefs: 0 }),
    );
    const tax = evaluateFor(profile, NOTHING, withRebate(0.6, 200));
    expect(tax.grossTax).toBe(389);
    expect(tax.pitRebate).toBe(200);
    expect(tax.taxPayable).toBe(189);
    expect(tax.marginalRate).toBe(0.035);
    expect(tax.effectiveRate).toBeCloseTo(189 / 45_500, 12);
  });
});

describe('usefulRoom (§6.6)', () => {
  it.each([
    // chargeable income 108,600 (opening example)
    [108_600, 0, 88_600], // down to 20,000
    [108_600, 0.02, 88_600],
    [108_600, 0.03, 78_600], // lowest bracket at or above 3% is 3.5%, from 30,000
    [108_600, 0.07, 68_600], // down to 40,000
    [108_600, 0.08, 28_600], // lowest bracket at or above 8% is 11.5%, from 80,000
    [108_600, 0.115, 28_600],
    [108_600, 0.12, 0], // the 15% bracket starts above this income
    [108_600, 0.5, 0], // no bracket saves 50%
    // chargeable income 35,400 (Appendix A.3)
    [35_400, 0, 15_400],
    [35_400, 0.035, 5_400],
    [35_400, 0.07, 0],
    // at or below the tax-free threshold
    [20_000, 0, 0],
    [12_000, 0, 0],
    [0, 0, 0],
  ])('usefulRoom(%i, %f) = %i', (chargeableIncome, minRate, expected) => {
    expect(usefulRoom(chargeableIncome, minRate, RULES)).toBe(expected);
  });
});

describe('income (§6.2) and reliefs (§6.3)', () => {
  it('employment expenses, other income and donations', () => {
    const tax = evaluate(
      input({
        income: {
          monthlyOrdinaryWage: 5_000,
          additionalWages: 0,
          employmentExpenses: 2_000,
          otherTaxableIncome: 10_000,
          donations: 1_001,
        },
        otherReliefs: 0,
      }),
      NOTHING,
    );
    expect(tax.employmentIncome).toBe(60_000);
    expect(tax.employmentExpenses).toBe(2_000);
    expect(tax.otherTaxableIncome).toBe(10_000);
    expect(tax.totalIncome).toBe(68_000); // (60,000 - 2,000) + 10,000
    expect(tax.donationDeduction).toBe(2_502.5); // 1,001 x 2.5
    expect(tax.assessableIncome).toBe(65_497.5);
    expect(tax.reliefs.cpf).toBe(12_000); // 1,000 x 12
    expect(tax.reliefs.totalBeforeCap).toBe(13_000); // EIR 1,000 + CPF 12,000
    expect(tax.chargeableIncome).toBe(52_497); // floor(65,497.50 - 13,000)
    expect(tax.grossTax).toBe(1_424.79); // 550 + 7% x 12,497 = 550 + 874.79
    expect(tax.marginalRate).toBe(0.07);
    expect(tax.effectiveRate).toBeCloseTo(1_424.79 / 68_000, 12);
  });

  it('expenses above employment income leave only other income, and no Earned Income Relief', () => {
    const tax = evaluate(
      input({
        income: {
          monthlyOrdinaryWage: 1_000,
          additionalWages: 0,
          employmentExpenses: 20_000,
          otherTaxableIncome: 30_000,
        },
        otherReliefs: 0,
      }),
      NOTHING,
    );
    expect(tax.employmentIncome).toBe(12_000);
    expect(tax.totalIncome).toBe(30_000); // max(0, 12,000 - 20,000) + 30,000
    expect(tax.reliefs.earnedIncome).toBe(0); // limited to earned income of 0
    expect(tax.reliefs.cpf).toBe(2_400); // 200 x 12 still contributed
    expect(tax.chargeableIncome).toBe(27_600);
    expect(tax.grossTax).toBe(152); // 2% x 7,600
  });

  it('donations larger than income give zero assessable income and no tax', () => {
    const tax = evaluate(input({ income: { donations: 100_000 } }), NOTHING);
    expect(tax.donationDeduction).toBe(250_000);
    expect(tax.assessableIncome).toBe(0);
    expect(tax.chargeableIncome).toBe(0);
    expect(tax.taxPayable).toBe(0);
    expect(tax.marginalRate).toBe(0);
    expect(tax.effectiveRate).toBe(0);
  });

  it('no income at all: everything is zero, including the effective rate', () => {
    const tax = evaluate(input({ income: { monthlyOrdinaryWage: 0, additionalWages: 0 }, otherReliefs: 0 }), NOTHING);
    expect(tax.totalIncome).toBe(0);
    expect(tax.reliefs.earnedIncome).toBe(0);
    expect(tax.reliefs.totalBeforeCap).toBe(0);
    expect(tax.chargeableIncome).toBe(0);
    expect(tax.effectiveRate).toBe(0);
  });

  it.each([
    [54, 1_000],
    [55, 6_000],
    [59, 6_000],
    [60, 8_000],
    [75, 8_000],
  ])('Earned Income Relief at age %i is %i', (ageAtYearEnd, relief) => {
    expect(evaluate(input({ profile: { ageAtYearEnd } }), NOTHING).reliefs.earnedIncome).toBe(relief);
  });

  it('Earned Income Relief is limited to earned income', () => {
    // S$50 a month = S$600 a year, below the S$1,000 relief
    const tax = evaluate(input({ income: { monthlyOrdinaryWage: 50, additionalWages: 0 }, otherReliefs: 0 }), NOTHING);
    expect(tax.reliefs.earnedIncome).toBe(600);
    expect(tax.chargeableIncome).toBe(0);
  });

  it('additional contributions add relief only up to each statutory cap', () => {
    // 20,000 into SRS earns 15,300; 9,000 into own CPF earns 8,000; 500 for family earns 500
    const tax = evaluate(input(), { srs: 20_000, cpfSelf: 9_000, cpfFamily: 500 });
    expect(tax.reliefs.srs).toBe(15_300);
    expect(tax.reliefs.cpfTopUpSelf).toBe(8_000);
    expect(tax.reliefs.cpfTopUpFamily).toBe(500);
    expect(tax.reliefs.totalBeforeCap).toBe(50_200); // 26,400 + 23,800
    expect(tax.chargeableIncome).toBe(84_800);
    expect(tax.grossTax).toBe(3_902); // 3,350 + 11.5% x 4,800
  });

  it('existing and additional contributions share the cap', () => {
    const tax = evaluate(input({ existing: { srs: 10_000 } }), { srs: 10_000, cpfSelf: 0, cpfFamily: 0 });
    expect(tax.reliefs.srs).toBe(15_300);
  });

  it('reliefs above S$80,000 are lost to the overall cap', () => {
    // 1,000 + 20,400 + 70,000 = 91,400 -> 80,000 allowed, 11,400 lost
    const tax = evaluate(input({ otherReliefs: 70_000 }), NOTHING);
    expect(tax.reliefs.totalBeforeCap).toBe(91_400);
    expect(tax.reliefs.totalAllowed).toBe(80_000);
    expect(tax.reliefs.lostToCap).toBe(11_400);
    expect(tax.chargeableIncome).toBe(55_000); // 135,000 - 80,000
    expect(tax.grossTax).toBe(1_600); // 550 + 7% x 15,000
  });

  it('sanitises the additional contributions', () => {
    const garbage = { srs: Number.NaN, cpfSelf: -500, cpfFamily: 1_000.9 };
    const tax = evaluate(input(), garbage);
    expect(tax.reliefs.srs).toBe(0);
    expect(tax.reliefs.cpfTopUpSelf).toBe(0);
    expect(tax.reliefs.cpfTopUpFamily).toBe(1_000);
  });

  it('a chargeable income just above a boundary shows the half-up rounding end to end', () => {
    // reliefs 1,000 + 20,400 + 53,599 = 74,999 -> chargeable income 135,000 - 74,999 = 60,001
    // -> 550 + 7% x 20,001 = 550 + 1,400.07 = 1,950.07
    const tax = evaluate(input({ otherReliefs: 53_599 }), NOTHING);
    expect(tax.chargeableIncome).toBe(60_001);
    expect(tax.grossTax).toBe(1_950.07);
  });
});
