/**
 * SPEC §6.1 — compulsory employee CPF contribution: per-month age band, months worked, phase-in and nil
 * bands, ceilings, graduated PR rates, foreigners and the override.
 */
import { describe, expect, it } from 'vitest';
import { computeCpf, defaultInput, getRules, plan } from '../../src/engine';
import type { CpfComputation, PlannerInput } from '../../src/engine';

/** The opening example with the profile and income fields replaced; CPF under that income year's rules. */
function cpf(
  profile: Partial<PlannerInput['profile']>,
  income: Partial<PlannerInput['income']>,
  incomeYear = 2026,
): CpfComputation {
  const base = defaultInput(`${incomeYear}-06-30`);
  return computeCpf(
    {
      ...base,
      incomeYear,
      profile: { ...base.profile, ...profile },
      income: { ...base.income, additionalWages: 0, ...income },
    },
    getRules(incomeYear),
  );
}

const rates = (...runs: [count: number, rate: number][]): number[] =>
  runs.flatMap(([count, rate]) => new Array<number>(count).fill(rate));

describe('age band switching within the year', () => {
  it('turning 55 in June: 20% to June, 18% from July; the bonus takes the December rate', () => {
    const result = cpf({ ageAtYearEnd: 55, birthMonth: 6 }, { monthlyOrdinaryWage: 6_000, additionalWages: 12_000 });
    expect(result.monthlyEmployeeRates).toEqual(rates([6, 0.2], [6, 0.18]));
    expect(result.ordinaryWagesSubject).toBe(72_000);
    expect(result.additionalWageCeiling).toBe(30_000); // 102,000 - 72,000
    expect(result.additionalWagesSubject).toBe(12_000);
    // 1,200 x 6 + 1,080 x 6 + 18% x 12,000 = 7,200 + 6,480 + 2,160
    expect(result.employeeContribution).toBe(15_840);
    // 17% x 36,000 + 16% x 36,000 + 16% x 12,000 = 6,120 + 5,760 + 1,920
    expect(result.employerContribution).toBe(13_800);
  });

  it('turning 55 in December: 20% all year, bonus included', () => {
    const result = cpf({ ageAtYearEnd: 55, birthMonth: 12 }, { monthlyOrdinaryWage: 6_000, additionalWages: 12_000 });
    expect(result.monthlyEmployeeRates).toEqual(rates([12, 0.2]));
    expect(result.employeeContribution).toBe(16_800); // 1,200 x 12 + 20% x 12,000
  });

  it('turning 55 in January: 20% for January only', () => {
    const result = cpf({ ageAtYearEnd: 55, birthMonth: 1 }, { monthlyOrdinaryWage: 6_000, additionalWages: 12_000 });
    expect(result.monthlyEmployeeRates).toEqual(rates([1, 0.2], [11, 0.18]));
    expect(result.employeeContribution).toBe(15_240); // 1,200 + 1,080 x 11 + 2,160
  });

  it('birth month defaults to December', () => {
    const result = cpf({ ageAtYearEnd: 55, birthMonth: undefined }, { monthlyOrdinaryWage: 6_000 });
    expect(result.monthlyEmployeeRates).toEqual(rates([12, 0.2]));
  });

  it('turning 60 in March: 18% to March, 12.5% from April', () => {
    const result = cpf({ ageAtYearEnd: 60, birthMonth: 3 }, { monthlyOrdinaryWage: 8_000 });
    expect(result.monthlyEmployeeRates).toEqual(rates([3, 0.18], [9, 0.125]));
    expect(result.employeeContribution).toBe(13_320); // 1,440 x 3 + 1,000 x 9
    expect(result.employerContribution).toBe(12_840); // 16% x 24,000 + 12.5% x 72,000
  });

  it('turning 60 with different birth months gives different totals', () => {
    const wage = { monthlyOrdinaryWage: 8_000 };
    // 1,440 x m + 1,000 x (12 - m)
    expect(cpf({ ageAtYearEnd: 60, birthMonth: 1 }, wage).employeeContribution).toBe(12_440);
    expect(cpf({ ageAtYearEnd: 60, birthMonth: 6 }, wage).employeeContribution).toBe(14_640);
    expect(cpf({ ageAtYearEnd: 60, birthMonth: 11 }, wage).employeeContribution).toBe(16_840);
    expect(cpf({ ageAtYearEnd: 60, birthMonth: 12 }, wage).employeeContribution).toBe(17_280);
  });

  it('turning 65 in September: 12.5% to September, 7.5% from October', () => {
    const result = cpf({ ageAtYearEnd: 65, birthMonth: 9 }, { monthlyOrdinaryWage: 5_000 });
    expect(result.monthlyEmployeeRates).toEqual(rates([9, 0.125], [3, 0.075]));
    expect(result.employeeContribution).toBe(6_750); // 625 x 9 + 375 x 3
  });

  it('turning 70 in June: 7.5% to June, 5% from July', () => {
    const result = cpf({ ageAtYearEnd: 70, birthMonth: 6 }, { monthlyOrdinaryWage: 4_000 });
    expect(result.monthlyEmployeeRates).toEqual(rates([6, 0.075], [6, 0.05]));
    expect(result.employeeContribution).toBe(3_000); // 300 x 6 + 200 x 6
  });

  it('ages that cross no boundary use one band whatever the birth month', () => {
    for (const birthMonth of [1, 6, 12]) {
      expect(cpf({ ageAtYearEnd: 54, birthMonth }, {}).monthlyEmployeeRates).toEqual(rates([12, 0.2]));
      expect(cpf({ ageAtYearEnd: 56, birthMonth }, {}).monthlyEmployeeRates).toEqual(rates([12, 0.18]));
      expect(cpf({ ageAtYearEnd: 61, birthMonth }, {}).monthlyEmployeeRates).toEqual(rates([12, 0.125]));
      expect(cpf({ ageAtYearEnd: 66, birthMonth }, {}).monthlyEmployeeRates).toEqual(rates([12, 0.075]));
      expect(cpf({ ageAtYearEnd: 71, birthMonth }, {}).monthlyEmployeeRates).toEqual(rates([12, 0.05]));
      expect(cpf({ ageAtYearEnd: 90, birthMonth }, {}).monthlyEmployeeRates).toEqual(rates([12, 0.05]));
    }
  });
});

