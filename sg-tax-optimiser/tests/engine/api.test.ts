/**
 * SPEC §7 — the public API: exactly the documented exports, the supported income years, the default input,
 * unsupported years, purity, and the three income years side by side.
 */
import { describe, expect, it } from 'vitest';
import * as engine from '../../src/engine';
import {
  SUPPORTED_INCOME_YEARS,
  computeCpf,
  defaultIncomeYear,
  defaultInput,
  evaluate,
  getRules,
  grossTax,
  marginalRate,
  plan,
  sanitiseInput,
} from '../../src/engine';
import type { PlannerInput } from '../../src/engine';

describe('exports', () => {
  it('index.ts exports exactly the SPEC §7 API', () => {
    expect(Object.keys(engine).sort()).toEqual([
      'SUPPORTED_INCOME_YEARS',
      'computeCpf',
      'defaultIncomeYear',
      'defaultInput',
      'evaluate',
      'getRules',
      'grossTax',
      'marginalRate',
      'plan',
      'sanitiseInput',
    ]);
  });

  it('every function is callable with the documented signature', () => {
    const input = defaultInput('2026-11-13');
    const rules = getRules(2026);
    expect(plan(input).plan.taxSaved).toBe(2_679.5);
    expect(evaluate(input, { srs: 0, cpfSelf: 0, cpfFamily: 0 }).taxPayable).toBe(6_639);
    expect(computeCpf(input, rules).employeeContribution).toBe(20_400);
    expect(grossTax(108_600, rules)).toBe(6_639);
    expect(marginalRate(108_600, rules)).toBe(0.115);
    expect(sanitiseInput(input).income.monthsWorked).toBe(12);
    expect(defaultIncomeYear('2026-11-13')).toBe(2026);
  });
});

describe('income years', () => {
  it('2025, 2026 and 2027 are supported', () => {
    expect(SUPPORTED_INCOME_YEARS).toEqual([2025, 2026, 2027]);
    expect(getRules(2025)).toMatchObject({ incomeYear: 2025, ya: 2026, status: 'final' });
    expect(getRules(2026)).toMatchObject({ incomeYear: 2026, ya: 2027, status: 'final' });
    expect(getRules(2027)).toMatchObject({ incomeYear: 2027, ya: 2028, status: 'projected' });
  });

  it('getRules throws a RangeError for any other year', () => {
    for (const year of [2024, 2028, 0, -2026, 2026.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => getRules(year)).toThrow(RangeError);
    }
  });

  it('plan and evaluate throw the same RangeError for an unsupported income year', () => {
    const input = defaultInput('2026-11-13');
    const nothing = { srs: 0, cpfSelf: 0, cpfFamily: 0 };
    for (const incomeYear of [2024, 2028, 2026.5, Number.NaN]) {
      expect(() => plan({ ...input, incomeYear })).toThrow(RangeError);
      expect(() => evaluate({ ...input, incomeYear }, nothing)).toThrow(RangeError);
    }
    expect(() => plan({ ...input, incomeYear: 2024 })).toThrow('No rules for income year 2024. Supported: 2025, 2026, 2027.');
    expect(() => plan({ ...input, incomeYear: '2026' } as unknown as PlannerInput)).toThrow(RangeError);
    expect(() => plan({} as PlannerInput)).toThrow(RangeError);
    expect(() => plan(undefined as unknown as PlannerInput)).toThrow(RangeError);
  });

  it('defaultIncomeYear: today\'s year when supported, otherwise the nearest supported year', () => {
    expect(defaultIncomeYear('2025-03-01')).toBe(2025);
    expect(defaultIncomeYear('2026-11-13')).toBe(2026);
    expect(defaultIncomeYear('2027-12-31')).toBe(2027);
    expect(defaultIncomeYear('2019-06-01')).toBe(2025);
    expect(defaultIncomeYear('2024-12-31')).toBe(2025);
    expect(defaultIncomeYear('2028-01-01')).toBe(2027);
    expect(defaultIncomeYear('2040-01-01')).toBe(2027);
  });
});

