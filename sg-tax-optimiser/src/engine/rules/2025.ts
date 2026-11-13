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
 * Income year 2025 -> Year of Assessment 2026. Kept for back-testing against Notices of Assessment
 * and the IRAS YA2026 sample calculations.
 */
export const RULES_2025: YearRules = {
  incomeYear: 2025,
  ya: 2026,
  status: 'final',
  statusNotes: ['Budget 2026 did not grant a Personal Income Tax Rebate for YA2026.'],

  taxBrackets: RESIDENT_TAX_BRACKETS_FROM_YA2024,
  pitRebate: null,
  personalReliefCap: 80_000,
  earnedIncomeRelief: { below55: 1_000, age55to59: 6_000, age60plus: 8_000 },
  donationDeductionMultiplier: 2.5,

  cpf: {
    owCeilingMonthly: 7_400,
    annualWageCeiling: 102_000,
    // Employee / employer rates 1 Jan – 31 Dec 2025.
    fullRates: [
      cpfBand(55, 0.2, 0.17),
      cpfBand(60, 0.17, 0.155),
      cpfBand(65, 0.115, 0.12),
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
    statutoryRetirementAge: 63,
  },

  cpfTopUp: {
    selfReliefCap: 8_000,
    familyReliefCap: 8_000,
    fullRetirementSum: 213_000,
    enhancedRetirementSum: 426_000,
    basicHealthcareSum: 75_500,
    familyGiverResidency: ['citizen', 'pr'],
    interestRateSmra: 0.04,
  },

  contributionDeadline: '2025-12-31',
  reliefCatalog: RELIEF_CATALOG,
  sources: COMMON_SOURCES,
};
