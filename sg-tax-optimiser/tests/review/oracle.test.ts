/**
 * Adversarial review — an independent "brute-force oracle" for the whole PlannerResult.
 *
 * This is a deliberately naive re-derivation of SPEC §6 that shares no code and no rule data with the engine:
 * - the rule values are transcribed from SPEC §5 into this file;
 * - tax is computed from the SPEC's CUMULATIVE column (not by summing brackets);
 * - the plan total X is found by walking dollar by dollar until a dollar fails a constraint (the definition in
 *   "Why this is optimal"), not by the closed form min(U, C, L, B);
 * - the ladder is found by classifying every single dollar of [0, L) and grouping equal neighbours;
 * - days to the deadline come from Date.UTC (the engine uses its own integer calendar).
 *
 * A seeded generator biased towards the boundary values (500/501/750/751, the OW ceilings, ages 17/18/54–71,
 * caps hit exactly, ties between U/C/L/B) then compares every field of plan() with the oracle.
 */
import { describe, expect, it } from 'vitest';
import { computeCpf, getRules, grossTax, marginalRate, plan } from '../../src/engine';
import type { LeverId, PlannerInput, PlannerResult } from '../../src/engine';

// ---- SPEC §5, transcribed ------------------------------------------------------------------------------

/** [from, rate per mille, cumulative tax in dollars at `from`] — SPEC §5.1 including the cumulative column. */
const TAX: [number, number, number][] = [
  [0, 0, 0],
  [20_000, 20, 0],
  [30_000, 35, 200],
  [40_000, 70, 550],
  [80_000, 115, 3_350],
  [120_000, 150, 7_950],
  [160_000, 180, 13_950],
  [200_000, 190, 21_150],
  [240_000, 195, 28_750],
  [280_000, 200, 36_550],
  [320_000, 220, 44_550],
  [500_000, 230, 84_150],
  [1_000_000, 240, 199_150],
];

/** Employee / employer rates in units of 0.001% (20% = 20,000) per band: <=55, 55–60, 60–65, 65–70, >70. */
const FULL: Record<number, [number, number][]> = {
  2025: [[20_000, 17_000], [17_000, 15_500], [11_500, 12_000], [7_500, 9_000], [5_000, 7_500]],
  2026: [[20_000, 17_000], [18_000, 16_000], [12_500, 12_500], [7_500, 9_000], [5_000, 7_500]],
  2027: [[20_000, 17_000], [19_000, 16_500], [13_000, 13_000], [7_500, 9_000], [5_000, 7_500]],
};
const PR1_EMPLOYEE = [5_000, 5_000, 5_000, 5_000, 5_000];
const PR2_EMPLOYEE = [15_000, 12_500, 7_500, 5_000, 5_000];
const OW_CEILING: Record<number, number> = { 2025: 7_400, 2026: 8_000, 2027: 8_000 };
const AW_CEILING_ANNUAL = 102_000;
const RELIEF_CAP = 80_000;
const SRS_CAP = 15_300;
const SRS_CAP_FOREIGNER = 35_700;
const TOPUP_CAP = 8_000;

// ---- oracle -------------------------------------------------------------------------------------------

/** Tax in cents on a whole-dollar chargeable income, from the cumulative column. */
function taxCents(ci: number): number {
  let k = 0;
  for (let i = 0; i < TAX.length; i++) if (TAX[i]![0] <= ci) k = i;
  const [from, perMille, cumulative] = TAX[k]!;
  const mills = perMille * (ci - from); // thousandths of a dollar
  return cumulative * 100 + Math.floor((mills + 5) / 10);
}

/** Rate per mille that taxes dollar number `n` (the dollar that takes income from n-1 to n); 0 for n <= 0. */
function perMilleOfDollar(n: number): number {
  if (n <= 0) return 0;
  for (let i = TAX.length - 1; i >= 0; i--) if (TAX[i]![0] < n) return TAX[i]![1];
  return 0;
}

/** Lower edge of the band that taxes dollar number `n` (n >= 1). */
function bandStartOfDollar(n: number): number {
  for (let i = TAX.length - 1; i >= 0; i--) if (TAX[i]![0] < n) return TAX[i]![0];
  return 0;
}

function bandIndex(ageReachedBeforeThisMonth: number): number {
  if (ageReachedBeforeThisMonth < 55) return 0;
  if (ageReachedBeforeThisMonth < 60) return 1;
  if (ageReachedBeforeThisMonth < 65) return 2;
  if (ageReachedBeforeThisMonth < 70) return 3;
  return 4;
}

interface Clean {
  incomeYear: number;
  today: string;
  residency: 'citizen' | 'pr' | 'foreigner';
  prYear: 1 | 2 | 3;
  age: number;
  birthMonth: number;
  /** The "I have unused Parenthood Tax Rebate" tick-box. */
  ptr: boolean;
  ow: number;
  months: number;
  aw: number;
  otherIncome: number;
  expenses: number;
  donations: number;
  override: number | null;
  existing: { srs: number; self: number; family: number };
  otherReliefs: number;
  on: { srs: boolean; self: boolean; family: boolean };
  roomToLimit: number | null;
  maxAmount: number | null;
  budget: number | null;
  minRate: number;
  priority: LeverId[];
  step: number;
}

function toInput(c: Clean): PlannerInput {
  return {
    incomeYear: c.incomeYear,
    today: c.today,
    profile: { residency: c.residency, prYear: c.prYear, ageAtYearEnd: c.age, birthMonth: c.birthMonth, hasUnusedParenthoodTaxRebate: c.ptr },
    income: {
      monthlyOrdinaryWage: c.ow,
      monthsWorked: c.months,
      additionalWages: c.aw,
      otherTaxableIncome: c.otherIncome,
      employmentExpenses: c.expenses,
      donations: c.donations,
      employeeCpfOverride: c.override,
    },
    existing: { srs: c.existing.srs, cpfTopUpSelf: c.existing.self, cpfTopUpFamily: c.existing.family },
    otherReliefs: c.otherReliefs,
    levers: {
      srs: { enabled: c.on.srs },
      cpfSelf: { enabled: c.on.self, roomToLimit: c.roomToLimit },
      cpfFamily: { enabled: c.on.family, maxAmount: c.maxAmount },
    },
    preferences: { cashBudget: c.budget, minSavingRate: c.minRate, priority: c.priority, simulatorStep: c.step },
  };
}

