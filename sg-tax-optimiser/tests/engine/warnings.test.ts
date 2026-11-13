/**
 * SPEC §6.11 — every warning code: when it fires, when it does not, its severity, message and params.
 */
import { describe, expect, it } from 'vitest';
import { defaultInput, getRules, plan } from '../../src/engine';
import type { PlannerInput, PlannerResult, PlannerWarning, WarningCode } from '../../src/engine';
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

/** The opening example (2026, seen on 30 June 2026) with some fields replaced. */
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

const codes = (result: PlannerResult): WarningCode[] => result.warnings.map((w) => w.code);

function warning(result: PlannerResult, code: WarningCode): PlannerWarning {
  const found = result.warnings.find((w) => w.code === code);
  if (!found) throw new Error(`expected warning ${code}, got [${codes(result).join(', ')}]`);
  return found;
}

/** SPEC §6.11 table: code -> severity. */
const SEVERITY: Record<WarningCode, PlannerWarning['severity']> = {
  NO_TAX_PAYABLE: 'info',
  RELIEF_CAP_EXCEEDED_BASELINE: 'caution',
  RELIEF_CAP_LIMITS_PLAN: 'caution',
  BELOW_MIN_SAVING_RATE: 'info',
  BUDGET_LIMITS_PLAN: 'info',
  LEVER_LIMITS_PLAN: 'info',
  EXISTING_EXCEEDS_CAP: 'caution',
  CPF_OVERRIDE_ABOVE_MAX: 'caution',
  FOREIGNER_NO_CPF: 'info',
  PR_GRADUATED_RATES: 'info',
  AGE_55_PLUS_TOPUP: 'info',
  SRS_UNDER_18: 'caution',
  DEADLINE_PASSED: 'blocker',
  DEADLINE_SOON: 'caution',
  PROJECTED_RULES: 'caution',
  PIT_REBATE_APPLIED: 'info',
};

const LOW_INCOME = { income: { monthlyOrdinaryWage: 3_500, additionalWages: 3_500 }, otherReliefs: 0 };

describe('NO_TAX_PAYABLE', () => {
  it('fires when the baseline tax is zero', () => {
    const result = plan(input({ income: { monthlyOrdinaryWage: 1_500, additionalWages: 0 }, otherReliefs: 0 }));
    const w = warning(result, 'NO_TAX_PAYABLE');
    expect(w.severity).toBe('info');
    expect(w.params).toEqual({ ya: 2027, chargeableIncome: 13_400 });
    expect(w.message).toBe(
      'Your estimated tax for YA2027 is already S$0, so extra SRS or CPF contributions would not save any tax this year.',
    );
    expect(codes(result)).not.toContain('BELOW_MIN_SAVING_RATE');
  });

  it('does not fire when any tax is payable', () => {
    expect(codes(plan(input()))).not.toContain('NO_TAX_PAYABLE');
  });
});

describe('RELIEF_CAP_EXCEEDED_BASELINE', () => {
  it('fires when reliefs are already above S$80,000', () => {
    const w = warning(plan(input({ otherReliefs: 70_000 })), 'RELIEF_CAP_EXCEEDED_BASELINE');
    expect(w.severity).toBe('caution');
    expect(w.params).toEqual({ totalBeforeCap: 91_400, personalReliefCap: 80_000, lostToCap: 11_400 });
    expect(w.message).toContain('S$91,400');
    expect(w.message).toContain('S$80,000');
    expect(w.message).toContain('S$11,400');
  });

  it('does not fire at exactly the cap', () => {
    // 1,000 + 20,400 + 58,600 = 80,000
    const result = plan(input({ otherReliefs: 58_600 }));
    expect(result.baseline.reliefs.lostToCap).toBe(0);
    expect(codes(result)).not.toContain('RELIEF_CAP_EXCEEDED_BASELINE');
    expect(codes(result)).toContain('RELIEF_CAP_LIMITS_PLAN'); // the cap still stops the plan at zero
  });
});

