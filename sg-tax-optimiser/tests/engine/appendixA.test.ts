/**
 * SPEC Appendix A — the normative worked examples, asserted field by field.
 * Every expected number is derived by hand in the comments; none is copied from engine output.
 */
import { describe, expect, it } from 'vitest';
import { defaultInput, evaluate, getRules, plan } from '../../src/engine';
import type { PlannerInput } from '../../src/engine';
import { buildContext } from '../../src/engine/evaluate';
import { optimise } from '../../src/engine/optimiser';
import { sanitise } from '../../src/engine/sanitise';

const TODAY = '2026-11-13';

/** §6.6 U for an input (it is not part of PlannerResult, so read it from the optimiser). */
function usefulRoomOf(input: PlannerInput): number {
  return optimise(buildContext(sanitise(input), getRules(input.incomeYear))).usefulRoom;
}

describe('Appendix A.1 — the opening example', () => {
  // Citizen, 35, S$10,000 x 12, S$15,000 bonus, S$5,000 other reliefs, nothing contributed,
  // SRS + CPF self on, family off, no budget, minSavingRate 0.07, priority srs -> cpfSelf -> cpfFamily.
  const input = defaultInput(TODAY);
  const result = plan(input);

  it('uses income year 2026 and the given date', () => {
    expect(result.input.incomeYear).toBe(2026);
    expect(result.input.today).toBe(TODAY);
    expect(result.rules.ya).toBe(2027);
  });

  it('CPF: OW 8,000 x 12 = 96,000 -> 19,200; AW ceiling 6,000 -> 1,200; relief 20,400', () => {
    expect(result.cpf).toEqual({
      source: 'auto',
      ordinaryWagesSubject: 96_000, // min(10,000, 8,000) x 12
      additionalWageCeiling: 6_000, // 102,000 - 96,000
      additionalWagesSubject: 6_000, // min(15,000, 6,000)
      employeeContribution: 20_400, // 1,600 x 12 + 20% x 6,000
      employerContribution: 17_340, // 17% x (96,000 + 6,000)
      monthlyEmployeeRates: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
    });
  });

  it('baseline: reliefs 26,400, chargeable income 108,600, tax 6,639.00 at 11.5%', () => {
    const b = result.baseline;
    expect(b.employmentIncome).toBe(135_000); // 120,000 + 15,000
    expect(b.employmentExpenses).toBe(0);
    expect(b.otherTaxableIncome).toBe(0);
    expect(b.totalIncome).toBe(135_000);
    expect(b.donationDeduction).toBe(0);
    expect(b.assessableIncome).toBe(135_000);
    expect(b.reliefs).toEqual({
      earnedIncome: 1_000,
      cpf: 20_400,
      srs: 0,
      cpfTopUpSelf: 0,
      cpfTopUpFamily: 0,
      other: 5_000,
      totalBeforeCap: 26_400,
      totalAllowed: 26_400,
      lostToCap: 0,
    });
    expect(b.chargeableIncome).toBe(108_600); // 135,000 - 26,400
    expect(b.grossTax).toBe(6_639); // 3,350 + 11.5% x 28,600 = 3,350 + 3,289
    expect(b.pitRebate).toBe(0);
    expect(b.taxPayable).toBe(6_639);
    expect(b.marginalRate).toBe(0.115);
    expect(b.effectiveRate).toBeCloseTo(6_639 / 135_000, 12);
  });

  it('levers: SRS 15,300 and CPF self 8,000 of room; family eligible but switched off', () => {
    expect(result.levers).toEqual({
      srs: { statutoryCap: 15_300, used: 0, room: 15_300, eligible: true, enabled: true },
      cpfSelf: { statutoryCap: 8_000, used: 0, room: 8_000, eligible: true, enabled: true },
      cpfFamily: { statutoryCap: 8_000, used: 0, room: 0, eligible: true, enabled: false },
    });
  });

  it('U, C, L, B = 68,600 / 53,600 / 23,300 / none -> X = 23,300, binding leverLimits', () => {
    expect(usefulRoomOf(input)).toBe(68_600); // 108,600 - 40,000 (the 7% bracket starts at 40,000)
    expect(result.reliefCapRoom).toBe(53_600); // 80,000 - 26,400
    expect(result.levers.srs.room + result.levers.cpfSelf.room + result.levers.cpfFamily.room).toBe(23_300);
    expect(result.input.preferences.cashBudget).toBeNull();
    expect(result.plan.totalContribution).toBe(23_300);
    expect(result.plan.bindingConstraint).toBe('leverLimits');
  });

  it('plan: SRS 15,300 + CPF self 8,000 saves 2,679.50', () => {
    expect(result.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 });
    expect(result.plan.taxBefore).toBe(6_639);
    expect(result.plan.taxAfter).toBe(3_959.5); // 3,350 + 11.5% x 5,300 = 3,350 + 609.50
    expect(result.plan.taxSaved).toBe(2_679.5); // 6,639 - 3,959.50 = 23,300 x 11.5%
    expect(result.plan.savingRate).toBeCloseTo(0.115, 12);
    expect(result.plan.chargeableIncomeBefore).toBe(108_600);
    expect(result.plan.chargeableIncomeAfter).toBe(85_300); // 108,600 - 23,300
    expect(result.plan.marginalRateBefore).toBe(0.115);
    expect(result.plan.marginalRateAfter).toBe(0.115);
  });

  it('unrealised saving: 3,959.50 - tax(55,000) = 3,959.50 - 1,600 = 2,359.50', () => {
    // min(U, C) = 53,600 -> chargeable income 55,000 -> 550 + 7% x 15,000 = 1,600
    expect(result.plan.unrealisedSaving).toBe(2_359.5);
  });

  it('optimised computation carries the new reliefs', () => {
    const o = result.optimised;
    expect(o.reliefs.srs).toBe(15_300);
    expect(o.reliefs.cpfTopUpSelf).toBe(8_000);
    expect(o.reliefs.cpfTopUpFamily).toBe(0);
    expect(o.reliefs.totalBeforeCap).toBe(49_700); // 26,400 + 23,300
    expect(o.reliefs.totalAllowed).toBe(49_700);
    expect(o.reliefs.lostToCap).toBe(0);
    expect(o.chargeableIncome).toBe(85_300);
    expect(o.grossTax).toBe(3_959.5);
    expect(o.taxPayable).toBe(3_959.5);
    expect(o.marginalRate).toBe(0.115);
    expect(o).toEqual(evaluate(input, result.plan.contributions));
  });

  it('ladder: one tier [0, 23,300) at 11.5%, saves 2,679.50, all used by the plan', () => {
    expect(result.ladder).toEqual([
      {
        fromContribution: 0,
        toContribution: 23_300,
        amount: 23_300,
        rate: 0.115,
        taxSaved: 2_679.5,
        cumulativeTaxSaved: 2_679.5,
        usedByPlan: 23_300,
      },
    ]);
  });

  it('simulator: 25 rows of S$1,000 (the last one S$300), each saving 11.5%', () => {
    const rows = result.simulator;
    expect(rows).toHaveLength(25); // i = 0 ... ceil(23,300 / 1,000) = 24
    expect(rows[0]).toEqual({
      contribution: 0,
      split: { srs: 0, cpfSelf: 0, cpfFamily: 0 },
      taxPayable: 6_639,
      taxSaved: 0,
      stepSaving: 0,
      stepRate: 0,
      withinPlan: true,
    });
    // 1,000 into SRS: 6,639 - 115 = 6,524
    expect(rows[1]).toMatchObject({
      contribution: 1_000,
      split: { srs: 1_000, cpfSelf: 0, cpfFamily: 0 },
      taxPayable: 6_524,
      taxSaved: 115,
      stepSaving: 115,
      withinPlan: true,
    });
    expect(rows[1]?.stepRate).toBeCloseTo(0.115, 12);
    // 16,000 = SRS 15,300 (full) + CPF self 700: saves 16,000 x 11.5% = 1,840
    expect(rows[16]).toMatchObject({
      contribution: 16_000,
      split: { srs: 15_300, cpfSelf: 700, cpfFamily: 0 },
      taxPayable: 4_799,
      taxSaved: 1_840,
      stepSaving: 115,
    });
    // last row is capped at L = 23,300: a 300-dollar step saving 34.50
    expect(rows[24]).toMatchObject({
      contribution: 23_300,
      split: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 },
      taxPayable: 3_959.5,
      taxSaved: 2_679.5,
      stepSaving: 34.5,
      withinPlan: true,
    });
    expect(rows[24]?.stepRate).toBeCloseTo(0.115, 12);
    expect(rows.every((row) => row.withinPlan)).toBe(true);
  });

  it('scenarios', () => {
    const byId = Object.fromEntries(result.scenarios.map((s) => [s.id, s]));
    expect(result.scenarios.map((s) => s.id)).toEqual([
      'none',
      'srsOnly',
      'cpfSelfOnly',
      'srsPlusCpfSelf',
      'maxAll',
      'recommended',
    ]);
    expect(byId.none).toEqual({
      id: 'none',
      contributions: { srs: 0, cpfSelf: 0, cpfFamily: 0 },
      totalContribution: 0,
      taxPayable: 6_639,
      taxSaved: 0,
      savingRate: 0,
      wastedContribution: 0,
    });
    // 15,300 x 11.5% = 1,759.50
    expect(byId.srsOnly).toMatchObject({
      contributions: { srs: 15_300, cpfSelf: 0, cpfFamily: 0 },
      totalContribution: 15_300,
      taxPayable: 4_879.5,
      taxSaved: 1_759.5,
      wastedContribution: 0,
    });
    // 8,000 x 11.5% = 920
    expect(byId.cpfSelfOnly).toMatchObject({
      contributions: { srs: 0, cpfSelf: 8_000, cpfFamily: 0 },
      totalContribution: 8_000,
      taxPayable: 5_719,
      taxSaved: 920,
      wastedContribution: 0,
    });
    const both = {
      contributions: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 },
      totalContribution: 23_300,
      taxPayable: 3_959.5,
      taxSaved: 2_679.5,
      wastedContribution: 0,
    };
    expect(byId.srsPlusCpfSelf).toMatchObject(both);
    expect(byId.maxAll).toMatchObject(both); // family is off, so nothing is added
    expect(byId.recommended).toMatchObject(both);
    for (const id of ['srsOnly', 'cpfSelfOnly', 'srsPlusCpfSelf', 'maxAll', 'recommended']) {
      expect(byId[id]?.savingRate).toBeCloseTo(0.115, 12);
    }
  });

  it('monthly plan on 2026-11-13: 2 months, SRS 7,650 + 7,650, CPF self 4,000 + 4,000', () => {
    expect(result.monthlyPlan).toEqual({
      deadline: '2026-12-31',
      daysToDeadline: 48, // 17 days left in November + 31 in December
      monthsRemaining: 2, // 12 - 11 + 1
      schedule: [
        { month: '2026-11', amounts: { srs: 7_650, cpfSelf: 4_000, cpfFamily: 0 }, total: 11_650 },
        { month: '2026-12', amounts: { srs: 7_650, cpfSelf: 4_000, cpfFamily: 0 }, total: 11_650 },
      ],
      // ceil(15,300 / 12) = 1,275; ceil(8,000 / 12) = ceil(666.67) = 667
      fullYearMonthly: { srs: 1_275, cpfSelf: 667, cpfFamily: 0, total: 1_942 },
    });
  });

  it('warnings: only LEVER_LIMITS_PLAN', () => {
    expect(result.warnings.map((w) => w.code)).toEqual(['LEVER_LIMITS_PLAN']);
    expect(result.warnings[0]?.params).toEqual({ leverRoom: 23_300, unrealisedSaving: 2_359.5 });
  });
});

