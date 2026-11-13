/**
 * Words. Every sentence the calculator builds from engine output lives here, so the copy can be read
 * and tested in one place. No number is worked out here: each figure is read from the PlannerResult.
 */
import type { LadderTier, LeverId, PlannerResult, ScenarioId, YearRules } from '../engine/types';
import {
  cents,
  centsPerDollar,
  countOf,
  dayAndMonth,
  dollars,
  listOf,
  longDate,
  monthLabel,
  pct,
  shortDate,
} from './format';
import type { Depth, Order, UiState } from './state';
import { monthlyWage } from './state';

export const LEVERS: LeverId[] = ['srs', 'cpfSelf', 'cpfFamily'];

/** Full scheme names, for labels and table headers. */
export const LEVER_NAME: Record<LeverId, string> = {
  srs: 'SRS',
  cpfSelf: 'CPF top-up, self',
  cpfFamily: 'CPF top-up, family',
};

/** Compact names for narrow table columns. */
export const LEVER_SHORT: Record<LeverId, string> = {
  srs: 'SRS',
  cpfSelf: 'CPF self',
  cpfFamily: 'CPF family',
};

/** Completes "Put S$X into ...". */
const LEVER_INTO: Record<LeverId, string> = {
  srs: 'SRS',
  cpfSelf: 'your CPF',
  cpfFamily: "family members' CPF",
};

export const SCENARIO_NAME: Record<ScenarioId, string> = {
  none: 'Do nothing more',
  srsOnly: 'SRS only',
  cpfSelfOnly: 'CPF top-up to self only',
  srsPlusCpfSelf: 'SRS and CPF top-up to self',
  maxAll: 'Everything to the limit',
  recommended: 'Your plan',
};

export const DEPTH_LABEL: Record<Depth, string> = {
  worth: 'Worth it (7%+)',
  top: 'Top bracket only',
  every: 'Every tax dollar',
  custom: 'Custom',
};

export const ORDER_LABEL: Record<Order, { title: string; route: string; why: string }> = {
  flexibility: {
    title: 'Flexibility first',
    route: 'SRS, then CPF self, then family',
    why: 'SRS can be withdrawn early for a 5% penalty. CPF top-ups cannot be taken back.',
  },
  interest: {
    title: 'Guaranteed interest first',
    route: 'CPF self, then SRS, then family',
    why: 'CPF top-ups earn a guaranteed floor rate. SRS earns 0.05% unless you invest it.',
  },
  family: {
    title: 'Family first',
    route: 'Family, then SRS, then CPF self',
    why: "Builds a family member's retirement or MediSave savings before your own.",
  },
};

export const DISCLAIMER =
  'This is an estimate for planning, not tax, legal or financial advice. It is not affiliated with IRAS or the ' +
  'CPF Board. Check your eligibility and limits with IRAS, the CPF Board and your SRS bank before transferring ' +
  'money. CPF top-ups cannot be reversed.';

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/** "S$15,300 into SRS", "S$8,000 into your CPF" for each scheme the plan uses. */
export function planParts(r: PlannerResult): { lever: LeverId; amount: number; into: string }[] {
  return LEVERS.filter((lever) => r.plan.contributions[lever] > 0).map((lever) => ({
    lever,
    amount: r.plan.contributions[lever],
    into: LEVER_INTO[lever],
  }));
}

/** The one-sentence recommendation, as plain text (announced to screen readers and copied). */
export function headline(r: PlannerResult): string {
  const parts = planParts(r).map((p) => `${dollars(p.amount)} into ${p.into}`);
  if (parts.length === 0) return 'Nothing more to put in this year.';
  return `Put ${listOf(parts)}. You save ${cents(r.plan.taxSaved)} in tax.`;
}

