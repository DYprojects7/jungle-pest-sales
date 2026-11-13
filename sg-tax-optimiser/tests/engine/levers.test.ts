/**
 * SPEC §6.5 — lever eligibility, statutory caps and room; existing contributions over the caps.
 */
import { describe, expect, it } from 'vitest';
import { defaultInput, plan } from '../../src/engine';
import type { PlannerInput } from '../../src/engine';
import { allocate } from '../../src/engine/levers';

type Overrides = {
  incomeYear?: number;
  profile?: Partial<PlannerInput['profile']>;
  income?: Partial<PlannerInput['income']>;
  existing?: Partial<PlannerInput['existing']>;
  otherReliefs?: number;
  srs?: Partial<PlannerInput['levers']['srs']>;
  cpfSelf?: Partial<PlannerInput['levers']['cpfSelf']>;
  cpfFamily?: Partial<PlannerInput['levers']['cpfFamily']>;
  preferences?: Partial<PlannerInput['preferences']>;
};

/** The opening example (2026, SRS and CPF self on, family off) with some fields replaced. */
function input(overrides: Overrides = {}): PlannerInput {
  const base = defaultInput('2026-06-30');
  return {
    ...base,
    incomeYear: overrides.incomeYear ?? base.incomeYear,
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

describe('statutory caps and eligibility', () => {
  it('citizen: SRS 15,300, CPF self 8,000, CPF family 8,000', () => {
    const { levers } = plan(input({ cpfFamily: { enabled: true } }));
    expect(levers).toEqual({
      srs: { statutoryCap: 15_300, used: 0, room: 15_300, eligible: true, enabled: true },
      cpfSelf: { statutoryCap: 8_000, used: 0, room: 8_000, eligible: true, enabled: true },
      cpfFamily: { statutoryCap: 8_000, used: 0, room: 8_000, eligible: true, enabled: true },
    });
  });

  it('PR: the same caps as a citizen', () => {
    const { levers } = plan(input({ profile: { residency: 'pr', prYear: 1 }, cpfFamily: { enabled: true } }));
    expect(levers.srs.statutoryCap).toBe(15_300);
    expect(levers.cpfSelf).toMatchObject({ statutoryCap: 8_000, eligible: true, room: 8_000 });
    expect(levers.cpfFamily).toMatchObject({ statutoryCap: 8_000, eligible: true, room: 8_000 });
  });

  it('the same caps apply in all three income years', () => {
    for (const incomeYear of [2025, 2026, 2027]) {
      const { levers } = plan(input({ incomeYear, cpfFamily: { enabled: true } }));
      expect([levers.srs.statutoryCap, levers.cpfSelf.statutoryCap, levers.cpfFamily.statutoryCap]).toEqual([
        15_300, 8_000, 8_000,
      ]);
    }
  });

  it('a disabled lever keeps its cap and usage but has no room', () => {
    const { levers } = plan(input({ srs: { enabled: false }, existing: { srs: 4_000 } }));
    expect(levers.srs).toEqual({ statutoryCap: 15_300, used: 4_000, room: 0, eligible: true, enabled: false });
  });
});

describe('foreigner', () => {
  // Foreigner, 40, S$15,000 x 12 + S$30,000 bonus, no other reliefs, every lever switched on.
  const result = plan(
    input({
      profile: { residency: 'foreigner', ageAtYearEnd: 40 },
      income: { monthlyOrdinaryWage: 15_000, additionalWages: 30_000 },
      otherReliefs: 0,
      cpfFamily: { enabled: true },
    }),
  );

  it('no CPF, SRS cap 35,700, CPF top-up levers not eligible', () => {
    expect(result.cpf.source).toBe('none');
    expect(result.cpf.employeeContribution).toBe(0);
    expect(result.levers).toEqual({
      srs: { statutoryCap: 35_700, used: 0, room: 35_700, eligible: true, enabled: true },
      cpfSelf: { statutoryCap: 0, used: 0, room: 0, eligible: false, enabled: true },
      cpfFamily: { statutoryCap: 0, used: 0, room: 0, eligible: false, enabled: true },
    });
  });

  it('baseline: income 210,000, only the 1,000 Earned Income Relief -> tax 22,860.00', () => {
    expect(result.baseline.reliefs.cpf).toBe(0);
    expect(result.baseline.reliefs.totalBeforeCap).toBe(1_000);
    expect(result.baseline.chargeableIncome).toBe(209_000);
    expect(result.baseline.taxPayable).toBe(22_860); // 21,150 + 19% x 9,000
  });

  it('plan: the whole 35,700 into SRS, saving 6,516.00 across two brackets', () => {
    // U = 209,000 - 40,000 = 169,000; C = 79,000; L = 35,700 -> X = 35,700 (leverLimits)
    expect(result.plan.contributions).toEqual({ srs: 35_700, cpfSelf: 0, cpfFamily: 0 });
    expect(result.plan.bindingConstraint).toBe('leverLimits');
    expect(result.plan.chargeableIncomeAfter).toBe(173_300);
    expect(result.plan.taxAfter).toBe(16_344); // 13,950 + 18% x 13,300
    expect(result.plan.taxSaved).toBe(6_516); // 9,000 x 19% + 26,700 x 18% = 1,710 + 4,806
    expect(result.plan.marginalRateAfter).toBe(0.18);
    // min(U, C) = 79,000 -> chargeable income 130,000 -> 7,950 + 1,500 = 9,450; 16,344 - 9,450
    expect(result.plan.unrealisedSaving).toBe(6_894);
  });

  it('ladder: 9,000 at 19% then 26,700 at 18%', () => {
    expect(result.ladder).toEqual([
      {
        fromContribution: 0,
        toContribution: 9_000,
        amount: 9_000,
        rate: 0.19,
        taxSaved: 1_710,
        cumulativeTaxSaved: 1_710,
        usedByPlan: 9_000,
      },
      {
        fromContribution: 9_000,
        toContribution: 35_700,
        amount: 26_700,
        rate: 0.18,
        taxSaved: 4_806,
        cumulativeTaxSaved: 6_516,
        usedByPlan: 26_700,
      },
    ]);
  });

  it('scenarios never include CPF top-ups', () => {
    for (const scenario of result.scenarios) {
      expect(scenario.contributions.cpfSelf).toBe(0);
      expect(scenario.contributions.cpfFamily).toBe(0);
    }
    const maxAll = result.scenarios.find((s) => s.id === 'maxAll');
    expect(maxAll).toMatchObject({ totalContribution: 35_700, taxSaved: 6_516, wastedContribution: 0 });
  });

  it('warnings: FOREIGNER_NO_CPF, and no existing-over-cap warning for CPF top-ups', () => {
    expect(result.warnings.map((w) => w.code)).toEqual(['LEVER_LIMITS_PLAN', 'FOREIGNER_NO_CPF']);
    expect(result.warnings[1]?.params).toEqual({ srsCap: 35_700 });
  });

  it('CPF top-ups already made earn a foreigner no relief', () => {
    const withTopUps = plan(
      input({
        profile: { residency: 'foreigner' },
        existing: { srs: 20_000, cpfTopUpSelf: 5_000, cpfTopUpFamily: 9_000 },
        cpfFamily: { enabled: true },
      }),
    );
    expect(withTopUps.baseline.reliefs.srs).toBe(20_000);
    expect(withTopUps.baseline.reliefs.cpfTopUpSelf).toBe(0);
    expect(withTopUps.baseline.reliefs.cpfTopUpFamily).toBe(0);
    expect(withTopUps.levers.srs).toMatchObject({ used: 20_000, room: 15_700 });
    expect(withTopUps.levers.cpfSelf.used).toBe(0);
    expect(withTopUps.levers.cpfFamily.used).toBe(0);
    expect(withTopUps.warnings.map((w) => w.code)).not.toContain('EXISTING_EXCEEDS_CAP');
  });
});

describe('SRS minimum age', () => {
  it('under 18: SRS is not eligible and the plan uses CPF only', () => {
    const result = plan(input({ profile: { ageAtYearEnd: 17 } }));
    expect(result.levers.srs).toEqual({ statutoryCap: 0, used: 0, room: 0, eligible: false, enabled: true });
    expect(result.levers.cpfSelf.room).toBe(8_000);
    expect(result.plan.contributions).toEqual({ srs: 0, cpfSelf: 8_000, cpfFamily: 0 });
    expect(result.plan.taxSaved).toBe(920); // 8,000 x 11.5%
    const warning = result.warnings.find((w) => w.code === 'SRS_UNDER_18');
    expect(warning?.severity).toBe('caution');
    expect(warning?.params).toEqual({ ageAtYearEnd: 17, minAge: 18 });
  });

  it('under 18: SRS already contributed earns no relief and the SRS scenario is empty', () => {
    const result = plan(input({ profile: { ageAtYearEnd: 17 }, existing: { srs: 3_000 } }));
    expect(result.baseline.reliefs.srs).toBe(0);
    expect(result.scenarios.find((s) => s.id === 'srsOnly')?.totalContribution).toBe(0);
  });

  it('18: eligible', () => {
    const result = plan(input({ profile: { ageAtYearEnd: 18 } }));
    expect(result.levers.srs).toMatchObject({ statutoryCap: 15_300, eligible: true, room: 15_300 });
    expect(result.warnings.map((w) => w.code)).not.toContain('SRS_UNDER_18');
  });
});

describe('existing contributions', () => {
  it('reduce the room and already count as relief', () => {
    const result = plan(input({ existing: { srs: 5_000, cpfTopUpSelf: 2_000, cpfTopUpFamily: 1_000 } }));
    expect(result.levers.srs).toMatchObject({ used: 5_000, room: 10_300 });
    expect(result.levers.cpfSelf).toMatchObject({ used: 2_000, room: 6_000 });
    expect(result.levers.cpfFamily).toMatchObject({ used: 1_000, room: 0 }); // switched off
    expect(result.baseline.reliefs).toMatchObject({ srs: 5_000, cpfTopUpSelf: 2_000, cpfTopUpFamily: 1_000 });
    expect(result.baseline.chargeableIncome).toBe(100_600); // 108,600 - 8,000
    expect(result.plan.contributions).toEqual({ srs: 10_300, cpfSelf: 6_000, cpfFamily: 0 });
  });

  it('exactly at the cap: no room, no warning', () => {
    const result = plan(input({ existing: { srs: 15_300, cpfTopUpSelf: 8_000 } }));
    expect(result.levers.srs).toMatchObject({ used: 15_300, room: 0 });
    expect(result.levers.cpfSelf).toMatchObject({ used: 8_000, room: 0 });
    expect(result.plan.totalContribution).toBe(0);
    expect(result.warnings.map((w) => w.code)).not.toContain('EXISTING_EXCEEDS_CAP');
  });

  it('over the caps: relief stops at the cap, there is no room, and EXISTING_EXCEEDS_CAP is raised', () => {
    const result = plan(
      input({
        existing: { srs: 20_000, cpfTopUpSelf: 9_000, cpfTopUpFamily: 10_000 },
        cpfFamily: { enabled: true },
      }),
    );
    expect(result.levers.srs).toMatchObject({ statutoryCap: 15_300, used: 15_300, room: 0 });
    expect(result.levers.cpfSelf).toMatchObject({ statutoryCap: 8_000, used: 8_000, room: 0 });
    expect(result.levers.cpfFamily).toMatchObject({ statutoryCap: 8_000, used: 8_000, room: 0 });
    expect(result.baseline.reliefs).toMatchObject({
      srs: 15_300,
      cpfTopUpSelf: 8_000,
      cpfTopUpFamily: 8_000,
      totalBeforeCap: 57_700, // 26,400 + 31,300
    });
    expect(result.baseline.chargeableIncome).toBe(77_300);
    expect(result.plan.totalContribution).toBe(0);
    expect(result.plan.bindingConstraint).toBe('leverLimits');

    const warnings = result.warnings.filter((w) => w.code === 'EXISTING_EXCEEDS_CAP');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe('caution');
    expect(warnings[0]?.params).toEqual({
      levers: 'srs,cpfSelf,cpfFamily',
      srsExisting: 20_000,
      srsCap: 15_300,
      srsExcess: 4_700,
      cpfSelfExisting: 9_000,
      cpfSelfCap: 8_000,
      cpfSelfExcess: 1_000,
      cpfFamilyExisting: 10_000,
      cpfFamilyCap: 8_000,
      cpfFamilyExcess: 2_000,
    });
  });

  it('SRS over the cap: the plan still fills the other lever', () => {
    // relief: 26,400 + 15,300 = 41,700 -> chargeable income 93,300 -> 3,350 + 11.5% x 13,300 = 4,879.50
    const result = plan(input({ existing: { srs: 20_000 } }));
    expect(result.baseline.taxPayable).toBe(4_879.5);
    expect(result.plan.contributions).toEqual({ srs: 0, cpfSelf: 8_000, cpfFamily: 0 });
    expect(result.plan.taxAfter).toBe(3_959.5);
    expect(result.plan.taxSaved).toBe(920);
    expect(result.warnings.find((w) => w.code === 'EXISTING_EXCEEDS_CAP')?.params).toEqual({
      levers: 'srs',
      srsExisting: 20_000,
      srsCap: 15_300,
      srsExcess: 4_700,
    });
  });
});

describe('user limits', () => {
  it('roomToLimit caps the CPF self room', () => {
    expect(plan(input({ cpfSelf: { roomToLimit: 3_000 } })).levers.cpfSelf.room).toBe(3_000);
    expect(plan(input({ cpfSelf: { roomToLimit: 0 } })).levers.cpfSelf.room).toBe(0);
    expect(plan(input({ cpfSelf: { roomToLimit: 50_000 } })).levers.cpfSelf.room).toBe(8_000);
    expect(plan(input({ cpfSelf: { roomToLimit: null } })).levers.cpfSelf.room).toBe(8_000);
  });

  it('roomToLimit applies after existing top-ups', () => {
    // statutory room 8,000 - 6,000 = 2,000; the smaller of that and the limit wins
    expect(plan(input({ existing: { cpfTopUpSelf: 6_000 }, cpfSelf: { roomToLimit: 3_000 } })).levers.cpfSelf.room).toBe(2_000);
    expect(plan(input({ existing: { cpfTopUpSelf: 6_000 }, cpfSelf: { roomToLimit: 500 } })).levers.cpfSelf.room).toBe(500);
  });

  it('maxAmount caps the family room', () => {
    expect(plan(input({ cpfFamily: { enabled: true, maxAmount: 2_500 } })).levers.cpfFamily.room).toBe(2_500);
    expect(plan(input({ cpfFamily: { enabled: true, maxAmount: null } })).levers.cpfFamily.room).toBe(8_000);
    expect(plan(input({ cpfFamily: { enabled: true, maxAmount: 20_000 } })).levers.cpfFamily.room).toBe(8_000);
    expect(plan(input({ cpfFamily: { enabled: false, maxAmount: 2_500 } })).levers.cpfFamily.room).toBe(0);
  });

  it('the plan and the scenarios respect the limits', () => {
    const result = plan(input({ cpfSelf: { roomToLimit: 3_000 }, cpfFamily: { enabled: true, maxAmount: 2_500 } }));
    expect(result.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 3_000, cpfFamily: 2_500 });
    expect(result.scenarios.find((s) => s.id === 'cpfSelfOnly')?.contributions.cpfSelf).toBe(3_000);
    expect(result.scenarios.find((s) => s.id === 'maxAll')?.contributions).toEqual({
      srs: 15_300,
      cpfSelf: 3_000,
      cpfFamily: 2_500,
    });
  });
});

describe('allocation by priority (§6.6)', () => {
  const rooms = { srs: 15_300, cpfSelf: 8_000, cpfFamily: 8_000 };

  it('fills levers in the given order', () => {
    expect(allocate(20_000, rooms, ['srs', 'cpfSelf', 'cpfFamily'])).toEqual({ srs: 15_300, cpfSelf: 4_700, cpfFamily: 0 });
    expect(allocate(20_000, rooms, ['cpfSelf', 'srs', 'cpfFamily'])).toEqual({ srs: 12_000, cpfSelf: 8_000, cpfFamily: 0 });
    expect(allocate(20_000, rooms, ['cpfFamily', 'srs', 'cpfSelf'])).toEqual({ srs: 12_000, cpfSelf: 0, cpfFamily: 8_000 });
    expect(allocate(0, rooms, ['srs', 'cpfSelf', 'cpfFamily'])).toEqual({ srs: 0, cpfSelf: 0, cpfFamily: 0 });
    expect(allocate(31_300, rooms, ['cpfFamily', 'cpfSelf', 'srs'])).toEqual(rooms);
  });

  it('the plan follows preferences.priority', () => {
    const familyFirst = plan(
      input({
        cpfFamily: { enabled: true },
        preferences: { cashBudget: 10_000, priority: ['cpfFamily', 'srs', 'cpfSelf'] },
      }),
    );
    expect(familyFirst.plan.contributions).toEqual({ cpfFamily: 8_000, srs: 2_000, cpfSelf: 0 });

    const interestFirst = plan(input({ preferences: { cashBudget: 10_000, priority: ['cpfSelf', 'srs', 'cpfFamily'] } }));
    expect(interestFirst.plan.contributions).toEqual({ cpfSelf: 8_000, srs: 2_000, cpfFamily: 0 });
    // the order changes the split, not the tax
    expect(interestFirst.plan.taxSaved).toBe(familyFirst.plan.taxSaved);
    expect(interestFirst.plan.taxSaved).toBe(1_150); // 10,000 x 11.5%
  });
});
