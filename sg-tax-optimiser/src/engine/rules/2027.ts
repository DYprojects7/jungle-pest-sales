import type { YearRules } from '../types';
import {
  COMMON_SOURCES,
  PR_YEAR1_GG_RATES,
  PR_YEAR2_GG_RATES,
  RELIEF_CATALOG,
  RESIDENT_TAX_BRACKETS_FROM_YA2024,
  cpfBand,
} from './shared';

/**
 * Income year 2027 -> Year of Assessment 2028. PROJECTED: built from what has been announced as at
 * November 2026 (CPF rates and retirement sums) with everything else carried forward from 2026.
 * Budget 2027 (February 2027) may change any of it.
 */
export const RULES_2027: YearRules = {
  incomeYear: 2027,
  ya: 2028,
  status: 'projected',
  statusNotes: [
    'Tax rates, relief caps and SRS limits are carried forward from 2026; Budget 2027 (February 2027) may change them.',
    'CPF rates for workers aged above 55 to 65 use the increases announced in Budget 2026 for 1 January 2027.',
    'The 2027 Basic Healthcare Sum had not been announced when this was written; the 2026 figure is used.',
    'The 250% deduction for qualifying donations was extended to 31 December 2029 in Budget 2026.',
  ],

  taxBrackets: RESIDENT_TAX_BRACKETS_FROM_YA2024,
  pitRebate: null,
  personalReliefCap: 80_000,
  earnedIncomeRelief: { below55: 1_000, age55to59: 6_000, age60plus: 8_000 },
  donationDeductionMultiplier: 2.5,

  cpf: {
    owCeilingMonthly: 8_000,
    annualWageCeiling: 102_000,
    // From 1 Jan 2027: +1.5 points (above 55 to 60) and +1 point (above 60 to 65), per Budget 2026.
    fullRates: [
      cpfBand(55, 0.2, 0.17),
      cpfBand(60, 0.19, 0.165),
      cpfBand(65, 0.13, 0.13),
      cpfBand(70, 0.075, 0.09),
      cpfBand(null, 0.05, 0.075),
    ],
    prYear1Rates: PR_YEAR1_GG_RATES,
    prYear2Rates: PR_YEAR2_GG_RATES,
    employeeNilUpTo: 500,
    phaseInUpTo: 750,
  },

  srs: {
    capCitizenPr: 15_300,
    capForeigner: 35_700,
    minAge: 18,
    statutoryRetirementAge: 64,
  },

  cpfTopUp: {
    selfReliefCap: 8_000,
    familyReliefCap: 8_000,
    fullRetirementSum: 228_200,
    enhancedRetirementSum: 456_400,
    basicHealthcareSum: 79_000,
    familyGiverResidency: ['citizen', 'pr'],
    interestRateSmra: 0.04,
  },

  contributionDeadline: '2027-12-31',
  reliefCatalog: RELIEF_CATALOG,
  sources: COMMON_SOURCES,
};
