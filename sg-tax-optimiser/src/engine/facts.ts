/**
 * The words of SPEC §5.4 — what locking money into each scheme means — with the year's figures filled in.
 *
 * One source for every surface: the web page's "Before you transfer" section and the workbook's
 * "Before You Transfer" sheet both render these rows, so the paid workbook never says less than the page and the
 * two can never drift apart. Pure: everything comes from the rules and the two facts about the person that change
 * the wording (residency and age).
 *
 * Every sentence here was checked against IRAS, CPF Board and MOF material (docs/RESEARCH.md). When a rule
 * changes, change it here and in SPEC §5.4 together.
 */
import { formatLongDate, parseIsoDate } from './dates';
import { formatDollars, formatPercent } from './format';
import { RETIREMENT_ACCOUNT_AGE } from './levers';
import type { LeverId, Residency, YearRules } from './types';

/** The two things about a person that change the wording. */
export interface FactsProfile {
  residency: Residency;
  /** Age on 31 December of the income year. */
  ageAtYearEnd: number;
}

export type LockUpFactId =
  | 'relief'
  | 'lockedUntil'
  | 'sooner'
  | 'earns'
  | 'taxLater'
  | 'limits'
  | 'noRelief'
  | 'who'
  | 'deadline';

export interface LockUpFactRow {
  id: LockUpFactId;
  /** Row heading, e.g. "Locked until". */
  label: string;
  /** One or two sentences per scheme. */
  values: Record<LeverId, string>;
}

export interface LockUpHorizon {
  /** Retirement age locked in by a first SRS contribution made in this income year. */
  srsAge: number;
  /** Whole years from the person's age to `srsAge` (0 if already there). */
  srsYears: number;
  /** Age from which a top-up to the Special / Retirement Account is paid out. */
  cpfPayoutAge: number;
  /** Whole years from the person's age to `cpfPayoutAge` (0 if already there). */
  cpfYears: number;
}

/** Income a spouse or sibling may have earned, in the year before the top-up, to count as a family member. */
const FAMILY_INCOME_LIMIT = 8_000;

/**
 * What a non-resident pays, at the least, to take a dollar out of SRS (SPEC §5.4): 15% on the taxable half at
 * retirement age or under the 10-year rule for foreigners; 15% on all of it plus the 5% penalty if earlier.
 */
export const NON_RESIDENT_SRS_COST = { atRetirementOrTenYears: 0.075, early: 0.2 } as const;

export const DISCLAIMER =
  'This is an estimate for planning, not tax, legal or financial advice. It is not affiliated with IRAS or the ' +
  'CPF Board. Check your eligibility and limits with IRAS, the CPF Board and your SRS bank before transferring ' +
  'money. CPF top-ups cannot be reversed.';

/** A rate as cents per dollar, e.g. 0.075 -> "7.5 cents". */
function centsPerDollar(rate: number): string {
  return `${Math.round(rate * 1000) / 10} cents`;
}

/** "31 December" from an ISO date. */
function dayAndMonth(iso: string): string {
  const date = parseIsoDate(iso);
  return date ? formatLongDate(date).replace(/ \d+$/, '') : iso;
}

function longDate(iso: string): string {
  const date = parseIsoDate(iso);
  return date ? formatLongDate(date) : iso;
}

/** The yearly SRS cap for a residency (SPEC §6.5), ignoring the age test. */
function srsCap(rules: YearRules, residency: Residency): number {
  return residency === 'foreigner' ? rules.srs.capForeigner : rules.srs.capCitizenPr;
}

/** Withdrawals a tax resident with no other income can take each year without paying tax: half is taxable. */
function taxFreeWithdrawal(rules: YearRules): number {
  const firstTaxed = rules.taxBrackets.find((bracket) => bracket.rate > 0);
  return firstTaxed ? firstTaxed.from * 2 : 0;
}

