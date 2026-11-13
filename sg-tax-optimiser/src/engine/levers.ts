/**
 * The three levers: eligibility, statutory relief caps and remaining room (SPEC §6.5).
 */
import type { SanitisedInput } from './sanitise';
import type { LeverAmounts, LeverId, LeverRoom, YearRules } from './types';

/** The levers in canonical order (SPEC §6.0). */
export const LEVER_IDS: readonly LeverId[] = ['srs', 'cpfSelf', 'cpfFamily'];

/**
 * Age on 31 December of the income year from which a member has a Retirement Account (SPEC §6.5). From this age
 * the CPF Board accepts cash top-ups above the Full Retirement Sum, which earn no relief and cannot be reversed.
 */
export const RETIREMENT_ACCOUNT_AGE = 55;

/**
 * SPEC §6.5 "Room must be confirmed from age 55": true when the person is 55 or over at the end of the year and
 * has not entered how much they can still top up with relief. A blank `roomToLimit` then means "not confirmed",
 * not "unlimited", so the lever's room is 0 until a figure is entered.
 */
export function cpfSelfRoomUnconfirmed(input: SanitisedInput): boolean {
  return input.profile.ageAtYearEnd >= RETIREMENT_ACCOUNT_AGE && input.levers.cpfSelf.roomToLimit === null;
}

export interface LeverPositions {
  /** Cap, usage and room per lever, as reported in `PlannerResult.levers`. */
  levers: Record<LeverId, LeverRoom>;
  /** §6.5 `roomIfEnabled`: the room each lever would have if switched on (0 when not eligible). */
  roomIfEnabled: LeverAmounts;
}

/** A fresh all-zero `LeverAmounts`. */
export function noContributions(): LeverAmounts {
  return { srs: 0, cpfSelf: 0, cpfFamily: 0 };
}

/** Sum of the three amounts. */
export function totalOf(amounts: LeverAmounts): number {
  return amounts.srs + amounts.cpfSelf + amounts.cpfFamily;
}

/**
 * Split `amount` across the levers in priority order, giving each `min(room, remaining)` (SPEC §6.6).
 * Any part of `amount` beyond the total room is left unallocated.
 */
export function allocate(amount: number, rooms: LeverAmounts, priority: readonly LeverId[]): LeverAmounts {
  const split = noContributions();
  let remaining = amount;
  for (const lever of priority) {
    const share = Math.min(rooms[lever], remaining);
    split[lever] = share;
    remaining -= share;
  }
  return split;
}

/**
 * §6.5 for one lever.
 * @param statutoryCapIfEligible the scheme's relief cap for this profile
 * @param existing contribution already made this year
 * @param userLimit the user's own limit on further contributions (null = none)
 */
function position(
  eligible: boolean,
  enabled: boolean,
  statutoryCapIfEligible: number,
  existing: number,
  userLimit: number | null,
): { lever: LeverRoom; roomIfEnabled: number } {
  const statutoryCap = eligible ? statutoryCapIfEligible : 0;
  const used = Math.min(existing, statutoryCap);
  const statutoryRoom = Math.max(0, statutoryCap - used);
  const roomIfEnabled = userLimit === null ? statutoryRoom : Math.min(statutoryRoom, userLimit);
  return {
    lever: { statutoryCap, used, room: eligible && enabled ? roomIfEnabled : 0, eligible, enabled },
    roomIfEnabled,
  };
}

/**
 * SPEC §6.5. Eligibility:
 * - `srs`: aged at least `rules.srs.minAge` (18) at the end of the year; the cap depends on residency.
 * - `cpfSelf`: Citizens and PRs (people with a CPF account).
 * - `cpfFamily`: residency statuses in `rules.cpfTopUp.familyGiverResidency` (Citizens and PRs, §5.4).
 *
 * Room: the statutory cap less what is already used, then the person's own limit. For `cpfSelf` from age 55 a
 * room that was not entered is a room of 0 (see `cpfSelfRoomUnconfirmed`).
 */
export function leverPositions(input: SanitisedInput, rules: YearRules): LeverPositions {
  const { profile, existing, levers } = input;
  const isForeigner = profile.residency === 'foreigner';

  const srs = position(
    profile.ageAtYearEnd >= rules.srs.minAge,
    levers.srs.enabled,
    isForeigner ? rules.srs.capForeigner : rules.srs.capCitizenPr,
    existing.srs,
    null,
  );
  const cpfSelf = position(
    !isForeigner,
    levers.cpfSelf.enabled,
    rules.cpfTopUp.selfReliefCap,
    existing.cpfTopUpSelf,
    cpfSelfRoomUnconfirmed(input) ? 0 : levers.cpfSelf.roomToLimit,
  );
  const cpfFamily = position(
    rules.cpfTopUp.familyGiverResidency.includes(profile.residency),
    levers.cpfFamily.enabled,
    rules.cpfTopUp.familyReliefCap,
    existing.cpfTopUpFamily,
    levers.cpfFamily.maxAmount,
  );

  return {
    levers: { srs: srs.lever, cpfSelf: cpfSelf.lever, cpfFamily: cpfFamily.lever },
    roomIfEnabled: {
      srs: srs.roomIfEnabled,
      cpfSelf: cpfSelf.roomIfEnabled,
      cpfFamily: cpfFamily.roomIfEnabled,
    },
  };
}