/** Why the plan stops where it does. Covers every BindingConstraint, with and without a contribution. */
export function stopReason(r: PlannerResult): string {
  const { plan: p, rules, baseline, levers } = r;
  const some = p.totalContribution > 0;
  const minRate = r.input.preferences.minSavingRate;
  const cap = dollars(rules.personalReliefCap);
  const more = p.unrealisedSaving > 0 ? cents(p.unrealisedSaving) : null;

  switch (p.bindingConstraint) {
    case 'usefulRoom': {
      if (!some) {
        if (minRate > 0) {
          return (
            `Nothing clears your minimum. Each extra dollar would save ${centsPerDollar(p.marginalRateBefore)} ` +
            `or less in tax, and you asked for at least ${centsPerDollar(minRate)}.`
          );
        }
        return 'The rest of your income is already tax-free, so extra dollars would save nothing.';
      }
      if (p.marginalRateAfter > 0) {
        return (
          `Beyond this, each extra dollar would save ${centsPerDollar(p.marginalRateAfter)} or less, ` +
          `below your ${centsPerDollar(minRate)} minimum.`
        );
      }
      return 'Beyond this, the rest of your income is already tax-free, so extra dollars would save nothing.';
    }
    case 'reliefCap':
      return some
        ? `You have reached the ${cap} overall relief cap. Anything more would be locked away without saving tax.`
        : `Your reliefs already reach the ${cap} overall relief cap, so extra contributions would save no tax.`;
    case 'cashBudget': {
      const limit = dollars(r.input.preferences.cashBudget ?? 0);
      const tail = more ? ` With a higher limit you could save up to ${more} more.` : '';
      return some
        ? `This uses your whole ${limit} cash limit.${tail}`
        : `Your cash limit is ${limit}, so there is nothing to put in.${tail}`;
    }
    case 'leverLimits': {
      const anyOn = LEVERS.some((l) => levers[l].eligible && levers[l].enabled);
      const off = LEVERS.filter((l) => levers[l].eligible && !levers[l].enabled).map((l) => LEVER_NAME[l]);
      if (!anyOn) {
        return 'No scheme is switched on. Choose at least one under "Schemes to use" to get a plan.';
      }
      const offNote = off.length > 0 ? ` You left ${listOf(off)} switched off.` : '';
      if (!some) {
        return `The schemes you switched on have no room left for ${rules.incomeYear}.${offNote}`;
      }
      const still =
        p.marginalRateAfter > 0
          ? ` Your next dollar of income is still taxed at ${pct(p.marginalRateAfter)}` +
            (more ? `, and with more room you could save up to ${more} more.` : '.')
          : '';
      return `You have used every scheme's limit.${still}${offNote}`;
    }
    case 'none':
    default:
      if (baseline.taxPayable === 0) {
        return `On these numbers you have no tax to pay for YA${rules.ya}, so contributions would save nothing.`;
      }
      return 'There is nothing to recommend with these settings.';
  }
}

