/**
 * Words. Every sentence the calculator builds from engine output lives here, so the copy can be read
 * and tested in one place. No number is worked out here: each figure is read from the PlannerResult.
 *
 * What locking the money away means, the things only the person can check, what the tool leaves out and the
 * disclaimer are NOT written here: they come from the engine (`lockUpFacts`, `transferCautions`, `NOT_MODELLED`,
 * `DISCLAIMER`), which is the one copy shared with the workbook. This file only picks rows out of them.
 */
import { DISCLAIMER, NON_RESIDENT_SRS_COST, NOT_MODELLED, lockUpFacts, lockUpHorizon, transferCautions } from '../engine';
import type { LockUpFactId, LockUpFactRow } from '../engine';
import type {
  LadderTier,
  LeverId,
  PlannerResult,
  PlannerWarning,
  Residency,
  ScenarioId,
  WarningCode,
  YearRules,
} from '../engine/types';
import { cents, centsPerDollar, countOf, dollars, listOf, longDate, monthLabel, pct, shortDate } from './format';
import { defaultMinRate, rateBelowLeavingCost } from './state';
import type { Depth, Order, UiState, WhatIf } from './state';

export const LEVERS: LeverId[] = ['srs', 'cpfSelf', 'cpfFamily'];

/**
 * Scheme names, for labels, table headings and rows. A CPF amount is always named as a cash top-up: that is
 * the transaction that earns relief, and a "contribution" to all three CPF accounts is not.
 */
export const LEVER_NAME: Record<LeverId, string> = {
  srs: 'SRS',
  cpfSelf: 'CPF cash top-up, self',
  cpfFamily: 'CPF cash top-up, family',
};

/** Completes "Put S$X into ...". */
const LEVER_INTO: Record<LeverId, string> = {
  srs: 'SRS',
  cpfSelf: 'your CPF as a cash top-up',
  cpfFamily: "family members' CPF as a cash top-up",
};

/** Scheme names that read as part of a sentence ("Switching on ... would ..."), as the tick boxes name them. */
const LEVER_PROSE: Record<LeverId, string> = {
  srs: 'SRS',
  cpfSelf: 'the CPF cash top-up to yourself',
  cpfFamily: 'the CPF cash top-up to family',
};

export const SCENARIO_NAME: Record<ScenarioId, string> = {
  none: 'Do nothing more',
  srsOnly: 'SRS only',
  cpfSelfOnly: 'CPF cash top-up to self only',
  srsPlusCpfSelf: 'SRS and CPF cash top-up to self',
  maxAll: 'Everything to the limit',
  recommended: 'Your plan',
};

export const DEPTHS: Depth[] = ['default', 'top', 'every', 'custom'];

/**
 * The name of a "How far down the ladder?" choice. The default is named by its figure, which follows the
 * residency: "7 cents or more" for citizens and PRs, "11.5 cents or more" for foreigners.
 */
export function depthLabel(depth: Depth, residency: Residency): string {
  switch (depth) {
    case 'top':
      return 'Top bracket only';
    case 'every':
      return 'Every tax dollar';
    case 'custom':
      return 'Custom';
    case 'default':
    default:
      return `${centsPerDollar(defaultMinRate(residency))} or more`;
  }
}

export const ORDER_LABEL: Record<Order, { title: string; route: string }> = {
  flexibility: { title: 'Flexibility first', route: 'SRS, then CPF self, then family' },
  interest: { title: 'Guaranteed interest first', route: 'CPF self, then SRS, then family' },
  family: { title: 'Family first', route: 'Family, then SRS, then CPF self' },
};

// ---------------------------------------------------------------------------
// The shared facts (engine/facts.ts), picked apart for the page
// ---------------------------------------------------------------------------

/** What locking the money away means for this person, from the engine. */
export function factsFor(r: PlannerResult): LockUpFactRow[] {
  const { residency, ageAtYearEnd } = r.input.profile;
  return lockUpFacts(r.rules, { residency, ageAtYearEnd });
}

/** One cell of the lock-up facts: the engine's sentence for a fact and a scheme. Empty if the row is missing. */
export function fact(rows: LockUpFactRow[], id: LockUpFactId, lever: LeverId): string {
  return rows.find((row) => row.id === id)?.values[lever] ?? '';
}

