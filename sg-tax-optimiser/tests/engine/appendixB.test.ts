/**
 * SPEC Appendix B — official figures used as test vectors.
 */
import { describe, expect, it } from 'vitest';
import { SUPPORTED_INCOME_YEARS, computeCpf, evaluate, getRules, grossTax } from '../../src/engine';
import type { PlannerInput } from '../../src/engine';

const NOTHING = { srs: 0, cpfSelf: 0, cpfFamily: 0 };

/** An employee with no contributions and no levers switched on. */
function employee(overrides: {
  incomeYear: number;
  ageAtYearEnd: number;
  monthlyOrdinaryWage: number;
  additionalWages: number;
  donations?: number;
  otherReliefs?: number;
}): PlannerInput {
  return {
    incomeYear: overrides.incomeYear,
    today: `${overrides.incomeYear}-06-30`,
    profile: { residency: 'citizen', ageAtYearEnd: overrides.ageAtYearEnd },
    income: {
      monthlyOrdinaryWage: overrides.monthlyOrdinaryWage,
      additionalWages: overrides.additionalWages,
      donations: overrides.donations ?? 0,
    },
    existing: { srs: 0, cpfTopUpSelf: 0, cpfTopUpFamily: 0 },
    otherReliefs: overrides.otherReliefs ?? 0,
    levers: { srs: { enabled: false }, cpfSelf: { enabled: false }, cpfFamily: { enabled: false } },
    preferences: { minSavingRate: 0, priority: ['srs', 'cpfSelf', 'cpfFamily'] },
  };
}

describe('Appendix B — IRAS rate table', () => {
  const vectors: [number, number][] = [
    [20_000, 0],
    [30_000, 200],
    [40_000, 550],
    [80_000, 3_350],
    [120_000, 7_950],
    [160_000, 13_950],
    [200_000, 21_150],
    [240_000, 28_750],
    [280_000, 36_550],
    [320_000, 44_550],
    [500_000, 84_150],
    [1_000_000, 199_150],
    [1_200_000, 247_150], // 199,150 + 24% x 200,000
  ];

  for (const year of SUPPORTED_INCOME_YEARS) {
    it.each(vectors)(`income year ${year}: tax on %i is %i`, (chargeableIncome, tax) => {
      expect(grossTax(chargeableIncome, getRules(year))).toBe(tax);
    });
  }
});

describe('Appendix B — IRAS sample calculation, YA2026 (Mr Heng, 35)', () => {
  // Income year 2025: S$4,000 x 12 + S$2,000 bonus = S$50,000; donations S$100; Qualifying Child Relief S$4,000.
  const input = employee({
    incomeYear: 2025,
    ageAtYearEnd: 35,
    monthlyOrdinaryWage: 4_000,
    additionalWages: 2_000,
    donations: 100,
    otherReliefs: 4_000,
  });
  const tax = evaluate(input, NOTHING);

  it('CPF relief 10,000 (800 x 12 + 400)', () => {
    expect(tax.reliefs.cpf).toBe(10_000);
  });

  it('assessable income 49,750 (50,000 less 250% x 100)', () => {
    expect(tax.totalIncome).toBe(50_000);
    expect(tax.donationDeduction).toBe(250);
    expect(tax.assessableIncome).toBe(49_750);
  });

  it('reliefs 15,000 (EIR 1,000 + CPF 10,000 + child 4,000)', () => {
    expect(tax.reliefs.earnedIncome).toBe(1_000);
    expect(tax.reliefs.other).toBe(4_000);
    expect(tax.reliefs.totalBeforeCap).toBe(15_000);
    expect(tax.reliefs.totalAllowed).toBe(15_000);
  });

  it('chargeable income 34,750 and tax 366.25 (200 + 3.5% x 4,750)', () => {
    expect(tax.chargeableIncome).toBe(34_750);
    expect(tax.grossTax).toBe(366.25);
    expect(tax.taxPayable).toBe(366.25);
  });
});

