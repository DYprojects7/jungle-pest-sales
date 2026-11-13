/**
 * SPEC §6.6–§6.9 — the optimiser (every binding constraint and the tie order), the ladder, the simulator and
 * the scenarios, and their reconciliation with the plan.
 */
import { describe, expect, it } from 'vitest';
import { defaultInput, evaluate, getRules, plan } from '../../src/engine';
import type { PlannerInput, PlannerResult } from '../../src/engine';
import { buildContext, taxPayableAfter } from '../../src/engine/evaluate';
import { planFor } from '../../src/engine/plan';
import { sanitise } from '../../src/engine/sanitise';

type Overrides = {
  incomeYear?: number;
  today?: string;
  profile?: Partial<PlannerInput['profile']>;
  income?: Partial<PlannerInput['income']>;
  existing?: Partial<PlannerInput['existing']>;
  otherReliefs?: number;
  srs?: Partial<PlannerInput['levers']['srs']>;
  cpfSelf?: Partial<PlannerInput['levers']['cpfSelf']>;
  cpfFamily?: Partial<PlannerInput['levers']['cpfFamily']>;
  preferences?: Partial<PlannerInput['preferences']>;
};

/**
 * The opening example with some fields replaced. Unchanged, it has chargeable income 108,600 (tax 6,639.00),
 * relief-cap room 53,600 and lever room 15,300 (SRS) + 8,000 (CPF self).
 */
function input(overrides: Overrides = {}): PlannerInput {
  const base = defaultInput('2026-06-30');
  return {
    ...base,
    incomeYear: overrides.incomeYear ?? base.incomeYear,
    today: overrides.today ?? base.today,
    profile: { ...base.profile, ...overrides.profile },
    income: { ...base.income, ...overrides.income },
    existing: { ...base.existing, ...overrides.existing },
    otherReliefs: overrides.otherReliefs ?? base.otherReliefs,
    levers: {
      srs: { ...base.levers.srs, ...overrides.srs },
      cpfSelf: { ...base.levers.cpfSelf, ...overrides.cpfSelf },
      cpfFamily: { ...base.levers.cpfFamily, ...overrides.cpfFamily },
    },
    preferences: { ...base.preferences, ...overrides.preferences },
  };
}

const codes = (result: PlannerResult): string[] => result.warnings.map((w) => w.code);

describe('binding constraint: usefulRoom', () => {
  it('stops where the next dollar would save less than the minimum rate', () => {
    // minSavingRate 11.5%: U = 108,600 - 80,000 = 28,600; C = 53,600; L = 31,300 with family on
    const result = plan(input({ cpfFamily: { enabled: true }, preferences: { minSavingRate: 0.115 } }));
    expect(result.plan.totalContribution).toBe(28_600);
    expect(result.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 5_300 });
    expect(result.plan.bindingConstraint).toBe('usefulRoom');
    expect(result.plan.chargeableIncomeAfter).toBe(80_000);
    expect(result.plan.taxAfter).toBe(3_350);
    expect(result.plan.taxSaved).toBe(3_289); // 28,600 x 11.5%
    expect(result.plan.marginalRateAfter).toBe(0.07);
    expect(result.plan.unrealisedSaving).toBe(0);
    // Nothing limits the plan, but S$5,300 of it is a family top-up, which carries its caution (§6.11).
    expect(codes(result)).toEqual(['FAMILY_TOPUP_CHECKS']);
  });

  it('the ladder shows the cheaper rung the plan leaves unused', () => {
    const result = plan(input({ cpfFamily: { enabled: true }, preferences: { minSavingRate: 0.115 } }));
    expect(result.ladder).toEqual([
      {
        fromContribution: 0,
        toContribution: 28_600,
        amount: 28_600,
        rate: 0.115,
        taxSaved: 3_289,
        cumulativeTaxSaved: 3_289,
        usedByPlan: 28_600,
      },
      {
        fromContribution: 28_600,
        toContribution: 31_300,
        amount: 2_700,
        rate: 0.07,
        taxSaved: 189, // 2,700 x 7%
        cumulativeTaxSaved: 3_478,
        usedByPlan: 0,
      },
    ]);
  });

  it('a minimum rate no bracket reaches recommends nothing', () => {
    const result = plan(input({ preferences: { minSavingRate: 0.5 } }));
    expect(result.plan.totalContribution).toBe(0);
    expect(result.plan.bindingConstraint).toBe('usefulRoom');
    expect(codes(result)).toEqual(['BELOW_MIN_SAVING_RATE']);
  });

  it('a minimum between two bracket rates keeps only the higher bracket', () => {
    // 8% is above 7% and below 11.5%: only the 28,600 taxed at 11.5% qualifies; L = 23,300 binds first
    const result = plan(input({ preferences: { minSavingRate: 0.08 } }));
    expect(result.plan.totalContribution).toBe(23_300);
    expect(result.plan.bindingConstraint).toBe('leverLimits');
    // unrealised: tax(85,300) - tax(80,000) = 3,959.50 - 3,350
    expect(result.plan.unrealisedSaving).toBe(609.5);
  });
});