/** "the first S$2,000 a year … Matched Retirement Savings Scheme, and the first S$1,000 … Matched MediSave Scheme". */
function matchedParts(rules: YearRules): string {
  const { retirementAnnualCap, mediSaveAnnualCap } = rules.cpfTopUp.matchedTopUps;
  return (
    `the first ${formatDollars(retirementAnnualCap)} a year topped up for a member on the Matched Retirement ` +
    'Savings Scheme' +
    (mediSaveAnnualCap === null
      ? ''
      : `, and the first ${formatDollars(mediSaveAnnualCap)} a year to MediSave for a member on the Matched ` +
        'MediSave Scheme')
  );
}

/** How the Basic Healthcare Sum is described: it is fixed for life in the year a member turns 65. */
function healthcareSum(rules: YearRules): string {
  const figure = formatDollars(rules.cpfTopUp.basicHealthcareSum);
  const provisional = rules.status === 'projected' ? '; the figure shown is provisional' : '';
  return (
    `your Basic Healthcare Sum (${figure} if you are 65 or younger in ${rules.incomeYear}; if older, the figure ` +
    `fixed in the year you turned 65${provisional})`
  );
}

/**
 * How long the cash is locked away (SPEC §8.4): SRS until the retirement age a first contribution this year locks
 * in, CPF until the payout eligibility age.
 */
export function lockUpHorizon(rules: YearRules, ageAtYearEnd: number): LockUpHorizon {
  const age = Number.isFinite(ageAtYearEnd) ? Math.max(0, Math.floor(ageAtYearEnd)) : 0;
  const srsAge = rules.srs.statutoryRetirementAge;
  const cpfPayoutAge = rules.cpfTopUp.payoutEligibilityAge;
  return {
    srsAge,
    srsYears: Math.max(0, srsAge - age),
    cpfPayoutAge,
    cpfYears: Math.max(0, cpfPayoutAge - age),
  };
}

