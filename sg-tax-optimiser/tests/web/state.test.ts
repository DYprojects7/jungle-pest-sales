import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DISCLAIMER,
  NON_RESIDENT_SRS_COST,
  NOT_MODELLED,
  SUPPORTED_INCOME_YEARS,
  defaultInput,
  evaluate,
  getRules,
  lockUpFacts,
  plan,
  transferCautions,
} from '../../src/engine';
import type { Residency } from '../../src/engine';
import { safeWebAddress } from '../../src/web/build';
import { listedWarnings, noticeMessage } from '../../src/web/components/Sections';
import {
  DEFAULT_MIN_RATE,
  STORAGE_KEY,
  applyEdit,
  computePlan,
  customRateOf,
  customRateOptions,
  defaultMinRate,
  deeperPlan,
  exampleLeft,
  exampleState,
  followCalendar,
  itemisedReliefTotal,
  minimumIsDefault,
  monthlyWage,
  oddPay,
  openIncomeYear,
  otherReliefsOf,
  parseSaved,
  rateBelowLeavingCost,
  reliefsUntouched,
  serialiseSaved,
  simulatorSteps,
  switchPayMode,
  switchReliefMode,
  toPlannerInput,
  whatIf,
} from '../../src/web/state';
import type { UiState } from '../../src/web/state';
import {
  COUNTS_NEXT_YEAR,
  PLAN_CAUTION_CODES,
  affordabilityNote,
  approximations,
  balanceCaution,
  cautionsFor,
  compareLeftOut,
  deadlineLines,
  deeperOffer,
  depthExplanation,
  depthLabel,
  fact,
  factsFor,
  familyCaution,
  foreignerDepthNote,
  fullYearSplit,
  headline,
  horizonLines,
  horizonNote,
  inputsSummary,
  ladderEmptyText,
  leavingCaveat,
  leftOutSentence,
  newToThis,
  notModelledFor,
  nothingText,
  orderWhy,
  planCautions,
  residencyHint,
  sourcesFor,
  stopReason,
  summaryText,
} from '../../src/web/text';
import { bandRows } from '../../src/web/bands';

const TODAY = '2026-11-13';
const example = (): UiState => exampleState(TODAY);
/** The example with one or more fields set the way the form sets them (recorded as the person's own). */
const edit = (patch: Partial<UiState>, from: UiState = example()): UiState => applyEdit(from, patch);

describe('toPlannerInput', () => {
  it('turns the opening state back into the engine example', () => {
    expect(toPlannerInput(example(), TODAY)).toEqual(defaultInput(TODAY));
  });

  it('reads an annual salary as twelve months of pay', () => {
    const ui: UiState = { ...example(), payMode: 'annual', salary: 120_000 };
    expect(monthlyWage(ui)).toBe(10_000);
    expect(toPlannerInput(ui, TODAY).income.monthlyOrdinaryWage).toBe(10_000);
    expect(toPlannerInput(ui, TODAY).income.additionalWages).toBe(15_000);
    expect(monthlyWage({ payMode: 'annual', salary: 100_000 })).toBe(8_333);
  });

  it('counts every dollar of an annual salary that is not a multiple of twelve', () => {
    // S$100,000 a year is S$8,333 a month with S$4 over; the S$4 travels with the extra pay.
    const ui: UiState = { ...example(), payMode: 'annual', salary: 100_000 };
    expect(oddPay(ui)).toBe(4);
    const input = toPlannerInput(ui, TODAY);
    expect(input.income.monthlyOrdinaryWage).toBe(8_333);
    expect(input.income.additionalWages).toBe(15_004);
    expect(computePlan(ui, TODAY).baseline.employmentIncome).toBe(115_000);
    // Part of a year: three twelfths of S$100,000 is S$25,000.
    const quarter: UiState = { ...ui, monthsWorked: 3, bonus: 0 };
    expect(computePlan(quarter, TODAY).baseline.employmentIncome).toBe(25_000);
    expect(oddPay({ payMode: 'monthly', salary: 8_333, monthsWorked: 12 })).toBe(0);
  });

  it('switching between monthly and annual entry never rewrites the typed figure', () => {
    const typed = { payMode: 'annual' as const, salary: 100_000, salaryOther: null };
    const monthly = switchPayMode(typed, 'monthly');
    expect(monthly).toEqual({ payMode: 'monthly', salary: 8_333, salaryOther: 100_000 });
    expect(switchPayMode(monthly, 'annual')).toEqual({ payMode: 'annual', salary: 100_000, salaryOther: 8_333 });
    // Once the monthly figure is edited, the remembered annual figure is dropped and the pay is converted.
    expect(switchPayMode({ payMode: 'monthly', salary: 8_400, salaryOther: null }, 'annual').salary).toBe(100_800);
    expect(switchPayMode(typed, 'annual')).toEqual(typed);
  });

  it('maps the strategy presets', () => {
    const ui = example();
    expect(toPlannerInput({ ...ui, depth: 'every' }, TODAY).preferences.minSavingRate).toBe(0);
    expect(toPlannerInput({ ...ui, depth: 'default' }, TODAY).preferences.minSavingRate).toBe(0.07);
    // A custom rate is one the person picked from the list (the form records that it was set).
    expect(toPlannerInput(edit({ depth: 'custom', customRate: 0.035 }), TODAY).preferences.minSavingRate).toBe(0.035);
    expect(toPlannerInput({ ...ui, depth: 'top' }, TODAY, 0.115).preferences.minSavingRate).toBe(0.115);
    expect(toPlannerInput({ ...ui, order: 'interest' }, TODAY).preferences.priority).toEqual(['cpfSelf', 'srs', 'cpfFamily']);
    expect(toPlannerInput({ ...ui, order: 'family' }, TODAY).preferences.priority).toEqual(['cpfFamily', 'srs', 'cpfSelf']);
  });

  it('passes optional limits through and ignores the CPF override for foreigners', () => {
    const ui: UiState = { ...example(), cashLimit: 20_000, cpfSelfRoom: 3_000, useCpfFamily: true, cpfFamilyMax: 1_000 };
    const input = toPlannerInput(ui, TODAY);
    expect(input.preferences.cashBudget).toBe(20_000);
    expect(input.levers.cpfSelf.roomToLimit).toBe(3_000);
    expect(input.levers.cpfFamily).toEqual({ enabled: true, maxAmount: 1_000 });
    const foreigner = toPlannerInput({ ...ui, residency: 'foreigner', cpfOverrideOn: true, cpfOverride: 9_999 }, TODAY);
    expect(foreigner.income.employeeCpfOverride).toBeNull();
  });

  it('an empty CPF override means "use the estimate", not S$0', () => {
    const ui: UiState = { ...example(), cpfOverrideOn: true, cpfOverride: null };
    expect(toPlannerInput(ui, TODAY).income.employeeCpfOverride).toBeNull();
    const r = computePlan(ui, TODAY);
    expect(r.cpf.source).toBe('auto');
    expect(r.plan.taxSaved).toBe(2_679.5);
    expect(toPlannerInput({ ...ui, cpfOverride: 18_000 }, TODAY).income.employeeCpfOverride).toBe(18_000);
  });

  it('adds up the itemised relief helper', () => {
    const rules = getRules(2026);
    const values = { spouse: 1, qualifyingChild: 2, nsmanSelf: 2, lifeInsurance: 9_999, parentStayingWith: 5 };
    // 2,000 + 2 x 4,000 + 3,000 + 5,000 (held at its maximum) + 2 x 9,000 (held at two dependants)
    expect(itemisedReliefTotal(rules.reliefCatalog, values)).toBe(36_000);
    const ui = edit({ reliefMode: 'itemised', reliefItems: values });
    expect(toPlannerInput(ui, TODAY).otherReliefs).toBe(36_000);
  });

  it('maps the Parenthood Tax Rebate tick-box, which changes no figure and raises the caution', () => {
    expect(toPlannerInput(example(), TODAY).profile.hasUnusedParenthoodTaxRebate).toBe(false);
    const ui = edit({ hasPtr: true });
    expect(toPlannerInput(ui, TODAY).profile.hasUnusedParenthoodTaxRebate).toBe(true);
    const r = computePlan(ui, TODAY);
    expect(r.plan.taxSaved).toBe(2_679.5);
    expect(planCautions(r).map((w) => w.code)).toEqual(['PARENTHOOD_TAX_REBATE']);
  });
});