/** The things only the person can check before moving money, from the engine. */
export function cautionsFor(r: PlannerResult): string[] {
  const { residency, ageAtYearEnd } = r.input.profile;
  return transferCautions(r.rules, { residency, ageAtYearEnd }, { deadlinePassed: deadlinePassed(r) });
}

/**
 * The engine's caution about a family top-up, whole: check that the member qualifies, and count only what the
 * Government does not match, with the year's matched amounts. It is the hint beside "Most I would give", so
 * the amounts are worded once, by the engine, and the form and the checklist cannot drift apart. Empty when
 * the engine has no such line for this person (a foreigner).
 */
export function familyCaution(r: PlannerResult): string {
  return cautionsFor(r).find((line) => /\bfamily top-up\b/i.test(line)) ?? '';
}

/**
 * The engine's caution about where a person finds their own CPF figures (from 55: the Retirement dashboard,
 * and why the figure matters), whole. It opens the hint on "Top-up that can still earn relief" from 55. Empty
 * when the engine has no such line for this person (a foreigner).
 */
export function balanceCaution(r: PlannerResult): string {
  return cautionsFor(r).find((line) => /^Log in to CPF\b/.test(line)) ?? '';
}

/** True when a CPF cash top-up, to the person or to family, is open to them. False for a foreigner. */
export function cpfOpen(r: PlannerResult): boolean {
  return r.levers.cpfSelf.eligible || r.levers.cpfFamily.eligible;
}

/** True for a line that is about CPF and nothing else on this page (it names CPF and does not name SRS). */
function onlyAboutCpf(line: string): boolean {
  return /\bCPF\b/.test(line) && !/\bSRS\b/.test(line);
}

/**
 * What the model leaves out, from the engine, each entry as the engine words it. The entries that are only
 * about CPF are left off the page of someone no CPF top-up is open to.
 */
export function notModelledFor(r: PlannerResult): string[] {
  return cpfOpen(r) ? NOT_MODELLED : NOT_MODELLED.filter((line) => !onlyAboutCpf(line));
}

/** The sources for the year's rules. Someone with no CPF and no CPF top-up is not sent to read CPF rules. */
export function sourcesFor(r: PlannerResult): { label: string; url: string }[] {
  return cpfOpen(r) || r.cpf.source !== 'none' ? r.rules.sources : r.rules.sources.filter((s) => !onlyAboutCpf(s.label));
}

/**
 * The reason behind each "Which first?" choice, as the engine's lock-up facts put it: a scheme name, then the
 * fact. "Family first" is a preference, not a fact about lock-up, so it has a plain line of its own.
 */
