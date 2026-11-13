/**
 * Adversarial review — hand-computed end-to-end cases.
 *
 * Every expected number in this file was worked out by hand from SPEC.md §5 and §6 (the arithmetic is in the
 * comment above each assertion), NOT read back from the engine. Inputs are built from scratch (not from
 * `defaultInput`) so that this file does not share assumptions with tests/engine.
 *
 * Tax table used throughout (SPEC §5.1), cumulative tax at the start of each band:
 *   20,000 -> 0 · 30,000 -> 200 · 40,000 -> 550 · 80,000 -> 3,350 · 120,000 -> 7,950 · 160,000 -> 13,950
 *   200,000 -> 21,150 · 240,000 -> 28,750 · 280,000 -> 36,550 · 320,000 -> 44,550 · 500,000 -> 84,150
 *   1,000,000 -> 199,150; rates 0 / 2 / 3.5 / 7 / 11.5 / 15 / 18 / 19 / 19.5 / 20 / 22 / 23 / 24 %.
 */
import { describe, expect, it } from 'vitest';
import { computeCpf, evaluate, getRules, plan } from '../../src/engine';
import type { LeverId, PlannerInput, PlannerResult, PrYear, Residency } from '../../src/engine';

interface Person {
  incomeYear?: number;
  today?: string;
  residency?: Residency;
  prYear?: PrYear;
  age?: number;
  birthMonth?: number;
  ow?: number;
  months?: number;
  aw?: number;
  otherIncome?: number;
  expenses?: number;
  donations?: number;
  override?: number | null;
  existingSrs?: number;
  existingSelf?: number;
  existingFamily?: number;
  otherReliefs?: number;
  srsOn?: boolean;
  selfOn?: boolean;
  familyOn?: boolean;
  roomToLimit?: number | null;
  maxAmount?: number | null;
  budget?: number | null;
  minRate?: number;
  priority?: LeverId[];
  step?: number;
}

/** A complete PlannerInput. Defaults: citizen, 35, 2026, mid-June, SRS + CPF self on, family off, min rate 0. */
function person(p: Person = {}): PlannerInput {
  const incomeYear = p.incomeYear ?? 2026;
  return {
    incomeYear,
    today: p.today ?? `${incomeYear}-06-15`,
    profile: {
      residency: p.residency ?? 'citizen',
      prYear: p.prYear ?? 3,
      ageAtYearEnd: p.age ?? 35,
      birthMonth: p.birthMonth ?? 12,
    },
    income: {
      monthlyOrdinaryWage: p.ow ?? 0,
      monthsWorked: p.months ?? 12,
      additionalWages: p.aw ?? 0,
      otherTaxableIncome: p.otherIncome ?? 0,
      employmentExpenses: p.expenses ?? 0,
      donations: p.donations ?? 0,
      employeeCpfOverride: p.override ?? null,
    },
    existing: {
      srs: p.existingSrs ?? 0,
      cpfTopUpSelf: p.existingSelf ?? 0,
      cpfTopUpFamily: p.existingFamily ?? 0,
    },
    otherReliefs: p.otherReliefs ?? 0,
    levers: {
      srs: { enabled: p.srsOn ?? true },
      cpfSelf: { enabled: p.selfOn ?? true, roomToLimit: p.roomToLimit ?? null },
      cpfFamily: { enabled: p.familyOn ?? false, maxAmount: p.maxAmount ?? null },
    },
    preferences: {
      cashBudget: p.budget ?? null,
      minSavingRate: p.minRate ?? 0,
      priority: p.priority ?? ['srs', 'cpfSelf', 'cpfFamily'],
      simulatorStep: p.step ?? 1000,
    },
  };
}

const codes = (r: PlannerResult): string[] => r.warnings.map((w) => w.code);
const scenario = (r: PlannerResult, id: string) => {
  const found = r.scenarios.find((s) => s.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found;
};
const tiers = (r: PlannerResult) =>
  r.ladder.map((t) => ({
    from: t.fromContribution,
    to: t.toContribution,
    amount: t.amount,
    rate: t.rate,
    saved: t.taxSaved,
    cumulative: t.cumulativeTaxSaved,
    used: t.usedByPlan,
    zero: t.zeroReason,
  }));

// ---------------------------------------------------------------------------------------------------------
// H1–H5: the 55 / 60 / 65 / 70 switches combined with months worked < 12 and a bonus
// ---------------------------------------------------------------------------------------------------------

describe('H1 — turns 55 in March, works June–December (7 months), S$30,000 bonus, 2026', () => {
  // Worked months 6..12. completedAge(m) = 54 for m <= 3, 55 afterwards, so every worked month has
  // completedAge 55 -> not < 55 -> band "above 55 to 60": employee 18%, employer 16%.
  //   OW: floor(18% x 6,000) = 1,080 x 7 = 7,560            OW subject 6,000 x 7 = 42,000
  //   AW ceiling 102,000 - 42,000 = 60,000; AW subject 30,000; employee 18% x 30,000 = 5,400
  //   employee 7,560 + 5,400 = 12,960; employer 16% x (42,000 + 30,000) = 11,520
  // Income 42,000 + 30,000 = 72,000. EIR at 55 = 6,000. Reliefs 18,960. CI 53,040.
  // Tax 550 + 7% x 13,040 = 550 + 912.80 = 1,462.80.
  // At 55 the CPF top-up room must be entered (SPEC §6.5): this person has confirmed the full S$8,000.
  const input = person({ age: 55, birthMonth: 3, ow: 6_000, months: 7, aw: 30_000, roomToLimit: 8_000 });
  const r = plan(input);

  it('CPF: 18% in every worked month and on the bonus', () => {
    expect(r.cpf).toEqual({
      source: 'auto',
      ordinaryWagesSubject: 42_000,
      additionalWageCeiling: 60_000,
      additionalWagesSubject: 30_000,
      employeeContribution: 12_960,
      employerContribution: 11_520,
      monthlyEmployeeRates: [0, 0, 0, 0, 0, 0.18, 0.18, 0.18, 0.18, 0.18, 0.18, 0.18],
    });
  });

  it('baseline: income 72,000, reliefs 18,960, CI 53,040, tax 1,462.80', () => {
    expect(r.baseline.employmentIncome).toBe(72_000);
    expect(r.baseline.reliefs).toMatchObject({ earnedIncome: 6_000, cpf: 12_960, totalBeforeCap: 18_960, lostToCap: 0 });
    expect(r.baseline.chargeableIncome).toBe(53_040);
    expect(r.baseline.taxPayable).toBe(1_462.8);
    expect(r.baseline.marginalRate).toBe(0.07);
    expect(r.baseline.effectiveRate).toBeCloseTo(1_462.8 / 72_000, 12);
  });

  it('plan (min rate 0): U 33,040 · C 61,040 · L 23,300 -> X 23,300, leverLimits; saves 1,268.00', () => {
    // CI after 53,040 - 23,300 = 29,740 -> 2% x 9,740 = 194.80. Saved 1,462.80 - 194.80 = 1,268.00.
    // Unrealised: 194.80 - tax(53,040 - min(33,040, 61,040) = 20,000) = 194.80.
    expect(r.reliefCapRoom).toBe(61_040);
    expect(r.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 });
    expect(r.plan.totalContribution).toBe(23_300);
    expect(r.plan.taxAfter).toBe(194.8);
    expect(r.plan.taxSaved).toBe(1_268);
    expect(r.plan.chargeableIncomeBefore).toBe(53_040);
    expect(r.plan.chargeableIncomeAfter).toBe(29_740);
    // The plan moves the last dollar from the 7% band (53,040) to the 2% band (29,740).
    expect(r.plan.marginalRateBefore).toBe(0.07);
    expect(r.plan.marginalRateAfter).toBe(0.02);
    expect(r.plan.taxBefore).toBe(1_462.8);
    expect(r.plan.bindingConstraint).toBe('leverLimits');
    expect(r.plan.unrealisedSaving).toBe(194.8);
    expect(codes(r)).toEqual(['LEVER_LIMITS_PLAN', 'AGE_55_PLUS_TOPUP']);
  });

  it('ladder: 13,040 at 7% (912.80), 10,000 at 3.5% (350.00), 260 at 2% (5.20)', () => {
    expect(tiers(r)).toEqual([
      { from: 0, to: 13_040, amount: 13_040, rate: 0.07, saved: 912.8, cumulative: 912.8, used: 13_040, zero: undefined },
      { from: 13_040, to: 23_040, amount: 10_000, rate: 0.035, saved: 350, cumulative: 1_262.8, used: 10_000, zero: undefined },
      { from: 23_040, to: 23_300, amount: 260, rate: 0.02, saved: 5.2, cumulative: 1_268, used: 260, zero: undefined },
    ]);
  });

  it('the same person with the CPF room left blank (SPEC §6.5): L 15,300 -> SRS only; saves 991.90', () => {
    // A blank room at 55 is "not confirmed": CPF self room 0, so L = 15,300 and X = min(33,040, 61,040, 15,300).
    // CI after 53,040 - 15,300 = 37,740 -> 200 + 3.5% x 7,740 = 470.90. Saved 1,462.80 - 470.90 = 991.90
    //   (= 13,040 x 7% + 2,260 x 3.5% = 912.80 + 79.10). Unrealised: 470.90 - tax(20,000) = 470.90.
    const blank = plan(person({ age: 55, birthMonth: 3, ow: 6_000, months: 7, aw: 30_000 }));
    expect(blank.cpf).toEqual(r.cpf);
    expect(blank.baseline).toEqual(r.baseline);
    expect(blank.levers.cpfSelf).toEqual({ statutoryCap: 8_000, used: 0, room: 0, eligible: true, enabled: true });
    expect(blank.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 0 });
    expect(blank.plan.taxAfter).toBe(470.9);
    expect(blank.plan.taxSaved).toBe(991.9);
    expect(blank.plan.chargeableIncomeAfter).toBe(37_740);
    expect(blank.plan.marginalRateAfter).toBe(0.035);
    expect(blank.plan.bindingConstraint).toBe('leverLimits');
    expect(blank.plan.unrealisedSaving).toBe(470.9);
    expect(codes(blank)).toEqual(['LEVER_LIMITS_PLAN', 'CPF_SELF_ROOM_UNCONFIRMED']);
    expect(tiers(blank)).toEqual([
      { from: 0, to: 13_040, amount: 13_040, rate: 0.07, saved: 912.8, cumulative: 912.8, used: 13_040, zero: undefined },
      { from: 13_040, to: 15_300, amount: 2_260, rate: 0.035, saved: 79.1, cumulative: 991.9, used: 2_260, zero: undefined },
    ]);
    expect(scenario(blank, 'cpfSelfOnly')).toMatchObject({ totalContribution: 0, taxSaved: 0 });
    expect(scenario(blank, 'srsPlusCpfSelf').contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 0 });
  });

  it('the birth month moves the switch: June -> one month at 20%; December -> 20% throughout', () => {
    // Birth month 6: June still completedAge 54 -> 20% (1,200); July–December 18% (1,080 x 6 = 6,480);
    //   bonus at the December rate 18% (5,400). Total 13,080.
    // Birth month 5: every worked month (6..12) is after the birthday month -> same as March: 12,960.
    // Birth month 12: completedAge 54 all year -> 20%: 1,200 x 7 + 6,000 = 14,400.
    const rules = getRules(2026);
    expect(computeCpf({ ...input, profile: { ...input.profile, birthMonth: 6 } }, rules).employeeContribution).toBe(13_080);
    expect(computeCpf({ ...input, profile: { ...input.profile, birthMonth: 5 } }, rules).employeeContribution).toBe(12_960);
    expect(computeCpf({ ...input, profile: { ...input.profile, birthMonth: 12 } }, rules).employeeContribution).toBe(14_400);
  });
});

describe('H2 — turns 55 in October, works September–December (4 months), S$10,000 bonus: 2025 vs 2026 vs 2027', () => {
  // Worked months 9..12. completedAge = 54 for m <= 10 (Sep, Oct: "55 and below"), 55 for Nov, Dec ("above 55 to 60").
  // OW 7,000 a month is under both OW ceilings (7,400 / 8,000). OW subject 28,000; AW ceiling 74,000; AW subject 10,000.
  // Income 28,000 + 10,000 = 38,000. EIR (age 55) 6,000.
  // The CPF top-up room is left blank: at 55 that leaves own CPF out (room 0) and raises CPF_SELF_ROOM_UNCONFIRMED
  // instead of the AGE_55_PLUS_TOPUP note (SPEC §6.5, §6.11). SRS alone has more room than these plans need.
  const base = { age: 55, birthMonth: 10, ow: 7_000, months: 4, aw: 10_000 };

  it('2026 (20% then 18%): CPF 7,120, employer 6,220, CI 24,880, tax 97.60', () => {
    // OW: 1,400 x 2 + floor(18% x 7,000) = 1,260 x 2 -> 2,800 + 2,520 = 5,320. AW: 18% x 10,000 = 1,800. Total 7,120.
    // Employer: 17% x 14,000 + 16% x 14,000 + 16% x 10,000 = 2,380 + 2,240 + 1,600 = 6,220.
    // CI = 38,000 - 6,000 - 7,120 = 24,880 -> 2% x 4,880 = 97.60.
    const r = plan(person({ ...base, incomeYear: 2026 }));
    expect(r.cpf.employeeContribution).toBe(7_120);
    expect(r.cpf.employerContribution).toBe(6_220);
    expect(r.cpf.monthlyEmployeeRates).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.2, 0.18, 0.18]);
    expect(r.baseline.chargeableIncome).toBe(24_880);
    expect(r.baseline.taxPayable).toBe(97.6);
    // Min rate 0: U = 4,880 is the smallest -> the whole tax bill goes with S$4,880 of SRS.
    expect(r.plan.contributions).toEqual({ srs: 4_880, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.taxAfter).toBe(0);
    expect(r.plan.taxSaved).toBe(97.6);
    expect(r.plan.bindingConstraint).toBe('usefulRoom');
    expect(r.plan.unrealisedSaving).toBe(0);
    expect(r.levers.cpfSelf.room).toBe(0);
    expect(codes(r)).toEqual(['CPF_SELF_ROOM_UNCONFIRMED']);
    // With the room entered the note replaces the caution and the plan is the same (U = 4,880 binds either way).
    const confirmed = plan(person({ ...base, incomeYear: 2026, roomToLimit: 8_000 }));
    expect(confirmed.plan).toEqual(r.plan);
    expect(codes(confirmed)).toEqual(['AGE_55_PLUS_TOPUP']);
  });

  it('2025 (20% then 17%): CPF 6,880, employer 6,100, CI 25,120, tax 102.40', () => {
    // OW: 2,800 + floor(17% x 7,000) = 1,190 x 2 = 2,380 -> 5,180. AW: 1,700. Total 6,880.
    // Employer: 2,380 + 15.5% x 14,000 = 2,170 + 15.5% x 10,000 = 1,550 -> 6,100.
    // CI = 38,000 - 6,000 - 6,880 = 25,120 -> 2% x 5,120 = 102.40.
    const r = plan(person({ ...base, incomeYear: 2025 }));
    expect(r.cpf.employeeContribution).toBe(6_880);
    expect(r.cpf.employerContribution).toBe(6_100);
    expect(r.cpf.monthlyEmployeeRates).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.2, 0.17, 0.17]);
    expect(r.baseline.chargeableIncome).toBe(25_120);
    expect(r.baseline.taxPayable).toBe(102.4);
    expect(codes(r)).toEqual(['CPF_SELF_ROOM_UNCONFIRMED']);
  });

  it('2027 (20% then 19%): CPF 7,360, employer 6,340, CI 24,640, tax 92.80, flagged projected', () => {
    // OW: 2,800 + floor(19% x 7,000) = 1,330 x 2 = 2,660 -> 5,460. AW: 1,900. Total 7,360.
    // Employer: 2,380 + 16.5% x 14,000 = 2,310 + 16.5% x 10,000 = 1,650 -> 6,340.
    // CI = 38,000 - 6,000 - 7,360 = 24,640 -> 2% x 4,640 = 92.80.
    const r = plan(person({ ...base, incomeYear: 2027 }));
    expect(r.cpf.employeeContribution).toBe(7_360);
    expect(r.cpf.employerContribution).toBe(6_340);
    expect(r.baseline.chargeableIncome).toBe(24_640);
    expect(r.baseline.taxPayable).toBe(92.8);
    expect(codes(r)).toEqual(['CPF_SELF_ROOM_UNCONFIRMED', 'PROJECTED_RULES']);
  });
});

