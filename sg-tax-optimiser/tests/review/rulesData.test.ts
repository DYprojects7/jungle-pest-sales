/**
 * Adversarial review — the rule DATA against SPEC.md §5, value by value.
 *
 * Every expected value below is transcribed from SPEC §5.1–§5.5 (not from src/engine/rules). A typo in a rules
 * file — a rate, a ceiling, a cap, a retirement sum, a deadline — must fail here even if no end-to-end test
 * happens to pass through that value.
 */
import { describe, expect, it } from 'vitest';
import { SUPPORTED_INCOME_YEARS, getRules, grossTax } from '../../src/engine';
import type { CpfAgeBand, YearRules } from '../../src/engine';

const YEARS = [2025, 2026, 2027] as const;

describe('SPEC §5 header — supported years and status', () => {
  it('2025 and 2026 are final, 2027 is projected; YA = income year + 1', () => {
    expect(SUPPORTED_INCOME_YEARS).toEqual([2025, 2026, 2027]);
    expect(YEARS.map((y) => getRules(y).status)).toEqual(['final', 'final', 'projected']);
    for (const y of YEARS) {
      expect(getRules(y).incomeYear).toBe(y);
      expect(getRules(y).ya).toBe(y + 1);
    }
    expect(getRules(2027).statusNotes.length).toBeGreaterThan(0);
  });
});

describe('SPEC §5.1 — resident tax rates (same table for all three years)', () => {
  // [from, rate, tax on the band, cumulative tax at the top of the band]
  const table: [number, number, number | null, number | null][] = [
    [0, 0, 0, 0],
    [20_000, 0.02, 200, 200],
    [30_000, 0.035, 350, 550],
    [40_000, 0.07, 2_800, 3_350],
    [80_000, 0.115, 4_600, 7_950],
    [120_000, 0.15, 6_000, 13_950],
    [160_000, 0.18, 7_200, 21_150],
    [200_000, 0.19, 7_600, 28_750],
    [240_000, 0.195, 7_800, 36_550],
    [280_000, 0.2, 8_000, 44_550],
    [320_000, 0.22, 39_600, 84_150],
    [500_000, 0.23, 115_000, 199_150],
    [1_000_000, 0.24, null, null],
  ];

  it.each(YEARS)('%i: thirteen brackets with the SPEC boundaries and rates, in ascending order', (year) => {
    expect(getRules(year).taxBrackets).toEqual(table.map(([from, rate]) => ({ from, rate })));
  });

  it.each(YEARS)('%i: tax on each band and cumulative tax at the top of each band', (year) => {
    const rules = getRules(year);
    table.forEach(([from, , bandTax, cumulative], k) => {
      const next = table[k + 1];
      if (!next || bandTax === null || cumulative === null) return;
      const top = next[0];
      expect(grossTax(top, rules) - grossTax(from, rules)).toBeCloseTo(bandTax, 9);
      expect(grossTax(top, rules)).toBe(cumulative);
    });
    // Above S$1,000,000: 24%.
    expect(grossTax(1_000_100, rules)).toBe(199_174);
  });

  it.each(YEARS)('%i: no Personal Income Tax Rebate (YA2026 none; YA2027 and YA2028 assumed none)', (year) => {
    expect(getRules(year).pitRebate).toBeNull();
  });
});

describe('SPEC §5.2 — reliefs computed by the tool', () => {
  it.each(YEARS)('%i: cap 80,000; EIR 1,000 / 6,000 / 8,000; donations at 250%', (year) => {
    const rules = getRules(year);
    expect(rules.personalReliefCap).toBe(80_000);
    expect(rules.earnedIncomeRelief).toEqual({ below55: 1_000, age55to59: 6_000, age60plus: 8_000 });
    expect(rules.donationDeductionMultiplier).toBe(2.5);
  });
});

