import { describe, expect, it } from 'vitest';
import { defaultInput, getRules, plan } from '../../src/engine';
import {
  STORAGE_KEY,
  computePlan,
  customRateOptions,
  exampleState,
  itemisedReliefTotal,
  monthlyWage,
  parseSaved,
  serialiseSaved,
  toPlannerInput,
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
    expect(monthlyWage({ payMode: 'annual', salary: 100_000 })).toBe(8_333);
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

  it('ignores unparseable or outdated data', () => {
    expect(parseSaved(null, example())).toBeNull();
    expect(parseSaved('{not json', example())).toBeNull();
    expect(parseSaved(JSON.stringify({ v: 0, ui: example() }), example())).toBeNull();
    expect(parseSaved(JSON.stringify({ v: 1, ui: 'nope' }), example())).toBeNull();
    expect(parseSaved('[]', example())).toBeNull();
  });

  it('repairs fields of the wrong type instead of trusting them', () => {
    const raw = { v: 1, theme: 'neon', ui: { ...example(), salary: 'lots', incomeYear: 1999, depth: 'deep', age: 400 } };
    const saved = parseSaved(JSON.stringify(raw), example());
    expect(saved?.theme).toBe('system');
    expect(saved?.ui.salary).toBe(10_000);
    expect(saved?.ui.incomeYear).toBe(2026);
    expect(saved?.ui.depth).toBe('worth');
    expect(saved?.ui.age).toBe(120);
  });
});
