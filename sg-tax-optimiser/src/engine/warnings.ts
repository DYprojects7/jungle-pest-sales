/**
 * Warnings (SPEC §6.11). Each one carries a ready-to-display message and the machine-readable values behind it.
 * At most one warning is emitted per code, in the order of the SPEC's table.
 */
import { maxCompulsoryEmployeeCpf } from './cpf';
import { formatLongDate, parseIsoDate } from './dates';
import type { EngineContext } from './evaluate';
import { formatDollars, formatPercent, formatTax } from './format';
import { LEVER_IDS } from './levers';
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

/** " <lead-in> you could save up to S$X more tax." when there is tax left to save, otherwise nothing. */
function unrealisedSentence(unrealisedSaving: number, leadIn: string): string {
  return unrealisedSaving > 0 ? ` ${leadIn} you could save up to ${formatTax(unrealisedSaving)} more tax.` : '';
}

function budgetLimitsPlan(ctx: EngineContext, optimisation: Optimisation): PlannerWarning | null {
  const { bindingConstraint, unrealisedSaving } = optimisation.plan;
  const { cashBudget } = ctx.input.preferences;
  if (bindingConstraint !== 'cashBudget' || cashBudget === null) return null;
  return {
    code: 'BUDGET_LIMITS_PLAN',
    severity: 'info',
    message:
      `Your cash limit of ${formatDollars(cashBudget)} is what stops the plan.` +
      unrealisedSentence(unrealisedSaving, 'With more cash'),
    params: { cashBudget, unrealisedSaving },
  };
}

function leverLimitsPlan(ctx: EngineContext, optimisation: Optimisation): PlannerWarning | null {
  const { bindingConstraint, unrealisedSaving } = optimisation.plan;
  if (bindingConstraint !== 'leverLimits') return null;
  const leverRoom = ctx.leverRoom;
  return {
    code: 'LEVER_LIMITS_PLAN',
    severity: 'info',
    message:
      (leverRoom > 0
        ? `The plan uses all ${formatDollars(leverRoom)} of room left in the schemes you switched on.`
        : 'The schemes you switched on have no room left this year, so nothing more can be contributed.') +
      unrealisedSentence(unrealisedSaving, 'With more room'),
    params: { leverRoom, unrealisedSaving },
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
  const srsCap = ctx.rules.srs.capForeigner;
  return {
    code: 'FOREIGNER_NO_CPF',
    severity: 'info',
    message:
      'Foreigners on work passes do not contribute to CPF, so there is no CPF relief and CPF top-ups do not ' +
      `earn tax relief. You can put up to ${formatDollars(srsCap)} a year into SRS.`,
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
