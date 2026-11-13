/**
 * SPEC §6.0 — input sanitising and defaulting, and plan() never throwing for a sanitisable input.
 */
import { describe, expect, it } from 'vitest';
import { defaultInput, evaluate, plan, sanitiseInput } from '../../src/engine';
import type { PlannerInput, PlannerResult } from '../../src/engine';

const base = defaultInput('2026-11-13');

/** Deliberately ill-typed input: the engine must cope with whatever a form or stored state hands it. */
function loose(value: unknown): PlannerInput {
  return value as PlannerInput;
}

/** Every number anywhere inside a value. */
function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(numbersIn);
  return [];
}

/** The parts of a result that the engine computes (the rules are static data). */
function computed(result: PlannerResult): unknown {
  const { rules: _rules, ...rest } = result;
  return rest;
}

describe('sanitiseInput — money', () => {
  const garbage: PlannerInput = loose({
    ...base,
    income: {
      monthlyOrdinaryWage: Number.NaN,
      additionalWages: -500,
      otherTaxableIncome: Number.POSITIVE_INFINITY,
      employmentExpenses: 1_234.99,
      donations: '100',
    },
    existing: { srs: Number.NEGATIVE_INFINITY, cpfTopUpSelf: 99.5, cpfTopUpFamily: null },
    otherReliefs: -0.01,
  });
  const clean = sanitiseInput(garbage);

  it('not finite or negative -> 0', () => {
    expect(clean.income.monthlyOrdinaryWage).toBe(0);
    expect(clean.income.additionalWages).toBe(0);
    expect(clean.income.otherTaxableIncome).toBe(0);
    expect(clean.existing.srs).toBe(0);
    expect(clean.otherReliefs).toBe(0);
  });

  it('fractions are rounded down', () => {
    expect(clean.income.employmentExpenses).toBe(1_234);
    expect(clean.existing.cpfTopUpSelf).toBe(99);
  });

  it('values that are not numbers count as not finite', () => {
    expect(clean.income.donations).toBe(0);
    expect(clean.existing.cpfTopUpFamily).toBe(0);
  });

  it('whole non-negative amounts pass through unchanged', () => {
    const same = sanitiseInput(base);
    expect(same.income.monthlyOrdinaryWage).toBe(10_000);
    expect(same.income.additionalWages).toBe(15_000);
    expect(same.otherReliefs).toBe(5_000);
    expect(sanitiseInput({ ...base, otherReliefs: 0 }).otherReliefs).toBe(0);
  });

  it('absurdly large amounts are held at S$10 billion so the arithmetic stays exact', () => {
    const huge = sanitiseInput({ ...base, income: { ...base.income, monthlyOrdinaryWage: 1e300, additionalWages: 1e15 } });
    expect(huge.income.monthlyOrdinaryWage).toBe(10_000_000_000);
    expect(huge.income.additionalWages).toBe(10_000_000_000);
    expect(sanitiseInput({ ...base, otherReliefs: 9_999_999_999 }).otherReliefs).toBe(9_999_999_999);
  });
});