describe('Appendix B — IRAS sample calculation, YA2026 (S$250,000 earner)', () => {
  // Income year 2025, in the "above 65 to 70" CPF band: S$19,000 x 12 + S$22,000 bonus, donations S$100.
  const input = employee({
    incomeYear: 2025,
    ageAtYearEnd: 68,
    monthlyOrdinaryWage: 19_000,
    additionalWages: 22_000,
    donations: 100,
  });
  const tax = evaluate(input, NOTHING);

  it('CPF relief 7,650: floor(7.5% x 7,400) x 12 + 7.5% x 13,200 = 6,660 + 990', () => {
    const cpf = computeCpf(input, getRules(2025));
    expect(cpf.ordinaryWagesSubject).toBe(88_800); // 7,400 x 12
    expect(cpf.additionalWageCeiling).toBe(13_200); // 102,000 - 88,800
    expect(cpf.additionalWagesSubject).toBe(13_200);
    expect(cpf.monthlyEmployeeRates).toEqual(new Array(12).fill(0.075));
    expect(cpf.employeeContribution).toBe(7_650);
    expect(tax.reliefs.cpf).toBe(7_650);
  });

  it('reliefs 15,650 (EIR 8,000 + CPF 7,650)', () => {
    expect(tax.reliefs.earnedIncome).toBe(8_000);
    expect(tax.reliefs.totalBeforeCap).toBe(15_650);
  });

  it('chargeable income 234,100 and tax 27,629.00 (21,150 + 19% x 34,100)', () => {
    expect(tax.totalIncome).toBe(250_000);
    expect(tax.assessableIncome).toBe(249_750);
    expect(tax.chargeableIncome).toBe(234_100);
    expect(tax.grossTax).toBe(27_629);
    expect(tax.taxPayable).toBe(27_629);
  });
});

describe('Appendix B — CPF Board, 2026 table maxima (monthly OW at or above 8,000)', () => {
  const oneMonth = (ageAtYearEnd: number, monthlyOrdinaryWage: number): number =>
    computeCpf(
      {
        ...employee({ incomeYear: 2026, ageAtYearEnd, monthlyOrdinaryWage, additionalWages: 0 }),
        income: { monthlyOrdinaryWage, monthsWorked: 1, additionalWages: 0 },
      },
      getRules(2026),
    ).employeeContribution;

  it.each([
    ['55 and below', 40, 1_600], // 20% x 8,000
    ['above 55 to 60', 58, 1_440], // 18% x 8,000
    ['above 60 to 65', 63, 1_000], // 12.5% x 8,000
  ])('%s (age %i): employee share %i', (_band, age, share) => {
    expect(oneMonth(age, 8_000)).toBe(share);
    expect(oneMonth(age, 12_500)).toBe(share); // wages above the ceiling do not add to it
  });
});

describe('Appendix B — CPF Board, AW ceiling example (2026, S$9,000 a month all year)', () => {
  it('OW subject 96,000; AW ceiling 6,000; maximum employee CPF 20,400', () => {
    const rules = getRules(2026);
    const withBonus = computeCpf(
      employee({ incomeYear: 2026, ageAtYearEnd: 40, monthlyOrdinaryWage: 9_000, additionalWages: 50_000 }),
      rules,
    );
    expect(withBonus.ordinaryWagesSubject).toBe(96_000);
    expect(withBonus.additionalWageCeiling).toBe(6_000);
    expect(withBonus.additionalWagesSubject).toBe(6_000);
    expect(withBonus.employeeContribution).toBe(20_400); // 19,200 + 1,200

    const noBonus = computeCpf(
      employee({ incomeYear: 2026, ageAtYearEnd: 40, monthlyOrdinaryWage: 9_000, additionalWages: 0 }),
      rules,
    );
    expect(noBonus.additionalWageCeiling).toBe(6_000);
    expect(noBonus.additionalWagesSubject).toBe(0);
    expect(noBonus.employeeContribution).toBe(19_200);
  });
});

describe('Appendix B — CPF Board, 2025 (S$9,000 a month, S$20,000 bonus, 55 and below)', () => {
  it('1,480 x 12 + 20% x 13,200 = 20,400', () => {
    const cpf = computeCpf(
      employee({ incomeYear: 2025, ageAtYearEnd: 40, monthlyOrdinaryWage: 9_000, additionalWages: 20_000 }),
      getRules(2025),
    );
    expect(cpf.ordinaryWagesSubject).toBe(88_800); // 7,400 x 12
    expect(cpf.additionalWageCeiling).toBe(13_200);
    expect(cpf.additionalWagesSubject).toBe(13_200);
    expect(cpf.employeeContribution).toBe(20_400); // 17,760 + 2,640
  });
});

describe('Appendix B — MOF / IRAS, SRS withdrawal', () => {
  it('a S$40,000 withdrawal is 50% taxable: chargeable income 20,000 -> tax 0', () => {
    for (const year of SUPPORTED_INCOME_YEARS) {
      expect(grossTax(40_000 * 0.5, getRules(year))).toBe(0);
    }
  });
});