describe('RELIEF_CAP_LIMITS_PLAN', () => {
  it('fires when the relief cap is the binding constraint', () => {
    const w = warning(plan(input({ otherReliefs: 40_000 })), 'RELIEF_CAP_LIMITS_PLAN');
    expect(w.severity).toBe('caution');
    expect(w.params).toEqual({ personalReliefCap: 80_000, reliefCapRoom: 18_600, totalContribution: 18_600 });
    expect(w.message).toBe(
      'The plan stops at S$18,600 because that brings your total reliefs to the S$80,000 overall cap. ' +
        'Anything you contribute beyond that earns no tax relief and cannot be refunded.',
    );
  });

  it('has its own wording when the cap leaves no room at all', () => {
    const w = warning(plan(input({ otherReliefs: 70_000 })), 'RELIEF_CAP_LIMITS_PLAN');
    expect(w.params).toEqual({ personalReliefCap: 80_000, reliefCapRoom: 0, totalContribution: 0 });
    expect(w.message).toContain('already reached the S$80,000 overall cap');
  });

  it('does not fire when something else binds', () => {
    expect(codes(plan(input()))).not.toContain('RELIEF_CAP_LIMITS_PLAN');
  });
});

describe('BELOW_MIN_SAVING_RATE', () => {
  it('fires when tax is payable but no dollar saves the minimum rate', () => {
    const result = plan(input(LOW_INCOME));
    const w = warning(result, 'BELOW_MIN_SAVING_RATE');
    expect(w.severity).toBe('info');
    expect(w.params).toEqual({ marginalRate: 0.035, minSavingRate: 0.07 });
    expect(w.message).toBe(
      'Every extra dollar you contribute would save at most 3.5% in tax, below the 7% minimum you set, ' +
        'so nothing is recommended. Lower the minimum to see these smaller savings.',
    );
  });

  it('does not fire once the minimum is lowered', () => {
    expect(codes(plan(input({ ...LOW_INCOME, preferences: { minSavingRate: 0.035 } })))).not.toContain('BELOW_MIN_SAVING_RATE');
  });
});

describe('BUDGET_LIMITS_PLAN', () => {
  it('fires when the cash budget is the binding constraint, and quotes only what more cash can deliver', () => {
    // Opening example with a S$10,000 cash limit: CI 108,600 -> 98,600, tax 5,489.00.
    // unrealisedSaving (§6.6) runs to min(U, C) = 53,600: 5,489.00 - tax(55,000) = 5,489.00 - 1,600.00 = 3,889.00.
    // But with the cash limit lifted the schemes stop the plan at L = 23,300 (tax 3,959.50), so more cash can
    // add at most 5,489.00 - 3,959.50 = 1,529.50 (13,300 x 11.5%). SPEC §6.11: the message quotes that figure.
    const w = warning(plan(input({ preferences: { cashBudget: 10_000 } })), 'BUDGET_LIMITS_PLAN');
    expect(w.severity).toBe('info');
    expect(w.params).toEqual({ cashBudget: 10_000, unrealisedSaving: 3_889, savingWithMoreCash: 1_529.5 });
    expect(w.message).toBe(
      'Your cash limit of S$10,000 is what stops the plan. With more cash you could save up to S$1,529.50 more tax.',
    );
  });

  it('quotes exactly the saving of the plan without the cash limit, whichever limit comes next', () => {
    const limited = (overrides: Parameters<typeof input>[0]): void => {
      const withLimit = plan(input(overrides));
      const without = plan(input({ ...overrides, preferences: { ...overrides?.preferences, cashBudget: null } }));
      const w = warning(withLimit, 'BUDGET_LIMITS_PLAN');
      const extraCents = Math.round(without.plan.taxSaved * 100) - Math.round(withLimit.plan.taxSaved * 100);
      expect(Math.round(Number(w.params?.savingWithMoreCash) * 100)).toBe(extraCents);
      expect(extraCents).toBeGreaterThan(0);
    };
    limited({ preferences: { cashBudget: 2_500 } }); // schemes next (L = 23,300)
    limited({ preferences: { cashBudget: 2_500, minSavingRate: 0.115 }, otherReliefs: 30_000 }); // minimum rate next
    limited({ preferences: { cashBudget: 2_500 }, otherReliefs: 45_000 }); // relief cap next (C = 13,600)
    limited({ preferences: { cashBudget: 1 }, cpfFamily: { enabled: true } });
  });

  it('does not fire when the budget is not what binds', () => {
    expect(codes(plan(input({ preferences: { cashBudget: 50_000 } })))).not.toContain('BUDGET_LIMITS_PLAN');
  });
});

