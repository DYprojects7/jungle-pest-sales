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
 * Income year 2026 -> Year of Assessment 2027. This is the product's primary year.
 * Every value is traceable to docs/RESEARCH.md.
 */
export const RULES_2026: YearRules = {
  incomeYear: 2026,
  ya: 2027,
  status: 'final',
  statusNotes: [
    'No Personal Income Tax Rebate has been announced for YA2027. Past rebates were announced at the Budget in February of the YA itself, after the contribution deadline, so this tool assumes none.',
  ],

  taxBrackets: RESIDENT_TAX_BRACKETS_FROM_YA2024,
  pitRebate: null,
  personalReliefCap: 80_000,
  earnedIncomeRelief: { below55: 1_000, age55to59: 6_000, age60plus: 8_000 },
  donationDeductionMultiplier: 2.5,

  cpf: {
    owCeilingMonthly: 8_000,
    annualWageCeiling: 102_000,
    // Employee / employer rates from 1 Jan 2026 (Singapore Citizens and SPRs from the 3rd year).
    fullRates: [
      cpfBand(55, 0.2, 0.17),
      cpfBand(60, 0.18, 0.16),
      cpfBand(65, 0.125, 0.125),
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
    // The statutory retirement age rose from 63 to 64 on 1 Jul 2026; a first contribution made after that locks in 64.
    statutoryRetirementAge: 64,
  },

  cpfTopUp: {
    selfReliefCap: 8_000,
    familyReliefCap: 8_000,
    fullRetirementSum: 220_400,
    enhancedRetirementSum: 440_800,
    basicHealthcareSum: 79_000,
    familyGiverResidency: ['citizen', 'pr'],
    interestRateSmra: 0.04,
  },

  contributionDeadline: '2026-12-31',
  reliefCatalog: RELIEF_CATALOG,
  sources: COMMON_SOURCES,
};