describe('months worked', () => {
  it('fewer than 12 months: the last n months of the year', () => {
    const result = cpf({}, { monthlyOrdinaryWage: 10_000, monthsWorked: 5, additionalWages: 20_000 });
    expect(result.monthlyEmployeeRates).toEqual(rates([7, 0], [5, 0.2]));
    expect(result.ordinaryWagesSubject).toBe(40_000); // 8,000 x 5
    expect(result.additionalWageCeiling).toBe(62_000);
    expect(result.additionalWagesSubject).toBe(20_000);
    expect(result.employeeContribution).toBe(12_000); // 1,600 x 5 + 4,000
    expect(result.employerContribution).toBe(10_200); // 17% x 60,000
  });

  it('one month', () => {
    const result = cpf({}, { monthlyOrdinaryWage: 3_000, monthsWorked: 1 });
    expect(result.monthlyEmployeeRates).toEqual(rates([11, 0], [1, 0.2]));
    expect(result.employeeContribution).toBe(600);
  });

  it('months before the start are skipped even when the age band changes there', () => {
    // Turns 55 in June but only works October to December: every worked month is at 18%.
    const result = cpf({ ageAtYearEnd: 55, birthMonth: 6 }, { monthlyOrdinaryWage: 6_000, monthsWorked: 3 });
    expect(result.monthlyEmployeeRates).toEqual(rates([9, 0], [3, 0.18]));
    expect(result.employeeContribution).toBe(3_240); // 1,080 x 3
  });

  it('employment income counts only the months worked', () => {
    const base = defaultInput('2026-06-30');
    const result = plan({ ...base, income: { ...base.income, monthsWorked: 5, additionalWages: 20_000 } });
    expect(result.baseline.employmentIncome).toBe(70_000); // 10,000 x 5 + 20,000
    expect(result.baseline.reliefs.cpf).toBe(12_000);
  });
});