describe('LEVER_LIMITS_PLAN', () => {
  it('fires when the schemes are full, and quotes only what switching on the other schemes can deliver', () => {
    // Opening example: SRS and own CPF are full at 23,300 (tax 3,959.50). unrealisedSaving (§6.6) = 2,359.50
    // needs 30,300 more dollars of room, but the only room left is the family top-up that is switched off
    // (8,000): CI 85,300 -> 77,300, tax 550 + 7% x 37,300 = 3,161.00, i.e. 3,959.50 - 3,161.00 = 798.50
    // (5,300 x 11.5% + 2,700 x 7%). SPEC §6.11: the message quotes that figure, not unrealisedSaving.
    const w = warning(plan(input()), 'LEVER_LIMITS_PLAN');
    expect(w.severity).toBe('info');
    expect(w.params).toEqual({ leverRoom: 23_300, unrealisedSaving: 2_359.5, savingIfSwitchedOn: 798.5 });
    expect(w.message).toBe(
      'The plan uses all S$23,300 of room left in the schemes you switched on. ' +
        'Switching on the schemes you left off could save up to S$798.50 more tax.',
    );
  });

  it('promises nothing when every scheme open to the person is already full', () => {
    const w = warning(plan(input({ cpfFamily: { enabled: true } })), 'LEVER_LIMITS_PLAN');
    // L = 31,300 < U = 68,600: unrealisedSaving = tax(77,300) - tax(55,000) = 3,161.00 - 1,600.00 = 1,561.00,
    // but no setting can create more room, so the message stops after the first sentence.
    expect(w.params).toEqual({ leverRoom: 31_300, unrealisedSaving: 1_561, savingIfSwitchedOn: 0 });
    expect(w.message).toBe('The plan uses all S$31,300 of room left in the schemes you switched on.');
  });

  it('says that nothing is switched on, and what switching the schemes on would save', () => {
    const w = warning(plan(input({ srs: { enabled: false }, cpfSelf: { enabled: false } })), 'LEVER_LIMITS_PLAN');
    // All three schemes together have 31,300 of room: tax 6,639.00 -> 3,161.00, a saving of 3,478.00
    // (not the 5,039.00 of unrealisedSaving, which would need 53,600 of room).
    expect(w.params).toEqual({ leverRoom: 0, unrealisedSaving: 5_039, savingIfSwitchedOn: 3_478 });
    expect(w.message).toBe(
      'No scheme is switched on, so nothing can be contributed. ' +
        'Switching on the schemes you left off could save up to S$3,478.00 more tax.',
    );
  });

  it('says so when none of the schemes switched on is open to the person', () => {
    // A foreigner with only own-CPF top-ups switched on: not eligible. SRS is open to them but off:
    // CI 134,000 (tax 10,050.00); 35,700 of SRS takes it to 98,300: 3,350 + 11.5% x 18,300 = 5,454.50.
    const w = warning(
      plan(input({ profile: { residency: 'foreigner' }, otherReliefs: 0, srs: { enabled: false } })),
      'LEVER_LIMITS_PLAN',
    );
    expect(w.params).toMatchObject({ leverRoom: 0, savingIfSwitchedOn: 4_595.5 });
    expect(w.message).toBe(
      'None of the schemes you switched on is open to you, so nothing can be contributed. ' +
        'Switching on the schemes you left off could save up to S$4,595.50 more tax.',
    );
    // A 17-year-old foreigner has no scheme at all: nothing to switch on, so no figure.
    const minor = warning(
      plan(input({ profile: { residency: 'foreigner', ageAtYearEnd: 17 }, cpfFamily: { enabled: true } })),
      'LEVER_LIMITS_PLAN',
    );
    expect(minor.params).toMatchObject({ leverRoom: 0, savingIfSwitchedOn: 0 });
    expect(minor.message).toBe('None of the schemes you switched on is open to you, so nothing can be contributed.');
  });

  it('keeps the "no room left" wording for schemes that are open but full', () => {
    const w = warning(
      plan(input({ existing: { srs: 15_300, cpfTopUpSelf: 8_000 } })),
      'LEVER_LIMITS_PLAN',
    );
    // Reliefs 49,700 -> CI 85,300 (tax 3,959.50). Only the family top-up (off) has room: 798.50 as above.
    expect(w.params).toEqual({ leverRoom: 0, unrealisedSaving: 2_359.5, savingIfSwitchedOn: 798.5 });
    expect(w.message).toBe(
      'The schemes you switched on have no room left this year, so nothing more can be contributed. ' +
        'Switching on the schemes you left off could save up to S$798.50 more tax.',
    );
  });

  it('does not count room that a cash limit would stop the person from using', () => {
    // Cash limit 23,300 = L: the schemes bind first (tie order), and switching on the family top-up would not
    // help because there is no cash left for it.
    const w = warning(plan(input({ preferences: { cashBudget: 23_300 } })), 'LEVER_LIMITS_PLAN');
    expect(w.params).toEqual({ leverRoom: 23_300, unrealisedSaving: 2_359.5, savingIfSwitchedOn: 0 });
    expect(w.message).toBe('The plan uses all S$23,300 of room left in the schemes you switched on.');
    // With 1,000 more cash than the schemes take, only 1,000 of the family room is within reach: 11.5% of it.
    const some = warning(plan(input({ preferences: { cashBudget: 24_300 } })), 'LEVER_LIMITS_PLAN');
    expect(some.params).toMatchObject({ savingIfSwitchedOn: 115 });
    expect(some.message).toContain('could save up to S$115.00 more tax.');
  });

  it('quotes only the tax still on the table at the chosen minimum rate', () => {
    // minSavingRate 11.5%: U = 28,600 > L = 23,300; the 5,300 dollars in between are worth 11.5% = 609.50,
    // and the family top-up (off, 8,000 of room) could take all of them.
    const result = plan(input({ preferences: { minSavingRate: 0.115 } }));
    const w = warning(result, 'LEVER_LIMITS_PLAN');
    expect(result.plan.unrealisedSaving).toBe(609.5);
    expect(w.params).toMatchObject({ savingIfSwitchedOn: 609.5 });
    expect(w.message).toContain('S$609.50 more tax');
  });

  it('quotes exactly the saving of the plan with every scheme switched on', () => {
    const on = { enabled: true };
    const cases: Parameters<typeof input>[0][] = [
      {},
      { srs: { enabled: false } },
      { cpfSelf: { enabled: false }, cpfFamily: { enabled: true } },
      { srs: { enabled: false }, cpfSelf: { enabled: false } },
      { cpfSelf: { enabled: true, roomToLimit: 1_000 }, srs: { enabled: false } },
      { cpfFamily: { enabled: false, maxAmount: 500 } },
      { profile: { residency: 'foreigner' }, srs: { enabled: false } },
      { otherReliefs: 30_000, srs: { enabled: false } },
      { preferences: { minSavingRate: 0.115 }, srs: { enabled: false } },
      { preferences: { cashBudget: 9_000 }, srs: { enabled: false } },
    ];
    for (const overrides of cases) {
      const now = plan(input(overrides));
      if (now.plan.bindingConstraint !== 'leverLimits') throw new Error(`not lever-limited: ${JSON.stringify(overrides)}`);
      const allOn = plan(
        input({
          ...overrides,
          srs: { ...overrides?.srs, ...on },
          cpfSelf: { ...overrides?.cpfSelf, ...on },
          cpfFamily: { ...overrides?.cpfFamily, ...on },
        }),
      );
      const extraCents = Math.round(allOn.plan.taxSaved * 100) - Math.round(now.plan.taxSaved * 100);
      const w = warning(now, 'LEVER_LIMITS_PLAN');
      expect({ overrides, cents: Math.round(Number(w.params?.savingIfSwitchedOn) * 100) }).toEqual({ overrides, cents: extraCents });
      expect(w.message.includes('could save up to')).toBe(extraCents > 0);
    }
  });
});