describe('H3 — turns 60 in 2027: EIR uses the age at year end, CPF the month after the birthday', () => {
  // S$8,500 a month (OW ceiling 8,000 -> OW subject 96,000), S$12,000 bonus (AW ceiling 6,000 -> subject 6,000).
  // Income 102,000 + 12,000 = 114,000. EIR at 60 = 8,000 whatever the birth month.
  it('December birthday: still "above 55 to 60" (19%) all year, bonus included', () => {
    // OW: floor(19% x 8,000) = 1,520 x 12 = 18,240. AW: 19% x 6,000 = 1,140. Total 19,380.
    // Reliefs 8,000 + 19,380 = 27,380. CI 86,620. Tax 3,350 + 11.5% x 6,620 = 3,350 + 761.30 = 4,111.30.
    const r = plan(person({ incomeYear: 2027, age: 60, birthMonth: 12, ow: 8_500, aw: 12_000, minRate: 0.115 }));
    expect(r.cpf.employeeContribution).toBe(19_380);
    expect(r.cpf.monthlyEmployeeRates).toEqual(new Array(12).fill(0.19));
    expect(r.baseline.reliefs.earnedIncome).toBe(8_000);
    expect(r.baseline.chargeableIncome).toBe(86_620);
    expect(r.baseline.taxPayable).toBe(4_111.3);
    // Min rate 11.5%: U = 86,620 - 80,000 = 6,620 -> SRS 6,620, tax after 3,350.00, saved 761.30.
    expect(r.plan.contributions).toEqual({ srs: 6_620, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.taxAfter).toBe(3_350);
    expect(r.plan.taxSaved).toBe(761.3);
    expect(r.plan.bindingConstraint).toBe('usefulRoom');
    // CPF room left blank at 60: the caution, not the note (the plan needs SRS only).
    expect(codes(r)).toEqual(['CPF_SELF_ROOM_UNCONFIRMED', 'PROJECTED_RULES']);
  });

  it('January birthday: 19% in January only, then 13%; the bonus takes the December rate', () => {
    // OW: 1,520 + floor(13% x 8,000) = 1,040 x 11 = 11,440 -> 12,960. AW: 13% x 6,000 = 780. Total 13,740.
    // Employer: 16.5% x 8,000 = 1,320; 13% x 8,000 x 11 = 11,440; 13% x 6,000 = 780 -> 13,540.
    // Reliefs 8,000 + 13,740 = 21,740. CI 92,260. Tax 3,350 + 11.5% x 12,260 = 3,350 + 1,409.90 = 4,759.90.
    const r = plan(person({ incomeYear: 2027, age: 60, birthMonth: 1, ow: 8_500, aw: 12_000, minRate: 0.115 }));
    expect(r.cpf.employeeContribution).toBe(13_740);
    expect(r.cpf.employerContribution).toBe(13_540);
    expect(r.cpf.monthlyEmployeeRates).toEqual([0.19, ...new Array(11).fill(0.13)]);
    expect(r.baseline.chargeableIncome).toBe(92_260);
    expect(r.baseline.taxPayable).toBe(4_759.9);
  });
});

describe('H4 — turns 65 in June 2026, works April–December (9 months) on S$5,555 with a S$20,001 bonus', () => {
  // Worked months 4..12. Apr–Jun completedAge 64 -> "above 60 to 65" (12.5% / 12.5%);
  // Jul–Dec completedAge 65 -> "above 65 to 70" (7.5% / 9%).
  //   OW: floor(12.5% x 5,555 = 694.375) = 694 x 3 = 2,082; floor(7.5% x 5,555 = 416.625) = 416 x 6 = 2,496 -> 4,578
  //   OW subject 5,555 x 9 = 49,995; AW ceiling 52,005; AW subject 20,001; floor(7.5% x 20,001 = 1,500.075) = 1,500
  //   employee 6,078
  //   employer 12.5% x 16,665 = 2,083.125; 9% x 33,330 = 2,999.70; 9% x 20,001 = 1,800.09 -> 6,882.915 -> 6,883
  // Income 49,995 + 20,001 = 69,996. EIR 8,000. Reliefs 14,078. CI 55,918. Tax 550 + 7% x 15,918 = 1,664.26.
  // CPF top-up room confirmed at the full S$8,000 (required from 55, SPEC §6.5).
  const r = plan(person({ age: 65, birthMonth: 6, ow: 5_555, months: 9, aw: 20_001, minRate: 0.07, roomToLimit: 8_000 }));

  it('CPF 6,078 (cents dropped every month), employer 6,883', () => {
    expect(r.cpf).toEqual({
      source: 'auto',
      ordinaryWagesSubject: 49_995,
      additionalWageCeiling: 52_005,
      additionalWagesSubject: 20_001,
      employeeContribution: 6_078,
      employerContribution: 6_883,
      monthlyEmployeeRates: [0, 0, 0, 0.125, 0.125, 0.125, 0.075, 0.075, 0.075, 0.075, 0.075, 0.075],
    });
  });

  it('CI 55,918, tax 1,664.26; plan stops at the 7% floor: 15,918 saves 1,114.26', () => {
    expect(r.baseline.employmentIncome).toBe(69_996);
    expect(r.baseline.chargeableIncome).toBe(55_918);
    expect(r.baseline.taxPayable).toBe(1_664.26);
    // U = 55,918 - 40,000 = 15,918; C = 80,000 - 14,078 = 65,922; L = 23,300 -> X = 15,918 (usefulRoom).
    // SRS 15,300 then CPF self 618. Tax after = 550.00. Saved 1,114.26.
    expect(r.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 618, cpfFamily: 0 });
    expect(r.plan.taxAfter).toBe(550);
    expect(r.plan.taxSaved).toBe(1_114.26);
    expect(r.plan.savingRate).toBeCloseTo(0.07, 12);
    expect(r.plan.bindingConstraint).toBe('usefulRoom');
    expect(codes(r)).toEqual(['AGE_55_PLUS_TOPUP']);
  });

  it('with the CPF room left blank the SRS cap binds 618 dollars early: 15,300 saves 1,071.00', () => {
    // L = 15,300 < U = 15,918 -> X = 15,300 (leverLimits). CI after 40,618 -> 550 + 7% x 618 = 593.26.
    // Saved 1,664.26 - 593.26 = 1,071.00. Unrealised: 593.26 - tax(40,000) = 43.26.
    // The family top-up (off) could take those 618 dollars: savingIfSwitchedOn = 43.26 (SPEC §6.11).
    const blank = plan(person({ age: 65, birthMonth: 6, ow: 5_555, months: 9, aw: 20_001, minRate: 0.07 }));
    expect(blank.baseline).toEqual(r.baseline);
    expect(blank.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 0 });
    expect(blank.plan.taxAfter).toBe(593.26);
    expect(blank.plan.taxSaved).toBe(1_071);
    expect(blank.plan.bindingConstraint).toBe('leverLimits');
    expect(blank.plan.unrealisedSaving).toBe(43.26);
    expect(codes(blank)).toEqual(['LEVER_LIMITS_PLAN', 'CPF_SELF_ROOM_UNCONFIRMED']);
    expect(blank.warnings[0]?.params).toEqual({ leverRoom: 15_300, unrealisedSaving: 43.26, savingIfSwitchedOn: 43.26 });
  });
});

