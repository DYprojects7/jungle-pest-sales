/**
 * Warnings (SPEC §6.11). Each one carries a ready-to-display message and the machine-readable values behind it.
 * At most one warning is emitted per code, in the order of the SPEC's table.
 */
import { maxCompulsoryEmployeeCpf } from './cpf';
import { formatLongDate, parseIsoDate } from './dates';
import { taxPayableAfter } from './evaluate';
import type { EngineContext } from './evaluate';
import { formatDollars, formatPercent, formatTax } from './format';
import { LEVER_IDS, totalOf } from './levers';
import { subtractMoney } from './money';
import type { Optimisation } from './optimiser';
import type { LeverId, MonthlyPlan, PlannerWarning } from './types';

/** DEADLINE_SOON applies from this many days before the deadline. */
const DEADLINE_SOON_DAYS = 14;

/** Age from which a CPF top-up to oneself goes to the Retirement Account. */
const RETIREMENT_ACCOUNT_AGE = 55;

/** Where each lever's money goes, to complete "You have already put S$X into …". */
const LEVER_DESTINATIONS: Record<LeverId, string> = {
  srs: 'SRS',
  cpfSelf: 'your own CPF as cash top-ups',
  cpfFamily: "family members' CPF as cash top-ups",
};

/** "1 day" / "5 days". */
function days(count: number): string {
  return count === 1 ? '1 day' : `${count} days`;
}

/** The deadline as written in messages, e.g. "31 December 2026". */
function longDate(iso: string): string {
  const date = parseIsoDate(iso);
  return date ? formatLongDate(date) : iso;
}

function noTaxPayable(ctx: EngineContext): PlannerWarning | null {
  if (ctx.baseline.taxPayable !== 0) return null;
  return {
    code: 'NO_TAX_PAYABLE',
    severity: 'info',
    message:
      `Your estimated tax for YA${ctx.rules.ya} is already S$0, so extra SRS or CPF contributions ` +
      'would not save any tax this year.',
    params: { ya: ctx.rules.ya, chargeableIncome: ctx.baseline.chargeableIncome },
  };
}

function reliefCapExceededBaseline(ctx: EngineContext): PlannerWarning | null {
  const { totalBeforeCap, lostToCap } = ctx.baseline.reliefs;
  if (lostToCap <= 0) return null;
  const cap = ctx.rules.personalReliefCap;
  return {
    code: 'RELIEF_CAP_EXCEEDED_BASELINE',
    severity: 'caution',
    message:
      `Your reliefs already add up to ${formatDollars(totalBeforeCap)}, more than the ${formatDollars(cap)} ` +
      `overall cap. The ${formatDollars(lostToCap)} above the cap is lost, and further SRS or CPF ` +
      'contributions would earn no tax relief.',
    params: { totalBeforeCap, personalReliefCap: cap, lostToCap },
  };
}

function reliefCapLimitsPlan(ctx: EngineContext, optimisation: Optimisation): PlannerWarning | null {
  const { bindingConstraint, totalContribution } = optimisation.plan;
  if (bindingConstraint !== 'reliefCap') return null;
  const cap = ctx.rules.personalReliefCap;
  return {
    code: 'RELIEF_CAP_LIMITS_PLAN',
    severity: 'caution',
    message:
      totalContribution > 0
        ? `The plan stops at ${formatDollars(totalContribution)} because that brings your total reliefs to the ` +
          `${formatDollars(cap)} overall cap. Anything you contribute beyond that earns no tax relief and ` +
          'cannot be refunded.'
        : `Your reliefs have already reached the ${formatDollars(cap)} overall cap, so further SRS or CPF ` +
          'contributions would earn no tax relief.',
    params: { personalReliefCap: cap, reliefCapRoom: ctx.reliefCapRoom, totalContribution },
  };
}

function belowMinSavingRate(ctx: EngineContext, optimisation: Optimisation): PlannerWarning | null {
  if (ctx.baseline.taxPayable <= 0 || optimisation.usefulRoom !== 0) return null;
  const { marginalRate } = ctx.baseline;
  const { minSavingRate } = ctx.input.preferences;
  return {
    code: 'BELOW_MIN_SAVING_RATE',
    severity: 'info',
    message:
      `Every extra dollar you contribute would save at most ${formatPercent(marginalRate)} in tax, below the ` +
      `${formatPercent(minSavingRate)} minimum you set, so nothing is recommended. Lower the minimum to see ` +
      'these smaller savings.',
    params: { marginalRate, minSavingRate },
  };
}

