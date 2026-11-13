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

  it('warnings: FOREIGNER_NO_CPF and the SRS withdrawal caution, and no existing-over-cap warning for CPF top-ups', () => {
    // A foreigner with SRS switched on and open to them always gets SRS_NON_RESIDENT_WITHDRAWAL (§6.11). The plan
    // sits in the 19% and 18% rungs, so none of it is worth less than the 7.5 cents it costs to take out.
    expect(result.warnings.map((w) => w.code)).toEqual(['LEVER_LIMITS_PLAN', 'FOREIGNER_NO_CPF', 'SRS_NON_RESIDENT_WITHDRAWAL']);
    expect(result.warnings[1]?.params).toEqual({ srsCap: 35_700 });
    expect(result.warnings[2]?.params).toMatchObject({ lowValueAmount: 0 });
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

describe('CPF self room from age 55 must be confirmed (§6.5)', () => {
  // The opening example at 54 and at 55 (December birthday, so the CPF rate is 20% all year in both cases).
  // 54: EIR 1,000 -> reliefs 26,400, CI 108,600, tax 6,639.00 (Appendix A.1).
  // 55: EIR 6,000 -> reliefs 31,400, CI 103,600, tax 3,350 + 11.5% x 23,600 = 6,064.00. U = 63,600, C = 48,600.
  const at = (ageAtYearEnd: number, cpfSelf: Overrides['cpfSelf'] = {}, more: Overrides = {}) =>
    plan(input({ ...more, profile: { ...more.profile, ageAtYearEnd }, cpfSelf }));
  const codes = (result: ReturnType<typeof plan>): string[] => result.warnings.map((w) => w.code);

  it('54 with the room left blank: the limits are assumed not to bind (room 8,000)', () => {
    const result = at(54);
    expect(result.baseline.taxPayable).toBe(6_639);
    expect(result.levers.cpfSelf).toEqual({ statutoryCap: 8_000, used: 0, room: 8_000, eligible: true, enabled: true });
    expect(result.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 });
    expect(result.plan.taxSaved).toBe(2_679.5);
    expect(codes(result)).toEqual(['LEVER_LIMITS_PLAN']);
  });

  it('55 with the room left blank: room 0, the plan is SRS only, and the caution asks for the figure', () => {
    const result = at(55);
    expect(result.cpf.employeeContribution).toBe(20_400);
    expect(result.baseline.reliefs.earnedIncome).toBe(6_000);
    expect(result.baseline.chargeableIncome).toBe(103_600);
    expect(result.baseline.taxPayable).toBe(6_064);
    expect(result.levers.cpfSelf).toEqual({ statutoryCap: 8_000, used: 0, room: 0, eligible: true, enabled: true });
    // X = min(U 63,600, C 48,600, L 15,300) = 15,300. CI 88,300 -> 3,350 + 11.5% x 8,300 = 4,304.50.
    expect(result.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 0 });
    expect(result.plan.totalContribution).toBe(15_300);
    expect(result.plan.bindingConstraint).toBe('leverLimits');
    expect(result.plan.taxAfter).toBe(4_304.5);
    expect(result.plan.taxSaved).toBe(1_759.5); // 15,300 x 11.5%
    // min(U, C) = 48,600 -> CI 55,000 -> 1,600.00; 4,304.50 - 1,600.00
    expect(result.plan.unrealisedSaving).toBe(2_704.5);
    expect(codes(result)).toEqual(['LEVER_LIMITS_PLAN', 'CPF_SELF_ROOM_UNCONFIRMED']);
  });

  it('55, blank: the ladder and the simulator stop at the SRS room (L = 15,300)', () => {
    const result = at(55);
    expect(result.ladder).toEqual([
      { fromContribution: 0, toContribution: 15_300, amount: 15_300, rate: 0.115, taxSaved: 1_759.5, cumulativeTaxSaved: 1_759.5, usedByPlan: 15_300 },
    ]);
    expect(result.simulator).toHaveLength(17); // 0, 1,000 ... 15,000, 15,300
    expect(result.simulator[16]).toMatchObject({ contribution: 15_300, split: { srs: 15_300, cpfSelf: 0, cpfFamily: 0 }, taxSaved: 1_759.5 });
    expect(result.simulator.every((row) => row.split.cpfSelf === 0)).toBe(true);
  });

  it('55, blank: the scenarios of §6.9 use roomIfEnabled, so "CPF only" is empty', () => {
    const byId = Object.fromEntries(at(55).scenarios.map((s) => [s.id, s]));
    expect(byId.srsOnly).toMatchObject({ contributions: { srs: 15_300, cpfSelf: 0, cpfFamily: 0 }, taxPayable: 4_304.5, taxSaved: 1_759.5 });
    expect(byId.cpfSelfOnly).toMatchObject({
      contributions: { srs: 0, cpfSelf: 0, cpfFamily: 0 },
      totalContribution: 0,
      taxPayable: 6_064,
      taxSaved: 0,
      savingRate: 0,
      wastedContribution: 0,
    });
    expect(byId.srsPlusCpfSelf).toMatchObject({ contributions: { srs: 15_300, cpfSelf: 0, cpfFamily: 0 }, totalContribution: 15_300, taxSaved: 1_759.5 });
    expect(byId.maxAll).toMatchObject({ contributions: { srs: 15_300, cpfSelf: 0, cpfFamily: 0 }, totalContribution: 15_300, taxSaved: 1_759.5 });
    expect(byId.recommended).toMatchObject({ contributions: { srs: 15_300, cpfSelf: 0, cpfFamily: 0 }, totalContribution: 15_300 });
    // Also when the lever is switched off: the scenario ignores the flag but not the unconfirmed room.
    const off = Object.fromEntries(at(55, { enabled: false }).scenarios.map((s) => [s.id, s]));
    expect(off.cpfSelfOnly?.totalContribution).toBe(0);
    // At 54 the same scenario is the full 8,000: 8,000 x 11.5% = 920.00.
    const younger = Object.fromEntries(at(54).scenarios.map((s) => [s.id, s]));
    expect(younger.cpfSelfOnly).toMatchObject({ contributions: { srs: 0, cpfSelf: 8_000, cpfFamily: 0 }, taxSaved: 920 });
  });

  it('55, blank: LEVER_LIMITS_PLAN counts only the family top-up as room that can be switched on', () => {
    // Sum of roomIfEnabled = 15,300 (SRS) + 0 (own CPF, unconfirmed) + 8,000 (family, off) = 23,300.
    // From CI 88,300 the 8,000 family dollars are all at 11.5%: 920.00. (Counting the unconfirmed 8,000 as well
    // would have promised 8,300 x 11.5% + 7,700 x 7% = 1,493.50.)
    const limit = at(55).warnings.find((w) => w.code === 'LEVER_LIMITS_PLAN');
    expect(limit?.params).toEqual({ leverRoom: 15_300, unrealisedSaving: 2_704.5, savingIfSwitchedOn: 920 });
    expect(limit?.message).toBe(
      'The plan uses all S$15,300 of room left in the schemes you switched on. ' +
        'Switching on the schemes you left off could save up to S$920.00 more tax.',
    );
    // With the family top-up on as well there is nothing left to switch on.
    const allOn = at(55, {}, { cpfFamily: { enabled: true } });
    expect(allOn.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 8_000 });
    expect(allOn.warnings.find((w) => w.code === 'LEVER_LIMITS_PLAN')?.params).toMatchObject({ leverRoom: 23_300, savingIfSwitchedOn: 0 });
    // Own CPF switched OFF at 55 with a blank room: still not counted (roomIfEnabled is 0), so 920.00 again;
    // at 54 the same switch is worth the full 16,000: tax(93,300) - tax(77,300) = 4,879.50 - 3,161.00 = 1,718.50.
    expect(at(55, { enabled: false }).warnings.find((w) => w.code === 'LEVER_LIMITS_PLAN')?.params).toMatchObject({ savingIfSwitchedOn: 920 });
    expect(at(54, { enabled: false }).warnings.find((w) => w.code === 'LEVER_LIMITS_PLAN')?.params).toMatchObject({ savingIfSwitchedOn: 1_718.5 });
  });

  it('55 with a room of 0: confirmed as nothing — the same plan, but the note instead of the caution', () => {
    const result = at(55, { roomToLimit: 0 });
    expect(result.levers.cpfSelf.room).toBe(0);
    expect(result.plan).toEqual(at(55).plan);
    expect(codes(result)).toEqual(['LEVER_LIMITS_PLAN', 'AGE_55_PLUS_TOPUP']);
  });

  it('55 with a room entered: the smaller of the room and what is left of the S$8,000 cap', () => {
    // 3,000: X = 18,300 -> CI 85,300 -> 3,959.50; saved 2,104.50.
    const some = at(55, { roomToLimit: 3_000 });
    expect(some.levers.cpfSelf.room).toBe(3_000);
    expect(some.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 3_000, cpfFamily: 0 });
    expect(some.plan.taxAfter).toBe(3_959.5);
    expect(some.plan.taxSaved).toBe(2_104.5);
    expect(codes(some)).toEqual(['LEVER_LIMITS_PLAN', 'AGE_55_PLUS_TOPUP']);
    // 8,000, 8,001 and 50,000 all confirm the whole cap: X = 23,300 -> CI 80,300 -> 3,350 + 34.50 = 3,384.50.
    for (const roomToLimit of [8_000, 8_001, 50_000]) {
      const full = at(55, { roomToLimit });
      expect(full.levers.cpfSelf.room).toBe(8_000);
      expect(full.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 });
      expect(full.plan.taxAfter).toBe(3_384.5);
      expect(full.plan.taxSaved).toBe(2_679.5);
      expect(codes(full)).toEqual(['LEVER_LIMITS_PLAN', 'AGE_55_PLUS_TOPUP']);
    }
  });

  it('55: existing top-ups still come off the cap first', () => {
    // 6,000 already topped up: 2,000 of the cap is left. Blank -> 0; room 5,000 -> 2,000; room 500 -> 500.
    expect(at(55, {}, { existing: { cpfTopUpSelf: 6_000 } }).levers.cpfSelf).toMatchObject({ used: 6_000, room: 0 });
    expect(at(55, { roomToLimit: 5_000 }, { existing: { cpfTopUpSelf: 6_000 } }).levers.cpfSelf).toMatchObject({ used: 6_000, room: 2_000 });
    expect(at(55, { roomToLimit: 500 }, { existing: { cpfTopUpSelf: 6_000 } }).levers.cpfSelf).toMatchObject({ used: 6_000, room: 500 });
  });

  it('54: a room that is entered still limits the plan, and a large one changes nothing', () => {
    expect(at(54, { roomToLimit: 0 }).levers.cpfSelf.room).toBe(0);
    expect(at(54, { roomToLimit: 3_000 }).levers.cpfSelf.room).toBe(3_000);
    expect(at(54, { roomToLimit: 50_000 }).levers.cpfSelf.room).toBe(8_000);
    for (const roomToLimit of [0, 3_000, 50_000]) {
      expect(codes(at(54, { roomToLimit }))).not.toContain('AGE_55_PLUS_TOPUP');
      expect(codes(at(54, { roomToLimit }))).not.toContain('CPF_SELF_ROOM_UNCONFIRMED');
    }
  });

  it('every age from 55 up needs the room; "not a number" is not a room', () => {
    for (const ageAtYearEnd of [55, 56, 60, 65, 70, 99, 120]) {
      expect(at(ageAtYearEnd).levers.cpfSelf.room).toBe(0);
      expect(at(ageAtYearEnd, { roomToLimit: 8_000 }).levers.cpfSelf.room).toBe(8_000);
    }
    for (const notANumber of [undefined, null, '8000', true, {}]) {
      const result = at(55, { roomToLimit: notANumber as unknown as number });
      expect(result.input.levers.cpfSelf.roomToLimit).toBeNull();
      expect(result.levers.cpfSelf.room).toBe(0);
    }
    // NaN and a negative number ARE numbers: a limit of 0 (§6.0), which counts as entered.
    for (const zeroLimit of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const result = at(55, { roomToLimit: zeroLimit });
      expect(result.input.levers.cpfSelf.roomToLimit).toBe(0);
      expect(result.levers.cpfSelf.room).toBe(0);
      expect(codes(result)).toContain('AGE_55_PLUS_TOPUP');
      expect(codes(result)).not.toContain('CPF_SELF_ROOM_UNCONFIRMED');
    }
  });

  it('the rule is about own CPF only: SRS and the family top-up are not held back at 55', () => {
    const result = at(55, {}, { cpfFamily: { enabled: true } });
    expect(result.levers.srs.room).toBe(15_300);
    expect(result.levers.cpfFamily.room).toBe(8_000);
    // A foreigner aged 60 has no CPF lever at all: cap 0, room 0, with or without a figure.
    const foreigner = at(60, { roomToLimit: 8_000 }, { profile: { residency: 'foreigner' } });
    expect(foreigner.levers.cpfSelf).toEqual({ statutoryCap: 0, used: 0, room: 0, eligible: false, enabled: true });
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
