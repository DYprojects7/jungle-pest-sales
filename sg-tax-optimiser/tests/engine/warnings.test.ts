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
  TAX_RESIDENCY_CHECK: 'caution',
  SRS_NON_RESIDENT_WITHDRAWAL: 'caution',
  PR_GRADUATED_RATES: 'info',
  CPF_SELF_ROOM_UNCONFIRMED: 'caution',
  AGE_55_PLUS_TOPUP: 'info',
  FAMILY_TOPUP_CHECKS: 'caution',
  PARENTHOOD_TAX_REBATE: 'caution',
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
      'Every extra dollar you contribute would save at most 3.5% in tax, below your 7% minimum, ' +
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

  it('ends by saying which CPF payment does earn relief, and where to enter it (wording fixed by SPEC §6.11)', () => {
    const w = warning(plan(input({ income: { employeeCpfOverride: 25_000 } })), 'CPF_OVERRIDE_ABOVE_MAX');
    const ending =
      'Voluntary contributions to your three CPF accounts earn no relief; a cash top-up to your MediSave, Special ' +
      "or Retirement Account does — enter it under 'Already contributed'.";
    expect(w.message.endsWith(` ${ending}`)).toBe(true);
    // The sentence before it still says what was entered and what is used instead.
    expect(w.message.slice(0, -ending.length)).toMatch(/S\$25,000.*S\$20,400.*S\$20,400 is used\. $/);
    expect(w.message).not.toContain('Voluntary contributions do not earn CPF relief');
    // The whole message for this case: the first sentence is unchanged, the ending is the SPEC's.
    expect(w.message).toBe(
      'The employee CPF you entered (S$25,000) is more than the largest compulsory contribution possible in a year ' +
        '(S$20,400), so S$20,400 is used. Voluntary contributions to your three CPF accounts earn no relief; a cash ' +
        "top-up to your MediSave, Special or Retirement Account does — enter it under 'Already contributed'.",
    );
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

describe('TAX_RESIDENCY_CHECK', () => {
  const foreigner = (monthsWorked: unknown, more: Overrides = {}): PlannerResult =>
    plan(
      input({
        ...more,
        profile: { residency: 'foreigner', ...more.profile },
        income: { ...more.income, monthsWorked: monthsWorked as number },
      }),
    );

  it('fires for a foreigner who worked 6 months or fewer, with the normative message', () => {
    const w = warning(foreigner(6), 'TAX_RESIDENCY_CHECK');
    expect(w.severity).toBe('caution');
    expect(w.params).toEqual({ monthsWorked: 6, residentDays: 183 });
    expect(w.message).toBe(
      'You worked here for half the year or less. You are a tax resident only if you were in Singapore for at ' +
        'least 183 days (IRAS has further rules for stays that span two years). Non-residents get no reliefs, so ' +
        'this plan would not apply.',
    );
  });

  it('the boundary is 6 months: 1 to 6 fire, 7 to 12 do not', () => {
    for (const months of [1, 2, 3, 4, 5, 6]) expect(codes(foreigner(months))).toContain('TAX_RESIDENCY_CHECK');
    for (const months of [7, 8, 9, 10, 11, 12]) expect(codes(foreigner(months))).not.toContain('TAX_RESIDENCY_CHECK');
  });

  it('uses the sanitised months worked (§6.0): missing or not a number is 12; 0, NaN and negatives are 1; 6.9 is 6', () => {
    for (const months of [undefined, null, '3']) {
      const result = foreigner(months);
      expect(result.input.income.monthsWorked).toBe(12);
      expect(codes(result)).not.toContain('TAX_RESIDENCY_CHECK');
    }
    for (const months of [0, Number.NaN, -4]) {
      const w = warning(foreigner(months), 'TAX_RESIDENCY_CHECK');
      expect(w.params).toEqual({ monthsWorked: 1, residentDays: 183 });
    }
    expect(warning(foreigner(6.9), 'TAX_RESIDENCY_CHECK').params).toMatchObject({ monthsWorked: 6 });
    expect(codes(foreigner(7.9))).not.toContain('TAX_RESIDENCY_CHECK');
  });

  it('is about foreigners only: a citizen or PR who worked 3 months is not asked', () => {
    expect(codes(plan(input({ income: { monthsWorked: 3 } })))).not.toContain('TAX_RESIDENCY_CHECK');
    expect(codes(plan(input({ profile: { residency: 'pr' }, income: { monthsWorked: 3 } })))).not.toContain('TAX_RESIDENCY_CHECK');
    expect(codes(plan(input({ profile: { residency: 'pr', prYear: 1 }, income: { monthsWorked: 1 } })))).not.toContain('TAX_RESIDENCY_CHECK');
  });

  it('does not depend on SRS: it fires with SRS off and for a foreigner under 18', () => {
    expect(codes(foreigner(6, { srs: { enabled: false } }))).toContain('TAX_RESIDENCY_CHECK');
    expect(codes(foreigner(6, { profile: { ageAtYearEnd: 17 } }))).toContain('TAX_RESIDENCY_CHECK');
  });
});

describe('SRS_NON_RESIDENT_WITHDRAWAL', () => {
  const BASE_MESSAGE =
    "If you have left Singapore when you withdraw, SRS is taxed as a non-resident's: at least 7.5 cents per dollar " +
    'withdrawn at retirement age or under the 10-year rule for foreigners, and at least 20 cents if earlier.';

  // Foreigner, 35, S$7,000 a month and a S$7,000 bonus, no other reliefs: income 91,000, no CPF, Earned Income
  // Relief 1,000 -> chargeable income 90,000, tax 3,350 + 11.5% x 10,000 = 4,500.00. SRS room 35,700.
  // Ladder (§6.7): [0, 10,000) at 11.5% (90,000 down to 80,000), then [10,000, 35,700) at 7%.
  const earner = (preferences: Overrides['preferences'] = {}, more: Overrides = {}): PlannerResult =>
    plan(
      input({
        otherReliefs: 0,
        ...more,
        profile: { residency: 'foreigner', ...more.profile },
        income: { monthlyOrdinaryWage: 7_000, additionalWages: 7_000, ...more.income },
        preferences,
      }),
    );

  it('fires for a foreigner with SRS switched on, with the normative message', () => {
    // The opening example as a foreigner: CI 129,000; the plan (35,700) sits in the 15% and 11.5% rungs.
    const result = plan(input({ profile: { residency: 'foreigner' } }));
    const w = warning(result, 'SRS_NON_RESIDENT_WITHDRAWAL');
    expect(w.severity).toBe('caution');
    expect(w.params).toEqual({ lowValueAmount: 0, atRetirementOrTenYears: 0.075, early: 0.2 });
    expect(w.message).toBe(BASE_MESSAGE);
    expect(result.ladder.map((tier) => [tier.rate, tier.usedByPlan])).toEqual([[0.15, 9_000], [0.115, 26_700]]);
  });

  it('minimum 7%: the plan spans the 11.5% and 7% rungs, and the S$25,700 on the 7% rung is called out', () => {
    // U = 90,000 - 40,000 = 50,000; C = 79,000; L = 35,700 -> X = 35,700: 10,000 at 11.5% + 25,700 at 7%.
    const result = earner({ minSavingRate: 0.07 });
    expect(result.baseline.chargeableIncome).toBe(90_000);
    expect(result.baseline.taxPayable).toBe(4_500);
    expect(result.plan.contributions).toEqual({ srs: 35_700, cpfSelf: 0, cpfFamily: 0 });
    expect(result.plan.taxSaved).toBe(2_949); // 1,150.00 + 1,799.00
    expect(result.ladder.map((tier) => [tier.rate, tier.amount, tier.usedByPlan])).toEqual([
      [0.115, 10_000, 10_000],
      [0.07, 25_700, 25_700],
    ]);
    const w = warning(result, 'SRS_NON_RESIDENT_WITHDRAWAL');
    expect(w.params).toEqual({ lowValueAmount: 25_700, atRetirementOrTenYears: 0.075, early: 0.2 });
    expect(w.message).toBe(`${BASE_MESSAGE} S$25,700 of this plan saves less than 7.5 cents per dollar today.`);
  });

  it('minimum 11.5%: the plan stops at the top rung, so nothing is called out', () => {
    // U = 90,000 - 80,000 = 10,000 -> X = 10,000, all at 11.5%.
    const result = earner({ minSavingRate: 0.115 });
    expect(result.plan.contributions).toEqual({ srs: 10_000, cpfSelf: 0, cpfFamily: 0 });
    expect(result.plan.bindingConstraint).toBe('usefulRoom');
    expect(result.plan.taxSaved).toBe(1_150);
    const w = warning(result, 'SRS_NON_RESIDENT_WITHDRAWAL');
    expect(w.params).toEqual({ lowValueAmount: 0, atRetirementOrTenYears: 0.075, early: 0.2 });
    expect(w.message).toBe(BASE_MESSAGE);
  });

  it('counts only the dollars the plan actually uses on the low rungs', () => {
    // Cash limit 12,000 at a 7% minimum: 10,000 at 11.5% and 2,000 at 7%.
    expect(warning(earner({ minSavingRate: 0.07, cashBudget: 12_000 }), 'SRS_NON_RESIDENT_WITHDRAWAL').params).toMatchObject({ lowValueAmount: 2_000 });
    // Cash limit 10,000: exactly the top rung. 10,001: one dollar on the 7% rung.
    expect(warning(earner({ minSavingRate: 0.07, cashBudget: 10_000 }), 'SRS_NON_RESIDENT_WITHDRAWAL').params).toMatchObject({ lowValueAmount: 0 });
    const one = warning(earner({ minSavingRate: 0.07, cashBudget: 10_001 }), 'SRS_NON_RESIDENT_WITHDRAWAL');
    expect(one.params).toMatchObject({ lowValueAmount: 1 });
    expect(one.message).toBe(`${BASE_MESSAGE} S$1 of this plan saves less than 7.5 cents per dollar today.`);
    // A minimum between 7% and 11.5% (7.5%) keeps the plan on the top rung.
    expect(warning(earner({ minSavingRate: 0.075 }), 'SRS_NON_RESIDENT_WITHDRAWAL').params).toMatchObject({ lowValueAmount: 0 });
  });

  it('every tax dollar on a small income: the whole plan is on the 3.5% and 2% rungs', () => {
    // S$3,000 x 12, no bonus: CI 35,000, tax 200 + 3.5% x 5,000 = 375.00. Minimum 0: X = U = 15,000
    // (5,000 at 3.5% + 10,000 at 2%); the 20,700 dollars beyond that are not in the plan.
    const result = earner({ minSavingRate: 0 }, { income: { monthlyOrdinaryWage: 3_000, additionalWages: 0 } });
    expect(result.baseline.taxPayable).toBe(375);
    expect(result.plan.totalContribution).toBe(15_000);
    expect(result.ladder.map((tier) => [tier.rate, tier.usedByPlan])).toEqual([[0.035, 5_000], [0.02, 10_000], [0, 0]]);
    const w = warning(result, 'SRS_NON_RESIDENT_WITHDRAWAL');
    expect(w.params).toMatchObject({ lowValueAmount: 15_000 });
    expect(w.message).toBe(`${BASE_MESSAGE} S$15,000 of this plan saves less than 7.5 cents per dollar today.`);
  });

  it('fires whenever SRS is on and open to a foreigner, even when nothing can be added', () => {
    const full = earner({ minSavingRate: 0.07 }, { existing: { srs: 35_700 } });
    expect(full.plan.totalContribution).toBe(0);
    expect(warning(full, 'SRS_NON_RESIDENT_WITHDRAWAL').params).toMatchObject({ lowValueAmount: 0 });
  });

  it('does not fire with SRS off, under 18, or for a citizen or PR', () => {
    expect(codes(earner({}, { srs: { enabled: false } }))).not.toContain('SRS_NON_RESIDENT_WITHDRAWAL');
    // 17: SRS is not open (§6.5), so there is nothing to caution about; from 18 it is.
    expect(codes(earner({}, { profile: { ageAtYearEnd: 17 } }))).not.toContain('SRS_NON_RESIDENT_WITHDRAWAL');
    expect(codes(earner({}, { profile: { ageAtYearEnd: 18 } }))).toContain('SRS_NON_RESIDENT_WITHDRAWAL');
    expect(codes(earner({}, { profile: { residency: 'citizen' } }))).not.toContain('SRS_NON_RESIDENT_WITHDRAWAL');
    expect(codes(earner({}, { profile: { residency: 'pr' } }))).not.toContain('SRS_NON_RESIDENT_WITHDRAWAL');
    // "enabled" must be the boolean true (§6.0).
    expect(codes(earner({}, { srs: { enabled: 1 as unknown as boolean } }))).not.toContain('SRS_NON_RESIDENT_WITHDRAWAL');
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

describe('CPF_SELF_ROOM_UNCONFIRMED', () => {
  it('fires from 55 when own CPF is on, open to the person and the room was not entered', () => {
    const w = warning(plan(input({ profile: { ageAtYearEnd: 55 } })), 'CPF_SELF_ROOM_UNCONFIRMED');
    expect(w.severity).toBe('caution');
    expect(w.params).toEqual({ ageAtYearEnd: 55, fullRetirementSum: 220_400, enhancedRetirementSum: 440_800 });
    expect(w.message).toBe(
      'From age 55 the CPF Board accepts top-ups up to the Enhanced Retirement Sum (S$440,800), but only the part ' +
        'up to the Full Retirement Sum (S$220,400) earns relief, and a top-up cannot be reversed. Your own CPF is ' +
        'left out until you enter how much you can still top up with relief (S$0 if you have set aside the Full ' +
        'Retirement Sum).',
    );
    expect(codes(plan(input({ profile: { ageAtYearEnd: 70 } })))).toContain('CPF_SELF_ROOM_UNCONFIRMED');
  });

  it('quotes the retirement sums of the income year (§5.4)', () => {
    const y2025 = warning(plan(input({ incomeYear: 2025, today: '2025-06-30', profile: { ageAtYearEnd: 60 } })), 'CPF_SELF_ROOM_UNCONFIRMED');
    expect(y2025.params).toEqual({ ageAtYearEnd: 60, fullRetirementSum: 213_000, enhancedRetirementSum: 426_000 });
    expect(y2025.message).toContain('Enhanced Retirement Sum (S$426,000)');
    expect(y2025.message).toContain('Full Retirement Sum (S$213,000)');
    const y2027 = warning(plan(input({ incomeYear: 2027, today: '2027-06-30', profile: { ageAtYearEnd: 60 } })), 'CPF_SELF_ROOM_UNCONFIRMED');
    expect(y2027.params).toEqual({ ageAtYearEnd: 60, fullRetirementSum: 228_200, enhancedRetirementSum: 456_400 });
    expect(y2027.message).toContain('Enhanced Retirement Sum (S$456,400)');
    expect(y2027.message).toContain('Full Retirement Sum (S$228,200)');
  });

  it('does not fire below 55, with the lever off, for a foreigner, or once any room is entered', () => {
    expect(codes(plan(input({ profile: { ageAtYearEnd: 54 } })))).not.toContain('CPF_SELF_ROOM_UNCONFIRMED');
    expect(codes(plan(input({ profile: { ageAtYearEnd: 60 }, cpfSelf: { enabled: false } })))).not.toContain('CPF_SELF_ROOM_UNCONFIRMED');
    expect(codes(plan(input({ profile: { ageAtYearEnd: 60, residency: 'foreigner' } })))).not.toContain('CPF_SELF_ROOM_UNCONFIRMED');
    for (const roomToLimit of [0, 1, 8_000, 50_000]) {
      expect(codes(plan(input({ profile: { ageAtYearEnd: 60 }, cpfSelf: { roomToLimit } })))).not.toContain('CPF_SELF_ROOM_UNCONFIRMED');
    }
  });
});

describe('AGE_55_PLUS_TOPUP', () => {
  it('fires from 55 when own CPF is on, open to the person and the room WAS entered', () => {
    const w = warning(plan(input({ profile: { ageAtYearEnd: 55 }, cpfSelf: { roomToLimit: 4_000 } })), 'AGE_55_PLUS_TOPUP');
    expect(w.severity).toBe('info');
    expect(w.params).toEqual({ ageAtYearEnd: 55, fullRetirementSum: 220_400, roomToLimit: 4_000 });
    expect(w.message).toBe(
      'From age 55, cash top-ups go to your Retirement Account and earn relief only up to the Full Retirement Sum ' +
        '(S$220,400 in 2026). The plan uses the room you entered (S$4,000); check it against your CPF Retirement ' +
        'dashboard.',
    );
    expect(codes(plan(input({ profile: { ageAtYearEnd: 70 }, cpfSelf: { roomToLimit: 4_000 } })))).toContain('AGE_55_PLUS_TOPUP');
  });

  it('quotes the room as entered, also when it is S$0 or above the S$8,000 cap', () => {
    const zero = warning(plan(input({ profile: { ageAtYearEnd: 58 }, cpfSelf: { roomToLimit: 0 } })), 'AGE_55_PLUS_TOPUP');
    expect(zero.params).toMatchObject({ roomToLimit: 0 });
    expect(zero.message).toContain('The plan uses the room you entered (S$0);');
    const large = warning(plan(input({ profile: { ageAtYearEnd: 58 }, cpfSelf: { roomToLimit: 50_000.75 } })), 'AGE_55_PLUS_TOPUP');
    expect(large.params).toMatchObject({ roomToLimit: 50_000 });
    expect(large.message).toContain('The plan uses the room you entered (S$50,000);');
  });

  it('quotes the Full Retirement Sum of the income year', () => {
    const y2025 = plan(input({ incomeYear: 2025, today: '2025-06-30', profile: { ageAtYearEnd: 60 }, cpfSelf: { roomToLimit: 8_000 } }));
    expect(warning(y2025, 'AGE_55_PLUS_TOPUP').params).toEqual({ ageAtYearEnd: 60, fullRetirementSum: 213_000, roomToLimit: 8_000 });
    expect(warning(y2025, 'AGE_55_PLUS_TOPUP').message).toContain('(S$213,000 in 2025)');
    const y2027 = plan(input({ incomeYear: 2027, today: '2027-06-30', profile: { ageAtYearEnd: 60 }, cpfSelf: { roomToLimit: 8_000 } }));
    expect(warning(y2027, 'AGE_55_PLUS_TOPUP').params).toEqual({ ageAtYearEnd: 60, fullRetirementSum: 228_200, roomToLimit: 8_000 });
    expect(warning(y2027, 'AGE_55_PLUS_TOPUP').message).toContain('(S$228,200 in 2027)');
  });

  it('does not fire below 55, with the lever off, for a foreigner, or while the room is blank', () => {
    const room = { roomToLimit: 4_000 };
    expect(codes(plan(input({ profile: { ageAtYearEnd: 54 }, cpfSelf: room })))).not.toContain('AGE_55_PLUS_TOPUP');
    expect(codes(plan(input({ profile: { ageAtYearEnd: 60 }, cpfSelf: { ...room, enabled: false } })))).not.toContain('AGE_55_PLUS_TOPUP');
    expect(codes(plan(input({ profile: { ageAtYearEnd: 60, residency: 'foreigner' }, cpfSelf: room })))).not.toContain('AGE_55_PLUS_TOPUP');
    expect(codes(plan(input({ profile: { ageAtYearEnd: 60 } })))).not.toContain('AGE_55_PLUS_TOPUP');
    expect(codes(plan(input({ profile: { ageAtYearEnd: 60 }, cpfSelf: { roomToLimit: null } })))).not.toContain('AGE_55_PLUS_TOPUP');
  });

  it('from 55, with own CPF on and open, exactly one of the caution and the note is shown', () => {
    const pair: WarningCode[] = ['CPF_SELF_ROOM_UNCONFIRMED', 'AGE_55_PLUS_TOPUP'];
    for (const ageAtYearEnd of [54, 55, 56, 64, 65, 90]) {
      for (const roomToLimit of [undefined, null, 0, 3_000, 8_000, 20_000]) {
        for (const residency of ['citizen', 'pr'] as const) {
          const shown = codes(plan(input({ profile: { ageAtYearEnd, residency }, cpfSelf: { roomToLimit } }))).filter((code) => pair.includes(code));
          const expected = ageAtYearEnd < 55 ? [] : typeof roomToLimit === 'number' ? ['AGE_55_PLUS_TOPUP'] : ['CPF_SELF_ROOM_UNCONFIRMED'];
          expect({ ageAtYearEnd, roomToLimit, residency, shown }).toEqual({ ageAtYearEnd, roomToLimit, residency, shown: expected });
        }
      }
    }
  });
});

describe('FAMILY_TOPUP_CHECKS', () => {
  const MESSAGE_2026 =
    'Family top-ups: the part the Government matches earns you no relief — the first S$2,000 a year for a member ' +
    'on the Matched Retirement Savings Scheme, S$1,000 for MediSave. The amounts here are top-ups beyond that, to ' +
    'a family member who qualifies.';

  it('fires when the plan puts money into a family top-up', () => {
    // Opening example with the family top-up on: X = L = 31,300, of which 8,000 for family.
    const result = plan(input({ cpfFamily: { enabled: true } }));
    expect(result.plan.contributions.cpfFamily).toBe(8_000);
    const w = warning(result, 'FAMILY_TOPUP_CHECKS');
    expect(w.severity).toBe('caution');
    expect(w.params).toEqual({ planned: 8_000, existing: 0, matchedRetirement: 2_000, matchedMediSave: 1_000 });
    expect(w.message).toBe(MESSAGE_2026);
  });

  it('fires when a family top-up was already made, even with the lever off and nothing planned', () => {
    const result = plan(input({ existing: { cpfTopUpFamily: 1 } }));
    expect(result.levers.cpfFamily.enabled).toBe(false);
    expect(result.plan.contributions.cpfFamily).toBe(0);
    const w = warning(result, 'FAMILY_TOPUP_CHECKS');
    expect(w.params).toEqual({ planned: 0, existing: 1, matchedRetirement: 2_000, matchedMediSave: 1_000 });
    expect(w.message).toBe(MESSAGE_2026);
  });

  it('does not fire when there is neither: lever off, or lever on but no family dollar in the plan', () => {
    expect(codes(plan(input()))).not.toContain('FAMILY_TOPUP_CHECKS');
    // Family on, but a cash limit of 23,300 is used up by SRS (15,300) and own CPF (8,000), which come first.
    const none = plan(input({ cpfFamily: { enabled: true }, preferences: { cashBudget: 23_300 } }));
    expect(none.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 });
    expect(codes(none)).not.toContain('FAMILY_TOPUP_CHECKS');
    // One more dollar of cash reaches the family top-up.
    const one = plan(input({ cpfFamily: { enabled: true }, preferences: { cashBudget: 23_301 } }));
    expect(one.plan.contributions.cpfFamily).toBe(1);
    expect(warning(one, 'FAMILY_TOPUP_CHECKS').params).toMatchObject({ planned: 1, existing: 0 });
    // "Most I would give" of 0.
    expect(codes(plan(input({ cpfFamily: { enabled: true, maxAmount: 0 } })))).not.toContain('FAMILY_TOPUP_CHECKS');
  });

  it('never fires for a foreigner, who gets no relief for family top-ups (§6.5), even with top-ups already made', () => {
    const result = plan(
      input({ profile: { residency: 'foreigner' }, existing: { cpfTopUpFamily: 5_000 }, cpfFamily: { enabled: true } }),
    );
    expect(result.levers.cpfFamily).toMatchObject({ eligible: false, statutoryCap: 0, room: 0 });
    expect(codes(result)).not.toContain('FAMILY_TOPUP_CHECKS');
  });

  it('2025 has no MediSave matching figure; 2027 has both (§5.4)', () => {
    const y2025 = warning(plan(input({ incomeYear: 2025, today: '2025-06-30', cpfFamily: { enabled: true } })), 'FAMILY_TOPUP_CHECKS');
    expect(y2025.params).toEqual({ planned: 8_000, existing: 0, matchedRetirement: 2_000 });
    expect(y2025.message).toBe(
      'Family top-ups: the part the Government matches earns you no relief — the first S$2,000 a year for a member ' +
        'on the Matched Retirement Savings Scheme. The amounts here are top-ups beyond that, to a family member who ' +
        'qualifies.',
    );
    const y2027 = warning(plan(input({ incomeYear: 2027, today: '2027-06-30', cpfFamily: { enabled: true } })), 'FAMILY_TOPUP_CHECKS');
    expect(y2027.params).toEqual({ planned: 8_000, existing: 0, matchedRetirement: 2_000, matchedMediSave: 1_000 });
    expect(y2027.message).toBe(MESSAGE_2026);
  });
});

describe('PARENTHOOD_TAX_REBATE', () => {
  const ticked = (value: unknown): PlannerResult =>
    plan(input({ profile: { hasUnusedParenthoodTaxRebate: value as boolean } }));

  it('fires when the box is ticked, with the normative message', () => {
    const w = warning(ticked(true), 'PARENTHOOD_TAX_REBATE');
    expect(w.severity).toBe('caution');
    expect(w.params).toEqual({});
    expect(w.message).toBe(
      'With unused Parenthood Tax Rebate your tax bill this year may already be S$0. This plan would then save no ' +
        'cash now: it makes the rebate last longer, so the benefit arrives in a later year.',
    );
  });

  it('only the boolean true is a tick: not "true", 1, false, null or a missing field', () => {
    for (const value of ['true', 1, false, null, undefined, 'yes', {}]) {
      expect(codes(ticked(value))).not.toContain('PARENTHOOD_TAX_REBATE');
    }
    expect(codes(plan(input()))).not.toContain('PARENTHOOD_TAX_REBATE');
  });

  it('is independent of everything else: it also shows when no tax is payable or nothing is recommended', () => {
    const noTax = plan(input({ profile: { hasUnusedParenthoodTaxRebate: true }, income: { monthlyOrdinaryWage: 1_500, additionalWages: 0 }, otherReliefs: 0 }));
    expect(codes(noTax)).toEqual(['NO_TAX_PAYABLE', 'PARENTHOOD_TAX_REBATE']);
    const foreigner = plan(input({ profile: { residency: 'foreigner', hasUnusedParenthoodTaxRebate: true }, srs: { enabled: false } }));
    expect(codes(foreigner)).toContain('PARENTHOOD_TAX_REBATE');
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
    // The ending is fixed by SPEC §6.11 (bank cut-offs; a CPF top-up counts on the day it is received).
    const ending =
      'Banks stop taking same-day SRS contributions before midnight on the last day, some as early as 7pm, and a ' +
      'CPF top-up counts on the day the CPF Board receives it, so transfer as soon as you can.';
    expect(fourteen.message).toBe(`Only 14 days left until the 31 December 2026 deadline. ${ending}`);
    expect(warning(plan(input({ today: '2026-12-30' })), 'DEADLINE_SOON').message).toBe(
      `Only 1 day left until the 31 December 2026 deadline. ${ending}`,
    );
    const lastDay = warning(plan(input({ today: '2026-12-31' })), 'DEADLINE_SOON');
    expect(lastDay.params).toEqual({ deadline: '2026-12-31', daysToDeadline: 0 });
    expect(lastDay.message).toBe(`Today, 31 December 2026, is the deadline. ${ending}`);
    expect(lastDay.message).not.toContain('can stop taking contributions earlier');
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
    plan(input({ profile: { residency: 'foreigner' }, income: { monthsWorked: 6 } })),
    plan(input({ profile: { residency: 'pr', prYear: 1, ageAtYearEnd: 60 } })),
    plan(input({ profile: { residency: 'pr', prYear: 3, ageAtYearEnd: 60 }, cpfSelf: { roomToLimit: 2_000 } })),
    plan(input({ cpfFamily: { enabled: true } })),
    plan(input({ profile: { hasUnusedParenthoodTaxRebate: true } })),
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
    // 2nd-year PR aged 60 on the last day of projected 2027, with the CPF self lever on and its room left blank:
    // L = 15,300 (SRS only) is the smallest of U, C, L, so the schemes bind and something is recommended.
    const result = plan(input({ incomeYear: 2027, today: '2027-12-31', profile: { residency: 'pr', prYear: 2, ageAtYearEnd: 60 } }));
    expect(codes(result)).toEqual([
      'LEVER_LIMITS_PLAN',
      'PR_GRADUATED_RATES',
      'CPF_SELF_ROOM_UNCONFIRMED',
      'DEADLINE_SOON',
      'PROJECTED_RULES',
    ]);
  });

  it('a citizen-or-PR pile-up comes out in the order of the SPEC table', () => {
    // 1st-year PR aged 60 in projected 2027, on the last day: CPF figure 25,000 entered (held at 20,400), S$9,000
    // already given to family (over the 8,000 cap), own CPF room entered as 2,000, the tick-box ticked.
    // Reliefs 8,000 + 20,400 + 8,000 + 5,000 = 41,400 -> CI 93,600 (tax 4,914.00). U = 53,600, C = 38,600,
    // L = 15,300 + 2,000 + 0 = 17,300 -> the schemes bind and S$17,300 is recommended.
    const result = plan(
      input({
        incomeYear: 2027,
        today: '2027-12-31',
        profile: { residency: 'pr', prYear: 1, ageAtYearEnd: 60, hasUnusedParenthoodTaxRebate: true },
        income: { employeeCpfOverride: 25_000 },
        existing: { cpfTopUpFamily: 9_000 },
        cpfSelf: { roomToLimit: 2_000 },
        cpfFamily: { enabled: true },
      }),
    );
    expect(result.baseline.taxPayable).toBe(4_914);
    expect(result.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 2_000, cpfFamily: 0 });
    expect(codes(result)).toEqual([
      'LEVER_LIMITS_PLAN',
      'EXISTING_EXCEEDS_CAP',
      'CPF_OVERRIDE_ABOVE_MAX',
      'PR_GRADUATED_RATES',
      'AGE_55_PLUS_TOPUP',
      'FAMILY_TOPUP_CHECKS',
      'PARENTHOOD_TAX_REBATE',
      'DEADLINE_SOON',
      'PROJECTED_RULES',
    ]);
  });

  it('a foreigner pile-up comes out in the order of the SPEC table', () => {
    // Foreigner, 6 months worked, seen the day after the deadline, tick-box ticked. Income 60,000 + 15,000;
    // reliefs 1,000 + 5,000 -> CI 69,000 (tax 550 + 7% x 29,000 = 2,580.00). U = 29,000 is the smallest limit,
    // so no plan-limit warning; the whole plan is on the 7% rung.
    const adult = plan(
      input({
        today: '2027-01-01',
        profile: { residency: 'foreigner', hasUnusedParenthoodTaxRebate: true },
        income: { monthsWorked: 6 },
      }),
    );
    expect(adult.baseline.taxPayable).toBe(2_580);
    expect(adult.plan.contributions).toEqual({ srs: 29_000, cpfSelf: 0, cpfFamily: 0 });
    expect(codes(adult)).toEqual([
      'FOREIGNER_NO_CPF',
      'TAX_RESIDENCY_CHECK',
      'SRS_NON_RESIDENT_WITHDRAWAL',
      'PARENTHOOD_TAX_REBATE',
      'DEADLINE_PASSED',
    ]);
    expect(warning(adult, 'SRS_NON_RESIDENT_WITHDRAWAL').params).toMatchObject({ lowValueAmount: 29_000 });
    // The same person at 17 has no scheme at all: the tick-box caution still comes before SRS_UNDER_18.
    const minor = plan(
      input({
        profile: { residency: 'foreigner', ageAtYearEnd: 17, hasUnusedParenthoodTaxRebate: true },
        income: { monthsWorked: 6 },
      }),
    );
    expect(codes(minor)).toEqual(['LEVER_LIMITS_PLAN', 'FOREIGNER_NO_CPF', 'TAX_RESIDENCY_CHECK', 'PARENTHOOD_TAX_REBATE', 'SRS_UNDER_18']);
  });
});