describe('the default minimum follows the residency (SPEC 8.3)', () => {
  it('is 7 cents for citizens and PRs and 11.5 cents for foreigners, and is named by its figure', () => {
    expect(DEFAULT_MIN_RATE).toEqual({ citizen: 0.07, pr: 0.07, foreigner: 0.115 });
    expect(depthLabel('default', 'citizen')).toBe('7 cents or more');
    expect(depthLabel('default', 'pr')).toBe('7 cents or more');
    expect(depthLabel('default', 'foreigner')).toBe('11.5 cents or more');
    for (const residency of ['citizen', 'pr', 'foreigner'] as Residency[]) {
      for (const depth of ['default', 'top', 'every', 'custom'] as const) {
        expect(depthLabel(depth, residency)).not.toMatch(/worth/i);
      }
    }
  });

  it("a foreigner's default is the lowest tax rate that beats the cost of taking SRS out after leaving", () => {
    for (const year of SUPPORTED_INCOME_YEARS) {
      const rates = getRules(year).taxBrackets.map((b) => b.rate);
      const beats = rates.filter((rate) => rate >= NON_RESIDENT_SRS_COST.atRetirementOrTenYears);
      expect(Math.min(...beats)).toBe(defaultMinRate('foreigner'));
      expect(rateBelowLeavingCost(getRules(year))).toBe(0.07);
      expect(rates).toContain(defaultMinRate('citizen'));
    }
  });

  it('changing residency while the default is selected moves the rate with it', () => {
    const citizen = example();
    expect(toPlannerInput(citizen, TODAY).preferences.minSavingRate).toBe(0.07);
    const foreigner = edit({ residency: 'foreigner' }, citizen);
    expect(foreigner.depth).toBe('default');
    expect(toPlannerInput(foreigner, TODAY).preferences.minSavingRate).toBe(0.115);
    expect(toPlannerInput(edit({ residency: 'pr' }, foreigner), TODAY).preferences.minSavingRate).toBe(0.07);
    // A minimum the person chose themselves is left alone.
    const custom = edit({ residency: 'foreigner' }, edit({ depth: 'custom', customRate: 0.035 }));
    expect(toPlannerInput(custom, TODAY).preferences.minSavingRate).toBe(0.035);
    expect(toPlannerInput(edit({ residency: 'foreigner' }, edit({ depth: 'every' })), TODAY).preferences.minSavingRate).toBe(0);
  });

  it('a foreigner on S$7,000 a month with a S$7,000 bonus is given S$10,000 of SRS at 11.5 cents', () => {
    const ui = edit({ residency: 'foreigner', salary: 7_000, bonus: 7_000, reliefTotal: 0 });
    const r = computePlan(ui, TODAY);
    expect(r.plan.contributions).toEqual({ srs: 10_000, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.savingRate).toBe(0.115);
    expect(stopReason(r, null, { defaultMinimum: minimumIsDefault(ui) })).toBe(
      'Beyond this, each extra dollar would save 7 cents or less, below the default minimum of 11.5 cents.',
    );
    expect(planCautions(r).map((w) => w.code)).toEqual(['SRS_NON_RESIDENT_WITHDRAWAL']);
    expect(planCautions(r)[0]?.message).not.toMatch(/of this plan saves less/);
    // Going all the way down is still allowed, and then the plan says how much of it is a loss on the way out.
    const every = computePlan(edit({ depth: 'every' }, ui), TODAY);
    expect(every.plan.contributions.srs).toBe(35_700);
    expect(planCautions(every)[0]?.message).toContain('S$25,700 of this plan saves less than 7.5 cents per dollar today.');
    expect(foreignerDepthNote(r.rules)).toBe(
      'A foreigner who has left Singapore pays at least 7.5 cents per dollar in tax to take SRS out, so the 7% rung ' +
        'would be a loss. That is why your default is 11.5 cents or more. You can still choose to go deeper.',
    );
    expect(depthExplanation('default', r)).toBe('Only lock away dollars that each save at least 11.5 cents in tax.');
  });

  it('says "the default minimum" whenever the default preset is selected, and "you asked for" for a minimum the person chose', () => {
    const low = { salary: 3_500, bonus: 3_500, reliefTotal: 0, age: 28 };
    const untouched = edit(low);
    expect(minimumIsDefault(untouched)).toBe(true);
    const r = computePlan(untouched, TODAY);
    expect(stopReason(r, null, { defaultMinimum: minimumIsDefault(untouched) })).toBe(
      'Nothing clears the minimum. Each extra dollar would save 3.5 cents or less in tax, and the default minimum is 7 cents.',
    );
    const note = r.warnings.find((w) => w.code === 'BELOW_MIN_SAVING_RATE');
    expect(note).toBeDefined();
    if (note) {
      expect(noticeMessage(note, r, null, { defaultMinimum: true })).toContain('below the default minimum of 7 cents');
      expect(noticeMessage(note, r, null, { defaultMinimum: false })).toContain('below the 7 cents minimum you set');
    }
    // Having been to another setting and back, the default preset is selected again: it is still the default,
    // not something they asked for.
    const back = edit({ depth: 'default' }, edit({ depth: 'every' }, untouched));
    expect(minimumIsDefault(back)).toBe(true);
    expect(stopReason(computePlan(back, TODAY), null, { defaultMinimum: minimumIsDefault(back) })).toBe(
      'Nothing clears the minimum. Each extra dollar would save 3.5 cents or less in tax, and the default minimum is 7 cents.',
    );
    // The same after the default has moved with the residency: a foreigner who once used the control.
    const moved = edit({ residency: 'foreigner', salary: 5_000, bonus: 0 }, edit({ depth: 'default' }, edit({ depth: 'top' })));
    expect(minimumIsDefault(moved)).toBe(true);
    expect(stopReason(computePlan(moved, TODAY), null, { defaultMinimum: minimumIsDefault(moved) })).toBe(
      'Nothing clears the minimum. Each extra dollar would save 7 cents or less in tax, and the default minimum is 11.5 cents.',
    );
    // A minimum they chose is theirs, even at the same figure.
    const custom = edit({ depth: 'custom', customRate: 0.07 }, untouched);
    expect(minimumIsDefault(custom)).toBe(false);
    expect(stopReason(computePlan(custom, TODAY), null, { defaultMinimum: minimumIsDefault(custom) })).toBe(
      'Nothing clears your minimum. Each extra dollar would save 3.5 cents or less in tax, and you asked for at least 7 cents.',
    );
    for (const depth of ['top', 'every', 'custom'] as const) expect(minimumIsDefault(edit({ depth }, untouched))).toBe(false);
  });

  it('a custom minimum starts from the default of the residency on screen until the person picks a rate', () => {
    // A citizen opens Custom, looks, and goes back to the default: nothing was picked.
    const looked = edit({ depth: 'default' }, edit({ depth: 'custom' }));
    expect(customRateOf(edit({ depth: 'custom' }))).toBe(0.07);
    expect(looked.edited).not.toContain('customRate');
    // As a foreigner on S$7,000 a month with a S$7,000 bonus, Custom now opens on 11.5 cents, not on 7.
    const foreigner = edit({ residency: 'foreigner', salary: 7_000, bonus: 7_000, reliefTotal: 0 }, looked);
    const opened = edit({ depth: 'custom' }, foreigner);
    expect(customRateOf(opened)).toBe(0.115);
    expect(toPlannerInput(opened, TODAY).preferences.minSavingRate).toBe(0.115);
    const r = computePlan(opened, TODAY);
    expect(r.plan.contributions.srs).toBe(10_000);
    expect(planCautions(r)[0]?.message).not.toMatch(/of this plan saves less/);
    // And the other way round: a foreigner who looked at Custom and became a citizen starts from 7 cents.
    const citizen = edit({ depth: 'custom' }, edit({ residency: 'citizen' }, edit({ depth: 'default' }, opened)));
    expect(customRateOf(citizen)).toBe(0.07);
    // With Custom still open and no rate picked, the figure moves with the residency, as the default does.
    expect(customRateOf(edit({ residency: 'pr' }, opened))).toBe(0.07);
    // A rate the person picks is theirs and stays through a change of residency, 7 cents included.
    const picked = edit({ customRate: 0.07 }, opened);
    expect(customRateOf(picked)).toBe(0.07);
    expect(computePlan(picked, TODAY).plan.contributions.srs).toBe(35_700);
    expect(customRateOf(edit({ residency: 'citizen' }, picked))).toBe(0.07);
    expect(customRateOf(edit({ residency: 'foreigner' }, edit({ depth: 'custom', customRate: 0.035 })))).toBe(0.035);
    // Numbers saved by the version before the rate was tracked: a foreigner who never picked one gets their
    // own default; numbers with no record of edits at all are the person's own and are kept.
    expect(customRateOf({ customRate: 0.07, residency: 'foreigner', edited: ['salary', 'depth'] })).toBe(0.115);
    const untracked = parseSaved(
      JSON.stringify({ v: 1, theme: 'system', ui: { ...example(), isExample: false, edited: undefined, residency: 'foreigner', depth: 'custom', customRate: 0.035 } }),
      example(),
    );
    expect(customRateOf(untracked?.ui as UiState)).toBe(0.035);
  });

  it("a foreigner's S$0 plan: the way to Every tax dollar says what those dollars cost on the way out", () => {
    // S$7,000 a month and a S$7,000 bonus for five months: nothing clears 11.5 cents.
    const ui = edit({ residency: 'foreigner', salary: 7_000, bonus: 7_000, reliefTotal: 0, monthsWorked: 5 });
    const r = computePlan(ui, TODAY);
    expect(r.plan.totalContribution).toBe(0);
    const deeper = deeperPlan(ui, TODAY, r);
    expect(deeper?.plan).toEqual(computePlan(edit({ depth: 'every' }, ui), TODAY).plan);
    if (!deeper) throw new Error('expected a plan with every tax dollar');
    expect(deeperOffer(deeper)).toBe(
      'Going all the way down the ladder would save S$620.00 by locking away S$21,000: 2.95 cents back per dollar.',
    );
    // Every dollar of it saves less than leaving costs; the amount is the engine's own.
    expect(deeper.warnings.find((w) => w.code === 'SRS_NON_RESIDENT_WITHDRAWAL')?.params?.lowValueAmount).toBe(21_000);
    expect(leavingCaveat(deeper)).toBe(
      'All of that plan saves less than 7.5 cents per dollar, the least you would pay in tax to take SRS out after leaving Singapore.',
    );
    expect(leavingCaveat(deeper)).toContain(`${NON_RESIDENT_SRS_COST.atRetirementOrTenYears * 100} cents`);
    // The note lower down points to the same view, so it carries the same sentence.
    const note = r.warnings.find((w) => w.code === 'BELOW_MIN_SAVING_RATE');
    if (!note) throw new Error('expected the note about the minimum');
    expect(noticeMessage(note, r, null, { defaultMinimum: true, deeperCaveat: leavingCaveat(deeper) })).toMatch(
      /to see a plan with these smaller savings\. All of that plan saves less than 7\.5 cents per dollar/,
    );
    // Part of a plan: a custom minimum above the top rate leaves dollars at 11.5 cents and dollars below 7.5.
    const high = edit({ residency: 'foreigner', salary: 7_000, bonus: 7_000, reliefTotal: 0, depth: 'custom', customRate: 0.15 });
    const part = deeperPlan(high, TODAY, computePlan(high, TODAY));
    if (!part) throw new Error('expected a plan with every tax dollar');
    expect(part.plan.totalContribution).toBe(35_700);
    expect(leavingCaveat(part)).toMatch(/^S\$25,700 of that plan saves less than 7\.5 cents per dollar/);
    // A citizen is told nothing of the kind, and nothing is offered where there is nothing to offer.
    const citizen = edit({ salary: 3_500, bonus: 3_500, reliefTotal: 0, age: 28 });
    const citizenDeeper = deeperPlan(citizen, TODAY, computePlan(citizen, TODAY));
    if (!citizenDeeper) throw new Error('expected a plan with every tax dollar');
    expect(deeperOffer(citizenDeeper)).toContain('2.53 cents back per dollar');
    expect(leavingCaveat(citizenDeeper)).toBe('');
    const citizenNote = computePlan(citizen, TODAY).warnings.find((w) => w.code === 'BELOW_MIN_SAVING_RATE');
    if (!citizenNote) throw new Error('expected the note about the minimum');
    expect(noticeMessage(citizenNote, computePlan(citizen, TODAY), null, { defaultMinimum: true, deeperCaveat: '' })).toMatch(
      /to see these smaller savings\.$/,
    );
    expect(deeperPlan(example(), TODAY, computePlan(example(), TODAY))).toBeNull();
    const every = edit({ depth: 'every' }, citizen);
    expect(deeperPlan(every, TODAY, computePlan(every, TODAY))).toBeNull();
    const closed = edit({ incomeYear: 2025 }, citizen);
    expect(deeperPlan(closed, TODAY, computePlan(closed, TODAY))).toBeNull();
    const noCash = edit({ cashLimit: 0 });
    expect(deeperPlan(noCash, TODAY, computePlan(noCash, TODAY))).toBeNull();
  });
});

describe('computePlan', () => {
  it('reproduces Appendix A.1 for the opening state', () => {
    const r = computePlan(example(), TODAY);
    expect(r.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 });
    expect(r.plan.taxBefore).toBe(6_639);
    expect(r.plan.taxAfter).toBe(3_959.5);
    expect(r.plan.taxSaved).toBe(2_679.5);
    expect(headline(r)).toBe(
      'Put S$15,300 into SRS and S$8,000 into your CPF as a cash top-up. You save S$2,679.50 in tax.',
    );
    expect(summaryText(r, true)).toContain('Tax saved: S$2,679.50 (11.5 cents back per dollar)');
  });

  it('"Top bracket only" stops at the bottom of the current bracket', () => {
    // S$12,000 a month puts chargeable income at S$132,600: S$12,600 sits in the 15% bracket.
    const r = computePlan({ ...example(), salary: 12_000, depth: 'top' }, TODAY);
    expect(r.input.preferences.minSavingRate).toBe(0.15);
    expect(r.plan.totalContribution).toBe(12_600);
    expect(r.plan.bindingConstraint).toBe('usefulRoom');
  });

  it('never quotes a saving that no setting can reach', () => {
    // The opening example is stopped by the scheme limits. The engine's unrealisedSaving (S$2,359.50) assumes
    // room that does not exist; the only thing left to switch on is the family top-up.
    const ui = example();
    const r = computePlan(ui, TODAY);
    expect(r.plan.unrealisedSaving).toBe(2_359.5);
    const hint = whatIf(ui, TODAY, r);
    expect(hint?.kind).toBe('switchOn');
    expect(hint?.levers).toEqual(['cpfFamily']);
    const withFamily = computePlan({ ...ui, useCpfFamily: true }, TODAY);
    expect(hint?.plan.taxSaved).toBe(withFamily.plan.taxSaved);
    const reason = stopReason(r, hint);
    expect(reason).not.toContain('2,359.50');
    expect(reason).toContain('Switching on the CPF cash top-up to family would raise the saving to S$3,478.00');
    expect(stopReason(r)).not.toContain('2,359.50');
    // With everything switched on there is nothing left to suggest.
    expect(whatIf({ ...ui, useCpfFamily: true }, TODAY, withFamily)).toBeNull();
  });

  it('credits a higher saving only to the schemes that would receive money', () => {
    // 57, the room not entered, own CPF and family both switched off: switching both on raises the saving,
    // but every extra dollar goes to family. The engine leaves the own CPF out until its room is entered.
    const ui = edit({ age: 57, useCpfSelf: false });
    const r = computePlan(ui, TODAY);
    expect(r.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 0 });
    const both = computePlan(edit({ useCpfSelf: true, useCpfFamily: true }, ui), TODAY);
    expect(both.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 8_000 });
    const hint = whatIf(ui, TODAY, r);
    expect(hint?.kind).toBe('switchOn');
    expect(hint?.levers).toEqual(['cpfFamily']);
    // The figure is the engine's plan for exactly that change: family on, own CPF still off.
    expect(hint?.plan).toEqual(computePlan(edit({ useCpfFamily: true }, ui), TODAY).plan);
    expect(hint?.plan.taxSaved).toBe(2_679.5);
    const reason = stopReason(r, hint);
    expect(reason).toContain(
      'Switching on the CPF cash top-up to family would raise the saving to S$2,679.50, if you have a family member who qualifies.',
    );
    expect(reason).not.toMatch(/top-up to yourself/);
    // With the room entered, the own CPF would receive money, so it is named too.
    const withRoom = edit({ cpfSelfRoom: 8_000 }, ui);
    const named = whatIf(withRoom, TODAY, computePlan(withRoom, TODAY));
    expect(named?.levers).toEqual(['cpfSelf', 'cpfFamily']);
    const bothWithRoom = computePlan(edit({ useCpfSelf: true, useCpfFamily: true }, withRoom), TODAY).plan;
    expect(bothWithRoom.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 8_000 });
    expect(named?.plan).toEqual(bothWithRoom);
    expect(bothWithRoom.taxSaved).toBe(3_344.8);
    expect(stopReason(computePlan(withRoom, TODAY), named)).toContain(
      'Switching on the CPF cash top-up to yourself and the CPF cash top-up to family would raise the saving to S$3,344.80',
    );
    // Only the own CPF left off, and it would get nothing: there is nothing to suggest.
    const onlySelfOff = edit({ age: 57, useCpfSelf: false, useCpfFamily: true });
    expect(whatIf(onlySelfOff, TODAY, computePlan(onlySelfOff, TODAY))).toBeNull();
    // A scheme the plan would stop short of is not named either. With SRS and family both off and S$13,400
    // of income above the 7% rung, the first in the order (SRS) takes it all and family would get nothing.
    const short = edit({ useSrs: false, existingCpfSelf: 8_000, salary: 6_500, bonus: 0, reliefTotal: 0 });
    const shortResult = computePlan(short, TODAY);
    expect(shortResult.plan.bindingConstraint).toBe('leverLimits');
    const allOn = computePlan(edit({ useSrs: true, useCpfFamily: true }, short), TODAY).plan;
    expect(allOn.contributions).toEqual({ srs: 13_400, cpfSelf: 0, cpfFamily: 0 });
    const shortHint = whatIf(short, TODAY, shortResult);
    expect(shortHint?.levers).toEqual(['srs']);
    expect(shortHint?.plan).toEqual(computePlan(edit({ useSrs: true }, short), TODAY).plan);
    expect(stopReason(shortResult, shortHint)).toBe(
      'The schemes you switched on have no room left for 2026. Switching on SRS would raise the saving to S$938.00.',
    );
  });

  it('says what lifting a cash limit would do, using the engine plan without it', () => {
    const ui: UiState = { ...example(), cashLimit: 10_000 };
    const r = computePlan(ui, TODAY);
    expect(r.plan.bindingConstraint).toBe('cashBudget');
    const hint = whatIf(ui, TODAY, r);
    expect(hint?.kind).toBe('noCashLimit');
    expect(hint?.plan.totalContribution).toBe(23_300);
    expect(stopReason(r, hint)).toBe(
      'This uses your whole S$10,000 cash limit. Without the limit the plan would save S$2,679.50 by locking away S$23,300.',
    );
    expect(inputsSummary(ui, r.input.otherReliefs)).toContain('Cash to spare: S$10,000');
  });

  it('lists the plan in the order chosen under "Which first?"', () => {
    const ui: UiState = { ...example(), order: 'interest' };
    expect(headline(computePlan(ui, TODAY))).toBe(
      'Put S$8,000 into your CPF as a cash top-up and S$15,300 into SRS. You save S$2,679.50 in tax.',
    );
  });

  it('after the deadline, describes the plan as what it would have done', () => {
    const r = computePlan({ ...example(), incomeYear: 2025 }, TODAY);
    expect(r.monthlyPlan.daysToDeadline).toBeLessThan(0);
    const said = headline(r);
    expect(said).not.toMatch(/^Put /);
    expect(said).toContain('The deadline for YA2026 has passed.');
    expect(said).toContain('would have saved S$2,679.50');
    const summary = summaryText(r, false);
    expect(summary).toContain('looking back at YA2026');
    expect(summary).not.toMatch(/You save/);
    expect(summary).toContain('Tax it would have saved: S$2,679.50');
    expect(summary).not.toMatch(/How long it is locked/);
    // The year to offer instead is the one today falls in, while its own deadline is still ahead.
    expect(openIncomeYear(TODAY, 2025)).toBe(2026);
    expect(openIncomeYear(TODAY, 2026)).toBeNull();
    expect(openIncomeYear('2027-01-05', 2026)).toBe(2027);
    expect(openIncomeYear('2028-03-02', 2027)).toBeNull();
  });

  it('flags projected rules in the copied summary', () => {
    const summary = summaryText(computePlan({ ...example(), incomeYear: 2027 }, TODAY), false);
    expect(summary).toMatch(/Projected rules/);
  });

  it('gives a reason for every way a plan can stop', () => {
    const base = example();
    const cases: UiState[] = [
      base,
      { ...base, salary: 3_500, bonus: 3_500, reliefTotal: 0, age: 28 },
      { ...base, salary: 3_500, bonus: 3_500, reliefTotal: 0, age: 28, depth: 'every' },
      { ...base, cashLimit: 5_000 },
      { ...base, cashLimit: 0 },
      { ...base, reliefTotal: 70_000 },
      { ...base, useSrs: false, useCpfSelf: false },
      { ...base, existingSrs: 15_300, existingCpfSelf: 8_000 },
      { ...base, salary: 1_000, bonus: 0 },
      { ...base, residency: 'foreigner' },
      { ...base, age: 57 },
      { ...base, age: 57, useSrs: false },
    ];
    const seen = new Set<string>();
    for (const ui of cases) {
      const r = computePlan(ui, TODAY);
      seen.add(r.plan.bindingConstraint);
      for (const defaultMinimum of [true, false]) {
        const reason = stopReason(r, null, { defaultMinimum });
        expect(reason.length).toBeGreaterThan(20);
        expect(reason).not.toMatch(/NaN|undefined|Infinity/);
      }
    }
    expect([...seen].sort()).toEqual(['cashBudget', 'leverLimits', 'none', 'reliefCap', 'usefulRoom']);
  });

  it('offers custom minimums at or below the current bracket', () => {
    const rules = getRules(2026);
    expect(customRateOptions(rules, 0.115, 0.07)).toEqual([0.115, 0.07, 0.035, 0.02]);
    expect(customRateOptions(rules, 0.035, 0.07)).toEqual([0.07, 0.035, 0.02]);
  });
});