describe('low wages: nil band and phase-in', () => {
  it('up to S$500 a month: no employee share', () => {
    expect(cpf({}, { monthlyOrdinaryWage: 400 }).employeeContribution).toBe(0);
    expect(cpf({}, { monthlyOrdinaryWage: 500 }).employeeContribution).toBe(0);
  });

  it('the nil band still reports the wages and the (informational) employer share', () => {
    const result = cpf({}, { monthlyOrdinaryWage: 400 });
    expect(result.ordinaryWagesSubject).toBe(4_800);
    expect(result.monthlyEmployeeRates).toEqual(rates([12, 0.2]));
    expect(result.employerContribution).toBe(816); // 17% x 4,800
  });

  it('S$500 to S$750: 0.6 x (wage - 500) for 55 and below', () => {
    expect(cpf({}, { monthlyOrdinaryWage: 501 }).employeeContribution).toBe(0); // floor(0.6) x 12
    expect(cpf({}, { monthlyOrdinaryWage: 502 }).employeeContribution).toBe(12); // floor(1.2) x 12
    expect(cpf({}, { monthlyOrdinaryWage: 600 }).employeeContribution).toBe(720); // 60 x 12
    expect(cpf({}, { monthlyOrdinaryWage: 750 }).employeeContribution).toBe(1_800); // 150 x 12
  });

  it('the phase-in meets the full rate at S$750', () => {
    expect(cpf({}, { monthlyOrdinaryWage: 751 }).employeeContribution).toBe(1_800); // floor(150.2) x 12
    expect(cpf({}, { monthlyOrdinaryWage: 760 }).employeeContribution).toBe(1_824); // 152 x 12
  });

  it('the phase-in factor follows the age band', () => {
    // above 55 to 60 in 2026: factor 0.54 -> floor(0.54 x 150) = 81 a month
    expect(cpf({ ageAtYearEnd: 58 }, { monthlyOrdinaryWage: 650 }).employeeContribution).toBe(972);
    // above 60 to 65 in 2025: factor 0.345 -> floor(0.345 x 200) = 69 a month
    expect(cpf({ ageAtYearEnd: 63 }, { monthlyOrdinaryWage: 700 }, 2025).employeeContribution).toBe(828);
    // 1st-year PR: factor 0.15 -> floor(0.15 x 200) = 30 a month
    expect(cpf({ residency: 'pr', prYear: 1 }, { monthlyOrdinaryWage: 700 }).employeeContribution).toBe(360);
  });

  it('is exact where binary floating point is not (0.57 x 100 = 56.99999999999999)', () => {
    // above 55 to 60 in 2027: factor 0.57 -> 57 a month, not 56
    expect(cpf({ ageAtYearEnd: 58 }, { monthlyOrdinaryWage: 600 }, 2027).employeeContribution).toBe(684);
    // 0.57 x 150 = 85.5 -> 85 a month
    expect(cpf({ ageAtYearEnd: 58 }, { monthlyOrdinaryWage: 650 }, 2027).employeeContribution).toBe(1_020);
  });

  it('additional wages attract the full rate even when the monthly wage is in the nil band', () => {
    const result = cpf({}, { monthlyOrdinaryWage: 400, additionalWages: 1_000 });
    expect(result.employeeContribution).toBe(200); // 0 on ordinary wages + 20% x 1,000
  });

  it('the phase-in changes with the age band during the year', () => {
    // Turns 55 in June on S$700 a month: 0.6 x 200 = 120 for 6 months, then 0.54 x 200 = 108 for 6 months.
    const result = cpf({ ageAtYearEnd: 55, birthMonth: 6 }, { monthlyOrdinaryWage: 700 });
    expect(result.employeeContribution).toBe(1_368);
  });
});

describe('wage ceilings', () => {
  it('ordinary wages are capped at the monthly ceiling: 8,000 in 2026 and 2027, 7,400 in 2025', () => {
    expect(cpf({}, { monthlyOrdinaryWage: 9_000 }, 2026).employeeContribution).toBe(19_200); // 1,600 x 12
    expect(cpf({}, { monthlyOrdinaryWage: 9_000 }, 2027).employeeContribution).toBe(19_200);
    expect(cpf({}, { monthlyOrdinaryWage: 9_000 }, 2025).employeeContribution).toBe(17_760); // 1,480 x 12
    expect(cpf({}, { monthlyOrdinaryWage: 9_000 }, 2025).ordinaryWagesSubject).toBe(88_800);
  });

  it('additional wages are capped at 102,000 less the ordinary wages subject to CPF', () => {
    const result = cpf({}, { monthlyOrdinaryWage: 5_000, additionalWages: 80_000 });
    expect(result.ordinaryWagesSubject).toBe(60_000);
    expect(result.additionalWageCeiling).toBe(42_000);
    expect(result.additionalWagesSubject).toBe(42_000);
    expect(result.employeeContribution).toBe(20_400); // 12,000 + 8,400
  });

  it('additional wages below the ceiling are fully subject', () => {
    const result = cpf({}, { monthlyOrdinaryWage: 5_000, additionalWages: 7_777 });
    expect(result.additionalWagesSubject).toBe(7_777);
    expect(result.employeeContribution).toBe(13_555); // 12,000 + floor(1,555.4)
  });

  it('the employee share drops the cents each month', () => {
    // 20% x 3,333 = 666.60 -> 666 a month
    expect(cpf({}, { monthlyOrdinaryWage: 3_333 }).employeeContribution).toBe(7_992);
  });

  it('the employer total is rounded to the nearest dollar, halves up', () => {
    // 2025, above 55 to 60, one month at S$900: employee floor(17% x 900) = 153; employer 15.5% x 900 = 139.50 -> 140
    const result = cpf({ ageAtYearEnd: 58 }, { monthlyOrdinaryWage: 900, monthsWorked: 1 }, 2025);
    expect(result.employeeContribution).toBe(153);
    expect(result.employerContribution).toBe(140);
  });
});