/**
 * The extra tax the plan would save if the ONE limit that stops it were lifted and it could run on to `reach`
 * dollars of contribution: `N(X) − N(reach)` in the SPEC §6.6 notation. `reach` is the smallest of the limits
 * that remain, so this is a saving the person can actually get. (`plan.unrealisedSaving` is not: it is
 * measured down to `min(U, C)` as if the cash limit and every scheme limit were lifted together, which no
 * setting can do, because each scheme is capped by law.)
 */
function savingWithinReach(ctx: EngineContext, optimisation: Optimisation, reach: number): number {
  const { totalContribution, taxAfter } = optimisation.plan;
  return subtractMoney(taxAfter, taxPayableAfter(ctx, Math.max(totalContribution, reach)));
}

/** " <lead-in> could save up to S$X more tax." when there is such a saving, otherwise nothing. */
function couldSaveSentence(saving: number, leadIn: string): string {
  return saving > 0 ? ` ${leadIn} could save up to ${formatTax(saving)} more tax.` : '';
}

function budgetLimitsPlan(ctx: EngineContext, optimisation: Optimisation): PlannerWarning | null {
  const { bindingConstraint, unrealisedSaving } = optimisation.plan;
  const { cashBudget } = ctx.input.preferences;
  if (bindingConstraint !== 'cashBudget' || cashBudget === null) return null;
  // With the cash limit lifted the plan runs on until the minimum rate, the relief cap or the schemes stop it.
  const savingWithMoreCash = savingWithinReach(
    ctx,
    optimisation,
    Math.min(optimisation.usefulRoom, ctx.reliefCapRoom, ctx.leverRoom),
  );
  return {
    code: 'BUDGET_LIMITS_PLAN',
    severity: 'info',
    message:
      `Your cash limit of ${formatDollars(cashBudget)} is what stops the plan.` +
      couldSaveSentence(savingWithMoreCash, 'With more cash you'),
    params: { cashBudget, unrealisedSaving, savingWithMoreCash },
  };
}

/** Why the schemes stop the plan, in words that are true for this person. */
function leverLimitsReason(ctx: EngineContext): string {
  const leverRoom = ctx.leverRoom;
  if (leverRoom > 0) {
    return `The plan uses all ${formatDollars(leverRoom)} of room left in the schemes you switched on.`;
  }
  const switchedOn = LEVER_IDS.filter((lever) => ctx.levers[lever].enabled);
  if (switchedOn.length === 0) return 'No scheme is switched on, so nothing can be contributed.';
  if (switchedOn.every((lever) => !ctx.levers[lever].eligible)) {
    return 'None of the schemes you switched on is open to you, so nothing can be contributed.';
  }
  return 'The schemes you switched on have no room left this year, so nothing more can be contributed.';
}

function leverLimitsPlan(ctx: EngineContext, optimisation: Optimisation): PlannerWarning | null {
  const { bindingConstraint, unrealisedSaving } = optimisation.plan;
  if (bindingConstraint !== 'leverLimits') return null;
  const leverRoom = ctx.leverRoom;
  const { cashBudget } = ctx.input.preferences;
  // The only room a person can add is in schemes that are open to them but switched off (§6.5 roomIfEnabled,
  // which is 0 for a scheme they are not eligible for and respects their own limits). With those switched on
  // the plan runs on until the minimum rate, the relief cap, the cash limit or the schemes stop it.
  const savingIfSwitchedOn = savingWithinReach(
    ctx,
    optimisation,
    Math.min(
      optimisation.usefulRoom,
      ctx.reliefCapRoom,
      cashBudget === null ? Infinity : cashBudget,
      totalOf(ctx.roomIfEnabled),
    ),
  );
  return {
    code: 'LEVER_LIMITS_PLAN',
    severity: 'info',
    message:
      leverLimitsReason(ctx) + couldSaveSentence(savingIfSwitchedOn, 'Switching on the schemes you left off'),
    params: { leverRoom, unrealisedSaving, savingIfSwitchedOn },
  };
}

