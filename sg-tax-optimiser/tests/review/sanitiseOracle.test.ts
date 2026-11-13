/**
 * Adversarial review — SPEC §6.0 input sanitising, checked against an independent re-statement of the rules.
 *
 * `specSanitise` below is written from the text of SPEC §6.0 only. A generator then feeds both it and the
 * engine thousands of inputs assembled from hostile values (NaN, ±Infinity, negatives, fractions, numbers beyond
 * the clamp, strings, booleans, arrays, objects, missing sections) and the two must agree field for field.
 */
import { describe, expect, it } from 'vitest';
import { plan, sanitiseInput } from '../../src/engine';
import type { PlannerInput } from '../../src/engine';

const MAX_MONEY = 10_000_000_000;
const LEVERS = ['srs', 'cpfSelf', 'cpfFamily'] as const;

// ---- SPEC §6.0, restated ---------------------------------------------------------------------------------

/** "not finite or < 0 -> 0; otherwise Math.floor"; "also clamped to at most S$10,000,000,000". */
function specMoney(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_MONEY) + 0;
}

/** "first sanitised like money (not finite or < 0 -> 0, then floored) and then clamped; a missing or non-number value takes the default". */
function specClamped(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== 'number') return fallback;
  const whole = !Number.isFinite(value) || value < 0 ? 0 : Math.floor(value);
  return Math.max(lo, Math.min(hi, whole)) + 0;
}

/** "apply only when they are numbers (then sanitised like money, so a negative limit is 0); null, missing or non-number means no limit". */
function specLimit(value: unknown): number | null {
  return typeof value === 'number' ? specMoney(value) : null;
}

function specRate(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function specPriority(value: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && (LEVERS as readonly string[]).includes(entry) && !out.includes(entry)) out.push(entry);
    }
  }
  for (const lever of LEVERS) if (!out.includes(lever)) out.push(lever);
  return out;
}

function specToday(value: unknown, incomeYear: number): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !/^\d{4}-\d{2}-\d{3}/.test(value)) {
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(5, 7));
    const d = Number(value.slice(8, 10));
    const probe = new Date(Date.UTC(2000, 0, 1));
    probe.setUTCFullYear(y, m - 1, d);
    if (m >= 1 && m <= 12 && d >= 1 && probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d) {
      return value.slice(0, 10);
    }
  }
  return `${String(incomeYear).padStart(4, '0')}-01-01`;
}

const bag = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

function specSanitise(raw: unknown, incomeYear: number) {
  const r = bag(raw);
  const profile = bag(r.profile);
  const income = bag(r.income);
  const existing = bag(r.existing);
  const levers = bag(r.levers);
  const prefs = bag(r.preferences);
  return {
    incomeYear,
    today: specToday(r.today, incomeYear),
    profile: {
      residency: profile.residency === 'pr' || profile.residency === 'foreigner' ? profile.residency : 'citizen',
      prYear: profile.prYear === 1 || profile.prYear === 2 ? profile.prYear : 3,
      ageAtYearEnd: specClamped(profile.ageAtYearEnd, 0, 120, 0),
      birthMonth: specClamped(profile.birthMonth, 1, 12, 12),
      // "`profile.hasUnusedParenthoodTaxRebate` is likewise `true` only for the boolean `true`, otherwise `false`."
      hasUnusedParenthoodTaxRebate: typeof profile.hasUnusedParenthoodTaxRebate === 'boolean' && profile.hasUnusedParenthoodTaxRebate,
    },
    income: {
      monthlyOrdinaryWage: specMoney(income.monthlyOrdinaryWage),
      monthsWorked: specClamped(income.monthsWorked, 1, 12, 12),
      additionalWages: specMoney(income.additionalWages),
      otherTaxableIncome: specMoney(income.otherTaxableIncome),
      employmentExpenses: specMoney(income.employmentExpenses),
      donations: specMoney(income.donations),
      // §6.0: the override is a figure, not a limit — only a finite number of 0 or more counts; else "not provided".
      employeeCpfOverride:
        typeof income.employeeCpfOverride === 'number' && Number.isFinite(income.employeeCpfOverride) && income.employeeCpfOverride >= 0
          ? specLimit(income.employeeCpfOverride)
          : null,
    },
    existing: {
      srs: specMoney(existing.srs),
      cpfTopUpSelf: specMoney(existing.cpfTopUpSelf),
      cpfTopUpFamily: specMoney(existing.cpfTopUpFamily),
    },
    otherReliefs: specMoney(r.otherReliefs),
    levers: {
      srs: { enabled: bag(levers.srs).enabled === true },
      cpfSelf: { enabled: bag(levers.cpfSelf).enabled === true, roomToLimit: specLimit(bag(levers.cpfSelf).roomToLimit) },
      cpfFamily: { enabled: bag(levers.cpfFamily).enabled === true, maxAmount: specLimit(bag(levers.cpfFamily).maxAmount) },
    },
    preferences: {
      cashBudget: specLimit(prefs.cashBudget),
      minSavingRate: specRate(prefs.minSavingRate),
      priority: specPriority(prefs.priority),
      // "simulatorStep (default 1,000; minimum 100)": sanitised like money (without the money clamp), then >= 100.
      simulatorStep:
        typeof prefs.simulatorStep !== 'number'
          ? 1_000
          : Math.max(100, !Number.isFinite(prefs.simulatorStep) || prefs.simulatorStep < 0 ? 0 : Math.floor(prefs.simulatorStep)),
    },
  };
}

