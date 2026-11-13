/**
 * src/engine/facts.ts — the words of SPEC §5.4 with the year's figures filled in (SPEC §7, §8.4 item 7, §9 sheet 8).
 *
 * The figures expected below are transcribed from the SPEC §5.4 tables, not read from src/engine/rules. The tests
 * check which figures each sentence quotes and which variant of a sentence a person gets; they do not pin the
 * prose word for word (the page and the workbook render these strings as they are).
 */
import { describe, expect, it } from 'vitest';
import {
  DISCLAIMER,
  NON_RESIDENT_SRS_COST,
  NOT_MODELLED,
  getRules,
  lockUpFacts,
  lockUpHorizon,
  plan,
  defaultInput,
  transferCautions,
} from '../../src/engine';
import type { FactsProfile, LockUpFactId, LockUpFactRow, Residency, YearRules } from '../../src/engine';

const YEARS = [2025, 2026, 2027] as const;
type Year = (typeof YEARS)[number];
const RESIDENCIES: Residency[] = ['citizen', 'pr', 'foreigner'];
const AGES = [17, 18, 35, 54, 55, 64, 65, 80];

/** SPEC §5.4, the "Limits" table and the lever table, per income year. */
const SPEC: Record<Year, { frs: string; ers: string; bhs: string; matchedRetirement: string; matchedMediSave: string | null; srsLockAge: number }> = {
  // A first SRS contribution made in 2025 locks in 63 (1 July 2022 to 30 June 2026); from 1 July 2026 it is 64.
  2025: { frs: 'S$213,000', ers: 'S$426,000', bhs: 'S$75,500', matchedRetirement: 'S$2,000', matchedMediSave: null, srsLockAge: 63 },
  2026: { frs: 'S$220,400', ers: 'S$440,800', bhs: 'S$79,000', matchedRetirement: 'S$2,000', matchedMediSave: 'S$1,000', srsLockAge: 64 },
  2027: { frs: 'S$228,200', ers: 'S$456,400', bhs: 'S$79,000', matchedRetirement: 'S$2,000', matchedMediSave: 'S$1,000', srsLockAge: 64 },
};

const ROW_IDS: LockUpFactId[] = ['relief', 'lockedUntil', 'sooner', 'earns', 'taxLater', 'limits', 'noRelief', 'who', 'deadline'];

const person = (residency: Residency = 'citizen', ageAtYearEnd = 35): FactsProfile => ({ residency, ageAtYearEnd });