describe('EXISTING_EXCEEDS_CAP', () => {
  it('fires once, listing every existing contribution above its cap', () => {
    const result = plan(input({ existing: { srs: 20_000, cpfTopUpSelf: 9_000 } }));
    const w = warning(result, 'EXISTING_EXCEEDS_CAP');
    expect(result.warnings.filter((x) => x.code === 'EXISTING_EXCEEDS_CAP')).toHaveLength(1);
    expect(w.severity).toBe('caution');
    expect(w.params).toEqual({
      levers: 'srs,cpfSelf',
      srsExisting: 20_000,
      srsCap: 15_300,
      srsExcess: 4_700,
      cpfSelfExisting: 9_000,
      cpfSelfCap: 8_000,
      cpfSelfExcess: 1_000,
    });
    expect(w.message).toBe(
      'You have already put S$20,000 into SRS this year, but only S$15,300 a year earns tax relief; ' +
        'the extra S$4,700 earns none. ' +
        'You have already put S$9,000 into your own CPF as cash top-ups this year, but only S$8,000 a year earns ' +
        'tax relief; the extra S$1,000 earns none.',
    );
  });

  it('covers family top-ups, also when the lever is switched off', () => {
    const w = warning(plan(input({ existing: { cpfTopUpFamily: 8_001 } })), 'EXISTING_EXCEEDS_CAP');
    expect(w.params).toEqual({ levers: 'cpfFamily', cpfFamilyExisting: 8_001, cpfFamilyCap: 8_000, cpfFamilyExcess: 1 });
  });

  it('does not fire at the cap, or when the cap is zero because the lever is not eligible', () => {
    expect(codes(plan(input({ existing: { srs: 15_300, cpfTopUpSelf: 8_000, cpfTopUpFamily: 8_000 } })))).not.toContain(
      'EXISTING_EXCEEDS_CAP',
    );
    expect(codes(plan(input({ profile: { ageAtYearEnd: 17 }, existing: { srs: 20_000 } })))).not.toContain('EXISTING_EXCEEDS_CAP');
    expect(
      codes(plan(input({ profile: { residency: 'foreigner' }, existing: { cpfTopUpSelf: 20_000, cpfTopUpFamily: 20_000 } }))),
    ).not.toContain('EXISTING_EXCEEDS_CAP');
  });

  it('uses the foreigner SRS cap for foreigners', () => {
    const base = { profile: { residency: 'foreigner' as const } };
    expect(codes(plan(input({ ...base, existing: { srs: 35_700 } })))).not.toContain('EXISTING_EXCEEDS_CAP');
    expect(warning(plan(input({ ...base, existing: { srs: 40_000 } })), 'EXISTING_EXCEEDS_CAP').params).toEqual({
      levers: 'srs',
      srsExisting: 40_000,
      srsCap: 35_700,
      srsExcess: 4_300,
    });
  });
});