describe('sanitiseInput — optional fields and limits', () => {
  it('fills in the defaults when optional fields are missing', () => {
    const minimal: PlannerInput = {
      incomeYear: 2026,
      today: '2026-11-13',
      profile: { residency: 'pr', ageAtYearEnd: 40 },
      income: { monthlyOrdinaryWage: 5_000, additionalWages: 0 },
      existing: { srs: 0, cpfTopUpSelf: 0, cpfTopUpFamily: 0 },
      otherReliefs: 0,
      levers: { srs: { enabled: true }, cpfSelf: { enabled: true }, cpfFamily: { enabled: false } },
      preferences: { minSavingRate: 0.07, priority: ['srs', 'cpfSelf', 'cpfFamily'] },
    };
    expect(sanitiseInput(minimal)).toEqual({
      incomeYear: 2026,
      today: '2026-11-13',
      profile: { residency: 'pr', prYear: 3, ageAtYearEnd: 40, birthMonth: 12 },
      income: {
        monthlyOrdinaryWage: 5_000,
        monthsWorked: 12,
        additionalWages: 0,
        otherTaxableIncome: 0,
        employmentExpenses: 0,
        donations: 0,
        employeeCpfOverride: null,
      },
      existing: { srs: 0, cpfTopUpSelf: 0, cpfTopUpFamily: 0 },
      otherReliefs: 0,
      levers: {
        srs: { enabled: true },
        cpfSelf: { enabled: true, roomToLimit: null },
        cpfFamily: { enabled: false, maxAmount: null },
      },
      preferences: { cashBudget: null, minSavingRate: 0.07, priority: ['srs', 'cpfSelf', 'cpfFamily'], simulatorStep: 1_000 },
    });
  });

  it('a limit applies only when it is a number: numbers are sanitised like money, anything else is "no limit"', () => {
    const limits = (cashBudget: unknown, roomToLimit: unknown, maxAmount: unknown, employeeCpfOverride: unknown) => {
      const clean = sanitiseInput(
        loose({
          ...base,
          income: { ...base.income, employeeCpfOverride },
          levers: { srs: { enabled: true }, cpfSelf: { enabled: true, roomToLimit }, cpfFamily: { enabled: true, maxAmount } },
          preferences: { ...base.preferences, cashBudget },
        }),
      );
      return [
        clean.preferences.cashBudget,
        clean.levers.cpfSelf.roomToLimit,
        clean.levers.cpfFamily.maxAmount,
        clean.income.employeeCpfOverride,
      ];
    };
    expect(limits(null, null, null, null)).toEqual([null, null, null, null]);
    expect(limits(undefined, undefined, undefined, undefined)).toEqual([null, null, null, null]);
    expect(limits(5_000, 2_500.9, 0, 18_000.5)).toEqual([5_000, 2_500, 0, 18_000]);
    expect(limits(-1, Number.NaN, Number.POSITIVE_INFINITY, -20)).toEqual([0, 0, 0, 0]);
    expect(limits('5000', 'none', {}, true)).toEqual([null, null, null, null]);
  });

  it('enabled flags are true only for a real true', () => {
    const clean = sanitiseInput(
      loose({ ...base, levers: { srs: { enabled: 'yes' }, cpfSelf: { enabled: 1 }, cpfFamily: { enabled: true } } }),
    );
    expect(clean.levers.srs.enabled).toBe(false);
    expect(clean.levers.cpfSelf.enabled).toBe(false);
    expect(clean.levers.cpfFamily.enabled).toBe(true);
  });
});

describe('sanitiseInput — profile', () => {
  const profile = (overrides: Record<string, unknown>) =>
    sanitiseInput(loose({ ...base, profile: { ...base.profile, ...overrides } })).profile;

  it.each([
    [35, 35],
    [35.9, 35],
    [0, 0],
    [-5, 0],
    [120, 120],
    [121, 120],
    [1_000, 120],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [undefined, 0],
    ['35', 0],
  ])('ageAtYearEnd %s -> %i (clamped to 0…120)', (given, expected) => {
    expect(profile({ ageAtYearEnd: given }).ageAtYearEnd).toBe(expected);
  });

  it.each([
    [1, 1],
    [6, 6],
    [12, 12],
    [0, 1],
    [-3, 1],
    [13, 12],
    [99, 12],
    [6.9, 6],
    [Number.NaN, 1], // a number that is not finite is 0 before clamping
    [Number.POSITIVE_INFINITY, 1],
    [undefined, 12],
    [null, 12],
    ['6', 12],
  ])('birthMonth %s -> %i (clamped to 1…12, default 12)', (given, expected) => {
    expect(profile({ birthMonth: given }).birthMonth).toBe(expected);
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [undefined, 3],
    [0, 3],
    [4, 3],
    [1.5, 3],
    ['1', 3],
  ])('prYear %s -> %i (default 3)', (given, expected) => {
    expect(profile({ prYear: given }).prYear).toBe(expected);
  });

  it('an unknown residency is treated as citizen', () => {
    expect(profile({ residency: 'pr' }).residency).toBe('pr');
    expect(profile({ residency: 'foreigner' }).residency).toBe('foreigner');
    expect(profile({ residency: 'citizen' }).residency).toBe('citizen');
    expect(profile({ residency: 'tourist' }).residency).toBe('citizen');
    expect(profile({ residency: undefined }).residency).toBe('citizen');
  });
});

