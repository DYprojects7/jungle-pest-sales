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

  it('getRules accepts only a number that is a supported year (SPEC §7)', () => {
    // A lookup in a plain object would answer 'constructor' or '__proto__' with members of Object.prototype,
    // and '2026' with the 2026 rules although plan({ incomeYear: '2026' }) throws.
    for (const notAYear of ['2026', '2025', ' 2026', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', null, undefined, true, [2026], { valueOf: () => 2026 }]) {
      expect(() => getRules(notAYear as unknown as number), String(notAYear)).toThrow(RangeError);
    }
    expect(() => getRules('2026' as unknown as number)).toThrow(
      'The income year must be a number, not the string "2026". Supported: 2025, 2026, 2027.',
    );
    // Values that cannot even be turned into text still get the documented RangeError.
    for (const awkward of [Object.create(null), Symbol('2026'), { toString: () => { throw new Error('no'); } }, 2026n, () => 2026]) {
      expect(() => getRules(awkward as unknown as number)).toThrow(RangeError);
    }
    // getRules and plan agree on what an income year is.
    const input = defaultInput('2026-11-13');
    for (const incomeYear of ['2026', 'constructor', null, [2026]]) {
      expect(() => plan({ ...input, incomeYear } as unknown as PlannerInput)).toThrow(RangeError);
    }
  });

  it('the rule objects and the list of years are read-only, so no caller can change a later calculation (SPEC §7)', () => {
    const isDeeplyFrozen = (value: unknown): boolean =>
      typeof value !== 'object' || value === null || (Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen));
    for (const year of SUPPORTED_INCOME_YEARS) expect(isDeeplyFrozen(getRules(year)), String(year)).toBe(true);
    expect(Object.isFrozen(SUPPORTED_INCOME_YEARS)).toBe(true);

    const input = defaultInput('2026-11-13');
    const before = plan(input);
    expect(before.rules).toBe(getRules(2026));
    expect(isDeeplyFrozen(before.rules)).toBe(true);
    // Every attempt to edit the rules through a result (or through getRules) throws instead of taking effect.
    const rules = before.rules as unknown as {
      personalReliefCap: number;
      taxBrackets: { from: number; rate: number }[];
      srs: { capCitizenPr: number };
      cpf: { fullRates: { employeeRate: number }[] };
      reliefCatalog: unknown[];
    };
    expect(() => { rules.personalReliefCap = 0; }).toThrow(TypeError);
    expect(() => rules.taxBrackets.reverse()).toThrow(TypeError);
    expect(() => rules.taxBrackets.sort((a, b) => b.from - a.from)).toThrow(TypeError);
    expect(() => { rules.taxBrackets[4]!.rate = 0; }).toThrow(TypeError);
    expect(() => { rules.srs.capCitizenPr = 99_999; }).toThrow(TypeError);
    expect(() => { rules.cpf.fullRates[0]!.employeeRate = 0; }).toThrow(TypeError);
    expect(() => rules.reliefCatalog.push({})).toThrow(TypeError);
    expect(() => (SUPPORTED_INCOME_YEARS as number[]).push(2030)).toThrow(TypeError);
    expect(() => (SUPPORTED_INCOME_YEARS as number[]).reverse()).toThrow(TypeError);
    expect(SUPPORTED_INCOME_YEARS).toEqual([2025, 2026, 2027]);
    // ... and the next calculation, for every year, is what it was (Appendix A.1: saves 2,679.50).
    expect(plan(input)).toEqual(before);
    expect(plan(input).plan.taxSaved).toBe(2_679.5);
    // 2025: OW ceiling 7,400 -> 17,760 on wages + 20% x 13,200 of the bonus = 20,400 CPF, so the same 6,639.00.
    expect(plan({ ...input, incomeYear: 2025 }).baseline.taxPayable).toBe(6_639);
    expect(plan({ ...input, incomeYear: 2027 }).baseline.taxPayable).toBe(6_639);
    // A caller that wants different rules copies first; the copy is an ordinary object.
    const copy = { ...getRules(2026), personalReliefCap: 60_000 };
    expect(copy.personalReliefCap).toBe(60_000);
    expect(getRules(2026).personalReliefCap).toBe(80_000);
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
    // A year of the wrong type is named as what it is, not as "income year NaN".
    expect(() => plan({ ...input, incomeYear: '2026' } as unknown as PlannerInput)).toThrow(
      'The income year must be a number, not the string "2026". Supported: 2025, 2026, 2027.',
    );
    expect(() => evaluate({ ...input, incomeYear: null } as unknown as PlannerInput, nothing)).toThrow(
      'The income year must be a number, not null. Supported: 2025, 2026, 2027.',
    );
    expect(() => plan({} as PlannerInput)).toThrow('The income year must be a number, not undefined. Supported: 2025, 2026, 2027.');
    expect(() => plan(null as unknown as PlannerInput)).toThrow('The income year must be a number, not undefined.');
  });

  it('defaultIncomeYear: today\'s year when supported, otherwise the nearest supported year', () => {
    expect(defaultIncomeYear('2025-03-01')).toBe(2025);
    expect(defaultIncomeYear('2026-11-13')).toBe(2026);
    expect(defaultIncomeYear('2027-12-31')).toBe(2027);
    expect(defaultIncomeYear('2019-06-01')).toBe(2025);
    expect(defaultIncomeYear('2024-12-31')).toBe(2025);
    expect(defaultIncomeYear('2028-01-01')).toBe(2027);
    expect(defaultIncomeYear('2040-01-01')).toBe(2027);
    expect(defaultIncomeYear('2027-06-30T23:59:59+08:00')).toBe(2027);
  });

  it('defaultIncomeYear: an unparseable date gives the latest year with final rules, never a projected one (SPEC §7)', () => {
    // Before the SPEC settled this, '' / null gave 2025 (the back-testing year) and other garbage gave 2027
    // (the PROJECTED year). 2026 is the latest supported year whose rules are final.
    expect(getRules(2026).status).toBe('final');
    expect(getRules(2027).status).toBe('projected');
    for (const unreadable of ['', 'garbage', 'soon', '13/11/2026', ' 2025-01-01', '2025', '2027', '2027-1-5', '2025-02-30', '2027-13-01', '2027-06-301', null, undefined, 2027, {}]) {
      expect(defaultIncomeYear(unreadable as unknown as string), String(unreadable)).toBe(2026);
      const input = defaultInput(unreadable as unknown as string);
      expect(input.incomeYear, String(unreadable)).toBe(2026);
      // §6.0: the unreadable date is then planned as 1 January of that year — the Appendix A.1 plan.
      const result = plan(input);
      expect(result.input.today).toBe('2026-01-01');
      expect(result.plan).toMatchObject({ totalContribution: 23_300, taxSaved: 2_679.5 });
      expect(result.warnings.map((w) => w.code)).not.toContain('PROJECTED_RULES');
    }
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