describe('Appendix A.2 — older PR with a budget and the relief cap in play', () => {
  // PR (3rd year onwards), 57 at year end, born in June, S$14,000 x 12, S$40,000 bonus, S$30,000 other reliefs,
  // S$5,000 already in SRS; all three levers on (family max 8,000), budget 20,000, minSavingRate 0,
  // priority cpfSelf -> srs -> cpfFamily.
  const input: PlannerInput = {
    incomeYear: 2026,
    today: TODAY,
    profile: { residency: 'pr', prYear: 3, ageAtYearEnd: 57, birthMonth: 6 },
    income: { monthlyOrdinaryWage: 14_000, monthsWorked: 12, additionalWages: 40_000 },
    existing: { srs: 5_000, cpfTopUpSelf: 0, cpfTopUpFamily: 0 },
    otherReliefs: 30_000,
    levers: {
      srs: { enabled: true },
      cpfSelf: { enabled: true },
      cpfFamily: { enabled: true, maxAmount: 8_000 },
    },
    preferences: { cashBudget: 20_000, minSavingRate: 0, priority: ['cpfSelf', 'srs', 'cpfFamily'] },
  };
  const result = plan(input);

  it('CPF band: above 55 to 60 all year (employee 18%)', () => {
    // completed age is 56 (Jan-Jun) then 57 (Jul-Dec): both in the "above 55 to 60" band
    expect(result.cpf.monthlyEmployeeRates).toEqual(new Array(12).fill(0.18));
  });

  it('CPF relief: floor(18% x 8,000) x 12 + floor(18% x 6,000) = 17,280 + 1,080 = 18,360', () => {
    expect(result.cpf).toMatchObject({
      source: 'auto',
      ordinaryWagesSubject: 96_000,
      additionalWageCeiling: 6_000,
      additionalWagesSubject: 6_000,
      employeeContribution: 18_360,
      employerContribution: 16_320, // 16% x (96,000 + 6,000)
    });
  });

  it('baseline: income 208,000, reliefs 59,360, chargeable income 148,640, tax 12,246.00', () => {
    const b = result.baseline;
    expect(b.employmentIncome).toBe(208_000); // 168,000 + 40,000
    expect(b.totalIncome).toBe(208_000);
    expect(b.assessableIncome).toBe(208_000);
    expect(b.reliefs).toEqual({
      earnedIncome: 6_000, // 55-59
      cpf: 18_360,
      srs: 5_000,
      cpfTopUpSelf: 0,
      cpfTopUpFamily: 0,
      other: 30_000,
      totalBeforeCap: 59_360,
      totalAllowed: 59_360,
      lostToCap: 0,
    });
    expect(b.chargeableIncome).toBe(148_640); // 208,000 - 59,360
    expect(b.grossTax).toBe(12_246); // 7,950 + 15% x 28,640 = 7,950 + 4,296
    expect(b.taxPayable).toBe(12_246);
    expect(b.marginalRate).toBe(0.15);
  });

  it('lever rooms: SRS 10,300, CPF self 8,000, family 8,000 -> L = 26,300', () => {
    expect(result.levers).toEqual({
      srs: { statutoryCap: 15_300, used: 5_000, room: 10_300, eligible: true, enabled: true },
      cpfSelf: { statutoryCap: 8_000, used: 0, room: 8_000, eligible: true, enabled: true },
      cpfFamily: { statutoryCap: 8_000, used: 0, room: 8_000, eligible: true, enabled: true },
    });
  });

  it('U, C, L, B = 128,640 / 20,640 / 26,300 / 20,000 -> X = 20,000, binding cashBudget', () => {
    expect(usefulRoomOf(input)).toBe(128_640); // 148,640 - 20,000 (any positive rate counts)
    expect(result.reliefCapRoom).toBe(20_640); // 80,000 - 59,360
    expect(result.levers.srs.room + result.levers.cpfSelf.room + result.levers.cpfFamily.room).toBe(26_300);
    expect(result.input.preferences.cashBudget).toBe(20_000);
    expect(result.plan.totalContribution).toBe(20_000);
    expect(result.plan.bindingConstraint).toBe('cashBudget');
  });

  it('plan: CPF self 8,000, SRS 10,300, family 1,700; tax 9,246.00; saved 3,000.00 (15%)', () => {
    expect(result.plan.contributions).toEqual({ cpfSelf: 8_000, srs: 10_300, cpfFamily: 1_700 });
    expect(result.plan.taxBefore).toBe(12_246);
    expect(result.plan.chargeableIncomeAfter).toBe(128_640); // 148,640 - 20,000
    expect(result.plan.taxAfter).toBe(9_246); // 7,950 + 15% x 8,640 = 7,950 + 1,296
    expect(result.plan.taxSaved).toBe(3_000);
    expect(result.plan.savingRate).toBeCloseTo(0.15, 12);
    expect(result.plan.marginalRateBefore).toBe(0.15);
    expect(result.plan.marginalRateAfter).toBe(0.15);
    expect(result.optimised.reliefs).toMatchObject({
      srs: 15_300, // 5,000 existing + 10,300
      cpfTopUpSelf: 8_000,
      cpfTopUpFamily: 1_700,
      totalBeforeCap: 79_360,
      totalAllowed: 79_360,
      lostToCap: 0,
    });
  });

  it('unrealised saving: 9,246.00 - tax(128,000) = 9,246.00 - 9,150.00 = 96.00', () => {
    // min(U, C) = 20,640 -> chargeable income 128,000 -> 7,950 + 15% x 8,000 = 9,150
    expect(result.plan.unrealisedSaving).toBe(96);
  });

  it('ladder: [0, 20,640) at 15% saves 3,096.00 (plan uses 20,000); [20,640, 26,300) at 0% — reliefCap', () => {
    expect(result.ladder).toEqual([
      {
        fromContribution: 0,
        toContribution: 20_640,
        amount: 20_640,
        rate: 0.15,
        taxSaved: 3_096, // 20,640 x 15%
        cumulativeTaxSaved: 3_096,
        usedByPlan: 20_000,
      },
      {
        fromContribution: 20_640,
        toContribution: 26_300,
        amount: 5_660,
        rate: 0,
        taxSaved: 0,
        cumulativeTaxSaved: 3_096,
        usedByPlan: 0,
        zeroReason: 'reliefCap',
      },
    ]);
  });

  it('scenarios, including maxAll: contributes 26,300, saves 3,096.00, wastes 5,660', () => {
    const byId = Object.fromEntries(result.scenarios.map((s) => [s.id, s]));
    expect(byId.none).toMatchObject({ totalContribution: 0, taxPayable: 12_246, taxSaved: 0, wastedContribution: 0 });
    // 10,300 x 15% = 1,545
    expect(byId.srsOnly).toMatchObject({
      contributions: { srs: 10_300, cpfSelf: 0, cpfFamily: 0 },
      totalContribution: 10_300,
      taxPayable: 10_701,
      taxSaved: 1_545,
      wastedContribution: 0,
    });
    // 8,000 x 15% = 1,200
    expect(byId.cpfSelfOnly).toMatchObject({
      contributions: { srs: 0, cpfSelf: 8_000, cpfFamily: 0 },
      totalContribution: 8_000,
      taxPayable: 11_046,
      taxSaved: 1_200,
      wastedContribution: 0,
    });
    // 18,300 x 15% = 2,745
    expect(byId.srsPlusCpfSelf).toMatchObject({
      contributions: { srs: 10_300, cpfSelf: 8_000, cpfFamily: 0 },
      totalContribution: 18_300,
      taxPayable: 9_501,
      taxSaved: 2_745,
      wastedContribution: 0,
    });
    // 26,300 contributed but only 20,640 fits under the relief cap: 20,640 x 15% = 3,096; 26,300 - 20,640 wasted
    expect(byId.maxAll).toMatchObject({
      contributions: { srs: 10_300, cpfSelf: 8_000, cpfFamily: 8_000 },
      totalContribution: 26_300,
      taxPayable: 9_150,
      taxSaved: 3_096,
      wastedContribution: 5_660,
    });
    expect(byId.maxAll?.savingRate).toBeCloseTo(3_096 / 26_300, 12);
    expect(byId.recommended).toMatchObject({
      contributions: { srs: 10_300, cpfSelf: 8_000, cpfFamily: 1_700 },
      totalContribution: 20_000,
      taxPayable: 9_246,
      taxSaved: 3_000,
      wastedContribution: 0,
    });
  });

  it('simulator: saving stops growing once the relief cap is reached at 20,640', () => {
    const rows = result.simulator;
    expect(rows).toHaveLength(28); // i = 0 ... ceil(26,300 / 1,000) = 27
    // 20,000: the plan itself, filled in priority order cpfSelf -> srs -> cpfFamily
    expect(rows[20]).toMatchObject({
      contribution: 20_000,
      split: { cpfSelf: 8_000, srs: 10_300, cpfFamily: 1_700 },
      taxPayable: 9_246,
      taxSaved: 3_000,
      stepSaving: 150,
      withinPlan: true,
    });
    // 21,000: only 640 of the step still earns relief: 640 x 15% = 96
    expect(rows[21]).toMatchObject({
      contribution: 21_000,
      split: { cpfSelf: 8_000, srs: 10_300, cpfFamily: 2_700 },
      taxPayable: 9_150,
      taxSaved: 3_096,
      stepSaving: 96,
      withinPlan: false,
    });
    expect(rows[21]?.stepRate).toBeCloseTo(0.096, 12);
    expect(rows[22]).toMatchObject({ contribution: 22_000, taxSaved: 3_096, stepSaving: 0, stepRate: 0 });
    expect(rows[27]).toMatchObject({
      contribution: 26_300,
      split: { cpfSelf: 8_000, srs: 10_300, cpfFamily: 8_000 },
      taxPayable: 9_150,
      taxSaved: 3_096,
      stepSaving: 0,
      stepRate: 0,
      withinPlan: false,
    });
  });

  it('monthly plan on 2026-11-13: two equal instalments per scheme', () => {
    expect(result.monthlyPlan.monthsRemaining).toBe(2);
    expect(result.monthlyPlan.schedule).toEqual([
      { month: '2026-11', amounts: { cpfSelf: 4_000, srs: 5_150, cpfFamily: 850 }, total: 10_000 },
      { month: '2026-12', amounts: { cpfSelf: 4_000, srs: 5_150, cpfFamily: 850 }, total: 10_000 },
    ]);
    // ceil(10,300 / 12) = 859; ceil(8,000 / 12) = 667; ceil(1,700 / 12) = 142
    expect(result.monthlyPlan.fullYearMonthly).toEqual({ srs: 859, cpfSelf: 667, cpfFamily: 142, total: 1_668 });
  });

  it('warnings: the budget binds; age 55+ top-up note', () => {
    expect(result.warnings.map((w) => w.code)).toEqual(['BUDGET_LIMITS_PLAN', 'AGE_55_PLUS_TOPUP']);
    expect(result.warnings[0]?.params).toEqual({ cashBudget: 20_000, unrealisedSaving: 96 });
  });
});

