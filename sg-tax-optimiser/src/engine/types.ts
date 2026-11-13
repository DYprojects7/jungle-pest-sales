/**
 * Singapore Tax Optimiser — engine contract.
 *
 * This file is the single source of truth for the data shapes shared by the
 * engine, the web UI, the workbook generator and the tests. See SPEC.md §6–§7.
 *
 * Conventions
 * - All money amounts are Singapore dollars. Inputs are non-negative WHOLE dollars
 *   (the engine sanitises: non-finite or negative -> 0, fractional -> Math.floor).
 * - Tax amounts are dollars rounded to cents (2 dp, half-up).
 * - Rates are fractions (0.115 = 11.5%).
 * - "Income year" = the calendar year in which income is earned and contributions
 *   are made. Year of Assessment (YA) = incomeYear + 1.
 * - The engine is pure and deterministic: "today" is an input, never read from the clock.
 */

// ---------------------------------------------------------------------------
// Rules (one object per income year, see src/engine/rules/)
// ---------------------------------------------------------------------------

export type Residency = 'citizen' | 'pr' | 'foreigner';

/** Years since obtaining SPR status: 1 = first year, 2 = second year, 3 = third year onwards (full rates). */
export type PrYear = 1 | 2 | 3;

export type LeverId = 'srs' | 'cpfSelf' | 'cpfFamily';

export interface TaxBracket {
  /** Chargeable income at which this bracket starts (inclusive lower bound). First bracket starts at 0. */
  from: number;
  /** Marginal rate for chargeable income above `from` (until the next bracket's `from`). */
  rate: number;
}

/**
 * CPF age band. A member is in band i when their CPF age is > bands[i-1].maxAge and <= bands[i].maxAge.
 * The band that applies in a given month is determined per SPEC §6.1 (the rate changes from the first day
 * of the month AFTER the month of the 55th/60th/65th/70th birthday).
 */
export interface CpfAgeBand {
  /** Upper age bound of the band (inclusive), e.g. 55 for "55 and below". null = no upper bound. */
  maxAge: number | null;
  /** Employee share of contribution for total monthly wages above the phase-in upper bound (>= $750). */
  employeeRate: number;
  /** Employer share (informational; not used for tax). */
  employerRate: number;
  /**
   * Employee share for monthly wages in the phase-in range ($500 < TW <= $750):
   * employee contribution = phaseInFactor * (TW - 500). For TW <= $500 the employee share is 0.
   */
  phaseInFactor: number;
}

export interface CpfRules {
  /** Ordinary Wage ceiling per month. */
  owCeilingMonthly: number;
  /** Annual wage ceiling (OW + AW subject to CPF per year). AW ceiling = this - total OW subject to CPF in the year. */
  annualWageCeiling: number;
  /** Rates for Singapore Citizens and SPRs from the 3rd year. Ordered by ascending maxAge. */
  fullRates: CpfAgeBand[];
  /** Graduated (G/G) rates for 1st-year SPRs. Ordered by ascending maxAge. */
  prYear1Rates: CpfAgeBand[];
  /** Graduated (G/G) rates for 2nd-year SPRs. Ordered by ascending maxAge. */
  prYear2Rates: CpfAgeBand[];
  /** Monthly total wage at or below which the employee share is nil. */
  employeeNilUpTo: number; // 500
  /** Monthly total wage above which the full employee rate applies. */
  phaseInUpTo: number; // 750
}

export interface YearRules {
  incomeYear: number;
  /** Year of Assessment = incomeYear + 1. */
  ya: number;
  /**
   * 'final'     = all values confirmed from official sources.
   * 'projected' = some values are carried forward / announced but not yet in force; UI must flag this.
   */
  status: 'final' | 'projected';
  /** Human-readable notes about what is projected or uncertain (shown in the UI's assumptions panel). */
  statusNotes: string[];

