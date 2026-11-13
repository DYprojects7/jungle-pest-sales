/**
 * Adversarial review — the NORMATIVE warning messages of SPEC §6.11, read from SPEC.md itself.
 *
 * "The cautions that cover what the tool cannot see (messages are normative; {…} are figures from the rules)".
 * The other tests carry their own copy of each sentence. This one has no copy at all: it cuts the quoted text
 * out of SPEC.md, fills in the figures of SPEC §5.4 for the year, and compares it with what the engine says. If
 * the SPEC's wording and the engine's ever drift apart, this fails whichever side was edited.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultInput, plan } from '../../src/engine';
import type { PlannerInput, WarningCode } from '../../src/engine';

const SPEC = readFileSync(join(__dirname, '..', '..', 'SPEC.md'), 'utf8');

/** Text between double quotes, in order, with the SPEC's line wrapping undone. */
const quotedIn = (text: string): string[] => [...text.replace(/\n\s*/g, ' ').matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');

/** The quoted pieces of the §6.11 bullet "- `CODE` — "…"". */
function specMessage(code: WarningCode): string[] {
  const start = SPEC.indexOf(`- \`${code}\` — "`);
  if (start < 0) throw new Error(`SPEC.md has no normative message bullet for ${code}`);
  const nextBullet = SPEC.indexOf('\n- `', start + 1);
  const paragraphEnd = SPEC.indexOf('\n\n', start);
  const end = nextBullet < 0 ? paragraphEnd : Math.min(nextBullet, paragraphEnd);
  return quotedIn(SPEC.slice(start, end));
}

/** The two endings of the paragraph "Other wording fixed by the rule audit". */
function specEndings(): string[] {
  const start = SPEC.indexOf('Other wording fixed by the rule audit');
  if (start < 0) throw new Error('SPEC.md has no "Other wording fixed by the rule audit" paragraph');
  return quotedIn(SPEC.slice(start, SPEC.indexOf('\n\n', start)));
}

const fill = (template: string, figures: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_whole, name: string) => {
    const value = figures[name];
    if (value === undefined) throw new Error(`no figure for {${name}} in "${template}"`);
    return value;
  });

/** SPEC §5.4 "Limits", per income year. */
const FIGURES: Record<number, { FRS: string; ERS: string; matchedRetirement: string; matchedMediSave: string | null }> = {
  2025: { FRS: 'S$213,000', ERS: 'S$426,000', matchedRetirement: 'S$2,000', matchedMediSave: null },
  2026: { FRS: 'S$220,400', ERS: 'S$440,800', matchedRetirement: 'S$2,000', matchedMediSave: 'S$1,000' },
  2027: { FRS: 'S$228,200', ERS: 'S$456,400', matchedRetirement: 'S$2,000', matchedMediSave: 'S$1,000' },
};
const YEARS = [2025, 2026, 2027];

/** The opening example in a given year (seen on 5 October), with a patch. */
function person(year: number, patch: (input: PlannerInput) => void): PlannerInput {
  const input = defaultInput(`${year}-10-05`);
  patch(input);
  return input;
}

function message(input: PlannerInput, code: WarningCode): string {
  const found = plan(input).warnings.find((warning) => warning.code === code);
  if (!found) throw new Error(`no ${code} warning`);
  return found.message;
}

