/**
 * Final independent verification (written after the arbiter's fixes, by someone who wrote neither the engine,
 * the reference nor the other tests).
 *
 * 1. Fourteen realistic taxpayers, end to end. Every expected figure was worked out with pen-and-paper arithmetic
 *    from the SPEC §5 tables (the working is in the comment above each case), not read back from the engine.
 *    (Twelve at first; the rule audit added the CPF room that must be confirmed from 55, the family top-up and
 *    SRS withdrawal cautions and the tax-residency check, and with them two more people.)
 *
 * 2. A differential run against the Python reference for inputs the permanent differential test cannot carry:
 *    NaN and ±Infinity (SPEC §6.0 gives each a meaning, but a JSON file cannot hold them — the reference's
 *    `json.load` does accept the bare tokens, so they are written that way here), together with foreigners
 *    who use the family top-up (SPEC §6.5) and money at the S$10,000,000,000 clamp (SPEC §6.0).
 *    Own generator, own PRNG, own seed: nothing is shared with tests/support/generators.ts.
 *
 * Tax table (SPEC §5.1), cumulative tax at the start of each band:
 *   20,000 -> 0 · 30,000 -> 200 · 40,000 -> 550 · 80,000 -> 3,350 · 120,000 -> 7,950 · 160,000 -> 13,950
 *   200,000 -> 21,150 · 320,000 -> 44,550; rates 0 / 2 / 3.5 / 7 / 11.5 / 15 / 18 / 19 / 19.5 / 20 / 22 %.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { plan } from '../../src/engine';
import type { LeverId, PlannerInput } from '../../src/engine';

// ---------------------------------------------------------------------------------------------------------------
// 1. Fourteen realistic taxpayers, by hand
// ---------------------------------------------------------------------------------------------------------------

type Overrides = Partial<Omit<PlannerInput, 'profile' | 'income'>> & Pick<PlannerInput, 'profile' | 'income'>;

/** Defaults: income year 2026, today 13 Nov 2026, nothing contributed, SRS + own CPF on, family off, 7% minimum. */
function taxpayer(overrides: Overrides): PlannerInput {
  return {
    incomeYear: 2026,
    today: '2026-11-13',
    existing: { srs: 0, cpfTopUpSelf: 0, cpfTopUpFamily: 0 },
    otherReliefs: 0,
    levers: { srs: { enabled: true }, cpfSelf: { enabled: true }, cpfFamily: { enabled: false } },
    preferences: { minSavingRate: 0.07, priority: ['srs', 'cpfSelf', 'cpfFamily'] },
    ...overrides,
  };
}

interface Expected {
  cpf: number;
  earnedIncomeRelief: number;
  reliefs: number;
  chargeableIncome: number;
  tax: number;
  reliefCapRoom: number;
  /** srs, cpfSelf, cpfFamily */
  split: [number, number, number];
  binding: string;
  taxAfter: number;
  saved: number;
  unrealised: number;
  warnings: string[];
  /** The "could save up to S$… more tax" figure in the plan-limit message; null when there must be none. */
  quoted?: string | null;
  /** from, to, rate, taxSaved */
  ladder?: [number, number, number, number][];
  /** month, srs, cpfSelf, cpfFamily */
  schedule?: [string, number, number, number][];
  daysToDeadline?: number;
}

