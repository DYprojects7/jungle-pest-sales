/**
 * Adversarial review — robustness: hidden mutation, purity, the clock / locale / time zone, very large inputs,
 * floating-point exposure and the export surface (SPEC §6.0, §7).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import type { PlannerInput, PlannerResult } from '../../src/engine';

const ENGINE_DIR = join(__dirname, '..', '..', 'src', 'engine');

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A spread of profiles that between them reach every module and every warning branch. */
function profiles(): PlannerInput[] {
  const base = defaultInput('2026-11-13');
  const make = (patch: (input: PlannerInput) => void): PlannerInput => {
    const input = clone(base);
    patch(input);
    return input;
  };
  return [
    base,
    make((i) => {
      i.profile = { residency: 'pr', prYear: 3, ageAtYearEnd: 57, birthMonth: 6 };
      i.income.monthlyOrdinaryWage = 14_000;
      i.income.additionalWages = 40_000;
      i.otherReliefs = 30_000;
      i.existing.srs = 5_000;
      i.levers.cpfFamily = { enabled: true, maxAmount: 8_000 };
      i.preferences = { cashBudget: 20_000, minSavingRate: 0, priority: ['cpfSelf', 'srs', 'cpfFamily'], simulatorStep: 100 };
    }),
    make((i) => {
      i.profile = { residency: 'foreigner', ageAtYearEnd: 17 };
      i.income.employeeCpfOverride = 99_999;
      i.existing = { srs: 50_000, cpfTopUpSelf: 9_000, cpfTopUpFamily: 9_000 };
      i.today = '2027-03-01';
    }),
    make((i) => {
      i.incomeYear = 2027;
      i.today = '2027-12-25';
      i.profile = { residency: 'pr', prYear: 1, ageAtYearEnd: 70, birthMonth: 3 };
      i.income = { monthlyOrdinaryWage: 620, monthsWorked: 5, additionalWages: 90_000, otherTaxableIncome: 70_000, employmentExpenses: 500, donations: 333, employeeCpfOverride: 30_000 };
      i.existing = { srs: 20_000, cpfTopUpSelf: 8_001, cpfTopUpFamily: 0 };
      i.otherReliefs = 70_000;
      i.levers = { srs: { enabled: true }, cpfSelf: { enabled: true, roomToLimit: 0 }, cpfFamily: { enabled: true, maxAmount: 123 } };
    }),
    make((i) => {
      i.incomeYear = 2025;
      i.today = '2024-07-07';
      i.income.monthlyOrdinaryWage = 2_000;
      i.income.additionalWages = 0;
      i.otherReliefs = 0;
      i.preferences.minSavingRate = 0;
    }),
  ];
}