describe('binding constraint: reliefCap', () => {
  // Other reliefs 40,000: reliefs 61,400, chargeable income 73,600, tax 550 + 7% x 33,600 = 2,902.00.
  // U = 33,600; C = 18,600; L = 23,300.
  const result = plan(input({ otherReliefs: 40_000 }));

  it('stops at the S$80,000 overall cap', () => {
    expect(result.baseline.reliefs.totalBeforeCap).toBe(61_400);
    expect(result.baseline.taxPayable).toBe(2_902);
    expect(result.reliefCapRoom).toBe(18_600);
    expect(result.plan.totalContribution).toBe(18_600);
    expect(result.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 3_300, cpfFamily: 0 });
    expect(result.plan.bindingConstraint).toBe('reliefCap');
    expect(result.optimised.reliefs.totalBeforeCap).toBe(80_000);
    expect(result.optimised.reliefs.lostToCap).toBe(0);
    expect(result.plan.chargeableIncomeAfter).toBe(55_000);
    expect(result.plan.taxAfter).toBe(1_600);
    expect(result.plan.taxSaved).toBe(1_302); // 18,600 x 7%
    expect(result.plan.unrealisedSaving).toBe(0);
  });

  it('raises RELIEF_CAP_LIMITS_PLAN', () => {
    expect(codes(result)).toEqual(['RELIEF_CAP_LIMITS_PLAN']);
    expect(result.warnings[0]).toMatchObject({
      severity: 'caution',
      params: { personalReliefCap: 80_000, reliefCapRoom: 18_600, totalContribution: 18_600 },
    });
  });

  it('the ladder marks the dollars beyond the cap', () => {
    expect(result.ladder).toEqual([
      {
        fromContribution: 0,
        toContribution: 18_600,
        amount: 18_600,
        rate: 0.07,
        taxSaved: 1_302,
        cumulativeTaxSaved: 1_302,
        usedByPlan: 18_600,
      },
      {
        fromContribution: 18_600,
        toContribution: 23_300,
        amount: 4_700,
        rate: 0,
        taxSaved: 0,
        cumulativeTaxSaved: 1_302,
        usedByPlan: 0,
        zeroReason: 'reliefCap',
      },
    ]);
  });

  it('the scenarios count the dollars beyond the cap as wasted', () => {
    const both = result.scenarios.find((s) => s.id === 'srsPlusCpfSelf');
    expect(both).toMatchObject({ totalContribution: 23_300, taxSaved: 1_302, wastedContribution: 4_700 });
    const srsOnly = result.scenarios.find((s) => s.id === 'srsOnly');
    expect(srsOnly).toMatchObject({ totalContribution: 15_300, taxSaved: 1_071, wastedContribution: 0 });
  });
});