describe('CPF_OVERRIDE_ABOVE_MAX', () => {
  it('fires when the override is above 20,400', () => {
    const w = warning(plan(input({ income: { employeeCpfOverride: 25_000 } })), 'CPF_OVERRIDE_ABOVE_MAX');
    expect(w.severity).toBe('caution');
    expect(w.params).toEqual({ override: 25_000, maxCompulsory: 20_400 });
    expect(w.message).toContain('S$25,000');
    expect(w.message).toContain('S$20,400');
  });

  it('does not fire at the maximum, without an override, or for a foreigner', () => {
    expect(codes(plan(input({ income: { employeeCpfOverride: 20_400 } })))).not.toContain('CPF_OVERRIDE_ABOVE_MAX');
    expect(codes(plan(input()))).not.toContain('CPF_OVERRIDE_ABOVE_MAX');
    expect(
      codes(plan(input({ profile: { residency: 'foreigner' }, income: { employeeCpfOverride: 25_000 } }))),
    ).not.toContain('CPF_OVERRIDE_ABOVE_MAX');
  });
});

describe('FOREIGNER_NO_CPF', () => {
  it('fires for foreigners only', () => {
    const w = warning(plan(input({ profile: { residency: 'foreigner' } })), 'FOREIGNER_NO_CPF');
    expect(w.severity).toBe('info');
    expect(w.params).toEqual({ srsCap: 35_700 });
    expect(w.message).toBe(
      'Foreigners on work passes do not contribute to CPF, so there is no CPF relief and CPF top-ups do not ' +
        'earn tax relief. You can put up to S$35,700 a year into SRS.',
    );
    expect(codes(plan(input({ profile: { residency: 'pr' } })))).not.toContain('FOREIGNER_NO_CPF');
    expect(codes(plan(input()))).not.toContain('FOREIGNER_NO_CPF');
  });

  it('does not invite a foreigner under 18 to use SRS (SPEC §6.5: srs is eligible from 18)', () => {
    const result = plan(input({ profile: { residency: 'foreigner', ageAtYearEnd: 17 } }));
    const w = warning(result, 'FOREIGNER_NO_CPF');
    expect(result.levers.srs).toMatchObject({ eligible: false, statutoryCap: 0 });
    expect(codes(result)).toContain('SRS_UNDER_18');
    expect(w.params).toEqual({ srsCap: 0 });
    expect(w.message).toBe(
      'Foreigners on work passes do not contribute to CPF, so there is no CPF relief and CPF top-ups do not ' +
        'earn tax relief.',
    );
    // At 18 the sentence is back.
    expect(warning(plan(input({ profile: { residency: 'foreigner', ageAtYearEnd: 18 } })), 'FOREIGNER_NO_CPF').message).toContain(
      'You can put up to S$35,700 a year into SRS.',
    );
  });
});