describe('from age 55 the room must be entered (SPEC 6.5)', () => {
  it('a blank room leaves the own CPF out, and the page says so in every place it describes the plan', () => {
    const ui = edit({ age: 57 });
    const r = computePlan(ui, TODAY);
    expect(r.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 0, cpfFamily: 0 });
    expect(r.plan.taxSaved).toBe(1_759.5);
    expect(planCautions(r).map((w) => w.code)).toEqual(['CPF_SELF_ROOM_UNCONFIRMED']);
    const hint = whatIf(ui, TODAY, r);
    const reason = stopReason(r, hint);
    expect(reason).toContain('Your own CPF is left out until you enter how much you can still top up with relief.');
    expect(reason).not.toMatch(/filled every scheme|no room left for it/);
    // The sentence is said once on the card: here the stop reason already carries it.
    expect(leftOutSentence(r)).toBe('');
    const summary = summaryText(r, false, hint);
    expect(summary).toContain('Check before you transfer:');
    expect(summary).toContain(`- ${planCautions(r)[0]?.message}`);
    expect(summary).toContain('S$0 if you have set aside the Full Retirement Sum');
  });

  it('with nothing else to fill, the plan is "nothing yet", never "the schemes are full"', () => {
    const r = computePlan(edit({ age: 57, useSrs: false }), TODAY);
    expect(r.plan.totalContribution).toBe(0);
    expect(nothingText(r)).toBe('Nothing to put in yet');
    expect(headline(r)).toBe('Nothing to put in yet.');
    expect(stopReason(r)).toMatch(/^Nothing can go in yet\. Your own CPF is left out until you enter/);
    expect(ladderEmptyText(r)).toMatch(/^There is no ladder to draw yet\. Your own CPF is left out/);
    expect(nothingText(computePlan(edit({ salary: 3_500, bonus: 3_500, reliefTotal: 0, age: 28 }), TODAY))).toBe(
      'Nothing more to put in this year',
    );
  });

  it('when something else stops the plan, the card still says the own CPF is left out', () => {
    const r = computePlan(edit({ age: 57, cashLimit: 5_000 }), TODAY);
    expect(r.plan.bindingConstraint).toBe('cashBudget');
    expect(leftOutSentence(r)).toBe('Your own CPF is left out until you enter how much you can still top up with relief.');
    expect(summaryText(r, false)).toContain('Your own CPF is left out until you enter');
  });

  it('entering any figure, S$0 included, confirms the room', () => {
    const some = computePlan(edit({ age: 57, cpfSelfRoom: 3_000 }), TODAY);
    expect(some.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 3_000, cpfFamily: 0 });
    expect(planCautions(some)).toEqual([]);
    expect(some.warnings.map((w) => w.code)).toContain('AGE_55_PLUS_TOPUP');
    const none = computePlan(edit({ age: 57, cpfSelfRoom: 0 }), TODAY);
    expect(none.plan.contributions.cpfSelf).toBe(0);
    expect(planCautions(none)).toEqual([]);
    expect(stopReason(none)).toMatch(/^You have filled every scheme you switched on\./);
    const plenty = computePlan(edit({ age: 57, cpfSelfRoom: 50_000 }), TODAY);
    expect(plenty.plan.contributions.cpfSelf).toBe(8_000);
  });

  it('below 55 a blank room still means "not limiting"', () => {
    const r = computePlan(edit({ age: 54 }), TODAY);
    expect(r.plan.contributions.cpfSelf).toBe(8_000);
    expect(planCautions(r)).toEqual([]);
  });

  it('reproduces Appendix A.2 with the room entered, and A.2b with it blank', () => {
    const a2 = edit({
      residency: 'pr',
      prYear: 3,
      age: 57,
      birthMonth: 6,
      salary: 14_000,
      bonus: 40_000,
      reliefTotal: 30_000,
      existingSrs: 5_000,
      useCpfFamily: true,
      cpfFamilyMax: 8_000,
      cpfSelfRoom: 50_000,
      cashLimit: 20_000,
      depth: 'every',
      order: 'interest',
    });
    const r = computePlan(a2, TODAY);
    expect(r.plan.contributions).toEqual({ srs: 10_300, cpfSelf: 8_000, cpfFamily: 1_700 });
    expect(r.plan.taxSaved).toBe(3_000);
    expect(r.warnings.map((w) => w.code)).toEqual(['BUDGET_LIMITS_PLAN', 'AGE_55_PLUS_TOPUP', 'FAMILY_TOPUP_CHECKS']);
    expect(headline(r)).toBe(
      "Put S$8,000 into your CPF as a cash top-up, S$10,300 into SRS and S$1,700 into family members' CPF as a " +
        'cash top-up. You save S$3,000.00 in tax.',
    );
    const blank = computePlan(edit({ cpfSelfRoom: null }, a2), TODAY);
    expect(blank.plan.contributions).toEqual({ srs: 10_300, cpfSelf: 0, cpfFamily: 8_000 });
    expect(blank.plan.taxSaved).toBe(2_745);
    expect(blank.warnings.map((w) => w.code)).toEqual(['LEVER_LIMITS_PLAN', 'CPF_SELF_ROOM_UNCONFIRMED', 'FAMILY_TOPUP_CHECKS']);
    expect(planCautions(blank).map((w) => w.code)).toEqual(['CPF_SELF_ROOM_UNCONFIRMED', 'FAMILY_TOPUP_CHECKS']);
  });
});