describe('rates by income year (55-and-below band unchanged; older bands rising)', () => {
  it.each([
    // [year, age, monthly employee share on a wage at or above the ceiling x 12]
    [2025, 40, 17_760], // 20% x 7,400 = 1,480
    [2025, 58, 15_096], // 17% x 7,400 = 1,258
    [2025, 63, 10_212], // 11.5% x 7,400 = 851
    [2025, 68, 6_660], // 7.5% x 7,400 = 555
    [2025, 72, 4_440], // 5% x 7,400 = 370
    [2026, 40, 19_200], // 20% x 8,000 = 1,600
    [2026, 58, 17_280], // 18% x 8,000 = 1,440
    [2026, 63, 12_000], // 12.5% x 8,000 = 1,000
    [2026, 68, 7_200], // 7.5% x 8,000 = 600
    [2026, 72, 4_800], // 5% x 8,000 = 400
    [2027, 40, 19_200],
    [2027, 58, 18_240], // 19% x 8,000 = 1,520
    [2027, 63, 12_480], // 13% x 8,000 = 1,040
    [2027, 68, 7_200],
    [2027, 72, 4_800],
  ])('income year %i, age %i: %i a year', (year, ageAtYearEnd, expected) => {
    expect(cpf({ ageAtYearEnd }, { monthlyOrdinaryWage: 10_000 }, year).employeeContribution).toBe(expected);
  });
});

describe('permanent residents on graduated rates', () => {
  const income = { monthlyOrdinaryWage: 6_000, additionalWages: 10_000 };

  it('1st year: 5% at every age', () => {
    const result = cpf({ residency: 'pr', prYear: 1 }, income);
    expect(result.monthlyEmployeeRates).toEqual(rates([12, 0.05]));
    expect(result.employeeContribution).toBe(4_100); // 300 x 12 + 500
    expect(result.employerContribution).toBe(3_280); // 4% x 82,000
    expect(cpf({ residency: 'pr', prYear: 1, ageAtYearEnd: 58 }, income).employeeContribution).toBe(4_100);
    expect(cpf({ residency: 'pr', prYear: 1, ageAtYearEnd: 68 }, income).employeeContribution).toBe(4_100);
  });

  it('2nd year: 15% (55 and below), 12.5%, 7.5%, 5%', () => {
    const young = cpf({ residency: 'pr', prYear: 2 }, income);
    expect(young.employeeContribution).toBe(12_300); // 900 x 12 + 1,500
    expect(young.employerContribution).toBe(7_380); // 9% x 82,000
    expect(cpf({ residency: 'pr', prYear: 2, ageAtYearEnd: 58 }, income).employeeContribution).toBe(10_250); // 750 x 12 + 1,250
    expect(cpf({ residency: 'pr', prYear: 2, ageAtYearEnd: 63 }, income).employeeContribution).toBe(6_150); // 450 x 12 + 750
    expect(cpf({ residency: 'pr', prYear: 2, ageAtYearEnd: 68 }, income).employeeContribution).toBe(4_100); // 300 x 12 + 500
  });

  it('2nd year: the band still switches the month after the 55th birthday', () => {
    const result = cpf({ residency: 'pr', prYear: 2, ageAtYearEnd: 55, birthMonth: 4 }, { monthlyOrdinaryWage: 6_000 });
    expect(result.monthlyEmployeeRates).toEqual(rates([4, 0.15], [8, 0.125]));
    expect(result.employeeContribution).toBe(9_600); // 900 x 4 + 750 x 8
  });

  it('3rd year onwards (and the default): full rates', () => {
    expect(cpf({ residency: 'pr', prYear: 3 }, income).employeeContribution).toBe(16_400); // 1,200 x 12 + 2,000
    expect(cpf({ residency: 'pr', prYear: undefined }, income).employeeContribution).toBe(16_400);
  });

  it('the PR year is ignored for citizens', () => {
    expect(cpf({ residency: 'citizen', prYear: 1 }, income).employeeContribution).toBe(16_400);
  });
});