describe('PR_GRADUATED_RATES', () => {
  it('fires for PRs in their 1st and 2nd year', () => {
    const first = warning(plan(input({ profile: { residency: 'pr', prYear: 1 } })), 'PR_GRADUATED_RATES');
    expect(first.severity).toBe('info');
    expect(first.params).toEqual({ prYear: 1 });
    expect(first.message).toContain('1st year');
    const second = warning(plan(input({ profile: { residency: 'pr', prYear: 2 } })), 'PR_GRADUATED_RATES');
    expect(second.params).toEqual({ prYear: 2 });
    expect(second.message).toContain('2nd year');
  });

  it('does not fire from the 3rd year, by default, or for other residencies', () => {
    expect(codes(plan(input({ profile: { residency: 'pr', prYear: 3 } })))).not.toContain('PR_GRADUATED_RATES');
    expect(codes(plan(input({ profile: { residency: 'pr', prYear: undefined } })))).not.toContain('PR_GRADUATED_RATES');
    expect(codes(plan(input({ profile: { residency: 'citizen', prYear: 1 } })))).not.toContain('PR_GRADUATED_RATES');
    expect(codes(plan(input({ profile: { residency: 'foreigner', prYear: 1 } })))).not.toContain('PR_GRADUATED_RATES');
  });
});

describe('AGE_55_PLUS_TOPUP', () => {
  it('fires from 55 when the CPF self lever is on and eligible', () => {
    const w = warning(plan(input({ profile: { ageAtYearEnd: 55 } })), 'AGE_55_PLUS_TOPUP');
    expect(w.severity).toBe('info');
    expect(w.params).toEqual({ ageAtYearEnd: 55, fullRetirementSum: 220_400 });
    expect(w.message).toContain('S$220,400 in 2026');
    expect(codes(plan(input({ profile: { ageAtYearEnd: 70 } })))).toContain('AGE_55_PLUS_TOPUP');
  });

  it('quotes the Full Retirement Sum of the income year', () => {
    const y2025 = plan(input({ incomeYear: 2025, today: '2025-06-30', profile: { ageAtYearEnd: 60 } }));
    expect(warning(y2025, 'AGE_55_PLUS_TOPUP').params).toEqual({ ageAtYearEnd: 60, fullRetirementSum: 213_000 });
    const y2027 = plan(input({ incomeYear: 2027, today: '2027-06-30', profile: { ageAtYearEnd: 60 } }));
    expect(warning(y2027, 'AGE_55_PLUS_TOPUP').params).toEqual({ ageAtYearEnd: 60, fullRetirementSum: 228_200 });
  });

  it('does not fire below 55, with the lever off, or for a foreigner', () => {
    expect(codes(plan(input({ profile: { ageAtYearEnd: 54 } })))).not.toContain('AGE_55_PLUS_TOPUP');
    expect(codes(plan(input({ profile: { ageAtYearEnd: 60 }, cpfSelf: { enabled: false } })))).not.toContain('AGE_55_PLUS_TOPUP');
    expect(codes(plan(input({ profile: { ageAtYearEnd: 60, residency: 'foreigner' } })))).not.toContain('AGE_55_PLUS_TOPUP');
  });
});

