import type { CpfAgeBand, ReliefCatalogItem, TaxBracket } from '../types';

/**
 * Resident individual income tax rates, "From YA 2024 onwards" (IRAS).
 * In force for YA2025, YA2026 and YA2027; no change announced for YA2028 as at Nov 2026.
 *
 * Cumulative gross tax at each boundary, for cross-checking:
 *   30,000 -> 200 · 40,000 -> 550 · 80,000 -> 3,350 · 120,000 -> 7,950 · 160,000 -> 13,950
 *   200,000 -> 21,150 · 240,000 -> 28,750 · 280,000 -> 36,550 · 320,000 -> 44,550
 *   500,000 -> 84,150 · 1,000,000 -> 199,150
 */
export const RESIDENT_TAX_BRACKETS_FROM_YA2024: TaxBracket[] = [
  { from: 0, rate: 0 },
  { from: 20_000, rate: 0.02 },
  { from: 30_000, rate: 0.035 },
  { from: 40_000, rate: 0.07 },
  { from: 80_000, rate: 0.115 },
  { from: 120_000, rate: 0.15 },
  { from: 160_000, rate: 0.18 },
  { from: 200_000, rate: 0.19 },
  { from: 240_000, rate: 0.195 },
  { from: 280_000, rate: 0.2 },
  { from: 320_000, rate: 0.22 },
  { from: 500_000, rate: 0.23 },
  { from: 1_000_000, rate: 0.24 },
];

/**
 * Build a CPF age band.
 *
 * The employee share for monthly wages between S$500 and S$750 is `factor x (TW - 500)`. In every CPF Board
 * table the factor equals 3 x the employee rate, which makes the phase-in formula meet the full-rate formula
 * exactly at S$750 (factor x 250 = rate x 750). e.g. 20% -> 0.6, 18% -> 0.54, 12.5% -> 0.375.
 */
export function cpfBand(maxAge: number | null, employeeRate: number, employerRate: number): CpfAgeBand {
  return {
    maxAge,
    employeeRate,
    employerRate,
    phaseInFactor: Math.round(employeeRate * 3 * 10_000) / 10_000,
  };
}

/**
 * Graduated employer / graduated employee (G/G) rates for Singapore Permanent Residents in their first two years
 * of SPR status. Unchanged since 1 Jan 2016.
 */
export const PR_YEAR1_GG_RATES: CpfAgeBand[] = [
  cpfBand(55, 0.05, 0.04),
  cpfBand(60, 0.05, 0.04),
  cpfBand(65, 0.05, 0.035),
  cpfBand(70, 0.05, 0.035),
  cpfBand(null, 0.05, 0.035),
];

export const PR_YEAR2_GG_RATES: CpfAgeBand[] = [
  cpfBand(55, 0.15, 0.09),
  cpfBand(60, 0.125, 0.06),
  cpfBand(65, 0.075, 0.035),
  cpfBand(70, 0.05, 0.035),
  cpfBand(null, 0.05, 0.035),
];

/**
 * Common personal reliefs offered in the UI's "relief helper". Amounts are per IRAS for YA2026/YA2027.
 * The helper only adds up amounts; it does not check eligibility.
 */