describe('SPEC §5.3 — CPF ceilings and rates', () => {
  it('OW ceiling 7,400 (2025) / 8,000 (2026, 2027); annual wage ceiling 102,000', () => {
    expect(YEARS.map((y) => getRules(y).cpf.owCeilingMonthly)).toEqual([7_400, 8_000, 8_000]);
    expect(YEARS.map((y) => getRules(y).cpf.annualWageCeiling)).toEqual([102_000, 102_000, 102_000]);
  });

  it.each(YEARS)('%i: nil up to 500, phase-in up to 750', (year) => {
    expect(getRules(year).cpf.employeeNilUpTo).toBe(500);
    expect(getRules(year).cpf.phaseInUpTo).toBe(750);
  });

  // SPEC table: employee / employer per age band.
  const full: Record<number, [number | null, number, number][]> = {
    2025: [
      [55, 0.2, 0.17],
      [60, 0.17, 0.155],
      [65, 0.115, 0.12],
      [70, 0.075, 0.09],
      [null, 0.05, 0.075],
    ],
    2026: [
      [55, 0.2, 0.17],
      [60, 0.18, 0.16],
      [65, 0.125, 0.125],
      [70, 0.075, 0.09],
      [null, 0.05, 0.075],
    ],
    2027: [
      [55, 0.2, 0.17],
      [60, 0.19, 0.165],
      [65, 0.13, 0.13],
      [70, 0.075, 0.09],
      [null, 0.05, 0.075],
    ],
  };

  const shape = (bands: CpfAgeBand[]) => bands.map((b) => [b.maxAge, b.employeeRate, b.employerRate]);

  it.each(YEARS)('%i: full rates for all five age bands', (year) => {
    expect(shape(getRules(year).cpf.fullRates)).toEqual(full[year]);
  });

  it.each(YEARS)('%i: 1st-year SPR employee rate 5% at every age; 2nd-year 15% / 12.5% / 7.5% / 5% / 5%', (year) => {
    const { prYear1Rates, prYear2Rates } = getRules(year).cpf;
    expect(prYear1Rates.map((b) => [b.maxAge, b.employeeRate])).toEqual([[55, 0.05], [60, 0.05], [65, 0.05], [70, 0.05], [null, 0.05]]);
    expect(prYear2Rates.map((b) => [b.maxAge, b.employeeRate])).toEqual([[55, 0.15], [60, 0.125], [65, 0.075], [70, 0.05], [null, 0.05]]);
  });

  it.each(YEARS)('%i: phase-in factor = 3 x employee rate in every band of every table (meets the full rate at 750)', (year) => {
    const { fullRates, prYear1Rates, prYear2Rates, phaseInUpTo, employeeNilUpTo } = getRules(year).cpf;
    for (const band of [...fullRates, ...prYear1Rates, ...prYear2Rates]) {
      expect(band.phaseInFactor).toBeCloseTo(3 * band.employeeRate, 12);
      // An exact multiple of 0.0001, so integer arithmetic on it is safe.
      expect(Math.abs(band.phaseInFactor * 10_000 - Math.round(band.phaseInFactor * 10_000))).toBeLessThan(1e-9);
      expect(band.phaseInFactor * (phaseInUpTo - employeeNilUpTo)).toBeCloseTo(band.employeeRate * phaseInUpTo, 9);
    }
    expect(fullRates[0]?.phaseInFactor).toBe(0.6);
  });

  it.each(YEARS)('%i: maximum compulsory employee contribution 20% x 102,000 = 20,400', (year) => {
    const { fullRates, annualWageCeiling } = getRules(year).cpf;
    expect(Math.floor((fullRates[0]?.employeeRate ?? 0) * annualWageCeiling)).toBe(20_400);
  });
});

describe('SPEC §5.4 — the three levers', () => {
  it.each(YEARS)('%i: SRS 15,300 / 35,700 from age 18; CPF top-up 8,000 + 8,000; givers are citizens and PRs', (year) => {
    const rules = getRules(year);
    expect(rules.srs.capCitizenPr).toBe(15_300);
    expect(rules.srs.capForeigner).toBe(35_700);
    expect(rules.srs.minAge).toBe(18);
    expect(rules.cpfTopUp.selfReliefCap).toBe(8_000);
    expect(rules.cpfTopUp.familyReliefCap).toBe(8_000);
    expect(rules.cpfTopUp.familyGiverResidency).toEqual(['citizen', 'pr']);
    expect(rules.cpfTopUp.interestRateSmra).toBe(0.04);
  });

  it('retirement sums and the Basic Healthcare Sum per year', () => {
    const pick = (f: (r: YearRules) => number) => YEARS.map((y) => f(getRules(y)));
    expect(pick((r) => r.cpfTopUp.fullRetirementSum)).toEqual([213_000, 220_400, 228_200]);
    expect(pick((r) => r.cpfTopUp.enhancedRetirementSum)).toEqual([426_000, 440_800, 456_400]);
    // 2027 BHS not yet announced: the 2026 figure is used.
    expect(pick((r) => r.cpfTopUp.basicHealthcareSum)).toEqual([75_500, 79_000, 79_000]);
    // The ERS is twice the FRS in every year.
    for (const y of YEARS) expect(getRules(y).cpfTopUp.enhancedRetirementSum).toBe(2 * getRules(y).cpfTopUp.fullRetirementSum);
  });

  it('the part of a top-up the Government matches (no relief): retirement 2,000 every year; MediSave from 2026 only', () => {
    // SPEC §5.4 "Limits": MRSS S$2,000 / S$2,000 / S$2,000; Matched MediSave Scheme not applicable / S$1,000 / S$1,000.
    expect(YEARS.map((y) => getRules(y).cpfTopUp.matchedTopUps.retirementAnnualCap)).toEqual([2_000, 2_000, 2_000]);
    expect(YEARS.map((y) => getRules(y).cpfTopUp.matchedTopUps.mediSaveAnnualCap)).toEqual([null, 1_000, 1_000]);
    for (const y of YEARS) expect(Object.keys(getRules(y).cpfTopUp.matchedTopUps).sort()).toEqual(['mediSaveAnnualCap', 'retirementAnnualCap']);
  });

  it('CPF payout eligibility age 65 in every year', () => {
    expect(YEARS.map((y) => getRules(y).cpfTopUp.payoutEligibilityAge)).toEqual([65, 65, 65]);
  });

  it('deadline 31 December of the income year', () => {
    expect(YEARS.map((y) => getRules(y).contributionDeadline)).toEqual(['2025-12-31', '2026-12-31', '2027-12-31']);
  });

  it('statutory retirement age locked in by a first SRS contribution at the end of the year: 63 / 64 / 64', () => {
    // 63 for first contributions from 1 Jul 2022 to 30 Jun 2026; 64 from 1 Jul 2026.
    expect(YEARS.map((y) => getRules(y).srs.statutoryRetirementAge)).toEqual([63, 64, 64]);
  });
});