describe('cautions beside the answer (SPEC 8.4)', () => {
  it('shows the five with the recommendation and does not repeat them in the list lower down', () => {
    expect([...PLAN_CAUTION_CODES].sort()).toEqual(
      ['CPF_SELF_ROOM_UNCONFIRMED', 'FAMILY_TOPUP_CHECKS', 'PARENTHOOD_TAX_REBATE', 'SRS_NON_RESIDENT_WITHDRAWAL', 'TAX_RESIDENCY_CHECK'],
    );
    const cases: UiState[] = [
      edit({ age: 57, useCpfFamily: true, hasPtr: true }),
      edit({ residency: 'foreigner', monthsWorked: 5, depth: 'every' }),
    ];
    const seen = new Set<string>();
    for (const ui of cases) {
      const r = computePlan(ui, TODAY);
      const beside = planCautions(r);
      const below = listedWarnings(r).map((w) => w.code);
      const summary = summaryText(r, false);
      for (const caution of beside) {
        seen.add(caution.code);
        expect(caution.severity).toBe('caution');
        expect(below).not.toContain(caution.code);
        // The engine's own words travel with the copied plan.
        expect(summary).toContain(caution.message);
      }
    }
    expect([...seen].sort()).toEqual([...PLAN_CAUTION_CODES].sort());
  });

  it('the family caution gives the matched amounts, with no MediSave figure in 2025', () => {
    const family = edit({ useCpfFamily: true });
    const now = planCautions(computePlan(family, TODAY)).find((w) => w.code === 'FAMILY_TOPUP_CHECKS');
    expect(now?.message).toContain('the first S$2,000 a year for a member on the Matched Retirement Savings Scheme, S$1,000 for MediSave');
    const then = planCautions(computePlan(edit({ incomeYear: 2025 }, family), TODAY)).find((w) => w.code === 'FAMILY_TOPUP_CHECKS');
    expect(then?.message).toContain('Matched Retirement Savings Scheme. The amounts here');
    expect(then?.message).not.toMatch(/MediSave/);
    expect(getRules(2025).cpfTopUp.matchedTopUps.mediSaveAnnualCap).toBeNull();
  });

  it('a foreigner who worked five months is asked to check their tax residency', () => {
    const r = computePlan(edit({ residency: 'foreigner', monthsWorked: 5 }), TODAY);
    expect(planCautions(r).map((w) => w.code)).toEqual(['TAX_RESIDENCY_CHECK', 'SRS_NON_RESIDENT_WITHDRAWAL']);
    expect(planCautions(computePlan(edit({ residency: 'foreigner', monthsWorked: 7 }), TODAY)).map((w) => w.code)).toEqual([
      'SRS_NON_RESIDENT_WITHDRAWAL',
    ]);
    // "Broadly": 183 days is the main test, not the only one (SPEC 5.4), and the checklist says it the same way.
    expect(residencyHint('citizen', 2026)).toBe(
      'This tool is for tax residents: broadly, people who stayed or worked in Singapore for at least 183 days in 2026.',
    );
    for (const residency of ['citizen', 'pr', 'foreigner'] as Residency[]) {
      expect(residencyHint(residency, 2026)).toContain('broadly, people who stayed or worked in Singapore for at least 183 days in 2026');
    }
    expect(cautionsFor(r)[0]).toContain('broadly, people who stayed or worked in Singapore for at least 183 days in 2026');
    expect(residencyHint('foreigner', 2026)).toMatch(/A non-resident gets no personal reliefs and no SRS relief\.$/);
  });
});

