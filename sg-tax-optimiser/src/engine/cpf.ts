/**
 * Compulsory employee CPF contribution for the year (SPEC §6.1). This is the CPF relief.
 */
import { floorRateTimesDollars, rateInMillionths, roundMillionthsToDollars } from './money';
import type { SanitisedInput } from './sanitise';
import type { CpfAgeBand, CpfComputation, CpfRules, YearRules } from './types';

const MONTHS_IN_YEAR = 12;

/** §6.1 "Rate table": full rates for Citizens and PRs from their 3rd year, graduated rates for 1st/2nd-year PRs. */
function rateTable(profile: SanitisedInput['profile'], cpf: CpfRules): readonly CpfAgeBand[] {
  if (profile.residency === 'pr' && profile.prYear === 1) return cpf.prYear1Rates;
  if (profile.residency === 'pr' && profile.prYear === 2) return cpf.prYear2Rates;
  return cpf.fullRates;
}

/**
 * §6.1 "Age band per month". The age completed by calendar month `month` is one less than the age at year end
 * up to and including the birthday month, so a new band starts the month AFTER the 55th/60th/65th/70th birthday.
 */
function bandForMonth(
  table: readonly CpfAgeBand[],
  month: number,
  ageAtYearEnd: number,
  birthMonth: number,
): CpfAgeBand {
  const completedAge = month <= birthMonth ? ageAtYearEnd - 1 : ageAtYearEnd;
  const band = table.find((b) => b.maxAge === null || completedAge < b.maxAge) ?? table[table.length - 1];
  if (!band) throw new RangeError('CPF rate table has no age bands.');
  return band;
}

/** §6.1 "Ordinary wages": the employee share for one month's ordinary wage `ow`. */
function employeeShareOnOrdinaryWage(ow: number, owSubject: number, band: CpfAgeBand, cpf: CpfRules): number {
  if (ow <= cpf.employeeNilUpTo) return 0;
  if (ow <= cpf.phaseInUpTo) return floorRateTimesDollars(band.phaseInFactor, ow - cpf.employeeNilUpTo);
  return floorRateTimesDollars(band.employeeRate, owSubject);
}

/**
 * §6.1 "Override": the largest compulsory employee contribution anyone can make in the year,
 * `floor(fullRates[0].employeeRate × annualWageCeiling)` (S$20,400).
 */
export function maxCompulsoryEmployeeCpf(rules: YearRules): number {
  const youngestBand = rules.cpf.fullRates[0];
  if (!youngestBand) throw new RangeError('CPF rate table has no age bands.');
  return floorRateTimesDollars(youngestBand.employeeRate, rules.cpf.annualWageCeiling);
}

/** SPEC §6.1 for an already-sanitised input. */
export function computeCpfFor(input: SanitisedInput, rules: YearRules): CpfComputation {
  const { profile, income } = input;
  const cpf = rules.cpf;

  if (profile.residency === 'foreigner') {
    return {
      source: 'none',
      ordinaryWagesSubject: 0,
      additionalWageCeiling: 0,
      additionalWagesSubject: 0,
      employeeContribution: 0,
      employerContribution: 0,
      monthlyEmployeeRates: new Array<number>(MONTHS_IN_YEAR).fill(0),
    };
  }

  const table = rateTable(profile, cpf);
  const bandFor = (month: number): CpfAgeBand =>
    bandForMonth(table, month, profile.ageAtYearEnd, profile.birthMonth);

  // The employee works the LAST `monthsWorked` months of the year.
  const firstWorkedMonth = MONTHS_IN_YEAR + 1 - income.monthsWorked;
  const ow = income.monthlyOrdinaryWage;
  const owSubject = Math.min(ow, cpf.owCeilingMonthly);

  let ordinaryWagesSubject = 0;
  let employeeOnOrdinaryWages = 0;
  let employerMillionths = 0;
  const monthlyEmployeeRates: number[] = [];
  for (let month = 1; month <= MONTHS_IN_YEAR; month++) {
    if (month < firstWorkedMonth) {
      monthlyEmployeeRates.push(0);
      continue;
    }
    const band = bandFor(month);
    ordinaryWagesSubject += owSubject;
    employeeOnOrdinaryWages += employeeShareOnOrdinaryWage(ow, owSubject, band, cpf);
    employerMillionths += rateInMillionths(band.employerRate) * owSubject;
    monthlyEmployeeRates.push(band.employeeRate);
  }

  // Additional wages are treated as paid in December and attract the full employee rate.
  const decemberBand = bandFor(MONTHS_IN_YEAR);
  const additionalWageCeiling = Math.max(0, cpf.annualWageCeiling - ordinaryWagesSubject);
  const additionalWagesSubject = Math.min(income.additionalWages, additionalWageCeiling);
  const employeeOnAdditionalWages = floorRateTimesDollars(decemberBand.employeeRate, additionalWagesSubject);
  employerMillionths += rateInMillionths(decemberBand.employerRate) * additionalWagesSubject;

  const wageBreakdown = { ordinaryWagesSubject, additionalWageCeiling, additionalWagesSubject, monthlyEmployeeRates };

  if (income.employeeCpfOverride !== null) {
    return {
      source: 'override',
      ...wageBreakdown,
      employeeContribution: Math.min(income.employeeCpfOverride, maxCompulsoryEmployeeCpf(rules)),
      employerContribution: 0,
    };
  }
  return {
    source: 'auto',
    ...wageBreakdown,
    employeeContribution: employeeOnOrdinaryWages + employeeOnAdditionalWages,
    employerContribution: roundMillionthsToDollars(employerMillionths),
  };
}