  taxBrackets: TaxBracket[];
  /** Personal income tax rebate for this YA (percentage of tax payable, capped), or null if none. */
  pitRebate: { rate: number; cap: number } | null;
  /** Overall cap on total personal reliefs per YA. */
  personalReliefCap: number;
  earnedIncomeRelief: { below55: number; age55to59: number; age60plus: number };
  /** Multiplier applied to qualifying donations (2.5 = 250% deduction). */
  donationDeductionMultiplier: number;

  cpf: CpfRules;

  srs: {
    capCitizenPr: number;
    capForeigner: number;
    /** Minimum age to contribute. */
    minAge: number;
    /**
     * Statutory retirement age that a FIRST SRS contribution made at the end of this income year locks in
     * as the penalty-free withdrawal age (informational; shown in the UI).
     */
    statutoryRetirementAge: number;
  };

  cpfTopUp: {
    /** Max relief for cash top-ups to own SA/RA + own MediSave (combined). */
    selfReliefCap: number;
    /** Max relief for cash top-ups to eligible family members' SA/RA + MediSave (combined). */
    familyReliefCap: number;
    /** Full Retirement Sum for the year (top-up limit for SA / relief limit for RA). */
    fullRetirementSum: number;
    /** Enhanced Retirement Sum for the year. */
    enhancedRetirementSum: number;
    /** Basic Healthcare Sum for the year (MediSave limit). */
    basicHealthcareSum: number;
    /** Residency statuses that can claim CPF Cash Top-up Relief for top-ups to family members. */
    familyGiverResidency: Residency[];
    /** Interest rate floor on SA/MA/RA for the year (informational; shown in the UI). */
    interestRateSmra: number;
    /**
     * The part of a cash top-up that the Government matches earns the giver NO relief (SPEC §5.4). The matched
     * part per recipient per year: retirement top-ups under the Matched Retirement Savings Scheme, and MediSave
     * top-ups under the Matched MediSave Scheme (`null` in a year the scheme does not apply). Display only: every
     * top-up amount in the engine already means the part that is not matched (SPEC §6.3).
     */
    matchedTopUps: { retirementAnnualCap: number; mediSaveAnnualCap: number | null };
    /** Age from which a top-up to the Special / Retirement Account comes back, as monthly payouts (display only). */
    payoutEligibilityAge: number;
  };

  /** Last day contributions count for this income year, ISO date (YYYY-MM-DD). */
  contributionDeadline: string;

  /** Common personal reliefs offered in the UI "relief helper" (amount per unit; display only). */
  reliefCatalog: ReliefCatalogItem[];

  /** Source citations for the rule values (shown in the UI / workbook "Sources" section). */
  sources: { label: string; url: string }[];
}

