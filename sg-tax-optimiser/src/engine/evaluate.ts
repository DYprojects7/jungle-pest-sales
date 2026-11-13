/**
 * The full tax computation for a profile: income (SPEC §6.2), reliefs and the overall cap (§6.3), tax (§6.4).
 *
 * `EngineContext` holds everything that does not depend on the additional contributions (sanitised input, rules,
 * CPF, lever positions, the baseline computation), so the optimiser, ladder, simulator and scenarios can
 * re-evaluate the tax cheaply and always through the same code path.
 */
import { computeCpfFor } from './cpf';
import { leverPositions, noContributions, totalOf } from './levers';
import { floorDiv, fromCents, subtractMoney, toCents } from './money';
import type { SanitisedInput } from './sanitise';
import { marginalRate, taxDue } from './tax';
import type {
  CpfComputation,
  LeverAmounts,
  LeverId,
  LeverRoom,
  ReliefBreakdown,
  TaxComputation,
  YearRules,
} from './types';

export interface EngineContext {
  input: SanitisedInput;
  rules: YearRules;
  cpf: CpfComputation;
  levers: Record<LeverId, LeverRoom>;
  /** §6.5 `room` per lever: what the plan may still put into each one. */
  rooms: LeverAmounts;
  /** §6.5 `roomIfEnabled` per lever (used by the scenarios, §6.9). */
  roomIfEnabled: LeverAmounts;
  /** Tax position with existing contributions only. */
  baseline: TaxComputation;
  /** §6.6 C: room left under the overall personal relief cap before any additional contribution. */
  reliefCapRoom: number;
  /** §6.6 L: total room across the enabled, eligible levers. */
  leverRoom: number;
}

/** §6.3 Earned Income Relief amount by age on 31 December of the income year. */
function earnedIncomeReliefForAge(age: number, rules: YearRules): number {
  if (age < 55) return rules.earnedIncomeRelief.below55;
  if (age <= 59) return rules.earnedIncomeRelief.age55to59;
  return rules.earnedIncomeRelief.age60plus;
}

/**
 * SPEC §6.2–§6.4: the tax computation with `additional` contributions on top of the existing ones.
 * `additional` must already be whole dollars.
 */
function computeTax(
  input: SanitisedInput,
  rules: YearRules,
  cpf: CpfComputation,
  levers: Record<LeverId, LeverRoom>,
  additional: LeverAmounts,
): TaxComputation {
  const { income, existing, profile } = input;

  // §6.2 Income
  const employmentIncome = income.monthlyOrdinaryWage * income.monthsWorked + income.additionalWages;
  const netEmploymentIncome = Math.max(0, employmentIncome - income.employmentExpenses);
  const totalIncome = netEmploymentIncome + income.otherTaxableIncome;
  const donationDeduction = fromCents(toCents(income.donations * rules.donationDeductionMultiplier));
  const assessableIncome = Math.max(0, subtractMoney(totalIncome, donationDeduction));

  // §6.3 Reliefs and the overall cap
  const earnedIncome = Math.min(earnedIncomeReliefForAge(profile.ageAtYearEnd, rules), netEmploymentIncome);
  const srs = Math.min(existing.srs + additional.srs, levers.srs.statutoryCap);
  const cpfTopUpSelf = Math.min(existing.cpfTopUpSelf + additional.cpfSelf, levers.cpfSelf.statutoryCap);
  const cpfTopUpFamily = Math.min(existing.cpfTopUpFamily + additional.cpfFamily, levers.cpfFamily.statutoryCap);
  const totalBeforeCap =
    earnedIncome + cpf.employeeContribution + srs + cpfTopUpSelf + cpfTopUpFamily + input.otherReliefs;
  const totalAllowed = Math.min(totalBeforeCap, rules.personalReliefCap);
  const reliefs: ReliefBreakdown = {
    earnedIncome,
    cpf: cpf.employeeContribution,
    srs,
    cpfTopUpSelf,
    cpfTopUpFamily,
    other: input.otherReliefs,
    totalBeforeCap,
    totalAllowed,
    lostToCap: totalBeforeCap - totalAllowed,
  };
  const chargeableIncome = floorDiv(Math.max(0, toCents(assessableIncome) - totalAllowed * 100), 100);

  // §6.4 Tax
  const tax = taxDue(chargeableIncome, rules);
  return {
    employmentIncome,
    employmentExpenses: income.employmentExpenses,
    otherTaxableIncome: income.otherTaxableIncome,
    totalIncome,
    donationDeduction,
    assessableIncome,
    reliefs,
    chargeableIncome,
    grossTax: tax.grossTax,
    pitRebate: tax.pitRebate,
    taxPayable: tax.taxPayable,
    marginalRate: marginalRate(chargeableIncome, rules),
    effectiveRate: totalIncome === 0 ? 0 : tax.taxPayable / totalIncome,
  };
}

/** Everything about a sanitised input that does not depend on the additional contributions. */
export function buildContext(input: SanitisedInput, rules: YearRules): EngineContext {
  const cpf = computeCpfFor(input, rules);
  const { levers, roomIfEnabled } = leverPositions(input, rules);
  const rooms: LeverAmounts = {
    srs: levers.srs.room,
    cpfSelf: levers.cpfSelf.room,
    cpfFamily: levers.cpfFamily.room,
  };
  const baseline = computeTax(input, rules, cpf, levers, noContributions());
  return {
    input,
    rules,
    cpf,
    levers,
    rooms,
    roomIfEnabled,
    baseline,
    reliefCapRoom: Math.max(0, rules.personalReliefCap - baseline.reliefs.totalBeforeCap),
    leverRoom: totalOf(rooms),
  };
}

/** `evaluate` for a prepared context (SPEC §6.4). */
export function taxWith(ctx: EngineContext, additional: LeverAmounts): TaxComputation {
  return computeTax(ctx.input, ctx.rules, ctx.cpf, ctx.levers, additional);
}

/**
 * SPEC §6.6 `N(x)` extended to the whole ladder (§6.7): tax payable once `contribution` further dollars have
 * gone into levers with room. Each such dollar is one dollar of relief until the overall relief cap is reached
 * (after `reliefCapRoom` dollars); beyond that chargeable income no longer falls.
 */
export function taxPayableAfter(ctx: EngineContext, contribution: number): number {
  const additionalRelief = Math.min(contribution, ctx.reliefCapRoom);
  return taxDue(Math.max(0, ctx.baseline.chargeableIncome - additionalRelief), ctx.rules).taxPayable;
}