interface OracleCpf {
  source: 'auto' | 'override' | 'none';
  ordinaryWagesSubject: number;
  additionalWageCeiling: number;
  additionalWagesSubject: number;
  employeeContribution: number;
  monthlyEmployeeRates: number[];
  /** null when the reference would not vouch for it (1st/2nd-year SPR employer rates are not in SPEC §5). */
  employerContribution: number | null;
}

function oracleCpf(c: Clean): OracleCpf {
  if (c.residency === 'foreigner') {
    return {
      source: 'none',
      ordinaryWagesSubject: 0,
      additionalWageCeiling: 0,
      additionalWagesSubject: 0,
      employeeContribution: 0,
      monthlyEmployeeRates: new Array<number>(12).fill(0),
      employerContribution: 0,
    };
  }
  const graduated = c.residency === 'pr' && c.prYear !== 3;
  const employeeRate = (band: number): number =>
    c.residency === 'pr' && c.prYear === 1
      ? PR1_EMPLOYEE[band]!
      : c.residency === 'pr' && c.prYear === 2
        ? PR2_EMPLOYEE[band]!
        : FULL[c.incomeYear]![band]![0];
  const employerRate = (band: number): number => FULL[c.incomeYear]![band]![1];

  let owSubjectTotal = 0;
  let employee = 0;
  let employerUnits = 0; // dollars x 0.001%
  const monthly: number[] = [];
  let decemberBand = 0;
  for (let m = 1; m <= 12; m++) {
    // Age reached by the end of the PREVIOUS month: the birthday (in month birthMonth) has passed iff m-1 >= birthMonth.
    const band = bandIndex(m - 1 >= c.birthMonth ? c.age : c.age - 1);
    if (m === 12) decemberBand = band;
    const worked = m > 12 - c.months;
    if (!worked) {
      monthly.push(0);
      continue;
    }
    monthly.push(employeeRate(band) / 100_000);
    const subject = Math.min(c.ow, OW_CEILING[c.incomeYear]!);
    owSubjectTotal += subject;
    employerUnits += employerRate(band) * subject;
    if (c.ow <= 500) employee += 0;
    else if (c.ow <= 750) employee += Math.floor((3 * employeeRate(band) * (c.ow - 500)) / 100_000);
    else employee += Math.floor((employeeRate(band) * subject) / 100_000);
  }
  const awCeiling = Math.max(0, AW_CEILING_ANNUAL - owSubjectTotal);
  const awSubject = Math.min(c.aw, awCeiling);
  employee += Math.floor((employeeRate(decemberBand) * awSubject) / 100_000);
  employerUnits += employerRate(decemberBand) * awSubject;

  const breakdown = {
    ordinaryWagesSubject: owSubjectTotal,
    additionalWageCeiling: awCeiling,
    additionalWagesSubject: awSubject,
    monthlyEmployeeRates: monthly,
  };
  if (c.override !== null) {
    return { source: 'override', ...breakdown, employeeContribution: Math.min(c.override, 20_400), employerContribution: 0 };
  }
  return {
    source: 'auto',
    ...breakdown,
    employeeContribution: employee,
    employerContribution: graduated ? null : Math.floor((employerUnits + 50_000) / 100_000),
  };
}

interface Caps {
  cap: Record<LeverId, number>;
  eligible: Record<LeverId, boolean>;
  used: Record<LeverId, number>;
  roomIfEnabled: Record<LeverId, number>;
  room: Record<LeverId, number>;
}

function oracleLevers(c: Clean): Caps {
  const citizenOrPr = c.residency !== 'foreigner';
  const eligible = { srs: c.age >= 18, cpfSelf: citizenOrPr, cpfFamily: citizenOrPr };
  const cap = {
    srs: eligible.srs ? (citizenOrPr ? SRS_CAP : SRS_CAP_FOREIGNER) : 0,
    cpfSelf: eligible.cpfSelf ? TOPUP_CAP : 0,
    cpfFamily: eligible.cpfFamily ? TOPUP_CAP : 0,
  };
  const existing = { srs: c.existing.srs, cpfSelf: c.existing.self, cpfFamily: c.existing.family };
  const used = { srs: 0, cpfSelf: 0, cpfFamily: 0 };
  const roomIfEnabled = { srs: 0, cpfSelf: 0, cpfFamily: 0 };
  const room = { srs: 0, cpfSelf: 0, cpfFamily: 0 };
  const on = { srs: c.on.srs, cpfSelf: c.on.self, cpfFamily: c.on.family };
  for (const lever of ['srs', 'cpfSelf', 'cpfFamily'] as const) {
    used[lever] = Math.min(existing[lever], cap[lever]);
    let left = cap[lever] - used[lever];
    if (lever === 'cpfSelf' && c.roomToLimit !== null) left = Math.min(left, c.roomToLimit);
    // SPEC §6.5 "Room must be confirmed from age 55": a blank room is then no room at all.
    if (lever === 'cpfSelf' && c.roomToLimit === null && c.age >= 55) left = 0;
    if (lever === 'cpfFamily' && c.maxAmount !== null) left = Math.min(left, c.maxAmount);
    roomIfEnabled[lever] = left;
    room[lever] = eligible[lever] && on[lever] ? left : 0;
  }
  return { cap, eligible, used, roomIfEnabled, room };
}

interface OracleTax {
  employmentIncome: number;
  employmentExpenses: number;
  otherTaxableIncome: number;
  totalIncome: number;
  donationDeduction: number;
  assessableIncome: number;
  earnedIncome: number;
  cpf: number;
  srs: number;
  cpfTopUpSelf: number;
  cpfTopUpFamily: number;
  other: number;
  grossTaxCents: number;
  pitRebate: number;
  totalBeforeCap: number;
  totalAllowed: number;
  lostToCap: number;
  chargeableIncome: number;
  taxCents: number;
  marginalPerMille: number;
}