describe('Appendix A.3 — lower income: recommending nothing', () => {
  // Citizen, 28, S$3,500 x 12, S$3,500 bonus, no other reliefs, defaults otherwise.
  const base = defaultInput(TODAY);
  const input: PlannerInput = {
    ...base,
    profile: { ...base.profile, ageAtYearEnd: 28 },
    income: { ...base.income, monthlyOrdinaryWage: 3_500, additionalWages: 3_500 },
    otherReliefs: 0,
  };
  const atSevenPercent = plan(input);
  const atAnySaving = plan({ ...input, preferences: { ...input.preferences, minSavingRate: 0 } });

  it('CPF relief 700 x 12 + 700 = 9,100; EIR 1,000; reliefs 10,100', () => {
    expect(atSevenPercent.cpf).toMatchObject({
      ordinaryWagesSubject: 42_000,
      additionalWageCeiling: 60_000, // 102,000 - 42,000
      additionalWagesSubject: 3_500,
      employeeContribution: 9_100,
      employerContribution: 7_735, // 17% x 45,500
    });
    expect(atSevenPercent.baseline.reliefs).toMatchObject({
      earnedIncome: 1_000,
      cpf: 9_100,
      totalBeforeCap: 10_100,
      totalAllowed: 10_100,
    });
  });

  it('chargeable income 45,500 - 10,100 = 35,400 -> tax 200 + 3.5% x 5,400 = 389.00 (marginal 3.5%)', () => {
    expect(atSevenPercent.baseline.employmentIncome).toBe(45_500);
    expect(atSevenPercent.baseline.chargeableIncome).toBe(35_400);
    expect(atSevenPercent.baseline.grossTax).toBe(389);
    expect(atSevenPercent.baseline.taxPayable).toBe(389);
    expect(atSevenPercent.baseline.marginalRate).toBe(0.035);
  });

  it('minSavingRate 0.07: U = 0 -> X = 0, binding usefulRoom, warning BELOW_MIN_SAVING_RATE', () => {
    expect(usefulRoomOf(input)).toBe(0); // 35,400 is below the 7% bracket's 40,000 floor
    expect(atSevenPercent.plan).toEqual({
      contributions: { srs: 0, cpfSelf: 0, cpfFamily: 0 },
      totalContribution: 0,
      taxBefore: 389,
      taxAfter: 389,
      taxSaved: 0,
      savingRate: 0,
      chargeableIncomeBefore: 35_400,
      chargeableIncomeAfter: 35_400,
      marginalRateBefore: 0.035,
      marginalRateAfter: 0.035,
      bindingConstraint: 'usefulRoom',
      unrealisedSaving: 0,
    });
    expect(atSevenPercent.warnings.map((w) => w.code)).toEqual(['BELOW_MIN_SAVING_RATE']);
    expect(atSevenPercent.warnings[0]?.params).toEqual({ marginalRate: 0.035, minSavingRate: 0.07 });
    expect(atSevenPercent.monthlyPlan.schedule).toEqual([]);
    expect(atSevenPercent.monthlyPlan.fullYearMonthly).toEqual({ srs: 0, cpfSelf: 0, cpfFamily: 0, total: 0 });
  });

  it('ladder: 5,400 at 3.5%, 10,000 at 2%, then 7,900 below the tax threshold', () => {
    // L = 23,300; chargeable income falls 35,400 -> 30,000 -> 20,000 -> 12,100
    expect(atSevenPercent.ladder).toEqual([
      {
        fromContribution: 0,
        toContribution: 5_400,
        amount: 5_400,
        rate: 0.035,
        taxSaved: 189, // 5,400 x 3.5%
        cumulativeTaxSaved: 189,
        usedByPlan: 0,
      },
      {
        fromContribution: 5_400,
        toContribution: 15_400,
        amount: 10_000,
        rate: 0.02,
        taxSaved: 200,
        cumulativeTaxSaved: 389,
        usedByPlan: 0,
      },
      {
        fromContribution: 15_400,
        toContribution: 23_300,
        amount: 7_900,
        rate: 0,
        taxSaved: 0,
        cumulativeTaxSaved: 389,
        usedByPlan: 0,
        zeroReason: 'belowTaxThreshold',
      },
    ]);
  });

  it('minSavingRate 0: U = 15,400 -> SRS 15,300 + CPF self 100; tax after 0.00; saved 389.00 (2.53%)', () => {
    expect(usefulRoomOf({ ...input, preferences: { ...input.preferences, minSavingRate: 0 } })).toBe(15_400);
    expect(atAnySaving.plan).toMatchObject({
      contributions: { srs: 15_300, cpfSelf: 100, cpfFamily: 0 },
      totalContribution: 15_400,
      taxBefore: 389,
      taxAfter: 0,
      taxSaved: 389,
      chargeableIncomeAfter: 20_000,
      marginalRateAfter: 0,
      bindingConstraint: 'usefulRoom',
      unrealisedSaving: 0,
    });
    expect(atAnySaving.plan.savingRate).toBeCloseTo(389 / 15_400, 12);
    expect(Math.round(atAnySaving.plan.savingRate * 10_000) / 100).toBe(2.53);
    expect(atAnySaving.ladder.map((tier) => tier.usedByPlan)).toEqual([5_400, 10_000, 0]);
    expect(atAnySaving.warnings).toEqual([]);
  });

  it('minSavingRate 0: scenarios show the dollars wasted below the tax threshold', () => {
    const byId = Object.fromEntries(atAnySaving.scenarios.map((s) => [s.id, s]));
    // SRS only: chargeable income 20,100 -> 2% x 100 = 2.00
    expect(byId.srsOnly).toMatchObject({ totalContribution: 15_300, taxPayable: 2, taxSaved: 387, wastedContribution: 0 });
    // CPF self only: chargeable income 27,400 -> 2% x 7,400 = 148.00
    expect(byId.cpfSelfOnly).toMatchObject({ totalContribution: 8_000, taxPayable: 148, taxSaved: 241, wastedContribution: 0 });
    // both: 23,300 contributed, only 15,400 reduces tax -> 7,900 wasted
    expect(byId.srsPlusCpfSelf).toMatchObject({ totalContribution: 23_300, taxPayable: 0, taxSaved: 389, wastedContribution: 7_900 });
    expect(byId.maxAll).toMatchObject({ totalContribution: 23_300, taxPayable: 0, taxSaved: 389, wastedContribution: 7_900 });
    expect(byId.recommended).toMatchObject({ totalContribution: 15_400, taxPayable: 0, taxSaved: 389, wastedContribution: 0 });
  });

  it('minSavingRate 0: monthly plan splits 15,300 and 100 over November and December', () => {
    expect(atAnySaving.monthlyPlan.schedule).toEqual([
      { month: '2026-11', amounts: { srs: 7_650, cpfSelf: 50, cpfFamily: 0 }, total: 7_700 },
      { month: '2026-12', amounts: { srs: 7_650, cpfSelf: 50, cpfFamily: 0 }, total: 7_700 },
    ]);
  });
});