/** What locking the money away means for each scheme (SPEC §5.4), with the year's figures filled in. */
export function lockUpFacts(rules: YearRules, profile: FactsProfile): LockUpFactRow[] {
  const { cpfTopUp, srs, incomeYear, ya } = rules;
  const foreigner = profile.residency === 'foreigner';
  const hasRetirementAccount = profile.ageAtYearEnd >= RETIREMENT_ACCOUNT_AGE;
  const frs = formatDollars(cpfTopUp.fullRetirementSum);
  const ers = formatDollars(cpfTopUp.enhancedRetirementSum);
  const floor = formatPercent(cpfTopUp.interestRateSmra);
  const deadline = dayAndMonth(rules.contributionDeadline);
  const taxFree = formatDollars(taxFreeWithdrawal(rules));
  const atLeast = centsPerDollar(NON_RESIDENT_SRS_COST.atRetirementOrTenYears);
  const early = centsPerDollar(NON_RESIDENT_SRS_COST.early);

  return [
    {
      id: 'relief',
      label: 'Relief each year',
      values: {
        srs:
          `Up to ${formatDollars(srsCap(rules, profile.residency))}. Anything your employer pays into your SRS ` +
          'counts towards the same cap.',
        cpfSelf:
          `Up to ${formatDollars(cpfTopUp.selfReliefCap)}, shared between your Special or Retirement Account and ` +
          "your MediSave. An employer's cash top-up counts towards it.",
        cpfFamily: `Up to ${formatDollars(cpfTopUp.familyReliefCap)} across all family members.`,
      },
    },
    {
      id: 'lockedUntil',
      label: 'Locked until',
      values: {
        srs:
          'The retirement age in force when you made your first SRS contribution: 64 if that is on or after ' +
          '1 July 2026, 63 if it was between 1 July 2022 and 30 June 2026, 62 if earlier.',
        cpfSelf:
          `It comes back as monthly payouts from age ${cpfTopUp.payoutEligibilityAge} (CPF LIFE). It cannot be ` +
          'withdrawn at 55 or used for housing. A MediSave top-up can only pay for healthcare.',
        cpfFamily: 'It is a gift. The money belongs to the family member, under the same rules.',
      },
    },
    {
      id: 'sooner',
      label: 'If you need it sooner',
      values: {
        srs: 'You can withdraw early, but the whole amount is taxed and there is a 5% penalty.',
        cpfSelf: 'You cannot take it back. A top-up cannot be reversed.',
        cpfFamily: 'You cannot take it back. A top-up cannot be reversed.',
      },
    },
    {
      id: 'earns',
      label: 'What it earns',
      values: {
        srs: 'About 0.05% a year at the bank unless you invest it.',
        cpfSelf: `At least ${floor} a year until the end of 2027, the date to which the floor has been extended.`,
        cpfFamily: `At least ${floor} a year until the end of 2027, in the family member's account.`,
      },
    },
    {
      id: 'taxLater',
      label: 'Tax later',
      values: {
        srs: foreigner
          ? 'Half of the withdrawal is taxable if you take it at your retirement age, or in one full withdrawal ' +
            'after keeping the account for 10 years (the rule for foreigners). If you have left Singapore by ' +
            'then, you are taxed as a non-resident: 15% or the resident rates, whichever is higher, on the ' +
            `taxable half, withheld by the bank. That is at least ${atLeast} per dollar you take out. Any ` +
            `earlier, the whole amount is taxed and there is a 5% penalty: at least ${early} per dollar. If you ` +
            `are still a tax resident with no other income, ${taxFree} a year comes out tax-free.`
          : 'Half of each withdrawal at or after your retirement age is taxable, and you can spread withdrawals ' +
            'over up to 10 years. If you are a Singapore tax resident then, with no other income, ' +
            `${taxFree} a year comes out tax-free. If you have left Singapore, there is no tax-free amount: ` +
            'the taxable half is taxed at 15% or the resident rates, whichever is higher.',
        cpfSelf: 'None.',
        cpfFamily: 'None.',
      },
    },
    {
      id: 'limits',
      label: 'Account limits',
      values: {
        srs: 'None beyond the yearly cap. Banks reject anything over it.',
        cpfSelf: hasRetirementAccount
          ? `From 55 the CPF Board accepts top-ups to your Retirement Account up to the Enhanced Retirement Sum ` +
            `(${ers}), but only the part up to the Full Retirement Sum (${frs}) earns relief. MediSave: up to ` +
            `${healthcareSum(rules)}.`
          : `Your Special Account can be topped up only to the Full Retirement Sum (${frs}), and MediSave to ` +
            `${healthcareSum(rules)}. The CPF Board does not accept more.`,
        cpfFamily:
          "The same limits apply to the family member's accounts, which you cannot see. Ask them to check " +
          'their CPF Retirement dashboard for the top-up that still earns relief.',
      },
    },
    {
      id: 'noRelief',
      label: 'No relief for',
      values: {
        srs: 'Anything over the yearly cap.',
        cpfSelf:
          'A voluntary contribution to all three CPF accounts (a different transaction: choose the retirement ' +
          'or MediSave top-up instead), a CPF-to-CPF transfer, a top-up that attracts a matching grant, and ' +
          'amounts above the limits.',
        cpfFamily: `The same, and any part the Government matches: ${matchedParts(rules)}.`,
      },
    },
    {
      id: 'who',
      label: 'Who qualifies',
      values: {
        srs:
          `Age ${srs.minAge} or over, not an undischarged bankrupt, and a Singapore tax resident for YA${ya}. ` +
          'You cannot contribute once you have started withdrawing at or after your retirement age, or on ' +
          'medical grounds.' +
          (foreigner
            ? ` Foreigners give their SRS bank a declaration each year to use the ${formatDollars(srs.capForeigner)} cap.`
            : ''),
        cpfSelf: 'Singapore Citizens and Permanent Residents.',
        cpfFamily:
          'Citizens and PRs topping up parents, parents-in-law, grandparents or grandparents-in-law. A spouse ' +
          `or sibling counts only if they earned no more than ${formatDollars(FAMILY_INCOME_LIMIT)} in ` +
          `${incomeYear - 1} (the year before the top-up) or have a disability.`,
      },
    },
    {
      id: 'deadline',
      label: 'Deadline',
      values: {
        srs:
          `${deadline}, or your bank's earlier cut-off. Banks stop taking same-day contributions before ` +
          'midnight on the last day, some as early as 7pm.',
        cpfSelf: `The money must reach the CPF Board by ${deadline}. A top-up counts on the day the Board receives it.`,
        cpfFamily: `The money must reach the CPF Board by ${deadline}. A top-up counts on the day the Board receives it.`,
      },
    },
  ];
}

