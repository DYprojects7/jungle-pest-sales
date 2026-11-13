/**
 * Adversarial review — the warning MESSAGES (SPEC §6.11: "Each warning carries a ready-to-display message").
 *
 * The numbers in `params` are checked elsewhere. These tests read the sentences the user is shown and check
 * that every dollar figure and every claim in them is true for that user.
 */
import { describe, expect, it } from 'vitest';
import { defaultInput, getRules, grossTax, plan } from '../../src/engine';
import type { PlannerInput, PlannerResult, WarningCode } from '../../src/engine';
import { seededInputs } from '../support/generators';

const cents = (dollars: number): number => Math.round(dollars * 100);

function opening(patch: (input: PlannerInput) => void = () => {}): PlannerInput {
  // Appendix A.1: CI 108,600, tax 6,639.00, U 68,600, C 53,600, L 23,300.
  const input = defaultInput('2026-10-05');
  patch(input);
  return input;
}

const message = (r: PlannerResult, code: WarningCode): string => {
  const found = r.warnings.find((w) => w.code === code);
  if (!found) throw new Error(`no ${code} warning; got ${r.warnings.map((w) => w.code).join(', ')}`);
  return found.message;
};

/** Every "S$1,234.56" / "S$1,234" in a sentence, in cents. */
const dollarFigures = (text: string): number[] =>
  [...text.matchAll(/S\$([\d,]+(?:\.\d\d)?)/g)].map((m) => cents(Number(m[1]!.replace(/,/g, ''))));

describe('BUDGET_LIMITS_PLAN', () => {
  it('quotes the cash limit and, when the relief cap is next in line, exactly what more cash would save (Appendix A.2)', () => {
    // A.2: budget 20,000; C = 20,640 < L = 26,300. With no cash limit X = 20,640 and the saving rises by 96.00.
    // (At 57 the CPF top-up room must be entered, SPEC §6.5: A.2 gives 50,000, so the S$8,000 cap is the limit.)
    const a2 = (budget: number | null): PlannerInput =>
      opening((i) => {
        i.profile = { residency: 'pr', prYear: 3, ageAtYearEnd: 57, birthMonth: 6 };
        i.income.monthlyOrdinaryWage = 14_000;
        i.income.additionalWages = 40_000;
        i.otherReliefs = 30_000;
        i.existing.srs = 5_000;
        i.levers.cpfSelf = { enabled: true, roomToLimit: 50_000 };
        i.levers.cpfFamily = { enabled: true, maxAmount: 8_000 };
        i.preferences = { cashBudget: budget, minSavingRate: 0, priority: ['cpfSelf', 'srs', 'cpfFamily'], simulatorStep: 1_000 };
      });
    const limited = plan(a2(20_000));
    const unlimited = plan(a2(null));
    expect(cents(unlimited.plan.taxSaved) - cents(limited.plan.taxSaved)).toBe(9_600);
    const text = message(limited, 'BUDGET_LIMITS_PLAN');
    expect(text).toContain('S$20,000');
    expect(text).toContain('S$96.00');
    expect(dollarFigures(text).sort((a, b) => a - b)).toEqual([9_600, 2_000_000]);
  });

  it('never promises more than removing the cash limit can actually deliver', () => {
    // Opening example with a S$2,500 cash limit: the plan saves 2,500 x 11.5% = 287.50.
    // With NO cash limit the schemes are full at S$23,300 and the plan saves 2,679.50 — i.e. more cash can add at
    // most 2,679.50 - 287.50 = S$2,392.00. (`unrealisedSaving` = 4,751.50 also counts S$30,300 of relief that no
    // amount of cash can buy, because SRS and the CPF top-up are capped by law.)
    const limited = plan(opening((i) => (i.preferences.cashBudget = 2_500)));
    const unlimited = plan(opening());
    expect(limited.plan.bindingConstraint).toBe('cashBudget');
    expect(limited.plan.taxSaved).toBe(287.5);
    expect(unlimited.plan.taxSaved).toBe(2_679.5);
    const achievableWithMoreCash = cents(unlimited.plan.taxSaved) - cents(limited.plan.taxSaved);
    expect(achievableWithMoreCash).toBe(239_200);

    const text = message(limited, 'BUDGET_LIMITS_PLAN');
    const quoted = /With more cash you could save up to S\$([\d,]+\.\d\d) more tax/.exec(text);
    const quotedCents = quoted ? cents(Number(quoted[1]!.replace(/,/g, ''))) : 0;
    // The sentence says "With more cash you could save up to S$X more tax": X must be reachable with more cash.
    expect({ text, quotedCents, withinReach: quotedCents <= achievableWithMoreCash }).toEqual({
      text,
      quotedCents,
      withinReach: true,
    });
  });

  it('quotes the last few cents correctly when one more dollar is all that is left', () => {
    // S$8,000 a month + 4,700 other income, no other reliefs: CI 80,500; U(11.5%) = 500. A cash limit of 499
    // leaves exactly one dollar at 11.5%: tax(80,001) - tax(80,000) = 3,350.12 - 3,350.00 = 0.12.
    const r = plan(
      opening((i) => {
        i.income.monthlyOrdinaryWage = 8_000;
        i.income.additionalWages = 0;
        i.income.otherTaxableIncome = 4_700;
        i.otherReliefs = 0;
        i.preferences.minSavingRate = 0.115;
        i.preferences.cashBudget = 499;
      }),
    );
    expect(r.plan.totalContribution).toBe(499);
    expect(r.plan.bindingConstraint).toBe('cashBudget');
    expect(r.plan.unrealisedSaving).toBe(0.12);
    expect(dollarFigures(message(r, 'BUDGET_LIMITS_PLAN')).sort((a, b) => a - b)).toEqual([12, 49_900]);
    expect(message(r, 'BUDGET_LIMITS_PLAN')).toContain('S$0.12');
  });
});