describe('how long the cash is locked (SPEC 8.4)', () => {
  it('says it for each scheme in the plan, in the words of the spec for a 35-year-old', () => {
    expect(horizonLines(computePlan(example(), TODAY))).toEqual([
      'SRS: locked until 64, about 29 years.',
      'CPF: paid out monthly from 65, about 30 years.',
    ]);
    // Only schemes that are in the plan, in the plan's order.
    expect(horizonLines(computePlan(edit({ useCpfSelf: false }), TODAY))).toEqual(['SRS: locked until 64, about 29 years.']);
    expect(horizonLines(computePlan(edit({ order: 'interest', useSrs: false }), TODAY))).toEqual([
      'CPF: paid out monthly from 65, about 30 years.',
    ]);
    expect(horizonLines(computePlan(edit({ salary: 3_500, bonus: 3_500, reliefTotal: 0, age: 28 }), TODAY))).toEqual([]);
  });

  it('handles someone already at or past those ages, and a year away from them', () => {
    const older = computePlan(edit({ age: 66, cpfSelfRoom: 8_000 }), TODAY);
    expect(horizonLines(older)).toEqual([
      'SRS: locked until 64, an age you have already reached.',
      'CPF: paid out monthly from 65, an age you have already reached.',
    ]);
    const nearly = computePlan(edit({ age: 64, cpfSelfRoom: 8_000 }), TODAY);
    expect(horizonLines(nearly)).toEqual([
      'SRS: locked until 64, an age you have already reached.',
      'CPF: paid out monthly from 65, about 1 year.',
    ]);
    for (const line of [...horizonLines(older), ...horizonLines(nearly)]) expect(line).not.toMatch(/about 0|-\d/);
  });

  it('the SRS age is conditional: a foreigner has the 10-year rule, and an earlier first contribution keeps its own age', () => {
    // A foreigner of 34: "locked until 64, about 30 years" alone would be wrong, since the 10-year rule for
    // foreigners (which the caution under the card and the "Tax later" fact describe) comes first.
    const foreigner = computePlan(edit({ residency: 'foreigner', age: 34, salary: 7_000, bonus: 7_000, reliefTotal: 0 }), TODAY);
    expect(horizonLines(foreigner)).toEqual([
      'SRS: locked until 64, about 30 years, or until you can use the 10-year rule for foreigners if that comes first.',
    ]);
    expect(fact(factsFor(foreigner), 'taxLater', 'srs')).toMatch(/after keeping the account for 10 years \(the rule for foreigners\)/);
    expect(planCautions(foreigner)[0]?.message).toContain('the 10-year rule for foreigners');
    // Citizens and PRs have no such rule, and their line stays the sentence of the spec.
    for (const residency of ['citizen', 'pr'] as Residency[]) {
      expect(horizonLines(computePlan(edit({ residency }), TODAY))[0]).toBe('SRS: locked until 64, about 29 years.');
    }
    // 64 is the age a first contribution made now locks in; an earlier one set its own. Said for everyone
    // with SRS in the plan who has not reached the age shown, whether or not they have contributed this year.
    const note = 'If you have paid into SRS before, your SRS age was set by your first contribution and may be lower than 64.';
    expect(horizonNote(computePlan(example(), TODAY))).toBe(note);
    expect(horizonNote(foreigner)).toBe(note);
    const earlier = computePlan(edit({ residency: 'pr', age: 57, existingSrs: 5_000, cpfSelfRoom: 0 }), TODAY);
    expect(horizonLines(earlier)).toEqual(['SRS: locked until 64, about 7 years.']);
    expect(horizonNote(earlier)).toBe(note);
    // The ages themselves are the engine's "Locked until" fact, not a second copy here.
    expect(fact(factsFor(earlier), 'lockedUntil', 'srs')).toMatch(/64 if that is on or after 1 July 2026, 63 if it was between/);
    // Nothing to qualify without SRS in the plan, at or past the age, on a S$0 plan, or in a closed year.
    expect(horizonNote(computePlan(edit({ useSrs: false }), TODAY))).toBe('');
    const past64 = computePlan(edit({ residency: 'foreigner', age: 66 }), TODAY);
    expect(horizonLines(past64)).toEqual(['SRS: locked until 64, an age you have already reached.']);
    expect(horizonNote(past64)).toBe('');
    expect(horizonNote(computePlan(edit({ salary: 3_500, bonus: 3_500, reliefTotal: 0, age: 28 }), TODAY))).toBe('');
    // The copied summary carries the condition with the lines; a closed year has neither.
    expect(summaryText(computePlan(example(), TODAY), true)).toContain(
      `How long it is locked: SRS: locked until 64, about 29 years. CPF: paid out monthly from 65, about 30 years. ${note}`,
    );
    expect(summaryText(foreigner, false)).toContain(
      `How long it is locked: SRS: locked until 64, about 30 years, or until you can use the 10-year rule for foreigners if that comes first. ${note}`,
    );
    expect(summaryText(computePlan(edit({ incomeYear: 2025 }), TODAY), false)).not.toMatch(/paid into SRS before/);
  });

  it('a family top-up is not locked for a time but given away, and the line says so in the shared wording', () => {
    const r = computePlan(edit({ useCpfFamily: true }), TODAY);
    const lines = horizonLines(r);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(`Family top-up: ${fact(factsFor(r), 'sooner', 'cpfFamily')}`);
    expect(lines[2]).toBe('Family top-up: You cannot take it back. A top-up cannot be reversed.');
    // It stands on its own when the person's own CPF is not in the plan beside it.
    expect(horizonLines(computePlan(edit({ age: 57, useCpfFamily: true }), TODAY))).toEqual([
      'SRS: locked until 64, about 7 years.',
      'Family top-up: You cannot take it back. A top-up cannot be reversed.',
    ]);
    expect(summaryText(r, false)).toContain('How long it is locked: SRS: locked until 64, about 29 years. CPF: paid out');
  });
});