describe('SPEC §6.11 — the normative messages, word for word from SPEC.md', () => {
  it('the SPEC has the bullets this test reads (one quoted sentence each; two pieces for SRS, three for family)', () => {
    expect(specMessage('TAX_RESIDENCY_CHECK')).toHaveLength(1);
    expect(specMessage('SRS_NON_RESIDENT_WITHDRAWAL')).toHaveLength(2);
    expect(specMessage('CPF_SELF_ROOM_UNCONFIRMED')).toHaveLength(1);
    expect(specMessage('AGE_55_PLUS_TOPUP')).toHaveLength(1);
    expect(specMessage('FAMILY_TOPUP_CHECKS')).toHaveLength(3);
    expect(specMessage('PARENTHOOD_TAX_REBATE')).toHaveLength(1);
    expect(specEndings()).toHaveLength(2);
  });

  it.each(YEARS)('%i: TAX_RESIDENCY_CHECK', (year) => {
    const input = person(year, (i) => {
      i.profile.residency = 'foreigner';
      i.income.monthsWorked = 6;
    });
    expect(message(input, 'TAX_RESIDENCY_CHECK')).toBe(specMessage('TAX_RESIDENCY_CHECK')[0]);
  });

  it.each(YEARS)('%i: SRS_NON_RESIDENT_WITHDRAWAL, without and with an amount on the low rungs', (year) => {
    const [base, addition] = specMessage('SRS_NON_RESIDENT_WITHDRAWAL');
    // The opening example as a foreigner: the plan stays on the 15% and 11.5% rungs.
    expect(message(person(year, (i) => (i.profile.residency = 'foreigner')), 'SRS_NON_RESIDENT_WITHDRAWAL')).toBe(base);
    // S$7,000 a month + S$7,000 bonus, no other reliefs: CI 90,000; 10,000 at 11.5%, then 25,700 at 7%.
    const low = person(year, (i) => {
      i.profile.residency = 'foreigner';
      i.income.monthlyOrdinaryWage = 7_000;
      i.income.additionalWages = 7_000;
      i.otherReliefs = 0;
    });
    expect(addition?.startsWith(' ')).toBe(true);
    expect(message(low, 'SRS_NON_RESIDENT_WITHDRAWAL')).toBe(`${base}${fill(addition ?? '', { lowValueAmount: 'S$25,700' })}`);
  });

  it.each(YEARS)('%i: CPF_SELF_ROOM_UNCONFIRMED with the year\'s Enhanced and Full Retirement Sums', (year) => {
    const input = person(year, (i) => (i.profile.ageAtYearEnd = 57));
    const figures = FIGURES[year]!;
    expect(message(input, 'CPF_SELF_ROOM_UNCONFIRMED')).toBe(
      fill(specMessage('CPF_SELF_ROOM_UNCONFIRMED')[0] ?? '', { ERS: figures.ERS, FRS: figures.FRS }),
    );
  });

  it.each(YEARS)('%i: AGE_55_PLUS_TOPUP with the year\'s Full Retirement Sum and the room entered', (year) => {
    const input = person(year, (i) => {
      i.profile.ageAtYearEnd = 57;
      i.levers.cpfSelf = { enabled: true, roomToLimit: 50_000 };
    });
    expect(message(input, 'AGE_55_PLUS_TOPUP')).toBe(
      fill(specMessage('AGE_55_PLUS_TOPUP')[0] ?? '', { FRS: FIGURES[year]!.FRS, year: String(year), roomToLimit: 'S$50,000' }),
    );
  });

  it.each(YEARS)('%i: FAMILY_TOPUP_CHECKS, with the MediSave piece only when the year has a figure', (year) => {
    const [start, mediSave, end] = specMessage('FAMILY_TOPUP_CHECKS');
    const figures = FIGURES[year]!;
    const input = person(year, (i) => (i.levers.cpfFamily = { enabled: true, maxAmount: null }));
    const middle = figures.matchedMediSave === null ? '' : fill(mediSave ?? '', { matchedMediSave: figures.matchedMediSave });
    expect(message(input, 'FAMILY_TOPUP_CHECKS')).toBe(`${fill(start ?? '', { matchedRetirement: figures.matchedRetirement })}${middle}${end}`);
  });

  it.each(YEARS)('%i: PARENTHOOD_TAX_REBATE', (year) => {
    const input = person(year, (i) => (i.profile.hasUnusedParenthoodTaxRebate = true));
    expect(message(input, 'PARENTHOOD_TAX_REBATE')).toBe(specMessage('PARENTHOOD_TAX_REBATE')[0]);
  });

  it('CPF_OVERRIDE_ABOVE_MAX and DEADLINE_SOON end with the wording fixed by the rule audit', () => {
    const [overrideEnding, deadlineEnding] = specEndings();
    const override = message(person(2026, (i) => (i.income.employeeCpfOverride = 25_000)), 'CPF_OVERRIDE_ABOVE_MAX');
    expect(override.endsWith(` ${overrideEnding}`)).toBe(true);
    for (const today of ['2026-12-17', '2026-12-30', '2026-12-31']) {
      const soon = message(person(2026, (i) => (i.today = today)), 'DEADLINE_SOON');
      expect(soon.endsWith(` ${deadlineEnding}`)).toBe(true);
    }
    // Only the cut-off of a scheme that is in the plan is mentioned (the two shorter endings quoted in §6.11).
    const bankClause = 'Banks stop taking same-day SRS contributions before midnight on the last day, some as early as 7pm';
    const boardOnly = 'A CPF top-up counts on the day the CPF Board receives it, so transfer as soon as you can.';
    expect(SPEC).toContain(`\`${boardOnly}\``);
    expect(deadlineEnding?.startsWith(`${bankClause}, and a CPF top-up`)).toBe(true);
    const srsOnly = message(
      person(2026, (i) => {
        i.today = '2026-12-20';
        i.levers.cpfSelf.enabled = false;
      }),
      'DEADLINE_SOON',
    );
    expect(srsOnly).toBe(`Only 11 days left until the 31 December 2026 deadline. ${bankClause}, so transfer as soon as you can.`);
    const cpfOnly = message(
      person(2026, (i) => {
        i.today = '2026-12-20';
        i.levers.srs.enabled = false;
      }),
      'DEADLINE_SOON',
    );
    expect(cpfOnly).toBe(`Only 11 days left until the 31 December 2026 deadline. ${boardOnly}`);
  });

  it('LEVER_LIMITS_PLAN says the own-CPF room is awaited, not used up, for someone 55 or over (§6.5, §6.11)', () => {
    const sentence =
      'Nothing can be contributed yet: your own CPF is left out until you enter its room, and no other scheme you switched on has room left.';
    expect(SPEC.replace(/\s+/g, ' ')).toContain(`\`${sentence}\``);
    const waiting = person(2026, (i) => {
      i.profile.ageAtYearEnd = 55;
      i.levers.srs.enabled = false;
    });
    expect(message(waiting, 'LEVER_LIMITS_PLAN').startsWith(sentence)).toBe(true);
    // With the room entered as 0 the scheme really is full, and at 54 a blank room is not a question at all.
    const full = person(2026, (i) => {
      i.profile.ageAtYearEnd = 55;
      i.levers.srs.enabled = false;
      i.levers.cpfSelf.roomToLimit = 0;
    });
    expect(message(full, 'LEVER_LIMITS_PLAN')).toMatch(/^The schemes you switched on have no room left this year/);
    const younger = person(2026, (i) => {
      i.profile.ageAtYearEnd = 54;
      i.levers.srs.enabled = false;
    });
    expect(message(younger, 'LEVER_LIMITS_PLAN')).toMatch(/^The plan uses all S\$8,000 of room left/);
  });

  it('the order of the §6.11 table is the order the engine uses', () => {
    // Read the codes from the table rows ("| `CODE` | severity | condition |") between "### 6.11" and the next rule.
    const section = SPEC.slice(SPEC.indexOf('### 6.11 Warnings'), SPEC.indexOf('\n---', SPEC.indexOf('### 6.11 Warnings')));
    const table = [...section.matchAll(/^\| `([A-Z0-9_]+)` \| (info|caution|blocker) \|/gm)].map((match) => [match[1], match[2]]);
    expect(table).toHaveLength(21);
    const order = table.map(([code]) => code);
    const severity = new Map(table.map(([code, level]) => [code, level]));
    // A handful of people who between them raise 19 of the 21 codes (the other two are checked elsewhere:
    // PIT_REBATE_APPLIED needs a rebate year, RELIEF_CAP_EXCEEDED_BASELINE excludes most of the others).
    const people: PlannerInput[] = [
      person(2027, (i) => {
        i.today = '2027-12-31';
        i.profile = { residency: 'pr', prYear: 1, ageAtYearEnd: 60, hasUnusedParenthoodTaxRebate: true };
        i.income.employeeCpfOverride = 25_000;
        i.existing.cpfTopUpFamily = 9_000;
        i.levers.cpfSelf = { enabled: true, roomToLimit: 2_000 };
        i.levers.cpfFamily = { enabled: true, maxAmount: null };
      }),
      person(2026, (i) => {
        i.today = '2027-01-01';
        i.profile = { residency: 'foreigner', ageAtYearEnd: 30, hasUnusedParenthoodTaxRebate: true };
        i.income.monthsWorked = 6;
      }),
      person(2026, (i) => {
        i.profile = { residency: 'foreigner', ageAtYearEnd: 17, hasUnusedParenthoodTaxRebate: true };
        i.income.monthsWorked = 6;
      }),
      person(2026, (i) => (i.profile.ageAtYearEnd = 58)),
      person(2026, (i) => (i.preferences.cashBudget = 5_000)),
      person(2026, (i) => (i.otherReliefs = 40_000)),
      person(2026, (i) => (i.preferences.minSavingRate = 0.5)),
      person(2026, (i) => {
        i.income.monthlyOrdinaryWage = 1_500;
        i.income.additionalWages = 0;
        i.profile.hasUnusedParenthoodTaxRebate = true;
      }),
    ];
    const seen = new Set<string>();
    for (const input of people) {
      const warnings = plan(input).warnings;
      const codes = warnings.map((warning) => warning.code);
      expect(new Set(codes).size).toBe(codes.length); // at most one per code
      expect([...codes].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(codes);
      for (const warning of warnings) {
        expect(order).toContain(warning.code);
        expect(warning.severity).toBe(severity.get(warning.code));
        seen.add(warning.code);
      }
    }
    expect(order.filter((code) => !seen.has(code ?? ''))).toEqual(['RELIEF_CAP_EXCEEDED_BASELINE', 'PIT_REBATE_APPLIED']);
  });
});