const TAXPAYERS: [string, PlannerInput, Expected][] = [
  [
    // 36,000 + 3,000 = 39,000. CPF 20% x 3,000 x 13 = 7,800. Reliefs 1,000 + 7,800 = 8,800. CI 30,200.
    // Tax 200 + 3.5% x 200 = 207.00. Marginal 3.5% < 7% -> U = 0 -> nothing recommended.
    'citizen, 25, S$3,000 a month + S$3,000 bonus: nothing is worth it at 7%',
    taxpayer({ profile: { residency: 'citizen', ageAtYearEnd: 25 }, income: { monthlyOrdinaryWage: 3_000, additionalWages: 3_000 } }),
    { cpf: 7_800, earnedIncomeRelief: 1_000, reliefs: 8_800, chargeableIncome: 30_200, tax: 207, reliefCapRoom: 71_200, split: [0, 0, 0], binding: 'usefulRoom', taxAfter: 207, saved: 0, unrealised: 0, warnings: ['BELOW_MIN_SAVING_RATE'] },
  ],
  [
    // 78,000 + 13,000 = 91,000. CPF 1,300 x 12 + 20% x 13,000 = 18,200. Reliefs 19,200. CI 71,800.
    // Tax 550 + 7% x 31,800 = 2,776.00. U = 31,800, C = 60,800, L = 23,300 -> X = 23,300 (schemes full).
    // CI after 48,500: 550 + 7% x 8,500 = 1,145.00; saved 1,631.00. Unrealised: 1,145 - tax(40,000) = 595.00.
    // Family top-up (off) has 8,000 of room: CI 48,500 -> 40,500, 8,000 x 7% = 560.00 more.
    'citizen, 32, S$6,500 a month + S$13,000 bonus',
    taxpayer({ profile: { residency: 'citizen', ageAtYearEnd: 32 }, income: { monthlyOrdinaryWage: 6_500, additionalWages: 13_000 } }),
    { cpf: 18_200, earnedIncomeRelief: 1_000, reliefs: 19_200, chargeableIncome: 71_800, tax: 2_776, reliefCapRoom: 60_800, split: [15_300, 8_000, 0], binding: 'leverLimits', taxAfter: 1_145, saved: 1_631, unrealised: 595, warnings: ['LEVER_LIMITS_PLAN'], quoted: 'S$560.00', ladder: [[0, 23_300, 0.07, 1_631]], schedule: [['2026-11', 7_650, 4_000, 0], ['2026-12', 7_650, 4_000, 0]], daysToDeadline: 48 },
  ],
  [
    // 2nd-year PR: employee rate 15%. OW capped at 8,000: 1,200 x 12 = 14,400; AW ceiling 6,000 x 15% = 900. CPF 15,300.
    // Income 102,000 + 17,000 = 119,000. Reliefs 16,300. CI 102,700. Tax 3,350 + 11.5% x 22,700 = 5,960.50.
    // X = 23,300: CI 79,400 -> 550 + 7% x 39,400 = 3,308.00; saved 2,610.50 + 42.00 = 2,652.50.
    // Unrealised: U = 62,700 < C = 63,700 -> 3,308 - tax(40,000) = 2,758.00.
    'PR in the 2nd year, 30, S$8,500 a month + S$17,000 bonus',
    taxpayer({ profile: { residency: 'pr', prYear: 2, ageAtYearEnd: 30 }, income: { monthlyOrdinaryWage: 8_500, additionalWages: 17_000 } }),
    { cpf: 15_300, earnedIncomeRelief: 1_000, reliefs: 16_300, chargeableIncome: 102_700, tax: 5_960.5, reliefCapRoom: 63_700, split: [15_300, 8_000, 0], binding: 'leverLimits', taxAfter: 3_308, saved: 2_652.5, unrealised: 2_758, warnings: ['LEVER_LIMITS_PLAN', 'PR_GRADUATED_RATES'], quoted: 'S$560.00', ladder: [[0, 22_700, 0.115, 2_610.5], [22_700, 23_300, 0.07, 42]] },
  ],
  [
    // Foreigner: no CPF, no CPF top-up relief (SPEC §6.5), so the S$5,000 already given to family earns nothing.
    // Income 180,000 + 45,000 = 225,000. Reliefs 1,000. CI 224,000. Tax 21,150 + 19% x 24,000 = 25,710.00.
    // Only SRS (35,700): CI 188,300 -> 13,950 + 18% x 28,300 = 19,044.00; saved 4,560 + 2,106 = 6,666.00.
    // Unrealised: C = 79,000 -> 19,044 - tax(145,000) = 19,044 - 11,700 = 7,344.00. Nothing else can be switched on.
    // SRS is on and open to a foreigner: SRS_NON_RESIDENT_WITHDRAWAL (the plan is on the 19% and 18% rungs, so no
    // part of it is called out). Worked all 12 months: no residency check. No family caution: not eligible.
    'foreigner, 40, S$15,000 a month + S$45,000 bonus, family top-up switched on and S$5,000 already given',
    taxpayer({ profile: { residency: 'foreigner', ageAtYearEnd: 40 }, income: { monthlyOrdinaryWage: 15_000, additionalWages: 45_000 }, existing: { srs: 0, cpfTopUpSelf: 0, cpfTopUpFamily: 5_000 }, levers: { srs: { enabled: true }, cpfSelf: { enabled: true }, cpfFamily: { enabled: true } } }),
    { cpf: 0, earnedIncomeRelief: 1_000, reliefs: 1_000, chargeableIncome: 224_000, tax: 25_710, reliefCapRoom: 79_000, split: [35_700, 0, 0], binding: 'leverLimits', taxAfter: 19_044, saved: 6_666, unrealised: 7_344, warnings: ['FOREIGNER_NO_CPF', 'LEVER_LIMITS_PLAN', 'SRS_NON_RESIDENT_WITHDRAWAL'], quoted: null, ladder: [[0, 24_000, 0.19, 4_560], [24_000, 35_700, 0.18, 2_106]] },
  ],
  [
    // Income 144,000 + 36,000 = 180,000. CPF 20,400. Reliefs 1,000 + 20,400 + 6,000 (SRS) + 13,500 = 40,900.
    // CI 139,100. Tax 7,950 + 15% x 19,100 = 10,815.00. Minimum 11.5% -> U = 59,100; C = 39,100;
    // L = 9,300 + 8,000 + 3,000 = 20,300; B = 15,000 -> X = 15,000 = SRS 9,300 + own CPF 5,700.
    // CI 124,100 -> 7,950 + 15% x 4,100 = 8,565.00; saved 2,250.00. Unrealised: 8,565 - tax(100,000) = 2,915.00.
    // With the cash limit lifted the schemes stop at 20,300: 4,100 x 15% + 1,200 x 11.5% = 753.00 more.
    'citizen, 45, S$12,000 a month + S$36,000 bonus, reliefs S$13,500, S$6,000 in SRS, S$15,000 cash, top bracket only',
    taxpayer({ profile: { residency: 'citizen', ageAtYearEnd: 45 }, income: { monthlyOrdinaryWage: 12_000, additionalWages: 36_000 }, existing: { srs: 6_000, cpfTopUpSelf: 0, cpfTopUpFamily: 0 }, otherReliefs: 13_500, levers: { srs: { enabled: true }, cpfSelf: { enabled: true }, cpfFamily: { enabled: true, maxAmount: 3_000 } }, preferences: { cashBudget: 15_000, minSavingRate: 0.115, priority: ['srs', 'cpfSelf', 'cpfFamily'] } }),
    { cpf: 20_400, earnedIncomeRelief: 1_000, reliefs: 40_900, chargeableIncome: 139_100, tax: 10_815, reliefCapRoom: 39_100, split: [9_300, 5_700, 0], binding: 'cashBudget', taxAfter: 8_565, saved: 2_250, unrealised: 2_915, warnings: ['BUDGET_LIMITS_PLAN'], quoted: 'S$753.00', schedule: [['2026-11', 4_650, 2_850, 0], ['2026-12', 4_650, 2_850, 0]] },
  ],
  [
    // 55th birthday in March: 20% for January to March, 18% from April. 1,600 x 3 + 1,440 x 9 = 17,760;
    // bonus: 6,000 of AW ceiling x 18% (December rate) = 1,080. CPF 18,840. Earned Income Relief at 55: 6,000.
    // Income 108,000 + 20,000 = 128,000. Reliefs 24,840. CI 103,160. Tax 3,350 + 11.5% x 23,160 = 6,013.40.
    // X = 23,300: CI 79,860 -> 550 + 7% x 39,860 = 3,340.20; saved 2,673.20.
    // Unrealised: C = 55,160 < U -> 3,340.20 - tax(48,000) = 3,340.20 - 1,110 = 2,230.20.
    // At 55 the CPF top-up room must be entered (SPEC §6.5); this person has checked and has the full S$8,000.
    'citizen turning 55 in March, S$9,000 a month + S$20,000 bonus, CPF top-up room confirmed at S$8,000',
    taxpayer({ profile: { residency: 'citizen', ageAtYearEnd: 55, birthMonth: 3 }, income: { monthlyOrdinaryWage: 9_000, additionalWages: 20_000 }, levers: { srs: { enabled: true }, cpfSelf: { enabled: true, roomToLimit: 8_000 }, cpfFamily: { enabled: false } } }),
    { cpf: 18_840, earnedIncomeRelief: 6_000, reliefs: 24_840, chargeableIncome: 103_160, tax: 6_013.4, reliefCapRoom: 55_160, split: [15_300, 8_000, 0], binding: 'leverLimits', taxAfter: 3_340.2, saved: 2_673.2, unrealised: 2_230.2, warnings: ['AGE_55_PLUS_TOPUP', 'LEVER_LIMITS_PLAN'], quoted: 'S$560.00', ladder: [[0, 23_160, 0.115, 2_663.4], [23_160, 23_300, 0.07, 9.8]] },
  ],
  [
    // 2027 rates: 19% until the month of the 60th birthday (September), 13% from October.
    // 1,330 x 9 + 910 x 3 = 14,700; bonus 7,000 x 13% = 910. CPF 15,610. Earned Income Relief at 60: 8,000.
    // Income 91,000. Reliefs 23,610. CI 67,390. Tax 550 + 7% x 27,390 = 2,467.30.
    // Every tax dollar, all three schemes: X = 31,300. CI 36,090 -> 200 + 3.5% x 6,090 = 413.15; saved 2,054.15.
    // 15 June: 7 instalments. 15,300 = 5 x 2,186 + 2 x 2,185; 8,000 = 6 x 1,143 + 1,142. 199 days to 31 December.
    // CPF top-up room entered as 20,000 (above the 8,000 cap, so the cap rules): the note, not the caution.
    // 8,000 of the plan goes to family: FAMILY_TOPUP_CHECKS.
    'PR (3rd year on) turning 60 in September, S$7,000 a month + S$7,000 bonus, income year 2027, every tax dollar',
    taxpayer({ incomeYear: 2027, today: '2027-06-15', profile: { residency: 'pr', prYear: 3, ageAtYearEnd: 60, birthMonth: 9 }, income: { monthlyOrdinaryWage: 7_000, additionalWages: 7_000 }, levers: { srs: { enabled: true }, cpfSelf: { enabled: true, roomToLimit: 20_000 }, cpfFamily: { enabled: true } }, preferences: { minSavingRate: 0, priority: ['srs', 'cpfSelf', 'cpfFamily'] } }),
    { cpf: 15_610, earnedIncomeRelief: 8_000, reliefs: 23_610, chargeableIncome: 67_390, tax: 2_467.3, reliefCapRoom: 56_390, split: [15_300, 8_000, 8_000], binding: 'leverLimits', taxAfter: 413.15, saved: 2_054.15, unrealised: 413.15, warnings: ['AGE_55_PLUS_TOPUP', 'FAMILY_TOPUP_CHECKS', 'LEVER_LIMITS_PLAN', 'PROJECTED_RULES'], quoted: null, ladder: [[0, 27_390, 0.07, 1_917.3], [27_390, 31_300, 0.035, 136.85]], schedule: [['2027-06', 2_186, 1_143, 1_143], ['2027-07', 2_186, 1_143, 1_143], ['2027-08', 2_186, 1_143, 1_143], ['2027-09', 2_186, 1_143, 1_143], ['2027-10', 2_186, 1_143, 1_143], ['2027-11', 2_185, 1_143, 1_143], ['2027-12', 2_185, 1_142, 1_142]], daysToDeadline: 199 },
  ],
  [
    // 68 all year: 7.5%. floor(337.50) = 337 a month and on the bonus: 337 x 13 = 4,381. Earned Income Relief 8,000.
    // Income 58,500 + 30,000 rent = 88,500. Reliefs 12,381. CI 76,119. Tax 550 + 7% x 36,119 = 3,078.33.
    // The CPF top-up room is left blank: at 68 that leaves own CPF out (SPEC §6.5), so L = 15,300 (SRS only).
    // X = 15,300: CI 60,819 -> 550 + 7% x 20,819 = 2,007.33; saved 1,071.00. Unrealised (U = 56,119): 2,007.33.
    // The only scheme that can be switched on is the family top-up: 8,000 x 7% = 560.00 more.
    'citizen, 68, S$4,500 a month + S$4,500 bonus, S$30,000 rental income, every tax dollar, CPF room left blank',
    taxpayer({ profile: { residency: 'citizen', ageAtYearEnd: 68 }, income: { monthlyOrdinaryWage: 4_500, additionalWages: 4_500, otherTaxableIncome: 30_000 }, preferences: { minSavingRate: 0, priority: ['srs', 'cpfSelf', 'cpfFamily'] } }),
    { cpf: 4_381, earnedIncomeRelief: 8_000, reliefs: 12_381, chargeableIncome: 76_119, tax: 3_078.33, reliefCapRoom: 67_619, split: [15_300, 0, 0], binding: 'leverLimits', taxAfter: 2_007.33, saved: 1_071, unrealised: 2_007.33, warnings: ['CPF_SELF_ROOM_UNCONFIRMED', 'LEVER_LIMITS_PLAN'], quoted: 'S$560.00', ladder: [[0, 15_300, 0.07, 1_071]] },
  ],
  [
    // Income 360,000 + 120,000 = 480,000; donations 5,000 -> deduction 12,500; assessable 467,500.
    // Reliefs 1,000 + 20,400 + 20,000 = 41,400. CI 426,100. Tax 44,550 + 22% x 106,100 = 67,892.00.
    // All three schemes: X = 31,300 -> CI 394,800 -> 44,550 + 22% x 74,800 = 61,006.00; saved 6,886.00.
    // Unrealised: C = 38,600 -> 7,300 more dollars at 22% = 1,606.00, but no scheme has room for them.
    // 8,000 of the plan goes to family: FAMILY_TOPUP_CHECKS.
    'citizen, 38, S$30,000 a month + S$120,000 bonus, reliefs S$20,000, donations S$5,000, all schemes, CPF first',
    taxpayer({ profile: { residency: 'citizen', ageAtYearEnd: 38 }, income: { monthlyOrdinaryWage: 30_000, additionalWages: 120_000, donations: 5_000 }, otherReliefs: 20_000, levers: { srs: { enabled: true }, cpfSelf: { enabled: true }, cpfFamily: { enabled: true } }, preferences: { minSavingRate: 0.07, priority: ['cpfSelf', 'srs', 'cpfFamily'] } }),
    { cpf: 20_400, earnedIncomeRelief: 1_000, reliefs: 41_400, chargeableIncome: 426_100, tax: 67_892, reliefCapRoom: 38_600, split: [15_300, 8_000, 8_000], binding: 'leverLimits', taxAfter: 61_006, saved: 6_886, unrealised: 1_606, warnings: ['FAMILY_TOPUP_CHECKS', 'LEVER_LIMITS_PLAN'], quoted: null, ladder: [[0, 31_300, 0.22, 6_886]] },
  ],
  [
    // Arrived in May: 8 months x 5,500 + 5,500 = 49,500. No CPF. Reliefs 1,000. CI 48,500.
    // Tax 550 + 7% x 8,500 = 1,145.00. At 7% only the 8,500 above 40,000 qualify: SRS 8,500, tax 550.00, saved 595.00.
    // 20 December 2025: 11 days left, one instalment.
    // 8 months worked is more than half the year: no residency check. SRS on: SRS_NON_RESIDENT_WITHDRAWAL, and
    // the whole plan (8,500) is on the 7% rung, below the 7.5 cents a non-resident pays to take it out.
    'foreigner, 29, S$5,500 a month for 8 months + S$5,500 bonus, income year 2025, on 20 December',
    taxpayer({ incomeYear: 2025, today: '2025-12-20', profile: { residency: 'foreigner', ageAtYearEnd: 29 }, income: { monthlyOrdinaryWage: 5_500, monthsWorked: 8, additionalWages: 5_500 }, levers: { srs: { enabled: true }, cpfSelf: { enabled: false }, cpfFamily: { enabled: false } } }),
    { cpf: 0, earnedIncomeRelief: 1_000, reliefs: 1_000, chargeableIncome: 48_500, tax: 1_145, reliefCapRoom: 79_000, split: [8_500, 0, 0], binding: 'usefulRoom', taxAfter: 550, saved: 595, unrealised: 0, warnings: ['DEADLINE_SOON', 'FOREIGNER_NO_CPF', 'SRS_NON_RESIDENT_WITHDRAWAL'], schedule: [['2025-12', 8_500, 0, 0]], daysToDeadline: 11 },
  ],
  [
    // 1st-year PR: 5%. 400 x 12 + 300 = 5,100. Income 135,000. Reliefs 1,000 + 5,100 + 5,000 = 11,100. CI 123,900.
    // Tax 7,950 + 15% x 3,900 = 8,535.00. X = 23,300: CI 100,600 -> 3,350 + 11.5% x 20,600 = 5,719.00; saved 2,816.00.
    // Unrealised: C = 68,900 < U -> 5,719 - tax(55,000) = 4,119.00. Family top-up (off): 8,000 x 11.5% = 920.00.
    'PR in the 1st year, 35, S$10,000 a month + S$15,000 bonus, reliefs S$5,000',
    taxpayer({ profile: { residency: 'pr', prYear: 1, ageAtYearEnd: 35 }, income: { monthlyOrdinaryWage: 10_000, additionalWages: 15_000 }, otherReliefs: 5_000 }),
    { cpf: 5_100, earnedIncomeRelief: 1_000, reliefs: 11_100, chargeableIncome: 123_900, tax: 8_535, reliefCapRoom: 68_900, split: [15_300, 8_000, 0], binding: 'leverLimits', taxAfter: 5_719, saved: 2_816, unrealised: 4_119, warnings: ['LEVER_LIMITS_PLAN', 'PR_GRADUATED_RATES'], quoted: 'S$920.00', ladder: [[0, 3_900, 0.15, 585], [3_900, 23_300, 0.115, 2_231]] },
  ],
  [
    // 62 all year: 12.5% x 3,200 = 400 x 12 = 4,800. Earned Income Relief 8,000, parent relief 9,000. Reliefs 21,800.
    // Income 38,400. CI 16,600: below 20,000, no tax, nothing to save.
    // The CPF top-up room is blank at 62: the caution asks for it (SPEC §6.11), whatever the tax bill.
    'citizen, 62, S$3,200 a month, parent relief S$9,000: no tax to save',
    taxpayer({ profile: { residency: 'citizen', ageAtYearEnd: 62 }, income: { monthlyOrdinaryWage: 3_200, additionalWages: 0 }, otherReliefs: 9_000 }),
    { cpf: 4_800, earnedIncomeRelief: 8_000, reliefs: 21_800, chargeableIncome: 16_600, tax: 0, reliefCapRoom: 58_200, split: [0, 0, 0], binding: 'none', taxAfter: 0, saved: 0, unrealised: 0, warnings: ['CPF_SELF_ROOM_UNCONFIRMED', 'NO_TAX_PAYABLE'] },
  ],
  [
    // The citizen turning 55 in March again (CPF 18,840, CI 103,160, tax 6,013.40), CPF top-up room left blank.
    // SPEC §6.5: own CPF room 0, L = 15,300. X = 15,300: CI 87,860 -> 3,350 + 11.5% x 7,860 = 4,253.90;
    // saved 1,759.50. Unrealised: C = 55,160 < U = 63,160 -> 4,253.90 - tax(48,000) = 4,253.90 - 1,110 = 3,143.90.
    // Switching on what is off: only the family top-up counts (8,000; the unconfirmed own CPF does not):
    // CI 87,860 -> 79,860: 7,860 x 11.5% + 140 x 7% = 903.90 + 9.80 = 913.70.
    'citizen turning 55 in March, S$9,000 a month + S$20,000 bonus, CPF top-up room left blank',
    taxpayer({ profile: { residency: 'citizen', ageAtYearEnd: 55, birthMonth: 3 }, income: { monthlyOrdinaryWage: 9_000, additionalWages: 20_000 } }),
    { cpf: 18_840, earnedIncomeRelief: 6_000, reliefs: 24_840, chargeableIncome: 103_160, tax: 6_013.4, reliefCapRoom: 55_160, split: [15_300, 0, 0], binding: 'leverLimits', taxAfter: 4_253.9, saved: 1_759.5, unrealised: 3_143.9, warnings: ['CPF_SELF_ROOM_UNCONFIRMED', 'LEVER_LIMITS_PLAN'], quoted: 'S$913.70', ladder: [[0, 15_300, 0.115, 1_759.5]], schedule: [['2026-11', 7_650, 0, 0], ['2026-12', 7_650, 0, 0]], daysToDeadline: 48 },
  ],
  [
    // Arrived in July: 6 months x 12,000 + 12,000 = 84,000. No CPF. Reliefs 1,000. CI 83,000.
    // Tax 3,350 + 11.5% x 3,000 = 3,695.00. At the foreigners' 11.5% minimum only the top 3,000 qualify:
    // SRS 3,000, tax 3,350.00, saved 345.00. Half the year or less: TAX_RESIDENCY_CHECK. SRS on: the withdrawal
    // caution, with nothing called out (the plan stays on the 11.5% rung).
    'foreigner, 33, S$12,000 a month for 6 months + S$12,000 bonus, top bracket only',
    taxpayer({ profile: { residency: 'foreigner', ageAtYearEnd: 33 }, income: { monthlyOrdinaryWage: 12_000, monthsWorked: 6, additionalWages: 12_000 }, levers: { srs: { enabled: true }, cpfSelf: { enabled: false }, cpfFamily: { enabled: false } }, preferences: { minSavingRate: 0.115, priority: ['srs', 'cpfSelf', 'cpfFamily'] } }),
    { cpf: 0, earnedIncomeRelief: 1_000, reliefs: 1_000, chargeableIncome: 83_000, tax: 3_695, reliefCapRoom: 79_000, split: [3_000, 0, 0], binding: 'usefulRoom', taxAfter: 3_350, saved: 345, unrealised: 0, warnings: ['FOREIGNER_NO_CPF', 'SRS_NON_RESIDENT_WITHDRAWAL', 'TAX_RESIDENCY_CHECK'], ladder: [[0, 3_000, 0.115, 345], [3_000, 35_700, 0.07, 2_289]], schedule: [['2026-11', 1_500, 0, 0], ['2026-12', 1_500, 0, 0]], daysToDeadline: 48 },
  ],
];