describe('hidden mutation', () => {
  it('plan / evaluate / computeCpf / sanitiseInput work on a deeply frozen input and leave it untouched', () => {
    for (const input of profiles()) {
      const frozen = deepFreeze(clone(input));
      const before = JSON.stringify(frozen);
      const viaFrozen = plan(frozen);
      expect(() => evaluate(frozen, deepFreeze({ srs: 1, cpfSelf: 2, cpfFamily: 3 }))).not.toThrow();
      expect(() => computeCpf(frozen, getRules(frozen.incomeYear))).not.toThrow();
      expect(() => sanitiseInput(frozen)).not.toThrow();
      expect(JSON.stringify(frozen)).toBe(before);
      const { rules: _a, ...restFrozen } = viaFrozen;
      const { rules: _b, ...restPlain } = plan(clone(input));
      expect(restFrozen).toEqual(restPlain);
    }
  });

  it('the engine never writes to the shared rule objects (deep-frozen for the rest of this file)', () => {
    const snapshots = SUPPORTED_INCOME_YEARS.map((year) => JSON.stringify(getRules(year)));
    for (const year of SUPPORTED_INCOME_YEARS) deepFreeze(getRules(year));
    deepFreeze(SUPPORTED_INCOME_YEARS);
    for (const input of profiles()) {
      for (const incomeYear of SUPPORTED_INCOME_YEARS) {
        const forYear = { ...clone(input), incomeYear };
        expect(() => plan(forYear)).not.toThrow();
        expect(() => evaluate(forYear, { srs: 5_000, cpfSelf: 5_000, cpfFamily: 5_000 })).not.toThrow();
        expect(() => computeCpf(forYear, getRules(incomeYear))).not.toThrow();
      }
    }
    expect(() => defaultInput('2026-11-13')).not.toThrow();
    expect(() => defaultIncomeYear('2031-01-01')).not.toThrow();
    expect(SUPPORTED_INCOME_YEARS.map((year) => JSON.stringify(getRules(year)))).toEqual(snapshots);
  });

  it('the result does not alias the caller\'s input: editing the result leaves the input and later results alone', () => {
    const input = profiles()[1]!;
    const pristine = clone(input);
    const first = plan(input);
    expect(first.input).not.toBe(input);
    expect(first.input.preferences.priority).not.toBe(input.preferences.priority);
    expect(first.input.profile).not.toBe(input.profile);
    expect(first.input.levers.cpfFamily).not.toBe(input.levers.cpfFamily);
    const reference = clone({ ...first, rules: undefined });
    // Vandalise everything in the first result except the (shared, frozen) rules.
    first.input.preferences.priority.reverse();
    first.input.income.monthlyOrdinaryWage = 1;
    first.plan.contributions.srs = -1;
    first.cpf.monthlyEmployeeRates.fill(9);
    first.ladder.length = 0;
    first.simulator.forEach((row) => (row.split.srs = -1));
    first.scenarios.forEach((s) => (s.contributions.cpfSelf = -1));
    first.monthlyPlan.schedule.forEach((row) => (row.amounts.srs = -1));
    first.levers.srs.room = -1;
    first.baseline.reliefs.cpf = -1;
    first.warnings.length = 0;
    expect(input).toEqual(pristine);
    expect(clone({ ...plan(input), rules: undefined })).toEqual(reference);
  });

  it('within one result, objects that are reported twice are not the same object', () => {
    // If plan.contributions and the "recommended" scenario shared one object, a UI that edits one would
    // silently change the other.
    const r = plan(profiles()[1]!);
    const recommended = r.scenarios.find((s) => s.id === 'recommended');
    expect(recommended?.contributions).toEqual(r.plan.contributions);
    expect(recommended?.contributions).not.toBe(r.plan.contributions);
    const seen = new Set<object>();
    for (const s of r.scenarios) {
      expect(seen.has(s.contributions)).toBe(false);
      seen.add(s.contributions);
    }
    for (const row of r.simulator) {
      expect(seen.has(row.split)).toBe(false);
      seen.add(row.split);
    }
    expect(r.optimised).not.toBe(r.baseline);
    expect(r.optimised.reliefs).not.toBe(r.baseline.reliefs);
  });
});

describe('purity and determinism', () => {
  it('the same input twice gives deep-equal output, and so does a JSON round trip of the input', () => {
    for (const input of profiles()) {
      const a = plan(input);
      const b = plan(input);
      const c = plan(clone(input));
      expect(a).toEqual(b);
      expect(a).toEqual(c);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(evaluate(input, { srs: 100, cpfSelf: 200, cpfFamily: 300 })).toEqual(evaluate(input, { srs: 100, cpfSelf: 200, cpfFamily: 300 }));
    }
  });

  it('calls do not influence each other (no hidden state between different inputs)', () => {
    const [a, b, c] = profiles();
    const alone = JSON.stringify(plan(b!));
    plan(a!);
    plan(c!);
    expect(JSON.stringify(plan(b!))).toBe(alone);
  });

  it('plan(sanitiseInput(x)) equals plan(x), and result.input is a fixed point of sanitiseInput', () => {
    for (const input of profiles()) {
      const direct = plan(input);
      expect(plan(sanitiseInput(input))).toEqual(direct);
      expect(sanitiseInput(direct.input)).toEqual(direct.input);
    }
  });

  it('optimised is exactly evaluate(input, plan.contributions) and baseline is evaluate(input, zeros)', () => {
    for (const input of profiles()) {
      const r = plan(input);
      expect(evaluate(input, r.plan.contributions)).toEqual(r.optimised);
      expect(evaluate(input, { srs: 0, cpfSelf: 0, cpfFamily: 0 })).toEqual(r.baseline);
      expect(computeCpf(input, getRules(input.incomeYear))).toEqual(r.cpf);
    }
  });
});