function existingExceedsCap(ctx: EngineContext): PlannerWarning | null {
  const { existing } = ctx.input;
  const existingByLever: Record<LeverId, number> = {
    srs: existing.srs,
    cpfSelf: existing.cpfTopUpSelf,
    cpfFamily: existing.cpfTopUpFamily,
  };
  const over = LEVER_IDS.filter((lever) => {
    const cap = ctx.levers[lever].statutoryCap;
    return cap > 0 && existingByLever[lever] > cap;
  });
  if (over.length === 0) return null;

  const params: Record<string, number | string> = { levers: over.join(',') };
  const sentences = over.map((lever) => {
    const cap = ctx.levers[lever].statutoryCap;
    const excess = existingByLever[lever] - cap;
    params[`${lever}Existing`] = existingByLever[lever];
    params[`${lever}Cap`] = cap;
    params[`${lever}Excess`] = excess;
    return (
      `You have already put ${formatDollars(existingByLever[lever])} into ${LEVER_DESTINATIONS[lever]} this ` +
      `year, but only ${formatDollars(cap)} a year earns tax relief; the extra ${formatDollars(excess)} earns none.`
    );
  });
  return { code: 'EXISTING_EXCEEDS_CAP', severity: 'caution', message: sentences.join(' '), params };
}

function cpfOverrideAboveMax(ctx: EngineContext): PlannerWarning | null {
  const override = ctx.input.income.employeeCpfOverride;
  if (ctx.cpf.source !== 'override' || override === null) return null;
  const maxCompulsory = maxCompulsoryEmployeeCpf(ctx.rules);
  if (override <= maxCompulsory) return null;
  return {
    code: 'CPF_OVERRIDE_ABOVE_MAX',
    severity: 'caution',
    message:
      `The employee CPF you entered (${formatDollars(override)}) is more than the largest compulsory ` +
      `contribution possible in a year (${formatDollars(maxCompulsory)}), so ${formatDollars(maxCompulsory)} ` +
      'is used. Voluntary contributions do not earn CPF relief.',
    params: { override, maxCompulsory },
  };
}

function foreignerNoCpf(ctx: EngineContext): PlannerWarning | null {
  if (ctx.input.profile.residency !== 'foreigner') return null;
  // SRS is open only from age 18 (§6.5); below that the cap is 0 and SRS_UNDER_18 says why, so this message
  // must not invite the person to use SRS.
  const { eligible, statutoryCap: srsCap } = ctx.levers.srs;
  return {
    code: 'FOREIGNER_NO_CPF',
    severity: 'info',
    message:
      'Foreigners on work passes do not contribute to CPF, so there is no CPF relief and CPF top-ups do not ' +
      'earn tax relief.' +
      (eligible ? ` You can put up to ${formatDollars(srsCap)} a year into SRS.` : ''),
    params: { srsCap },
  };
}

function prGraduatedRates(ctx: EngineContext): PlannerWarning | null {
  const { residency, prYear } = ctx.input.profile;
  if (residency !== 'pr' || prYear === 3) return null;
  return {
    code: 'PR_GRADUATED_RATES',
    severity: 'info',
    message:
      `As a permanent resident in your ${prYear === 1 ? '1st' : '2nd'} year you pay reduced (graduated) CPF rates, so ` +
      'your CPF relief is smaller than at full rates. If you have opted to pay full rates, choose ' +
      '"3rd year onwards".',
    params: { prYear },
  };
}

function age55PlusTopUp(ctx: EngineContext): PlannerWarning | null {
  const { ageAtYearEnd } = ctx.input.profile;
  const { eligible, enabled } = ctx.levers.cpfSelf;
  if (ageAtYearEnd < RETIREMENT_ACCOUNT_AGE || !enabled || !eligible) return null;
  const { fullRetirementSum } = ctx.rules.cpfTopUp;
  return {
    code: 'AGE_55_PLUS_TOPUP',
    severity: 'info',
    message:
      'From age 55, cash top-ups go to your Retirement Account and earn tax relief only up to the Full ' +
      `Retirement Sum (${formatDollars(fullRetirementSum)} in ${ctx.rules.incomeYear}). Check your balance and ` +
      'enter the room you have left.',
    params: { ageAtYearEnd, fullRetirementSum },
  };
}

