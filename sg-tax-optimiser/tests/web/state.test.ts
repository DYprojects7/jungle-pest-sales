import { describe, expect, it } from 'vitest';
import { defaultInput, getRules, plan } from '../../src/engine';
import {
  STORAGE_KEY,
  computePlan,
  customRateOptions,
  exampleState,
  itemisedReliefTotal,
  monthlyWage,
  oddPay,
  openIncomeYear,
  parseSaved,
  serialiseSaved,
  switchPayMode,
  toPlannerInput,
  whatIf,
} from '../../src/web/state';
import type { UiState } from '../../src/web/state';
import { headline, stopReason, summaryText } from '../../src/web/text';
import { bandRows } from '../../src/web/bands';

const TODAY = '2026-11-13';
const example = (): UiState => exampleState(TODAY);

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
    expect(toPlannerInput({ ...ui, depth: 'worth' }, TODAY).preferences.minSavingRate).toBe(0.07);
    expect(toPlannerInput({ ...ui, depth: 'custom', customRate: 0.035 }, TODAY).preferences.minSavingRate).toBe(0.035);
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
    const ui: UiState = { ...example(), reliefMode: 'itemised', reliefItems: values, reliefTotal: 5_000 };
    expect(toPlannerInput(ui, TODAY).otherReliefs).toBe(36_000);
  });
});

describe('computePlan', () => {
  it('reproduces Appendix A.1 for the opening state', () => {
    const r = computePlan(example(), TODAY);
    expect(r.plan.contributions).toEqual({ srs: 15_300, cpfSelf: 8_000, cpfFamily: 0 });
    expect(r.plan.taxBefore).toBe(6_639);
    expect(r.plan.taxAfter).toBe(3_959.5);
    expect(r.plan.taxSaved).toBe(2_679.5);
    expect(headline(r)).toBe('Put S$15,300 into SRS and S$8,000 into your CPF. You save S$2,679.50 in tax.');
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
    expect(reason).toContain('Switching on the family CPF top-up would raise the saving to S$3,478.00');
    expect(stopReason(r)).not.toContain('2,359.50');
    // With everything switched on there is nothing left to suggest.
    expect(whatIf({ ...ui, useCpfFamily: true }, TODAY, withFamily)).toBeNull();
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
  });

  it('lists the plan in the order chosen under "Which first?"', () => {
    const ui: UiState = { ...example(), order: 'interest' };
    expect(headline(computePlan(ui, TODAY))).toBe(
      'Put S$8,000 into your CPF and S$15,300 into SRS. You save S$2,679.50 in tax.',
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
    ];
    const seen = new Set<string>();
    for (const ui of cases) {
      const r = computePlan(ui, TODAY);
      seen.add(r.plan.bindingConstraint);
      const reason = stopReason(r);
      expect(reason.length).toBeGreaterThan(20);
      expect(reason).not.toMatch(/NaN|undefined|Infinity/);
    }
    expect([...seen].sort()).toEqual(['cashBudget', 'leverLimits', 'none', 'reliefCap', 'usefulRoom']);
  });

  it('offers custom minimums at or below the current bracket', () => {
    const rules = getRules(2026);
    expect(customRateOptions(rules, 0.115, 0.07)).toEqual([0.115, 0.07, 0.035, 0.02]);
    expect(customRateOptions(rules, 0.035, 0.07)).toEqual([0.07, 0.035, 0.02]);
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
    const ui: UiState = { ...example(), isExample: false, salary: 12_000, cashLimit: 9_000, depth: 'every' };
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
      ui: { ...example(), isExample: false, salary: 'lots', incomeYear: 1999, depth: 'deep', age: 400, cpfOverride: 'x' },
    };
    const saved = parseSaved(JSON.stringify(raw), example());
    expect(saved?.theme).toBe('system');
    expect(saved?.ui?.salary).toBe(10_000);
    expect(saved?.ui?.incomeYear).toBe(2026);
    expect(saved?.ui?.depth).toBe('worth');
    expect(saved?.ui?.age).toBe(120);
    expect(saved?.ui?.cpfOverride).toBeNull();
    expect(saved?.ui?.salaryOther).toBeNull();
  });
});