export const RELIEF_CATALOG: ReliefCatalogItem[] = [
  {
    id: 'spouse',
    group: 'family',
    label: 'Spouse Relief',
    amountPerUnit: 2_000,
    input: 'toggle',
    help: 'S$2,000 if your spouse lived with or was supported by you and earned no more than S$8,000 in the year.',
  },
  {
    id: 'qualifyingChild',
    group: 'family',
    label: 'Qualifying Child Relief',
    amountPerUnit: 4_000,
    input: 'count',
    max: 10,
    help: 'S$4,000 per child (under 16, or studying full-time) who earned no more than S$8,000. Parents can share it.',
  },
  {
    id: 'workingMotherChild',
    group: 'family',
    label: "Working Mother's Child Relief",
    amountPerUnit: 0,
    input: 'amount',
    max: 80_000,
    help:
      'Working mothers only, for children who are Singapore Citizens. Children born or adopted from 1 Jan 2024: ' +
      'S$8,000 (1st), S$10,000 (2nd), S$12,000 (3rd onwards). Children born earlier: 15% / 20% / 25% of your earned ' +
      'income. With Qualifying Child Relief it cannot exceed S$50,000 for one child. Enter the total.',
  },
  {
    id: 'parentStayingWith',
    group: 'family',
    label: 'Parent Relief — living with you',
    amountPerUnit: 9_000,
    input: 'count',
    max: 2,
    help:
      'S$9,000 per dependent parent, grandparent or parent-in-law (55 or older, income up to S$8,000) living with you. ' +
      'Up to 2 dependants in total. The amount is per parent: if others claim for the same parent, you share it.',
  },
  {
    id: 'parentNotStayingWith',
    group: 'family',
    label: 'Parent Relief — not living with you',
    amountPerUnit: 5_500,
    input: 'count',
    max: 2,
    help:
      'S$5,500 per dependant not living with you, if you gave at least S$2,000 in support. Up to 2 dependants in total. ' +
      'The amount is per parent: if others claim for the same parent, you share it.',
  },
  {
    id: 'nsmanSelf',
    group: 'ns',
    label: 'NSman Self Relief',
    amountPerUnit: 0,
    input: 'select',
    options: [
      { label: 'None', amount: 0 },
      { label: 'No in-camp training this work year — S$1,500', amount: 1_500 },
      { label: 'Performed NS activities — S$3,000', amount: 3_000 },
      { label: 'Key appointment holder, no activities — S$3,500', amount: 3_500 },
      { label: 'Key appointment holder, performed activities — S$5,000', amount: 5_000 },
    ],
    help: 'Granted automatically by IRAS from MINDEF/MHA records.',
  },
  {
    id: 'nsmanWifeOrParent',
    group: 'ns',
    label: 'NSman Wife / Parent Relief',
    amountPerUnit: 750,
    input: 'toggle',
    help: 'S$750 if you are the wife or a parent of an NSman (you cannot also claim NSman Self Relief).',
  },
  {
    id: 'grandparentCaregiver',
    group: 'family',
    label: 'Grandparent Caregiver Relief',
    amountPerUnit: 3_000,
    input: 'toggle',
    help:
      'One claim of S$3,000 for working mothers whose parent, parent-in-law, grandparent or grandparent-in-law ' +
      '(not working, or earning no more than S$8,000) looks after a child aged 12 or below.',
  },
  {
    id: 'spouseDisability',
    group: 'disability',
    label: 'Spouse Relief (Disability)',
    amountPerUnit: 5_500,
    input: 'toggle',
    help: 'S$5,500 instead of Spouse Relief if your spouse has a disability. No income limit applies.',
  },
  {
    id: 'childDisability',
    group: 'disability',
    label: 'Child Relief (Disability)',
    amountPerUnit: 7_500,
    input: 'count',
    max: 10,
    help: 'S$7,500 per child with a disability, instead of Qualifying Child Relief for that child.',
  },
  {
    id: 'parentDisabilityStayingWith',
    group: 'disability',
    label: 'Parent Relief (Disability) — living with you',
    amountPerUnit: 14_000,
    input: 'count',
    max: 2,
    help: 'S$14,000 per dependant with a disability living with you, instead of Parent Relief. No age or income limit applies.',
  },
  {
    id: 'parentDisabilityNotStayingWith',
    group: 'disability',
    label: 'Parent Relief (Disability) — not living with you',
    amountPerUnit: 10_000,
    input: 'count',
    max: 2,
    help: 'S$10,000 per dependant with a disability not living with you, instead of Parent Relief.',
  },
  {
    id: 'siblingDisability',
    group: 'disability',
    label: 'Sibling Relief (Disability)',
    amountPerUnit: 5_500,
    input: 'count',
    max: 10,
    help: 'S$5,500 per sibling or sibling-in-law with a disability whom you live with or support.',
  },
  {
    id: 'earnedIncomeDisabilityTopUp',
    group: 'disability',
    label: 'Earned Income Relief (Disability) — extra amount',
    amountPerUnit: 0,
    input: 'select',
    options: [
      { label: 'None', amount: 0 },
      { label: 'Below 55 — S$4,000 instead of S$1,000 (add S$3,000)', amount: 3_000 },
      { label: 'Age 55 to 59 — S$10,000 instead of S$6,000 (add S$4,000)', amount: 4_000 },
      { label: 'Age 60 or above — S$12,000 instead of S$8,000 (add S$4,000)', amount: 4_000 },
    ],
    help: 'If you have a disability, your Earned Income Relief is higher. The tool already counts the standard amount, so add only the difference.',
  },
  {
    id: 'lifeInsurance',
    group: 'other',
    label: 'Life Insurance Relief',
    amountPerUnit: 0,
    input: 'amount',
    max: 5_000,
    help: 'Only if your CPF contributions for the year (compulsory plus voluntary) were under S$5,000. Most full-time employees get nil.',
  },
  {
    id: 'other',
    group: 'other',
    label: 'Any other relief',
    amountPerUnit: 0,
    input: 'amount',
    max: 80_000,
    help: 'Anything else on your Notice of Assessment. Do not include CPF, SRS, top-ups or Earned Income Relief — those are worked out for you.',
  },
];