describe('LEVER_LIMITS_PLAN (the mirror of the cash-limit sentence; REV-01, REV-07)', () => {
  const allOn = (input: PlannerInput): PlannerInput => ({
    ...input,
    levers: {
      srs: { ...input.levers.srs, enabled: true },
      cpfSelf: { ...input.levers.cpfSelf, enabled: true },
      cpfFamily: { ...input.levers.cpfFamily, enabled: true },
    },
  });
  const quoted = (text: string): number => {
    const found = /could save up to S\$([\d,]+\.\d\d) more tax/.exec(text);
    return found ? cents(Number(found[1]!.replace(/,/g, ''))) : 0;
  };

  it('with every scheme switched off, never promises more than switching all of them on can deliver', () => {
    // Opening example, nothing switched on: tax 6,639.00. `unrealisedSaving` = 6,639.00 - tax(55,000) = 5,039.00
    // would need 53,600 of room; SRS 15,300 + own CPF 8,000 + family 8,000 = 31,300 is all the law allows:
    // tax(77,300) = 550 + 7% x 37,300 = 3,161.00, so at most 6,639.00 - 3,161.00 = 3,478.00 can be saved.
    const none = opening((i) => (i.levers = { srs: { enabled: false }, cpfSelf: { enabled: false }, cpfFamily: { enabled: false } }));
    const r = plan(none);
    expect(r.plan.bindingConstraint).toBe('leverLimits');
    expect(r.plan.unrealisedSaving).toBe(5_039);
    const reachable = cents(plan(allOn(none)).plan.taxSaved) - cents(r.plan.taxSaved);
    expect(reachable).toBe(347_800);
    const text = message(r, 'LEVER_LIMITS_PLAN');
    expect(quoted(text)).toBe(reachable);
    expect(dollarFigures(text)).toEqual([reachable]);
    // REV-07: nothing is switched on, so the sentence must not talk about "the schemes you switched on".
    expect(text).toMatch(/^No scheme is switched on/);
    expect(text).not.toMatch(/schemes you switched on/);
  });

  it('with every scheme full, quotes no saving at all: no setting can create more room', () => {
    const full = opening((i) => (i.levers.cpfFamily = { enabled: true, maxAmount: null }));
    const r = plan(full);
    expect(r.plan.bindingConstraint).toBe('leverLimits');
    expect(r.plan.totalContribution).toBe(31_300);
    expect(r.plan.unrealisedSaving).toBe(1_561); // tax(77,300) - tax(55,000) = 3,161.00 - 1,600.00
    const text = message(r, 'LEVER_LIMITS_PLAN');
    expect(text).toBe('The plan uses all S$31,300 of room left in the schemes you switched on.');
  });

  it('does not count room that the cash limit would stop the person from using', () => {
    // SRS and own CPF are full at 23,300 and the cash limit is 24,000: switching on the family top-up
    // (8,000 of room) can only use 700 more dollars: 700 x 11.5% = 80.50.
    const input = opening((i) => (i.preferences.cashBudget = 24_000));
    const r = plan(input);
    expect(r.plan.bindingConstraint).toBe('leverLimits');
    const reachable = cents(plan(allOn(input)).plan.taxSaved) - cents(r.plan.taxSaved);
    expect(reachable).toBe(8_050);
    expect(quoted(message(r, 'LEVER_LIMITS_PLAN'))).toBe(reachable);
  });

  it('a foreigner under 18 has no scheme: the sentence says so and promises nothing', () => {
    const r = plan(opening((i) => (i.profile = { residency: 'foreigner', ageAtYearEnd: 17 })));
    expect(r.plan.bindingConstraint).toBe('leverLimits');
    expect(message(r, 'LEVER_LIMITS_PLAN')).toBe(
      'None of the schemes you switched on is open to you, so nothing can be contributed.',
    );
  });

  it('on a grid of profiles the quoted figure is always exactly what the engine itself plans with every scheme on', () => {
    let checked = 0;
    for (const residency of ['citizen', 'pr', 'foreigner'] as const) {
      for (const wage of [3_000, 6_000, 10_000, 25_000]) {
        for (const flags of [0, 1, 2, 3, 4, 5, 6, 7]) {
          for (const budget of [null, 5_000, 20_000]) {
            for (const minRate of [0, 0.07, 0.115]) {
              const input = opening((i) => {
                i.profile = { residency, prYear: 3, ageAtYearEnd: 40, birthMonth: 6 };
                i.income.monthlyOrdinaryWage = wage;
                i.existing = { srs: 2_000, cpfTopUpSelf: 0, cpfTopUpFamily: 7_500 };
                i.levers = {
                  srs: { enabled: (flags & 1) > 0 },
                  cpfSelf: { enabled: (flags & 2) > 0, roomToLimit: 6_000 },
                  cpfFamily: { enabled: (flags & 4) > 0, maxAmount: null },
                };
                i.preferences = { cashBudget: budget, minSavingRate: minRate, priority: ['cpfFamily', 'srs', 'cpfSelf'], simulatorStep: 1_000 };
              });
              const r = plan(input);
              const w = r.warnings.find((x) => x.code === 'LEVER_LIMITS_PLAN');
              if (!w) continue;
              checked += 1;
              const reachable = cents(plan(allOn(input)).plan.taxSaved) - cents(r.plan.taxSaved);
              expect({ input, quoted: quoted(w.message) }).toEqual({ input, quoted: reachable });
              expect(reachable).toBeLessThanOrEqual(cents(r.plan.unrealisedSaving));
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(150);
  });
});

describe('BUDGET_LIMITS_PLAN on a grid of profiles', () => {
  it('the quoted figure is always exactly what the engine itself plans without the cash limit', () => {
    let checked = 0;
    for (const residency of ['citizen', 'pr', 'foreigner'] as const) {
      for (const wage of [3_000, 6_000, 10_000, 25_000]) {
        for (const flags of [1, 2, 3, 5, 7]) {
          for (const budget of [0, 1, 999, 5_000, 20_000, 30_000]) {
            for (const minRate of [0, 0.07, 0.115]) {
              const input = opening((i) => {
                i.profile = { residency, prYear: 3, ageAtYearEnd: 40, birthMonth: 6 };
                i.income.monthlyOrdinaryWage = wage;
                i.otherReliefs = wage === 25_000 ? 45_000 : 5_000;
                i.levers = {
                  srs: { enabled: (flags & 1) > 0 },
                  cpfSelf: { enabled: (flags & 2) > 0, roomToLimit: null },
                  cpfFamily: { enabled: (flags & 4) > 0, maxAmount: null },
                };
                i.preferences = { cashBudget: budget, minSavingRate: minRate, priority: ['srs', 'cpfSelf', 'cpfFamily'], simulatorStep: 1_000 };
              });
              const r = plan(input);
              const w = r.warnings.find((x) => x.code === 'BUDGET_LIMITS_PLAN');
              if (!w) continue;
              checked += 1;
              const withoutLimit = plan({ ...input, preferences: { ...input.preferences, cashBudget: null } });
              const reachable = cents(withoutLimit.plan.taxSaved) - cents(r.plan.taxSaved);
              const found = /With more cash you could save up to S\$([\d,]+\.\d\d) more tax/.exec(w.message);
              const quotedCents = found ? cents(Number(found[1]!.replace(/,/g, ''))) : 0;
              expect({ input, quotedCents }).toEqual({ input, quotedCents: reachable });
              expect(reachable).toBeGreaterThan(0);
              expect(reachable).toBeLessThanOrEqual(cents(r.plan.unrealisedSaving));
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(150);
  });
});

describe('what-stops-the-plan messages on 4,000 seeded inputs (SPEC §6.11)', () => {
  // The honest figure is found by asking the engine the what-if question directly: the same input with the cash
  // limit lifted, or with every scheme switched on. The message must quote exactly that, or nothing when it is 0.
  const inputs = seededInputs(4_000, 60_611, { maxMoney: 400_000 });
  const quotedCents = (text: string): number | null => {
    const found = /could save up to S\$([\d,]+\.\d\d) more tax\.$/.exec(text);
    return found ? cents(Number(found[1]!.replace(/,/g, ''))) : null;
  };

  it('BUDGET_LIMITS_PLAN quotes the saving of the same plan without the cash limit', () => {
    let fired = 0;
    let belowUnrealised = 0;
    for (const input of inputs) {
      const r = plan(input);
      const w = r.warnings.find((x) => x.code === 'BUDGET_LIMITS_PLAN');
      if (!w) continue;
      fired += 1;
      const lifted = plan({ ...input, preferences: { ...input.preferences, cashBudget: null } });
      const reachable = cents(lifted.plan.taxSaved) - cents(r.plan.taxSaved);
      expect({ input, quoted: quotedCents(w.message) }).toEqual({ input, quoted: reachable > 0 ? reachable : null });
      expect(cents(Number(w.params?.savingWithMoreCash))).toBe(reachable);
      expect(reachable).toBeLessThanOrEqual(cents(r.plan.unrealisedSaving));
      if (reachable < cents(r.plan.unrealisedSaving)) belowUnrealised += 1;
    }
    expect(fired).toBeGreaterThan(100);
    // The old sentence (which quoted unrealisedSaving) would have over-promised in this many cases:
    expect(belowUnrealised).toBeGreaterThan(20);
  });

  it('LEVER_LIMITS_PLAN quotes the saving of the same plan with every scheme switched on', () => {
    let fired = 0;
    let belowUnrealised = 0;
    for (const input of inputs) {
      const r = plan(input);
      const w = r.warnings.find((x) => x.code === 'LEVER_LIMITS_PLAN');
      if (!w) continue;
      fired += 1;
      const everythingOn = plan({
        ...input,
        levers: {
          srs: { ...input.levers.srs, enabled: true },
          cpfSelf: { ...input.levers.cpfSelf, enabled: true },
          cpfFamily: { ...input.levers.cpfFamily, enabled: true },
        },
      });
      const reachable = cents(everythingOn.plan.taxSaved) - cents(r.plan.taxSaved);
      expect({ input, quoted: quotedCents(w.message) }).toEqual({ input, quoted: reachable > 0 ? reachable : null });
      expect(cents(Number(w.params?.savingIfSwitchedOn))).toBe(reachable);
      expect(reachable).toBeLessThanOrEqual(cents(r.plan.unrealisedSaving));
      if (reachable < cents(r.plan.unrealisedSaving)) belowUnrealised += 1;
      // The first sentence matches the person's situation.
      const room = r.levers.srs.room + r.levers.cpfSelf.room + r.levers.cpfFamily.room;
      const on = (['srs', 'cpfSelf', 'cpfFamily'] as const).filter((lever) => r.levers[lever].enabled);
      if (room > 0) expect(w.message).toMatch(/^The plan uses all S\$[\d,]+ of room left in the schemes you switched on\./);
      else if (on.length === 0) expect(w.message).toMatch(/^No scheme is switched on, so nothing can be contributed\./);
      else if (on.every((lever) => !r.levers[lever].eligible)) expect(w.message).toMatch(/^None of the schemes you switched on is open to you, so nothing can be contributed\./);
      else if (r.levers.cpfSelf.enabled && r.levers.cpfSelf.eligible && r.input.profile.ageAtYearEnd >= 55 && (r.input.levers.cpfSelf.roomToLimit ?? null) === null) {
        // §6.5: from 55 a blank room is "not confirmed", so the sentence says the figure is awaited, not that the scheme is full.
        expect(w.message).toMatch(/^Nothing can be contributed yet: your own CPF is left out until you enter its room, and no other scheme you switched on has room left\./);
      } else expect(w.message).toMatch(/^The schemes you switched on have no room left this year, so nothing more can be contributed\./);
    }
    expect(fired).toBeGreaterThan(300);
    expect(belowUnrealised).toBeGreaterThan(100);
  });

  it('no message ever quotes a zero saving or an unformatted number', () => {
    for (const input of inputs) {
      for (const w of plan(input).warnings) {
        expect(w.message, w.code).not.toMatch(/S\$0\.00 more tax|NaN|undefined|Infinity|\d\.\d{3,}/);
      }
    }
  });
});

describe('FOREIGNER_NO_CPF', () => {
  it('quotes the foreigner SRS cap for an adult', () => {
    const r = plan(opening((i) => (i.profile = { residency: 'foreigner', ageAtYearEnd: 35 })));
    expect(message(r, 'FOREIGNER_NO_CPF')).toContain('S$35,700');
  });

  it('does not tell someone under 18 that they can put money into SRS', () => {
    // SPEC §5.4: SRS is for "Age 18+". For a 17-year-old foreigner the same result carries SRS_UNDER_18
    // ("You must be at least 18 to contribute to SRS"), so the two messages must not contradict each other.
    const r = plan(opening((i) => (i.profile = { residency: 'foreigner', ageAtYearEnd: 17 })));
    expect(r.levers.srs.eligible).toBe(false);
    expect(message(r, 'SRS_UNDER_18')).toContain('at least 18');
    expect(message(r, 'FOREIGNER_NO_CPF')).not.toMatch(/You can put up to S\$[\d,]+ a year into SRS/);
  });
});

describe('every dollar figure in every message is one of the result\'s own numbers', () => {
  const inputs: [string, PlannerInput][] = [
    ['opening example', opening()],
    ['budget binds', opening((i) => (i.preferences.cashBudget = 12_345))],
    ['relief cap exceeded', opening((i) => (i.otherReliefs = 70_000))],
    ['relief cap binds', opening((i) => (i.otherReliefs = 40_000))],
    ['existing over the caps', opening((i) => (i.existing = { srs: 20_000, cpfTopUpSelf: 9_500, cpfTopUpFamily: 8_001 }))],
    ['override above the maximum', opening((i) => (i.income.employeeCpfOverride = 25_000))],
    ['55 plus, CPF room left blank', opening((i) => (i.profile.ageAtYearEnd = 60))],
    ['55 plus, CPF room entered', opening((i) => { i.profile.ageAtYearEnd = 60; i.levers.cpfSelf = { enabled: true, roomToLimit: 6_500 }; })],
    ['55 plus, CPF room entered above the cap', opening((i) => { i.profile.ageAtYearEnd = 57; i.levers.cpfSelf = { enabled: true, roomToLimit: 50_000 }; })],
    ['family top-up in the plan', opening((i) => (i.levers.cpfFamily = { enabled: true, maxAmount: null }))],
    ['family top-up already made, 2025', opening((i) => { i.incomeYear = 2025; i.today = '2025-10-05'; i.existing.cpfTopUpFamily = 3_000; })],
    ['foreigner whose plan reaches the 7% rung', opening((i) => { i.profile = { residency: 'foreigner', ageAtYearEnd: 35 }; i.income.monthlyOrdinaryWage = 7_000; i.income.additionalWages = 7_000; i.otherReliefs = 0; })],
    ['foreigner who worked six months', opening((i) => { i.profile = { residency: 'foreigner', ageAtYearEnd: 35 }; i.income.monthsWorked = 6; })],
    ['unused Parenthood Tax Rebate', opening((i) => (i.profile.hasUnusedParenthoodTaxRebate = true))],
    ['after the deadline', opening((i) => (i.today = '2027-01-10'))],
    ['deadline tomorrow', opening((i) => (i.today = '2026-12-30'))],
  ];

  it.each(inputs)('%s', (_label, input) => {
    const r = plan(input);
    // What lifting the cash limit alone would add (the honest figure for a "with more cash" sentence).
    const withoutBudget = plan({ ...input, preferences: { ...input.preferences, cashBudget: null } });
    // What switching on every scheme would add (the honest figure for a scheme-limited plan). SPEC §6.11: a
    // message never quotes `unrealisedSaving`, so that figure is deliberately NOT in this list.
    const everythingOn = plan({
      ...input,
      levers: {
        srs: { ...input.levers.srs, enabled: true },
        cpfSelf: { ...input.levers.cpfSelf, enabled: true },
        cpfFamily: { ...input.levers.cpfFamily, enabled: true },
      },
    });
    const known = new Set<number>([
      cents(withoutBudget.plan.taxSaved) - cents(r.plan.taxSaved),
      cents(everythingOn.plan.taxSaved) - cents(r.plan.taxSaved),
      cents(r.plan.totalContribution),
      cents(r.reliefCapRoom),
      cents(r.rules.personalReliefCap),
      cents(r.baseline.reliefs.totalBeforeCap),
      cents(r.baseline.reliefs.lostToCap),
      cents(r.rules.cpfTopUp.fullRetirementSum),
      cents(r.rules.cpfTopUp.enhancedRetirementSum),
      cents(r.rules.cpfTopUp.matchedTopUps.retirementAnnualCap),
      cents(r.rules.cpfTopUp.matchedTopUps.mediSaveAnnualCap ?? 0),
      // The CPF top-up room as the person entered it (AGE_55_PLUS_TOPUP quotes it, even above the S$8,000 cap).
      cents(r.input.levers.cpfSelf.roomToLimit ?? 0),
      // The plan's dollars on ladder rungs below 7.5 cents per dollar (SRS_NON_RESIDENT_WITHDRAWAL).
      cents(r.ladder.filter((tier) => tier.rate < 0.075).reduce((total, tier) => total + tier.usedByPlan, 0)),
      cents(r.rules.srs.capForeigner),
      cents(r.levers.srs.room + r.levers.cpfSelf.room + r.levers.cpfFamily.room),
      cents(r.input.preferences.cashBudget ?? 0),
      cents(r.input.income.employeeCpfOverride ?? 0),
      cents(20_400),
      cents(0),
      ...(['srs', 'cpfSelf', 'cpfFamily'] as const).flatMap((lever) => {
        const existing = { srs: r.input.existing.srs, cpfSelf: r.input.existing.cpfTopUpSelf, cpfFamily: r.input.existing.cpfTopUpFamily }[lever];
        return [cents(existing), cents(r.levers[lever].statutoryCap), cents(existing - r.levers[lever].statutoryCap)];
      }),
    ]);
    for (const w of r.warnings) {
      for (const figure of dollarFigures(w.message)) {
        expect({ code: w.code, figure, known: known.has(figure) }).toEqual({ code: w.code, figure, known: true });
      }
      // No raw floating-point noise, no "NaN"/"undefined", grouped thousands, sentences end properly.
      expect(w.message).not.toMatch(/NaN|undefined|null|Infinity|\d\.\d{3,}/);
      expect(w.message).toMatch(/[.!]$/);
      expect(w.message).not.toMatch(/S\$\d{4,}/);
    }
  });

  it('exact sentences for the dated warnings', () => {
    const passed = plan(opening((i) => (i.today = '2027-01-01')));
    expect(message(passed, 'DEADLINE_PASSED')).toContain('YA2027');
    expect(message(passed, 'DEADLINE_PASSED')).toContain('31 December 2026');
    expect(message(passed, 'DEADLINE_PASSED')).toMatch(/\b1 day ago\b/);
    const later = plan(opening((i) => (i.today = '2027-01-10')));
    expect(message(later, 'DEADLINE_PASSED')).toMatch(/\b10 days ago\b/);
    const tomorrow = plan(opening((i) => (i.today = '2026-12-30')));
    expect(message(tomorrow, 'DEADLINE_SOON')).toMatch(/\b1 day\b(?! s)/);
    expect(message(tomorrow, 'DEADLINE_SOON')).not.toMatch(/1 days|[Tt]oday/);
    expect(message(tomorrow, 'DEADLINE_SOON')).toContain('31 December 2026');
    const today = plan(opening((i) => (i.today = '2026-12-31')));
    expect(message(today, 'DEADLINE_SOON')).toMatch(/[Tt]oday/);
    expect(message(today, 'DEADLINE_SOON')).not.toMatch(/\d+ days? left/);
    const fortnight = plan(opening((i) => (i.today = '2026-12-17')));
    expect(message(fortnight, 'DEADLINE_SOON')).toMatch(/\b14 days\b/);
    expect(message(fortnight, 'DEADLINE_SOON')).not.toMatch(/[Tt]oday/);
  });

  it('rates are shown as percentages with the precision the user typed', () => {
    // CI 35,400 (Appendix A.3), marginal 3.5%, minimum 7.01%.
    const r = plan(
      opening((i) => {
        i.profile.ageAtYearEnd = 28;
        i.income.monthlyOrdinaryWage = 3_500;
        i.income.additionalWages = 3_500;
        i.otherReliefs = 0;
        i.preferences.minSavingRate = 0.0701;
      }),
    );
    const text = message(r, 'BELOW_MIN_SAVING_RATE');
    expect(text).toContain('3.5%');
    expect(text).toContain('7.01%');
  });

  it('tax amounts keep two decimals, including a leading zero in the cents', () => {
    // Budget binds one dollar short of a 7% band edge: unrealised = 7 cents... build: CI 44,801 with a 7% minimum
    // and budget 4,800: U = 4,801; unrealised = 0.07.
    // S$3,500 x 12 + 3,500 bonus = 45,500; CPF 9,100; EIR 1,000 -> CI 35,400 (A.3). Add other income 9,401 -> 44,801.
    const r = plan(
      opening((i) => {
        i.profile.ageAtYearEnd = 28;
        i.income.monthlyOrdinaryWage = 3_500;
        i.income.additionalWages = 3_500;
        i.income.otherTaxableIncome = 9_401;
        i.otherReliefs = 0;
        i.preferences.minSavingRate = 0.07;
        i.preferences.cashBudget = 4_800;
      }),
    );
    expect(r.baseline.chargeableIncome).toBe(44_801);
    expect(r.plan.totalContribution).toBe(4_800);
    expect(r.plan.unrealisedSaving).toBe(0.07);
    expect(message(r, 'BUDGET_LIMITS_PLAN')).toContain('S$0.07');
    expect(dollarFigures(message(r, 'BUDGET_LIMITS_PLAN')).sort((a, b) => a - b)).toEqual([7, 480_000]);
  });
});

describe('SRS_NON_RESIDENT_WITHDRAWAL: the amount called out is exactly the plan dollars that save less than 7.5 cents', () => {
  const rules = getRules(2026);
  const BASE =
    "If you have left Singapore when you withdraw, SRS is taxed as a non-resident's: at least 7.5 cents per dollar " +
    'withdrawn at retirement age or under the 10-year rule for foreigners, and at least 20 cents if earlier.';
  const dollars = (amount: number): string => `S$${amount.toLocaleString('en-US')}`;

  it('on a grid of foreigners, counted dollar by dollar from the tax table', () => {
    let checked = 0;
    let withAmount = 0;
    for (const wage of [2_500, 4_000, 6_000, 7_000, 9_000, 14_000, 30_000]) {
      for (const minRate of [0, 0.02, 0.07, 0.075, 0.115]) {
        for (const budget of [null, 3_000, 12_000]) {
          const input = opening((i) => {
            i.profile = { residency: 'foreigner', ageAtYearEnd: 40 };
            i.income.monthlyOrdinaryWage = wage;
            i.income.additionalWages = wage;
            i.otherReliefs = 0;
            i.preferences = { cashBudget: budget, minSavingRate: minRate, priority: ['srs', 'cpfSelf', 'cpfFamily'], simulatorStep: 1_000 };
          });
          const r = plan(input);
          const w = r.warnings.find((x) => x.code === 'SRS_NON_RESIDENT_WITHDRAWAL');
          if (!w) throw new Error('a foreigner with SRS on must get the caution');
          // Plan dollar d takes chargeable income from CI0 - d + 1 to CI0 - d. What it saves is the tax on that one
          // dollar of income (the plan never passes the relief cap, so every plan dollar is a dollar of relief).
          const ci0 = r.baseline.chargeableIncome;
          let low = 0;
          for (let d = 1; d <= r.plan.totalContribution; d++) {
            const saved = cents(grossTax(ci0 - d + 1, rules)) - cents(grossTax(ci0 - d, rules));
            if (saved < 7.5) low += 1;
          }
          checked += 1;
          if (low > 0) withAmount += 1;
          expect({ wage, minRate, budget, lowValueAmount: w.params?.lowValueAmount }).toEqual({ wage, minRate, budget, lowValueAmount: low });
          expect(w.message).toBe(low > 0 ? `${BASE} ${dollars(low)} of this plan saves less than 7.5 cents per dollar today.` : BASE);
          // Never more than the plan itself.
          expect(low).toBeLessThanOrEqual(r.plan.totalContribution);
        }
      }
    }
    expect(checked).toBe(105);
    // By hand (chargeable income = 13 x wage - 1,000 of Earned Income Relief; only minimums 0, 2% and 7% can
    // reach a rung below 7.5 cents):
    //   2,500 -> CI 31,500 (3.5% and 2% rungs): every plan at 0 and 2% is low (3 budgets each), none at 7%   = 6
    //   4,000 -> CI 51,000 and 6,000 -> CI 77,000 (7% rung and below): every plan is low, 3 rates x 3 budgets = 9 + 9
    //   7,000 -> CI 90,000 (10,000 at 11.5%, then 7%): low unless the cash limit is 3,000, 3 rates x 2        = 6
    //   9,000, 14,000 and 30,000: the first 35,700 dollars are all at 11.5% or more                            = 0
    expect(withAmount).toBe(30);
  });

  it('a minimum of 7.5% or more never leaves an amount to call out', () => {
    for (const input of seededInputs(1_500, 75_075, { maxMoney: 400_000 })) {
      const r = plan(input);
      const w = r.warnings.find((x) => x.code === 'SRS_NON_RESIDENT_WITHDRAWAL');
      if (!w || r.input.preferences.minSavingRate < 0.075) continue;
      expect(w.params?.lowValueAmount).toBe(0);
      expect(w.message).toBe(BASE);
    }
  });
});

describe('the cautions about what the tool cannot see say only true things about this person (SPEC §6.11)', () => {
  const inputs = seededInputs(4_000, 60_611, { maxMoney: 400_000 });

  it('CPF_SELF_ROOM_UNCONFIRMED: own CPF really is left out, and entering the full room would bring it back', () => {
    let fired = 0;
    let broughtBack = 0;
    for (const input of inputs) {
      const r = plan(input);
      const w = r.warnings.find((x) => x.code === 'CPF_SELF_ROOM_UNCONFIRMED');
      if (!w) continue;
      fired += 1;
      // "Your own CPF is left out": nothing is planned for it, and no scenario uses it either.
      expect(r.plan.contributions.cpfSelf).toBe(0);
      expect(r.levers.cpfSelf.room).toBe(0);
      expect(r.scenarios.every((scenario) => scenario.contributions.cpfSelf === 0)).toBe(true);
      expect(r.simulator.every((row) => row.split.cpfSelf === 0)).toBe(true);
      // "until you enter how much you can still top up": with a figure the caution is replaced by the note.
      const confirmed = plan({ ...input, levers: { ...input.levers, cpfSelf: { enabled: true, roomToLimit: 8_000 } } });
      expect(confirmed.warnings.map((x) => x.code)).not.toContain('CPF_SELF_ROOM_UNCONFIRMED');
      expect(confirmed.warnings.map((x) => x.code)).toContain('AGE_55_PLUS_TOPUP');
      expect(confirmed.levers.cpfSelf.room).toBe(r.levers.cpfSelf.statutoryCap - r.levers.cpfSelf.used);
      if (confirmed.plan.contributions.cpfSelf > 0) broughtBack += 1;
      // The sums quoted are the year's.
      expect(w.message).toContain(`S$${r.rules.cpfTopUp.enhancedRetirementSum.toLocaleString('en-US')}`);
      expect(w.message).toContain(`S$${r.rules.cpfTopUp.fullRetirementSum.toLocaleString('en-US')}`);
    }
    expect(fired).toBeGreaterThan(100);
    expect(broughtBack).toBeGreaterThan(20);
  });

  it('AGE_55_PLUS_TOPUP: "the plan uses the room you entered" — never more than that room', () => {
    let fired = 0;
    for (const input of inputs) {
      const r = plan(input);
      const w = r.warnings.find((x) => x.code === 'AGE_55_PLUS_TOPUP');
      if (!w) continue;
      fired += 1;
      const room = r.input.levers.cpfSelf.roomToLimit;
      expect(room).not.toBeNull();
      expect(r.plan.contributions.cpfSelf).toBeLessThanOrEqual(room ?? 0);
      expect(w.message).toContain(`The plan uses the room you entered (S$${(room ?? 0).toLocaleString('en-US')});`);
    }
    expect(fired).toBeGreaterThan(30);
  });

  it('FAMILY_TOPUP_CHECKS: shown exactly when there is a family top-up that can earn this person relief', () => {
    let fired = 0;
    let silent = 0;
    for (const input of inputs) {
      const r = plan(input);
      const shown = r.warnings.some((x) => x.code === 'FAMILY_TOPUP_CHECKS');
      const hasTopUp = r.plan.contributions.cpfFamily > 0 || r.input.existing.cpfTopUpFamily > 0;
      const canEarnRelief = r.input.profile.residency !== 'foreigner';
      expect({ input, shown }).toEqual({ input, shown: hasTopUp && canEarnRelief });
      if (shown) fired += 1;
      else silent += 1;
    }
    expect(fired).toBeGreaterThan(300);
    expect(silent).toBeGreaterThan(300);
  });

  it('TAX_RESIDENCY_CHECK and PARENTHOOD_TAX_REBATE change no figure: the same plan with and without them', () => {
    let residency = 0;
    let rebate = 0;
    for (const input of inputs.slice(0, 1_500)) {
      const r = plan(input);
      const codes = r.warnings.map((x) => x.code);
      if (codes.includes('TAX_RESIDENCY_CHECK')) {
        residency += 1;
        expect(r.input.profile.residency).toBe('foreigner');
        expect(r.input.income.monthsWorked).toBeLessThanOrEqual(6);
      }
      // Ticking the box on the same input adds the caution and nothing else.
      const ticked = plan({ ...input, profile: { ...input.profile, hasUnusedParenthoodTaxRebate: true } });
      const unticked = plan({ ...input, profile: { ...input.profile, hasUnusedParenthoodTaxRebate: false } });
      expect(ticked.plan).toEqual(unticked.plan);
      expect(ticked.baseline).toEqual(unticked.baseline);
      expect(ticked.warnings.filter((x) => x.code !== 'PARENTHOOD_TAX_REBATE')).toEqual(unticked.warnings);
      expect(ticked.warnings.map((x) => x.code)).toContain('PARENTHOOD_TAX_REBATE');
      expect(unticked.warnings.map((x) => x.code)).not.toContain('PARENTHOOD_TAX_REBATE');
      rebate += 1;
    }
    expect(residency).toBeGreaterThan(10);
    expect(rebate).toBe(1_500);
  });
});