describe('relief cap already exceeded at baseline', () => {
  // Other reliefs 70,000: 1,000 + 20,400 + 70,000 = 91,400 -> 80,000 allowed, 11,400 lost.
  const result = plan(input({ otherReliefs: 70_000 }));

  it('baseline is taxed on income less 80,000', () => {
    expect(result.baseline.reliefs).toMatchObject({ totalBeforeCap: 91_400, totalAllowed: 80_000, lostToCap: 11_400 });
    expect(result.baseline.chargeableIncome).toBe(55_000);
    expect(result.baseline.taxPayable).toBe(1_600);
    expect(result.reliefCapRoom).toBe(0);
  });

  it('recommends nothing, binding reliefCap', () => {
    // U = 15,000; C = 0; L = 23,300
    expect(result.plan.totalContribution).toBe(0);
    expect(result.plan.contributions).toEqual({ srs: 0, cpfSelf: 0, cpfFamily: 0 });
    expect(result.plan.bindingConstraint).toBe('reliefCap');
    expect(result.plan.taxSaved).toBe(0);
    expect(result.plan.unrealisedSaving).toBe(0);
  });

  it('raises both relief-cap warnings', () => {
    expect(codes(result)).toEqual(['RELIEF_CAP_EXCEEDED_BASELINE', 'RELIEF_CAP_LIMITS_PLAN']);
    expect(result.warnings[0]).toMatchObject({
      severity: 'caution',
      params: { totalBeforeCap: 91_400, personalReliefCap: 80_000, lostToCap: 11_400 },
    });
  });

  it('the whole ladder is beyond the cap, and every scenario dollar is wasted', () => {
    expect(result.ladder).toEqual([
      {
        fromContribution: 0,
        toContribution: 23_300,
        amount: 23_300,
        rate: 0,
        taxSaved: 0,
        cumulativeTaxSaved: 0,
        usedByPlan: 0,
        zeroReason: 'reliefCap',
      },
    ]);
    expect(result.scenarios.find((s) => s.id === 'maxAll')).toMatchObject({
      totalContribution: 23_300,
      taxPayable: 1_600,
      taxSaved: 0,
      savingRate: 0,
      wastedContribution: 23_300,
    });
    expect(result.simulator.every((row) => row.taxSaved === 0 && row.taxPayable === 1_600)).toBe(true);
  });

  it('contributing anyway only adds to the relief that is lost', () => {
    const tax = evaluate(input({ otherReliefs: 70_000 }), { srs: 10_000, cpfSelf: 0, cpfFamily: 0 });
    expect(tax.reliefs.lostToCap).toBe(21_400);
    expect(tax.taxPayable).toBe(1_600);
  });
});

describe('binding constraint: leverLimits', () => {
  it('stops when every enabled scheme is full', () => {
    const result = plan(input());
    expect(result.plan.totalContribution).toBe(23_300);
    expect(result.plan.bindingConstraint).toBe('leverLimits');
    expect(result.plan.unrealisedSaving).toBe(2_359.5);
    expect(codes(result)).toEqual(['LEVER_LIMITS_PLAN']);
  });

  it('nothing enabled: nothing to contribute, tax unchanged', () => {
    const result = plan(input({ srs: { enabled: false }, cpfSelf: { enabled: false } }));
    expect(result.plan.totalContribution).toBe(0);
    expect(result.plan.bindingConstraint).toBe('leverLimits');
    expect(result.plan.taxAfter).toBe(6_639);
    // U = 68,600 and C = 53,600 -> chargeable income 55,000 -> 1,600; 6,639 - 1,600 still on the table
    expect(result.plan.unrealisedSaving).toBe(5_039);
    expect(result.ladder).toEqual([]);
    expect(result.simulator).toHaveLength(1);
    expect(result.simulator[0]).toMatchObject({ contribution: 0, taxPayable: 6_639, taxSaved: 0, withinPlan: true });
    expect(codes(result)).toEqual(['LEVER_LIMITS_PLAN']);
    // the scenarios ignore the SRS / CPF self switches
    expect(result.scenarios.find((s) => s.id === 'srsPlusCpfSelf')?.taxSaved).toBe(2_679.5);
    expect(result.scenarios.find((s) => s.id === 'recommended')?.totalContribution).toBe(0);
  });

  it('one scheme enabled', () => {
    const result = plan(input({ srs: { enabled: false } }));
    expect(result.plan.contributions).toEqual({ srs: 0, cpfSelf: 8_000, cpfFamily: 0 });
    expect(result.plan.taxSaved).toBe(920);
    expect(result.plan.bindingConstraint).toBe('leverLimits');
  });
});