describe('defaultInput', () => {
  it('is the opening example of SPEC §7 / Appendix A.1', () => {
    expect(defaultInput('2026-11-13')).toEqual({
      incomeYear: 2026,
      today: '2026-11-13',
      profile: { residency: 'citizen', prYear: 3, ageAtYearEnd: 35, birthMonth: 12 },
      income: {
        monthlyOrdinaryWage: 10_000,
        monthsWorked: 12,
        additionalWages: 15_000,
        otherTaxableIncome: 0,
        employmentExpenses: 0,
        donations: 0,
        employeeCpfOverride: null,
      },
      existing: { srs: 0, cpfTopUpSelf: 0, cpfTopUpFamily: 0 },
      otherReliefs: 5_000,
      levers: {
        srs: { enabled: true },
        cpfSelf: { enabled: true, roomToLimit: null },
        cpfFamily: { enabled: false, maxAmount: null },
      },
      preferences: { cashBudget: null, minSavingRate: 0.07, priority: ['srs', 'cpfSelf', 'cpfFamily'], simulatorStep: 1_000 },
    });
  });

  it('is already sanitised', () => {
    const input = defaultInput('2026-11-13');
    expect(sanitiseInput(input)).toEqual(input);
  });

  it('picks the income year from today', () => {
    expect(defaultInput('2025-07-01').incomeYear).toBe(2025);
    expect(defaultInput('2027-02-01').incomeYear).toBe(2027);
    expect(defaultInput('2030-02-01').incomeYear).toBe(2027);
    expect(defaultInput('2021-02-01').incomeYear).toBe(2025);
  });

  it('returns a fresh object each time', () => {
    const first = defaultInput('2026-11-13');
    first.preferences.priority.reverse();
    first.income.monthlyOrdinaryWage = 1;
    expect(defaultInput('2026-11-13').preferences.priority).toEqual(['srs', 'cpfSelf', 'cpfFamily']);
    expect(defaultInput('2026-11-13').income.monthlyOrdinaryWage).toBe(10_000);
  });

  it('always yields a plannable input, even from a bad date', () => {
    for (const today of ['', 'soon', undefined as unknown as string]) {
      expect(() => plan(defaultInput(today))).not.toThrow();
    }
  });
});

describe('the opening example in all three income years', () => {
  it('2025: lower OW ceiling, same CPF relief and the same plan', () => {
    const result = plan({ ...defaultInput('2025-11-13'), incomeYear: 2025 });
    expect(result.rules.ya).toBe(2026);
    expect(result.cpf).toMatchObject({
      ordinaryWagesSubject: 88_800, // 7,400 x 12
      additionalWageCeiling: 13_200,
      additionalWagesSubject: 13_200,
      employeeContribution: 20_400, // 1,480 x 12 + 2,640
      employerContribution: 17_340, // 17% x 102,000
    });
    expect(result.baseline.chargeableIncome).toBe(108_600);
    expect(result.baseline.taxPayable).toBe(6_639);
    expect(result.plan).toMatchObject({
      contributions: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 },
      taxAfter: 3_959.5,
      taxSaved: 2_679.5,
      bindingConstraint: 'leverLimits',
    });
    expect(result.monthlyPlan).toMatchObject({ deadline: '2025-12-31', daysToDeadline: 48, monthsRemaining: 2 });
    expect(result.warnings.map((w) => w.code)).toEqual(['LEVER_LIMITS_PLAN']);
  });

  it('2026: Appendix A.1', () => {
    const result = plan(defaultInput('2026-11-13'));
    expect(result.rules.ya).toBe(2027);
    expect(result.plan.taxSaved).toBe(2_679.5);
    expect(result.warnings.map((w) => w.code)).toEqual(['LEVER_LIMITS_PLAN']);
  });

  it('2027: same numbers, flagged as projected', () => {
    const result = plan(defaultInput('2027-11-13'));
    expect(result.input.incomeYear).toBe(2027);
    expect(result.rules.status).toBe('projected');
    expect(result.cpf.employeeContribution).toBe(20_400);
    expect(result.plan.taxSaved).toBe(2_679.5);
    expect(result.monthlyPlan.deadline).toBe('2027-12-31');
    expect(result.warnings.map((w) => w.code)).toEqual(['LEVER_LIMITS_PLAN', 'PROJECTED_RULES']);
  });
});