describe('sanitiseInput — months worked', () => {
  it.each([
    [12, 12],
    [1, 1],
    [7, 7],
    [0, 1],
    [-2, 1],
    [13, 12],
    [6.9, 6],
    [0.5, 1],
    [Number.NaN, 1], // a number that is not finite is 0 before clamping
    [undefined, 12],
    [null, 12],
    ['7', 12],
  ])('monthsWorked %s -> %i (clamped to 1…12, default 12)', (given, expected) => {
    const clean = sanitiseInput(loose({ ...base, income: { ...base.income, monthsWorked: given } }));
    expect(clean.income.monthsWorked).toBe(expected);
  });
});

describe('sanitiseInput — preferences', () => {
  const preferences = (overrides: Record<string, unknown>) =>
    sanitiseInput(loose({ ...base, preferences: { ...base.preferences, ...overrides } })).preferences;

  it.each([
    [0.07, 0.07],
    [0, 0],
    [1, 1],
    [-0.5, 0],
    [1.5, 1],
    [7, 1],
    [Number.POSITIVE_INFINITY, 1],
    [Number.NEGATIVE_INFINITY, 0],
    [Number.NaN, 0],
    [undefined, 0],
    ['0.07', 0],
  ])('minSavingRate %s -> %f (clamped to 0…1)', (given, expected) => {
    expect(preferences({ minSavingRate: given }).minSavingRate).toBe(expected);
  });

  it.each([
    [undefined, 1_000],
    [null, 1_000],
    ['500', 1_000],
    [Number.NaN, 100], // a number that is not finite is 0, then raised to the minimum
    [1_000, 1_000],
    [500, 500],
    [100, 100],
    [99, 100],
    [0, 100],
    [-250, 100],
    [250.7, 250],
    [5_000, 5_000],
  ])('simulatorStep %s -> %i (default 1,000, minimum 100)', (given, expected) => {
    expect(preferences({ simulatorStep: given }).simulatorStep).toBe(expected);
  });

  it.each([
    [['srs', 'cpfSelf', 'cpfFamily'], ['srs', 'cpfSelf', 'cpfFamily']],
    [['cpfFamily', 'srs', 'cpfSelf'], ['cpfFamily', 'srs', 'cpfSelf']],
    [['cpfSelf'], ['cpfSelf', 'srs', 'cpfFamily']], // missing levers appended in canonical order
    [['cpfFamily', 'cpfSelf'], ['cpfFamily', 'cpfSelf', 'srs']],
    [['cpfFamily', 'cpfFamily', 'bogus', 'srs'], ['cpfFamily', 'srs', 'cpfSelf']], // duplicates and unknowns dropped
    [['srs', 'srs', 'srs'], ['srs', 'cpfSelf', 'cpfFamily']],
    [[], ['srs', 'cpfSelf', 'cpfFamily']],
    [[1, null, {}], ['srs', 'cpfSelf', 'cpfFamily']],
    [undefined, ['srs', 'cpfSelf', 'cpfFamily']],
    ['cpfSelf', ['srs', 'cpfSelf', 'cpfFamily']],
  ])('priority %j -> %j', (given, expected) => {
    expect(preferences({ priority: given }).priority).toEqual(expected);
  });
});