describe('binding constraint: cashBudget', () => {
  it('stops at the budget', () => {
    const result = plan(input({ preferences: { cashBudget: 10_000 } }));
    expect(result.plan.totalContribution).toBe(10_000);
    expect(result.plan.contributions).toEqual({ srs: 10_000, cpfSelf: 0, cpfFamily: 0 });
    expect(result.plan.bindingConstraint).toBe('cashBudget');
    expect(result.plan.taxAfter).toBe(5_489); // 6,639 - 1,150
    expect(result.plan.taxSaved).toBe(1_150);
    // min(U, C) = 53,600 -> tax(55,000) = 1,600; 5,489 - 1,600
    expect(result.plan.unrealisedSaving).toBe(3_889);
    expect(codes(result)).toEqual(['BUDGET_LIMITS_PLAN']);
    // With the cash limit lifted the schemes stop the plan at L = 23,300: tax 3,959.50, i.e. 5,489 - 3,959.50
    // = 1,529.50 more (SPEC §6.11: the saving more cash can actually deliver).
    expect(result.warnings[0]?.params).toEqual({ cashBudget: 10_000, unrealisedSaving: 3_889, savingWithMoreCash: 1_529.5 });
  });

  it('a budget of zero recommends nothing', () => {
    const result = plan(input({ preferences: { cashBudget: 0 } }));
    expect(result.plan.totalContribution).toBe(0);
    expect(result.plan.bindingConstraint).toBe('cashBudget');
    expect(result.plan.taxSaved).toBe(0);
    expect(result.plan.savingRate).toBe(0);
  });

  it('a budget larger than everything else does not bind', () => {
    const result = plan(input({ preferences: { cashBudget: 1_000_000 } }));
    expect(result.plan.totalContribution).toBe(23_300);
    expect(result.plan.bindingConstraint).toBe('leverLimits');
  });

  it('an odd budget is used to the dollar', () => {
    const result = plan(input({ preferences: { cashBudget: 15_301 } }));
    expect(result.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 1, cpfFamily: 0 });
    expect(result.plan.taxSaved).toBe(1_759.61); // 15,301 x 11.5% = 1,759.615 -> tax after 4,879.385 -> 4,879.39
    expect(result.plan.taxAfter).toBe(4_879.39);
  });
});

describe("binding constraint: 'none'", () => {
  // S$1,500 x 12 = 18,000; CPF 3,600; EIR 1,000; no other reliefs -> chargeable income 13,400, no tax.
  const result = plan(input({ income: { monthlyOrdinaryWage: 1_500, additionalWages: 0 }, otherReliefs: 0 }));

  it('no tax payable: nothing to recommend', () => {
    expect(result.baseline.chargeableIncome).toBe(13_400);
    expect(result.baseline.taxPayable).toBe(0);
    expect(result.baseline.marginalRate).toBe(0);
    expect(result.plan.totalContribution).toBe(0);
    expect(result.plan.bindingConstraint).toBe('none');
    expect(result.plan.unrealisedSaving).toBe(0);
    expect(codes(result)).toEqual(['NO_TAX_PAYABLE']);
    expect(result.warnings[0]).toMatchObject({ severity: 'info', params: { ya: 2027, chargeableIncome: 13_400 } });
  });

  it('the ladder is one zero tier below the tax threshold, merged across the end of chargeable income', () => {
    expect(result.ladder).toEqual([
      {
        fromContribution: 0,
        toContribution: 23_300,
        amount: 23_300,
        rate: 0,
        taxSaved: 0,
        cumulativeTaxSaved: 0,
        usedByPlan: 0,
        zeroReason: 'belowTaxThreshold',
      },
    ]);
  });

  it("stays 'none' even with a minimum rate of zero and every scheme on", () => {
    const everything = plan(
      input({
        income: { monthlyOrdinaryWage: 1_500, additionalWages: 0 },
        otherReliefs: 0,
        cpfFamily: { enabled: true },
        preferences: { minSavingRate: 0 },
      }),
    );
    expect(everything.plan.totalContribution).toBe(0);
    expect(everything.plan.bindingConstraint).toBe('none');
    expect(everything.scenarios.find((s) => s.id === 'maxAll')).toMatchObject({
      totalContribution: 31_300,
      taxSaved: 0,
      wastedContribution: 31_300,
    });
  });

  it('chargeable income exactly at the threshold pays no tax', () => {
    // 2,000 x 12 = 24,000; CPF 4,800; EIR 1,000 -> 18,200; add other income 1,800 -> 20,000
    const atThreshold = plan(
      input({ income: { monthlyOrdinaryWage: 2_000, additionalWages: 0, otherTaxableIncome: 1_800 }, otherReliefs: 0 }),
    );
    expect(atThreshold.baseline.chargeableIncome).toBe(20_000);
    expect(atThreshold.baseline.taxPayable).toBe(0);
    expect(atThreshold.plan.bindingConstraint).toBe('none');
  });
});