describe('an older worker in all three income years', () => {
  // Citizen, 58 all year (above 55 to 60), S$8,000 x 12, no bonus, no other reliefs, minSavingRate 0.07.
  const older = (incomeYear: number): PlannerInput => {
    const base = defaultInput(`${incomeYear}-06-30`);
    return {
      ...base,
      profile: { ...base.profile, ageAtYearEnd: 58 },
      income: { ...base.income, monthlyOrdinaryWage: 8_000, additionalWages: 0 },
      otherReliefs: 0,
    };
  };

  it('2025: employee 17% of 7,400', () => {
    const result = plan(older(2025));
    expect(result.cpf.employeeContribution).toBe(15_096); // 1,258 x 12
    // reliefs 6,000 + 15,096 = 21,096 -> chargeable income 74,904 -> 550 + 7% x 34,904 = 2,993.28
    expect(result.baseline.chargeableIncome).toBe(74_904);
    expect(result.baseline.taxPayable).toBe(2_993.28);
    // X = 23,300 -> chargeable income 51,604 -> 550 + 7% x 11,604 = 1,362.28
    expect(result.plan.taxAfter).toBe(1_362.28);
    expect(result.plan.taxSaved).toBe(1_631); // 23,300 x 7%
  });

  it('2026: employee 18% of 8,000', () => {
    const result = plan(older(2026));
    expect(result.cpf.employeeContribution).toBe(17_280); // 1,440 x 12
    // reliefs 23,280 -> chargeable income 72,720 -> 550 + 7% x 32,720 = 2,840.40
    expect(result.baseline.chargeableIncome).toBe(72_720);
    expect(result.baseline.taxPayable).toBe(2_840.4);
    expect(result.plan.taxAfter).toBe(1_209.4);
    expect(result.plan.taxSaved).toBe(1_631);
  });

  it('2027: employee 19% of 8,000', () => {
    const result = plan(older(2027));
    expect(result.cpf.employeeContribution).toBe(18_240); // 1,520 x 12
    // reliefs 24,240 -> chargeable income 71,760 -> 550 + 7% x 31,760 = 2,773.20
    expect(result.baseline.chargeableIncome).toBe(71_760);
    expect(result.baseline.taxPayable).toBe(2_773.2);
    expect(result.plan.taxAfter).toBe(1_142.2);
    expect(result.plan.taxSaved).toBe(1_631);
  });
});

describe('purity and speed', () => {
  it('the same input always gives an equal, independent result', () => {
    const input = defaultInput('2026-11-13');
    const first = plan(input);
    const second = plan(input);
    expect(second).toEqual(first);
    expect(second.plan).not.toBe(first.plan);
    first.plan.contributions.srs = 0;
    first.input.preferences.priority.reverse();
    expect(plan(input)).toEqual(second);
  });

  it('results survive a JSON round trip (plain data only)', () => {
    const result = plan(defaultInput('2026-11-13'));
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('plan() takes well under 5 ms, even with the finest simulator step', () => {
    const base = defaultInput('2026-11-13');
    const heavy: PlannerInput = {
      ...base,
      profile: { ...base.profile, residency: 'foreigner' },
      preferences: { ...base.preferences, minSavingRate: 0, simulatorStep: 100 },
    };
    plan(heavy); // warm up
    const runs = 200;
    const start = performance.now();
    for (let i = 0; i < runs; i++) plan(heavy);
    const perCall = (performance.now() - start) / runs;
    expect(plan(heavy).simulator).toHaveLength(358); // 35,700 / 100 + 1
    expect(perCall).toBeLessThan(5);
  });
});