describe('the clock, the locale and the time zone', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sources = readdirSync(ENGINE_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(ENGINE_DIR, name), 'utf8') }));

  /** Source with comments and string literals removed, so prose such as "the 55th birthDate" cannot match. */
  const code = (text: string): string =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');

  it('there are engine sources to scan', () => {
    expect(sources.length).toBeGreaterThanOrEqual(20);
  });

  it('no engine source touches Date, Intl, locale formatting, randomness, timers, I/O or globals', () => {
    const forbidden = /\bDate\b|\bIntl\b|toLocale\w*|\bMath\.random\b|\bperformance\b|\bsetTimeout\b|\bsetInterval\b|\bfetch\b|\bprocess\b|\brequire\s*\(|\blocalStorage\b|\bwindow\b|\bdocument\b|\bglobalThis\b|\bconsole\b/;
    for (const { name, text } of sources) {
      const match = forbidden.exec(code(text));
      expect(match ? `${name}: ${match[0]}` : null).toBeNull();
    }
  });

  it('no runtime dependencies: every import in src/engine is a relative path', () => {
    for (const { name, text } of sources) {
      for (const match of text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
        expect(`${name} -> ${match[1]}`).toMatch(/-> \.\.?\//);
      }
    }
  });

  it('plan() works, and gives the same answer, when Date and Intl do not exist at all', () => {
    const input = defaultInput('2026-11-13');
    const expected = JSON.stringify(plan(input));
    const explode = new Proxy(function () {}, {
      get: () => {
        throw new Error('the engine touched the clock');
      },
      apply: () => {
        throw new Error('the engine called Date()');
      },
      construct: () => {
        throw new Error('the engine constructed a Date');
      },
    });
    vi.stubGlobal('Date', explode);
    vi.stubGlobal('Intl', undefined);
    let actual = '';
    try {
      actual = JSON.stringify(plan(input));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(actual).toBe(expected);
  });

  it('warning messages use the same number formatting whatever the default locale', () => {
    // Messages are built by hand ("S$15,300", "11.5%", "31 December 2026"), never via toLocaleString.
    const r = plan({ ...defaultInput('2026-12-20'), preferences: { ...defaultInput('2026-12-20').preferences, cashBudget: 12_345 } });
    const budget = r.warnings.find((w) => w.code === 'BUDGET_LIMITS_PLAN');
    expect(budget?.message).toContain('S$12,345');
    // X = 12,345 -> CI 96,255 -> tax 3,350 + 1,869.325 = 5,219.33 (half-up). With more cash the schemes fill up
    // at 23,300 (tax 3,959.50), so the sentence quotes 5,219.33 - 3,959.50 = 1,259.83 (SPEC §6.11) — not
    // unrealisedSaving (5,219.33 - 1,600.00 = 3,619.33), which no amount of cash can deliver.
    expect(r.plan.unrealisedSaving).toBe(3_619.33);
    expect(budget?.message).toContain('S$1,259.83');
    expect(budget?.message).not.toContain('S$3,619.33');
    const soon = r.warnings.find((w) => w.code === 'DEADLINE_SOON');
    expect(soon?.message).toContain('11 days');
    expect(soon?.message).toContain('31 December 2026');
  });

  it('day counts agree with the UTC calendar for every day from 2023 to 2029 (leap years 2024 and 2028)', () => {
    const base = defaultInput('2026-11-13');
    const pad = (n: number): string => String(n).padStart(2, '0');
    for (const incomeYear of SUPPORTED_INCOME_YEARS) {
      const deadline = Date.UTC(incomeYear, 11, 31);
      for (let t = Date.UTC(2023, 0, 1); t <= Date.UTC(2029, 11, 31); t += 86_400_000) {
        const d = new Date(t);
        const today = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
        const r = plan({ ...base, incomeYear, today, levers: { srs: { enabled: false }, cpfSelf: { enabled: false }, cpfFamily: { enabled: false } } });
        const expectedDays = Math.round((deadline - t) / 86_400_000);
        const expectedMonths = d.getUTCFullYear() < incomeYear ? 12 : d.getUTCFullYear() > incomeYear ? 0 : 12 - d.getUTCMonth();
        if (r.input.today !== today || r.monthlyPlan.daysToDeadline !== expectedDays || r.monthlyPlan.monthsRemaining !== expectedMonths) {
          throw new Error(`calendar mismatch for today ${today}, income year ${incomeYear}: ${JSON.stringify(r.monthlyPlan)}`);
        }
      }
    }
  });

  it('29 February exists only in leap years; impossible dates fall back to 1 January of the income year', () => {
    const base = defaultInput('2026-11-13');
    expect(plan({ ...base, incomeYear: 2025, today: '2024-02-29' }).input.today).toBe('2024-02-29');
    expect(plan({ ...base, incomeYear: 2027, today: '2028-02-29' }).input.today).toBe('2028-02-29');
    expect(plan({ ...base, today: '2026-02-29' }).input.today).toBe('2026-01-01');
    expect(plan({ ...base, today: '2026-04-31' }).input.today).toBe('2026-01-01');
    expect(plan({ ...base, today: '2026-00-10' }).input.today).toBe('2026-01-01');
    expect(plan({ ...base, today: '2026-12-00' }).input.today).toBe('2026-01-01');
    expect(plan({ ...base, today: '2026-12-32' }).input.today).toBe('2026-01-01');
    // A full ISO timestamp keeps its leading calendar date exactly as written (no time-zone shift).
    expect(plan({ ...base, today: '2026-12-31T23:59:59.999-12:00' }).input.today).toBe('2026-12-31');
    expect(plan({ ...base, today: '2026-01-01T00:00:00+14:00' }).input.today).toBe('2026-01-01');
  });
});

describe('very large inputs (SPEC §6.0: money is clamped to S$10,000,000,000 so integer arithmetic stays exact)', () => {
  const huge = (value: number): PlannerInput => ({
    incomeYear: 2026,
    today: '2026-06-15',
    profile: { residency: 'citizen', prYear: 3, ageAtYearEnd: 40, birthMonth: 12 },
    income: {
      monthlyOrdinaryWage: value,
      monthsWorked: 12,
      additionalWages: value,
      otherTaxableIncome: value,
      employmentExpenses: 0,
      donations: value,
      employeeCpfOverride: null,
    },
    existing: { srs: value, cpfTopUpSelf: value, cpfTopUpFamily: value },
    otherReliefs: value,
    levers: { srs: { enabled: true }, cpfSelf: { enabled: true, roomToLimit: value }, cpfFamily: { enabled: true, maxAmount: value } },
    preferences: { cashBudget: value, minSavingRate: 0, priority: ['srs', 'cpfSelf', 'cpfFamily'], simulatorStep: value },
  });

  it('S$10 billion everywhere: exact against BigInt arithmetic', () => {
    // Income 12 x 1e10 + 1e10 + 1e10 = 1.4e11. Donations 1e10 -> deduction 2.5e10. Assessable 1.15e11.
    // Reliefs far above the cap -> 80,000 allowed. CI = 114,999,920,000.
    // Tax = 199,150 + 24% x (114,999,920,000 - 1,000,000) = 199,150 + 27,599,740,800 = 27,599,939,950.00.
    const r = plan(huge(10_000_000_000));
    const ci = 115_000_000_000n - 80_000n;
    const taxCents = 19_915_000n + ((ci - 1_000_000n) * 240n + 5n) / 10n;
    expect(r.baseline.totalIncome).toBe(140_000_000_000);
    expect(r.baseline.donationDeduction).toBe(25_000_000_000);
    expect(r.baseline.assessableIncome).toBe(115_000_000_000);
    expect(r.baseline.reliefs.totalAllowed).toBe(80_000);
    expect(r.baseline.reliefs.srs).toBe(15_300);
    expect(r.baseline.reliefs.cpfTopUpSelf).toBe(8_000);
    expect(r.baseline.reliefs.lostToCap).toBe(r.baseline.reliefs.totalBeforeCap - 80_000);
    expect(BigInt(r.baseline.chargeableIncome)).toBe(ci);
    expect(r.baseline.taxPayable).toBe(Number(taxCents) / 100);
    expect(r.baseline.taxPayable).toBe(27_599_939_950);
    expect(r.cpf.employeeContribution).toBe(20_400);
    expect(r.plan.totalContribution).toBe(0);
    expect(r.plan.bindingConstraint).toBe('reliefCap');
  });

  it('values beyond the clamp (1e15, 2^53, 1e300, MAX_VALUE) behave exactly like S$10 billion', () => {
    const reference = plan(huge(10_000_000_000));
    for (const value of [10_000_000_001, 1e15, 2 ** 53, 2 ** 53 + 2, 1e300, Number.MAX_VALUE]) {
      const r = plan(huge(value));
      expect(r.baseline).toEqual(reference.baseline);
      expect(r.plan).toEqual(reference.plan);
      expect(r.input.income.monthlyOrdinaryWage).toBe(10_000_000_000);
      expect(r.input.preferences.cashBudget).toBe(10_000_000_000);
    }
  });

  it('a very high earner with room to plan: every figure stays a whole dollar or a whole cent', () => {
    const input = huge(9_999_999_999);
    input.existing = { srs: 0, cpfTopUpSelf: 0, cpfTopUpFamily: 0 };
    input.otherReliefs = 0;
    input.income.donations = 3; // deduction 7.50
    input.preferences.cashBudget = null;
    input.preferences.simulatorStep = 1_000;
    const r = plan(input);
    // Income 14 x 9,999,999,999 = 139,999,999,986. Assessable 139,999,999,978.50. Reliefs 1,000 + 20,400.
    // CI = floor(139,999,978,578.5) = 139,999,978,578.
    expect(r.baseline.assessableIncome).toBe(139_999_999_978.5);
    expect(r.baseline.chargeableIncome).toBe(139_999_978_578);
    const taxCents = 19_915_000n + ((139_999_978_578n - 1_000_000n) * 240n + 5n) / 10n;
    expect(r.baseline.taxPayable).toBe(Number(taxCents) / 100);
    // 31,300 of lever room at 24% = 7,512.00.
    expect(r.plan.totalContribution).toBe(31_300);
    expect(r.plan.taxSaved).toBe(7_512);
    expect(r.plan.savingRate).toBe(0.24);
    for (const row of r.simulator) {
      expect(Number.isInteger(Math.round(row.taxPayable * 100))).toBe(true);
      expect(Math.abs(row.taxPayable * 100 - Math.round(row.taxPayable * 100))).toBeLessThan(1e-3);
    }
    expect(r.simulator[1]).toMatchObject({ stepSaving: 240, stepRate: 0.24 });
  });

  it('every number in every result is finite and never negative zero', () => {
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`${path} is ${value}`);
        if (Object.is(value, -0)) throw new Error(`${path} is -0`);
      } else if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
      }
    };
    const inputs = [...profiles(), huge(10_000_000_000), huge(0), huge(-5), huge(Number.NaN), huge(Number.POSITIVE_INFINITY), huge(0.5)];
    for (const input of inputs) {
      const { rules: _rules, ...rest } = plan(input);
      walk(rest, 'result');
      walk(evaluate(input, { srs: -0, cpfSelf: Number.NaN, cpfFamily: 1e300 }), 'evaluate');
    }
  });

  it('non-finite limits are a limit of zero, not "no limit" (SPEC §6.0) — Infinity must not be used for "no budget"', () => {
    const r = plan({ ...defaultInput('2026-06-15'), preferences: { ...defaultInput('2026-06-15').preferences, cashBudget: Number.POSITIVE_INFINITY } });
    expect(r.input.preferences.cashBudget).toBe(0);
    expect(r.plan.totalContribution).toBe(0);
    expect(r.plan.bindingConstraint).toBe('cashBudget');
  });
});