function oracleTax(c: Clean, cpf: number, caps: Caps, add: Record<LeverId, number>): OracleTax {
  const employmentIncome = c.ow * c.months + c.aw;
  const net = Math.max(0, employmentIncome - c.expenses);
  const totalIncome = net + c.otherIncome;
  const donationCents = c.donations * 250;
  const assessableCents = Math.max(0, totalIncome * 100 - donationCents);
  const eirFull = c.age >= 60 ? 8_000 : c.age >= 55 ? 6_000 : 1_000;
  const earnedIncome = Math.min(eirFull, net);
  const srs = Math.min(c.existing.srs + add.srs, caps.cap.srs);
  const cpfTopUpSelf = Math.min(c.existing.self + add.cpfSelf, caps.cap.cpfSelf);
  const cpfTopUpFamily = Math.min(c.existing.family + add.cpfFamily, caps.cap.cpfFamily);
  const totalBeforeCap = earnedIncome + cpf + srs + cpfTopUpSelf + cpfTopUpFamily + c.otherReliefs;
  const totalAllowed = Math.min(totalBeforeCap, RELIEF_CAP);
  const chargeableIncome = Math.floor(Math.max(0, assessableCents - totalAllowed * 100) / 100);
  return {
    employmentIncome,
    employmentExpenses: c.expenses,
    otherTaxableIncome: c.otherIncome,
    totalIncome,
    donationDeduction: donationCents / 100,
    assessableIncome: assessableCents / 100,
    earnedIncome,
    cpf,
    srs,
    cpfTopUpSelf,
    cpfTopUpFamily,
    other: c.otherReliefs,
    grossTaxCents: taxCents(chargeableIncome),
    pitRebate: 0,
    totalBeforeCap,
    totalAllowed,
    lostToCap: totalBeforeCap - totalAllowed,
    chargeableIncome,
    taxCents: taxCents(chargeableIncome),
    marginalPerMille: perMilleOfDollar(chargeableIncome),
  };
}

function split(amount: number, room: Record<LeverId, number>, priority: LeverId[]): Record<LeverId, number> {
  const out = { srs: 0, cpfSelf: 0, cpfFamily: 0 };
  let left = amount;
  for (const lever of priority) {
    const take = left < room[lever] ? left : room[lever];
    out[lever] = take;
    left -= take;
  }
  return out;
}

const sum = (a: Record<LeverId, number>): number => a.srs + a.cpfSelf + a.cpfFamily;

function utcDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