/** One line under the "How far down the ladder?" control, for the chosen depth. */
export function depthExplanation(depth: Depth, r: PlannerResult): string {
  const top = r.baseline.marginalRate;
  switch (depth) {
    case 'worth':
      return 'Only lock away dollars that each save at least 7 cents in tax.';
    case 'top':
      return top > 0
        ? `Only dollars taxed at your highest rate, ${pct(top)} right now.`
        : 'Only dollars taxed at your highest rate. You have no tax to pay right now.';
    case 'every':
      return 'Keep going until an extra dollar saves nothing, however small the saving.';
    case 'custom':
      return 'Choose the smallest saving per dollar you would accept.';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Ladder
// ---------------------------------------------------------------------------

export function tierRange(t: LadderTier): string {
  return `${dollars(t.fromContribution)} to ${dollars(t.toContribution)}`;
}

/** Why a zero-rate tier saves nothing. */
export function zeroReasonText(t: LadderTier, rules: YearRules): string {
  if (t.zeroReason === 'reliefCap') return `over the ${dollars(rules.personalReliefCap)} relief cap`;
  return 'income already tax-free';
}

export function tierPlanUse(t: LadderTier): string {
  if (t.usedByPlan <= 0) return 'None';
  if (t.usedByPlan >= t.amount) return 'All';
  return `${dollars(t.usedByPlan)} of it`;
}

/** Text alternative for the chart as a whole. */
export function ladderSummary(r: PlannerResult): string {
  if (r.ladder.length === 0) return 'No scheme has room left, so there is no ladder to draw.';
  const tiers = r.ladder.map((t) =>
    t.rate > 0
      ? `${tierRange(t)} saves ${centsPerDollar(t.rate)} per dollar, ${cents(t.taxSaved)} in total`
      : `${tierRange(t)} saves no tax (${zeroReasonText(t, r.rules)})`,
  );
  return `Savings ladder. ${tiers.join('. ')}. Your plan uses the first ${dollars(r.plan.totalContribution)}.`;
}

// ---------------------------------------------------------------------------
// Inputs summary (phone) and the copied summary
// ---------------------------------------------------------------------------

const RESIDENCY_NAME: Record<UiState['residency'], string> = {
  citizen: 'Singapore Citizen',
  pr: 'Permanent Resident',
  foreigner: 'Foreigner (tax resident)',
};

/** Two or three short lines that describe the inputs, for the compact card on phones. */
export function inputsSummary(ui: UiState, otherReliefs: number): string[] {
  const lines: string[] = [];
  lines.push(`${RESIDENCY_NAME[ui.residency]}, age ${ui.age}`);
  const pay = `${dollars(monthlyWage(ui))} a month`;
  const months = ui.monthsWorked < 12 ? ` for ${countOf(ui.monthsWorked, 'month')}` : '';
  lines.push(`${pay}${months}, ${dollars(ui.bonus)} bonus`);
  lines.push(`${dollars(otherReliefs)} other reliefs`);
  const already: string[] = [];
  if (ui.existingSrs > 0) already.push(`SRS ${dollars(ui.existingSrs)}`);
  if (ui.residency !== 'foreigner') {
    if (ui.existingCpfSelf > 0) already.push(`CPF self ${dollars(ui.existingCpfSelf)}`);
    if (ui.existingCpfFamily > 0) already.push(`CPF family ${dollars(ui.existingCpfFamily)}`);
  }
  if (already.length > 0) lines.push(`Already contributed: ${already.join(', ')}`);
  return lines;
}

/** The plain-text summary behind the Copy summary button. */
export function summaryText(r: PlannerResult, isExample: boolean): string {
  const { plan: p, rules, monthlyPlan } = r;
  const lines: string[] = [];
  lines.push(`Singapore Tax Optimiser: plan for YA${rules.ya} (income year ${rules.incomeYear})`);
  if (isExample) lines.push('Example figures, not my own numbers.');
  lines.push('');
  lines.push(headline(r));
  for (const part of planParts(r)) {
    lines.push(`- ${LEVER_NAME[part.lever]}: ${dollars(part.amount)}`);
  }
  lines.push(`Cash locked away: ${dollars(p.totalContribution)}`);
  lines.push(`Tax before: ${cents(p.taxBefore)}`);
  lines.push(`Tax after: ${cents(p.taxAfter)}`);
  lines.push(`Tax saved: ${cents(p.taxSaved)}` + (p.totalContribution > 0 ? ` (${centsPerDollar(p.savingRate)} back per dollar)` : ''));
  lines.push(`Why it stops there: ${stopReason(r)}`);
  if (monthlyPlan.schedule.length > 0) {
    lines.push('');
    lines.push(`Set aside by ${longDate(monthlyPlan.deadline)}:`);
    for (const row of monthlyPlan.schedule) {
      const split = LEVERS.filter((l) => row.amounts[l] > 0)
        .map((l) => `${LEVER_SHORT[l]} ${dollars(row.amounts[l])}`)
        .join(', ');
      lines.push(`- ${monthLabel(row.month)}: ${dollars(row.total)}` + (split ? ` (${split})` : ''));
    }
  }
  lines.push('');
  lines.push('Estimate only. Not tax advice. Not affiliated with IRAS or the CPF Board.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Before you transfer
// ---------------------------------------------------------------------------

export interface FactRow {
  label: string;
  values: Record<LeverId, string>;
}

/** What locking the money away means for each scheme (SPEC 5.4), with the year's figures filled in. */
export function lockUpFacts(r: PlannerResult): FactRow[] {
  const { rules, levers } = r;
  const year = rules.incomeYear;
  const frs = dollars(rules.cpfTopUp.fullRetirementSum);
  const bhs = dollars(rules.cpfTopUp.basicHealthcareSum);
  const floor = pct(rules.cpfTopUp.interestRateSmra);
  const deadline = dayAndMonth(rules.contributionDeadline);
  return [
    {
      label: 'Relief each year',
      values: {
        srs: `Up to ${dollars(levers.srs.statutoryCap)}.`,
        cpfSelf: `Up to ${dollars(rules.cpfTopUp.selfReliefCap)}, shared between your Special or Retirement Account and your MediSave.`,
        cpfFamily: `Up to ${dollars(rules.cpfTopUp.familyReliefCap)} across all family members.`,
      },
    },
    {
      label: 'Locked until',
      values: {
        srs:
          `The retirement age set when you made your first contribution: ${rules.srs.statutoryRetirementAge} ` +
          `if you start by the end of ${year}. Older accounts keep the age that applied when they were opened.`,
        cpfSelf:
          'You can start CPF payouts. The money becomes part of your monthly retirement payouts (CPF LIFE). ' +
          'MediSave top-ups can only pay for healthcare.',
        cpfFamily: 'It is a gift. The money belongs to the family member.',
      },
    },
    {
      label: 'If you need it sooner',
      values: {
        srs: 'You can withdraw early, but the whole amount is taxed and there is a 5% penalty.',
        cpfSelf: 'You cannot take it back. A top-up cannot be reversed.',
        cpfFamily: 'You cannot take it back. A top-up cannot be reversed.',
      },
    },
    {
      label: 'What it earns',
      values: {
        srs: '0.05% a year unless you invest it.',
        cpfSelf: `At least ${floor} a year, a floor rate extended to the end of 2027.`,
        cpfFamily: `At least ${floor} a year, in the family member's account.`,
      },
    },
    {
      label: 'Tax later',
      values: {
        srs:
          'Half of each withdrawal is taxable. You can spread withdrawals over up to 10 years; with no other ' +
          'income, S$40,000 a year comes out tax-free.',
        cpfSelf: 'None.',
        cpfFamily: 'None.',
      },
    },
    {
      label: 'Account limits',
      values: {
        srs: 'None beyond the yearly cap. Banks reject anything over it.',
        cpfSelf:
          `Below 55: your Special Account up to the Full Retirement Sum (${frs}). From 55: relief only up to the ` +
          `Full Retirement Sum in your Retirement Account. MediSave: up to the Basic Healthcare Sum (${bhs}).`,
        cpfFamily: "The same limits, measured on the family member's accounts.",
      },
    },
    {
      label: 'No relief for',
      values: {
        srs: 'Anything over the yearly cap.',
        cpfSelf:
          'CPF-to-CPF transfers, top-ups that attract a matching grant (the Matched Retirement Savings Scheme, ' +
          'or the Matched MediSave Scheme from 2026), and amounts above the limits.',
        cpfFamily: 'The same exclusions as a top-up to yourself.',
      },
    },
    {
      label: 'Who qualifies',
      values: {
        srs: `Age ${rules.srs.minAge} or over, not an undischarged bankrupt, and a tax resident for YA${rules.ya}.`,
        cpfSelf: 'Singapore Citizens and Permanent Residents.',
        cpfFamily:
          'Citizens and PRs topping up parents, parents-in-law, grandparents or grandparents-in-law. A spouse or ' +
          'sibling counts only if they earned no more than S$8,000 last year or have a disability.',
      },
    },
    {
      label: 'Deadline',
      values: {
        srs: `${deadline}, or your bank's earlier cut-off (for example 7pm on the last day).`,
        cpfSelf: `Received by the CPF Board by ${deadline}.`,
        cpfFamily: `Received by the CPF Board by ${deadline}.`,
      },
    },
  ];
}

/** Things only the person can check. */
export function eligibilityCautions(r: PlannerResult): string[] {
  const { rules, levers } = r;
  const out: string[] = [];
  out.push(
    `This plan is for employees who are Singapore tax residents for YA${rules.ya}. Self-employed income and ` +
      'non-residents follow different rules.',
  );
  if (levers.cpfSelf.eligible || levers.cpfFamily.eligible) {
    out.push(
      'Log in to CPF to see how far each account is from the Full Retirement Sum and the Basic Healthcare Sum. ' +
        'A top-up above those limits earns no relief, and this tool cannot see your balances.',
    );
    out.push('A top-up that attracts a government matching grant earns no tax relief.');
  }
  if (levers.cpfFamily.eligible) {
    out.push(
      'For a family top-up, check that the family member qualifies before you transfer. A top-up cannot be reversed if they do not.',
    );
  }
  out.push(
    'If you have unused Parenthood Tax Rebate, you will pay less tax this year than shown here. The saving from ' +
      'this plan arrives later, when the rebate would otherwise have run out.',
  );
  out.push(
    `Aim to transfer a few working days before ${shortDate(rules.contributionDeadline)}. Banks stop taking ` +
      'same-day SRS contributions before midnight on the last day, and a CPF top-up counts on the day the CPF Board receives it.',
  );
  return out;
}

/** What the model leaves out (SPEC section 1, non-goals). */
export const NOT_MODELLED: string[] = [
  'Self-employed income, and MediSave contributions that self-employed people must make.',
  'People who are not tax residents: they get no personal reliefs and pay different rates.',
  'Investment returns inside SRS or CPF, and what your balances will be at retirement.',
  'Parenthood Tax Rebate balances.',
  'Employer SRS contributions, the Not Ordinarily Resident scheme, foreign-sourced income and rental expenses.',
  'Your CPF balances, whether a top-up attracts a matching grant, and whether a family member qualifies.',
];

/** Approximations in the CPF estimate (SPEC 6.1). */
export const APPROXIMATIONS: string[] = [
  'Employee CPF is worked out month by month on your salary, with the employee share rounded down each month. ' +
    'Bonuses are treated as paid in December. Real payslips can differ by a few dollars: for an exact match, ' +
    'enter the figure from your CPF statement under Income, More options.',
  'If you worked part of the year, the months are counted as the last months of the year.',
  'A Permanent Resident is treated as being in the same PR year for the whole income year.',
];
