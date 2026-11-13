/**
 * SPEC §6.10 — the monthly plan and its date arithmetic (pure: `today` is an input, the clock is never read).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultInput, getRules, plan } from '../../src/engine';
import type { PlannerInput } from '../../src/engine';
import { daysBetween, parseIsoDate } from '../../src/engine/dates';
import { buildMonthlyPlan } from '../../src/engine/monthlyPlan';

/** The opening example (plan: SRS 15,300 + CPF self 8,000) for income year 2026, as seen on `today`. */
function on(today: string, incomeYear = 2026): PlannerInput {
  return { ...defaultInput('2026-06-30'), incomeYear, today };
}

const RULES_2026 = getRules(2026);
const PLAN = { srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 };

describe('date arithmetic', () => {
  it('parses real calendar dates only', () => {
    expect(parseIsoDate('2026-11-13')).toEqual({ year: 2026, month: 11, day: 13 });
    expect(parseIsoDate('2026-11-13T09:30:00+08:00')).toEqual({ year: 2026, month: 11, day: 13 });
    expect(parseIsoDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 }); // leap year
    expect(parseIsoDate('2026-02-29')).toBeNull();
    expect(parseIsoDate('2100-02-29')).toBeNull(); // century, not a leap year
    expect(parseIsoDate('2000-02-29')).toEqual({ year: 2000, month: 2, day: 29 }); // divisible by 400
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('2026-00-10')).toBeNull();
    expect(parseIsoDate('2026-04-31')).toBeNull();
    expect(parseIsoDate('2026-11-00')).toBeNull();
    expect(parseIsoDate('2026-11-131')).toBeNull();
    expect(parseIsoDate('13/11/2026')).toBeNull();
    expect(parseIsoDate('')).toBeNull();
    expect(parseIsoDate(undefined)).toBeNull();
    expect(parseIsoDate(20261113)).toBeNull();
  });

  const days = (from: string, to: string): number => {
    const a = parseIsoDate(from);
    const b = parseIsoDate(to);
    if (!a || !b) throw new Error('bad test date');
    return daysBetween(a, b);
  };

  it('counts whole days between dates', () => {
    expect(days('2026-12-31', '2026-12-31')).toBe(0);
    expect(days('2026-12-30', '2026-12-31')).toBe(1);
    expect(days('2026-11-13', '2026-12-31')).toBe(48); // 17 + 31
    expect(days('2026-01-01', '2026-12-31')).toBe(364);
    expect(days('2025-12-31', '2026-12-31')).toBe(365);
    expect(days('2027-12-31', '2028-12-31')).toBe(366); // 2028 is a leap year
    expect(days('2024-02-28', '2024-03-01')).toBe(2); // across 29 February 2024
    expect(days('2025-02-28', '2025-03-01')).toBe(1);
    expect(days('2027-01-01', '2026-12-31')).toBe(-1);
    expect(days('2000-01-01', '2026-12-31')).toBe(9_861); // 27 years x 365 + 7 leap days - 1
  });
});

