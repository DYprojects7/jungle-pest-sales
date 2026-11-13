/**
 * The worked example the workbook opens with (SPEC Appendix A.1): what the cream cells hold in a fresh file.
 */
import { MONTH_LABELS, NO, PRIORITY_PRESETS, PR_YEAR_LABELS, RESIDENCY_LABELS, SALARY_PERIODS, YES } from './rules';

/**
 * The smallest saving per dollar the Planner starts with (SPEC §8.3, and release/BUYER-GUIDE.md): 7 cents for
 * citizens and PRs, 11.5 cents for foreigners, who pay at least 7.5 cents per dollar to take SRS out once they
 * have left Singapore, so that the 7% rung would be a loss for them. The cell holds a formula that follows the
 * residency until the person types a rate of their own over it. The test holds both figures to the web page's own
 * defaults.
 */
export const DEFAULT_MIN_RATE = { resident: 0.07, foreigner: 0.115 } as const;

export const EXAMPLE = {
  residency: RESIDENCY_LABELS.citizen,
  prYear: PR_YEAR_LABELS[2],
  age: 35,
  birthMonth: MONTH_LABELS[11],
  salary: 10_000,
  salaryPeriod: SALARY_PERIODS[0],
  monthsWorked: 12,
  additionalWages: 15_000,
  otherIncome: 0,
  employmentExpenses: 0,
  donations: 0,
  cpfOverride: null,
  existingSrs: 0,
  existingCpfSelf: 0,
  existingCpfFamily: 0,
  otherReliefs: 5_000,
  unusedPtr: NO,
  cashBudget: null,
  useSrs: YES,
  useCpfSelf: YES,
  cpfSelfRoom: null,
  useCpfFamily: NO,
  cpfFamilyMax: null,
  /** What the cell's formula gives for the example's residency. */
  minSavingRate: DEFAULT_MIN_RATE.resident,
  priority: PRIORITY_PRESETS[0]!.label,
  simulatorStep: 1_000,
} as const;