describe('monthly plan (SPEC 8.4 item 4)', () => {
  it('says when an instalment is larger than the monthly salary, in the sentence of the spec', () => {
    const modest = computePlan(edit({ age: 29, salary: 5_200, bonus: 10_400, reliefTotal: 0 }), TODAY);
    expect(affordabilityNote(modest)).toEqual({
      amount: 8_620,
      text: 'S$8,620 a month is more than your monthly salary. It would have to come from your bonus or savings.',
    });
    // An instalment the salary covers needs no note; nor does a plan with no salary entered or a closed year.
    expect(affordabilityNote(computePlan(edit({ cashLimit: 10_000 }), TODAY))).toBeNull();
    expect(affordabilityNote(computePlan(edit({ salary: 0, bonus: 200_000 }), TODAY))).toBeNull();
    expect(affordabilityNote(computePlan(edit({ incomeYear: 2025 }), TODAY))).toBeNull();
    // An annual salary is compared month for month.
    const annual = computePlan(edit({ payMode: 'annual', salary: 62_400, age: 29, bonus: 10_400, reliefTotal: 0 }), TODAY);
    expect(affordabilityNote(annual)?.amount).toBe(8_620);
  });

  it('gives the cut-off only for a scheme that is in the plan', () => {
    const both = computePlan(example(), TODAY);
    expect(deadlineLines(both).map((line) => line.term)).toEqual(['SRS', 'CPF cash top-up']);
    expect(deadlineLines(both)[0]?.text).toBe(fact(factsFor(both), 'deadline', 'srs'));
    const foreigner = computePlan(edit({ residency: 'foreigner' }), TODAY);
    expect(deadlineLines(foreigner).map((line) => line.term)).toEqual(['SRS']);
    expect(deadlineLines(foreigner).map((line) => line.text).join(' ')).not.toMatch(/CPF/);
    const cpfOnly = computePlan(edit({ useSrs: false, useCpfFamily: true }), TODAY);
    expect(deadlineLines(cpfOnly).map((line) => line.term)).toEqual(['CPF cash top-up']);
    expect(deadlineLines(cpfOnly).map((line) => line.text).join(' ')).not.toMatch(/bank/i);
    expect(deadlineLines(computePlan(edit({ salary: 3_500, bonus: 3_500, reliefTotal: 0, age: 28 }), TODAY))).toEqual([]);
  });

  it('words the January figure as cash top-ups too', () => {
    expect(fullYearSplit(computePlan(example(), TODAY))).toBe('S$1,275 into SRS and S$667 into your CPF as a cash top-up');
  });
});