function row(rows: LockUpFactRow[], id: LockUpFactId): LockUpFactRow {
  const found = rows.find((entry) => entry.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
}

/** Every sentence the module can show for one year and one person. */
function everySentence(rules: YearRules, profile: FactsProfile): string[] {
  return [
    ...lockUpFacts(rules, profile).flatMap((entry) => [entry.label, entry.values.srs, entry.values.cpfSelf, entry.values.cpfFamily]),
    ...transferCautions(rules, profile),
    ...transferCautions(rules, profile, { deadlinePassed: true }),
  ];
}

describe('lockUpFacts — rows', () => {
  it('nine rows, with these ids in this order, for every year, residency and age', () => {
    for (const year of YEARS) {
      for (const residency of RESIDENCIES) {
        for (const age of AGES) {
          expect(lockUpFacts(getRules(year), person(residency, age)).map((entry) => entry.id)).toEqual(ROW_IDS);
        }
      }
    }
  });

  it('every row has a heading and one or two sentences for each of the three schemes', () => {
    for (const year of YEARS) {
      const rows = lockUpFacts(getRules(year), person());
      expect(new Set(rows.map((entry) => entry.label)).size).toBe(rows.length);
      for (const entry of rows) {
        expect(entry.label.length).toBeGreaterThan(3);
        expect(Object.keys(entry.values).sort()).toEqual(['cpfFamily', 'cpfSelf', 'srs']);
        for (const text of Object.values(entry.values)) {
          expect(text.length).toBeGreaterThan(4);
          expect(text).toMatch(/^[A-Z0-9]/);
          expect(text).toMatch(/\.$/);
        }
      }
    }
  });

  it('is pure: the same answer every time, a fresh array each call, and the frozen rules are left alone', () => {
    const rules = getRules(2026);
    const first = lockUpFacts(rules, person());
    const second = lockUpFacts(rules, person());
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    expect(transferCautions(rules, person())).toEqual(transferCautions(rules, person()));
    expect(transferCautions(rules, person())).not.toBe(transferCautions(rules, person()));
    expect(Object.isFrozen(rules)).toBe(true);
  });
});

describe('lockUpFacts — the figures come from the rules of the income year', () => {
  it.each(YEARS)('%i: relief caps, payout age, interest floor and the tax-free SRS withdrawal (SPEC §5.4)', (year) => {
    const rows = lockUpFacts(getRules(year), person('citizen', 35));
    // Relief cap per calendar year: SRS S$15,300 (citizen/PR), CPF top-ups S$8,000 + S$8,000.
    expect(row(rows, 'relief').values.srs).toContain('S$15,300');
    expect(row(rows, 'relief').values.cpfSelf).toContain('S$8,000');
    expect(row(rows, 'relief').values.cpfFamily).toContain('S$8,000');
    // Lock-up: monthly payouts from the payout eligibility age of 65.
    expect(row(rows, 'lockedUntil').values.cpfSelf).toContain('from age 65');
    // What it earns: at least 4% a year.
    expect(row(rows, 'earns').values.cpfSelf).toContain('4%');
    expect(row(rows, 'earns').values.cpfFamily).toContain('4%');
    // Later tax: S$40,000 a year comes out tax-free for a resident with no other income (half of it is taxable,
    // and the first S$20,000 of chargeable income is taxed at 0%).
    expect(row(rows, 'taxLater').values.srs).toContain('S$40,000');
    expect(row(rows, 'taxLater').values.cpfSelf).toBe('None.');
    expect(row(rows, 'taxLater').values.cpfFamily).toBe('None.');
  });

  it.each(YEARS)('%i: Full Retirement Sum and Basic Healthcare Sum of the year, below 55', (year) => {
    const text = row(lockUpFacts(getRules(year), person('citizen', 54)), 'limits').values.cpfSelf;
    expect(text).toContain(`Full Retirement Sum (${SPEC[year].frs})`);
    expect(text).toContain(`${SPEC[year].bhs} if you are 65 or younger in ${year}`);
    // Below 55 the Board does not accept more, so the Enhanced Retirement Sum is not mentioned.
    expect(text).not.toContain('Enhanced Retirement Sum');
    expect(text).not.toContain(SPEC[year].ers);
    expect(text).toContain('Special Account');
  });

  it('2027: the Basic Healthcare Sum is not announced yet, so the 2026 figure is shown as provisional', () => {
    const text = (year: Year): string => row(lockUpFacts(getRules(year), person()), 'limits').values.cpfSelf;
    expect(text(2027)).toContain('S$79,000');
    expect(text(2027)).toContain('provisional');
    expect(text(2025)).not.toContain('provisional');
    expect(text(2026)).not.toContain('provisional');
  });

  it.each(YEARS)('%i: who qualifies — SRS from 18 for the Year of Assessment, family income test for the year before', (year) => {
    const who = row(lockUpFacts(getRules(year), person()), 'who').values;
    expect(who.srs).toContain('Age 18');
    expect(who.srs).toContain(`YA${year + 1}`);
    // Spouse or siblings: earned no more than S$8,000 in the year before the top-up.
    expect(who.cpfFamily).toContain(`S$8,000 in ${year - 1}`);
    expect(who.cpfSelf).toContain('Citizens and Permanent Residents');
  });

  it.each(YEARS)('%i: the deadline is 31 December for every scheme', (year) => {
    const deadline = row(lockUpFacts(getRules(year), person()), 'deadline').values;
    for (const text of Object.values(deadline)) expect(text).toContain('31 December');
    expect(deadline.srs).toContain('7pm');
  });

  it.each(YEARS)('%i: the part the Government matches — retirement S$2,000 in every year, MediSave S$1,000 from 2026', (year) => {
    const text = row(lockUpFacts(getRules(year), person()), 'noRelief').values.cpfFamily;
    expect(text).toContain(`the first ${SPEC[year].matchedRetirement} a year`);
    expect(text).toContain('Matched Retirement Savings Scheme');
    if (SPEC[year].matchedMediSave === null) {
      expect(text).not.toContain('Matched MediSave Scheme');
      expect(text).not.toContain('S$1,000');
    } else {
      expect(text).toContain(`the first ${SPEC[year].matchedMediSave} a year to MediSave`);
      expect(text).toContain('Matched MediSave Scheme');
    }
    // The person's own top-up: a voluntary contribution to all three accounts earns no relief.
    expect(row(lockUpFacts(getRules(year), person()), 'noRelief').values.cpfSelf).toMatch(/voluntary contribution to all three CPF accounts/i);
  });

  it('reads the rules it is given, not a copy of the numbers', () => {
    const base = getRules(2026);
    const changed: YearRules = {
      ...base,
      srs: { ...base.srs, capCitizenPr: 16_000, capForeigner: 36_000, minAge: 21 },
      cpfTopUp: {
        ...base.cpfTopUp,
        selfReliefCap: 9_000,
        familyReliefCap: 7_000,
        fullRetirementSum: 230_000,
        enhancedRetirementSum: 470_000,
        basicHealthcareSum: 81_000,
        interestRateSmra: 0.035,
        payoutEligibilityAge: 67,
        matchedTopUps: { retirementAnnualCap: 2_500, mediSaveAnnualCap: 1_200 },
      },
    };
    const rows = lockUpFacts(changed, person('citizen', 60));
    expect(row(rows, 'relief').values.srs).toContain('S$16,000');
    expect(row(rows, 'relief').values.cpfSelf).toContain('S$9,000');
    expect(row(rows, 'relief').values.cpfFamily).toContain('S$7,000');
    expect(row(rows, 'lockedUntil').values.cpfSelf).toContain('from age 67');
    expect(row(rows, 'earns').values.cpfSelf).toContain('3.5%');
    expect(row(rows, 'limits').values.cpfSelf).toContain('S$230,000');
    expect(row(rows, 'limits').values.cpfSelf).toContain('S$470,000');
    expect(row(rows, 'limits').values.cpfSelf).toContain('S$81,000');
    expect(row(rows, 'noRelief').values.cpfFamily).toContain('S$2,500');
    expect(row(rows, 'noRelief').values.cpfFamily).toContain('S$1,200');
    expect(row(rows, 'who').values.srs).toContain('Age 21');
    expect(row(lockUpFacts(changed, person('foreigner')), 'relief').values.srs).toContain('S$36,000');
    expect(lockUpHorizon(changed, 35)).toMatchObject({ cpfPayoutAge: 67, cpfYears: 32 });
    expect(transferCautions(changed, person()).join(' ')).toContain('S$2,500');
  });
});

describe('lockUpFacts — the foreigner variant', () => {
  it.each(YEARS)('%i: the S$35,700 cap, the yearly declaration and the non-resident withdrawal tax', (year) => {
    const rules = getRules(year);
    const foreigner = lockUpFacts(rules, person('foreigner'));
    const citizen = lockUpFacts(rules, person('citizen'));

    expect(row(foreigner, 'relief').values.srs).toContain('S$35,700');
    expect(row(foreigner, 'relief').values.srs).not.toContain('S$15,300');
    expect(row(citizen, 'relief').values.srs).not.toContain('S$35,700');

    expect(row(foreigner, 'who').values.srs).toContain('declaration');
    expect(row(foreigner, 'who').values.srs).toContain('S$35,700');
    expect(row(citizen, 'who').values.srs).not.toContain('declaration');

    // SPEC §5.4 "Later tax": at least 7.5 cents per dollar at retirement age or under the 10-year rule, at least
    // 20 cents if earlier; a resident with no other income still takes S$40,000 a year out tax-free.
    const later = row(foreigner, 'taxLater').values.srs;
    expect(later).toContain('7.5 cents');
    expect(later).toContain('20 cents');
    expect(later).toContain('10 years');
    expect(later).toContain('non-resident');
    expect(later).toContain('S$40,000');
    expect(row(citizen, 'taxLater').values.srs).not.toContain('7.5 cents');
    expect(row(citizen, 'taxLater').values.srs).toContain('left Singapore');
  });

  it('only the SRS column changes with residency, and a PR reads exactly what a citizen reads', () => {
    const rules = getRules(2026);
    const foreigner = lockUpFacts(rules, person('foreigner'));
    const citizen = lockUpFacts(rules, person('citizen'));
    expect(lockUpFacts(rules, person('pr'))).toEqual(citizen);
    for (const id of ROW_IDS) {
      expect(row(foreigner, id).label).toBe(row(citizen, id).label);
      expect(row(foreigner, id).values.cpfSelf).toBe(row(citizen, id).values.cpfSelf);
      expect(row(foreigner, id).values.cpfFamily).toBe(row(citizen, id).values.cpfFamily);
    }
    const changed = ROW_IDS.filter((id) => row(foreigner, id).values.srs !== row(citizen, id).values.srs);
    expect(changed).toEqual(['relief', 'taxLater', 'who']);
  });
});

describe('lockUpFacts — the age-55 variant', () => {
  it.each(YEARS)('%i: from 55 the Board accepts up to the Enhanced Retirement Sum, relief stops at the Full Retirement Sum', (year) => {
    const text = row(lockUpFacts(getRules(year), person('citizen', 55)), 'limits').values.cpfSelf;
    expect(text).toContain(`Enhanced Retirement Sum (${SPEC[year].ers})`);
    expect(text).toContain(`Full Retirement Sum (${SPEC[year].frs})`);
    expect(text).toContain('Retirement Account');
    expect(text).toContain(SPEC[year].bhs);
    expect(text).not.toContain('Special Account');
  });

  it('the wording switches between 54 and 55 and nowhere else; only the "limits" row depends on age', () => {
    const rules = getRules(2026);
    const limits = (age: number): string => row(lockUpFacts(rules, person('citizen', age)), 'limits').values.cpfSelf;
    expect(limits(0)).toBe(limits(54));
    expect(limits(17)).toBe(limits(54));
    expect(limits(54)).not.toBe(limits(55));
    for (const age of [56, 60, 64, 65, 80, 120]) expect(limits(age)).toBe(limits(55));

    const younger = lockUpFacts(rules, person('citizen', 54));
    const older = lockUpFacts(rules, person('citizen', 55));
    for (const id of ROW_IDS) {
      if (id === 'limits') continue;
      expect(row(older, id)).toEqual(row(younger, id));
    }
    expect(row(older, 'limits').values.srs).toBe(row(younger, 'limits').values.srs);
    expect(row(older, 'limits').values.cpfFamily).toBe(row(younger, 'limits').values.cpfFamily);
  });
});

describe('transferCautions', () => {
  it('a citizen or PR gets six lines: residency, CPF balances, which CPF transaction, family top-ups, the rebate, the deadline', () => {
    for (const residency of ['citizen', 'pr'] as const) {
      const lines = transferCautions(getRules(2026), person(residency, 35));
      expect(lines).toHaveLength(6);
      // Tax residency: at least 183 days in the income year (SPEC §5.4), for YA = income year + 1.
      expect(lines[0]).toContain('YA2027');
      expect(lines[0]).toContain('183 days in 2026');
      expect(lines[1]).toContain('Full Retirement Sum');
      expect(lines[2]).toMatch(/voluntary contribution to all three CPF accounts earns no tax relief/i);
      expect(lines[3]).toContain('the first S$2,000 a year');
      expect(lines[3]).toContain('the first S$1,000 a year to MediSave');
      expect(lines[4]).toContain('Parenthood Tax Rebate');
      expect(lines[5]).toContain('31 December 2026');
      expect(lines.join(' ')).not.toContain('7.5 cents');
    }
  });

  it('a foreigner gets four lines: no CPF lines, and the cost of taking SRS out after leaving', () => {
    const lines = transferCautions(getRules(2026), person('foreigner', 35));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('183 days in 2026');
    expect(lines[1]).toContain('7.5 cents');
    expect(lines[1]).toContain('20 cents');
    expect(lines[1]).toContain('10-year rule');
    expect(lines[2]).toContain('Parenthood Tax Rebate');
    expect(lines[3]).toContain('31 December 2026');
    expect(lines.join(' ')).not.toMatch(/Retirement dashboard|Special Account|family top-up|voluntary contribution/i);
  });

  it('from 55 the balance line is about the Retirement dashboard and the top-ups the Board accepts without relief', () => {
    const rules = getRules(2026);
    const at = (age: number): string => transferCautions(rules, person('citizen', age))[1] ?? '';
    expect(at(54)).toContain('Special Account');
    expect(at(54)).not.toContain('Retirement dashboard');
    expect(at(55)).toContain('Retirement dashboard');
    expect(at(55)).toContain('From 55');
    expect(at(55)).toContain('cannot be taken back');
    expect(at(80)).toBe(at(55));
    // Every other line is the same at 54 and 55.
    const younger = transferCautions(rules, person('citizen', 54));
    const older = transferCautions(rules, person('citizen', 55));
    expect(older.filter((_, index) => index !== 1)).toEqual(younger.filter((_, index) => index !== 1));
  });

  it.each(YEARS)('%i: the year, the Year of Assessment, the matched amounts and the deadline follow the rules', (year) => {
    const lines = transferCautions(getRules(year), person('citizen', 40));
    expect(lines[0]).toContain(`YA${year + 1}`);
    expect(lines[0]).toContain(`183 days in ${year}`);
    expect(lines[3]).toContain(`the first ${SPEC[year].matchedRetirement} a year`);
    if (SPEC[year].matchedMediSave === null) expect(lines[3]).not.toMatch(/Matched MediSave|S\$1,000/);
    else expect(lines[3]).toContain(`the first ${SPEC[year].matchedMediSave} a year to MediSave`);
    expect(lines[lines.length - 1]).toContain(`31 December ${year}`);
  });

  it('once the deadline has passed, only the last line changes', () => {
    for (const residency of RESIDENCIES) {
      const before = transferCautions(getRules(2026), person(residency));
      const after = transferCautions(getRules(2026), person(residency), { deadlinePassed: true });
      expect(after).toHaveLength(before.length);
      expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
      expect(after[after.length - 1]).toContain('The deadline for 2026 has passed');
      expect(after[after.length - 1]).not.toContain('Aim to transfer');
      expect(transferCautions(getRules(2026), person(residency), { deadlinePassed: false })).toEqual(before);
      expect(transferCautions(getRules(2026), person(residency), {})).toEqual(before);
    }
  });
});

describe('lockUpHorizon (SPEC §8.4: "SRS: locked until 64, about 29 years. CPF: paid out monthly from 65, about 30 years")', () => {
  it('2026, ages 35, 64, 65 and 80', () => {
    const rules = getRules(2026);
    expect(lockUpHorizon(rules, 35)).toEqual({ srsAge: 64, srsYears: 29, cpfPayoutAge: 65, cpfYears: 30 });
    expect(lockUpHorizon(rules, 64)).toEqual({ srsAge: 64, srsYears: 0, cpfPayoutAge: 65, cpfYears: 1 });
    expect(lockUpHorizon(rules, 65)).toEqual({ srsAge: 64, srsYears: 0, cpfPayoutAge: 65, cpfYears: 0 });
    expect(lockUpHorizon(rules, 80)).toEqual({ srsAge: 64, srsYears: 0, cpfPayoutAge: 65, cpfYears: 0 });
    // One year either side of the SRS age.
    expect(lockUpHorizon(rules, 63)).toEqual({ srsAge: 64, srsYears: 1, cpfPayoutAge: 65, cpfYears: 2 });
  });

  it.each(YEARS)('%i: a first SRS contribution locks in the retirement age of that year; CPF pays out from 65', (year) => {
    const horizon = lockUpHorizon(getRules(year), 35);
    expect(horizon.srsAge).toBe(SPEC[year].srsLockAge);
    expect(horizon.srsYears).toBe(SPEC[year].srsLockAge - 35);
    expect(horizon.cpfPayoutAge).toBe(65);
    expect(horizon.cpfYears).toBe(30);
  });

  it('never negative, and an age that is not a whole number of years is handled like any engine input', () => {
    const rules = getRules(2026);
    expect(lockUpHorizon(rules, 120)).toEqual({ srsAge: 64, srsYears: 0, cpfPayoutAge: 65, cpfYears: 0 });
    expect(lockUpHorizon(rules, 35.9)).toEqual(lockUpHorizon(rules, 35));
    for (const odd of [Number.NaN, -5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const horizon = lockUpHorizon(rules, odd);
      expect(horizon).toEqual({ srsAge: 64, srsYears: 64, cpfPayoutAge: 65, cpfYears: 65 });
    }
  });
});

describe('2025 has no MediSave matching figure (SPEC §5.4: the Matched MediSave Scheme starts in 2026)', () => {
  it('nothing shown for 2025 names the Matched MediSave Scheme or its S$1,000; 2026 and 2027 do', () => {
    for (const residency of ['citizen', 'pr'] as const) {
      for (const age of AGES) {
        const y2025 = everySentence(getRules(2025), person(residency, age)).join(' ');
        expect(y2025).not.toContain('Matched MediSave');
        expect(y2025).not.toContain('S$1,000');
        expect(y2025).toContain('Matched Retirement Savings Scheme');
        for (const year of [2026, 2027] as const) {
          const text = everySentence(getRules(year), person(residency, age)).join(' ');
          expect(text).toContain('Matched MediSave Scheme');
          expect(text).toContain('S$1,000');
        }
      }
    }
    expect(getRules(2025).cpfTopUp.matchedTopUps).toEqual({ retirementAnnualCap: 2_000, mediSaveAnnualCap: null });
  });
});

describe('no sentence is broken', () => {
  it('nothing contains "undefined", "NaN" or "null", an unformatted amount or a missing full stop', () => {
    let checked = 0;
    for (const year of YEARS) {
      for (const residency of RESIDENCIES) {
        for (const age of AGES) {
          for (const text of everySentence(getRules(year), person(residency, age))) {
            checked += 1;
            expect(text, text).not.toMatch(/undefined|NaN|null|Infinity|\[object/);
            expect(text, text).not.toMatch(/S\$\d{4,}/); // thousands are grouped
            expect(text, text).not.toMatch(/\d\.\d{3,}/); // no floating-point noise
            expect(text, text).not.toMatch(/ {2}|\s$|^\s/);
          }
          for (const text of transferCautions(getRules(year), person(residency, age))) expect(text).toMatch(/\.$/);
        }
      }
    }
    expect(checked).toBeGreaterThan(3 * 3 * 8 * 40);
    for (const text of [...NOT_MODELLED, DISCLAIMER]) {
      expect(text).not.toMatch(/undefined|NaN|null|Infinity|\[object/);
      expect(text).toMatch(/\.$/);
    }
  });

  it('odd profiles do not break a sentence either (an age that is not a number, an unknown residency)', () => {
    const odd = [
      { residency: 'citizen', ageAtYearEnd: Number.NaN },
      { residency: 'foreigner', ageAtYearEnd: -1 },
      { residency: 'tourist', ageAtYearEnd: 40 },
    ] as unknown as FactsProfile[];
    for (const profile of odd) {
      for (const text of everySentence(getRules(2026), profile)) expect(text).not.toMatch(/undefined|NaN|null|\[object/);
    }
  });
});

describe('NOT_MODELLED, DISCLAIMER and NON_RESIDENT_SRS_COST', () => {
  it('the disclaimer is the sentence of SPEC §11, word for word', () => {
    expect(DISCLAIMER).toBe(
      'This is an estimate for planning, not tax, legal or financial advice. It is not affiliated with IRAS or the ' +
        'CPF Board. Check your eligibility and limits with IRAS, the CPF Board and your SRS bank before transferring ' +
        'money. CPF top-ups cannot be reversed.',
    );
  });

  it('what is not modelled covers the non-goals of SPEC §1', () => {
    expect(Array.isArray(NOT_MODELLED)).toBe(true);
    expect(new Set(NOT_MODELLED).size).toBe(NOT_MODELLED.length);
    const all = NOT_MODELLED.join(' ');
    for (const topic of [/self-employed/i, /not tax residents/i, /SRS withdrawals/i, /investment returns/i, /Parenthood Tax Rebate/i, /employer SRS contributions/i, /matching grant/i, /voluntary contributions/i]) {
      expect(all).toMatch(topic);
    }
    for (const line of NOT_MODELLED) expect(line.length).toBeGreaterThan(20);
  });

  it('the cost of an SRS withdrawal for a non-resident: 15% of the taxable half, or 15% of everything plus the 5% penalty', () => {
    expect(NON_RESIDENT_SRS_COST).toEqual({ atRetirementOrTenYears: 0.075, early: 0.2 });
    expect(NON_RESIDENT_SRS_COST.atRetirementOrTenYears).toBe(0.15 * 0.5);
    expect(NON_RESIDENT_SRS_COST.early).toBeCloseTo(0.15 + 0.05, 12);
  });

  it('the engine warning and the facts quote the same two figures (one copy of the numbers)', () => {
    const base = defaultInput('2026-11-13');
    const result = plan({ ...base, profile: { ...base.profile, residency: 'foreigner' } });
    const warning = result.warnings.find((w) => w.code === 'SRS_NON_RESIDENT_WITHDRAWAL');
    expect(warning?.params).toMatchObject({
      atRetirementOrTenYears: NON_RESIDENT_SRS_COST.atRetirementOrTenYears,
      early: NON_RESIDENT_SRS_COST.early,
    });
    const caution = transferCautions(result.rules, { residency: 'foreigner', ageAtYearEnd: 35 })[1] ?? '';
    for (const figure of ['7.5 cents', '20 cents']) {
      expect(warning?.message).toContain(figure);
      expect(caution).toContain(figure);
    }
  });
});