describe('final verification: fourteen realistic taxpayers worked by hand', () => {
  it.each(TAXPAYERS)('%s', (_name, input, x) => {
    const r = plan(input);
    expect(r.cpf.employeeContribution).toBe(x.cpf);
    expect(r.baseline.reliefs.earnedIncome).toBe(x.earnedIncomeRelief);
    expect(r.baseline.reliefs.totalBeforeCap).toBe(x.reliefs);
    expect(r.baseline.reliefs.lostToCap).toBe(0);
    expect(r.baseline.chargeableIncome).toBe(x.chargeableIncome);
    expect(r.baseline.taxPayable).toBe(x.tax);
    expect(r.reliefCapRoom).toBe(x.reliefCapRoom);
    expect([r.plan.contributions.srs, r.plan.contributions.cpfSelf, r.plan.contributions.cpfFamily]).toEqual(x.split);
    expect(r.plan.totalContribution).toBe(x.split[0] + x.split[1] + x.split[2]);
    expect(r.plan.bindingConstraint).toBe(x.binding);
    expect(r.plan.taxBefore).toBe(x.tax);
    expect(r.plan.taxAfter).toBe(x.taxAfter);
    expect(r.optimised.taxPayable).toBe(x.taxAfter);
    expect(r.plan.taxSaved).toBe(x.saved);
    expect(r.plan.unrealisedSaving).toBe(x.unrealised);
    expect(r.warnings.map((warning) => warning.code).sort()).toEqual([...x.warnings].sort());
    // The recommendation never contains a dollar that saves nothing.
    expect(r.scenarios.find((scenario) => scenario.id === 'recommended')?.wastedContribution).toBe(0);
    if (x.quoted !== undefined) {
      const limit = r.warnings.find((warning) => warning.code === 'LEVER_LIMITS_PLAN' || warning.code === 'BUDGET_LIMITS_PLAN');
      const match = /could save up to (S\$[\d,]+\.\d\d) more tax/.exec(limit?.message ?? '');
      expect(match ? match[1] : null).toBe(x.quoted);
    }
    if (x.ladder) expect(r.ladder.map((tier) => [tier.fromContribution, tier.toContribution, tier.rate, tier.taxSaved])).toEqual(x.ladder);
    if (x.schedule) {
      expect(r.monthlyPlan.schedule.map((row) => [row.month, row.amounts.srs, row.amounts.cpfSelf, row.amounts.cpfFamily])).toEqual(x.schedule);
    }
    if (x.daysToDeadline !== undefined) expect(r.monthlyPlan.daysToDeadline).toBe(x.daysToDeadline);
  });

  it('a foreigner gets no relief, no room and no warning for family top-ups (SPEC §6.5)', () => {
    const r = plan(TAXPAYERS[3]![1]);
    expect(r.levers.cpfFamily).toEqual({ statutoryCap: 0, used: 0, room: 0, eligible: false, enabled: true });
    expect(r.levers.cpfSelf).toEqual({ statutoryCap: 0, used: 0, room: 0, eligible: false, enabled: true });
    expect(r.baseline.reliefs.cpfTopUpFamily).toBe(0);
    expect(r.scenarios.find((scenario) => scenario.id === 'maxAll')?.contributions).toEqual({ srs: 35_700, cpfSelf: 0, cpfFamily: 0 });
    // The family caution is for people who can get the relief; the S$5,000 already given raises nothing here.
    expect(r.warnings.map((warning) => warning.code)).not.toContain('FAMILY_TOPUP_CHECKS');
  });

  it('the foreigner whose whole plan is on the 7% rung is told how much of it saves less than it costs to take out', () => {
    // TAXPAYERS[9]: SRS 8,500, chargeable income 48,500 -> 40,000, all of it taxed at 7% (< 7.5 cents per dollar).
    const r = plan(TAXPAYERS[9]![1]);
    const caution = r.warnings.find((warning) => warning.code === 'SRS_NON_RESIDENT_WITHDRAWAL');
    expect(caution?.severity).toBe('caution');
    expect(caution?.params).toMatchObject({ lowValueAmount: 8_500 });
    expect(caution?.message).toMatch(/ S\$8,500 of this plan saves less than 7\.5 cents per dollar today\.$/);
    // The foreigner who stops at the 11.5% rung (the last taxpayer) is told about the withdrawal tax, with no amount.
    const top = plan(TAXPAYERS[13]![1]);
    const plain = top.warnings.find((warning) => warning.code === 'SRS_NON_RESIDENT_WITHDRAWAL');
    expect(plain?.params).toMatchObject({ lowValueAmount: 0 });
    expect(plain?.message).not.toContain('of this plan saves less');
    expect(plain?.message).toMatch(/at least 20 cents if earlier\.$/);
  });

  it('the two people of 55 and over who left the CPF room blank are told why their own CPF is left out', () => {
    for (const index of [7, 12]) {
      const r = plan(TAXPAYERS[index]![1]);
      expect(r.levers.cpfSelf).toEqual({ statutoryCap: 8_000, used: 0, room: 0, eligible: true, enabled: true });
      expect(r.scenarios.find((scenario) => scenario.id === 'cpfSelfOnly')?.totalContribution).toBe(0);
      const caution = r.warnings.find((warning) => warning.code === 'CPF_SELF_ROOM_UNCONFIRMED');
      expect(caution?.severity).toBe('caution');
      // 2026: Enhanced Retirement Sum 440,800, Full Retirement Sum 220,400 (SPEC §5.4).
      expect(caution?.message).toContain('Enhanced Retirement Sum (S$440,800)');
      expect(caution?.message).toContain('Full Retirement Sum (S$220,400)');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Differential run for NaN / ±Infinity, foreigners with family top-ups and money at the clamp
// ---------------------------------------------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK_DIR = join(ROOT, '.tmp', 'differential-nonfinite');
const REFERENCE = join(ROOT, 'reference', 'sgtax_reference.py');
const SEED = 0x5eed_2027;
const COUNT = 1_500;
const MAX_MONEY = 10_000_000_000;

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAVE_PYTHON = pythonAvailable();
if (!HAVE_PYTHON) console.warn('[finalVerifier] python3 is not available: the non-finite differential test is SKIPPED.');

/** sfc32: a small 32-bit PRNG (not the one tests/support uses). */
function sfc32(seed: number): () => number {
  let a = seed | 0;
  let b = (seed ^ 0x9e3779b9) | 0;
  let c = 0x243f6a88;
  let d = 0xb7e15162 | 0;
  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4_294_967_296;
  };
  for (let i = 0; i < 16; i++) next();
  return next;
}

type Bag = Record<string, unknown>;
const NON_FINITE: readonly number[] = [Number.NaN, Infinity, -Infinity];
const CLAMP_EDGE: readonly number[] = [MAX_MONEY - 1, MAX_MONEY, MAX_MONEY + 1, MAX_MONEY + 0.5, 2 ** 53, 1.7e308];
/** Every numeric field of the input: [section path, key]. */
const NUMERIC_FIELDS: readonly (readonly [readonly string[], string])[] = [
  [['income'], 'monthlyOrdinaryWage'],
  [['income'], 'monthsWorked'],
  [['income'], 'additionalWages'],
  [['income'], 'otherTaxableIncome'],
  [['income'], 'employmentExpenses'],
  [['income'], 'donations'],
  [['income'], 'employeeCpfOverride'],
  [['existing'], 'srs'],
  [['existing'], 'cpfTopUpSelf'],
  [['existing'], 'cpfTopUpFamily'],
  [[], 'otherReliefs'],
  [['profile'], 'ageAtYearEnd'],
  [['profile'], 'birthMonth'],
  [['profile'], 'prYear'],
  [['levers', 'cpfSelf'], 'roomToLimit'],
  [['levers', 'cpfFamily'], 'maxAmount'],
  [['preferences'], 'cashBudget'],
  [['preferences'], 'minSavingRate'],
  [['preferences'], 'simulatorStep'],
];
/** Money fields only (for the clamp edge). */
const MONEY_FIELDS = NUMERIC_FIELDS.filter(([, key]) => !['monthsWorked', 'ageAtYearEnd', 'birthMonth', 'prYear', 'minSavingRate', 'simulatorStep'].includes(key));
const PRIORITIES: readonly (readonly LeverId[])[] = [
  ['srs', 'cpfSelf', 'cpfFamily'],
  ['cpfSelf', 'srs', 'cpfFamily'],
  ['cpfFamily', 'srs', 'cpfSelf'],
  ['cpfFamily', 'cpfSelf', 'srs'],
];

function generate(count: number, seed: number): Bag[] {
  const rnd = sfc32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;
  const chance = (p: number): boolean => rnd() < p;
  const inputs: Bag[] = [];
  for (let i = 0; i < count; i++) {
    const incomeYear = pick([2025, 2026, 2027]);
    const residency = pick(['citizen', 'pr', 'foreigner', 'foreigner']);
    const foreigner = residency === 'foreigner';
    const wage = chance(0.15) ? int(400, 800) : int(3_000, 30_000);
    const month = int(1, 12);
    const input: Bag = {
      incomeYear,
      today: `${incomeYear + pick([0, 0, 0, -1, 1])}-${String(month).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
      profile: { residency, prYear: pick([1, 2, 3]), ageAtYearEnd: chance(0.4) ? pick([17, 18, 54, 55, 56, 59, 60, 61, 65, 66, 70, 71]) : int(25, 68), birthMonth: int(1, 12) },
      income: {
        monthlyOrdinaryWage: wage,
        monthsWorked: chance(0.7) ? 12 : int(1, 11),
        additionalWages: chance(0.25) ? 0 : int(0, 6) * wage,
        otherTaxableIncome: chance(0.7) ? 0 : int(1, 80_000),
        employmentExpenses: chance(0.9) ? 0 : int(1, 4_000),
        donations: chance(0.8) ? 0 : int(1, 6_001),
      },
      // Foreigners: three in four have already topped up a family member's CPF (earns nothing, SPEC §6.5).
      existing: { srs: chance(0.6) ? 0 : int(1, 40_000), cpfTopUpSelf: chance(0.7) ? 0 : int(1, 9_000), cpfTopUpFamily: chance(foreigner ? 0.25 : 0.7) ? 0 : int(1, 9_000) },
      otherReliefs: chance(0.3) ? 0 : int(1, 60_000),
      levers: { srs: { enabled: chance(0.75) }, cpfSelf: { enabled: chance(0.7) }, cpfFamily: { enabled: chance(foreigner ? 0.8 : 0.5) } },
      preferences: { minSavingRate: pick([0, 0, 0.02, 0.035, 0.07, 0.07, 0.115, 0.15]), priority: [...pick(PRIORITIES)], simulatorStep: pick([500, 1_000, 1_000, 5_000]) },
    };
    if (chance(0.3)) (input.preferences as Bag).cashBudget = int(0, 40_000);
    if (chance(0.3)) ((input.levers as Bag).cpfFamily as Bag).maxAmount = int(0, 9_000);
    // Every third input has money at the clamp; then one to three numeric fields become NaN or ±Infinity.
    const set = (field: readonly [readonly string[], string], value: number): void => {
      let node = input;
      for (const key of field[0]) node = node[key] as Bag;
      node[field[1]] = value;
    };
    if (i % 3 === 0) set(pick(MONEY_FIELDS), pick(CLAMP_EDGE));
    for (let m = int(1, 3); m > 0; m--) set(pick(NUMERIC_FIELDS), pick(NON_FINITE));
    inputs.push(input);
  }
  return inputs;
}

/** JSON with bare NaN / Infinity / -Infinity tokens, which Python's json.load reads as those numbers. */
function serialise(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item)) return Number.isNaN(item) ? '@@NaN@@' : item > 0 ? '@@+Inf@@' : '@@-Inf@@';
    return item;
  });
  return text.replace(/"@@NaN@@"/g, 'NaN').replace(/"@@\+Inf@@"/g, 'Infinity').replace(/"@@-Inf@@"/g, '-Infinity');
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The engine's result in the shape the reference prints (reference/README.md). */
function engineResult(input: unknown): Json {
  const { rules: _rules, input: _input, warnings, cpf, ...rest } = plan(input as PlannerInput);
  const { employerContribution: _employer, ...cpfRest } = cpf;
  const shaped = {
    ...rest,
    cpf: cpfRest,
    warnings: warnings.map(({ code, severity }) => ({ code, severity })).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
  };
  return JSON.parse(JSON.stringify(shaped)) as Json;
}

function referenceResult(result: Json): Json {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
  const cpf = result.cpf;
  if (typeof cpf !== 'object' || cpf === null || Array.isArray(cpf)) return result;
  const { employerContribution: _employer, ...cpfRest } = cpf;
  return { ...result, cpf: cpfRest };
}

/** Paths at which the two results differ: integers exactly, other numbers within 1e-9, everything else strictly. */
function differences(engine: Json | undefined, reference: Json | undefined, path: string, out: string[]): void {
  if (typeof engine === 'number' && typeof reference === 'number') {
    const equal = Number.isInteger(engine) && Number.isInteger(reference) ? engine === reference : Math.abs(engine - reference) <= 1e-9;
    if (!equal) out.push(`${path}: engine ${engine} | reference ${reference}`);
  } else if (Array.isArray(engine) && Array.isArray(reference)) {
    if (engine.length !== reference.length) out.push(`${path}.length: engine ${engine.length} | reference ${reference.length}`);
    for (let i = 0; i < Math.min(engine.length, reference.length); i++) differences(engine[i], reference[i], `${path}[${i}]`, out);
  } else if (typeof engine === 'object' && typeof reference === 'object' && engine !== null && reference !== null && !Array.isArray(engine) && !Array.isArray(reference)) {
    for (const key of new Set([...Object.keys(engine), ...Object.keys(reference)])) differences(engine[key], reference[key], `${path}.${key}`, out);
  } else if (engine !== reference) {
    out.push(`${path}: engine ${JSON.stringify(engine)} | reference ${JSON.stringify(reference)}`);
  }
}

describe.skipIf(!HAVE_PYTHON)('final verification: engine vs reference on NaN, ±Infinity, foreigners with family top-ups and the money clamp', () => {
  const inputs = generate(COUNT, SEED);
  let reference: Json[] = [];

  beforeAll(() => {
    mkdirSync(WORK_DIR, { recursive: true });
    const inputFile = join(WORK_DIR, 'inputs.json');
    const outputFile = join(WORK_DIR, 'reference-output.json');
    writeFileSync(inputFile, `[${inputs.map(serialise).join(',\n')}]`);
    const stdout = openSync(outputFile, 'w');
    try {
      execFileSync('python3', [REFERENCE, inputFile], { maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', stdout, 'inherit'] });
    } finally {
      closeSync(stdout);
    }
    reference = JSON.parse(readFileSync(outputFile, 'utf8')) as Json[];
  }, 120_000);

  it('the set holds what it claims', () => {
    const text = inputs.map(serialise);
    expect(inputs).toHaveLength(COUNT);
    expect(reference).toHaveLength(COUNT);
    expect(text.every((item) => /NaN|Infinity/.test(item))).toBe(true);
    expect(text.filter((item) => /NaN/.test(item)).length).toBeGreaterThan(COUNT / 4);
    expect(text.filter((item) => /-Infinity/.test(item)).length).toBeGreaterThan(COUNT / 4);
    const sanitised = inputs.map((input) => plan(input as unknown as PlannerInput).input);
    const foreigners = sanitised.filter((input) => input.profile.residency === 'foreigner');
    expect(foreigners.length).toBeGreaterThan(COUNT / 3);
    expect(foreigners.filter((input) => input.existing.cpfTopUpFamily > 0 && input.levers.cpfFamily.enabled).length).toBeGreaterThan(COUNT / 6);
    expect(sanitised.filter((input) => [input.income.monthlyOrdinaryWage, input.income.additionalWages, input.income.otherTaxableIncome, input.otherReliefs, input.existing.srs].includes(MAX_MONEY)).length).toBeGreaterThan(20);
    // And the plans are not all trivial.
    const results = inputs.map((input) => plan(input as unknown as PlannerInput));
    expect(results.filter((result) => result.plan.totalContribution > 0).length).toBeGreaterThan(COUNT / 5);
  });

  it(`engine and reference agree on every field for ${COUNT} such inputs`, () => {
    const failures: string[] = [];
    inputs.forEach((input, index) => {
      const out: string[] = [];
      differences(engineResult(input), referenceResult(reference[index] ?? null), '$', out);
      if (out.length > 0 && failures.length < 5) failures.push(`#${index} ${serialise(input)}\n    ${out.slice(0, 5).join('\n    ')}`);
      else if (out.length > 0) failures.push(`#${index}`);
    });
    if (failures.length > 0) expect.fail(`${failures.length} of ${COUNT} inputs differ (seed ${SEED}):\n${failures.slice(0, 5).join('\n')}`);
  });

  it('a foreigner never gets relief, room or a recommendation for a CPF top-up, in either implementation', () => {
    inputs.forEach((input, index) => {
      const r = plan(input as unknown as PlannerInput);
      if (r.input.profile.residency !== 'foreigner') return;
      const other = reference[index] as unknown as { levers: Record<string, { statutoryCap: number; room: number; eligible: boolean }>; plan: { contributions: Record<string, number> }; baseline: { reliefs: Record<string, number> } };
      for (const side of [r, other]) {
        for (const lever of ['cpfSelf', 'cpfFamily'] as const) {
          expect(side.levers[lever]?.eligible).toBe(false);
          expect(side.levers[lever]?.statutoryCap).toBe(0);
          expect(side.levers[lever]?.room).toBe(0);
          expect(side.plan.contributions[lever]).toBe(0);
        }
        expect(side.baseline.reliefs.cpfTopUpSelf).toBe(0);
        expect(side.baseline.reliefs.cpfTopUpFamily).toBe(0);
      }
      expect(r.warnings.map((warning) => warning.code)).toContain('FOREIGNER_NO_CPF');
    });
  });
});