// ---- generator -------------------------------------------------------------------------------------------

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

const HOSTILE: unknown[] = [
  undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0, -1, -0.5, 0.4, 0.5, 0.999, 1, 1.5, 2, 2.999,
  3, 11, 11.99, 12, 12.01, 13, 17.9, 18, 54.99, 55, 99, 99.99, 100, 100.5, 119.9, 120, 120.1, 121, 500, 750.75, 8_000,
  15_300.99, 102_000, 1e9, MAX_MONEY - 0.5, MAX_MONEY, MAX_MONEY + 1, 1e15, 2 ** 53, 1e300, Number.MAX_VALUE, Number.MIN_VALUE,
  '', '5', '5000', 'abc', '12', true, false, [], [5], {}, { valueOf: () => 5 },
];
const RATES: unknown[] = [undefined, null, Number.NaN, -1, -0.0001, 0, 0.02, 0.07, 0.115, 0.9999, 1, 1.0001, 5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.07', true, {}];
const RESIDENCIES: unknown[] = ['citizen', 'pr', 'foreigner', 'PR', 'Citizen', '', 'tourist', undefined, null, 3, {}];
const PR_YEARS: unknown[] = [1, 2, 3, 0, 4, 1.5, '1', '2', null, undefined, Number.NaN, true];
const BOOLS: unknown[] = [true, false, true, false, undefined, null, 1, 0, 'true', 'yes', {}];
const TODAYS: unknown[] = [
  '2026-11-13', '2026-01-01', '2026-12-31', '2027-01-01', '2025-06-30', '2024-02-29', '2026-02-29', '2026-02-30', '2026-13-01',
  '2026-00-10', '2026-04-31', '2026-06-00', '2026-11-13T10:30:00Z', '2026-11-13 10:30', '2026-11-131', '2026-1-3', '26-11-13',
  ' 2026-11-13', '13/11/2026', 'today', '', undefined, null, 20261113, new Date(Date.UTC(2026, 10, 13)), {}, [], '0000-01-01', '9999-12-31',
];
const PRIORITIES: unknown[] = [
  ['srs', 'cpfSelf', 'cpfFamily'], ['cpfFamily', 'cpfSelf', 'srs'], ['cpfSelf'], [], ['cpfFamily', 'cpfFamily', 'srs'], ['srs', 'bank', 'cpfSelf', 'srs', 'cpfFamily', 'x'],
  ['SRS', 'cpfself'], [null, 1, 'cpfFamily'], 'srs', { 0: 'cpfFamily', length: 1 }, undefined, null, 7, [['srs'], 'cpfSelf'],
];
const SECTIONS: unknown[] = [undefined, null, 5, 'x', [], true];

function hostileInput(random: () => number, incomeYear: number): unknown {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const maybeSection = <T>(build: () => T): T | unknown => (random() < 0.06 ? pick(SECTIONS) : build());
  const field = (target: Record<string, unknown>, key: string, value: unknown): void => {
    if (random() < 0.08) return; // leave the key out altogether
    target[key] = value;
  };
  const input: Record<string, unknown> = { incomeYear };
  field(input, 'today', pick(TODAYS));
  input.profile = maybeSection(() => {
    const o: Record<string, unknown> = {};
    field(o, 'residency', pick(RESIDENCIES));
    field(o, 'prYear', pick(PR_YEARS));
    field(o, 'ageAtYearEnd', pick(HOSTILE));
    field(o, 'birthMonth', pick(HOSTILE));
    field(o, 'hasUnusedParenthoodTaxRebate', pick(BOOLS));
    return o;
  });
  input.income = maybeSection(() => {
    const o: Record<string, unknown> = {};
    for (const key of ['monthlyOrdinaryWage', 'monthsWorked', 'additionalWages', 'otherTaxableIncome', 'employmentExpenses', 'donations', 'employeeCpfOverride']) {
      field(o, key, pick(HOSTILE));
    }
    return o;
  });
  input.existing = maybeSection(() => {
    const o: Record<string, unknown> = {};
    for (const key of ['srs', 'cpfTopUpSelf', 'cpfTopUpFamily']) field(o, key, pick(HOSTILE));
    return o;
  });
  field(input, 'otherReliefs', pick(HOSTILE));
  input.levers = maybeSection(() => {
    const o: Record<string, unknown> = {};
    o.srs = maybeSection(() => ({ enabled: pick(BOOLS) }));
    o.cpfSelf = maybeSection(() => ({ enabled: pick(BOOLS), roomToLimit: pick(HOSTILE) }));
    o.cpfFamily = maybeSection(() => ({ enabled: pick(BOOLS), maxAmount: pick(HOSTILE) }));
    return o;
  });
  input.preferences = maybeSection(() => {
    const o: Record<string, unknown> = {};
    field(o, 'cashBudget', pick(HOSTILE));
    field(o, 'minSavingRate', pick(RATES));
    field(o, 'priority', pick(PRIORITIES));
    field(o, 'simulatorStep', pick(HOSTILE));
    return o;
  });
  return input;
}

// ---- tests -----------------------------------------------------------------------------------------------

describe('SPEC §6.0 — sanitiseInput against an independent restatement of the rules', () => {
  it('3,000 hostile inputs sanitise exactly as the SPEC says, and plan() runs on every one of them', () => {
    const random = mulberry32(60);
    for (let i = 0; i < 3_000; i++) {
      const incomeYear = [2025, 2026, 2027][i % 3]!;
      const raw = hostileInput(random, incomeYear);
      const expected = specSanitise(raw, incomeYear);
      let actual: unknown;
      try {
        actual = sanitiseInput(raw as PlannerInput);
        expect(actual).toEqual(expected);
      } catch (error) {
        throw new Error(`sanitise mismatch for ${JSON.stringify(raw, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v === undefined ? '<undefined>' : v))}\n${(error as Error).message}`);
      }
      // The engine must plan from the sanitised values and from nothing else.
      const viaRaw = plan(raw as PlannerInput);
      expect(viaRaw.input).toEqual(expected);
      if (i % 10 === 0) {
        const { rules: _a, ...restRaw } = viaRaw;
        const { rules: _b, ...restClean } = plan(expected as unknown as PlannerInput);
        expect(restRaw).toEqual(restClean);
      }
    }
  });

  it('whole sections may be missing or garbage', () => {
    for (const raw of [{ incomeYear: 2026 }, { incomeYear: 2026, profile: null, income: 5, existing: 'x', levers: [], preferences: true }]) {
      const s = sanitiseInput(raw as unknown as PlannerInput);
      expect(s).toEqual(specSanitise(raw, 2026));
      expect(s.profile).toEqual({ residency: 'citizen', prYear: 3, ageAtYearEnd: 0, birthMonth: 12, hasUnusedParenthoodTaxRebate: false });
      expect(s.income).toEqual({
        monthlyOrdinaryWage: 0, monthsWorked: 12, additionalWages: 0, otherTaxableIncome: 0, employmentExpenses: 0, donations: 0, employeeCpfOverride: null,
      });
      expect(s.preferences).toEqual({ cashBudget: null, minSavingRate: 0, priority: ['srs', 'cpfSelf', 'cpfFamily'], simulatorStep: 1_000 });
      expect(s.today).toBe('2026-01-01');
      const r = plan(raw as unknown as PlannerInput);
      expect(r.baseline.taxPayable).toBe(0);
      expect(r.plan.totalContribution).toBe(0);
      expect(r.warnings.map((w) => w.code)).toEqual(['NO_TAX_PAYABLE', 'SRS_UNDER_18']);
    }
  });

  it('the table in SPEC §6.0, value by value', () => {
    const base = { incomeYear: 2026, today: '2026-06-15', profile: {}, income: {}, existing: {}, levers: {}, preferences: {} };
    const s = (patch: Record<string, unknown>) => sanitiseInput({ ...base, ...patch } as unknown as PlannerInput);
    // monthsWorked: clamped to 1..12, default 12; a NUMBER that is not finite or negative is 0 first, hence 1.
    const months = (v: unknown) => s({ income: { monthsWorked: v } }).income.monthsWorked;
    expect([undefined, null, '6', 0, 0.9, 1, 6.99, 12, 12.9, 13, 1e9, -3, Number.NaN, Number.POSITIVE_INFINITY].map(months)).toEqual(
      [12, 12, 12, 1, 1, 1, 6, 12, 12, 12, 12, 1, 1, 1],
    );
    // birthMonth: clamped to 1..12, default 12.
    const birth = (v: unknown) => s({ profile: { birthMonth: v } }).profile.birthMonth;
    expect([undefined, '3', 0, 1, 3.7, 12, 13, -1, Number.NaN].map(birth)).toEqual([12, 12, 1, 1, 3, 12, 12, 1, 1]);
    // ageAtYearEnd: clamped to 0..120, default 0.
    const age = (v: unknown) => s({ profile: { ageAtYearEnd: v } }).profile.ageAtYearEnd;
    expect([undefined, '35', -5, 0, 17.99, 35, 120, 120.9, 121, 1e300, Number.NaN, Number.POSITIVE_INFINITY].map(age)).toEqual(
      [0, 0, 0, 0, 17, 35, 120, 120, 120, 120, 0, 0],
    );
    // prYear: 3 unless exactly 1 or 2.
    const pr = (v: unknown) => s({ profile: { prYear: v } }).profile.prYear;
    expect([undefined, 0, 1, 2, 3, 4, 1.5, '1', Number.NaN].map(pr)).toEqual([3, 3, 1, 2, 3, 3, 3, 3, 3]);
    // minSavingRate: clamped to 0..1 without flooring; not a number -> 0.
    const rate = (v: unknown) => s({ preferences: { minSavingRate: v } }).preferences.minSavingRate;
    expect([undefined, '0.07', -0.1, 0, 0.0701, 0.999, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map(rate)).toEqual(
      [0, 0, 0, 0, 0.0701, 0.999, 1, 1, 0, 1, 0],
    );
    // simulatorStep: default 1,000, minimum 100, floored.
    const step = (v: unknown) => s({ preferences: { simulatorStep: v } }).preferences.simulatorStep;
    expect([undefined, null, '500', 0, 99, 99.99, 100, 100.9, 2_500.5, -1, Number.NaN, Number.POSITIVE_INFINITY].map(step)).toEqual(
      [1_000, 1_000, 1_000, 100, 100, 100, 100, 100, 2_500, 100, 100, 100],
    );
    // Optional limits: a number is sanitised like money; anything else is "no limit".
    const budget = (v: unknown) => s({ preferences: { cashBudget: v } }).preferences.cashBudget;
    expect([undefined, null, '500', true, 0, 0.9, 500.9, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e11].map(budget)).toEqual(
      [null, null, null, null, 0, 0, 500, 0, 0, 0, 10_000_000_000],
    );
    const room = (v: unknown) => s({ levers: { cpfSelf: { enabled: true, roomToLimit: v } } }).levers.cpfSelf.roomToLimit;
    const max = (v: unknown) => s({ levers: { cpfFamily: { enabled: true, maxAmount: v } } }).levers.cpfFamily.maxAmount;
    const override = (v: unknown) => s({ income: { employeeCpfOverride: v } }).income.employeeCpfOverride;
    for (const f of [room, max]) {
      expect([undefined, null, 'x', 0, 7_999.9, -2, Number.NaN].map(f)).toEqual([null, null, null, 0, 7_999, 0, 0]);
    }
    // The CPF override replaces a calculated figure, so a meaningless value is "not provided", never a figure of 0.
    expect([undefined, null, 'x', 0, 7_999.9, -2, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e11].map(override)).toEqual(
      [null, null, null, 0, 7_999, null, null, null, null, null, 10_000_000_000],
    );
    // Money: non-negative whole dollars, at most S$10 billion.
    const money = (v: unknown) => s({ otherReliefs: v }).otherReliefs;
    expect([undefined, null, '5000', true, -1, -0.01, 0, 0.99, 4_999.99, 1e10, 1e10 + 0.5, 1e10 + 1, Number.NaN, Number.POSITIVE_INFINITY].map(money)).toEqual(
      [0, 0, 0, 0, 0, 0, 0, 0, 4_999, 1e10, 1e10, 1e10, 0, 0],
    );
    // Priority: repaired to a permutation — valid entries in the order given, then the missing ones in canonical order.
    const priority = (v: unknown) => s({ preferences: { priority: v } }).preferences.priority;
    expect(priority(['cpfFamily'])).toEqual(['cpfFamily', 'srs', 'cpfSelf']);
    expect(priority(['cpfSelf', 'cpfSelf', 'bogus', 'cpfFamily'])).toEqual(['cpfSelf', 'cpfFamily', 'srs']);
    expect(priority(['cpfFamily', 'srs', 'cpfSelf', 'srs'])).toEqual(['cpfFamily', 'srs', 'cpfSelf']);
    expect(priority(undefined)).toEqual(['srs', 'cpfSelf', 'cpfFamily']);
    expect(priority('cpfFamily')).toEqual(['srs', 'cpfSelf', 'cpfFamily']);
    // Residency: unknown -> citizen.
    const residency = (v: unknown) => s({ profile: { residency: v } }).profile.residency;
    expect(['citizen', 'pr', 'foreigner', 'PR', '', undefined, 1].map(residency)).toEqual(['citizen', 'pr', 'foreigner', 'citizen', 'citizen', 'citizen', 'citizen']);
    // Flags: true only for the boolean true — a lever's `enabled` and the Parenthood Tax Rebate tick-box alike.
    const tick = (v: unknown) => s({ profile: { hasUnusedParenthoodTaxRebate: v } }).profile.hasUnusedParenthoodTaxRebate;
    const enabled = (v: unknown) => s({ levers: { srs: { enabled: v } } }).levers.srs.enabled;
    for (const flag of [tick, enabled]) {
      expect([true, false, undefined, null, 1, 0, 'true', 'yes', {}, [true], Number.NaN].map(flag)).toEqual(
        [true, false, false, false, false, false, false, false, false, false, false],
      );
    }
  });

  it('sanitising has real consequences: each rule changes the plan in the direction the SPEC says', () => {
    const good: PlannerInput = {
      incomeYear: 2026,
      today: '2026-06-15',
      profile: { residency: 'citizen', prYear: 3, ageAtYearEnd: 35, birthMonth: 12 },
      income: { monthlyOrdinaryWage: 10_000, monthsWorked: 12, additionalWages: 15_000, otherTaxableIncome: 0, employmentExpenses: 0, donations: 0, employeeCpfOverride: null },
      existing: { srs: 0, cpfTopUpSelf: 0, cpfTopUpFamily: 0 },
      otherReliefs: 5_000,
      levers: { srs: { enabled: true }, cpfSelf: { enabled: true, roomToLimit: null }, cpfFamily: { enabled: false, maxAmount: null } },
      preferences: { cashBudget: null, minSavingRate: 0.07, priority: ['srs', 'cpfSelf', 'cpfFamily'], simulatorStep: 1_000 },
    };
    const patched = (patch: (i: PlannerInput) => void): PlannerInput => {
      const copy = JSON.parse(JSON.stringify(good)) as PlannerInput;
      patch(copy);
      return copy;
    };
    // Fractional wage is floored: 10,000.99 -> 10,000 (tax 6,639.00), not 10,001.
    expect(plan(patched((i) => (i.income.monthlyOrdinaryWage = 10_000.99))).baseline.taxPayable).toBe(6_639);
    // A negative bonus is 0: income 120,000; CPF 19,200; CI 94,800 -> 3,350 + 11.5% x 14,800 = 5,052.00.
    expect(plan(patched((i) => (i.income.additionalWages = -15_000))).baseline.taxPayable).toBe(5_052);
    // monthsWorked 0 is clamped to 1 (December only): income 10,000 + 15,000 = 25,000;
    // CPF 1,600 + 20% x 15,000 = 4,600; EIR 1,000; other 5,000 -> CI 14,400 -> no tax.
    const oneMonth = plan(patched((i) => (i.income.monthsWorked = 0)));
    expect(oneMonth.input.income.monthsWorked).toBe(1);
    expect(oneMonth.baseline.employmentIncome).toBe(25_000);
    expect(oneMonth.cpf.employeeContribution).toBe(4_600);
    expect(oneMonth.baseline.chargeableIncome).toBe(14_400);
    // A budget of -1 is a budget of 0, not "no limit".
    const zeroBudget = plan(patched((i) => (i.preferences.cashBudget = -1)));
    expect(zeroBudget.plan.totalContribution).toBe(0);
    expect(zeroBudget.plan.bindingConstraint).toBe('cashBudget');
    // A fractional budget is floored: 2,500.99 -> 2,500 -> saves 287.50.
    expect(plan(patched((i) => (i.preferences.cashBudget = 2_500.99))).plan.taxSaved).toBe(287.5);
    // roomToLimit 0.9 -> 0: CPF self drops out; plan = SRS 15,300.
    expect(plan(patched((i) => (i.levers.cpfSelf.roomToLimit = 0.9))).plan.contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 0 });
    // minSavingRate above 1 is clamped to 1: nothing qualifies.
    expect(plan(patched((i) => (i.preferences.minSavingRate = 7))).plan.totalContribution).toBe(0);
    // minSavingRate 7 (a percent typed as a number) is NOT read as 7%: params show the clamped value.
    expect(plan(patched((i) => (i.preferences.minSavingRate = 7))).input.preferences.minSavingRate).toBe(1);
    // A negative minimum is 0.
    expect(plan(patched((i) => (i.preferences.minSavingRate = -0.5))).plan.totalContribution).toBe(23_300);
    // Unknown residency -> citizen: same plan as the original.
    expect(plan(patched((i) => ((i.profile as { residency: string }).residency = 'alien'))).plan).toEqual(plan(good).plan);
    // A broken priority is repaired: ['cpfSelf'] -> cpfSelf, srs, cpfFamily; with a 10,000 budget: self 8,000 + SRS 2,000.
    const repaired = plan(
      patched((i) => {
        i.preferences.priority = ['cpfSelf'] as PlannerInput['preferences']['priority'];
        i.preferences.cashBudget = 10_000;
      }),
    );
    expect(repaired.plan.contributions).toEqual({ srs: 2_000, cpfSelf: 8_000, cpfFamily: 0 });
    // Age NaN -> 0: under 18, so SRS drops out and only CPF self (8,000) is planned.
    const noAge = plan(patched((i) => (i.profile.ageAtYearEnd = Number.NaN)));
    expect(noAge.plan.contributions).toEqual({ srs: 0, cpfSelf: 8_000, cpfFamily: 0 });
    expect(noAge.warnings.map((w) => w.code)).toContain('SRS_UNDER_18');
    // The tick-box is a tick only as the boolean true: "true" and 1 raise no PARENTHOOD_TAX_REBATE caution, and
    // no value of it changes a figure.
    const ticked = plan(patched((i) => (i.profile.hasUnusedParenthoodTaxRebate = true)));
    expect(ticked.warnings.map((w) => w.code)).toEqual(['LEVER_LIMITS_PLAN', 'PARENTHOOD_TAX_REBATE']);
    expect(ticked.plan).toEqual(plan(good).plan);
    for (const notATick of ['true', 1]) {
      const r = plan(patched((i) => ((i.profile as { hasUnusedParenthoodTaxRebate: unknown }).hasUnusedParenthoodTaxRebate = notATick)));
      expect(r.input.profile.hasUnusedParenthoodTaxRebate).toBe(false);
      expect(r.warnings.map((w) => w.code)).toEqual(['LEVER_LIMITS_PLAN']);
    }
    // From 55 a room that is not a number is "not confirmed" (SPEC §6.5): the string "8000" is no room at all, so
    // own CPF drops out; the number 8,000 keeps it in. Age 55 with a December birthday: CPF 20,400, EIR 6,000,
    // CI 103,600; plan 15,300 (SRS only) vs 23,300.
    const at55 = (roomToLimit: unknown): PlannerInput =>
      patched((i) => {
        i.profile.ageAtYearEnd = 55;
        (i.levers.cpfSelf as { roomToLimit: unknown }).roomToLimit = roomToLimit;
      });
    expect(plan(at55('8000')).input.levers.cpfSelf.roomToLimit).toBeNull();
    expect(plan(at55('8000')).plan.contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 0 });
    expect(plan(at55(null)).plan.contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 0 });
    expect(plan(at55(8_000)).plan.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 });
    expect(plan(at55(8_000.9)).plan.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 });
  });
});
