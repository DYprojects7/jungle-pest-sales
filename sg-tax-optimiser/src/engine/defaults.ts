/**
 * The opening example (SPEC §7, Appendix A.1): the state the UI starts in.
 */
import { defaultIncomeYear } from './rules';
import type { PlannerInput } from './types';

/**
 * SPEC §7 `defaultInput`: citizen, age 35, S$10,000 a month for 12 months, S$15,000 bonus, S$5,000 other
 * reliefs, nothing contributed yet, SRS and CPF (self) enabled, family off, no budget, a 7% minimum saving
 * rate and the "flexibility first" order. The income year is today's year when supported.
 */
export function defaultInput(today: string): PlannerInput {
  return {
    incomeYear: defaultIncomeYear(typeof today === 'string' ? today : ''),
    today,
    profile: { residency: 'citizen', prYear: 3, ageAtYearEnd: 35, birthMonth: 12 },
    income: {
      monthlyOrdinaryWage: 10_000,
      monthsWorked: 12,
      additionalWages: 15_000,
      otherTaxableIncome: 0,
      employmentExpenses: 0,
      donations: 0,
      employeeCpfOverride: null,
    },
    existing: { srs: 0, cpfTopUpSelf: 0, cpfTopUpFamily: 0 },
    otherReliefs: 5_000,
    levers: {
      srs: { enabled: true },
      cpfSelf: { enabled: true, roomToLimit: null },
      cpfFamily: { enabled: false, maxAmount: null },
    },
    preferences: {
      cashBudget: null,
      minSavingRate: 0.07,
      priority: ['srs', 'cpfSelf', 'cpfFamily'],
      simulatorStep: 1000,
    },
  };
}