export const COMMON_SOURCES: { label: string; url: string }[] = [
  {
    label: 'IRAS — Individual income tax rates (residents)',
    url: 'https://www.iras.gov.sg/taxes/individual-income-tax/basics-of-individual-income-tax/tax-residency-and-tax-rates/individual-income-tax-rates',
  },
  {
    label: 'IRAS — Tax reliefs and the S$80,000 personal relief cap',
    url: 'https://www.iras.gov.sg/taxes/individual-income-tax/basics-of-individual-income-tax/tax-reliefs-rebates-and-deductions/tax-reliefs',
  },
  {
    label: 'IRAS — CPF Relief for employees',
    url: 'https://www.iras.gov.sg/taxes/individual-income-tax/basics-of-individual-income-tax/tax-reliefs-rebates-and-deductions/tax-reliefs/central-provident-fund(cpf)-relief-for-employees',
  },
  {
    label: 'IRAS — SRS contributions and tax relief',
    url: 'https://www.iras.gov.sg/taxes/individual-income-tax/basics-of-individual-income-tax/special-tax-schemes/srs-contributions',
  },
  {
    label: 'IRAS — CPF Cash Top-up Relief',
    url: 'https://www.iras.gov.sg/taxes/individual-income-tax/basics-of-individual-income-tax/tax-reliefs-rebates-and-deductions/tax-reliefs/central-provident-fund-(cpf)-cash-top-up-relief',
  },
  {
    label: 'CPF Board — How much CPF contributions to pay',
    url: 'https://www.cpf.gov.sg/employer/employer-obligations/how-much-cpf-contributions-to-pay',
  },
  {
    label: 'CPF Board — Retirement sums',
    url: 'https://www.cpf.gov.sg/member/infohub/educational-resources/what-is-the-cpf-retirement-sum',
  },
  {
    label: 'CPF Board — Basic Healthcare Sum',
    url: 'https://www.cpf.gov.sg/service/article/what-is-the-basic-healthcare-sum',
  },
  {
    label: 'IRAS — Tax on SRS withdrawals',
    url: 'https://www.iras.gov.sg/taxes/individual-income-tax/basics-of-individual-income-tax/special-tax-schemes/tax-on-srs-withdrawals',
  },
  {
    label: 'IRAS — Sample income tax calculations',
    url: 'https://www.iras.gov.sg/taxes/individual-income-tax/basics-of-individual-income-tax/tax-residency-and-tax-rates/sample-income-tax-calculations',
  },
  {
    label: 'CPF Board — Tax relief on cash top-ups',
    url: 'https://www.cpf.gov.sg/service/article/how-much-tax-relief-can-i-enjoy-when-i-make-cash-top-ups',
  },
  {
    label: 'CPF Board — When contribution rates change at 55, 60, 65 and 70',
    url: 'https://www.cpf.gov.sg/service/article/when-will-my-cpf-contribution-rates-change-when-I-turn-55-60-65-or-70',
  },
  {
    label: 'MOM — Retirement and re-employment ages',
    url: 'https://www.mom.gov.sg/employment-practices/re-employment',
  },
  {
    label: 'MOF — Supplementary Retirement Scheme',
    url: 'https://www.mof.gov.sg/news-resources/supplementary-retirement-scheme/',
  },
];