describe('H5 — turns 70 in November 2026: December (and the bonus) drop to 5%; tax needs half-up rounding', () => {
  // completedAge 69 for Jan–Nov ("above 65 to 70": 7.5% / 9%), 70 in December ("above 70": 5% / 7.5%).
  //   OW: floor(7.5% x 3,000) = 225 x 11 = 2,475; 5% x 3,000 = 150 -> 2,625. AW: 5% x 5,000 = 250. Total 2,875.
  //   Employer: 9% x 33,000 = 2,970; 7.5% x 3,000 = 225; 7.5% x 5,000 = 375 -> 3,570.
  // Income 36,000 + 5,000 = 41,000. EIR 8,000. Reliefs 10,875. CI 30,125.
  // Tax 200 + 3.5% x 125 = 204.375 -> 204.38 (half-up).
  const base = { age: 70, birthMonth: 11, ow: 3_000, aw: 5_000 };

  it('CPF 2,875; CI 30,125; tax 204.38', () => {
    const r = plan(person(base));
    expect(r.cpf.employeeContribution).toBe(2_875);
    expect(r.cpf.employerContribution).toBe(3_570);
    expect(r.cpf.monthlyEmployeeRates).toEqual([...new Array(11).fill(0.075), 0.05]);
    expect(r.baseline.reliefs.totalBeforeCap).toBe(10_875);
    expect(r.baseline.chargeableIncome).toBe(30_125);
    expect(r.baseline.grossTax).toBe(204.38);
    expect(r.baseline.taxPayable).toBe(204.38);
  });

  it('min rate 3.5%: only the top S$125 is worth it and saves 4.38', () => {
    const r = plan(person({ ...base, minRate: 0.035 }));
    expect(r.plan.contributions).toEqual({ srs: 125, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.taxAfter).toBe(200);
    expect(r.plan.taxSaved).toBe(4.38);
    expect(r.plan.savingRate).toBe(4.38 / 125);
    expect(r.plan.bindingConstraint).toBe('usefulRoom');
    // The CPF room is blank: at 70 that is the caution (own CPF left out), not the AGE_55_PLUS_TOPUP note.
    expect(codes(r)).toEqual(['CPF_SELF_ROOM_UNCONFIRMED']);
  });

  it('min rate 2%: 10,125 clears the whole bill', () => {
    const r = plan(person({ ...base, minRate: 0.02, roomToLimit: 8_000 }));
    expect(r.plan.totalContribution).toBe(10_125);
    expect(r.plan.taxAfter).toBe(0);
    expect(r.plan.taxSaved).toBe(204.38);
    // Room confirmed at 8,000, so the ladder runs over L = 23,300: 125 at 3.5% (4.38, realised), 10,000 at 2%
    // (200.00), then 13,175 tax-free dollars.
    expect(tiers(r)).toEqual([
      { from: 0, to: 125, amount: 125, rate: 0.035, saved: 4.38, cumulative: 4.38, used: 125, zero: undefined },
      { from: 125, to: 10_125, amount: 10_000, rate: 0.02, saved: 200, cumulative: 204.38, used: 10_000, zero: undefined },
      { from: 10_125, to: 23_300, amount: 13_175, rate: 0, saved: 0, cumulative: 204.38, used: 0, zero: 'belowTaxThreshold' },
    ]);
    // Room left blank: the same plan (SRS alone covers 10,125), but the ladder stops at L = 15,300, leaving
    // 15,300 - 10,125 = 5,175 tax-free dollars.
    const blank = plan(person({ ...base, minRate: 0.02 }));
    expect(blank.plan).toEqual(r.plan);
    expect(tiers(blank)).toEqual([
      { from: 0, to: 125, amount: 125, rate: 0.035, saved: 4.38, cumulative: 4.38, used: 125, zero: undefined },
      { from: 125, to: 10_125, amount: 10_000, rate: 0.02, saved: 200, cumulative: 204.38, used: 10_000, zero: undefined },
      { from: 10_125, to: 15_300, amount: 5_175, rate: 0, saved: 0, cumulative: 204.38, used: 0, zero: 'belowTaxThreshold' },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// H6–H7: wages at 500 / 501 / 750 / 751 and at the OW ceiling
// ---------------------------------------------------------------------------------------------------------

describe('H6 — nil band and phase-in boundaries (S$500 / S$501 / S$750 / S$751)', () => {
  const employee = (p: Person): number => computeCpf(person(p), getRules(p.incomeYear ?? 2026)).employeeContribution;

  it('55 and below, 2026 (20%, factor 0.6), 12 months', () => {
    // 500 -> 0. 501 -> floor(0.6 x 1) = 0. 502 -> floor(1.2) = 1 -> 12 a year.
    // 749 -> floor(0.6 x 249 = 149.4) = 149 -> 1,788. 750 -> floor(150) = 150 -> 1,800.
    // 751 -> full rate: floor(20% x 751 = 150.2) = 150 -> 1,800. 755 -> floor(151) = 151 -> 1,812.
    expect(employee({ ow: 500 })).toBe(0);
    expect(employee({ ow: 501 })).toBe(0);
    expect(employee({ ow: 502 })).toBe(12);
    expect(employee({ ow: 749 })).toBe(1_788);
    expect(employee({ ow: 750 })).toBe(1_800);
    expect(employee({ ow: 751 })).toBe(1_800);
    expect(employee({ ow: 755 })).toBe(1_812);
  });

  it('above 60 to 65, 2026 (12.5%, factor 0.375)', () => {
    // 750 -> floor(0.375 x 250 = 93.75) = 93; 751 -> floor(12.5% x 751 = 93.875) = 93; 752 -> floor(94) = 94.
    expect(employee({ age: 62, ow: 750 })).toBe(93 * 12);
    expect(employee({ age: 62, ow: 751 })).toBe(93 * 12);
    expect(employee({ age: 62, ow: 752 })).toBe(94 * 12);
  });

  it('above 55 to 60 in 2025 (17%, 0.51) and 2027 (19%, 0.57); above 60 to 65 in 2025 (11.5%, 0.345)', () => {
    // 2025, 58: 750 -> floor(127.5) = 127; 751 -> floor(17% x 751 = 127.67) = 127.
    expect(employee({ incomeYear: 2025, age: 58, ow: 750 })).toBe(127 * 12);
    expect(employee({ incomeYear: 2025, age: 58, ow: 751 })).toBe(127 * 12);
    // 2027, 58: 750 -> floor(142.5) = 142; 751 -> floor(19% x 751 = 142.69) = 142; 600 -> 0.57 x 100 = 57 exactly.
    expect(employee({ incomeYear: 2027, age: 58, ow: 750 })).toBe(142 * 12);
    expect(employee({ incomeYear: 2027, age: 58, ow: 751 })).toBe(142 * 12);
    expect(employee({ incomeYear: 2027, age: 58, ow: 600 })).toBe(57 * 12);
    // 2025, 62: 501 -> floor(0.345) = 0; 503 -> floor(1.035) = 1; 750 -> floor(86.25) = 86; 751 -> floor(86.365) = 86.
    expect(employee({ incomeYear: 2025, age: 62, ow: 501 })).toBe(0);
    expect(employee({ incomeYear: 2025, age: 62, ow: 503 })).toBe(12);
    expect(employee({ incomeYear: 2025, age: 62, ow: 750 })).toBe(86 * 12);
    expect(employee({ incomeYear: 2025, age: 62, ow: 751 })).toBe(86 * 12);
  });

  it('phase-in wage of S$700 while turning 60 in June 2026, with a S$2,000 bonus: nothing to plan', () => {
    // Jan–Jun completedAge 59 -> 18%, factor 0.54: floor(0.54 x 200) = 108 x 6 = 648.
    // Jul–Dec completedAge 60 -> 12.5%, factor 0.375: floor(75) = 75 x 6 = 450.
    // Bonus at the December FULL rate: 12.5% x 2,000 = 250. Employee 1,348.
    // Employer: 16% x 4,200 = 672; 12.5% x 4,200 = 525; 12.5% x 2,000 = 250 -> 1,447.
    // Income 8,400 + 2,000 = 10,400. EIR 8,000. Reliefs 9,348. CI 1,052. Tax 0.
    const r = plan(person({ age: 60, birthMonth: 6, ow: 700, aw: 2_000 }));
    expect(r.cpf.employeeContribution).toBe(1_348);
    expect(r.cpf.employerContribution).toBe(1_447);
    expect(r.cpf.ordinaryWagesSubject).toBe(8_400);
    expect(r.cpf.additionalWageCeiling).toBe(93_600);
    expect(r.baseline.chargeableIncome).toBe(1_052);
    expect(r.baseline.taxPayable).toBe(0);
    expect(r.plan.totalContribution).toBe(0);
    expect(r.plan.bindingConstraint).toBe('none');
    // CPF room blank at 60: own CPF is left out (room 0) and the caution asks for the figure.
    expect(codes(r)).toEqual(['NO_TAX_PAYABLE', 'CPF_SELF_ROOM_UNCONFIRMED']);
    // L = 15,300 (SRS only), all of it below the tax threshold (1,052 in the 0% band, the rest beyond CI0): one
    // merged tier.
    expect(tiers(r)).toEqual([
      { from: 0, to: 15_300, amount: 15_300, rate: 0, saved: 0, cumulative: 0, used: 0, zero: 'belowTaxThreshold' },
    ]);
    expect(scenario(r, 'maxAll').wastedContribution).toBe(15_300);
    // With the room confirmed at 8,000 the ladder and the "everything" scenario cover 23,300.
    const confirmed = plan(person({ age: 60, birthMonth: 6, ow: 700, aw: 2_000, roomToLimit: 8_000 }));
    expect(codes(confirmed)).toEqual(['NO_TAX_PAYABLE', 'AGE_55_PLUS_TOPUP']);
    expect(tiers(confirmed)).toEqual([
      { from: 0, to: 23_300, amount: 23_300, rate: 0, saved: 0, cumulative: 0, used: 0, zero: 'belowTaxThreshold' },
    ]);
    expect(scenario(confirmed, 'maxAll').wastedContribution).toBe(23_300);
  });

  it('1st-year PR aged 66 on S$700 (5%, factor 0.15) with a S$1,000 bonus', () => {
    // floor(0.15 x 200) = 30 x 12 = 360; bonus 5% x 1,000 = 50 -> 410.
    const r = plan(person({ residency: 'pr', prYear: 1, age: 66, ow: 700, aw: 1_000 }));
    expect(r.cpf.employeeContribution).toBe(410);
    expect(r.cpf.monthlyEmployeeRates).toEqual(new Array(12).fill(0.05));
    expect(codes(r)).toEqual(['NO_TAX_PAYABLE', 'PR_GRADUATED_RATES', 'CPF_SELF_ROOM_UNCONFIRMED']);
  });
});

describe('H7 — wages at and around the OW ceiling: 2025 (7,400) vs 2026 / 2027 (8,000)', () => {
  const cpf = (p: Person) => computeCpf(person(p), getRules(p.incomeYear ?? 2026));

  it('S$7,400 and S$7,401', () => {
    // 7,400: 20% = 1,480 x 12 = 17,760 in every year; OW subject 88,800; AW ceiling 13,200.
    for (const incomeYear of [2025, 2026, 2027]) {
      expect(cpf({ incomeYear, ow: 7_400 })).toMatchObject({
        employeeContribution: 17_760,
        ordinaryWagesSubject: 88_800,
        additionalWageCeiling: 13_200,
      });
    }
    // 7,401: capped at 7,400 in 2025; in 2026 floor(20% x 7,401 = 1,480.2) = 1,480 but OW subject 88,812.
    expect(cpf({ incomeYear: 2025, ow: 7_401 })).toMatchObject({ employeeContribution: 17_760, ordinaryWagesSubject: 88_800, additionalWageCeiling: 13_200 });
    expect(cpf({ incomeYear: 2026, ow: 7_401 })).toMatchObject({ employeeContribution: 17_760, ordinaryWagesSubject: 88_812, additionalWageCeiling: 13_188 });
  });

  it('S$8,000 / S$8,001 with a S$10,000 bonus: the same person pays different tax in 2025 and 2026', () => {
    // 2025: OW subject 7,400 x 12 = 88,800 -> 17,760; AW ceiling 13,200 -> all 10,000 subject -> 2,000. CPF 19,760.
    // 2026/27: OW subject 96,000 -> 19,200; AW ceiling 6,000 -> 6,000 subject -> 1,200. CPF 20,400.
    // Income 96,000 + 10,000 = 106,000; EIR 1,000.
    // 2025: CI 106,000 - 20,760 = 85,240 -> 3,350 + 11.5% x 5,240 = 3,350 + 602.60 = 3,952.60.
    // 2026: CI 106,000 - 21,400 = 84,600 -> 3,350 + 11.5% x 4,600 = 3,350 + 529.00 = 3,879.00.
    const y25 = plan(person({ incomeYear: 2025, ow: 8_000, aw: 10_000 }));
    expect(y25.cpf).toMatchObject({ employeeContribution: 19_760, ordinaryWagesSubject: 88_800, additionalWagesSubject: 10_000 });
    expect(y25.baseline.chargeableIncome).toBe(85_240);
    expect(y25.baseline.taxPayable).toBe(3_952.6);
    for (const incomeYear of [2026, 2027]) {
      const r = plan(person({ incomeYear, ow: 8_000, aw: 10_000 }));
      expect(r.cpf).toMatchObject({ employeeContribution: 20_400, ordinaryWagesSubject: 96_000, additionalWageCeiling: 6_000, additionalWagesSubject: 6_000 });
      expect(r.baseline.chargeableIncome).toBe(84_600);
      expect(r.baseline.taxPayable).toBe(3_879);
    }
    // One dollar over the ceiling changes the income (12 more dollars) but not the CPF.
    const over = plan(person({ incomeYear: 2026, ow: 8_001, aw: 10_000 }));
    expect(over.cpf).toMatchObject({ employeeContribution: 20_400, ordinaryWagesSubject: 96_000 });
    expect(over.baseline.chargeableIncome).toBe(84_612);
  });

  it('few months worked: the unused OW ceiling becomes AW ceiling', () => {
    // 3 months on 10,000 + 100,000 bonus.
    // 2026: OW subject 24,000 -> 4,800; AW ceiling 78,000 -> 15,600. CPF 20,400.
    // 2025: OW subject 22,200 -> 4,440; AW ceiling 79,800 -> 15,960. CPF 20,400.
    // Income 30,000 + 100,000 = 130,000; CI 130,000 - 21,400 = 108,600; tax 3,350 + 11.5% x 28,600 = 6,639.00.
    for (const incomeYear of [2025, 2026]) {
      const r = plan(person({ incomeYear, ow: 10_000, months: 3, aw: 100_000 }));
      expect(r.cpf.employeeContribution).toBe(20_400);
      expect(r.cpf.additionalWageCeiling).toBe(incomeYear === 2025 ? 79_800 : 78_000);
      expect(r.cpf.monthlyEmployeeRates).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.2, 0.2]);
      expect(r.baseline.employmentIncome).toBe(130_000);
      expect(r.baseline.chargeableIncome).toBe(108_600);
      expect(r.baseline.taxPayable).toBe(6_639);
    }
    // Nil-band wage of 500 with a 200,000 bonus: OW subject 6,000 (the wage still uses up ceiling),
    // AW ceiling 96,000 -> 20% x 96,000 = 19,200; nothing on the ordinary wage.
    const nil = computeCpf(person({ ow: 500, aw: 200_000 }), getRules(2026));
    expect(nil).toMatchObject({ ordinaryWagesSubject: 6_000, additionalWageCeiling: 96_000, additionalWagesSubject: 96_000, employeeContribution: 19_200 });
  });
});

describe('H8 — the same 62-year-old in 2025, 2026 and 2027 (S$7,800 a month, S$15,000 bonus)', () => {
  // Income 93,600 + 15,000 = 108,600. EIR 8,000. Band "above 60 to 65" all year.
  it.each([
    // 2025: 11.5%, OW ceiling 7,400: floor(851) x 12 = 10,212; AW ceiling 13,200 -> floor(11.5% x 13,200) = 1,518.
    //       CPF 11,730. CI 108,600 - 19,730 = 88,870. Tax 3,350 + 11.5% x 8,870 = 3,350 + 1,020.05 = 4,370.05.
    [2025, 11_730, 88_870, 4_370.05],
    // 2026: 12.5%: 975 x 12 = 11,700; OW subject 93,600; AW ceiling 8,400 -> 1,050. CPF 12,750.
    //       CI 108,600 - 20,750 = 87,850. Tax 3,350 + 11.5% x 7,850 = 3,350 + 902.75 = 4,252.75.
    [2026, 12_750, 87_850, 4_252.75],
    // 2027: 13%: 1,014 x 12 = 12,168; AW 13% x 8,400 = 1,092. CPF 13,260.
    //       CI 108,600 - 21,260 = 87,340. Tax 3,350 + 11.5% x 7,340 = 3,350 + 844.10 = 4,194.10.
    [2027, 13_260, 87_340, 4_194.1],
  ])('%i: CPF %i, CI %i, tax %f', (incomeYear, cpf, ci, tax) => {
    const r = plan(person({ incomeYear, age: 62, ow: 7_800, aw: 15_000 }));
    expect(r.cpf.employeeContribution).toBe(cpf);
    expect(r.baseline.reliefs.earnedIncome).toBe(8_000);
    expect(r.baseline.chargeableIncome).toBe(ci);
    expect(r.baseline.taxPayable).toBe(tax);
  });
});

// ---------------------------------------------------------------------------------------------------------
// H9–H11: the relief cap, existing contributions at / over caps, user room limits
// ---------------------------------------------------------------------------------------------------------

describe('H9 — the plan lands exactly on the S$80,000 relief cap', () => {
  // S$20,000 a month: income 240,000; CPF 1,600 x 12 = 19,200 (AW 0); EIR 1,000.
  // Existing SRS 5,000 and CPF self 3,000; other reliefs 32,500.
  // Reliefs before cap 1,000 + 19,200 + 5,000 + 3,000 + 32,500 = 60,700 -> C = 19,300.
  // Rooms: SRS 10,300; CPF self 5,000; family min(8,000, max 4,000) = 4,000 -> L = 19,300.
  // CI 240,000 - 60,700 = 179,300. Tax 13,950 + 18% x 19,300 = 13,950 + 3,474 = 17,424.00.
  const base: Person = {
    ow: 20_000,
    existingSrs: 5_000,
    existingSelf: 3_000,
    otherReliefs: 32_500,
    familyOn: true,
    maxAmount: 4_000,
  };

  it('min rate 15%: U 59,300 · C 19,300 · L 19,300 -> X 19,300; C = L resolves to reliefCap', () => {
    const r = plan(person({ ...base, minRate: 0.15 }));
    expect(r.baseline.reliefs.totalBeforeCap).toBe(60_700);
    expect(r.baseline.chargeableIncome).toBe(179_300);
    expect(r.baseline.taxPayable).toBe(17_424);
    expect(r.reliefCapRoom).toBe(19_300);
    expect(r.levers.srs).toEqual({ statutoryCap: 15_300, used: 5_000, room: 10_300, eligible: true, enabled: true });
    expect(r.levers.cpfSelf).toEqual({ statutoryCap: 8_000, used: 3_000, room: 5_000, eligible: true, enabled: true });
    expect(r.levers.cpfFamily).toEqual({ statutoryCap: 8_000, used: 0, room: 4_000, eligible: true, enabled: true });
    expect(r.plan.contributions).toEqual({ srs: 10_300, cpfSelf: 5_000, cpfFamily: 4_000 });
    expect(r.plan.taxAfter).toBe(13_950);
    expect(r.plan.taxSaved).toBe(3_474);
    expect(r.plan.bindingConstraint).toBe('reliefCap');
    expect(r.plan.unrealisedSaving).toBe(0);
    expect(r.optimised.reliefs).toMatchObject({ srs: 15_300, cpfTopUpSelf: 8_000, cpfTopUpFamily: 4_000, totalBeforeCap: 80_000, totalAllowed: 80_000, lostToCap: 0 });
    expect(r.optimised.chargeableIncome).toBe(160_000);
    expect(r.optimised.marginalRate).toBe(0.15);
    // S$4,000 of the plan is a family top-up, so FAMILY_TOPUP_CHECKS follows (SPEC §6.11).
    expect(codes(r)).toEqual(['RELIEF_CAP_LIMITS_PLAN', 'FAMILY_TOPUP_CHECKS']);
    // The cap is reached exactly at L, so there is no over-cap tier.
    expect(tiers(r)).toEqual([
      { from: 0, to: 19_300, amount: 19_300, rate: 0.18, saved: 3_474, cumulative: 3_474, used: 19_300, zero: undefined },
    ]);
    expect(scenario(r, 'maxAll')).toMatchObject({ totalContribution: 19_300, taxSaved: 3_474, wastedContribution: 0 });
  });

  it('min rate 18%: U = C = L = 19,300 (and B too) resolves to usefulRoom', () => {
    // floorCI(18%) = 160,000 -> U = 179,300 - 160,000 = 19,300.
    const r = plan(person({ ...base, minRate: 0.18 }));
    expect(r.plan.totalContribution).toBe(19_300);
    expect(r.plan.bindingConstraint).toBe('usefulRoom');
    // Nothing limits the plan; the only warning is the family top-up caution (4,000 of the plan goes to family).
    expect(codes(r)).toEqual(['FAMILY_TOPUP_CHECKS']);
    const withBudget = plan(person({ ...base, minRate: 0.18, budget: 19_300 }));
    expect(withBudget.plan.totalContribution).toBe(19_300);
    expect(withBudget.plan.bindingConstraint).toBe('usefulRoom');
    expect(codes(withBudget)).toEqual(['FAMILY_TOPUP_CHECKS']);
  });

  it('one more dollar of other reliefs: C 19,299 < L, the last family dollar would be wasted', () => {
    // Reliefs 60,701 -> C = 19,299. CI 179,299. Tax 13,950 + 18% x 19,299 = 13,950 + 3,473.82 = 17,423.82.
    // X = 19,299: SRS 10,300, CPF self 5,000, family 3,999. Tax after 13,950.00. Saved 3,473.82.
    const r = plan(person({ ...base, otherReliefs: 32_501, minRate: 0.15 }));
    expect(r.baseline.taxPayable).toBe(17_423.82);
    expect(r.plan.contributions).toEqual({ srs: 10_300, cpfSelf: 5_000, cpfFamily: 3_999 });
    expect(r.plan.taxSaved).toBe(3_473.82);
    expect(r.plan.bindingConstraint).toBe('reliefCap');
    expect(tiers(r)).toEqual([
      { from: 0, to: 19_299, amount: 19_299, rate: 0.18, saved: 3_473.82, cumulative: 3_473.82, used: 19_299, zero: undefined },
      { from: 19_299, to: 19_300, amount: 1, rate: 0, saved: 0, cumulative: 3_473.82, used: 0, zero: 'reliefCap' },
    ]);
    expect(scenario(r, 'maxAll')).toMatchObject({ totalContribution: 19_300, taxSaved: 3_473.82, wastedContribution: 1 });
    // Contributing the wasted dollar anyway: relief 80,001 before the cap, 1 lost, same tax.
    const all = evaluate(person({ ...base, otherReliefs: 32_501 }), { srs: 10_300, cpfSelf: 5_000, cpfFamily: 4_000 });
    expect(all.reliefs).toMatchObject({ totalBeforeCap: 80_001, totalAllowed: 80_000, lostToCap: 1 });
    expect(all.taxPayable).toBe(13_950);
  });
});

describe('H10 — existing contributions at and over the caps, plus room limits; min rate at and just above 15%', () => {
  // S$12,000 a month, S$24,000 bonus: income 168,000. CPF 19,200 + 20% x min(24,000, 6,000) = 20,400. EIR 1,000.
  // Existing: SRS 15,300 (exactly the cap), CPF self 9,500 (1,500 over the cap), family 2,500.
  // Reliefs: 1,000 + 20,400 + 15,300 + 8,000 + 2,500 = 47,200 -> C = 32,800.
  // CI 168,000 - 47,200 = 120,800. Tax 7,950 + 15% x 800 = 8,070.00.
  // Rooms: SRS 0; CPF self min(0, roomToLimit 1,000) = 0; family min(8,000 - 2,500, max 7,000) = 5,500. L = 5,500.
  // The S$2,500 already given to family raises FAMILY_TOPUP_CHECKS in every result below (SPEC §6.11).
  const base: Person = {
    age: 40,
    ow: 12_000,
    aw: 24_000,
    existingSrs: 15_300,
    existingSelf: 9_500,
    existingFamily: 2_500,
    familyOn: true,
    maxAmount: 7_000,
    roomToLimit: 1_000,
  };

  it('baseline and lever positions', () => {
    const r = plan(person(base));
    expect(r.baseline.reliefs).toEqual({
      earnedIncome: 1_000,
      cpf: 20_400,
      srs: 15_300,
      cpfTopUpSelf: 8_000,
      cpfTopUpFamily: 2_500,
      other: 0,
      totalBeforeCap: 47_200,
      totalAllowed: 47_200,
      lostToCap: 0,
    });
    expect(r.baseline.chargeableIncome).toBe(120_800);
    expect(r.baseline.taxPayable).toBe(8_070);
    expect(r.levers).toEqual({
      srs: { statutoryCap: 15_300, used: 15_300, room: 0, eligible: true, enabled: true },
      cpfSelf: { statutoryCap: 8_000, used: 8_000, room: 0, eligible: true, enabled: true },
      cpfFamily: { statutoryCap: 8_000, used: 2_500, room: 5_500, eligible: true, enabled: true },
    });
    const warning = r.warnings.find((w) => w.code === 'EXISTING_EXCEEDS_CAP');
    expect(warning?.params).toEqual({ levers: 'cpfSelf', cpfSelfExisting: 9_500, cpfSelfCap: 8_000, cpfSelfExcess: 1_500 });
  });

  it('min rate exactly 15%: the 15% bracket is included -> X = U = 800, saves 120.00', () => {
    const r = plan(person({ ...base, minRate: 0.15 }));
    expect(r.plan.contributions).toEqual({ srs: 0, cpfSelf: 0, cpfFamily: 800 });
    expect(r.plan.taxAfter).toBe(7_950);
    expect(r.plan.taxSaved).toBe(120);
    expect(r.plan.savingRate).toBe(0.15);
    expect(r.plan.bindingConstraint).toBe('usefulRoom');
    expect(r.plan.unrealisedSaving).toBe(0);
    expect(codes(r)).toEqual(['EXISTING_EXCEEDS_CAP', 'FAMILY_TOPUP_CHECKS']);
  });

  it('min rate just above 15% (0.1501): nothing qualifies -> X = 0, BELOW_MIN_SAVING_RATE', () => {
    const r = plan(person({ ...base, minRate: 0.1501 }));
    expect(r.plan.totalContribution).toBe(0);
    expect(r.plan.taxSaved).toBe(0);
    expect(r.plan.bindingConstraint).toBe('usefulRoom');
    expect(codes(r)).toEqual(['BELOW_MIN_SAVING_RATE', 'EXISTING_EXCEEDS_CAP', 'FAMILY_TOPUP_CHECKS']);
    expect(r.warnings[0]?.params).toEqual({ marginalRate: 0.15, minSavingRate: 0.1501 });
  });

  it('min rate just below 15% (0.1499) behaves like 15%', () => {
    expect(plan(person({ ...base, minRate: 0.1499 })).plan.totalContribution).toBe(800);
  });

  it('min rate 11.5%: the family room (5,500) binds; unrealised 3,139.50; simulator in S$2,000 steps', () => {
    // U = 120,800 - 80,000 = 40,800; C = 32,800; L = 5,500 -> X = 5,500 (leverLimits).
    // CI after 115,300 -> 3,350 + 11.5% x 35,300 = 3,350 + 4,059.50 = 7,409.50. Saved 8,070 - 7,409.50 = 660.50
    //   (= 800 x 15% + 4,700 x 11.5% = 120 + 540.50).
    // Unrealised: 7,409.50 - tax(120,800 - min(40,800, 32,800) = 88,000) = 7,409.50 - (3,350 + 920) = 3,139.50.
    const r = plan(person({ ...base, minRate: 0.115, step: 2_000 }));
    expect(r.plan.contributions).toEqual({ srs: 0, cpfSelf: 0, cpfFamily: 5_500 });
    expect(r.plan.taxAfter).toBe(7_409.5);
    expect(r.plan.taxSaved).toBe(660.5);
    expect(r.plan.bindingConstraint).toBe('leverLimits');
    expect(r.plan.unrealisedSaving).toBe(3_139.5);
    expect(codes(r)).toEqual(['LEVER_LIMITS_PLAN', 'EXISTING_EXCEEDS_CAP', 'FAMILY_TOPUP_CHECKS']);
    expect(tiers(r)).toEqual([
      { from: 0, to: 800, amount: 800, rate: 0.15, saved: 120, cumulative: 120, used: 800, zero: undefined },
      { from: 800, to: 5_500, amount: 4_700, rate: 0.115, saved: 540.5, cumulative: 660.5, used: 4_700, zero: undefined },
    ]);
    // Simulator: 0, 2,000, 4,000, 5,500 (last step 1,500).
    //   2,000: CI 118,800 -> 3,350 + 11.5% x 38,800 = 7,812.00; saved 258.00; step rate 258 / 2,000 = 0.129
    //   4,000: CI 116,800 -> 3,350 + 11.5% x 36,800 = 7,582.00; saved 488.00; step 230.00 -> 0.115
    //   5,500: 7,409.50; saved 660.50; step 172.50 / 1,500 = 0.115
    expect(r.simulator).toEqual([
      { contribution: 0, split: { srs: 0, cpfSelf: 0, cpfFamily: 0 }, taxPayable: 8_070, taxSaved: 0, stepSaving: 0, stepRate: 0, withinPlan: true },
      { contribution: 2_000, split: { srs: 0, cpfSelf: 0, cpfFamily: 2_000 }, taxPayable: 7_812, taxSaved: 258, stepSaving: 258, stepRate: 0.129, withinPlan: true },
      { contribution: 4_000, split: { srs: 0, cpfSelf: 0, cpfFamily: 4_000 }, taxPayable: 7_582, taxSaved: 488, stepSaving: 230, stepRate: 0.115, withinPlan: true },
      { contribution: 5_500, split: { srs: 0, cpfSelf: 0, cpfFamily: 5_500 }, taxPayable: 7_409.5, taxSaved: 660.5, stepSaving: 172.5, stepRate: 0.115, withinPlan: true },
    ]);
    // Scenarios: SRS and CPF self have no room even "if enabled"; maxAll is the family room only.
    expect(scenario(r, 'srsOnly').totalContribution).toBe(0);
    expect(scenario(r, 'cpfSelfOnly').totalContribution).toBe(0);
    expect(scenario(r, 'srsPlusCpfSelf').totalContribution).toBe(0);
    expect(scenario(r, 'maxAll')).toMatchObject({ contributions: { srs: 0, cpfSelf: 0, cpfFamily: 5_500 }, taxSaved: 660.5, wastedContribution: 0 });
  });

  it('a budget smaller than the top tier: 500 of the 800 dollars at 15%', () => {
    // X = min(U 800, C 32,800, L 5,500, B 500) = 500 -> cashBudget. Saved 75.00. Tax after 7,995.00.
    // Unrealised at min rate 15%: 7,995 - tax(120,000) = 45.00.
    const r = plan(person({ ...base, minRate: 0.15, budget: 500 }));
    expect(r.plan.contributions).toEqual({ srs: 0, cpfSelf: 0, cpfFamily: 500 });
    expect(r.plan.taxSaved).toBe(75);
    expect(r.plan.taxAfter).toBe(7_995);
    expect(r.plan.bindingConstraint).toBe('cashBudget');
    expect(r.plan.unrealisedSaving).toBe(45);
    expect(r.ladder[0]).toMatchObject({ amount: 800, rate: 0.15, usedByPlan: 500 });
    expect(r.ladder[1]).toMatchObject({ amount: 4_700, rate: 0.115, usedByPlan: 0 });
    expect(codes(r)).toEqual(['BUDGET_LIMITS_PLAN', 'EXISTING_EXCEEDS_CAP', 'FAMILY_TOPUP_CHECKS']);
  });
});

describe('H11 — relief cap already exceeded at baseline for a 61-year-old', () => {
  // Age 61, December birthday: completedAge 60 all year -> "above 60 to 65": 12.5% x 8,000 = 1,000 x 12 = 12,000.
  // EIR 8,000. Other reliefs 65,000 -> 85,000 before the cap; 80,000 allowed; 5,000 lost.
  // Income 96,000 + other income 50,000 = 146,000. CI 66,000. Tax 550 + 7% x 26,000 = 2,370.00.
  // CPF top-up room confirmed at the full S$8,000 (required from 55, SPEC §6.5), so L = 23,300.
  const r = plan(person({ age: 61, ow: 8_000, otherIncome: 50_000, otherReliefs: 65_000, roomToLimit: 8_000 }));

  it('baseline', () => {
    expect(r.cpf.employeeContribution).toBe(12_000);
    expect(r.baseline.totalIncome).toBe(146_000);
    expect(r.baseline.reliefs).toMatchObject({ earnedIncome: 8_000, cpf: 12_000, other: 65_000, totalBeforeCap: 85_000, totalAllowed: 80_000, lostToCap: 5_000 });
    expect(r.baseline.chargeableIncome).toBe(66_000);
    expect(r.baseline.taxPayable).toBe(2_370);
    expect(r.reliefCapRoom).toBe(0);
  });

  it('nothing is recommended; every scheme dollar would be wasted', () => {
    expect(r.plan.totalContribution).toBe(0);
    expect(r.plan.bindingConstraint).toBe('reliefCap');
    expect(r.plan.unrealisedSaving).toBe(0);
    expect(codes(r)).toEqual(['RELIEF_CAP_EXCEEDED_BASELINE', 'RELIEF_CAP_LIMITS_PLAN', 'AGE_55_PLUS_TOPUP']);
    expect(tiers(r)).toEqual([
      { from: 0, to: 23_300, amount: 23_300, rate: 0, saved: 0, cumulative: 0, used: 0, zero: 'reliefCap' },
    ]);
    expect(scenario(r, 'srsPlusCpfSelf')).toMatchObject({ totalContribution: 23_300, taxSaved: 0, savingRate: 0, wastedContribution: 23_300 });
    expect(r.simulator).toHaveLength(25);
    expect(r.simulator.every((row) => row.taxPayable === 2_370 && row.taxSaved === 0 && row.stepRate === 0)).toBe(true);
    expect(r.simulator.map((row) => row.withinPlan)).toEqual([true, ...new Array(24).fill(false)]);
  });

  it('with the CPF room left blank only the SRS room (15,300) is on the ladder, and the caution replaces the note', () => {
    const blank = plan(person({ age: 61, ow: 8_000, otherIncome: 50_000, otherReliefs: 65_000 }));
    expect(blank.plan).toEqual(r.plan);
    expect(codes(blank)).toEqual(['RELIEF_CAP_EXCEEDED_BASELINE', 'RELIEF_CAP_LIMITS_PLAN', 'CPF_SELF_ROOM_UNCONFIRMED']);
    expect(tiers(blank)).toEqual([
      { from: 0, to: 15_300, amount: 15_300, rate: 0, saved: 0, cumulative: 0, used: 0, zero: 'reliefCap' },
    ]);
    expect(scenario(blank, 'srsPlusCpfSelf')).toMatchObject({ totalContribution: 15_300, taxSaved: 0, wastedContribution: 15_300 });
    expect(blank.simulator).toHaveLength(17); // 0, 1,000 ... 15,000, 15,300
  });
});

// ---------------------------------------------------------------------------------------------------------
// H12–H14: budgets, bracket edges, falling below the tax threshold
// ---------------------------------------------------------------------------------------------------------

describe('H12 — a budget smaller than the top tier, "guaranteed interest first"', () => {
  // S$9,000 a month + S$20,000 bonus: income 128,000; CPF 19,200 + 1,200 = 20,400; EIR 1,000.
  // CI 106,600. Tax 3,350 + 11.5% x 26,600 = 3,350 + 3,059 = 6,409.00.
  // Min rate 7%: U = 66,600; C = 58,600; L = 23,300; B = 2,500 -> X = 2,500 (cashBudget), all to CPF self.
  // Tax after 6,409 - 287.50 = 6,121.50.
  // Unrealised: 6,121.50 - tax(106,600 - 58,600 = 48,000) = 6,121.50 - (550 + 560) = 5,011.50.
  const r = plan(
    person({ age: 30, ow: 9_000, aw: 20_000, minRate: 0.07, budget: 2_500, priority: ['cpfSelf', 'srs', 'cpfFamily'], today: '2026-10-05' }),
  );

  it('plan', () => {
    expect(r.baseline.taxPayable).toBe(6_409);
    expect(r.plan.contributions).toEqual({ srs: 0, cpfSelf: 2_500, cpfFamily: 0 });
    expect(r.plan.taxAfter).toBe(6_121.5);
    expect(r.plan.taxSaved).toBe(287.5);
    expect(r.plan.savingRate).toBe(0.115);
    expect(r.plan.bindingConstraint).toBe('cashBudget');
    expect(r.plan.unrealisedSaving).toBe(5_011.5);
    expect(codes(r)).toEqual(['BUDGET_LIMITS_PLAN']);
    // What more cash can actually deliver (SPEC §6.11): without the limit the schemes are full at L = 23,300,
    // CI 83,300, tax 3,350 + 11.5% x 3,300 = 3,729.50; 6,121.50 - 3,729.50 = 2,392.00 (20,800 x 11.5%).
    expect(r.warnings[0]?.params).toEqual({ cashBudget: 2_500, unrealisedSaving: 5_011.5, savingWithMoreCash: 2_392 });
    expect(r.warnings[0]?.message).toBe(
      'Your cash limit of S$2,500 is what stops the plan. With more cash you could save up to S$2,392.00 more tax.',
    );
  });

  it('ladder and simulator ignore the budget but mark what the plan uses', () => {
    expect(tiers(r)).toEqual([
      { from: 0, to: 23_300, amount: 23_300, rate: 0.115, saved: 2_679.5, cumulative: 2_679.5, used: 2_500, zero: undefined },
    ]);
    expect(r.simulator.filter((row) => row.withinPlan).map((row) => row.contribution)).toEqual([0, 1_000, 2_000]);
    // CPF self fills first in the simulator too: row 9 = 8,000 self + 1,000 SRS.
    expect(r.simulator[9]?.split).toEqual({ srs: 1_000, cpfSelf: 8_000, cpfFamily: 0 });
    expect(r.simulator[24]).toMatchObject({ contribution: 23_300, taxSaved: 2_679.5, stepSaving: 34.5 });
  });

  it('monthly plan from 5 October: 834 + 833 + 833; from January it would be 209 a month', () => {
    expect(r.monthlyPlan.monthsRemaining).toBe(3);
    // 5 Oct -> 31 Dec: 26 days left in October + 30 + 31 = 87.
    expect(r.monthlyPlan.daysToDeadline).toBe(87);
    expect(r.monthlyPlan.schedule).toEqual([
      { month: '2026-10', amounts: { srs: 0, cpfSelf: 834, cpfFamily: 0 }, total: 834 },
      { month: '2026-11', amounts: { srs: 0, cpfSelf: 833, cpfFamily: 0 }, total: 833 },
      { month: '2026-12', amounts: { srs: 0, cpfSelf: 833, cpfFamily: 0 }, total: 833 },
    ]);
    // ceil(2,500 / 12) = ceil(208.33) = 209.
    expect(r.monthlyPlan.fullYearMonthly).toEqual({ srs: 0, cpfSelf: 209, cpfFamily: 0, total: 209 });
  });
});

describe('H13 — chargeable income exactly on a bracket edge (80,000) and one dollar above', () => {
  // S$8,000 a month: income 96,000; CPF 19,200; EIR 1,000 -> reliefs 20,200.
  // Other income 4,200 -> total 100,200 -> CI 80,000 exactly. Tax 3,350.00. The last dollar is in the 7% band.
  it('CI 80,000: marginal rate 7%; a 11.5% minimum recommends nothing; a 7% minimum uses all 23,300', () => {
    const strict = plan(person({ ow: 8_000, otherIncome: 4_200, minRate: 0.115 }));
    expect(strict.baseline.chargeableIncome).toBe(80_000);
    expect(strict.baseline.taxPayable).toBe(3_350);
    expect(strict.baseline.marginalRate).toBe(0.07);
    expect(strict.plan.totalContribution).toBe(0);
    expect(strict.plan.bindingConstraint).toBe('usefulRoom');
    expect(codes(strict)).toEqual(['BELOW_MIN_SAVING_RATE']);
    expect(strict.warnings[0]?.params).toEqual({ marginalRate: 0.07, minSavingRate: 0.115 });

    // Min rate 7%: U = 40,000; C = 59,800; L = 23,300 -> X = 23,300.
    // CI after 56,700 -> 550 + 7% x 16,700 = 1,719.00. Saved 1,631.00.
    // Unrealised: 1,719 - tax(80,000 - min(40,000, 59,800) = 40,000) = 1,719 - 550 = 1,169.00.
    const r = plan(person({ ow: 8_000, otherIncome: 4_200, minRate: 0.07 }));
    expect(r.plan.totalContribution).toBe(23_300);
    expect(r.plan.taxAfter).toBe(1_719);
    expect(r.plan.taxSaved).toBe(1_631);
    expect(r.plan.unrealisedSaving).toBe(1_169);
    expect(tiers(r)).toEqual([
      { from: 0, to: 23_300, amount: 23_300, rate: 0.07, saved: 1_631, cumulative: 1_631, used: 23_300, zero: undefined },
    ]);
  });

  it('CI 80,001: tax 3,350.115 -> 3,350.12; a 11.5% minimum recommends exactly one dollar', () => {
    const r = plan(person({ ow: 8_000, otherIncome: 4_201, minRate: 0.115 }));
    expect(r.baseline.chargeableIncome).toBe(80_001);
    expect(r.baseline.taxPayable).toBe(3_350.12);
    expect(r.baseline.marginalRate).toBe(0.115);
    expect(r.plan.contributions).toEqual({ srs: 1, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.taxAfter).toBe(3_350);
    expect(r.plan.taxSaved).toBe(0.12);
    expect(r.plan.bindingConstraint).toBe('usefulRoom');
    // Ladder: 1 dollar at 11.5% (realised 0.12), then 23,299 at 7% (1,630.93); total 1,631.05.
    expect(tiers(r)).toEqual([
      { from: 0, to: 1, amount: 1, rate: 0.115, saved: 0.12, cumulative: 0.12, used: 1, zero: undefined },
      { from: 1, to: 23_300, amount: 23_299, rate: 0.07, saved: 1_630.93, cumulative: 1_631.05, used: 0, zero: undefined },
    ]);
  });

  it('CI 79,999: marginal 7%, tax 3,349.93', () => {
    // 550 + 7% x 39,999 = 550 + 2,799.93 = 3,349.93.
    const r = plan(person({ ow: 8_000, otherIncome: 4_199, minRate: 0.07 }));
    expect(r.baseline.chargeableIncome).toBe(79_999);
    expect(r.baseline.taxPayable).toBe(3_349.93);
    expect(r.baseline.marginalRate).toBe(0.07);
  });

  it('CI exactly 20,000 and 20,001: no tax vs two cents', () => {
    // S$2,000 a month: income 24,000; CPF 4,800; EIR 1,000; CI 18,200. Other income 1,800 -> 20,000; 1,801 -> 20,001.
    const edge = plan(person({ ow: 2_000, otherIncome: 1_800 }));
    expect(edge.baseline.chargeableIncome).toBe(20_000);
    expect(edge.baseline.taxPayable).toBe(0);
    expect(edge.baseline.marginalRate).toBe(0);
    expect(edge.plan.bindingConstraint).toBe('none');
    expect(codes(edge)).toEqual(['NO_TAX_PAYABLE']);
    const above = plan(person({ ow: 2_000, otherIncome: 1_801 }));
    expect(above.baseline.chargeableIncome).toBe(20_001);
    expect(above.baseline.taxPayable).toBe(0.02);
    expect(above.baseline.marginalRate).toBe(0.02);
    expect(above.plan.contributions).toEqual({ srs: 1, cpfSelf: 0, cpfFamily: 0 });
    expect(above.plan.taxSaved).toBe(0.02);
    expect(above.plan.bindingConstraint).toBe('usefulRoom');
    expect(codes(above)).toEqual([]);
  });
});

describe('H14 — a contribution large enough to push chargeable income below S$20,000', () => {
  // S$3,000 a month + S$3,000 bonus: income 39,000. CPF 600 x 12 + 600 = 7,800. EIR 1,000. Reliefs 8,800.
  // CI 30,200. Tax 200 + 3.5% x 200 = 207.00. C = 71,200. All three levers on: L = 31,300.
  const r = plan(person({ age: 25, ow: 3_000, aw: 3_000, familyOn: true, minRate: 0 }));

  it('plan stops at the tax-free threshold: 10,200 into SRS saves the whole 207.00', () => {
    expect(r.baseline.chargeableIncome).toBe(30_200);
    expect(r.baseline.taxPayable).toBe(207);
    expect(r.plan.contributions).toEqual({ srs: 10_200, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.taxAfter).toBe(0);
    expect(r.plan.taxSaved).toBe(207);
    expect(r.plan.chargeableIncomeBefore).toBe(30_200);
    expect(r.plan.chargeableIncomeAfter).toBe(20_000);
    expect(r.plan.marginalRateBefore).toBe(0.035);
    expect(r.plan.marginalRateAfter).toBe(0);
    expect(r.plan.savingRate).toBe(207 / 10_200);
    expect(r.plan.bindingConstraint).toBe('usefulRoom');
    expect(r.plan.unrealisedSaving).toBe(0);
    expect(codes(r)).toEqual([]);
  });

  it('ladder: 200 at 3.5%, 10,000 at 2%, then 21,100 that save nothing', () => {
    expect(tiers(r)).toEqual([
      { from: 0, to: 200, amount: 200, rate: 0.035, saved: 7, cumulative: 7, used: 200, zero: undefined },
      { from: 200, to: 10_200, amount: 10_000, rate: 0.02, saved: 200, cumulative: 207, used: 10_000, zero: undefined },
      { from: 10_200, to: 31_300, amount: 21_100, rate: 0, saved: 0, cumulative: 207, used: 0, zero: 'belowTaxThreshold' },
    ]);
  });

  it('scenarios count the dollars below the threshold as wasted', () => {
    // srsOnly 15,300: CI 14,900 -> tax 0; wasted 15,300 - 10,200 = 5,100.
    // cpfSelfOnly 8,000: CI 22,200 -> 44.00; saved 163.00; wasted 0.
    // srsPlusCpfSelf 23,300: wasted 13,100. maxAll 31,300: CI 0 (floored), wasted 21,100.
    expect(scenario(r, 'srsOnly')).toMatchObject({ totalContribution: 15_300, taxPayable: 0, taxSaved: 207, wastedContribution: 5_100 });
    expect(scenario(r, 'cpfSelfOnly')).toMatchObject({ totalContribution: 8_000, taxPayable: 44, taxSaved: 163, wastedContribution: 0 });
    expect(scenario(r, 'srsPlusCpfSelf')).toMatchObject({ totalContribution: 23_300, taxSaved: 207, wastedContribution: 13_100 });
    expect(scenario(r, 'maxAll')).toMatchObject({ totalContribution: 31_300, taxSaved: 207, wastedContribution: 21_100 });
    expect(scenario(r, 'maxAll').savingRate).toBe(207 / 31_300);
    expect(scenario(r, 'recommended')).toMatchObject({ totalContribution: 10_200, taxSaved: 207, wastedContribution: 0 });
    expect(evaluate(person({ age: 25, ow: 3_000, aw: 3_000 }), { srs: 15_300, cpfSelf: 8_000, cpfFamily: 8_000 }).chargeableIncome).toBe(0);
  });

  it('simulator: 33 rows; the saving flattens after 10,200', () => {
    // i = 0 .. ceil(31,300 / 1,000) = 32.
    expect(r.simulator).toHaveLength(33);
    // Row 10 (10,000): CI 20,200 -> 4.00 tax; saved 203.00. Row 9 (9,000): CI 21,200 -> 24.00; saved 183.00.
    expect(r.simulator[9]).toMatchObject({ contribution: 9_000, taxPayable: 24, taxSaved: 183 });
    expect(r.simulator[10]).toMatchObject({ contribution: 10_000, taxPayable: 4, taxSaved: 203, stepSaving: 20, stepRate: 0.02, withinPlan: true });
    // Row 11 (11,000): tax 0; step saving 4.00 over 1,000 dollars.
    expect(r.simulator[11]).toMatchObject({ contribution: 11_000, taxPayable: 0, taxSaved: 207, stepSaving: 4, stepRate: 0.004, withinPlan: false });
    // Last row: 31,300 (a 300-dollar step), split SRS 15,300 / self 8,000 / family 8,000.
    expect(r.simulator[32]).toEqual({
      contribution: 31_300,
      split: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 8_000 },
      taxPayable: 0,
      taxSaved: 207,
      stepSaving: 0,
      stepRate: 0,
      withinPlan: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------
// H15–H18: foreigner, under-18, CPF override, donations
// ---------------------------------------------------------------------------------------------------------

describe('H15 — foreigner with the S$35,700 SRS cap', () => {
  // S$25,000 a month + S$60,000 bonus: income 360,000. No CPF. EIR 1,000.
  // Existing SRS 10,000 (relief), existing CPF self top-up 5,000 and family 2,000 (no relief for a foreigner).
  // Reliefs 11,000. CI 349,000. Tax 44,550 + 22% x 29,000 = 44,550 + 6,380 = 50,930.00.
  const base: Person = {
    residency: 'foreigner',
    age: 45,
    ow: 25_000,
    aw: 60_000,
    existingSrs: 10_000,
    existingSelf: 5_000,
    existingFamily: 2_000,
    familyOn: true,
    override: 9_999,
  };

  it('min rate 22%: U 29,000 · C 69,000 · L 25,700 -> SRS 25,700 (leverLimits)', () => {
    // CI after 323,300 -> 44,550 + 22% x 3,300 = 45,276.00. Saved 5,654.00.
    // Unrealised: 45,276 - tax(349,000 - 29,000 = 320,000) = 45,276 - 44,550 = 726.00.
    const r = plan(person({ ...base, minRate: 0.22 }));
    expect(r.cpf).toEqual({
      source: 'none',
      ordinaryWagesSubject: 0,
      additionalWageCeiling: 0,
      additionalWagesSubject: 0,
      employeeContribution: 0,
      employerContribution: 0,
      monthlyEmployeeRates: new Array(12).fill(0),
    });
    expect(r.baseline.reliefs).toMatchObject({ earnedIncome: 1_000, cpf: 0, srs: 10_000, cpfTopUpSelf: 0, cpfTopUpFamily: 0, totalBeforeCap: 11_000 });
    expect(r.baseline.chargeableIncome).toBe(349_000);
    expect(r.baseline.taxPayable).toBe(50_930);
    expect(r.levers).toEqual({
      srs: { statutoryCap: 35_700, used: 10_000, room: 25_700, eligible: true, enabled: true },
      cpfSelf: { statutoryCap: 0, used: 0, room: 0, eligible: false, enabled: true },
      cpfFamily: { statutoryCap: 0, used: 0, room: 0, eligible: false, enabled: true },
    });
    expect(r.plan.contributions).toEqual({ srs: 25_700, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.taxAfter).toBe(45_276);
    expect(r.plan.taxSaved).toBe(5_654);
    expect(r.plan.bindingConstraint).toBe('leverLimits');
    expect(r.plan.unrealisedSaving).toBe(726);
    // SRS is on and open to this foreigner, so the withdrawal caution follows FOREIGNER_NO_CPF (SPEC §6.11);
    // the S$2,000 already given to family raises nothing, because a foreigner gets no relief for it (§6.5).
    expect(codes(r)).toEqual(['LEVER_LIMITS_PLAN', 'FOREIGNER_NO_CPF', 'SRS_NON_RESIDENT_WITHDRAWAL']);
    // Every plan dollar is on the 22% rung, far above the 7.5 cents it costs a non-resident to take out.
    expect(r.warnings[2]?.params).toMatchObject({ lowValueAmount: 0 });
    expect(scenario(r, 'maxAll').contributions).toEqual({ srs: 25_700, cpfSelf: 0, cpfFamily: 0 });
    expect(scenario(r, 'cpfSelfOnly').totalContribution).toBe(0);
  });

  it('nothing contributed yet and min rate 20%: the full 35,700 across the 22% and 20% bands', () => {
    // Reliefs 1,000. CI 359,000. Tax 44,550 + 22% x 39,000 = 53,130.00.
    // U(20%) = 359,000 - 280,000 = 79,000; L = 35,700 -> X = 35,700.
    // CI after 323,300 -> 45,276.00. Saved 7,854.00 = 35,700 x 22%.
    const r = plan(person({ ...base, existingSrs: 0, minRate: 0.2 }));
    expect(r.baseline.taxPayable).toBe(53_130);
    expect(r.plan.contributions).toEqual({ srs: 35_700, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.taxSaved).toBe(7_854);
    expect(r.simulator).toHaveLength(37); // 0 .. 35,000 in thousands, then 35,700
    expect(r.simulator[36]).toMatchObject({ contribution: 35_700, stepSaving: 154, stepRate: 0.22 });
  });

  it('existing SRS of 35,701 is one dollar over the foreigner cap', () => {
    const r = plan(person({ ...base, existingSrs: 35_701, minRate: 0.2 }));
    expect(r.levers.srs).toEqual({ statutoryCap: 35_700, used: 35_700, room: 0, eligible: true, enabled: true });
    expect(r.baseline.reliefs.srs).toBe(35_700);
    expect(r.plan.totalContribution).toBe(0);
    expect(codes(r)).toEqual(['LEVER_LIMITS_PLAN', 'EXISTING_EXCEEDS_CAP', 'FOREIGNER_NO_CPF', 'SRS_NON_RESIDENT_WITHDRAWAL']);
    expect(r.warnings[1]?.params).toEqual({ levers: 'srs', srsExisting: 35_701, srsCap: 35_700, srsExcess: 1 });
  });

  it('the same person as a 3rd-year PR gets CPF relief, the 15,300 SRS cap and both top-up levers', () => {
    // CPF 19,200 + 20% x 6,000 = 20,400. Reliefs 1,000 + 20,400 + 10,000 + 5,000 + 2,000 = 38,400.
    // CI 321,600. Tax 44,550 + 22% x 1,600 = 44,902.00.
    const r = plan(person({ ...base, residency: 'pr', override: null, minRate: 0.2 }));
    expect(r.baseline.reliefs.totalBeforeCap).toBe(38_400);
    expect(r.baseline.chargeableIncome).toBe(321_600);
    expect(r.baseline.taxPayable).toBe(44_902);
    expect(r.levers.srs.room).toBe(5_300);
    expect(r.levers.cpfSelf.room).toBe(3_000);
    expect(r.levers.cpfFamily.room).toBe(6_000);
    // U(20%) = 41,600; C = 41,600 as well (80,000 - 38,400); L = 14,300 -> X = 14,300.
    // CI after 307,300 -> 36,550 + 20% x 27,300 = 42,010.00. Saved 2,892.00 = 1,600 x 22% + 12,700 x 20%.
    expect(r.plan.totalContribution).toBe(14_300);
    expect(r.plan.taxSaved).toBe(2_892);
    expect(r.plan.bindingConstraint).toBe('leverLimits');
  });
});

describe('H16 — under 18', () => {
  // Age 17. S$2,000 a month: income 24,000; CPF 400 x 12 = 4,800; EIR 1,000. Other income 30,000 -> total 54,000.
  // SRS already contributed (4,000) earns nothing under 18. CI 54,000 - 5,800 = 48,200. Tax 550 + 7% x 8,200 = 1,124.00.
  it('17: SRS is out, CPF self takes the plan', () => {
    // Min rate 7%: U = 8,200; L = 8,000 (CPF self only) -> X = 8,000 (leverLimits).
    // CI after 40,200 -> 550 + 14 = 564.00. Saved 560.00. Unrealised 564 - 550 = 14.00.
    const r = plan(person({ age: 17, ow: 2_000, otherIncome: 30_000, existingSrs: 4_000, minRate: 0.07 }));
    expect(r.levers.srs).toEqual({ statutoryCap: 0, used: 0, room: 0, eligible: false, enabled: true });
    expect(r.baseline.reliefs.srs).toBe(0);
    expect(r.baseline.chargeableIncome).toBe(48_200);
    expect(r.baseline.taxPayable).toBe(1_124);
    expect(r.plan.contributions).toEqual({ srs: 0, cpfSelf: 8_000, cpfFamily: 0 });
    expect(r.plan.taxAfter).toBe(564);
    expect(r.plan.taxSaved).toBe(560);
    expect(r.plan.unrealisedSaving).toBe(14);
    expect(codes(r)).toEqual(['LEVER_LIMITS_PLAN', 'SRS_UNDER_18']);
    expect(scenario(r, 'srsOnly').totalContribution).toBe(0);
    expect(scenario(r, 'srsPlusCpfSelf').contributions).toEqual({ srs: 0, cpfSelf: 8_000, cpfFamily: 0 });
  });

  it('18: SRS counts — the existing 4,000 is relief and 11,300 of room remains', () => {
    // Reliefs 5,800 + 4,000 = 9,800. CI 44,200. Tax 550 + 7% x 4,200 = 844.00.
    // Min rate 7%: U = 4,200 -> SRS 4,200. Tax after 550.00.
    const r = plan(person({ age: 18, ow: 2_000, otherIncome: 30_000, existingSrs: 4_000, minRate: 0.07 }));
    expect(r.levers.srs).toEqual({ statutoryCap: 15_300, used: 4_000, room: 11_300, eligible: true, enabled: true });
    expect(r.baseline.chargeableIncome).toBe(44_200);
    expect(r.baseline.taxPayable).toBe(844);
    expect(r.plan.contributions).toEqual({ srs: 4_200, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.taxAfter).toBe(550);
    expect(codes(r)).toEqual([]);
  });

  it('a 17-year-old foreigner has no lever at all', () => {
    // No CPF. Income 24,000 + 30,000; EIR 1,000; CI 53,000; tax 550 + 7% x 13,000 = 1,460.00.
    const r = plan(person({ residency: 'foreigner', age: 17, ow: 2_000, otherIncome: 30_000, familyOn: true, minRate: 0.07 }));
    expect(r.baseline.taxPayable).toBe(1_460);
    expect(r.plan.totalContribution).toBe(0);
    expect(r.plan.bindingConstraint).toBe('leverLimits');
    expect(r.ladder).toEqual([]);
    expect(r.simulator).toHaveLength(1);
    expect(codes(r)).toEqual(['LEVER_LIMITS_PLAN', 'FOREIGNER_NO_CPF', 'SRS_UNDER_18']);
  });
});

describe('H17 — CPF override for a 2nd-year PR who turns 60 in April', () => {
  // S$9,000 a month, S$10,000 bonus, 2026. Auto: Jan–Apr completedAge 59 -> PR year-2 "above 55 to 60" 12.5%;
  // May–Dec completedAge 60 -> "above 60 to 65" 7.5%.
  //   OW: floor(12.5% x 8,000) = 1,000 x 4 + floor(7.5% x 8,000) = 600 x 8 = 4,000 + 4,800 = 8,800
  //   AW: ceiling 6,000 -> 7.5% x 6,000 = 450. Auto total 9,250.
  // Income 108,000 + 10,000 = 118,000. EIR at 60 = 8,000.
  // CPF top-up room confirmed at the full S$8,000 (required from 55, SPEC §6.5), hence AGE_55_PLUS_TOPUP below.
  const base: Person = { residency: 'pr', prYear: 2, age: 60, birthMonth: 4, ow: 9_000, aw: 10_000, minRate: 0.115, roomToLimit: 8_000 };

  it('auto: 9,250', () => {
    const r = plan(person(base));
    expect(r.cpf.source).toBe('auto');
    expect(r.cpf.employeeContribution).toBe(9_250);
    expect(r.cpf.monthlyEmployeeRates).toEqual([0.125, 0.125, 0.125, 0.125, 0.075, 0.075, 0.075, 0.075, 0.075, 0.075, 0.075, 0.075]);
    // CI 118,000 - 8,000 - 9,250 = 100,750 -> 3,350 + 11.5% x 20,750 = 3,350 + 2,386.25 = 5,736.25.
    expect(r.baseline.chargeableIncome).toBe(100_750);
    expect(r.baseline.taxPayable).toBe(5_736.25);
    expect(codes(r)).toEqual(['PR_GRADUATED_RATES', 'AGE_55_PLUS_TOPUP']);
  });

  it('override 12,345: used as the relief; wage breakdown and monthly rates still from the auto-calculation', () => {
    // Reliefs 8,000 + 12,345 = 20,345. CI 97,655. Tax 3,350 + 11.5% x 17,655 = 3,350 + 2,030.325 -> 5,380.33.
    const r = plan(person({ ...base, override: 12_345 }));
    expect(r.cpf).toEqual({
      source: 'override',
      ordinaryWagesSubject: 96_000,
      additionalWageCeiling: 6_000,
      additionalWagesSubject: 6_000,
      employeeContribution: 12_345,
      employerContribution: 0,
      monthlyEmployeeRates: [0.125, 0.125, 0.125, 0.125, 0.075, 0.075, 0.075, 0.075, 0.075, 0.075, 0.075, 0.075],
    });
    expect(r.baseline.reliefs.cpf).toBe(12_345);
    expect(r.baseline.chargeableIncome).toBe(97_655);
    expect(r.baseline.taxPayable).toBe(5_380.33);
    // Min rate 11.5%: U = 17,655; L = 23,300 -> X = 17,655: SRS 15,300 + CPF self 2,355. Tax after 3,350.00.
    expect(r.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 2_355, cpfFamily: 0 });
    expect(r.plan.taxSaved).toBe(2_030.33);
    expect(codes(r)).toEqual(['PR_GRADUATED_RATES', 'AGE_55_PLUS_TOPUP']);
  });

  it('override 12,345 with the CPF room left blank: the plan stops at the SRS cap', () => {
    // L = 15,300 < U = 17,655 -> X = 15,300 (leverLimits). CI after 82,355 -> 3,350 + 11.5% x 2,355
    //   = 3,350 + 270.825 -> 3,620.83 (half-up). Saved 5,380.33 - 3,620.83 = 1,759.50 (= 15,300 x 11.5%).
    const r = plan(person({ ...base, override: 12_345, roomToLimit: null }));
    expect(r.baseline.taxPayable).toBe(5_380.33);
    expect(r.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.taxAfter).toBe(3_620.83);
    expect(r.plan.taxSaved).toBe(1_759.5);
    expect(r.plan.bindingConstraint).toBe('leverLimits');
    expect(codes(r)).toEqual(['LEVER_LIMITS_PLAN', 'PR_GRADUATED_RATES', 'CPF_SELF_ROOM_UNCONFIRMED']);
  });

  it('override 25,000 is held at 20,400 with a caution; 20,400 itself raises nothing; 0 means zero relief', () => {
    const over = plan(person({ ...base, override: 25_000 }));
    expect(over.cpf.employeeContribution).toBe(20_400);
    // CI 118,000 - 28,400 = 89,600 -> 3,350 + 11.5% x 9,600 = 4,454.00.
    expect(over.baseline.taxPayable).toBe(4_454);
    expect(codes(over)).toEqual(['CPF_OVERRIDE_ABOVE_MAX', 'PR_GRADUATED_RATES', 'AGE_55_PLUS_TOPUP']);
    expect(over.warnings[0]?.params).toEqual({ override: 25_000, maxCompulsory: 20_400 });
    expect(codes(plan(person({ ...base, override: 20_400 })))).toEqual(['PR_GRADUATED_RATES', 'AGE_55_PLUS_TOPUP']);
    const zeroResult = plan(person({ ...base, override: 0 }));
    expect(zeroResult.cpf.source).toBe('override');
    expect(zeroResult.cpf.employeeContribution).toBe(0);
    // CI 118,000 - 8,000 = 110,000 -> 3,350 + 11.5% x 30,000 = 6,800.00.
    expect(zeroResult.baseline.taxPayable).toBe(6_800);
  });
});

describe('H18 — donations whose 250% deduction ends in .5', () => {
  // S$5,000 a month: income 60,000; CPF 12,000; EIR 1,000.
  it('donation 201 -> deduction 502.50; chargeable income floors to 46,497', () => {
    // Assessable 59,497.50. CI floor(59,497.50 - 13,000) = 46,497. Tax 550 + 7% x 6,497 = 550 + 454.79 = 1,004.79.
    const r = plan(person({ ow: 5_000, donations: 201, minRate: 0.07 }));
    expect(r.baseline.donationDeduction).toBe(502.5);
    expect(r.baseline.assessableIncome).toBe(59_497.5);
    expect(r.baseline.chargeableIncome).toBe(46_497);
    expect(r.baseline.taxPayable).toBe(1_004.79);
    // U = 6,497 -> SRS 6,497. After: floor(59,497.50 - 19,497) = floor(40,000.50) = 40,000 -> 550.00.
    expect(r.plan.contributions).toEqual({ srs: 6_497, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.chargeableIncomeAfter).toBe(40_000);
    expect(r.plan.taxAfter).toBe(550);
    expect(r.plan.taxSaved).toBe(454.79);
  });

  it('donation 1 -> deduction 2.50: one half-dollar disappears in the floor', () => {
    // Assessable 59,997.50; CI floor(46,997.50) = 46,997; tax 550 + 7% x 6,997 = 1,039.79.
    const r = plan(person({ ow: 5_000, donations: 1 }));
    expect(r.baseline.donationDeduction).toBe(2.5);
    expect(r.baseline.chargeableIncome).toBe(46_997);
    expect(r.baseline.taxPayable).toBe(1_039.79);
  });

  it('a deduction that leaves half a dollar of assessable income above the reliefs: CI 0', () => {
    // Other income only: 13,003; donations 5,201 -> 13,002.50; assessable 0.50; no reliefs; CI floor(0.5) = 0.
    const r = plan(person({ otherIncome: 13_003, donations: 5_201 }));
    expect(r.baseline.assessableIncome).toBe(0.5);
    expect(r.baseline.reliefs.totalBeforeCap).toBe(0);
    expect(r.baseline.chargeableIncome).toBe(0);
    expect(r.baseline.taxPayable).toBe(0);
  });

  it('a deduction larger than income: assessable 0, never negative', () => {
    const r = plan(person({ ow: 1_000, donations: 4_801 })); // 12,000 - 12,002.50
    expect(r.baseline.assessableIncome).toBe(0);
    expect(r.baseline.chargeableIncome).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// H19: "today" on 1 January, 31 December, the day after and the year before (the opening example's plan)
// ---------------------------------------------------------------------------------------------------------

describe('H19 — the calendar: 1 Jan, 31 Dec, the day after, the year before', () => {
  // S$10,000 a month + S$15,000 bonus, other reliefs 5,000 (Appendix A.1): X = 23,300 = SRS 15,300 + CPF self 8,000.
  const base: Person = { ow: 10_000, aw: 15_000, otherReliefs: 5_000, minRate: 0.07 };

  it('1 January: 12 instalments, 364 days', () => {
    const r = plan(person({ ...base, today: '2026-01-01' }));
    expect(r.monthlyPlan.monthsRemaining).toBe(12);
    expect(r.monthlyPlan.daysToDeadline).toBe(364);
    // SRS 15,300 / 12 = 1,275 exactly. CPF self 8,000 = 666 x 12 + 8 -> eight months of 667, four of 666.
    expect(r.monthlyPlan.schedule.map((row) => row.month)).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
      '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
    ]);
    expect(r.monthlyPlan.schedule.map((row) => row.amounts.srs)).toEqual(new Array(12).fill(1_275));
    expect(r.monthlyPlan.schedule.map((row) => row.amounts.cpfSelf)).toEqual([667, 667, 667, 667, 667, 667, 667, 667, 666, 666, 666, 666]);
    expect(r.monthlyPlan.schedule.map((row) => row.total)).toEqual([1_942, 1_942, 1_942, 1_942, 1_942, 1_942, 1_942, 1_942, 1_941, 1_941, 1_941, 1_941]);
    expect(r.monthlyPlan.fullYearMonthly).toEqual({ srs: 1_275, cpfSelf: 667, cpfFamily: 0, total: 1_942 });
    expect(codes(r)).toEqual(['LEVER_LIMITS_PLAN']);
  });

  it('31 December: one instalment, 0 days, DEADLINE_SOON but not DEADLINE_PASSED', () => {
    const r = plan(person({ ...base, today: '2026-12-31' }));
    expect(r.monthlyPlan.monthsRemaining).toBe(1);
    expect(r.monthlyPlan.daysToDeadline).toBe(0);
    expect(r.monthlyPlan.schedule).toEqual([
      { month: '2026-12', amounts: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 }, total: 23_300 },
    ]);
    expect(codes(r)).toEqual(['LEVER_LIMITS_PLAN', 'DEADLINE_SOON']);
    expect(r.warnings[1]).toMatchObject({ severity: 'caution', params: { deadline: '2026-12-31', daysToDeadline: 0 } });
  });

  it('the day after (1 January 2027): the plan is unchanged, nothing is scheduled, DEADLINE_PASSED', () => {
    const r = plan(person({ ...base, today: '2027-01-01' }));
    expect(r.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 });
    expect(r.plan.taxSaved).toBe(2_679.5);
    expect(r.monthlyPlan.monthsRemaining).toBe(0);
    expect(r.monthlyPlan.daysToDeadline).toBe(-1);
    expect(r.monthlyPlan.schedule).toEqual([]);
    expect(r.monthlyPlan.fullYearMonthly).toEqual({ srs: 1_275, cpfSelf: 667, cpfFamily: 0, total: 1_942 });
    expect(codes(r)).toEqual(['LEVER_LIMITS_PLAN', 'DEADLINE_PASSED']);
    expect(r.warnings[1]).toMatchObject({ severity: 'blocker', params: { deadline: '2026-12-31', daysToDeadline: -1, daysSinceDeadline: 1 } });
  });

  it('the year before: 31 December 2025 is 365 days out with all 12 months of 2026 ahead', () => {
    const r = plan(person({ ...base, today: '2025-12-31' }));
    expect(r.monthlyPlan.monthsRemaining).toBe(12);
    expect(r.monthlyPlan.daysToDeadline).toBe(365);
    expect(r.monthlyPlan.schedule).toHaveLength(12);
    expect(r.monthlyPlan.schedule[0]?.month).toBe('2026-01');
    expect(r.monthlyPlan.schedule[11]?.month).toBe('2026-12');
    expect(codes(r)).toEqual(['LEVER_LIMITS_PLAN']);
    // 1 January 2025: 364 days left in 2025 + 365 in 2026 = 729.
    expect(plan(person({ ...base, today: '2025-01-01' })).monthlyPlan.daysToDeadline).toBe(729);
  });

  it('across a leap day: 28 February 2024 to 31 December 2025 is 672 days', () => {
    // 2024 is a leap year: 28 Feb is day 59, so 366 - 59 = 307 days to 31 Dec 2024, plus 365.
    const r = plan(person({ ...base, incomeYear: 2025, today: '2024-02-28' }));
    expect(r.monthlyPlan.daysToDeadline).toBe(672);
    expect(r.monthlyPlan.monthsRemaining).toBe(12);
    // 2028 is a leap year too: from 1 March 2028 back to 31 Dec 2027 is 31 + 29 + 1 = 61 days.
    const late = plan(person({ ...base, incomeYear: 2027, today: '2028-03-01' }));
    expect(late.monthlyPlan.daysToDeadline).toBe(-61);
    expect(late.warnings.find((w) => w.code === 'DEADLINE_PASSED')?.params).toMatchObject({ daysSinceDeadline: 61 });
  });

  it('14 days out warns, 15 days out does not; nothing recommended never warns "soon"', () => {
    expect(codes(plan(person({ ...base, today: '2026-12-17' })))).toEqual(['LEVER_LIMITS_PLAN', 'DEADLINE_SOON']);
    expect(plan(person({ ...base, today: '2026-12-17' })).monthlyPlan.daysToDeadline).toBe(14);
    expect(codes(plan(person({ ...base, today: '2026-12-16' })))).toEqual(['LEVER_LIMITS_PLAN']);
    expect(codes(plan(person({ ...base, today: '2026-12-31', minRate: 0.5 })))).toEqual(['BELOW_MIN_SAVING_RATE']);
  });

  it('an unparseable today is 1 January of the income year (SPEC §6.0)', () => {
    for (const today of ['', 'tomorrow', '2026-02-30', '2026-13-01', '13/11/2026', '20261113']) {
      const r = plan(person({ ...base, today }));
      expect(r.input.today).toBe('2026-01-01');
      expect(r.monthlyPlan.monthsRemaining).toBe(12);
      expect(r.monthlyPlan.daysToDeadline).toBe(364);
    }
    expect(plan(person({ ...base, incomeYear: 2027, today: 'x' })).input.today).toBe('2027-01-01');
  });
});

// ---------------------------------------------------------------------------------------------------------
// H20–H25: further interactions
// ---------------------------------------------------------------------------------------------------------

describe('H20 — "family first" with a family limit and a budget', () => {
  // The opening example's income (CI 108,600; tax 6,639.00). Family on with max 3,000; budget 10,000.
  // Priority family -> SRS -> CPF self: family 3,000, SRS 7,000, CPF self 0.
  // Saved 10,000 x 11.5% = 1,150.00; tax after 5,489.00.
  // Unrealised (min 7%): 5,489 - tax(108,600 - min(68,600, 53,600) = 55,000) = 5,489 - 1,600 = 3,889.00.
  const r = plan(
    person({
      ow: 10_000, aw: 15_000, otherReliefs: 5_000, minRate: 0.07,
      familyOn: true, maxAmount: 3_000, budget: 10_000, priority: ['cpfFamily', 'srs', 'cpfSelf'], today: '2026-10-05',
    }),
  );

  it('plan and unrealised saving', () => {
    expect(r.plan.contributions).toEqual({ srs: 7_000, cpfSelf: 0, cpfFamily: 3_000 });
    expect(r.plan.taxAfter).toBe(5_489);
    expect(r.plan.taxSaved).toBe(1_150);
    expect(r.plan.bindingConstraint).toBe('cashBudget');
    expect(r.plan.unrealisedSaving).toBe(3_889);
  });

  it('scenarios ignore the budget and the priority', () => {
    // maxAll: 15,300 + 8,000 + 3,000 = 26,300 -> CI 82,300 -> 3,350 + 11.5% x 2,300 = 3,614.50; saved 3,024.50.
    expect(scenario(r, 'maxAll')).toMatchObject({
      contributions: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 3_000 },
      totalContribution: 26_300,
      taxPayable: 3_614.5,
      taxSaved: 3_024.5,
      wastedContribution: 0,
    });
    expect(scenario(r, 'maxAll').savingRate).toBe(0.115);
    // srsOnly: 15,300 x 11.5% = 1,759.50. cpfSelfOnly: 8,000 x 11.5% = 920.00.
    expect(scenario(r, 'srsOnly')).toMatchObject({ taxSaved: 1_759.5, taxPayable: 4_879.5 });
    expect(scenario(r, 'cpfSelfOnly')).toMatchObject({ taxSaved: 920, taxPayable: 5_719 });
    expect(r.scenarios.map((s) => s.id)).toEqual(['none', 'srsOnly', 'cpfSelfOnly', 'srsPlusCpfSelf', 'maxAll', 'recommended']);
  });

  it('monthly plan over October–December: family 1,000 each; SRS 2,334 + 2,333 + 2,333', () => {
    expect(r.monthlyPlan.schedule).toEqual([
      { month: '2026-10', amounts: { srs: 2_334, cpfSelf: 0, cpfFamily: 1_000 }, total: 3_334 },
      { month: '2026-11', amounts: { srs: 2_333, cpfSelf: 0, cpfFamily: 1_000 }, total: 3_333 },
      { month: '2026-12', amounts: { srs: 2_333, cpfSelf: 0, cpfFamily: 1_000 }, total: 3_333 },
    ]);
    // ceil(7,000 / 12) = 584; 3,000 / 12 = 250.
    expect(r.monthlyPlan.fullYearMonthly).toEqual({ srs: 584, cpfSelf: 0, cpfFamily: 250, total: 834 });
  });

  it('the simulator fills family first, then SRS, then CPF self', () => {
    expect(r.simulator[2]?.split).toEqual({ srs: 0, cpfSelf: 0, cpfFamily: 2_000 });
    expect(r.simulator[4]?.split).toEqual({ srs: 1_000, cpfSelf: 0, cpfFamily: 3_000 });
    expect(r.simulator[19]?.split).toEqual({ srs: 15_300, cpfSelf: 700, cpfFamily: 3_000 });
    expect(r.simulator.filter((row) => row.withinPlan)).toHaveLength(11); // 0 .. 10,000
    expect(r.simulator).toHaveLength(28); // 0 .. 26,000 then 26,300
  });
});

describe('H21 — Earned Income Relief limited by expenses; phase-in wage with large other income', () => {
  // S$600 a month: employment income 7,200; expenses 6,700 -> net 500. EIR = min(1,000, 500) = 500.
  // CPF: floor(0.6 x 100) = 60 x 12 = 720. Other income 100,000 -> total income 100,500.
  // Reliefs 1,220. CI 99,280. Tax 3,350 + 11.5% x 19,280 = 3,350 + 2,217.20 = 5,567.20.
  it('EIR 500, CPF 720, tax 5,567.20', () => {
    const r = plan(person({ age: 30, ow: 600, expenses: 6_700, otherIncome: 100_000 }));
    expect(r.baseline.employmentIncome).toBe(7_200);
    expect(r.baseline.totalIncome).toBe(100_500);
    expect(r.baseline.reliefs).toMatchObject({ earnedIncome: 500, cpf: 720, totalBeforeCap: 1_220 });
    expect(r.baseline.chargeableIncome).toBe(99_280);
    expect(r.baseline.taxPayable).toBe(5_567.2);
    expect(r.baseline.effectiveRate).toBeCloseTo(5_567.2 / 100_500, 12);
  });

  it('Earned Income Relief by age: 54 -> 1,000; 55 and 59 -> 6,000; 60 -> 8,000', () => {
    const eir = (age: number): number => plan(person({ age, ow: 4_000 })).baseline.reliefs.earnedIncome;
    expect([54, 55, 59, 60, 61].map(eir)).toEqual([1_000, 6_000, 6_000, 8_000, 8_000]);
  });
});

describe('H22 — top of the rate table', () => {
  it('S$100,000 a month + S$300,000 bonus: CI 1,478,600, tax 314,014.00, each lever dollar saves 24 cents', () => {
    // Income 1,500,000. CPF 20,400. EIR 1,000. CI 1,478,600.
    // Tax 199,150 + 24% x 478,600 = 199,150 + 114,864 = 314,014.00.
    const r = plan(person({ age: 45, ow: 100_000, aw: 300_000, minRate: 0.24 }));
    expect(r.baseline.chargeableIncome).toBe(1_478_600);
    expect(r.baseline.taxPayable).toBe(314_014);
    expect(r.baseline.marginalRate).toBe(0.24);
    expect(r.plan.totalContribution).toBe(23_300);
    expect(r.plan.taxSaved).toBe(5_592); // 23,300 x 24%
    // Unrealised: min(U 478,600, C 58,600) = 58,600 -> (58,600 - 23,300) x 24% = 8,472.00.
    expect(r.plan.unrealisedSaving).toBe(8_472);
  });

  it('a minimum rate above 24% recommends nothing', () => {
    const r = plan(person({ age: 45, ow: 100_000, aw: 300_000, minRate: 0.2401 }));
    expect(r.plan.totalContribution).toBe(0);
    expect(r.plan.bindingConstraint).toBe('usefulRoom');
    expect(codes(r)).toEqual(['BELOW_MIN_SAVING_RATE']);
  });
});

describe('H23 — age 55 with a December birthday: EIR 6,000 but still the "55 and below" CPF rates', () => {
  it('2026: CPF 20,400 at 20%; CI 75,600; tax 3,042.00', () => {
    // S$8,000 a month + S$6,000 bonus: income 102,000; CPF 19,200 + 1,200 = 20,400; EIR 6,000.
    // CI 75,600. Tax 550 + 7% x 35,600 = 3,042.00.
    const r = plan(person({ age: 55, birthMonth: 12, ow: 8_000, aw: 6_000, minRate: 0.07 }));
    expect(r.cpf.monthlyEmployeeRates).toEqual(new Array(12).fill(0.2));
    expect(r.cpf.employeeContribution).toBe(20_400);
    expect(r.baseline.reliefs.earnedIncome).toBe(6_000);
    expect(r.baseline.chargeableIncome).toBe(75_600);
    expect(r.baseline.taxPayable).toBe(3_042);
    // 55 at year end counts as "from 55" for the room rule too (SPEC §6.5), whatever the birth month: the room
    // is blank, so own CPF is left out and the caution is shown instead of the note.
    expect(r.levers.cpfSelf.room).toBe(0);
    expect(codes(r)).toContain('CPF_SELF_ROOM_UNCONFIRMED');
    expect(codes(r)).not.toContain('AGE_55_PLUS_TOPUP');
    // One year younger nothing is asked: room 8,000, neither warning.
    const younger = plan(person({ age: 54, birthMonth: 12, ow: 8_000, aw: 6_000, minRate: 0.07 }));
    expect(younger.levers.cpfSelf.room).toBe(8_000);
    expect(codes(younger)).not.toContain('CPF_SELF_ROOM_UNCONFIRMED');
    expect(codes(younger)).not.toContain('AGE_55_PLUS_TOPUP');
  });

  it('age 56 is in the higher band from January whatever the birth month', () => {
    // 18% x 8,000 = 1,440 x 12 = 17,280 + 18% x 6,000 = 1,080 -> 18,360.
    for (const birthMonth of [1, 6, 12]) {
      expect(computeCpf(person({ age: 56, birthMonth, ow: 8_000, aw: 6_000 }), getRules(2026)).employeeContribution).toBe(18_360);
    }
  });

  it('ages 71 and 120 use the last band; age 0 the first', () => {
    // 5% x 8,000 = 400 x 12 = 4,800; 20% -> 19,200.
    expect(computeCpf(person({ age: 71, birthMonth: 1, ow: 8_000 }), getRules(2026)).employeeContribution).toBe(4_800);
    expect(computeCpf(person({ age: 120, ow: 8_000 }), getRules(2026)).employeeContribution).toBe(4_800);
    expect(computeCpf(person({ age: 0, ow: 8_000 }), getRules(2026)).employeeContribution).toBe(19_200);
  });
});

describe('H24 — levers switched off are ignored by the plan but not by the SRS / CPF-self scenarios', () => {
  // Opening example income (CI 108,600, tax 6,639.00), SRS and CPF self OFF, family ON with 2,000 already given.
  const r = plan(
    person({ ow: 10_000, aw: 15_000, otherReliefs: 5_000, minRate: 0.07, srsOn: false, selfOn: false, familyOn: true, existingFamily: 2_000 }),
  );

  it('plan: only the family room of 6,000', () => {
    // Reliefs 26,400 + 2,000 = 28,400 -> CI 106,600 -> 3,350 + 11.5% x 26,600 = 6,409.00.
    // X = L = 6,000 -> 6,409 - 690 = 5,719.00.
    expect(r.baseline.taxPayable).toBe(6_409);
    expect(r.levers.srs).toEqual({ statutoryCap: 15_300, used: 0, room: 0, eligible: true, enabled: false });
    expect(r.levers.cpfSelf).toEqual({ statutoryCap: 8_000, used: 0, room: 0, eligible: true, enabled: false });
    expect(r.plan.contributions).toEqual({ srs: 0, cpfSelf: 0, cpfFamily: 6_000 });
    expect(r.plan.taxAfter).toBe(5_719);
    expect(r.plan.bindingConstraint).toBe('leverLimits');
  });

  it('scenarios: srsOnly / cpfSelfOnly / srsPlusCpfSelf still show what those schemes would do', () => {
    expect(scenario(r, 'srsOnly')).toMatchObject({ contributions: { srs: 15_300, cpfSelf: 0, cpfFamily: 0 }, taxSaved: 1_759.5 });
    expect(scenario(r, 'cpfSelfOnly')).toMatchObject({ contributions: { srs: 0, cpfSelf: 8_000, cpfFamily: 0 }, taxSaved: 920 });
    expect(scenario(r, 'srsPlusCpfSelf')).toMatchObject({ totalContribution: 23_300, taxSaved: 2_679.5 });
    // maxAll: 23,300 + 6,000 = 29,300 -> CI 77,300 -> 550 + 7% x 37,300 = 3,161.00; saved 3,248.00
    //   (= 26,600 x 11.5% + 2,700 x 7% = 3,059 + 189).
    expect(scenario(r, 'maxAll')).toMatchObject({ totalContribution: 29_300, taxPayable: 3_161, taxSaved: 3_248, wastedContribution: 0 });
  });

  it('ladder and simulator cover only the enabled room', () => {
    expect(tiers(r)).toEqual([
      { from: 0, to: 6_000, amount: 6_000, rate: 0.115, saved: 690, cumulative: 690, used: 6_000, zero: undefined },
    ]);
    expect(r.simulator).toHaveLength(7);
  });
});

describe('H25 — a three-tier ladder that ends over the relief cap', () => {
  // S$8,000 a month, no bonus: income 96,000; CPF 19,200; EIR 1,000. Other income 14,000 -> total 110,000.
  // Other reliefs 45,000 -> reliefs 65,200 -> C = 14,800. CI 44,800. Tax 550 + 7% x 4,800 = 886.00.
  // All three levers: L = 31,300. Min rate 0: U = 24,800. X = min(24,800, 14,800, 31,300) = 14,800 (reliefCap).
  // CI after 30,000 -> 200.00. Saved 686.00 = 4,800 x 7% + 10,000 x 3.5%.
  const r = plan(person({ ow: 8_000, otherIncome: 14_000, otherReliefs: 45_000, familyOn: true, minRate: 0 }));

  it('plan', () => {
    expect(r.baseline.chargeableIncome).toBe(44_800);
    expect(r.baseline.taxPayable).toBe(886);
    expect(r.reliefCapRoom).toBe(14_800);
    expect(r.plan.contributions).toEqual({ srs: 14_800, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.taxAfter).toBe(200);
    expect(r.plan.taxSaved).toBe(686);
    expect(r.plan.bindingConstraint).toBe('reliefCap');
    expect(r.plan.unrealisedSaving).toBe(0);
    expect(codes(r)).toEqual(['RELIEF_CAP_LIMITS_PLAN']);
    expect(r.warnings[0]?.params).toEqual({ personalReliefCap: 80_000, reliefCapRoom: 14_800, totalContribution: 14_800 });
  });

  it('ladder: 4,800 at 7%, 10,000 at 3.5%, then 16,500 over the cap', () => {
    expect(tiers(r)).toEqual([
      { from: 0, to: 4_800, amount: 4_800, rate: 0.07, saved: 336, cumulative: 336, used: 4_800, zero: undefined },
      { from: 4_800, to: 14_800, amount: 10_000, rate: 0.035, saved: 350, cumulative: 686, used: 10_000, zero: undefined },
      { from: 14_800, to: 31_300, amount: 16_500, rate: 0, saved: 0, cumulative: 686, used: 0, zero: 'reliefCap' },
    ]);
    expect(scenario(r, 'maxAll')).toMatchObject({ totalContribution: 31_300, taxPayable: 200, taxSaved: 686, wastedContribution: 16_500 });
    // srsOnly 15,300: 500 over the cap.
    expect(scenario(r, 'srsOnly')).toMatchObject({ taxSaved: 686, wastedContribution: 500 });
  });

  it('with a 3.5% minimum the cap still binds first; with a 7% minimum U = 4,800 binds', () => {
    // floorCI(3.5%) = 30,000 -> U = 14,800 = C -> tie resolves to usefulRoom.
    const tie = plan(person({ ow: 8_000, otherIncome: 14_000, otherReliefs: 45_000, familyOn: true, minRate: 0.035 }));
    expect(tie.plan.totalContribution).toBe(14_800);
    expect(tie.plan.bindingConstraint).toBe('usefulRoom');
    expect(codes(tie)).toEqual([]);
    const seven = plan(person({ ow: 8_000, otherIncome: 14_000, otherReliefs: 45_000, familyOn: true, minRate: 0.07 }));
    expect(seven.plan.totalContribution).toBe(4_800);
    expect(seven.plan.taxSaved).toBe(336);
    expect(seven.plan.bindingConstraint).toBe('usefulRoom');
  });
});

describe('H26 — PIT rebate data path (SPEC §6.4) with the YA2025-style rule: 60% capped at S$200', () => {
  // Not a supported year, so run the public orchestration with a rules object that carries a rebate.
  it('gross 207.00 -> rebate 124.20 -> payable 82.80; the realised saving of the plan is 82.80, not 207.00', async () => {
    const { planFor } = await import('../../src/engine/plan');
    const { sanitise } = await import('../../src/engine/sanitise');
    const rules = { ...getRules(2026), pitRebate: { rate: 0.6, cap: 200 } };
    // H14's person: CI 30,200 -> gross 207.00. Rebate min(200, 60% x 207 = 124.20) = 124.20. Payable 82.80.
    const r = planFor(sanitise(person({ age: 25, ow: 3_000, aw: 3_000, minRate: 0 })), rules);
    expect(r.baseline.grossTax).toBe(207);
    expect(r.baseline.pitRebate).toBe(124.2);
    expect(r.baseline.taxPayable).toBe(82.8);
    expect(r.plan.totalContribution).toBe(10_200);
    expect(r.plan.taxSaved).toBe(82.8);
    expect(codes(r)).toEqual(['PIT_REBATE_APPLIED']);
    // Ladder realised savings: [0, 200) at 3.5%: gross 207 -> 200: payable 82.80 -> 80.00 = 2.80;
    // [200, 10,200) at 2%: 80.00 -> 0 = 80.00.
    expect(r.ladder.map((t) => [t.rate, t.taxSaved, t.cumulativeTaxSaved])).toEqual([
      [0.035, 2.8, 2.8],
      [0.02, 80, 82.8],
      [0, 0, 82.8],
    ]);
  });

  it('a large bill hits the S$200 cap', async () => {
    const { planFor } = await import('../../src/engine/plan');
    const { sanitise } = await import('../../src/engine/sanitise');
    const rules = { ...getRules(2026), pitRebate: { rate: 0.6, cap: 200 } };
    // Opening example: gross 6,639.00 -> rebate 200 -> 6,439.00. Plan saves the full 2,679.50 (rebate stays 200).
    const r = planFor(sanitise(person({ ow: 10_000, aw: 15_000, otherReliefs: 5_000, minRate: 0.07 })), rules);
    expect(r.baseline.pitRebate).toBe(200);
    expect(r.baseline.taxPayable).toBe(6_439);
    expect(r.plan.taxSaved).toBe(2_679.5);
  });
});