function srsUnder18(ctx: EngineContext): PlannerWarning | null {
  const { ageAtYearEnd } = ctx.input.profile;
  const { minAge } = ctx.rules.srs;
  if (ageAtYearEnd >= minAge) return null;
  return {
    code: 'SRS_UNDER_18',
    severity: 'caution',
    message: `You must be at least ${minAge} to contribute to SRS, so SRS is left out of the plan.`,
    params: { ageAtYearEnd, minAge },
  };
}

function deadlinePassed(ctx: EngineContext, monthlyPlan: MonthlyPlan): PlannerWarning | null {
  const { deadline, daysToDeadline } = monthlyPlan;
  if (daysToDeadline >= 0) return null;
  return {
    code: 'DEADLINE_PASSED',
    severity: 'blocker',
    message:
      `The deadline for contributions that count for YA${ctx.rules.ya} was ${longDate(deadline)}, ` +
      `${days(-daysToDeadline)} ago. Money you put in now counts for the following year instead.`,
    params: { deadline, daysToDeadline, daysSinceDeadline: -daysToDeadline },
  };
}

function deadlineSoon(optimisation: Optimisation, monthlyPlan: MonthlyPlan): PlannerWarning | null {
  const { deadline, daysToDeadline } = monthlyPlan;
  if (daysToDeadline < 0 || daysToDeadline > DEADLINE_SOON_DAYS || optimisation.plan.totalContribution <= 0) {
    return null;
  }
  return {
    code: 'DEADLINE_SOON',
    severity: 'caution',
    message:
      (daysToDeadline === 0
        ? `Today, ${longDate(deadline)}, is the deadline.`
        : `Only ${days(daysToDeadline)} left until the ${longDate(deadline)} deadline.`) +
      ' Banks and the CPF Board can stop taking contributions earlier, so transfer as soon as you can.',
    params: { deadline, daysToDeadline },
  };
}

function projectedRules(ctx: EngineContext): PlannerWarning | null {
  const { status, incomeYear, ya } = ctx.rules;
  if (status !== 'projected') return null;
  return {
    code: 'PROJECTED_RULES',
    severity: 'caution',
    message:
      `The rules for income year ${incomeYear} (YA${ya}) are projected from what has been announced so far ` +
      'and may change, for example at the Budget. Treat these figures as provisional.',
    params: { incomeYear, ya },
  };
}

function pitRebateApplied(ctx: EngineContext): PlannerWarning | null {
  const { pitRebate } = ctx.baseline;
  const rebateRule = ctx.rules.pitRebate;
  if (pitRebate <= 0 || rebateRule === null) return null;
  return {
    code: 'PIT_REBATE_APPLIED',
    severity: 'info',
    message:
      `A Personal Income Tax Rebate of ${formatPercent(rebateRule.rate)} of tax (at most ` +
      `${formatDollars(rebateRule.cap)}) applies for YA${ctx.rules.ya} and takes ${formatTax(pitRebate)} off ` +
      'your bill. Because the rebate shrinks as your tax falls, the tax actually saved can be less than the ' +
      'bracket rate suggests.',
    params: { pitRebate, rebateRate: rebateRule.rate, rebateCap: rebateRule.cap },
  };
}

/** SPEC §6.11: every warning whose condition holds, in the order of the SPEC's table. */
export function buildWarnings(
  ctx: EngineContext,
  optimisation: Optimisation,
  monthlyPlan: MonthlyPlan,
): PlannerWarning[] {
  const candidates = [
    noTaxPayable(ctx),
    reliefCapExceededBaseline(ctx),
    reliefCapLimitsPlan(ctx, optimisation),
    belowMinSavingRate(ctx, optimisation),
    budgetLimitsPlan(ctx, optimisation),
    leverLimitsPlan(ctx, optimisation),
    existingExceedsCap(ctx),
    cpfOverrideAboveMax(ctx),
    foreignerNoCpf(ctx),
    prGraduatedRates(ctx),
    age55PlusTopUp(ctx),
    srsUnder18(ctx),
    deadlinePassed(ctx, monthlyPlan),
    deadlineSoon(optimisation, monthlyPlan),
    projectedRules(ctx),
    pitRebateApplied(ctx),
  ];
  return candidates.filter((warning): warning is PlannerWarning => warning !== null);
}