describe('sanitiseInput — today and incomeYear', () => {
  it('keeps a valid date, drops a time suffix, and falls back to 1 January of the income year', () => {
    expect(sanitiseInput({ ...base, today: '2026-03-09' }).today).toBe('2026-03-09');
    expect(sanitiseInput({ ...base, today: '2026-03-09T12:00:00Z' }).today).toBe('2026-03-09');
    expect(sanitiseInput({ ...base, today: 'not a date' }).today).toBe('2026-01-01');
    expect(sanitiseInput(loose({ ...base, today: undefined })).today).toBe('2026-01-01');
    expect(sanitiseInput(loose({ ...base, today: 20261113 })).today).toBe('2026-01-01');
    expect(sanitiseInput({ ...base, incomeYear: 2025, today: '2025-02-29' }).today).toBe('2025-01-01');
  });

  it('leaves the income year for getRules to accept or reject', () => {
    expect(sanitiseInput({ ...base, incomeYear: 2031 }).incomeYear).toBe(2031);
    expect(sanitiseInput(loose({ ...base, incomeYear: '2026' })).incomeYear).toBeNaN();
  });
});

describe('sanitiseInput — general', () => {
  it('is idempotent', () => {
    const once = sanitiseInput(base);
    expect(sanitiseInput(once)).toEqual(once);
    const messy = sanitiseInput(loose({ incomeYear: 2026, profile: { ageAtYearEnd: 44.4 }, preferences: { priority: ['cpfSelf'] } }));
    expect(sanitiseInput(messy)).toEqual(messy);
  });

  it('does not modify the object it is given', () => {
    const original = defaultInput('2026-11-13');
    original.preferences.priority = ['cpfSelf'];
    original.income.monthlyOrdinaryWage = 10_000.75;
    const snapshot = JSON.stringify(original);
    const clean = sanitiseInput(original);
    plan(original);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(clean.preferences.priority).not.toBe(original.preferences.priority);
  });

  it('never throws, whatever it is given', () => {
    for (const value of [undefined, null, 42, 'input', [], {}, { profile: null, income: 7, levers: 'all', preferences: [] }]) {
      expect(() => sanitiseInput(loose(value))).not.toThrow();
    }
  });

  it('plan() reports the sanitised input it actually used', () => {
    const result = plan(loose({ ...base, income: { monthlyOrdinaryWage: 10_000.99, additionalWages: 15_000 } }));
    expect(result.input).toEqual(sanitiseInput(base));
  });
});