describe('binding constraint: ties resolve usefulRoom, reliefCap, leverLimits, cashBudget', () => {
  it('U = L -> usefulRoom', () => {
    // minSavingRate 11.5%: U = 28,600; L = 15,300 + 8,000 + 5,300
    const result = plan(
      input({ cpfFamily: { enabled: true, maxAmount: 5_300 }, preferences: { minSavingRate: 0.115 } }),
    );
    expect(result.plan.totalContribution).toBe(28_600);
    expect(result.plan.bindingConstraint).toBe('usefulRoom');
  });

  it('U = B -> usefulRoom', () => {
    const result = plan(
      input({ cpfFamily: { enabled: true }, preferences: { minSavingRate: 0.115, cashBudget: 28_600 } }),
    );
    expect(result.plan.totalContribution).toBe(28_600);
    expect(result.plan.bindingConstraint).toBe('usefulRoom');
  });

  it('U = C -> usefulRoom', () => {
    // U = C needs income - floor = 80,000: income 120,000 (no bonus) with the 7% floor at 40,000.
    const result = plan(
      input({
        income: { monthlyOrdinaryWage: 10_000, additionalWages: 0 },
        otherReliefs: 30_000,
        cpfFamily: { enabled: true },
        preferences: { minSavingRate: 0.07 },
      }),
    );
    // CPF 19,200; reliefs 1,000 + 19,200 + 30,000 = 50,200; chargeable income 69,800
    expect(result.baseline.chargeableIncome).toBe(69_800);
    expect(result.reliefCapRoom).toBe(29_800); // C = 80,000 - 50,200
    // U = 69,800 - 40,000 = 29,800 = C; L = 31,300
    expect(result.plan.totalContribution).toBe(29_800);
    expect(result.plan.bindingConstraint).toBe('usefulRoom');
    expect(result.warnings.map((w) => w.code)).not.toContain('RELIEF_CAP_LIMITS_PLAN');
  });

  it('C = L -> reliefCap', () => {
    // other reliefs 35,300: reliefs 56,700 -> C = 23,300 = L; chargeable income 78,300 -> U = 38,300
    const result = plan(input({ otherReliefs: 35_300 }));
    expect(result.reliefCapRoom).toBe(23_300);
    expect(result.plan.totalContribution).toBe(23_300);
    expect(result.plan.bindingConstraint).toBe('reliefCap');
  });

  it('C = B -> reliefCap', () => {
    const result = plan(input({ otherReliefs: 40_000, preferences: { cashBudget: 18_600 } }));
    expect(result.plan.totalContribution).toBe(18_600);
    expect(result.plan.bindingConstraint).toBe('reliefCap');
  });

  it('L = B -> leverLimits', () => {
    const result = plan(input({ preferences: { cashBudget: 23_300 } }));
    expect(result.plan.totalContribution).toBe(23_300);
    expect(result.plan.bindingConstraint).toBe('leverLimits');
  });
});

describe('simulator (§6.8)', () => {
  it('uses the step from preferences, with a short last step', () => {
    const result = plan(input({ preferences: { simulatorStep: 5_000 } }));
    expect(result.simulator.map((row) => row.contribution)).toEqual([0, 5_000, 10_000, 15_000, 20_000, 23_300]);
    // 5,000 x 11.5% = 575 per step; the last step is 3,300 x 11.5% = 379.50
    expect(result.simulator.map((row) => row.stepSaving)).toEqual([0, 575, 575, 575, 575, 379.5]);
    expect(result.simulator.map((row) => row.taxSaved)).toEqual([0, 575, 1_150, 1_725, 2_300, 2_679.5]);
    expect(result.simulator[3]?.split).toEqual({ srs: 15_000, cpfSelf: 0, cpfFamily: 0 });
    expect(result.simulator[4]?.split).toEqual({ srs: 15_300, cpfSelf: 4_700, cpfFamily: 0 });
  });

  it('a step that divides the room exactly adds no extra row', () => {
    const result = plan(input({ srs: { enabled: false }, preferences: { simulatorStep: 2_000 } }));
    expect(result.simulator.map((row) => row.contribution)).toEqual([0, 2_000, 4_000, 6_000, 8_000]);
  });

  it('the minimum step is S$100 and the default S$1,000', () => {
    const fine = plan(input({ srs: { enabled: false }, preferences: { simulatorStep: 1 } }));
    expect(fine.input.preferences.simulatorStep).toBe(100);
    expect(fine.simulator).toHaveLength(81); // 8,000 / 100 + 1
    const byDefault = plan(input({ preferences: { simulatorStep: undefined } }));
    expect(byDefault.input.preferences.simulatorStep).toBe(1_000);
    expect(byDefault.simulator).toHaveLength(25);
  });

  it('ignores the budget and the minimum rate but marks which rows are within the plan', () => {
    const result = plan(input({ preferences: { cashBudget: 2_500 } }));
    expect(result.plan.totalContribution).toBe(2_500);
    expect(result.simulator).toHaveLength(25);
    expect(result.simulator.map((row) => row.withinPlan).slice(0, 5)).toEqual([true, true, true, false, false]);
  });

  it('shows the step rate falling across a bracket boundary', () => {
    // minSavingRate 0, chargeable income 108,600: the 80,000 boundary is crossed between 28,000 and 29,000
    const result = plan(input({ cpfFamily: { enabled: true }, preferences: { minSavingRate: 0 } }));
    const row29 = result.simulator[29];
    // 600 x 11.5% + 400 x 7% = 69 + 28 = 97
    expect(row29).toMatchObject({ contribution: 29_000, stepSaving: 97 });
    expect(row29?.stepRate).toBeCloseTo(0.097, 12);
    expect(result.simulator[30]).toMatchObject({ contribution: 30_000, stepSaving: 70 });
  });
});