describe('SRS_UNDER_18', () => {
  it('fires below 18 only', () => {
    const w = warning(plan(input({ profile: { ageAtYearEnd: 17 } })), 'SRS_UNDER_18');
    expect(w.severity).toBe('caution');
    expect(w.params).toEqual({ ageAtYearEnd: 17, minAge: 18 });
    expect(w.message).toBe('You must be at least 18 to contribute to SRS, so SRS is left out of the plan.');
    expect(codes(plan(input({ profile: { ageAtYearEnd: 18 } })))).not.toContain('SRS_UNDER_18');
  });
});

describe('DEADLINE_PASSED', () => {
  it('fires after 31 December of the income year', () => {
    const result = plan(input({ today: '2027-01-01' }));
    const w = warning(result, 'DEADLINE_PASSED');
    expect(w.severity).toBe('blocker');
    expect(w.params).toEqual({ deadline: '2026-12-31', daysToDeadline: -1, daysSinceDeadline: 1 });
    expect(w.message).toBe(
      'The deadline for contributions that count for YA2027 was 31 December 2026, 1 day ago. ' +
        'Money you put in now counts for the following year instead.',
    );
    expect(codes(result)).not.toContain('DEADLINE_SOON');
    expect(warning(plan(input({ today: '2027-03-15' })), 'DEADLINE_PASSED').message).toContain('74 days ago');
  });

  it('does not fire on the deadline day itself', () => {
    expect(codes(plan(input({ today: '2026-12-31' })))).not.toContain('DEADLINE_PASSED');
  });
});

describe('DEADLINE_SOON', () => {
  it('fires from 14 days before the deadline when something is recommended', () => {
    const fourteen = warning(plan(input({ today: '2026-12-17' })), 'DEADLINE_SOON');
    expect(fourteen.severity).toBe('caution');
    expect(fourteen.params).toEqual({ deadline: '2026-12-31', daysToDeadline: 14 });
    expect(fourteen.message).toBe(
      'Only 14 days left until the 31 December 2026 deadline. ' +
        'Banks and the CPF Board can stop taking contributions earlier, so transfer as soon as you can.',
    );
    expect(warning(plan(input({ today: '2026-12-30' })), 'DEADLINE_SOON').message).toContain('Only 1 day left');
    const lastDay = warning(plan(input({ today: '2026-12-31' })), 'DEADLINE_SOON');
    expect(lastDay.params).toEqual({ deadline: '2026-12-31', daysToDeadline: 0 });
    expect(lastDay.message).toContain('Today, 31 December 2026, is the deadline.');
  });

  it('does not fire 15 days out, or when nothing is recommended', () => {
    expect(codes(plan(input({ today: '2026-12-16' })))).not.toContain('DEADLINE_SOON');
    const nothing = plan(input({ today: '2026-12-20', preferences: { cashBudget: 0 } }));
    expect(nothing.plan.totalContribution).toBe(0);
    expect(codes(nothing)).not.toContain('DEADLINE_SOON');
  });
});

describe('PROJECTED_RULES', () => {
  it('fires for income year 2027 only', () => {
    const w = warning(plan(input({ incomeYear: 2027, today: '2027-06-30' })), 'PROJECTED_RULES');
    expect(w.severity).toBe('caution');
    expect(w.params).toEqual({ incomeYear: 2027, ya: 2028 });
    expect(w.message).toContain('income year 2027 (YA2028)');
    expect(codes(plan(input({ incomeYear: 2026 })))).not.toContain('PROJECTED_RULES');
    expect(codes(plan(input({ incomeYear: 2025, today: '2025-06-30' })))).not.toContain('PROJECTED_RULES');
  });
});