describe('a CPF amount is always worded as a cash top-up (SPEC 8.4)', () => {
  it('in the headline, the summary and the monthly lines, for self and for family', () => {
    const r = computePlan(edit({ useCpfFamily: true }), TODAY);
    const said = headline(r);
    expect(said).toContain('S$8,000 into your CPF as a cash top-up');
    expect(said).toContain("S$8,000 into family members' CPF as a cash top-up");
    const summary = summaryText(r, false);
    expect(summary).toContain('- CPF cash top-up, self: S$8,000');
    expect(summary).toContain('- CPF cash top-up, family: S$8,000');
    expect(summary).toContain('(SRS S$7,650; CPF cash top-up, self S$4,000; CPF cash top-up, family S$4,000)');
    // Nowhere does a CPF amount stand as just "into your CPF" or "into family members' CPF".
    for (const text of [said, summary]) {
      expect(text).not.toMatch(/into your CPF(?! as a cash top-up)/);
      expect(text).not.toMatch(/into family members' CPF(?! as a cash top-up)/);
    }
  });
});

describe('itemising other reliefs (SPEC 8.3)', () => {
  const rules = getRules(2026);

  it('does not turn the untouched example total into the figure of the person', () => {
    // Somebody has typed their salary; the S$5,000 of other reliefs is still the example's.
    const own = edit({ salary: 5_200 });
    expect(exampleLeft(own, example())).toContain('other reliefs');
    const patch = switchReliefMode(own, 'itemised', rules);
    expect(patch).toEqual({ reliefMode: 'itemised' });
    const itemising = edit(patch, own);
    // The helper opens empty; the example's total is still counted and still named as the example's.
    expect(itemising.reliefItems).toEqual({});
    expect(reliefsUntouched(itemising)).toBe(true);
    expect(otherReliefsOf(itemising, rules)).toBe(5_000);
    expect(exampleLeft(itemising, example())).toContain('other reliefs');
    expect(computePlan(itemising, TODAY).plan.taxSaved).toBe(computePlan(own, TODAY).plan.taxSaved);
    // Back again without entering anything: still the example's, still flagged.
    const back = edit(switchReliefMode(itemising, 'total', rules), itemising);
    expect(back.reliefTotal).toBe(5_000);
    expect(exampleLeft(back, example())).toContain('other reliefs');
  });

  it('the helper takes over as soon as something is entered in it, S$0 included', () => {
    const itemising = edit({ reliefMode: 'itemised' }, edit({ salary: 5_200 }));
    const entered = edit({ reliefItems: { spouse: 1 } }, itemising);
    expect(otherReliefsOf(entered, rules)).toBe(2_000);
    expect(exampleLeft(entered, example())).not.toContain('other reliefs');
    // "I have none of these": an empty list that the person has confirmed counts as S$0.
    const none = edit({ reliefItems: {} }, itemising);
    expect(otherReliefsOf(none, rules)).toBe(0);
    expect(exampleLeft(none, example())).not.toContain('other reliefs');
    // And back to one total: the field takes the itemised sum.
    expect(switchReliefMode(entered, 'total', rules)).toEqual({ reliefMode: 'total', reliefTotal: 2_000 });
  });

  it('switching on the untouched example alone leaves the page an example', () => {
    const start = example();
    const itemising = edit(switchReliefMode(start, 'itemised', rules), start);
    expect(itemising.isExample).toBe(true);
    expect(computePlan(itemising, TODAY).plan.taxSaved).toBe(2_679.5);
    expect(serialiseSaved(itemising, 'system')).toBe(JSON.stringify({ v: 1, theme: 'system', ui: null }));
    // The calendar moving on keeps the view the person chose.
    expect(followCalendar(itemising, exampleState('2026-11-14'), start).reliefMode).toBe('itemised');
  });

  it('a total the person typed still converts both ways', () => {
    const typed = edit({ reliefTotal: 6_500 });
    const toHelper = switchReliefMode(typed, 'itemised', rules);
    expect(toHelper).toEqual({ reliefMode: 'itemised', reliefItems: { other: 6_500 } });
    const itemising = edit(toHelper, typed);
    expect(otherReliefsOf(itemising, rules)).toBe(6_500);
    const more = edit({ reliefItems: { ...itemising.reliefItems, spouse: 1 } }, itemising);
    expect(switchReliefMode(more, 'total', rules)).toEqual({ reliefMode: 'total', reliefTotal: 8_500 });
    // A typed S$0 is the person's figure too: nothing is carried, and nothing of the example comes back.
    const zero = edit({ reliefTotal: 0 });
    const zeroItemised = edit(switchReliefMode(zero, 'itemised', rules), zero);
    expect(otherReliefsOf(zeroItemised, rules)).toBe(0);
    expect(switchReliefMode(typed, 'total', rules)).toEqual({});
  });
});

describe('simulator rows (SPEC 8.4 item 5)', () => {
  it("adds a row at the plan's own total when the step does not land on it", () => {
    // A plan of S$17,240 in S$1,000 steps: the engine has rows at S$17,000 and S$18,000.
    const r = computePlan(edit({ age: 29, salary: 5_200, bonus: 10_400, reliefTotal: 0 }), TODAY);
    expect(r.plan.totalContribution).toBe(17_240);
    expect(r.simulator.some((row) => row.contribution === 17_240)).toBe(false);
    const rows = simulatorSteps(r);
    expect(rows).toHaveLength(r.simulator.length + 1);
    const at = rows.findIndex((row) => row.planTotal);
    const added = rows[at];
    const next = rows[at + 1];
    expect(added?.contribution).toBe(17_240);
    expect(added?.split).toEqual(r.plan.contributions);
    expect(added?.withinPlan).toBe(true);
    expect(added?.taxPayable).toBe(evaluate(r.input, r.plan.contributions).taxPayable);
    expect(added?.taxPayable).toBe(r.plan.taxAfter);
    expect(added?.taxSaved).toBe(r.plan.taxSaved);
    // The last step inside the plan and the first one beyond it each show their own rate.
    expect(added?.stepSaving).toBe(16.8);
    expect(added?.stepRate).toBeCloseTo(0.07, 10);
    expect(next?.contribution).toBe(18_000);
    expect(next?.withinPlan).toBe(false);
    expect(next?.stepSaving).toBe(26.6);
    expect(next?.stepRate).toBeCloseTo(0.035, 10);
    // The steps still add up to the engine's totals, and every other row is the engine's own.
    const last = rows[rows.length - 1];
    const sum = Math.round(rows.reduce((total, row) => total + row.stepSaving, 0) * 100) / 100;
    expect(sum).toBe(last?.taxSaved);
    expect(rows.filter((row) => !row.planTotal && row.contribution !== 18_000)).toEqual(
      r.simulator.filter((row) => row.contribution !== 18_000),
    );
  });

  it('adds nothing when a row already sits on the plan total, or the plan is S$0', () => {
    const exampleRows = simulatorSteps(computePlan(example(), TODAY));
    expect(exampleRows).toHaveLength(25);
    expect(exampleRows.filter((row) => row.planTotal).map((row) => row.contribution)).toEqual([23_300]);
    const nothing = computePlan(edit({ salary: 3_500, bonus: 3_500, reliefTotal: 0, age: 28 }), TODAY);
    expect(simulatorSteps(nothing)).toEqual(nothing.simulator);
  });
});

describe('the shared facts are rendered, not rewritten (SPEC 7)', () => {
  const profiles: { residency: Residency; ageAtYearEnd: number }[] = [
    { residency: 'citizen', ageAtYearEnd: 35 },
    { residency: 'pr', ageAtYearEnd: 57 },
    { residency: 'foreigner', ageAtYearEnd: 35 },
  ];

  it('the page shows the engine wording for this person', () => {
    const r = computePlan(edit({ age: 57 }), TODAY);
    expect(factsFor(r)).toEqual(lockUpFacts(r.rules, { residency: 'citizen', ageAtYearEnd: 57 }));
    expect(factsFor(r)).toHaveLength(9);
    expect(cautionsFor(r)).toEqual(transferCautions(r.rules, { residency: 'citizen', ageAtYearEnd: 57 }, { deadlinePassed: false }));
    const closed = computePlan(edit({ incomeYear: 2025 }), TODAY);
    expect(cautionsFor(closed)).toEqual(
      transferCautions(closed.rules, { residency: 'citizen', ageAtYearEnd: 35 }, { deadlinePassed: true }),
    );
    expect(notModelledFor(r)).toEqual(NOT_MODELLED);
    expect(summaryText(r, false).endsWith(DISCLAIMER)).toBe(true);
    // The reasons under "Which first?" are the same facts.
    expect(orderWhy('flexibility', factsFor(r)).map((why) => why.text)).toEqual([
      fact(factsFor(r), 'sooner', 'srs'),
      fact(factsFor(r), 'sooner', 'cpfSelf'),
    ]);
    expect(orderWhy('interest', factsFor(r))[0]?.text).toBe(fact(factsFor(r), 'earns', 'cpfSelf'));
  });

  it('the hints that repeat a caution show the caution of the engine, whole', () => {
    // Beside "Most I would give": what to count in a family top-up, with the matched amounts of the year.
    for (const year of SUPPORTED_INCOME_YEARS) {
      const r = computePlan(edit({ incomeYear: year, useCpfFamily: true }), TODAY);
      const { retirementAnnualCap, mediSaveAnnualCap } = r.rules.cpfTopUp.matchedTopUps;
      const hint = familyCaution(r);
      expect(cautionsFor(r).filter((line) => line === hint)).toHaveLength(1);
      expect(cautionsFor(r).filter((line) => /family top-up/i.test(line))).toEqual([hint]);
      expect(hint).toContain('count only what the Government does not match');
      expect(hint).toContain(`the first S$${retirementAnnualCap.toLocaleString('en-SG')} a year`);
      if (mediSaveAnnualCap === null) expect(hint).not.toMatch(/MediSave/);
      else expect(hint).toContain(`the first S$${mediSaveAnnualCap.toLocaleString('en-SG')} a year to MediSave`);
    }
    expect(getRules(2025).cpfTopUp.matchedTopUps.mediSaveAnnualCap).toBeNull();
    expect(familyCaution(computePlan(example(), TODAY))).toBe(
      'For a family top-up, check that the family member qualifies and count only what the Government does not ' +
        'match: the first S$2,000 a year topped up for a member on the Matched Retirement Savings Scheme, and the ' +
        'first S$1,000 a year to MediSave for a member on the Matched MediSave Scheme earns you no relief. A top-up ' +
        'cannot be reversed.',
    );
    // On "Top-up that can still earn relief" from 55: where the figure is found, and why it matters.
    const older = computePlan(edit({ age: 57 }), TODAY);
    expect(cautionsFor(older)).toContain(balanceCaution(older));
    expect(balanceCaution(older)).toMatch(/^Log in to CPF and open the Retirement dashboard to see how much you can still top up with tax relief\./);
    expect(balanceCaution(computePlan(example(), TODAY))).toMatch(/^Log in to CPF to see how far your Special Account/);
    // A foreigner has neither option, and the engine has neither line for them.
    const foreigner = computePlan(edit({ residency: 'foreigner' }), TODAY);
    expect(familyCaution(foreigner)).toBe('');
    expect(balanceCaution(foreigner)).toBe('');
  });

  describe('no second copy of that wording is kept anywhere in src/web', () => {
    const RUN = 6;
    /** Lower-case words, with every figure (S$2,000, 183, 4%, YA2027) turned into a break that no run crosses. */
    const wordsOf = (text: string): string[] =>
      text
        .toLowerCase()
        .replace(/['’\\]/g, '')
        .replace(/s\$[\d,]+|\d[\d,.]*%?/g, ' # ')
        .replace(/[^a-z#]+/g, ' ')
        .split(' ')
        .filter(Boolean);
    const runsOf = (text: string): string[] => {
      const words = wordsOf(text);
      const out: string[] = [];
      for (let i = 0; i + RUN <= words.length; i += 1) {
        const run = words.slice(i, i + RUN);
        if (!run.includes('#')) out.push(run.join(' '));
      }
      return out;
    };
    // Every run of six words in anything the engine can return for these people and years.
    const engineRuns = new Set<string>();
    for (const year of SUPPORTED_INCOME_YEARS) {
      for (const profile of profiles) {
        for (const row of lockUpFacts(getRules(year), profile)) Object.values(row.values).forEach((v) => runsOf(v).forEach((run) => engineRuns.add(run)));
        for (const passed of [true, false]) {
          transferCautions(getRules(year), profile, { deadlinePassed: passed }).forEach((line) => runsOf(line).forEach((run) => engineRuns.add(run)));
        }
      }
    }
    NOT_MODELLED.forEach((line) => runsOf(line).forEach((run) => engineRuns.add(run)));
    runsOf(DISCLAIMER).forEach((run) => engineRuns.add(run));
    /** The runs of six words that a piece of source text shares with the engine's wording. */
    const shared = (text: string): string[] => [...new Set(runsOf(text).filter((run) => engineRuns.has(run)))];

    /**
     * Three phrases the page writes itself although part of each also occurs in the shared facts. Each is tied
     * to its own source by a check below, so none of them can drift on its own. Nothing else is excused.
     */
    const EXCUSED = [
      // What the own CPF waits for, in the words of the engine's CPF_SELF_ROOM_UNCONFIRMED message (SPEC 6.11).
      'until you enter how much you can still top up with relief',
      // The closing words of the engine's DEADLINE_PASSED message (SPEC 6.11), said again on the card.
      'Money you put in now counts for the following year instead',
      // SPEC 5.4 "Tax residency", which the line under Residency follows; the engine's first check uses the same
      // words ("broadly, people who stayed or worked in Singapore for at least 183 days").
      'broadly, people who stayed or worked in Singapore for at least',
    ];
    const excused = (run: string): boolean => EXCUSED.some((phrase) => ` ${wordsOf(phrase).join(' ')} `.includes(` ${run} `));

    it('covers the wording of the engine', () => {
      expect(engineRuns.size).toBeGreaterThan(600);
    });

    it('finds a copy even when it has been reworded here and there', () => {
      // The hint beside "Most I would give" as it was once written by hand: two words away from the engine's.
      const handWritten =
        'Count only what the Government does not match. The matched part earns you no relief: the first ' +
        '${dollars(matched.retirementAnnualCap)} a year for a member on the Matched Retirement Savings Scheme, and ' +
        'the first ${dollars(matched.mediSaveAnnualCap)} a year to MediSave for a member on the Matched MediSave Scheme.';
      expect(shared(handWritten).length).toBeGreaterThan(5);
      expect(shared(handWritten)).toContain('a year to medisave for a');
      // A whole sentence, a sentence split across two string literals, and one with a figure changed.
      expect(shared('You cannot take it back. A top-up cannot be reversed.').length).toBeGreaterThan(0);
      expect(shared("'Banks stop taking same-day SRS contributions before ' +\n  'midnight on the last day'").length).toBeGreaterThan(0);
      expect(shared('At least 5% a year until the end of 2029, the date to which the floor has been extended.').length).toBeGreaterThan(0);
      // Plain page copy shares nothing.
      expect(shared('Put S$15,300 into SRS and S$8,000 into your CPF as a cash top-up. You save S$2,679.50 in tax.')).toEqual([]);
    });

    it('src/web shares no run of six words with it, beyond three phrases that are held to their own sources', () => {
      const dir = resolve(__dirname, '../../src/web');
      const files = [
        ...readdirSync(dir).map((name) => join(dir, name)),
        ...readdirSync(join(dir, 'components')).map((name) => join(dir, 'components', name)),
      ].filter((file) => /\.(ts|tsx)$/.test(file));
      expect(files.length).toBeGreaterThan(10);
      const copied: string[] = [];
      for (const file of files) {
        // Comments are not shown to anyone; everything else in the file is read as words.
        const code = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/^\s*\/\/.*$/gm, ' ');
        for (const run of shared(code)) if (!excused(run)) copied.push(`${file.slice(dir.length + 1)}: "${run}"`);
      }
      expect(copied).toEqual([]);
    });

    it('holds each excused phrase to the source it comes from', () => {
      // 1. The engine's caution for a room that has not been entered, and every place the page says it.
      const waiting = computePlan(edit({ age: 57, cashLimit: 5_000 }), TODAY);
      const caution = waiting.warnings.find((w) => w.code === 'CPF_SELF_ROOM_UNCONFIRMED');
      expect(caution?.message).toContain(`Your own CPF is left out ${EXCUSED[0]}`);
      expect(leftOutSentence(waiting)).toBe(`Your own CPF is left out ${EXCUSED[0]}.`);
      expect(compareLeftOut(waiting)).toBe(` Your own CPF is left out of them ${EXCUSED[0]}.`);
      expect(compareLeftOut(computePlan(example(), TODAY))).toBe('');
      // 2. The engine's message once the deadline has passed.
      const closed = computePlan(edit({ incomeYear: 2025 }), TODAY);
      expect(COUNTS_NEXT_YEAR).toBe(`${EXCUSED[1]}.`);
      expect(closed.warnings.find((w) => w.code === 'DEADLINE_PASSED')?.message.endsWith(COUNTS_NEXT_YEAR)).toBe(true);
      // 3. The spec's own paragraph on tax residency.
      const spec = readFileSync(resolve(__dirname, '../../SPEC.md'), 'utf8').replace(/\s+/g, ' ');
      expect(spec).toContain('stayed or worked in Singapore for at least 183 days');
      expect(residencyHint('pr', 2026)).toContain(`${EXCUSED[2]} 183 days in 2026`);
      expect(cautionsFor(computePlan(edit({}), TODAY))[0]).toContain(`${EXCUSED[2]} 183 days in 2026`);
    });
  });
});

describe("a foreigner's page says nothing about CPF top-ups that are not open to them", () => {
  const foreigner = (): UiState => edit({ residency: 'foreigner', salary: 7_000, bonus: 7_000, reliefTotal: 0 });

  it('in the words this page writes itself', () => {
    const r = computePlan(foreigner(), TODAY);
    const own = [
      headline(r),
      stopReason(r),
      ...horizonLines(r),
      ...newToThis(r).map((line) => `${line.term}: ${line.text}`),
      ...approximations(r),
      ...deadlineLines(r).map((line) => `${line.term}: ${line.text}`),
      ...notModelledFor(r),
      depthExplanation('default', r),
      foreignerDepthNote(r.rules),
      residencyHint('foreigner', 2026),
      ...inputsSummary(foreigner(), 0),
    ].join('\n');
    // (One shared line names CPF in passing: what the tool leaves out about "returns inside SRS or CPF".)
    expect(own.replace('Investment returns inside SRS or CPF', '')).not.toMatch(/CPF/);
    // The two entries that are about CPF alone are the only ones left off, and the rest are word for word.
    expect(NOT_MODELLED.filter((line) => !notModelledFor(r).includes(line))).toEqual([
      'Your CPF balances, whether a top-up attracts a matching grant, and whether a family member qualifies.',
      'Voluntary contributions to all three CPF accounts, which earn an employee no tax relief.',
    ]);
    expect(sourcesFor(r).map((s) => s.label).join(' ')).not.toMatch(/CPF/);
    expect(sourcesFor(r).length).toBeGreaterThan(2);
    // A citizen is told all of it.
    const citizen = computePlan(example(), TODAY);
    expect(newToThis(citizen).map((line) => line.term)).toEqual(['SRS', 'CPF cash top-up', 'Claiming']);
    expect(newToThis(r).map((line) => line.term)).toEqual(['SRS', 'Claiming']);
    expect(approximations(citizen).join(' ')).toMatch(/Employee CPF/);
    expect(sourcesFor(citizen)).toEqual(citizen.rules.sources);
    expect(notModelledFor(citizen)).toEqual(NOT_MODELLED);
  });
});

describe('the link to the paid workbook', () => {
  it('is only ever made from a web address', () => {
    expect(safeWebAddress('https://example.com/workbook?ref=calc')).toBe('https://example.com/workbook?ref=calc');
    expect(safeWebAddress('  http://example.com/x  ')).toBe('http://example.com/x');
    for (const bad of [undefined, null, '', '   ', 'javascript:alert(1)', 'data:text/html,x', '/local', 'example.com', 'https://a b', 'https://x"onclick="y', 12]) {
      expect(safeWebAddress(bad)).toBe('');
    }
  });
});

describe('band table', () => {
  it('slices the engine tax by band and adds back up to it', () => {
    const r = plan(defaultInput(TODAY));
    const rows = bandRows(r.rules, r.baseline.chargeableIncome, r.optimised.chargeableIncome);
    expect(rows.map((b) => b.before.tax)).toEqual([0, 200, 350, 2_800, 3_289]);
    expect(rows.map((b) => b.after.tax)).toEqual([0, 200, 350, 2_800, 609.5]);
    const sum = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(sum(rows.map((b) => b.before.tax))).toBe(r.baseline.grossTax);
    expect(sum(rows.map((b) => b.after.tax))).toBe(r.optimised.grossTax);
    expect(sum(rows.map((b) => b.after.income))).toBe(r.optimised.chargeableIncome);
  });
});

describe('persistence', () => {
  it('uses a versioned key and round-trips a state', () => {
    expect(STORAGE_KEY).toBe('sgto:v1');
    const ui: UiState = { ...example(), isExample: false, salary: 12_000, cashLimit: 9_000, depth: 'every', hasPtr: true };
    const saved = parseSaved(serialiseSaved(ui, 'dark'), example());
    expect(saved?.ui).toEqual(ui);
    expect(saved?.theme).toBe('dark');
  });

  it('does not restore the untouched example, only the theme', () => {
    const saved = parseSaved(serialiseSaved(example(), 'dark'), example());
    expect(saved?.ui).toBeNull();
    expect(saved?.theme).toBe('dark');
    // Data written by an earlier build, which stored the example like any other state.
    const old = JSON.stringify({ v: 1, theme: 'light', ui: { ...example(), incomeYear: 2025 } });
    expect(parseSaved(old, example())?.ui).toBeNull();
  });

  it('ignores unparseable or outdated data', () => {
    expect(parseSaved(null, example())).toBeNull();
    expect(parseSaved('{not json', example())).toBeNull();
    expect(parseSaved(JSON.stringify({ v: 0, ui: example() }), example())).toBeNull();
    expect(parseSaved(JSON.stringify({ v: 1, ui: 'nope' }), example())).toBeNull();
    expect(parseSaved('[]', example())).toBeNull();
  });

  it('repairs fields of the wrong type instead of trusting them', () => {
    const raw = {
      v: 1,
      theme: 'neon',
      ui: { ...example(), isExample: false, salary: 'lots', incomeYear: 1999, depth: 'deep', age: 400, cpfOverride: 'x', hasPtr: 'yes' },
    };
    const saved = parseSaved(JSON.stringify(raw), example());
    expect(saved?.theme).toBe('system');
    expect(saved?.ui?.salary).toBe(10_000);
    expect(saved?.ui?.incomeYear).toBe(2026);
    expect(saved?.ui?.depth).toBe('default');
    expect(saved?.ui?.age).toBe(120);
    expect(saved?.ui?.cpfOverride).toBeNull();
    expect(saved?.ui?.salaryOther).toBeNull();
    expect(saved?.ui?.hasPtr).toBe(false);
  });

  it('loads numbers saved by the previous version of the page', () => {
    // Exactly what version 1.0.0 wrote: the default preset was called 'worth', and there was no tick-box.
    const previous = {
      isExample: false,
      edited: ['salary', 'age'],
      incomeYear: 2026,
      residency: 'citizen',
      prYear: 3,
      age: 41,
      birthMonth: 12,
      payMode: 'monthly',
      salary: 12_000,
      salaryOther: null,
      bonus: 15_000,
      monthsWorked: 12,
      otherIncome: 0,
      expenses: 0,
      donations: 0,
      cpfOverrideOn: false,
      cpfOverride: null,
      existingSrs: 0,
      existingCpfSelf: 0,
      existingCpfFamily: 0,
      reliefMode: 'total',
      reliefTotal: 5_000,
      reliefItems: {},
      useSrs: true,
      useCpfSelf: true,
      useCpfFamily: false,
      cpfSelfRoom: null,
      cpfFamilyMax: null,
      depth: 'worth',
      customRate: 0.07,
      cashLimit: null,
      order: 'flexibility',
      simulatorStep: 1000,
    };
    const saved = parseSaved(JSON.stringify({ v: 1, theme: 'system', ui: previous }), example());
    expect(saved?.ui).toEqual({ ...previous, depth: 'default', hasPtr: false });
    const ui = saved?.ui as UiState;
    expect(toPlannerInput(ui, TODAY).preferences.minSavingRate).toBe(0.07);
    expect(computePlan(ui, TODAY).plan.taxSaved).toBe(3_120.5);
    // The figures the person had not set are still named as the example's.
    expect(exampleLeft(ui, example())).toEqual(['bonus', 'other reliefs']);
    // A foreigner's saved default is the default still: it now steps over the rung that loses money.
    const foreigner = parseSaved(JSON.stringify({ v: 1, theme: 'system', ui: { ...previous, residency: 'foreigner' } }), example());
    expect(foreigner?.ui?.depth).toBe('default');
    expect(toPlannerInput(foreigner?.ui as UiState, TODAY).preferences.minSavingRate).toBe(0.115);
    // Somebody aged 57 who had left the room blank now has their own CPF left out until they enter it.
    const older = parseSaved(JSON.stringify({ v: 1, theme: 'system', ui: { ...previous, age: 57 } }), example());
    expect(computePlan(older?.ui as UiState, TODAY).plan.contributions.cpfSelf).toBe(0);
  });
});