describe('scenarios (§6.9)', () => {
  it('include the family lever in maxAll only when it is enabled', () => {
    const off = plan(input());
    expect(off.scenarios.find((s) => s.id === 'maxAll')?.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 });
    const on = plan(input({ cpfFamily: { enabled: true } }));
    expect(on.scenarios.find((s) => s.id === 'maxAll')).toMatchObject({
      contributions: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 8_000 },
      totalContribution: 31_300,
      taxPayable: 3_161, // 28,600 x 11.5% + 2,700 x 7% = 3,478 saved
      taxSaved: 3_478,
      wastedContribution: 0,
    });
  });

  it('ignore the budget, the minimum rate and the priority', () => {
    const constrained = plan(
      input({ preferences: { cashBudget: 1_000, minSavingRate: 0.5, priority: ['cpfFamily', 'cpfSelf', 'srs'] } }),
    );
    const free = plan(input());
    for (const id of ['none', 'srsOnly', 'cpfSelfOnly', 'srsPlusCpfSelf', 'maxAll'] as const) {
      expect(constrained.scenarios.find((s) => s.id === id)).toEqual(free.scenarios.find((s) => s.id === id));
    }
    expect(constrained.scenarios.find((s) => s.id === 'recommended')?.totalContribution).toBe(0);
  });
});