describe('foreigners', () => {
  it('make no CPF contributions', () => {
    const result = cpf({ residency: 'foreigner' }, { monthlyOrdinaryWage: 12_000, additionalWages: 30_000 });
    expect(result).toEqual({
      source: 'none',
      ordinaryWagesSubject: 0,
      additionalWageCeiling: 0,
      additionalWagesSubject: 0,
      employeeContribution: 0,
      employerContribution: 0,
      monthlyEmployeeRates: rates([12, 0]),
    });
  });

  it('ignore the override', () => {
    const result = cpf({ residency: 'foreigner' }, { monthlyOrdinaryWage: 12_000, employeeCpfOverride: 9_000 });
    expect(result.source).toBe('none');
    expect(result.employeeContribution).toBe(0);
  });
});

describe('override', () => {
  const income = { monthlyOrdinaryWage: 10_000, additionalWages: 15_000 };

  it('replaces the calculated contribution and keeps the wage breakdown', () => {
    const result = cpf({}, { ...income, employeeCpfOverride: 15_000 });
    expect(result).toEqual({
      source: 'override',
      ordinaryWagesSubject: 96_000,
      additionalWageCeiling: 6_000,
      additionalWagesSubject: 6_000,
      employeeContribution: 15_000,
      employerContribution: 0,
      monthlyEmployeeRates: rates([12, 0.2]),
    });
  });

  it('is limited to the maximum compulsory contribution, 20% x 102,000 = 20,400', () => {
    expect(cpf({}, { ...income, employeeCpfOverride: 20_400 }).employeeContribution).toBe(20_400);
    expect(cpf({}, { ...income, employeeCpfOverride: 20_401 }).employeeContribution).toBe(20_400);
    expect(cpf({}, { ...income, employeeCpfOverride: 99_999 }).employeeContribution).toBe(20_400);
    // the limit uses the 55-and-below full rate whatever the profile
    expect(cpf({ ageAtYearEnd: 68 }, { ...income, employeeCpfOverride: 99_999 }).employeeContribution).toBe(20_400);
    expect(cpf({ residency: 'pr', prYear: 1 }, { ...income, employeeCpfOverride: 99_999 }).employeeContribution).toBe(20_400);
    expect(cpf({}, { ...income, employeeCpfOverride: 99_999 }, 2025).employeeContribution).toBe(20_400);
    expect(cpf({}, { ...income, employeeCpfOverride: 99_999 }, 2027).employeeContribution).toBe(20_400);
  });

  it('an override of zero means zero', () => {
    const result = cpf({}, { ...income, employeeCpfOverride: 0 });
    expect(result.source).toBe('override');
    expect(result.employeeContribution).toBe(0);
  });

  it('null or undefined means "calculate it"', () => {
    expect(cpf({}, { ...income, employeeCpfOverride: null }).source).toBe('auto');
    expect(cpf({}, { ...income, employeeCpfOverride: undefined }).source).toBe('auto');
    expect(cpf({}, { ...income, employeeCpfOverride: null }).employeeContribution).toBe(20_400);
  });

  it('feeds the CPF relief and raises CPF_OVERRIDE_ABOVE_MAX only above the maximum', () => {
    const base = defaultInput('2026-06-30');
    const withOverride = (employeeCpfOverride: number) =>
      plan({ ...base, income: { ...base.income, employeeCpfOverride } });

    const below = withOverride(15_000);
    expect(below.baseline.reliefs.cpf).toBe(15_000);
    expect(below.baseline.chargeableIncome).toBe(114_000); // 135,000 - (1,000 + 15,000 + 5,000)
    expect(below.warnings.map((w) => w.code)).not.toContain('CPF_OVERRIDE_ABOVE_MAX');

    expect(withOverride(20_400).warnings.map((w) => w.code)).not.toContain('CPF_OVERRIDE_ABOVE_MAX');

    const above = withOverride(25_000);
    expect(above.cpf.employeeContribution).toBe(20_400);
    expect(above.baseline.reliefs.cpf).toBe(20_400);
    const warning = above.warnings.find((w) => w.code === 'CPF_OVERRIDE_ABOVE_MAX');
    expect(warning?.severity).toBe('caution');
    expect(warning?.params).toEqual({ override: 25_000, maxCompulsory: 20_400 });
  });
});