export function orderWhy(order: Order, rows: LockUpFactRow[]): { term: string; text: string }[] {
  switch (order) {
    case 'flexibility':
      return [
        { term: 'SRS', text: fact(rows, 'sooner', 'srs') },
        { term: 'CPF', text: fact(rows, 'sooner', 'cpfSelf') },
      ];
    case 'interest':
      return [
        { term: 'CPF', text: fact(rows, 'earns', 'cpfSelf') },
        { term: 'SRS', text: fact(rows, 'earns', 'srs') },
      ];
    case 'family':
    default:
      return [{ term: '', text: "Builds a family member's retirement or MediSave savings before your own." }];
  }
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/**
 * Said wherever a plan for a closed year is shown, so nobody reads it as an instruction. These are the closing
 * words of the engine's own DEADLINE_PASSED message (SPEC 6.11); a test holds the two together.
 */
export const COUNTS_NEXT_YEAR = 'Money you put in now counts for the following year instead.';

/** True once the last day to contribute for the income year on screen has gone by. */
export function deadlinePassed(r: PlannerResult): boolean {
  return r.monthlyPlan.daysToDeadline < 0;
}

/**
 * True when the person is 55 or over, has their own CPF switched on and has not yet entered how much they can
 * still top up with relief. The engine then leaves their own CPF out of the plan and says so.
 */
export function ownCpfLeftOut(r: PlannerResult): boolean {
  return r.warnings.some((w) => w.code === 'CPF_SELF_ROOM_UNCONFIRMED');
}

/**
 * What the person's own CPF is waiting for, in the words of the engine's own caution (CPF_SELF_ROOM_UNCONFIRMED,
 * SPEC 6.11), so the card and the caution under it say the same thing. A test holds the two together.
 */
const ROOM_AWAITED = 'until you enter how much you can still top up with relief';

/** Said wherever the page explains that the person's own CPF is waiting for a figure. */
const LEFT_OUT = `Your own CPF is left out ${ROOM_AWAITED}`;

/**
 * Added to the lead-in of "Compare options" while the person's own CPF is waiting for its figure: nothing is
 * assumed about it there either. Starts with a space; empty otherwise.
 */
export function compareLeftOut(r: PlannerResult): string {
  return ownCpfLeftOut(r) ? ` Your own CPF is left out of them ${ROOM_AWAITED}.` : '';
}

/**
 * "S$15,300 into SRS", "S$8,000 into your CPF as a cash top-up" for each scheme the plan uses, in the order the
 * person chose under "Which first?".
 */
export function planParts(r: PlannerResult): { lever: LeverId; amount: number; into: string }[] {
  return r.input.preferences.priority
    .filter((lever) => r.plan.contributions[lever] > 0)
    .map((lever) => ({ lever, amount: r.plan.contributions[lever], into: LEVER_INTO[lever] }));
}

/** "S$15,300 into SRS and S$8,000 into your CPF as a cash top-up" for a set of amounts, in the plan's order. */
function intoList(r: PlannerResult, amounts: Record<LeverId, number>): string {
  return listOf(
    r.input.preferences.priority
      .filter((lever) => amounts[lever] > 0)
      .map((lever) => `${dollars(amounts[lever])} into ${LEVER_INTO[lever]}`),
  );
}

/**
 * After the deadline the plan can no longer be acted on, so it is described as what it would have done.
 * "Putting S$15,300 into SRS and S$8,000 into your CPF as a cash top-up by 31 Dec 2025 would have saved ..."
 */
export function lookingBack(r: PlannerResult): string {
  const parts = planParts(r).map((p) => `${dollars(p.amount)} into ${p.into}`);
  if (parts.length === 0) return `On these numbers there was nothing more worth putting in for YA${r.rules.ya}.`;
  return (
    `Putting ${listOf(parts)} by ${shortDate(r.monthlyPlan.deadline)} would have saved ` +
    `${cents(r.plan.taxSaved)} in tax for YA${r.rules.ya}.`
  );
}

/**
 * The words for a S$0 plan. "Nothing more to put in this year" would be wrong while the person's own CPF is
 * only waiting for a figure, so then it is "yet".
 */
export function nothingText(r: PlannerResult): string {
  return ownCpfLeftOut(r) && r.plan.bindingConstraint === 'leverLimits'
    ? 'Nothing to put in yet'
    : 'Nothing more to put in this year';
}

/** The one-sentence recommendation, as plain text (announced to screen readers and copied). */
export function headline(r: PlannerResult): string {
  if (deadlinePassed(r)) return `The deadline for YA${r.rules.ya} has passed. ${lookingBack(r)}`;
  const parts = planParts(r).map((p) => `${dollars(p.amount)} into ${p.into}`);
  if (parts.length === 0) return `${nothingText(r)}.`;
  return `Put ${listOf(parts)}. You save ${cents(r.plan.taxSaved)} in tax.`;
}

/** What one change of setting would do, in the engine's own figures. Starts with a space; empty without a hint. */
function whatIfSentence(hint: WhatIf | null | undefined): string {
  if (!hint) return '';
  const saved = cents(hint.plan.taxSaved);
  if (hint.kind === 'noCashLimit') {
    return ` Without the limit the plan would save ${saved} by locking away ${dollars(hint.plan.totalContribution)}.`;
  }
  const names = listOf(hint.levers.map((l) => LEVER_PROSE[l]));
  const family = hint.levers.includes('cpfFamily') ? ', if you have a family member who qualifies' : '';
  return ` Switching on ${names} would raise the saving to ${saved}${family}.`;
}

export interface ReasonOptions {
  /**
   * True while the default preset is the one selected under "How far down the ladder?". The sentence then
   * says "the default minimum", not "you asked for".
   */
  defaultMinimum?: boolean;
  /**
   * For a foreigner whose plan is S$0: what going all the way down the ladder would cost on the way out (see
   * `leavingCaveat`). Said wherever the page mentions the Every tax dollar view as a way to save more.
   */
  deeperCaveat?: string;
}

/**
 * The offer under a S$0 plan: what the engine's plan with no minimum (`deeper`) would save, and what it would
 * lock away to do it.
 */
export function deeperOffer(deeper: PlannerResult): string {
  const { taxSaved, totalContribution, savingRate } = deeper.plan;
  return (
    `Going all the way down the ladder would save ${cents(taxSaved)} by locking away ` +
    `${dollars(totalContribution)}: ${centsPerDollar(savingRate)} back per dollar.`
  );
}

/**
 * What a foreigner must be told before going deeper: how much of that plan saves less today than taking SRS
 * out costs, at the least, once they have left Singapore. The amount is the engine's own (`lowValueAmount` of
 * its SRS caution for that plan). Empty for citizens and PRs, and when no dollar of the plan is below the cost.
 */
export function leavingCaveat(deeper: PlannerResult): string {
  const low = deeper.warnings.find((w) => w.code === 'SRS_NON_RESIDENT_WITHDRAWAL')?.params?.lowValueAmount;
  const total = deeper.plan.totalContribution;
  if (typeof low !== 'number' || low <= 0 || total <= 0) return '';
  const cost = centsPerDollar(NON_RESIDENT_SRS_COST.atRetirementOrTenYears);
  return (
    `${low >= total ? 'All' : dollars(low)} of that plan saves less than ${cost} per dollar, the least you ` +
    'would pay in tax to take SRS out after leaving Singapore.'
  );
}

/**
 * Why the plan stops where it does. Covers every BindingConstraint, with and without a contribution.
 * `hint` is the engine's plan with one setting changed (see `whatIf` in state.ts); when it is given, the
 * sentence says what that change would save. It never quotes a saving that no setting can reach.
 */
export function stopReason(r: PlannerResult, hint?: WhatIf | null, options: ReasonOptions = {}): string {
  const { plan: p, rules, baseline, levers } = r;
  const some = p.totalContribution > 0;
  const minRate = r.input.preferences.minSavingRate;
  const cap = dollars(rules.personalReliefCap);

  switch (p.bindingConstraint) {
    case 'usefulRoom': {
      if (!some) {
        if (minRate > 0) {
          const most = `Each extra dollar would save ${centsPerDollar(p.marginalRateBefore)} or less in tax`;
          return options.defaultMinimum
            ? `Nothing clears the minimum. ${most}, and the default minimum is ${centsPerDollar(minRate)}.`
            : `Nothing clears your minimum. ${most}, and you asked for at least ${centsPerDollar(minRate)}.`;
        }
        return 'The rest of your income is already tax-free, so extra dollars would save nothing.';
      }
      if (p.marginalRateAfter > 0) {
        return (
          `Beyond this, each extra dollar would save ${centsPerDollar(p.marginalRateAfter)} or less, below ` +
          (options.defaultMinimum
            ? `the default minimum of ${centsPerDollar(minRate)}.`
            : `your ${centsPerDollar(minRate)} minimum.`)
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
      return some
        ? `This uses your whole ${limit} cash limit.${whatIfSentence(hint)}`
        : `Your cash limit is ${limit}, so there is nothing to put in.${whatIfSentence(hint)}`;
    }
    case 'leverLimits': {
      const anyOn = LEVERS.some((l) => levers[l].eligible && levers[l].enabled);
      if (!anyOn) {
        return 'No scheme is switched on. Choose at least one under "Schemes to use" to get a plan.';
      }
      // From 55 a blank figure for the person's own CPF is "not confirmed", not "full": never call it full.
      if (ownCpfLeftOut(r)) {
        return some
          ? `You have filled every other scheme you switched on. ${LEFT_OUT}.${whatIfSentence(hint)}`
          : `Nothing can go in yet. ${LEFT_OUT}, and nothing else you switched on has room left.${whatIfSentence(hint)}`;
      }
      if (!some) {
        return `The schemes you switched on have no room left for ${rules.incomeYear}.${whatIfSentence(hint)}`;
      }
      // marginalRateAfter is the rate on the last dollar of chargeable income, which is what one more
      // dollar of relief would save.
      const next =
        p.marginalRateAfter > 0
          ? ` Another dollar of relief would still save ${centsPerDollar(p.marginalRateAfter)} in tax` +
            (hint ? '.' : ', but there is no room left for it.')
          : '';
      return `You have filled every scheme you switched on.${next}${whatIfSentence(hint)}`;
    }
    case 'none':
    default:
      if (baseline.taxPayable === 0) {
        return `On these numbers you have no tax to pay for YA${rules.ya}, so contributions would save nothing.`;
      }
      return 'There is nothing to recommend with these settings.';
  }
}

/**
 * Said on the card when the person's own CPF is left out and the sentence about where the plan stops does not
 * already say so (the plan was stopped by something else: the cash limit, the minimum, the relief cap).
 */
export function leftOutSentence(r: PlannerResult): string {
  if (!ownCpfLeftOut(r) || deadlinePassed(r)) return '';
  const { bindingConstraint } = r.plan;
  const anyOn = LEVERS.some((l) => r.levers[l].eligible && r.levers[l].enabled);
  return bindingConstraint === 'leverLimits' && anyOn ? '' : `${LEFT_OUT}.`;
}

/**
 * The cautions that decide whether a recommended dollar earns relief (SPEC 8.4). They are shown with the
 * recommendation, in the engine's words and the engine's order, and are not repeated in the list lower down.
 */
export const PLAN_CAUTION_CODES: readonly WarningCode[] = [
  'TAX_RESIDENCY_CHECK',
  'SRS_NON_RESIDENT_WITHDRAWAL',
  'CPF_SELF_ROOM_UNCONFIRMED',
  'FAMILY_TOPUP_CHECKS',
  'PARENTHOOD_TAX_REBATE',
];

export function planCautions(r: PlannerResult): PlannerWarning[] {
  return r.warnings.filter((w) => PLAN_CAUTION_CODES.includes(w.code));
}

/**
 * How long the cash is locked away, one line per scheme that is in the plan, in the plan's order:
 * "SRS: locked until 64, about 29 years." "CPF: paid out monthly from 65, about 30 years."
 * The ages and years are the engine's (`lockUpHorizon`). A family top-up is not locked for a time, it is given
 * away: the line is the engine's own sentence for "if you need it sooner".
 *
 * The SRS age is the one a first contribution made this year locks in, so the line is not the whole story for
 * two groups, and says so:
 * - a foreigner can also take SRS out under the 10-year rule for foreigners, which for most comes long before
 *   the retirement age: their line names the rule (the facts under "Before you transfer" give it in full);
 * - someone who has contributed before keeps the age set then (see `horizonNote`).
 */
export function horizonLines(r: PlannerResult): string[] {
  const h = lockUpHorizon(r.rules, r.input.profile.ageAtYearEnd);
  const span = (years: number): string =>
    years > 0 ? `about ${countOf(years, 'year')}` : 'an age you have already reached';
  const tenYearRule =
    r.input.profile.residency === 'foreigner' && h.srsYears > 0
      ? ', or until you can use the 10-year rule for foreigners if that comes first'
      : '';
  const line: Record<LeverId, () => string> = {
    srs: () => `SRS: locked until ${h.srsAge}, ${span(h.srsYears)}${tenYearRule}.`,
    cpfSelf: () => `CPF: paid out monthly from ${h.cpfPayoutAge}, ${span(h.cpfYears)}.`,
    cpfFamily: () => `Family top-up: ${fact(factsFor(r), 'sooner', 'cpfFamily')}`,
  };
  return planParts(r).map((part) => line[part.lever]());
}

/**
 * The condition on the SRS line above, said straight after the lines: the age shown is for a first
 * contribution made now, and anyone who has paid into SRS before keeps the age their first contribution set,
 * which may be lower. (Which age, and from which dates, is the engine's "Locked until" fact lower down.) Empty
 * when SRS is not in the plan, and for someone who has already reached the age shown.
 */
export function horizonNote(r: PlannerResult): string {
  if (r.plan.contributions.srs <= 0) return '';
  const h = lockUpHorizon(r.rules, r.input.profile.ageAtYearEnd);
  if (h.srsYears <= 0) return '';
  return `If you have paid into SRS before, your SRS age was set by your first contribution and may be lower than ${h.srsAge}.`;
}

/** One line under the "How far down the ladder?" control, for the chosen depth. */
export function depthExplanation(depth: Depth, r: PlannerResult): string {
  const top = r.baseline.marginalRate;
  switch (depth) {
    case 'default':
      return `Only lock away dollars that each save at least ${centsPerDollar(defaultMinRate(r.input.profile.residency))} in tax.`;
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

/**
 * Why a foreigner's default is not the citizens' 7 cents: leaving Singapore makes SRS cost more than that to
 * take out again. Says that they can still choose to go deeper.
 */
export function foreignerDepthNote(rules: YearRules): string {
  const cost = centsPerDollar(NON_RESIDENT_SRS_COST.atRetirementOrTenYears);
  const skipped = rateBelowLeavingCost(rules);
  const rung = skipped > 0 ? `the ${pct(skipped)} rung would be a loss` : 'a smaller saving would be a loss';
  return (
    `A foreigner who has left Singapore pays at least ${cost} per dollar in tax to take SRS out, so ${rung}. ` +
    `That is why your default is ${centsPerDollar(defaultMinRate('foreigner'))} or more. You can still choose to go deeper.`
  );
}

/** One line under Residency, for every choice: what a tax resident is (SPEC 5.4, "Tax residency"). */
export function residencyHint(residency: Residency, incomeYear: number): string {
  const base =
    `This tool is for tax residents: broadly, people who stayed or worked in Singapore for at least 183 days in ${incomeYear}.`;
  return residency === 'foreigner' ? `${base} A non-resident gets no personal reliefs and no SRS relief.` : base;
}

// ---------------------------------------------------------------------------
// New to this?
// ---------------------------------------------------------------------------

/**
 * A few short lines for someone who has never used either scheme (SPEC 8.4). The CPF line is left off the page
 * of someone no CPF top-up is open to.
 */
export function newToThis(r: PlannerResult): { term: string; text: string }[] {
  const lines = [
    {
      term: 'SRS',
      text:
        'The Supplementary Retirement Scheme is a voluntary retirement account at DBS, OCBC or UOB. ' +
        'You must open it before your first contribution.',
    },
  ];
  if (cpfOpen(r)) {
    lines.push({
      term: 'CPF cash top-up',
      text:
        "Cash you pay into your own or a family member's Special or Retirement Account, or MediSave, in the CPF " +
        'app or on the CPF website. It is not a "contribution to my three CPF accounts".',
    });
    lines.push({
      term: 'Claiming',
      text: 'There is nothing to claim. The bank and the CPF Board report both to IRAS for you.',
    });
  } else {
    lines.push({ term: 'Claiming', text: 'There is nothing to claim. The bank reports it to IRAS for you.' });
  }
  return lines;
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

/** The explanation shown in place of the chart when no slice of the ladder saves any tax. */
export function flatLadderText(r: PlannerResult): string {
  const reasons = new Set(r.ladder.map((t) => t.zeroReason));
  const why =
    reasons.size !== 1
      ? 'The table gives the reason for each slice.'
      : reasons.has('reliefCap')
        ? `Your reliefs are already over the ${dollars(r.rules.personalReliefCap)} cap.`
        : 'The income they would come off is already tax-free.';
  return `On these numbers no extra contribution would save tax, so there are no steps to draw. ${why}`;
}

export function tierPlanUse(t: LadderTier): string {
  if (t.usedByPlan <= 0) return 'None';
  if (t.usedByPlan >= t.amount) return 'All';
  return `${dollars(t.usedByPlan)} of it`;
}

/** The same, for the middle of a sentence: "none", "all", "S$20,000 of it" (the S of S$ stays a capital). */
export function tierPlanUseInline(t: LadderTier): string {
  if (t.usedByPlan <= 0) return 'none';
  if (t.usedByPlan >= t.amount) return 'all';
  return `${dollars(t.usedByPlan)} of it`;
}

/**
 * Shown in place of the ladder when there are no tiers at all: either nothing is switched on, or everything
 * that is switched on is already full (or, from 55, waiting for a figure). It only suggests switching a scheme
 * on when one is there to switch on.
 */
export function ladderEmptyText(r: PlannerResult): string {
  const open = LEVERS.filter((l) => r.levers[l].eligible);
  const anyOn = open.some((l) => r.levers[l].enabled);
  const anyOff = open.some((l) => !r.levers[l].enabled);
  if (!anyOn) {
    return anyOff
      ? 'No scheme is switched on. Switch one on under "Schemes to use" to see its ladder.'
      : 'No scheme is open to you on these numbers, so there is no ladder to draw.';
  }
  if (ownCpfLeftOut(r)) {
    return `There is no ladder to draw yet. ${LEFT_OUT}, and nothing else you switched on has room left.`;
  }
  return (
    `The schemes you switched on are full for ${r.rules.incomeYear}.` +
    (anyOff ? ' Switch on another under "Schemes to use" to see what it would save.' : '')
  );
}

/** Text alternative for the chart as a whole. */
export function ladderSummary(r: PlannerResult): string {
  if (r.ladder.length === 0) return ladderEmptyText(r);
  const tiers = r.ladder.map((t) =>
    t.rate > 0
      ? `${tierRange(t)} saves ${centsPerDollar(t.rate)} per dollar, ${cents(t.taxSaved)} in total`
      : `${tierRange(t)} saves no tax (${zeroReasonText(t, r.rules)})`,
  );
  return `Savings ladder. ${tiers.join('. ')}. Your plan uses the first ${dollars(r.plan.totalContribution)}.`;
}

// ---------------------------------------------------------------------------
// Monthly plan
// ---------------------------------------------------------------------------

/** "S$1,275 into SRS and S$667 into your CPF as a cash top-up": the same plan spread over twelve months. */
export function fullYearSplit(r: PlannerResult): string {
  return intoList(r, r.monthlyPlan.fullYearMonthly);
}

/**
 * Set when an instalment is larger than the monthly salary entered (and that salary is above 0): the amount of
 * the largest instalment, and the sentence that says so (SPEC 8.4). null otherwise, and once the deadline has
 * passed.
 */
export function affordabilityNote(r: PlannerResult): { amount: number; text: string } | null {
  const salary = r.input.income.monthlyOrdinaryWage;
  if (deadlinePassed(r) || salary <= 0) return null;
  const amount = r.monthlyPlan.schedule.reduce((most, row) => Math.max(most, row.total), 0);
  if (amount <= salary) return null;
  return {
    amount,
    text: `${dollars(amount)} a month is more than your monthly salary. It would have to come from your bonus or savings.`,
  };
}

/**
 * The cut-off for each scheme that is in the plan, in the engine's words (the "Deadline" row of the lock-up
 * facts). A plan with no CPF top-up says nothing about the CPF Board, and a plan with no SRS nothing about banks.
 */
export function deadlineLines(r: PlannerResult): { term: string; text: string }[] {
  const rows = factsFor(r);
  const { srs, cpfSelf, cpfFamily } = r.plan.contributions;
  const out: { term: string; text: string }[] = [];
  if (srs > 0) out.push({ term: 'SRS', text: fact(rows, 'deadline', 'srs') });
  if (cpfSelf > 0) out.push({ term: 'CPF cash top-up', text: fact(rows, 'deadline', 'cpfSelf') });
  else if (cpfFamily > 0) out.push({ term: 'CPF cash top-up', text: fact(rows, 'deadline', 'cpfFamily') });
  return out;
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
  const pay = ui.payMode === 'annual' ? `${dollars(ui.salary)} a year` : `${dollars(ui.salary)} a month`;
  const months = ui.monthsWorked < 12 ? ` for ${countOf(ui.monthsWorked, 'month')}` : '';
  lines.push(`${pay}${months}, ${dollars(ui.bonus)} bonus`);
  lines.push(`${dollars(otherReliefs)} other reliefs`);
  if (ui.cashLimit !== null) lines.push(`Cash to spare: ${dollars(ui.cashLimit)}`);
  const already: string[] = [];
  if (ui.existingSrs > 0) already.push(`SRS ${dollars(ui.existingSrs)}`);
  if (ui.residency !== 'foreigner') {
    if (ui.existingCpfSelf > 0) already.push(`CPF self ${dollars(ui.existingCpfSelf)}`);
    if (ui.existingCpfFamily > 0) already.push(`CPF family ${dollars(ui.existingCpfFamily)}`);
  }
  if (already.length > 0) lines.push(`Already contributed: ${already.join(', ')}`);
  return lines;
}

/** "Still using the example's bonus and other reliefs." Empty when nothing of the example is left. */
export function exampleLeftText(names: string[]): string {
  return names.length === 0 ? '' : `Still using the example's ${listOf(names)}.`;
}

/** The plain-text summary behind the Copy summary button. */
export function summaryText(
  r: PlannerResult,
  isExample: boolean,
  hint?: WhatIf | null,
  options: ReasonOptions = {},
): string {
  const { plan: p, rules, monthlyPlan } = r;
  const past = deadlinePassed(r);
  const lines: string[] = [];
  lines.push(
    `Singapore Tax Optimiser: ${past ? 'looking back at' : 'plan for'} YA${rules.ya} (income year ${rules.incomeYear})`,
  );
  if (rules.status === 'projected') {
    lines.push(`Projected rules: the figures for ${rules.incomeYear} are provisional and may change.`);
  }
  if (isExample) lines.push('Example figures, not my own numbers.');
  lines.push('');
  lines.push(headline(r));
  if (past) lines.push(COUNTS_NEXT_YEAR);
  for (const part of planParts(r)) {
    lines.push(`- ${LEVER_NAME[part.lever]}: ${dollars(part.amount)}`);
  }
  lines.push(`${past ? 'Cash it would have locked away' : 'Cash locked away'}: ${dollars(p.totalContribution)}`);
  lines.push(`Tax before: ${cents(p.taxBefore)}`);
  lines.push(`${past ? 'Tax with the plan' : 'Tax after'}: ${cents(p.taxAfter)}`);
  lines.push(
    `${past ? 'Tax it would have saved' : 'Tax saved'}: ${cents(p.taxSaved)}` +
      (p.totalContribution > 0 ? ` (${centsPerDollar(p.savingRate)} back per dollar)` : ''),
  );
  if (!past) {
    const leftOut = leftOutSentence(r);
    lines.push(`Why it stops there: ${stopReason(r, hint, options)}${leftOut ? ` ${leftOut}` : ''}`);
    const horizon = horizonLines(r);
    const note = horizonNote(r);
    if (horizon.length > 0) lines.push(`How long it is locked: ${horizon.join(' ')}${note ? ` ${note}` : ''}`);
  }
  // What decides whether a recommended dollar earns relief travels with the plan, wherever it is pasted.
  const cautions = planCautions(r);
  if (cautions.length > 0) {
    lines.push('');
    lines.push(past ? 'To check:' : 'Check before you transfer:');
    for (const caution of cautions) lines.push(`- ${caution.message}`);
  }
  if (!past && monthlyPlan.schedule.length > 0) {
    lines.push('');
    lines.push(`Set aside by ${longDate(monthlyPlan.deadline)}:`);
    for (const row of monthlyPlan.schedule) {
      const split = planParts(r)
        .filter((part) => row.amounts[part.lever] > 0)
        .map((part) => `${LEVER_NAME[part.lever]} ${dollars(row.amounts[part.lever])}`)
        .join('; ');
      lines.push(`- ${monthLabel(row.month)}: ${dollars(row.total)}` + (split ? ` (${split})` : ''));
    }
  }
  lines.push('');
  lines.push(DISCLAIMER);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sources and assumptions
// ---------------------------------------------------------------------------

/**
 * Approximations in the pay and CPF figures (SPEC 6.1). Someone with no CPF (a foreigner on a work pass) is
 * told only about the pay, and the line about PR years is for PRs.
 */
export function approximations(r: PlannerResult): string[] {
  const hasCpf = r.cpf.source !== 'none';
  const out: string[] = [];
  if (hasCpf) {
    out.push(
      'Employee CPF is worked out month by month on your salary, with the employee share rounded down each month. ' +
        'Bonuses are treated as paid in December. Real payslips can differ by a few dollars: for an exact match, ' +
        'enter the figure from your CPF statement under Income, More options.',
    );
  }
  out.push(
    'An annual salary is split into twelve equal months of whole dollars. Any dollars left over are counted ' +
      'with your extra pay, so your income is right to the dollar' +
      (hasCpf ? ' and your CPF is within a dollar or two.' : '.'),
  );
  out.push('If you worked part of the year, the months are counted as the last months of the year.');
  if (r.input.profile.residency === 'pr') {
    out.push('A Permanent Resident is treated as being in the same PR year for the whole income year.');
  }
  return out;
}