export interface ReliefCatalogItem {
  id: string;
  /** Grouping for display. 'disability' items are shown in a collapsed group. */
  group: 'family' | 'ns' | 'disability' | 'other';
  label: string;
  /** Relief amount per unit (e.g. per child, per parent). 0 when the user must type the amount. */
  amountPerUnit: number;
  /**
   * 'count'  = user enters how many (amount = count * amountPerUnit);
   * 'amount' = user types a dollar amount;
   * 'toggle' = on/off (amount = amountPerUnit when on);
   * 'select' = user picks one of `options`.
   */
  input: 'count' | 'amount' | 'toggle' | 'select';
  /** Maximum count or amount, if any. */
  max?: number;
  /** Choices for input === 'select'. The first option should be the "none" choice with amount 0. */
  options?: { label: string; amount: number }[];
  help: string;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PlannerInput {
  /** Calendar year of income/contributions (YA = incomeYear + 1). Must have rules. */
  incomeYear: number;
  /** ISO date (YYYY-MM-DD) treated as "today" for the monthly plan and deadline warnings. */
  today: string;

  profile: {
    /** Tax-resident status. The engine only supports Singapore TAX RESIDENTS. */
    residency: Residency;
    /** Only used when residency === 'pr'. Default 3. */
    prYear?: PrYear;
    /** Age attained in the income year, i.e. age on 31 December of the income year (incomeYear - birthYear). */
    ageAtYearEnd: number;
    /** Birth month 1–12. Only matters when a CPF age band boundary is crossed during the year. Default 12. */
    birthMonth?: number;
    /**
     * The person has Parenthood Tax Rebate left over from earlier years. It does not change any figure (the balance
     * is out of scope, SPEC §1); it raises the PARENTHOOD_TAX_REBATE caution. True only for the boolean `true`.
     */
    hasUnusedParenthoodTaxRebate?: boolean;
  };

  income: {
    /** Gross monthly ordinary wage (basic salary + fixed monthly allowances). */
    monthlyOrdinaryWage: number;
    /** Number of months worked in the income year, 1–12 (months are assumed to be the LAST n months of the year). Default 12. */
    monthsWorked?: number;
    /** Total additional wages paid in the income year (bonus, AWS/13th month, commissions, incentives). */
    additionalWages: number;
    /** Other taxable income that does not attract CPF (e.g. net rental income, taxable benefits). */
    otherTaxableIncome?: number;
    /** Allowable employment expenses. */
    employmentExpenses?: number;
    /** Qualifying cash donations made in the year (the engine applies the deduction multiplier). */
    donations?: number;
    /**
     * If set, use this as the year's compulsory employee CPF contribution (from payslips / CPF statement)
     * instead of the auto-calculated figure.
     */
    employeeCpfOverride?: number | null;
  };

  /** Contributions already made in this income year (they already count towards reliefs and caps). */
  existing: {
    srs: number;
    cpfTopUpSelf: number;
    cpfTopUpFamily: number;
  };

  /** Total of all OTHER personal reliefs (spouse, child, parent, NSman, life insurance, ...). Excludes EIR, CPF, SRS, top-ups. */
  otherReliefs: number;

  levers: {
    srs: { enabled: boolean };
    cpfSelf: {
      enabled: boolean;
      /**
       * Remaining amount the member may still top up to own SA/RA + MediSave before hitting the FRS / BHS limits.
       * null/undefined = not provided; assume the limits do not bind.
       */
      roomToLimit?: number | null;
    };
    cpfFamily: {
      enabled: boolean;
      /** Max the user is willing/able to top up for eligible family members this year. null/undefined = up to the relief cap. */
      maxAmount?: number | null;
    };
  };

  preferences: {
    /** Max additional cash the user is willing to lock away this year. null/undefined = no limit. */
    cashBudget?: number | null;
    /** Only contribute dollars that save at least this fraction in tax (0 = any positive saving). */
    minSavingRate: number;
    /** Order in which levers are filled. Must be a permutation of the three LeverIds. */
    priority: LeverId[];
    /** Step size for the simulator table in dollars. Default 1000; minimum 100. */
    simulatorStep?: number;
  };
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** Dollar amounts per lever. */
export type LeverAmounts = Record<LeverId, number>;

export interface CpfComputation {
  /** 'auto' when calculated from wages; 'override' when the user supplied the figure; 'none' for foreigners. */
  source: 'auto' | 'override' | 'none';
  /** Total ordinary wages in the year that attract CPF (after the monthly OW ceiling). */
  ordinaryWagesSubject: number;
  /** Additional wage ceiling for the year (annualWageCeiling - ordinaryWagesSubject, floored at 0). */
  additionalWageCeiling: number;
  /** Additional wages that attract CPF (min of AW and the AW ceiling). */
  additionalWagesSubject: number;
  /** Compulsory employee contribution for the year (this is the CPF relief). */
  employeeContribution: number;
  /** Employer contribution for the year (informational, approximate; 0 when source is 'override' or 'none'). */
  employerContribution: number;
  /** Employee rate applied in each calendar month (index 0 = January); 0 for months not worked. */
  monthlyEmployeeRates: number[];
}

export interface ReliefBreakdown {
  earnedIncome: number;
  cpf: number;
  srs: number;
  cpfTopUpSelf: number;
  cpfTopUpFamily: number;
  other: number;
  /** Sum of the six items above. */
  totalBeforeCap: number;
  /** min(totalBeforeCap, personalReliefCap). */
  totalAllowed: number;
  /** max(0, totalBeforeCap - personalReliefCap): reliefs lost to the cap. */
  lostToCap: number;
}

export interface TaxComputation {
  employmentIncome: number;
  employmentExpenses: number;
  otherTaxableIncome: number;
  /** employmentIncome - employmentExpenses (floored at 0) + otherTaxableIncome. */
  totalIncome: number;
  /** donations * multiplier. */
  donationDeduction: number;
  /** max(0, totalIncome - donationDeduction). */
  assessableIncome: number;
  reliefs: ReliefBreakdown;
  /** Math.floor(max(0, assessableIncome - reliefs.totalAllowed)). */
  chargeableIncome: number;
  /** Tax from the rate table, before rebates. */
  grossTax: number;
  /** Personal income tax rebate for the YA (0 when none). */
  pitRebate: number;
  /** grossTax - pitRebate (never below 0). */
  taxPayable: number;
  /** Marginal rate at this chargeable income: the rate of the bracket that the LAST dollar of chargeable income falls in (0 when chargeable income is 0). */
  marginalRate: number;
  /** taxPayable / totalIncome (0 when totalIncome is 0). */
  effectiveRate: number;
}

export type BindingConstraint =
  /** Every remaining dollar would save less than the user's minimum saving rate (or nothing). */
  | 'usefulRoom'
  /** The overall personal relief cap is reached. */
  | 'reliefCap'
  /** The user's cash budget is used up. */
  | 'cashBudget'
  /** All enabled schemes are at their limits. */
  | 'leverLimits'
  /** Nothing to do: no tax is payable. */
  | 'none';

export interface Plan {
  /** Additional contributions recommended (on top of `existing`). */
  contributions: LeverAmounts;
  totalContribution: number;
  taxBefore: number;
  taxAfter: number;
  taxSaved: number;
  /** taxSaved / totalContribution (0 when totalContribution is 0). */
  savingRate: number;
  chargeableIncomeBefore: number;
  chargeableIncomeAfter: number;
  marginalRateBefore: number;
  marginalRateAfter: number;
  /** What stopped the plan from contributing more. */
  bindingConstraint: BindingConstraint;
  /**
   * Further tax that could be saved at or above the user's minimum saving rate if schemes/budget had more room
   * (0 when bindingConstraint is 'usefulRoom' or 'none').
   */
  unrealisedSaving: number;
}

export interface LeverRoom {
  /** Statutory relief cap for the lever for this profile (0 when not eligible). */
  statutoryCap: number;
  /** Amount already used this year (existing contribution, capped at statutoryCap). */
  used: number;
  /** Remaining room after existing contributions, user limits and eligibility; 0 when disabled. */
  room: number;
  eligible: boolean;
  enabled: boolean;
}

/** One rung of the savings ladder: a slice of additional contribution that all saves tax at the same marginal rate. */
export interface LadderTier {
  /** Cumulative contribution at which the tier starts (inclusive). */
  fromContribution: number;
  /** Cumulative contribution at which the tier ends (exclusive upper bound). */
  toContribution: number;
  /** toContribution - fromContribution. */
  amount: number;
  /** Tax saved per dollar within this tier (statutory marginal rate; 0 when the dollars save nothing). */
  rate: number;
  /** Tax saved by contributing the whole tier. */
  taxSaved: number;
  /** Tax saved by contributing everything up to the end of this tier. */
  cumulativeTaxSaved: number;
  /** How many dollars of this tier the recommended plan uses. */
  usedByPlan: number;
  /** Why dollars in this tier save nothing, when rate is 0. */
  zeroReason?: 'belowTaxThreshold' | 'reliefCap';
}

export interface SimulatorRow {
  /** Cumulative additional contribution. */
  contribution: number;
  /** How the contribution would be split across levers in priority order. */
  split: LeverAmounts;
  taxPayable: number;
  /** Total tax saved versus contributing nothing more. */
  taxSaved: number;
  /** Tax saved by the last step (difference from the previous row; 0 for the first row). */
  stepSaving: number;
  /** stepSaving / (this row's contribution - the previous row's contribution); 0 for the first row. */
  stepRate: number;
  /** True when this row's contribution is within the recommended plan total. */
  withinPlan: boolean;
}

export type ScenarioId = 'none' | 'srsOnly' | 'cpfSelfOnly' | 'srsPlusCpfSelf' | 'maxAll' | 'recommended';

export interface Scenario {
  id: ScenarioId;
  contributions: LeverAmounts;
  totalContribution: number;
  taxPayable: number;
  taxSaved: number;
  /** taxSaved / totalContribution (0 when nothing contributed). */
  savingRate: number;
  /** Dollars contributed that reduce tax by nothing (beyond the relief cap or below the tax-free threshold). */
  wastedContribution: number;
}

export interface MonthlyPlanRow {
  /** 'YYYY-MM'. */
  month: string;
  amounts: LeverAmounts;
  total: number;
}

export interface MonthlyPlan {
  /** ISO date of the statutory deadline (31 Dec of the income year). */
  deadline: string;
  /** Whole days from `today` to the deadline (negative when passed). */
  daysToDeadline: number;
  /** Number of monthly instalments remaining, counting the current month (0 when the deadline has passed). */
  monthsRemaining: number;
  /** Instalment schedule from the current month to December (empty when the deadline has passed or nothing is recommended). */
  schedule: MonthlyPlanRow[];
  /** What the same plan would cost per month if spread over 12 months from January. */
  fullYearMonthly: LeverAmounts & { total: number };
}

export type WarningCode =
  | 'NO_TAX_PAYABLE'
  | 'RELIEF_CAP_EXCEEDED_BASELINE'
  | 'RELIEF_CAP_LIMITS_PLAN'
  | 'BELOW_MIN_SAVING_RATE'
  | 'BUDGET_LIMITS_PLAN'
  | 'LEVER_LIMITS_PLAN'
  | 'EXISTING_EXCEEDS_CAP'
  | 'CPF_OVERRIDE_ABOVE_MAX'
  | 'FOREIGNER_NO_CPF'
  | 'TAX_RESIDENCY_CHECK'
  | 'SRS_NON_RESIDENT_WITHDRAWAL'
  | 'PR_GRADUATED_RATES'
  | 'CPF_SELF_ROOM_UNCONFIRMED'
  | 'AGE_55_PLUS_TOPUP'
  | 'FAMILY_TOPUP_CHECKS'
  | 'PARENTHOOD_TAX_REBATE'
  | 'DEADLINE_PASSED'
  | 'DEADLINE_SOON'
  | 'PROJECTED_RULES'
  | 'SRS_UNDER_18'
  | 'PIT_REBATE_APPLIED';

export interface PlannerWarning {
  code: WarningCode;
  severity: 'info' | 'caution' | 'blocker';
  /** Plain-English message ready to show to the user. */
  message: string;
  /** Machine-readable values referenced by the message. */
  params?: Record<string, number | string>;
}

export interface PlannerResult {
  rules: YearRules;
  /** Input after sanitising/defaulting (what the engine actually used). */
  input: PlannerInput;
  cpf: CpfComputation;
  /** Tax position with existing contributions only. */
  baseline: TaxComputation;
  /** Tax position after the recommended plan. */
  optimised: TaxComputation;
  levers: Record<LeverId, LeverRoom>;
  /** Room left under the overall personal relief cap before any additional contribution. */
  reliefCapRoom: number;
  plan: Plan;
  ladder: LadderTier[];
  simulator: SimulatorRow[];
  scenarios: Scenario[];
  monthlyPlan: MonthlyPlan;
  warnings: PlannerWarning[];
}