describe('reconciliation of the ladder, simulator and scenarios with the plan', () => {
  const profiles: [string, PlannerInput][] = [
    ['opening example', input()],
    ['all levers, any saving', input({ cpfFamily: { enabled: true }, preferences: { minSavingRate: 0 } })],
    ['budget', input({ cpfFamily: { enabled: true }, preferences: { cashBudget: 12_345 } })],
    ['relief cap in play', input({ otherReliefs: 45_000, cpfFamily: { enabled: true }, preferences: { minSavingRate: 0 } })],
    ['relief cap exceeded', input({ otherReliefs: 75_000 })],
    ['low income', input({ income: { monthlyOrdinaryWage: 3_500, additionalWages: 3_500 }, otherReliefs: 0, preferences: { minSavingRate: 0 } })],
    ['no tax', input({ income: { monthlyOrdinaryWage: 1_200, additionalWages: 0 }, otherReliefs: 0 })],
    ['high income', input({ income: { monthlyOrdinaryWage: 40_000, additionalWages: 250_000 }, cpfFamily: { enabled: true } })],
    ['foreigner', input({ profile: { residency: 'foreigner' }, income: { monthlyOrdinaryWage: 20_000, additionalWages: 0 } })],
    ['existing contributions', input({ existing: { srs: 9_999, cpfTopUpSelf: 7_001 }, preferences: { simulatorStep: 700 } })],
    ['donations (half-dollar assessable income)', input({ income: { donations: 333 }, preferences: { minSavingRate: 0 } })],
    ['2025', input({ incomeYear: 2025, today: '2025-10-01', profile: { ageAtYearEnd: 61, birthMonth: 5 } })],
    ['2027', input({ incomeYear: 2027, today: '2027-03-01', profile: { residency: 'pr', prYear: 2 } })],
    ['family first, part-year', input({ income: { monthsWorked: 7 }, cpfFamily: { enabled: true, maxAmount: 1_234 }, preferences: { priority: ['cpfFamily', 'cpfSelf', 'srs'], simulatorStep: 333 } })],
  ];

  describe.each(profiles)('%s', (_name, profile) => {
    const result = plan(profile);
    const leverRoom = result.levers.srs.room + result.levers.cpfSelf.room + result.levers.cpfFamily.room;
    const planTotal = result.plan.totalContribution;

    it('the plan respects every limit', () => {
      const { contributions } = result.plan;
      expect(contributions.srs + contributions.cpfSelf + contributions.cpfFamily).toBe(planTotal);
      expect(contributions.srs).toBeLessThanOrEqual(result.levers.srs.room);
      expect(contributions.cpfSelf).toBeLessThanOrEqual(result.levers.cpfSelf.room);
      expect(contributions.cpfFamily).toBeLessThanOrEqual(result.levers.cpfFamily.room);
      expect(planTotal).toBeLessThanOrEqual(result.reliefCapRoom);
      const budget = result.input.preferences.cashBudget;
      if (typeof budget === 'number') expect(planTotal).toBeLessThanOrEqual(budget);
      expect(result.optimised.reliefs.lostToCap).toBe(result.baseline.reliefs.lostToCap);
    });

    it('optimised = evaluate(input, plan.contributions), and the plan figures come from it', () => {
      expect(result.optimised).toEqual(evaluate(profile, result.plan.contributions));
      expect(result.plan.taxBefore).toBe(result.baseline.taxPayable);
      expect(result.plan.taxAfter).toBe(result.optimised.taxPayable);
      expect(result.plan.taxSaved).toBe(Math.round((result.plan.taxBefore - result.plan.taxAfter) * 100) / 100);
      expect(result.plan.chargeableIncomeAfter).toBe(result.baseline.chargeableIncome - planTotal);
    });

    it('the ladder partitions [0, L) and its savings add up', () => {
      let cursor = 0;
      let cumulative = 0;
      for (const tier of result.ladder) {
        expect(tier.fromContribution).toBe(cursor);
        expect(tier.amount).toBe(tier.toContribution - tier.fromContribution);
        expect(tier.amount).toBeGreaterThan(0);
        cumulative = Math.round((cumulative + tier.taxSaved) * 100) / 100;
        expect(tier.cumulativeTaxSaved).toBe(cumulative);
        expect(tier.usedByPlan).toBe(Math.max(0, Math.min(tier.toContribution, planTotal) - tier.fromContribution));
        if (tier.rate === 0) expect(tier.zeroReason).toBeDefined();
        else expect(tier.zeroReason).toBeUndefined();
        cursor = tier.toContribution;
      }
      expect(cursor).toBe(leverRoom);
      expect(result.ladder.reduce((sum, tier) => sum + tier.usedByPlan, 0)).toBe(planTotal);
    });

    it('adjacent ladder tiers differ in rate or zero reason', () => {
      result.ladder.forEach((tier, index) => {
        const next = result.ladder[index + 1];
        if (next) expect([next.rate, next.zeroReason]).not.toEqual([tier.rate, tier.zeroReason]);
      });
    });

    it('tier savings equal rate x amount (no rebate in these years)', () => {
      for (const tier of result.ladder) {
        expect(Math.abs(tier.taxSaved - tier.rate * tier.amount)).toBeLessThan(0.011);
      }
    });

    it('the plan saves what the ladder says for the dollars it uses', () => {
      const ctx = buildContext(sanitise(profile), getRules(profile.incomeYear));
      expect(taxPayableAfter(ctx, planTotal)).toBe(result.plan.taxAfter);
      expect(taxPayableAfter(ctx, 0)).toBe(result.plan.taxBefore);
      const fromLadder = result.ladder.reduce((sum, tier) => sum + tier.rate * tier.usedByPlan, 0);
      expect(Math.abs(result.plan.taxSaved - fromLadder)).toBeLessThan(0.011);
      // every rung the plan uses saves at least the minimum rate
      for (const tier of result.ladder) {
        if (tier.usedByPlan > 0) {
          expect(tier.rate).toBeGreaterThan(0);
          expect(tier.rate).toBeGreaterThanOrEqual(result.input.preferences.minSavingRate);
        }
      }
    });

    it('the simulator runs from 0 to L and every row matches evaluate()', () => {
      const step = result.input.preferences.simulatorStep ?? 1_000;
      const rows = result.simulator;
      expect(rows).toHaveLength(Math.ceil(leverRoom / step) + 1);
      expect(rows[0]?.contribution).toBe(0);
      expect(rows[rows.length - 1]?.contribution).toBe(leverRoom);
      let previousSaved = 0;
      rows.forEach((row, index) => {
        expect(row.contribution).toBe(Math.min(index * step, leverRoom));
        expect(row.split.srs + row.split.cpfSelf + row.split.cpfFamily).toBe(row.contribution);
        expect(row.taxPayable).toBe(evaluate(profile, row.split).taxPayable);
        expect(row.taxSaved).toBe(Math.round((result.baseline.taxPayable - row.taxPayable) * 100) / 100);
        expect(row.stepSaving).toBe(Math.round((row.taxSaved - previousSaved) * 100) / 100);
        expect(row.withinPlan).toBe(row.contribution <= planTotal);
        expect(row.stepSaving).toBeGreaterThanOrEqual(0);
        previousSaved = row.taxSaved;
      });
    });

    it('the last simulator row, the last ladder tier and maxAll agree when they cover the same levers', () => {
      const lastRow = result.simulator[result.simulator.length - 1];
      const lastTier = result.ladder[result.ladder.length - 1];
      expect(lastRow?.taxSaved).toBe(lastTier?.cumulativeTaxSaved ?? 0);
      const maxAll = result.scenarios.find((s) => s.id === 'maxAll');
      if (maxAll?.totalContribution === leverRoom) expect(maxAll.taxSaved).toBe(lastRow?.taxSaved);
    });

    it("the 'recommended' scenario is the plan", () => {
      const recommended = result.scenarios.find((s) => s.id === 'recommended');
      expect(recommended).toMatchObject({
        contributions: result.plan.contributions,
        totalContribution: planTotal,
        taxPayable: result.plan.taxAfter,
        taxSaved: result.plan.taxSaved,
        savingRate: result.plan.savingRate,
        wastedContribution: 0,
      });
    });

    it('no fixed scenario beats the recommendation per dollar unless the plan was limited', () => {
      const noScenario = result.scenarios.find((s) => s.id === 'none');
      expect(noScenario).toMatchObject({ totalContribution: 0, taxSaved: 0, taxPayable: result.baseline.taxPayable });
      for (const scenario of result.scenarios) {
        expect(scenario.taxSaved).toBe(Math.round((result.baseline.taxPayable - scenario.taxPayable) * 100) / 100);
        expect(scenario.wastedContribution).toBeGreaterThanOrEqual(0);
        expect(scenario.wastedContribution).toBeLessThanOrEqual(scenario.totalContribution);
        if (scenario.totalContribution > 0 && scenario.totalContribution <= planTotal) {
          expect(scenario.taxSaved).toBeLessThanOrEqual(result.plan.taxSaved);
        }
      }
    });

    it('one more dollar would break a limit or save less than the minimum rate', () => {
      const budget = result.input.preferences.cashBudget;
      const atLimit =
        planTotal >= leverRoom || planTotal >= result.reliefCapRoom || (typeof budget === 'number' && planTotal >= budget);
      if (!atLimit) {
        // the next relief dollar would come off the last dollar of the remaining chargeable income
        const nextDollarRate = result.plan.marginalRateAfter;
        expect(nextDollarRate === 0 || nextDollarRate < result.input.preferences.minSavingRate).toBe(true);
        expect(['usefulRoom', 'none']).toContain(result.plan.bindingConstraint);
      }
    });
  });
});