describe('monthsRemaining and daysToDeadline', () => {
  it.each([
    // [today, days to 2026-12-31, months remaining]
    ['2026-01-01', 364, 12],
    ['2026-01-31', 334, 12],
    ['2026-02-01', 333, 11],
    ['2026-06-30', 184, 7],
    ['2026-10-05', 87, 3],
    ['2026-11-13', 48, 2],
    ['2026-11-30', 31, 2],
    ['2026-12-01', 30, 1],
    ['2026-12-31', 0, 1],
  ])('on %s: %i days and %i months left', (today, daysToDeadline, monthsRemaining) => {
    const { monthlyPlan } = plan(on(today));
    expect(monthlyPlan.deadline).toBe('2026-12-31');
    expect(monthlyPlan.daysToDeadline).toBe(daysToDeadline);
    expect(monthlyPlan.monthsRemaining).toBe(monthsRemaining);
    expect(monthlyPlan.schedule).toHaveLength(monthsRemaining);
  });

  it('before the income year starts: all 12 months, counting days across the year end', () => {
    const { monthlyPlan } = plan(on('2025-12-20'));
    expect(monthlyPlan.daysToDeadline).toBe(376); // 11 days left in 2025 + 365
    expect(monthlyPlan.monthsRemaining).toBe(12);
    expect(monthlyPlan.schedule.map((row) => row.month)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
  });

  it('after the income year: the deadline has passed, nothing is scheduled', () => {
    const newYear = plan(on('2027-01-01'));
    expect(newYear.monthlyPlan.daysToDeadline).toBe(-1);
    expect(newYear.monthlyPlan.monthsRemaining).toBe(0);
    expect(newYear.monthlyPlan.schedule).toEqual([]);
    // the plan itself and the "start in January" figures are still reported
    expect(newYear.plan.totalContribution).toBe(23_300);
    expect(newYear.monthlyPlan.fullYearMonthly).toEqual({ srs: 1_275, cpfSelf: 667, cpfFamily: 0, total: 1_942 });

    const march = plan(on('2027-03-15'));
    expect(march.monthlyPlan.daysToDeadline).toBe(-74); // 31 + 28 + 15
    expect(march.monthlyPlan.monthsRemaining).toBe(0);
  });

  it('uses each income year\'s own deadline', () => {
    expect(plan(on('2025-11-13', 2025)).monthlyPlan).toMatchObject({ deadline: '2025-12-31', daysToDeadline: 48, monthsRemaining: 2 });
    expect(plan(on('2027-11-13', 2027)).monthlyPlan).toMatchObject({ deadline: '2027-12-31', daysToDeadline: 48, monthsRemaining: 2 });
    // a leap day in between: 2024-02-28 -> 2024-12-31 is 307 days, plus 365
    expect(plan(on('2024-02-28', 2025)).monthlyPlan).toMatchObject({ daysToDeadline: 672, monthsRemaining: 12 });
  });

  it('ignores a time-of-day suffix on today', () => {
    const result = plan(on('2026-11-13T23:59:59+08:00'));
    expect(result.input.today).toBe('2026-11-13');
    expect(result.monthlyPlan.daysToDeadline).toBe(48);
  });
});

describe('schedule', () => {
  it('whole-dollar instalments that sum exactly, the earlier months taking the odd dollars', () => {
    // 3 months (October to December): 15,300 = 5,100 x 3; 8,000 = 2,667 + 2,667 + 2,666
    expect(buildMonthlyPlan('2026-10-05', RULES_2026, PLAN).schedule).toEqual([
      { month: '2026-10', amounts: { srs: 5_100, cpfSelf: 2_667, cpfFamily: 0 }, total: 7_767 },
      { month: '2026-11', amounts: { srs: 5_100, cpfSelf: 2_667, cpfFamily: 0 }, total: 7_767 },
      { month: '2026-12', amounts: { srs: 5_100, cpfSelf: 2_666, cpfFamily: 0 }, total: 7_766 },
    ]);
  });

  it('12 months: 8,000 = 667 x 8 + 666 x 4', () => {
    const { schedule } = buildMonthlyPlan('2026-01-15', RULES_2026, PLAN);
    expect(schedule.map((row) => row.amounts.srs)).toEqual(new Array(12).fill(1_275));
    expect(schedule.map((row) => row.amounts.cpfSelf)).toEqual([667, 667, 667, 667, 667, 667, 667, 667, 666, 666, 666, 666]);
    expect(schedule.reduce((sum, row) => sum + row.total, 0)).toBe(23_300);
    expect(schedule[0]?.total).toBe(1_942);
    expect(schedule[11]?.total).toBe(1_941);
  });

  it('one month left: everything in December', () => {
    expect(buildMonthlyPlan('2026-12-31', RULES_2026, PLAN).schedule).toEqual([
      { month: '2026-12', amounts: { srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 }, total: 23_300 },
    ]);
  });

  it('amounts smaller than the number of months go to the first months only', () => {
    const { schedule, fullYearMonthly } = buildMonthlyPlan('2026-08-01', RULES_2026, { srs: 3, cpfSelf: 0, cpfFamily: 7 });
    // 5 months: 3 = 1 + 1 + 1 + 0 + 0; 7 = 2 + 2 + 1 + 1 + 1
    expect(schedule.map((row) => row.amounts.srs)).toEqual([1, 1, 1, 0, 0]);
    expect(schedule.map((row) => row.amounts.cpfFamily)).toEqual([2, 2, 1, 1, 1]);
    expect(schedule.map((row) => row.total)).toEqual([3, 3, 2, 1, 1]);
    expect(fullYearMonthly).toEqual({ srs: 1, cpfSelf: 0, cpfFamily: 1, total: 2 }); // ceil(3/12), ceil(7/12)
  });

  it.each(['2026-01-01', '2026-03-31', '2026-05-17', '2026-07-04', '2026-09-09', '2026-11-30'])(
    'on %s every lever sums to its planned amount',
    (today) => {
      const amounts = { srs: 15_299, cpfSelf: 7_919, cpfFamily: 1_001 };
      const { schedule, monthsRemaining } = buildMonthlyPlan(today, RULES_2026, amounts);
      expect(schedule).toHaveLength(monthsRemaining);
      for (const lever of ['srs', 'cpfSelf', 'cpfFamily'] as const) {
        const instalments = schedule.map((row) => row.amounts[lever]);
        expect(instalments.reduce((sum, value) => sum + value, 0)).toBe(amounts[lever]);
        expect(Math.max(...instalments) - Math.min(...instalments)).toBeLessThanOrEqual(1);
        expect([...instalments].sort((a, b) => b - a)).toEqual(instalments); // never increasing
      }
      expect(schedule[schedule.length - 1]?.month).toBe('2026-12');
      for (const row of schedule) {
        expect(row.total).toBe(row.amounts.srs + row.amounts.cpfSelf + row.amounts.cpfFamily);
      }
    },
  );

  it('nothing recommended: empty schedule, zero monthly figures, months still counted', () => {
    const monthlyPlan = buildMonthlyPlan('2026-11-13', RULES_2026, { srs: 0, cpfSelf: 0, cpfFamily: 0 });
    expect(monthlyPlan).toEqual({
      deadline: '2026-12-31',
      daysToDeadline: 48,
      monthsRemaining: 2,
      schedule: [],
      fullYearMonthly: { srs: 0, cpfSelf: 0, cpfFamily: 0, total: 0 },
    });
  });

  it('fullYearMonthly rounds each lever up to a whole dollar', () => {
    // ceil(10,300 / 12) = 859; ceil(8,000 / 12) = 667; ceil(1,700 / 12) = 142; ceil(12 / 12) = 1
    expect(buildMonthlyPlan('2026-11-13', RULES_2026, { srs: 10_300, cpfSelf: 8_000, cpfFamily: 1_700 }).fullYearMonthly).toEqual({
      srs: 859,
      cpfSelf: 667,
      cpfFamily: 142,
      total: 1_668,
    });
    expect(buildMonthlyPlan('2026-11-13', RULES_2026, { srs: 12, cpfSelf: 13, cpfFamily: 0 }).fullYearMonthly).toEqual({
      srs: 1,
      cpfSelf: 2,
      cpfFamily: 0,
      total: 3,
    });
  });
});

describe('the engine never reads the clock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the same answer whatever the system date is', () => {
    const input = on('2026-11-13');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-05-05T00:00:00Z'));
    const later = plan(input);
    vi.setSystemTime(new Date('2019-01-01T00:00:00Z'));
    const earlier = plan(input);
    expect(later).toEqual(earlier);
    expect(later.monthlyPlan.daysToDeadline).toBe(48);
  });

  it('an unreadable today is treated as 1 January of the income year', () => {
    for (const today of ['', 'tomorrow', '2026-02-30', '13/11/2026']) {
      const result = plan(on(today));
      expect(result.input.today).toBe('2026-01-01');
      expect(result.monthlyPlan.daysToDeadline).toBe(364);
      expect(result.monthlyPlan.monthsRemaining).toBe(12);
      expect(result.warnings.map((w) => w.code)).not.toContain('DEADLINE_PASSED');
    }
  });
});