describe('floating-point exposure in the money path', () => {
  it('products that are inexact in binary floating point come out exact', () => {
    const rules = getRules(2026);
    // 0.115 x 3 = 0.34500000000000003 in doubles; 0.07 x 3 = 0.21000000000000002; 0.035 x 3 = 0.10500000000000001.
    expect(grossTax(80_003, rules)).toBe(3_350.35); // 3,350 + 0.345 -> 0.35 (half-up at the mill)
    expect(grossTax(40_003, rules)).toBe(550.21);
    expect(grossTax(30_003, rules)).toBe(200.11); // 0.105 -> 0.11 half-up
    expect(grossTax(30_001, rules)).toBe(200.04); // 0.035 -> 0.04
    expect(grossTax(240_001, rules)).toBe(28_750.2); // 0.195 -> 0.20
    expect(grossTax(240_003, rules)).toBe(28_750.59); // 0.585 -> 0.59
    expect(grossTax(80_001, rules)).toBe(3_350.12); // 0.115 -> 0.12
    expect(grossTax(80_005, rules)).toBe(3_350.58); // 0.575 -> 0.58
  });

  it('tax is rounded once: the sum over brackets is not the sum of separately rounded brackets', () => {
    // CI 240,001: 28,750 + 0.195 = 28,750.195 -> 28,750.20. (Rounding per bracket would give the same here, so
    // also take a case where a per-dollar rounding would drift: 1,000 single dollars at 11.5% = 115.00, not 120.00.)
    const rules = getRules(2026);
    expect(grossTax(81_000, rules) - grossTax(80_000, rules)).toBe(115);
  });

  it('CPF: rate x wage products that fall just below an integer in doubles are not floored one dollar low', () => {
    const rules27 = getRules(2027);
    const person = (age: number, ow: number, aw = 0): PlannerInput => ({
      ...defaultInput('2027-06-15'),
      incomeYear: 2027,
      profile: { residency: 'citizen', prYear: 3, ageAtYearEnd: age, birthMonth: 12 },
      income: { monthlyOrdinaryWage: ow, monthsWorked: 12, additionalWages: aw, otherTaxableIncome: 0, employmentExpenses: 0, donations: 0, employeeCpfOverride: null },
    });
    // The only inexact floor(rate x dollars) products in the whole CPF domain (every rate and phase-in factor,
    // every wage up to 102,000) are the 2027 "above 55 to 60" phase-in factor 0.57 at S$600 and S$700:
    // 0.57 x 100 = 56.99999999999999 and 0.57 x 200 = 113.99999999999999 in doubles (exactly 57 and 114).
    expect(0.57 * 100).toBeLessThan(57);
    expect(0.57 * 200).toBeLessThan(114);
    expect(computeCpf(person(58, 600), rules27).employeeContribution).toBe(57 * 12);
    expect(computeCpf(person(58, 700), rules27).employeeContribution).toBe(114 * 12);
    // Turning 55 in June 2027 on S$700: Jan–Jun factor 0.6 -> 120; Jul–Dec factor 0.57 -> 114. Bonus 2,300 at 19% = 437.
    const turning = person(55, 700, 2_300);
    turning.profile.birthMonth = 6;
    expect(computeCpf(turning, rules27).employeeContribution).toBe(120 * 6 + 114 * 6 + 437);
    // 13% x 2,300 = 299 on a bonus paid on top of a nil-band wage.
    expect(computeCpf(person(62, 400, 2_300), rules27).employeeContribution).toBe(299);
  });

  it('donation deductions are exact to the cent for every amount (x 2.5 never drifts)', () => {
    const base = defaultInput('2026-06-15');
    // Opening example: income 135,000, reliefs 26,400.
    for (const donations of [1, 3, 7, 33, 101, 999, 1_001, 12_345, 43_439, 43_440, 43_441, 53_999, 54_000, 54_001, 99_999]) {
      const r = evaluate({ ...base, income: { ...base.income, donations } }, { srs: 0, cpfSelf: 0, cpfFamily: 0 });
      const assessableHalves = Math.max(0, 135_000 * 2 - donations * 5); // in half-dollars
      expect(r.donationDeduction * 2).toBe(donations * 5);
      expect(r.assessableIncome * 2).toBe(assessableHalves);
      expect(r.chargeableIncome).toBe(Math.max(0, Math.floor((assessableHalves - 26_400 * 2) / 2)));
    }
  });

  it('taxSaved, unrealised saving, ladder and simulator differences are clean two-decimal numbers', () => {
    // 6,639.00 - 3,959.50 etc. are exact here; pick a case where a naive float subtraction is not:
    // 0.3 - 0.1 style: tax 204.38 - 200 = 4.38 (4.3799999999999955 in doubles).
    expect(204.38 - 200).not.toBe(4.38);
    const input = defaultInput('2026-06-15');
    input.profile = { residency: 'citizen', prYear: 3, ageAtYearEnd: 70, birthMonth: 11 };
    input.income.monthlyOrdinaryWage = 3_000;
    input.income.additionalWages = 5_000;
    input.otherReliefs = 0;
    input.preferences.minSavingRate = 0.035;
    input.preferences.simulatorStep = 125;
    const r = plan(input);
    expect(r.plan.taxSaved).toBe(4.38);
    expect(r.ladder[0]?.taxSaved).toBe(4.38);
    expect(r.simulator[1]?.taxSaved).toBe(4.38);
    expect(r.simulator[1]?.stepSaving).toBe(4.38);
    expect(r.scenarios.find((s) => s.id === 'recommended')?.taxSaved).toBe(4.38);
  });
});