describe('ladder with a Personal Income Tax Rebate reports realised savings', () => {
  it('tier savings reflect the shrinking rebate while the rate stays statutory', () => {
    // Appendix A.3 profile, minSavingRate 0, with a 60% rebate capped at S$200:
    //   N(0)      = 389.00 - min(200, 233.40) = 189.00
    //   N(5,400)  = 200.00 - 120.00            =  80.00   (chargeable income 30,000)
    //   N(15,400) = 0                                    (chargeable income 20,000)
    const rules = { ...getRules(2026), pitRebate: { rate: 0.6, cap: 200 } };
    const result = planFor(
      sanitise(
        input({
          profile: { ageAtYearEnd: 28 },
          income: { monthlyOrdinaryWage: 3_500, additionalWages: 3_500 },
          otherReliefs: 0,
          preferences: { minSavingRate: 0 },
        }),
      ),
      rules,
    );
    expect(result.baseline).toMatchObject({ grossTax: 389, pitRebate: 200, taxPayable: 189 });
    expect(result.plan).toMatchObject({ totalContribution: 15_400, taxBefore: 189, taxAfter: 0, taxSaved: 189 });
    expect(result.ladder.map((t) => [t.rate, t.taxSaved, t.cumulativeTaxSaved])).toEqual([
      [0.035, 109, 109],
      [0.02, 80, 189],
      [0, 0, 189],
    ]);
    expect(result.warnings.map((w) => w.code)).toEqual(['PIT_REBATE_APPLIED']);
    expect(result.warnings[0]).toMatchObject({
      severity: 'info',
      params: { pitRebate: 200, rebateRate: 0.6, rebateCap: 200 },
    });
  });
});