describe('plan() never throws for a sanitisable input', () => {
  const sections = {
    profile: [undefined, null, {}, { residency: 'martian', ageAtYearEnd: Number.NaN, birthMonth: 40, prYear: 9 }, 'x'],
    income: [undefined, null, {}, { monthlyOrdinaryWage: -1, additionalWages: Number.NaN, monthsWorked: 0, employeeCpfOverride: Number.NaN }, 5],
    existing: [undefined, null, {}, { srs: Number.POSITIVE_INFINITY, cpfTopUpSelf: -1, cpfTopUpFamily: 'lots' }],
    levers: [undefined, null, {}, { srs: null, cpfSelf: { enabled: true, roomToLimit: Number.NaN }, cpfFamily: { enabled: true, maxAmount: -5 } }],
    preferences: [undefined, null, {}, { cashBudget: Number.NaN, minSavingRate: 'high', priority: 'srs', simulatorStep: -1 }],
  };

  it('garbage in any section still produces a complete, finite result', () => {
    let runs = 0;
    for (const [section, values] of Object.entries(sections)) {
      for (const value of values) {
        const result = plan(loose({ ...base, [section]: value }));
        runs += 1;
        expect(numbersIn(computed(result)).every(Number.isFinite)).toBe(true);
        expect(result.plan.totalContribution).toBeGreaterThanOrEqual(0);
        expect(result.plan.taxAfter).toBeLessThanOrEqual(result.plan.taxBefore);
        expect(result.scenarios).toHaveLength(6);
        expect(result.simulator.length).toBeGreaterThanOrEqual(1);
      }
    }
    expect(runs).toBe(22);
  });

  it('everything garbage except the income year', () => {
    const result = plan(loose({ incomeYear: 2026 }));
    expect(result.input.today).toBe('2026-01-01');
    expect(result.baseline.taxPayable).toBe(0);
    expect(result.plan.totalContribution).toBe(0);
    expect(result.plan.bindingConstraint).toBe('none');
    expect(result.ladder).toEqual([]); // nothing is enabled
    expect(result.warnings.map((w) => w.code)).toEqual(['NO_TAX_PAYABLE', 'SRS_UNDER_18']); // age defaults to 0
  });

  it('negative and NaN amounts behave as zero', () => {
    const result = plan(
      loose({
        ...base,
        income: { monthlyOrdinaryWage: 10_000, additionalWages: -15_000, donations: Number.NaN },
        existing: { srs: -100, cpfTopUpSelf: Number.NaN, cpfTopUpFamily: 0 },
        otherReliefs: -5_000,
      }),
    );
    // 120,000 income; CPF 19,200; EIR 1,000 -> chargeable income 99,800 -> 3,350 + 11.5% x 19,800 = 5,627
    expect(result.baseline.chargeableIncome).toBe(99_800);
    expect(result.baseline.taxPayable).toBe(5_627);
    expect(result.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 });
  });

  it('a NaN budget or limit is a limit of zero, not "no limit"', () => {
    const budget = plan(loose({ ...base, preferences: { ...base.preferences, cashBudget: Number.NaN } }));
    expect(budget.plan.totalContribution).toBe(0);
    expect(budget.plan.bindingConstraint).toBe('cashBudget');
    const room = plan(loose({ ...base, levers: { ...base.levers, cpfSelf: { enabled: true, roomToLimit: Number.NaN } } }));
    expect(room.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 0 });
  });

  it('a priority list that is not a permutation is repaired, not rejected', () => {
    const result = plan(loose({ ...base, preferences: { ...base.preferences, cashBudget: 9_000, priority: ['cpfSelf', 'cpfSelf'] } }));
    expect(result.input.preferences.priority).toEqual(['cpfSelf', 'srs', 'cpfFamily']);
    expect(result.plan.contributions).toEqual({ cpfSelf: 8_000, srs: 1_000, cpfFamily: 0 });
  });

  it('astronomically large inputs stay finite and exact', () => {
    const result = plan(
      loose({
        ...base,
        income: { monthlyOrdinaryWage: 1e308, additionalWages: 1e308, otherTaxableIncome: 1e308, donations: 3 },
        otherReliefs: 1e308,
      }),
    );
    expect(numbersIn(computed(result)).every(Number.isFinite)).toBe(true);
    // 12 x 10bn + 10bn + 10bn = 140bn, less 7.50 of donation deduction, less 80,000 of reliefs
    expect(result.baseline.totalIncome).toBe(140_000_000_000);
    expect(result.baseline.assessableIncome).toBe(139_999_999_992.5);
    expect(result.baseline.chargeableIncome).toBe(139_999_919_992);
    // 199,150 + 24% x 139,998,919,992 = 199,150 + 33,599,740,798.08
    expect(result.baseline.taxPayable).toBe(33_599_939_948.08);
    expect(result.plan.totalContribution).toBe(0); // reliefs are already over the cap
  });

  it('evaluate() tolerates a missing or malformed contributions object', () => {
    const none = evaluate(base, { srs: 0, cpfSelf: 0, cpfFamily: 0 });
    expect(evaluate(base, undefined as never)).toEqual(none);
    expect(evaluate(base, null as never)).toEqual(none);
    expect(evaluate(base, { srs: 'all' } as never)).toEqual(none);
  });
});