describe('PIT_REBATE_APPLIED', () => {
  const withRebate = { ...getRules(2026), pitRebate: { rate: 0.6, cap: 200 } };

  it('fires when a rebate reduces the baseline tax', () => {
    const result = planFor(sanitise(input()), withRebate);
    // 6,639.00 x 60% is far above the cap -> rebate 200
    expect(result.baseline).toMatchObject({ grossTax: 6_639, pitRebate: 200, taxPayable: 6_439 });
    const w = warning(result, 'PIT_REBATE_APPLIED');
    expect(w.severity).toBe('info');
    expect(w.params).toEqual({ pitRebate: 200, rebateRate: 0.6, rebateCap: 200 });
    expect(w.message).toContain('60%');
    expect(w.message).toContain('S$200.00 off your bill');
    // the capped rebate is the same before and after, so the saving is unchanged
    expect(result.plan.taxSaved).toBe(2_679.5);
  });

  it('does not fire without a rebate rule, or when there is no tax to rebate', () => {
    expect(codes(plan(input()))).not.toContain('PIT_REBATE_APPLIED');
    const noTax = planFor(
      sanitise(input({ income: { monthlyOrdinaryWage: 1_500, additionalWages: 0 }, otherReliefs: 0 })),
      withRebate,
    );
    expect(codes(noTax)).toEqual(['NO_TAX_PAYABLE']);
  });
});

describe('warnings in general', () => {
  const scenarios: PlannerResult[] = [
    plan(input()),
    plan(input({ income: { monthlyOrdinaryWage: 1_500, additionalWages: 0 }, otherReliefs: 0 })),
    plan(input({ otherReliefs: 70_000 })),
    plan(input({ otherReliefs: 40_000 })),
    plan(input(LOW_INCOME)),
    plan(input({ preferences: { cashBudget: 10_000 } })),
    plan(input({ existing: { srs: 20_000, cpfTopUpSelf: 9_000, cpfTopUpFamily: 9_000 } })),
    plan(input({ income: { employeeCpfOverride: 25_000 } })),
    plan(input({ profile: { residency: 'foreigner' } })),
    plan(input({ profile: { residency: 'pr', prYear: 1, ageAtYearEnd: 60 } })),
    plan(input({ profile: { ageAtYearEnd: 17 } })),
    plan(input({ today: '2027-01-01' })),
    plan(input({ today: '2026-12-25' })),
    plan(input({ incomeYear: 2027, today: '2027-12-31' })),
    planFor(sanitise(input()), { ...getRules(2026), pitRebate: { rate: 0.6, cap: 200 } }),
  ];
  const all = scenarios.flatMap((result) => result.warnings);

  it('together these cases exercise every code in the SPEC table', () => {
    const seen = new Set(all.map((w) => w.code));
    expect([...seen].sort()).toEqual(Object.keys(SEVERITY).sort());
  });

  it('every warning has the severity from the SPEC table, a sentence and params', () => {
    for (const w of all) {
      expect(w.severity).toBe(SEVERITY[w.code]);
      expect(w.message.length).toBeGreaterThan(30);
      expect(w.message).toMatch(/^[A-Z]/);
      expect(w.message).toMatch(/\.$/);
      expect(w.message).not.toMatch(/undefined|NaN|null|\[object/);
      expect(w.params).toBeDefined();
      for (const value of Object.values(w.params ?? {})) {
        expect(['number', 'string']).toContain(typeof value);
      }
    }
  });

  it('no code appears twice in one result, and codes follow the order of the SPEC table', () => {
    const order = Object.keys(SEVERITY);
    for (const result of scenarios) {
      const list = codes(result);
      expect(new Set(list).size).toBe(list.length);
      expect([...list].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(list);
    }
  });

  it('several warnings can apply at once', () => {
    // 2nd-year PR aged 60 on the last day of projected 2027, with the CPF self lever on
    const result = plan(input({ incomeYear: 2027, today: '2027-12-31', profile: { residency: 'pr', prYear: 2, ageAtYearEnd: 60 } }));
    expect(codes(result)).toEqual([
      'LEVER_LIMITS_PLAN',
      'PR_GRADUATED_RATES',
      'AGE_55_PLUS_TOPUP',
      'DEADLINE_SOON',
      'PROJECTED_RULES',
    ]);
  });
});