describe('SPEC §5.5 — relief helper catalogue', () => {
  const catalog = getRules(2026).reliefCatalog;
  const item = (id: string) => {
    const found = catalog.find((entry) => entry.id === id);
    if (!found) throw new Error(`no catalogue item ${id}`);
    return found;
  };

  it('the same catalogue is offered in every year', () => {
    for (const y of YEARS) expect(getRules(y).reliefCatalog).toEqual(catalog);
  });

  it('fixed amounts', () => {
    expect(item('spouse')).toMatchObject({ amountPerUnit: 2_000, input: 'toggle' });
    expect(item('qualifyingChild')).toMatchObject({ amountPerUnit: 4_000, input: 'count' });
    expect(item('parentStayingWith')).toMatchObject({ amountPerUnit: 9_000, input: 'count', max: 2 });
    expect(item('parentNotStayingWith')).toMatchObject({ amountPerUnit: 5_500, input: 'count', max: 2 });
    expect(item('nsmanWifeOrParent')).toMatchObject({ amountPerUnit: 750, input: 'toggle' });
    expect(item('grandparentCaregiver')).toMatchObject({ amountPerUnit: 3_000, input: 'toggle' });
    expect(item('spouseDisability')).toMatchObject({ amountPerUnit: 5_500, group: 'disability' });
    expect(item('childDisability')).toMatchObject({ amountPerUnit: 7_500, group: 'disability' });
    expect(item('parentDisabilityStayingWith')).toMatchObject({ amountPerUnit: 14_000, max: 2 });
    expect(item('parentDisabilityNotStayingWith')).toMatchObject({ amountPerUnit: 10_000, max: 2 });
    expect(item('siblingDisability')).toMatchObject({ amountPerUnit: 5_500, group: 'disability' });
  });

  it('NSman Self Relief options 1,500 / 3,000 / 3,500 / 5,000 after a zero "none" choice', () => {
    expect(item('nsmanSelf').input).toBe('select');
    expect(item('nsmanSelf').options?.map((o) => o.amount)).toEqual([0, 1_500, 3_000, 3_500, 5_000]);
  });

  it('Earned Income Relief (disability) is entered as the difference from the standard amount', () => {
    // 4,000 - 1,000; 10,000 - 6,000; 12,000 - 8,000.
    expect(item('earnedIncomeDisabilityTopUp').options?.map((o) => o.amount)).toEqual([0, 3_000, 4_000, 4_000]);
  });

  it('typed amounts: Working Mother\'s Child Relief, Life Insurance Relief (max 5,000) and "other"', () => {
    expect(item('workingMotherChild')).toMatchObject({ input: 'amount', amountPerUnit: 0 });
    expect(item('workingMotherChild').help).toMatch(/8,000.*10,000.*12,000/);
    expect(item('workingMotherChild').help).toMatch(/15%.*20%.*25%/);
    expect(item('lifeInsurance')).toMatchObject({ input: 'amount', amountPerUnit: 0, max: 5_000 });
    expect(item('other')).toMatchObject({ input: 'amount', amountPerUnit: 0 });
  });

  it('lapsed reliefs are not offered: Course Fees (from YA2026) and Foreign Domestic Worker Levy (from YA2025)', () => {
    const text = catalog.map((entry) => `${entry.id} ${entry.label}`).join(' ').toLowerCase();
    expect(text).not.toMatch(/course/);
    expect(text).not.toMatch(/levy|domestic/);
  });

  it('ids are unique and every item has a label and help text', () => {
    expect(new Set(catalog.map((entry) => entry.id)).size).toBe(catalog.length);
    for (const entry of catalog) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.help.length).toBeGreaterThan(0);
      expect(entry.amountPerUnit).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('sources', () => {
  it.each(YEARS)('%i: every source has a label and an https URL on an official domain', (year) => {
    const { sources } = getRules(year);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.label.length).toBeGreaterThan(0);
      expect(source.url).toMatch(/^https:\/\/www\.(iras|cpf|mom|mof)\.gov\.sg\//);
    }
  });
});