describe('export surface (SPEC §7)', () => {
  it('exactly the documented runtime exports', () => {
    expect(Object.keys(engine).sort()).toEqual(
      ['SUPPORTED_INCOME_YEARS', 'computeCpf', 'defaultIncomeYear', 'defaultInput', 'evaluate', 'getRules', 'grossTax', 'marginalRate', 'plan', 'sanitiseInput'].sort(),
    );
  });

  it('documented arities', () => {
    expect(plan.length).toBe(1);
    expect(evaluate.length).toBe(2);
    expect(computeCpf.length).toBe(2);
    expect(grossTax.length).toBe(2);
    expect(marginalRate.length).toBe(2);
    expect(sanitiseInput.length).toBe(1);
    expect(getRules.length).toBe(1);
    expect(defaultIncomeYear.length).toBe(1);
    expect(defaultInput.length).toBe(1);
    expect(Array.isArray(SUPPORTED_INCOME_YEARS)).toBe(true);
  });

  it('PlannerResult has exactly the documented top-level fields', () => {
    const r: PlannerResult = plan(defaultInput('2026-11-13'));
    expect(Object.keys(r).sort()).toEqual(
      ['rules', 'input', 'cpf', 'baseline', 'optimised', 'levers', 'reliefCapRoom', 'plan', 'ladder', 'simulator', 'scenarios', 'monthlyPlan', 'warnings'].sort(),
    );
    expect(Object.keys(r.plan).sort()).toEqual(
      ['contributions', 'totalContribution', 'taxBefore', 'taxAfter', 'taxSaved', 'savingRate', 'chargeableIncomeBefore', 'chargeableIncomeAfter', 'marginalRateBefore', 'marginalRateAfter', 'bindingConstraint', 'unrealisedSaving'].sort(),
    );
    expect(Object.keys(r.baseline).sort()).toEqual(
      ['employmentIncome', 'employmentExpenses', 'otherTaxableIncome', 'totalIncome', 'donationDeduction', 'assessableIncome', 'reliefs', 'chargeableIncome', 'grossTax', 'pitRebate', 'taxPayable', 'marginalRate', 'effectiveRate'].sort(),
    );
    expect(Object.keys(r.cpf).sort()).toEqual(
      ['source', 'ordinaryWagesSubject', 'additionalWageCeiling', 'additionalWagesSubject', 'employeeContribution', 'employerContribution', 'monthlyEmployeeRates'].sort(),
    );
    expect(Object.keys(r.monthlyPlan).sort()).toEqual(['deadline', 'daysToDeadline', 'monthsRemaining', 'schedule', 'fullYearMonthly'].sort());
    expect(r.rules).toBe(getRules(2026));
  });

  it('getRules throws for unsupported years and for things that are not years', () => {
    for (const bad of [2024, 2028, 2026.5, -2026, 0, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, 'next year']) {
      expect(() => getRules(bad as number)).toThrow(RangeError);
    }
  });

  it('getRules never returns something that is not a rule set (inherited object keys are not income years)', () => {
    // SPEC §7: "throws for unsupported years". A lookup table that is a plain object answers 'constructor',
    // 'toString' or '__proto__' with members of Object.prototype instead of throwing.
    for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      let returned: unknown;
      let threw = false;
      try {
        returned = getRules(bad as unknown as number);
      } catch (error) {
        threw = true;
        expect(error).toBeInstanceOf(RangeError);
      }
      expect({ key: bad, threw, returnedType: typeof returned }).toEqual({ key: bad, threw: true, returnedType: 'undefined' });
    }
  });

  it('defaultInput(today) is the SPEC §7 example for each supported year and plans to Appendix A.1 in 2026', () => {
    for (const year of [2025, 2026, 2027]) {
      const input = defaultInput(`${year}-03-03`);
      expect(input.incomeYear).toBe(year);
      expect(input.today).toBe(`${year}-03-03`);
      expect(input.profile).toMatchObject({ residency: 'citizen', ageAtYearEnd: 35 });
      expect(input.income).toMatchObject({ monthlyOrdinaryWage: 10_000, additionalWages: 15_000 });
      expect(input.income.monthlyOrdinaryWage * (input.income.monthsWorked ?? 12)).toBe(120_000);
      expect(input.otherReliefs).toBe(5_000);
      expect(input.existing).toEqual({ srs: 0, cpfTopUpSelf: 0, cpfTopUpFamily: 0 });
      expect([input.levers.srs.enabled, input.levers.cpfSelf.enabled, input.levers.cpfFamily.enabled]).toEqual([true, true, false]);
      expect(input.preferences.cashBudget ?? null).toBeNull();
    }
    const r = plan(defaultInput('2026-11-13'));
    expect(r.plan).toMatchObject({ totalContribution: 23_300, taxBefore: 6_639, taxAfter: 3_959.5, taxSaved: 2_679.5, bindingConstraint: 'leverLimits', unrealisedSaving: 2_359.5 });
  });
});