/**
 * Things only the person can check before moving money (SPEC §8.4 item 7), in the order they matter.
 * `deadlinePassed` swaps the last line for the one that applies once 31 December has gone by.
 */
export function transferCautions(
  rules: YearRules,
  profile: FactsProfile,
  options: { deadlinePassed?: boolean } = {},
): string[] {
  const { incomeYear, ya, cpfTopUp } = rules;
  const cpfOpen = cpfTopUp.familyGiverResidency.includes(profile.residency);
  const hasRetirementAccount = profile.ageAtYearEnd >= RETIREMENT_ACCOUNT_AGE;
  const out: string[] = [];

  out.push(
    `This plan is for employees who are Singapore tax residents for YA${ya}: broadly, people who lived or worked ` +
      `in Singapore for at least 183 days in ${incomeYear}. Self-employed income and non-residents follow ` +
      'different rules.',
  );
  if (cpfOpen) {
    out.push(
      hasRetirementAccount
        ? 'Log in to CPF and open the Retirement dashboard to see how much you can still top up with tax ' +
            'relief. From 55 the CPF Board accepts more than that, and the extra earns no relief and cannot be ' +
            'taken back.'
        : 'Log in to CPF to see how far your Special Account is from the Full Retirement Sum and your MediSave ' +
            'from the Basic Healthcare Sum. This tool cannot see your balances.',
    );
    out.push(
      'When you transfer, choose the retirement top-up (Special or Retirement Account) or the MediSave top-up. ' +
        'A voluntary contribution to all three CPF accounts earns no tax relief.',
    );
    out.push(
      'For a family top-up, check that the family member qualifies and count only what the Government does not ' +
        `match: ${matchedParts(rules)} earns you no relief. A top-up cannot be reversed.`,
    );
  }
  if (profile.residency === 'foreigner') {
    out.push(
      'If you may leave Singapore before you withdraw, count the tax on the way out: at least ' +
        `${centsPerDollar(NON_RESIDENT_SRS_COST.atRetirementOrTenYears)} per dollar at retirement age or under the ` +
        `10-year rule for foreigners, and at least ${centsPerDollar(NON_RESIDENT_SRS_COST.early)} if earlier.`,
    );
  }
  out.push(
    'If you have unused Parenthood Tax Rebate, you will pay less tax this year than shown here. The saving from ' +
      'this plan arrives later, when the rebate would otherwise have run out.',
  );
  out.push(
    options.deadlinePassed
      ? `The deadline for ${incomeYear} has passed. Money you put in now counts for the following year.`
      : `Aim to transfer a few working days before ${longDate(rules.contributionDeadline)}. Banks stop taking ` +
          'same-day SRS contributions before midnight on the last day, and a CPF top-up counts on the day the ' +
          'CPF Board receives it.',
  );
  return out;
}

/** What the model leaves out (SPEC §1, non-goals). */
export const NOT_MODELLED: string[] = [
  'Self-employed income, and MediSave contributions that self-employed people must make.',
  'People who are not tax residents: they get no personal reliefs and pay different rates.',
  'The tax on SRS withdrawals, which depends on your income and where you live when you withdraw.',
  'Investment returns inside SRS or CPF, and what your balances will be at retirement.',
  'Parenthood Tax Rebate balances.',
  'Employer SRS contributions, the Not Ordinarily Resident scheme, foreign-sourced income and rental expenses.',
  'Your CPF balances, whether a top-up attracts a matching grant, and whether a family member qualifies.',
  'Voluntary contributions to all three CPF accounts, which earn an employee no tax relief.',
];