const SEVERITY: Record<string, string> = {
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

/** Everything the oracle predicts, in the shape used for the comparison. */
function oracle(c: Clean) {
  const cpf = oracleCpf(c);
  const caps = oracleLevers(c);
  const none = { srs: 0, cpfSelf: 0, cpfFamily: 0 };
  const base = oracleTax(c, cpf.employeeContribution, caps, none);
  const CI0 = base.chargeableIncome;
  const C = Math.max(0, RELIEF_CAP - base.totalBeforeCap);
  const L = sum(caps.room);
  const B = c.budget === null ? Infinity : c.budget;

  // The value of contribution dollar number d (1-based): nothing beyond the relief cap, otherwise the rate that
  // taxes income dollar number CI0 - d + 1.
  const perMilleOfContributionDollar = (d: number): number => (d > C ? 0 : perMilleOfDollar(CI0 - d + 1));

  // X by walking: take dollars while the next one is available, affordable and worth at least the minimum.
  let X = 0;
  while (X < L && X < B) {
    const perMille = perMilleOfContributionDollar(X + 1);
    if (perMille === 0 || perMille / 1000 < c.minRate) break;
    X++;
  }
  // U by walking down band by band with unlimited schemes, budget and relief cap (for the binding constraint and
  // the unrealised saving): keep going while the band that taxes the next dollar is worth the minimum.
  let U = 0;
  while (U < CI0) {
    const dollar = CI0 - U;
    const perMille = perMilleOfDollar(dollar);
    if (perMille === 0 || perMille / 1000 < c.minRate) break;
    U = CI0 - bandStartOfDollar(dollar);
  }

  const contributions = split(X, caps.room, c.priority);
  const after = oracleTax(c, cpf.employeeContribution, caps, contributions);
  const taxAfterRelief = (relief: number): number => taxCents(Math.max(0, CI0 - Math.min(relief, C)));

  let binding: string;
  if (base.taxCents === 0) binding = 'none';
  else {
    const smallest = Math.min(U, C, L, B);
    binding = U === smallest ? 'usefulRoom' : C === smallest ? 'reliefCap' : L === smallest ? 'leverLimits' : 'cashBudget';
  }

  // Ladder: classify every dollar, group equal neighbours.
  const ladder: { from: number; to: number; rate: number; zero: string | undefined; savedCents: number; cumulativeCents: number; used: number }[] = [];
  let runStart = 0;
  let runKey = '';
  let runRate = 0;
  let runZero: string | undefined;
  for (let d = 1; d <= L + 1; d++) {
    let rate = 0;
    let zero: string | undefined;
    let key = 'end';
    if (d <= L) {
      if (d > C) {
        zero = 'reliefCap';
      } else {
        rate = perMilleOfDollar(CI0 - d + 1);
        if (rate === 0) zero = 'belowTaxThreshold';
      }
      key = `${rate}|${zero}`;
    }
    if (d === 1) {
      runKey = key;
      runRate = rate;
      runZero = zero;
    } else if (key !== runKey) {
      const to = d - 1;
      ladder.push({
        from: runStart,
        to,
        rate: runRate / 1000,
        zero: runZero,
        savedCents: taxAfterRelief(runStart) - taxAfterRelief(to),
        cumulativeCents: base.taxCents - taxAfterRelief(to),
        used: Math.max(0, Math.min(to, X) - runStart),
      });
      runStart = to;
      runKey = key;
      runRate = rate;
      runZero = zero;
    }
  }

  // Simulator.
  const simulator: { contribution: number; split: Record<LeverId, number>; taxCents: number; within: boolean }[] = [];
  for (let contribution = 0; ; contribution = Math.min(contribution + c.step, L)) {
    const s = split(contribution, caps.room, c.priority);
    simulator.push({ contribution, split: s, taxCents: oracleTax(c, cpf.employeeContribution, caps, s).taxCents, within: contribution <= X });
    if (contribution >= L) break;
  }

  // Scenarios.
  const usefulAtZero = Math.max(0, CI0 - 20_000);
  const scenarioOf = (id: string, s: Record<LeverId, number>) => {
    const total = sum(s);
    const tax = oracleTax(c, cpf.employeeContribution, caps, s).taxCents;
    return { id, contributions: s, total, taxCents: tax, wasted: total - Math.min(total, usefulAtZero, C) };
  };
  const srsRoom = caps.roomIfEnabled.srs;
  const selfRoom = caps.roomIfEnabled.cpfSelf;
  const scenarios = [
    scenarioOf('none', none),
    scenarioOf('srsOnly', { ...none, srs: srsRoom }),
    scenarioOf('cpfSelfOnly', { ...none, cpfSelf: selfRoom }),
    scenarioOf('srsPlusCpfSelf', { ...none, srs: srsRoom, cpfSelf: selfRoom }),
    scenarioOf('maxAll', { srs: srsRoom, cpfSelf: selfRoom, cpfFamily: caps.room.cpfFamily }),
    scenarioOf('recommended', contributions),
  ];

  // Monthly plan.
  const deadline = `${c.incomeYear}-12-31`;
  const days = utcDay(deadline) - utcDay(c.today);
  const todayYear = Number(c.today.slice(0, 4));
  const todayMonth = Number(c.today.slice(5, 7));
  const monthsRemaining = todayYear < c.incomeYear ? 12 : todayYear > c.incomeYear ? 0 : 13 - todayMonth;
  const schedule: { month: string; amounts: Record<LeverId, number>; total: number }[] = [];
  if (monthsRemaining > 0 && X > 0) {
    for (let i = 0; i < monthsRemaining; i++) {
      const amounts = { srs: 0, cpfSelf: 0, cpfFamily: 0 };
      for (const lever of ['srs', 'cpfSelf', 'cpfFamily'] as const) {
        amounts[lever] = Math.max(0, Math.ceil((contributions[lever] - i) / monthsRemaining));
      }
      const monthNumber = 12 - monthsRemaining + 1 + i;
      schedule.push({ month: `${c.incomeYear}-${String(monthNumber).padStart(2, '0')}`, amounts, total: sum(amounts) });
    }
  }
  const fullYear = {
    srs: Math.ceil(contributions.srs / 12),
    cpfSelf: Math.ceil(contributions.cpfSelf / 12),
    cpfFamily: Math.ceil(contributions.cpfFamily / 12),
  };

  // Warnings, in the order of the SPEC §6.11 table.
  const warnings: string[] = [];
  if (base.taxCents === 0) warnings.push('NO_TAX_PAYABLE');
  if (base.lostToCap > 0) warnings.push('RELIEF_CAP_EXCEEDED_BASELINE');
  if (binding === 'reliefCap') warnings.push('RELIEF_CAP_LIMITS_PLAN');
  if (base.taxCents > 0 && U === 0) warnings.push('BELOW_MIN_SAVING_RATE');
  if (binding === 'cashBudget') warnings.push('BUDGET_LIMITS_PLAN');
  if (binding === 'leverLimits') warnings.push('LEVER_LIMITS_PLAN');
  if (
    (caps.cap.srs > 0 && c.existing.srs > caps.cap.srs) ||
    (caps.cap.cpfSelf > 0 && c.existing.self > caps.cap.cpfSelf) ||
    (caps.cap.cpfFamily > 0 && c.existing.family > caps.cap.cpfFamily)
  ) {
    warnings.push('EXISTING_EXCEEDS_CAP');
  }
  if (c.residency !== 'foreigner' && c.override !== null && c.override > 20_400) warnings.push('CPF_OVERRIDE_ABOVE_MAX');
  if (c.residency === 'foreigner') warnings.push('FOREIGNER_NO_CPF');
  if (c.residency === 'foreigner' && c.months <= 6) warnings.push('TAX_RESIDENCY_CHECK');
  // §6.11 lowValueAmount, dollar by dollar: the plan's dollars that each save less than 7.5 cents (75 per mille).
  let lowValue: number | null = null;
  if (c.residency === 'foreigner' && c.on.srs && c.age >= 18) {
    warnings.push('SRS_NON_RESIDENT_WITHDRAWAL');
    lowValue = 0;
    for (let d = 1; d <= X; d++) if (perMilleOfContributionDollar(d) < 75) lowValue++;
  }
  if (c.residency === 'pr' && c.prYear < 3) warnings.push('PR_GRADUATED_RATES');
  const ownTopUpFrom55 = c.age >= 55 && c.on.self && c.residency !== 'foreigner';
  if (ownTopUpFrom55 && c.roomToLimit === null) warnings.push('CPF_SELF_ROOM_UNCONFIRMED');
  if (ownTopUpFrom55 && c.roomToLimit !== null) warnings.push('AGE_55_PLUS_TOPUP');
  if (c.residency !== 'foreigner' && (contributions.cpfFamily > 0 || c.existing.family > 0)) warnings.push('FAMILY_TOPUP_CHECKS');
  if (c.ptr) warnings.push('PARENTHOOD_TAX_REBATE');
  if (c.age < 18) warnings.push('SRS_UNDER_18');
  if (days < 0) warnings.push('DEADLINE_PASSED');
  if (days >= 0 && days <= 14 && X > 0) warnings.push('DEADLINE_SOON');
  if (c.incomeYear === 2027) warnings.push('PROJECTED_RULES');

  return {
    cpf, caps, base, after, U, C, L, X, contributions, binding,
    unrealisedCents: after.taxCents - taxAfterRelief(Math.min(U, C)),
    ladder, simulator, scenarios,
    monthly: { deadline, days, monthsRemaining, schedule, fullYear: { ...fullYear, total: sum(fullYear) } },
    warnings,
    lowValue,
  };
}

// ---- comparison ----------------------------------------------------------------------------------------

const cents = (dollars: number): number => Math.round(dollars * 100);

/** The engine result reduced to the same shape as the oracle's prediction. */
function view(r: PlannerResult, o: ReturnType<typeof oracle>) {
  const taxView = (t: PlannerResult['baseline']) => ({
    employmentIncome: t.employmentIncome,
    employmentExpenses: t.employmentExpenses,
    otherTaxableIncome: t.otherTaxableIncome,
    totalIncome: t.totalIncome,
    donationDeduction: t.donationDeduction,
    assessableIncome: t.assessableIncome,
    earnedIncome: t.reliefs.earnedIncome,
    cpf: t.reliefs.cpf,
    srs: t.reliefs.srs,
    cpfTopUpSelf: t.reliefs.cpfTopUpSelf,
    cpfTopUpFamily: t.reliefs.cpfTopUpFamily,
    other: t.reliefs.other,
    grossTaxCents: cents(t.grossTax),
    pitRebate: t.pitRebate,
    totalBeforeCap: t.reliefs.totalBeforeCap,
    totalAllowed: t.reliefs.totalAllowed,
    lostToCap: t.reliefs.lostToCap,
    chargeableIncome: t.chargeableIncome,
    taxCents: cents(t.taxPayable),
    marginalPerMille: Math.round(t.marginalRate * 1000),
  });
  return {
    cpf: { ...r.cpf, employerContribution: o.cpf.employerContribution === null ? null : r.cpf.employerContribution },
    caps: {
      cap: { srs: r.levers.srs.statutoryCap, cpfSelf: r.levers.cpfSelf.statutoryCap, cpfFamily: r.levers.cpfFamily.statutoryCap },
      eligible: { srs: r.levers.srs.eligible, cpfSelf: r.levers.cpfSelf.eligible, cpfFamily: r.levers.cpfFamily.eligible },
      used: { srs: r.levers.srs.used, cpfSelf: r.levers.cpfSelf.used, cpfFamily: r.levers.cpfFamily.used },
      room: { srs: r.levers.srs.room, cpfSelf: r.levers.cpfSelf.room, cpfFamily: r.levers.cpfFamily.room },
    },
    base: taxView(r.baseline),
    after: taxView(r.optimised),
    C: r.reliefCapRoom,
    X: r.plan.totalContribution,
    contributions: r.plan.contributions,
    binding: r.plan.bindingConstraint,
    unrealisedCents: cents(r.plan.unrealisedSaving),
    planTax: [cents(r.plan.taxBefore), cents(r.plan.taxAfter), cents(r.plan.taxSaved)],
    planCi: [r.plan.chargeableIncomeBefore, r.plan.chargeableIncomeAfter],
    planRates: [Math.round(r.plan.marginalRateBefore * 1000), Math.round(r.plan.marginalRateAfter * 1000)],
    ladder: r.ladder.map((t) => ({
      from: t.fromContribution,
      to: t.toContribution,
      rate: t.rate,
      zero: t.zeroReason,
      savedCents: cents(t.taxSaved),
      cumulativeCents: cents(t.cumulativeTaxSaved),
      used: t.usedByPlan,
    })),
    ladderAmounts: r.ladder.every((t) => t.amount === t.toContribution - t.fromContribution),
    simulator: r.simulator.map((row) => ({ contribution: row.contribution, split: row.split, taxCents: cents(row.taxPayable), within: row.withinPlan })),
    scenarios: r.scenarios.map((s) => ({ id: s.id, contributions: s.contributions, total: s.totalContribution, taxCents: cents(s.taxPayable), wasted: s.wastedContribution })),
    monthly: {
      deadline: r.monthlyPlan.deadline,
      days: r.monthlyPlan.daysToDeadline,
      monthsRemaining: r.monthlyPlan.monthsRemaining,
      schedule: r.monthlyPlan.schedule,
      fullYear: r.monthlyPlan.fullYearMonthly,
    },
    warnings: r.warnings.map((w) => w.code),
    lowValue: r.warnings.find((w) => w.code === 'SRS_NON_RESIDENT_WITHDRAWAL')?.params?.lowValueAmount ?? null,
  };
}

function expected(o: ReturnType<typeof oracle>) {
  return {
    cpf: o.cpf,
    caps: { cap: o.caps.cap, eligible: o.caps.eligible, used: o.caps.used, room: o.caps.room },
    base: o.base,
    after: o.after,
    C: o.C,
    X: o.X,
    contributions: o.contributions,
    binding: o.binding,
    unrealisedCents: o.unrealisedCents,
    planTax: [o.base.taxCents, o.after.taxCents, o.base.taxCents - o.after.taxCents],
    planCi: [o.base.chargeableIncome, o.after.chargeableIncome],
    planRates: [o.base.marginalPerMille, o.after.marginalPerMille],
    ladder: o.ladder,
    ladderAmounts: true,
    simulator: o.simulator,
    scenarios: o.scenarios,
    monthly: o.monthly,
    warnings: o.warnings,
    lowValue: o.lowValue,
  };
}

// ---- generator -----------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function generator(seed: number) {
  const random = mulberry32(seed);
  // The tick-box comes from a stream of its own, so every other field of every profile is what it was before the
  // tick-box existed.
  const tickBox = mulberry32(seed ^ 0x51ed_270b);
  const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
  const chance = (p: number): boolean => random() < p;
  const edgeOr = (edges: readonly number[], lo: number, hi: number, pEdge = 0.6): number => (chance(pEdge) ? pick(edges) : int(lo, hi));

  return (): Clean => {
    const incomeYear = pick([2025, 2026, 2027]);
    const todayYear = pick([incomeYear, incomeYear, incomeYear, incomeYear - 1, incomeYear + 1]);
    const month = chance(0.4) ? 12 : int(1, 12);
    const day = month === 12 && chance(0.6) ? pick([1, 16, 17, 18, 30, 31]) : int(1, 28);
    const perms: LeverId[][] = [
      ['srs', 'cpfSelf', 'cpfFamily'], ['srs', 'cpfFamily', 'cpfSelf'], ['cpfSelf', 'srs', 'cpfFamily'],
      ['cpfSelf', 'cpfFamily', 'srs'], ['cpfFamily', 'srs', 'cpfSelf'], ['cpfFamily', 'cpfSelf', 'srs'],
    ];
    return {
      incomeYear,
      today: `${todayYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      residency: pick(['citizen', 'citizen', 'citizen', 'pr', 'pr', 'foreigner']),
      prYear: pick([1, 2, 3, 3]),
      age: edgeOr([16, 17, 18, 19, 30, 54, 55, 56, 59, 60, 61, 64, 65, 66, 69, 70, 71, 85], 16, 80, 0.7),
      birthMonth: int(1, 12),
      ptr: tickBox() < 0.2,
      ow: chance(0.25)
        ? pick([0, 1, 499, 500, 501, 502, 503, 600, 749, 750, 751, 752, 1_000])
        : edgeOr([3_000, 5_555, 7_399, 7_400, 7_401, 7_999, 8_000, 8_001, 12_000, 20_000, 60_000], 2_000, 30_000, 0.4),
      months: chance(0.6) ? 12 : int(1, 12),
      aw: edgeOr([0, 0, 1, 5_999, 6_000, 6_001, 13_200, 13_201, 20_000, 100_000, 102_000, 500_000], 0, 80_000, 0.6),
      otherIncome: chance(0.6) ? 0 : int(0, 400_000),
      expenses: chance(0.8) ? 0 : int(0, 60_000),
      donations: chance(0.7) ? 0 : int(0, 6_000),
      override: chance(0.85) ? null : pick([0, 1, 5_000, 20_399, 20_400, 20_401, 30_000]),
      existing: {
        srs: edgeOr([0, 0, 0, 1, 5_000, 15_299, 15_300, 15_301, 35_699, 35_700, 35_701, 50_000], 0, 40_000, 0.8),
        self: edgeOr([0, 0, 0, 1, 3_000, 7_999, 8_000, 8_001, 20_000], 0, 10_000, 0.8),
        family: edgeOr([0, 0, 0, 1, 3_000, 7_999, 8_000, 8_001, 20_000], 0, 10_000, 0.8),
      },
      otherReliefs: chance(0.45) ? 0 : edgeOr([5_000, 20_000, 36_500, 40_000, 50_000, 55_000, 58_600, 60_000, 79_000, 80_000, 95_000], 0, 60_000, 0.5),
      on: { srs: chance(0.8), self: chance(0.8), family: chance(0.5) },
      roomToLimit: chance(0.7) ? null : pick([0, 1, 1_000, 7_999, 8_000, 8_001, 20_000]),
      maxAmount: chance(0.7) ? null : pick([0, 1, 1_000, 7_999, 8_000, 8_001, 20_000]),
      budget: chance(0.6) ? null : edgeOr([0, 1, 500, 2_500, 8_000, 10_000, 15_300, 23_300, 31_300, 50_000], 0, 40_000, 0.7),
      minRate: chance(0.55)
        ? pick([0, 0, 0, 0.02, 0.035, 0.07, 0.07])
        : pick([0.115, 0.15, 0.18, 0.19, 0.195, 0.2, 0.22, 0.23, 0.24, 0.25, 0.0199, 0.0201, 0.0349, 0.0351, 0.0699, 0.0701, 0.1149, 0.1151, 0.5, 1]),
      priority: pick(perms),
      step: pick([100, 250, 1_000, 1_000, 2_500, 5_000, 40_000]),
    };
  };
}

/**
 * A second generator that forces the interesting coincidences: it first builds a random person, then adjusts
 * other reliefs / the budget / the minimum rate so that two or more of U, C, L and B are equal or one apart.
 */
function tieGenerator(seed: number) {
  const next = generator(seed);
  const random = mulberry32(seed ^ 0x9e3779b9);
  const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
  return (): Clean => {
    const c = next();
    c.residency = c.residency === 'foreigner' && random() < 0.5 ? 'citizen' : c.residency;
    c.otherReliefs = 0;
    const o = oracle(c);
    if (o.L === 0 || o.base.taxCents === 0) return c;
    const nudge = int(-1, 1);
    const mode = int(0, 3);
    if (mode === 0) {
      // C close to L.
      const want = Math.max(0, RELIEF_CAP - o.base.totalBeforeCap - o.L + nudge);
      c.otherReliefs = want;
    } else if (mode === 1) {
      // B close to L (or to U).
      c.budget = Math.max(0, (random() < 0.5 ? o.L : o.U) + nudge);
    } else if (mode === 2) {
      // C close to U.
      const want = Math.max(0, RELIEF_CAP - o.base.totalBeforeCap - o.U + nudge);
      c.otherReliefs = Math.min(want, Math.max(0, RELIEF_CAP - o.base.totalBeforeCap));
    } else {
      // Everything on the same number where possible: budget = L and C = L.
      c.budget = o.L;
      c.otherReliefs = Math.max(0, RELIEF_CAP - o.base.totalBeforeCap - o.L);
    }
    return c;
  };
}

// ---- tests ---------------------------------------------------------------------------------------------

describe('oracle self-checks (so that a wrong oracle cannot hide behind a wrong engine)', () => {
  it('tax from the cumulative column reproduces Appendix B', () => {
    const vectors: [number, number][] = [
      [20_000, 0], [30_000, 200], [40_000, 550], [80_000, 3_350], [120_000, 7_950], [160_000, 13_950],
      [200_000, 21_150], [240_000, 28_750], [280_000, 36_550], [320_000, 44_550], [500_000, 84_150],
      [1_000_000, 199_150], [1_200_000, 247_150], [34_750, 366.25], [234_100, 27_629],
    ];
    for (const [ci, tax] of vectors) expect(taxCents(ci)).toBe(Math.round(tax * 100));
  });

  it('reproduces Appendix A.1, A.2 and A.3', () => {
    const a1: Clean = {
      incomeYear: 2026, today: '2026-11-13', residency: 'citizen', prYear: 3, age: 35, birthMonth: 12, ptr: false,
      ow: 10_000, months: 12, aw: 15_000, otherIncome: 0, expenses: 0, donations: 0, override: null,
      existing: { srs: 0, self: 0, family: 0 }, otherReliefs: 5_000, on: { srs: true, self: true, family: false },
      roomToLimit: null, maxAmount: null, budget: null, minRate: 0.07, priority: ['srs', 'cpfSelf', 'cpfFamily'], step: 1_000,
    };
    const o1 = oracle(a1);
    expect([o1.cpf.employeeContribution, o1.base.chargeableIncome, o1.base.taxCents]).toEqual([20_400, 108_600, 663_900]);
    expect([o1.U, o1.C, o1.L, o1.X, o1.binding]).toEqual([68_600, 53_600, 23_300, 23_300, 'leverLimits']);
    expect([o1.after.taxCents, o1.unrealisedCents]).toEqual([395_950, 235_950]);

    expect(o1.warnings).toEqual(['LEVER_LIMITS_PLAN']);

    // A.2: the CPF self room is entered (50,000) — at 57 it must be (§6.5).
    const a2: Clean = {
      ...a1, residency: 'pr', age: 57, birthMonth: 6, ow: 14_000, aw: 40_000, otherReliefs: 30_000,
      existing: { srs: 5_000, self: 0, family: 0 }, on: { srs: true, self: true, family: true }, roomToLimit: 50_000, maxAmount: 8_000,
      budget: 20_000, minRate: 0, priority: ['cpfSelf', 'srs', 'cpfFamily'],
    };
    const o2 = oracle(a2);
    expect([o2.cpf.employeeContribution, o2.base.chargeableIncome, o2.base.taxCents]).toEqual([18_360, 148_640, 1_224_600]);
    expect([o2.U, o2.C, o2.L, o2.X, o2.binding]).toEqual([128_640, 20_640, 26_300, 20_000, 'cashBudget']);
    expect(o2.contributions).toEqual({ cpfSelf: 8_000, srs: 10_300, cpfFamily: 1_700 });
    expect([o2.after.taxCents, o2.unrealisedCents]).toEqual([924_600, 9_600]);
    expect(o2.ladder.map((t) => [t.from, t.to, t.rate, t.zero, t.savedCents])).toEqual([
      [0, 20_640, 0.15, undefined, 309_600],
      [20_640, 26_300, 0, 'reliefCap', 0],
    ]);
    expect(o2.warnings).toEqual(['BUDGET_LIMITS_PLAN', 'AGE_55_PLUS_TOPUP', 'FAMILY_TOPUP_CHECKS']);

    // A.2b: the same person with the room left blank — CPF self room 0, L = 18,300, X = 18,300 (leverLimits).
    const o2b = oracle({ ...a2, roomToLimit: null });
    expect(o2b.caps.room).toEqual({ srs: 10_300, cpfSelf: 0, cpfFamily: 8_000 });
    expect([o2b.U, o2b.C, o2b.L, o2b.X, o2b.binding]).toEqual([128_640, 20_640, 18_300, 18_300, 'leverLimits']);
    expect(o2b.contributions).toEqual({ srs: 10_300, cpfSelf: 0, cpfFamily: 8_000 });
    expect([o2b.after.chargeableIncome, o2b.after.taxCents, o2b.base.taxCents - o2b.after.taxCents]).toEqual([130_340, 950_100, 274_500]);
    expect(o2b.warnings).toEqual(['LEVER_LIMITS_PLAN', 'CPF_SELF_ROOM_UNCONFIRMED', 'FAMILY_TOPUP_CHECKS']);

    const a3: Clean = { ...a1, age: 28, ow: 3_500, aw: 3_500, otherReliefs: 0 };
    const o3 = oracle(a3);
    expect([o3.cpf.employeeContribution, o3.base.chargeableIncome, o3.base.taxCents]).toEqual([9_100, 35_400, 38_900]);
    expect([o3.U, o3.X, o3.binding, o3.warnings]).toEqual([0, 0, 'usefulRoom', ['BELOW_MIN_SAVING_RATE']]);
    const o3b = oracle({ ...a3, minRate: 0 });
    expect([o3b.U, o3b.X, o3b.after.taxCents]).toEqual([15_400, 15_400, 0]);
    expect(o3b.contributions).toEqual({ srs: 15_300, cpfSelf: 100, cpfFamily: 0 });
  });
});

describe('engine vs brute-force oracle', () => {
  const compare = (c: Clean): ReturnType<typeof oracle> => {
    const o = oracle(c);
    const r = plan(toInput(c));
    try {
      expect(view(r, o)).toEqual(expected(o));
      // Severity of every warning, per the SPEC table.
      for (const w of r.warnings) expect(w.severity).toBe(SEVERITY[w.code]);
      // Derived ratios.
      expect(r.plan.savingRate).toBe(o.X === 0 ? 0 : r.plan.taxSaved / o.X);
      expect(r.baseline.effectiveRate).toBe(o.base.totalIncome === 0 ? 0 : r.baseline.taxPayable / o.base.totalIncome);
      // Simulator step columns.
      r.simulator.forEach((row, i) => {
        const prev = r.simulator[i - 1];
        const stepCents = prev ? cents(row.taxSaved) - cents(prev.taxSaved) : 0;
        expect(cents(row.stepSaving)).toBe(stepCents);
        expect(cents(row.taxSaved)).toBe(o.base.taxCents - o.simulator[i]!.taxCents);
        expect(row.stepRate).toBe(prev ? row.stepSaving / (row.contribution - prev.contribution) : 0);
      });
      for (const s of r.scenarios) {
        expect(cents(s.taxSaved)).toBe(o.base.taxCents - cents(s.taxPayable));
        expect(s.savingRate).toBe(s.totalContribution === 0 ? 0 : s.taxSaved / s.totalContribution);
      }
    } catch (error) {
      throw new Error(`Mismatch for input ${JSON.stringify(toInput(c))}\n${(error as Error).message}`);
    }
    return o;
  };

  it('1,200 boundary-biased random profiles agree on every field', () => {
    const next = generator(20261113);
    const warnings = new Set<string>();
    const bindings = new Set<string>();
    const zeroReasons = new Set<string>();
    const sources = new Set<string>();
    let planned = 0;
    let multiTier = 0;
    let twoLevers = 0;
    let scheduled = 0;
    let lowValuePlans = 0;
    let roomHeldBack = 0;
    for (let i = 0; i < 1_200; i++) {
      const c = next();
      const o = compare(c);
      if ((o.lowValue ?? 0) > 0) lowValuePlans++;
      // People of 55 or over whose blank room is what keeps their own CPF out of the plan (§6.5).
      if (c.age >= 55 && c.roomToLimit === null && c.on.self && o.caps.cap.cpfSelf > o.caps.used.cpfSelf && o.caps.room.cpfSelf === 0) roomHeldBack++;
      o.warnings.forEach((w) => warnings.add(w));
      bindings.add(o.binding);
      o.ladder.forEach((t) => t.zero && zeroReasons.add(t.zero));
      sources.add(o.cpf.source);
      if (o.X > 0) planned++;
      if (o.ladder.length >= 2) multiTier++;
      if ([o.contributions.srs, o.contributions.cpfSelf, o.contributions.cpfFamily].filter((x) => x > 0).length >= 2) twoLevers++;
      if (o.monthly.schedule.length > 1) scheduled++;
    }
    // The comparison is only worth something if the generator really reaches every branch.
    expect([...warnings].sort()).toEqual(Object.keys(SEVERITY).filter((code) => code !== 'PIT_REBATE_APPLIED').sort());
    expect([...bindings].sort()).toEqual(['cashBudget', 'leverLimits', 'none', 'reliefCap', 'usefulRoom']);
    expect([...zeroReasons].sort()).toEqual(['belowTaxThreshold', 'reliefCap']);
    expect([...sources].sort()).toEqual(['auto', 'none', 'override']);
    expect({ planned: planned > 300, multiTier: multiTier > 100, twoLevers: twoLevers > 80, scheduled: scheduled > 80 }).toEqual({
      planned: true,
      multiTier: true,
      twoLevers: true,
      scheduled: true,
    });
    // The rule audit's additions are really exercised: foreigners whose plan reaches the rungs below 7.5 cents,
    // and people from 55 whose own CPF is left out because the room is blank.
    expect({ lowValuePlans, roomHeldBack, enough: lowValuePlans >= 10 && roomHeldBack >= 100 }).toEqual({ lowValuePlans, roomHeldBack, enough: true });
  });

  it('400 low-bracket profiles whose ladders cross the 7% / 3.5% / 2% / 0% bands', () => {
    const next = generator(777);
    const random = mulberry32(31337);
    const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
    let threeTiers = 0;
    let fourTiers = 0;
    let lowValuePlans = 0;
    for (let i = 0; i < 400; i++) {
      const c = next();
      c.residency = random() < 0.8 ? 'citizen' : 'foreigner';
      c.age = int(18, 54);
      c.ow = int(2_400, 6_500);
      c.months = 12;
      c.aw = int(0, 6_000);
      c.otherIncome = random() < 0.7 ? 0 : int(0, 30_000);
      c.expenses = 0;
      c.override = null;
      c.otherReliefs = random() < 0.7 ? 0 : int(0, 45_000);
      c.existing = { srs: 0, self: 0, family: 0 };
      c.on = { srs: true, self: true, family: random() < 0.7 };
      c.roomToLimit = null;
      c.maxAmount = null;
      c.minRate = random() < 0.6 ? 0 : c.minRate;
      const o = compare(c);
      if (o.ladder.length >= 3) threeTiers++;
      if (o.ladder.length >= 4) fourTiers++;
      if ((o.lowValue ?? 0) > 0) lowValuePlans++;
    }
    expect({ threeTiers: threeTiers > 150, fourTiers: fourTiers > 40 }).toEqual({ threeTiers: true, fourTiers: true });
    // About one profile in five is a foreigner, most of them planning down to rungs that save less than 7.5 cents
    // per dollar: SRS_NON_RESIDENT_WITHDRAWAL's lowValueAmount is compared on plenty of non-zero cases.
    expect({ lowValuePlans, enough: lowValuePlans >= 30 }).toEqual({ lowValuePlans, enough: true });
  });

  it('700 profiles engineered so that U, C, L and B coincide or differ by one dollar', () => {
    const next = tieGenerator(4242);
    const seen = new Set<string>();
    for (let i = 0; i < 700; i++) {
      const c = next();
      seen.add(oracle(c).binding);
      compare(c);
    }
    // The generator must actually reach every binding constraint.
    expect([...seen].sort()).toEqual(['cashBudget', 'leverLimits', 'none', 'reliefCap', 'usefulRoom']);
  });

  it('exhaustive: every monthly wage from 0 to 8,200 in every age band, table and year', () => {
    for (const incomeYear of [2025, 2026, 2027]) {
      const rules = getRules(incomeYear);
      for (const [residency, prYear] of [['citizen', 3], ['pr', 1], ['pr', 2]] as const) {
        if (residency === 'pr' && incomeYear !== 2026) continue; // graduated tables are the same in every year
        for (const age of [30, 58, 62, 67, 75]) {
          const base: Clean = {
            incomeYear, today: `${incomeYear}-06-15`, residency, prYear, age, birthMonth: 12, ptr: false,
            ow: 0, months: 12, aw: 0, otherIncome: 0, expenses: 0, donations: 0, override: null,
            existing: { srs: 0, self: 0, family: 0 }, otherReliefs: 0, on: { srs: false, self: false, family: false },
            roomToLimit: null, maxAmount: null, budget: null, minRate: 0, priority: ['srs', 'cpfSelf', 'cpfFamily'], step: 1_000,
          };
          for (let ow = 0; ow <= 8_200; ow++) {
            const c = { ...base, ow };
            const o = oracleCpf(c);
            const r = computeCpf(toInput(c), rules);
            if (r.employeeContribution !== o.employeeContribution || r.ordinaryWagesSubject !== o.ordinaryWagesSubject) {
              throw new Error(`CPF mismatch: year ${incomeYear} ${residency}/${prYear} age ${age} wage ${ow}: engine ${r.employeeContribution}, oracle ${o.employeeContribution}`);
            }
          }
        }
      }
    }
  });

  it('exhaustive: grossTax and marginalRate for every chargeable income from 0 to 330,000 and around the upper boundaries', () => {
    for (const year of [2025, 2026, 2027]) {
      const rules = getRules(year);
      const check = (ci: number): void => {
        if (Math.round(grossTax(ci, rules) * 100) !== taxCents(ci) || Math.round(marginalRate(ci, rules) * 1000) !== perMilleOfDollar(ci)) {
          throw new Error(`tax mismatch at CI ${ci} (${year}): engine ${grossTax(ci, rules)} / ${marginalRate(ci, rules)}, oracle ${taxCents(ci) / 100} / ${perMilleOfDollar(ci)}`);
        }
        // The returned number must be exactly the two-decimal value, not a float neighbour of it.
        if (grossTax(ci, rules) !== taxCents(ci) / 100) throw new Error(`grossTax(${ci}) is not cent-exact: ${grossTax(ci, rules)}`);
      };
      const step = year === 2026 ? 1 : 7;
      for (let ci = 0; ci <= 330_000; ci += step) check(ci);
      for (const edge of [500_000, 1_000_000]) for (let d = -300; d <= 300; d++) check(edge + d);
      for (const big of [2_345_678, 9_999_999, 123_456_789, 9_999_999_999, 139_999_978_600]) check(big);
    }
  });

  it('end to end: plan() lands on the same chargeable income and tax around every bracket boundary', () => {
    // A foreigner with other income only has no reliefs at all, so chargeable income = other income.
    const base: Clean = {
      incomeYear: 2026, today: '2026-06-15', residency: 'foreigner', prYear: 3, age: 40, birthMonth: 12, ptr: false,
      ow: 0, months: 12, aw: 0, otherIncome: 0, expenses: 0, donations: 0, override: null,
      existing: { srs: 0, self: 0, family: 0 }, otherReliefs: 0, on: { srs: false, self: false, family: false },
      roomToLimit: null, maxAmount: null, budget: null, minRate: 0, priority: ['srs', 'cpfSelf', 'cpfFamily'], step: 1_000,
    };
    for (const [from] of TAX) {
      for (let d = -3; d <= 3; d++) {
        const ci = from + d;
        if (ci < 0) continue;
        const r = plan(toInput({ ...base, otherIncome: ci }));
        expect(r.baseline.chargeableIncome).toBe(ci);
        expect(cents(r.baseline.taxPayable)).toBe(taxCents(ci));
        expect(Math.round(r.baseline.marginalRate * 1000)).toBe(perMilleOfDollar(ci));
      }
    }
  });
});
