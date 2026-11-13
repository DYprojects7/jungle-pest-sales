#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Singapore Tax Optimiser - independent Python reference implementation.

Written ONLY from SPEC.md (sections 5 and 6, Appendices A and B) and the field
names in src/engine/types.ts.  It deliberately shares no code and no data with
the TypeScript engine: every rule value below was transcribed by hand from
SPEC section 5, so that a differential test between the two implementations
checks the rule data as well as the logic.

Arithmetic
----------
* Dollar amounts are Python ints (arbitrary precision).
* Rates are held as integer "per mille" values (0.115 -> 115), so every
  ``floor(rate * amount)`` is exact integer arithmetic.
* Tax is summed in integer mills (dollars x per-mille rate) and rounded to
  cents half-up exactly once (SPEC 6.0).  Internally tax is an int of cents.
* The donation deduction (donations x 2.5) can end in .5, so assessable income
  is a ``fractions.Fraction``.
* Only at the output boundary are cents turned into dollars (``cents / 100``)
  and per-mille rates into floats (``mille / 1000``).

Usage
-----
    python3 sgtax_reference.py inputs.json      # JSON array in, JSON array out
    python3 sgtax_reference.py --warning-order=table inputs.json
                                                # warnings in the order of the SPEC 6.11 table

Standard library only.
"""

from __future__ import annotations

import json
import math
import re
import sys
from fractions import Fraction

__all__ = [
    "SUPPORTED_INCOME_YEARS",
    "LEVER_IDS",
    "WARNING_TABLE",
    "UnsupportedIncomeYear",
    "get_rules",
    "sanitise_input",
    "compute_cpf",
    "gross_tax",
    "marginal_rate",
    "evaluate",
    "plan",
    "default_income_year",
    "default_input",
    "main",
]

LEVER_IDS = ("srs", "cpfSelf", "cpfFamily")

# Field of `existing` that belongs to each lever.
_EXISTING_FIELD = {"srs": "srs", "cpfSelf": "cpfTopUpSelf", "cpfFamily": "cpfTopUpFamily"}


class UnsupportedIncomeYear(ValueError):
    """Raised by get_rules()/plan() for an income year without rules."""


# ---------------------------------------------------------------------------
# Rules - transcribed from SPEC section 5.  Rates are per mille (x1000).
# ---------------------------------------------------------------------------

# SPEC 5.1 - resident income tax rates, YA2024 onwards.  (from, rate per mille)
_TAX_BRACKETS = (
    (0, 0),            # first 20,000 at 0%
    (20_000, 20),      # next 10,000 at 2%
    (30_000, 35),      # next 10,000 at 3.5%
    (40_000, 70),      # next 40,000 at 7%
    (80_000, 115),     # next 40,000 at 11.5%
    (120_000, 150),    # next 40,000 at 15%
    (160_000, 180),    # next 40,000 at 18%
    (200_000, 190),    # next 40,000 at 19%
    (240_000, 195),    # next 40,000 at 19.5%
    (280_000, 200),    # next 40,000 at 20%
    (320_000, 220),    # next 180,000 at 22%
    (500_000, 230),    # next 500,000 at 23%
    (1_000_000, 240),  # above 1,000,000 at 24%
)


def _band(max_age, employee_mille, employer_mille):
    """One CPF age band.  SPEC 5.3: phase-in factor = 3 x employee rate."""
    return {
        "maxAge": max_age,
        "employee": employee_mille,
        "employer": employer_mille,  # None = not given by the SPEC
        "phaseIn": 3 * employee_mille,
    }


# SPEC 5.3 - employee / employer rates, citizens and SPRs from the 3rd year.
_FULL_RATES_2025 = (
    _band(55, 200, 170),    # 55 and below      20%   / 17%
    _band(60, 170, 155),    # above 55 to 60    17%   / 15.5%
    _band(65, 115, 120),    # above 60 to 65    11.5% / 12%
    _band(70, 75, 90),      # above 65 to 70    7.5%  / 9%
    _band(None, 50, 75),    # above 70          5%    / 7.5%
)
_FULL_RATES_2026 = (
    _band(55, 200, 170),    # 20%   / 17%
    _band(60, 180, 160),    # 18%   / 16%
    _band(65, 125, 125),    # 12.5% / 12.5%
    _band(70, 75, 90),      # 7.5%  / 9%
    _band(None, 50, 75),    # 5%    / 7.5%
)
_FULL_RATES_2027 = (
    _band(55, 200, 170),    # 20%   / 17%
    _band(60, 190, 165),    # 19%   / 16.5%
    _band(65, 130, 130),    # 13%   / 13%
    _band(70, 75, 90),      # 7.5%  / 9%
    _band(None, 50, 75),    # 5%    / 7.5%
)

# SPEC 5.3 - SPR graduated employee rates (same in all three years).  The SPEC
# gives no employer rates for these, so the employer share is unknown (None).
_PR_YEAR1_RATES = (
    _band(55, 50, None),    # year 1: 5% at every age
    _band(60, 50, None),
    _band(65, 50, None),
    _band(70, 50, None),
    _band(None, 50, None),
)
_PR_YEAR2_RATES = (
    _band(55, 150, None),   # 15%   (55 and below)
    _band(60, 125, None),   # 12.5% (above 55 to 60)
    _band(65, 75, None),    # 7.5%  (above 60 to 65)
    _band(None, 50, None),  # 5%    (above 65)
)


def _year(income_year, status, ow_ceiling, full_rates, frs, ers, bhs, matched_medisave):
    return {
        "incomeYear": income_year,
        "ya": income_year + 1,
        "status": status,
        "taxBrackets": _TAX_BRACKETS,
        # SPEC 5.1: no Personal Income Tax Rebate for YA2026, YA2027 (assumed) or YA2028 (projected).
        # If ever set: {"rate": <per mille>, "cap": <dollars>}.
        "pitRebate": None,
        "personalReliefCap": 80_000,                                      # SPEC 5.2
        "earnedIncomeRelief": {"below55": 1_000, "age55to59": 6_000, "age60plus": 8_000},
        "donationDeductionMultiplier": Fraction(5, 2),                    # 250%
        "cpf": {
            "owCeilingMonthly": ow_ceiling,
            "annualWageCeiling": 102_000,
            "fullRates": full_rates,
            "prYear1Rates": _PR_YEAR1_RATES,
            "prYear2Rates": _PR_YEAR2_RATES,
            "employeeNilUpTo": 500,
            "phaseInUpTo": 750,
        },
        "srs": {"capCitizenPr": 15_300, "capForeigner": 35_700, "minAge": 18},   # SPEC 5.4
        "cpfTopUp": {
            "selfReliefCap": 8_000,
            "familyReliefCap": 8_000,
            # SPEC 5.4 / 6.5: relief for topping up family members is for givers who are
            # Singapore Citizens or PRs only.
            "familyGiverResidency": ("citizen", "pr"),
            "fullRetirementSum": frs,          # informational
            "enhancedRetirementSum": ers,      # informational
            "basicHealthcareSum": bhs,         # informational
            # SPEC 5.4: the part of a top-up that the Government matches earns the giver no relief -
            # the first S$2,000 a year under the Matched Retirement Savings Scheme, and (top-ups from
            # 2026) the first S$1,000 a year to MediSave under the Matched MediSave Scheme.  Wording
            # only: every top-up amount in the model already means the part that is not matched (6.3).
            "matchedTopUps": {"retirementAnnualCap": 2_000, "mediSaveAnnualCap": matched_medisave},
            "payoutEligibilityAge": 65,        # informational
        },
        "contributionDeadline": "%04d-12-31" % income_year,
    }


RULES = {
    # 2025: the Matched MediSave Scheme does not apply yet (SPEC 5.4: "not applicable").
    2025: _year(2025, "final", 7_400, _FULL_RATES_2025, 213_000, 426_000, 75_500, None),
    2026: _year(2026, "final", 8_000, _FULL_RATES_2026, 220_400, 440_800, 79_000, 1_000),
    # 2027: BHS not yet announced, the 2026 figure is carried forward (SPEC 5.4).
    2027: _year(2027, "projected", 8_000, _FULL_RATES_2027, 228_200, 456_400, 79_000, 1_000),
}

SUPPORTED_INCOME_YEARS = tuple(sorted(RULES))


def get_rules(income_year):
    """Rules for an income year; raises UnsupportedIncomeYear otherwise."""
    if _is_number(income_year) and income_year == income_year and income_year in RULES:
        return RULES[int(income_year)]
    raise UnsupportedIncomeYear("unsupported incomeYear")


# ---------------------------------------------------------------------------
# SPEC 6.0 - conventions and input sanitising
# ---------------------------------------------------------------------------

def _is_number(v):
    """True for JSON numbers (bool is not a number, as in JavaScript's typeof)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# SPEC 6.0: "Money inputs are also clamped to at most S$10,000,000,000".
_MAX_MONEY = 10_000_000_000

# SPEC 7: the public tax functions clamp their chargeable-income argument to S$140,000,000,000,
# the largest chargeable income the clamped money inputs can produce
# (12 months of wages + additional wages + other income, each at most S$10,000,000,000).
_MAX_CHARGEABLE_INCOME = 140_000_000_000


def _whole(v):
    """SPEC 6.0 numeric sanitising: not finite or < 0 -> 0; otherwise floor.

    Non-numbers count as not finite.  The data contract is a JSON number, i.e. an IEEE-754
    double, so a Python int is first read as the double it would be: one that is too large
    for a double is "not finite" (0), like the Infinity a JSON parser would produce for it.
    """
    if not _is_number(v):
        return 0
    if isinstance(v, int):
        try:
            v = float(v)
        except OverflowError:
            return 0
    if not math.isfinite(v) or v < 0:
        return 0
    return math.floor(v)


def _money(v):
    """A money input: sanitised (_whole), then clamped to at most S$10,000,000,000."""
    return min(_whole(v), _MAX_MONEY)


def _optional_money(v):
    """A number -> sanitised money; anything else (None/missing) -> None = "no limit"."""
    return _money(v) if _is_number(v) else None


def _optional_figure(v):
    """SPEC 6.0: the employee CPF override is a figure only when it is a finite number of 0 or more.

    NaN, +/-Infinity, a negative number or a non-number all mean "not provided" (the auto-calculation is used).
    An integer too large for a double is not finite, as a JSON parser would read it.
    """
    if not _is_number(v):
        return None
    if isinstance(v, int):
        try:
            v = float(v)
        except OverflowError:
            return None
    if not math.isfinite(v) or v < 0:
        return None
    return _money(v)


def _clamped_int(v, lo, hi, default):
    """Missing/None/non-number -> default; otherwise sanitise (not as money: no S$10bn clamp), then clamp to lo..hi."""
    if not _is_number(v):
        return default
    return max(lo, min(hi, _whole(v)))


# SPEC 6.0: `today` is read as its leading YYYY-MM-DD - exactly four digits, a hyphen, two digits,
# a hyphen, two digits, and no further digit straight after.  ASCII digits only.
_LEADING_DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})(?![0-9])")


def _is_leap_year(year):
    return year % 400 == 0 or (year % 4 == 0 and year % 100 != 0)


def _month_length(year, month):
    if month == 2:
        return 29 if _is_leap_year(year) else 28
    return 30 if month in (4, 6, 9, 11) else 31


def _read_date(text):
    """The leading YYYY-MM-DD of `text` as (year, month, day); None when it cannot be parsed.

    Unparseable (SPEC 6.0): anything that is not a string, a string that does not start with that
    pattern (leading whitespace and unpadded fields included), a date followed directly by another
    digit, and a date that does not exist in the calendar (month 13, 30 February, 29 February of a
    non-leap year).  Whatever follows the date (a time, a zone) is ignored.
    """
    if not isinstance(text, str):
        return None
    found = _LEADING_DATE.match(text)
    if found is None:
        return None
    year, month, day = int(found.group(1)), int(found.group(2)), int(found.group(3))
    if not 1 <= month <= 12:
        return None
    if not 1 <= day <= _month_length(year, month):
        return None
    return year, month, day


def _day_number(date):
    """A running day count in the proleptic Gregorian calendar (differences are whole days).

    Years are counted from 1 March so that the leap day is the last day of the counting year;
    400 Gregorian years are always 146,097 days.  Works for year 0000 as well.
    """
    year, month, day = date
    counting_year = year if month >= 3 else year - 1
    cycle, year_of_cycle = divmod(counting_year, 400)
    months_since_march = (month - 3) % 12
    day_of_counting_year = (153 * months_since_march + 2) // 5 + (day - 1)
    day_of_cycle = 365 * year_of_cycle + year_of_cycle // 4 - year_of_cycle // 100 + day_of_counting_year
    return 146_097 * cycle + day_of_cycle


def _sanitise_today(value, income_year):
    """`today` as YYYY-MM-DD; an unparseable value becomes 1 January of the income year (SPEC 6.0)."""
    date = _read_date(value)
    if date is None:
        if not (_is_number(income_year) and isinstance(income_year, int) and 0 <= income_year <= 9999):
            return None  # no usable income year either; plan() rejects such an input anyway
        date = (income_year, 1, 1)
    return "%04d-%02d-%02d" % date


def _obj(v):
    return v if isinstance(v, dict) else {}


def _sanitise_priority(v):
    out = []
    if isinstance(v, (list, tuple)):
        for item in v:
            if isinstance(item, str) and item in LEVER_IDS and item not in out:
                out.append(item)
    for lever in LEVER_IDS:
        if lever not in out:
            out.append(lever)
    return out


def sanitise_input(raw):
    """Return a fully defaulted, sanitised copy of a PlannerInput dict (SPEC 6.0).

    Optional limits that are absent are returned as None ("no limit").
    The function is idempotent.
    """
    raw = _obj(raw)
    profile = _obj(raw.get("profile"))
    income = _obj(raw.get("income"))
    existing = _obj(raw.get("existing"))
    levers = _obj(raw.get("levers"))
    prefs = _obj(raw.get("preferences"))
    lev_srs = _obj(levers.get("srs"))
    lev_self = _obj(levers.get("cpfSelf"))
    lev_family = _obj(levers.get("cpfFamily"))

    income_year = raw.get("incomeYear")
    if _is_number(income_year) and isinstance(income_year, float) and income_year.is_integer():
        income_year = int(income_year)

    residency = profile.get("residency")
    if residency not in ("citizen", "pr", "foreigner"):
        residency = "citizen"  # not specified by the SPEC; see README

    pr_year = profile.get("prYear")
    pr_year = int(pr_year) if _is_number(pr_year) and pr_year in (1, 2) else 3

    min_rate = prefs.get("minSavingRate")
    if not _is_number(min_rate) or min_rate != min_rate:  # missing or NaN
        min_rate = 0.0
    try:
        min_rate = float(min_rate)
    except OverflowError:  # an integer beyond the range of a double: +/- infinity, clamped below
        min_rate = math.inf if min_rate > 0 else -math.inf
    min_rate = min(1.0, max(0.0, min_rate))

    step = prefs.get("simulatorStep")
    step = max(100, _whole(step)) if _is_number(step) else 1000

    return {
        "incomeYear": income_year,
        "today": _sanitise_today(raw.get("today"), income_year),
        "profile": {
            "residency": residency,
            "prYear": pr_year,
            "ageAtYearEnd": _clamped_int(profile.get("ageAtYearEnd"), 0, 120, 0),
            "birthMonth": _clamped_int(profile.get("birthMonth"), 1, 12, 12),
            # SPEC 6.0: true only for the boolean true (1, "true", missing ... are all false).
            "hasUnusedParenthoodTaxRebate": profile.get("hasUnusedParenthoodTaxRebate") is True,
        },
        "income": {
            "monthlyOrdinaryWage": _money(income.get("monthlyOrdinaryWage")),
            "monthsWorked": _clamped_int(income.get("monthsWorked"), 1, 12, 12),
            "additionalWages": _money(income.get("additionalWages")),
            "otherTaxableIncome": _money(income.get("otherTaxableIncome")),
            "employmentExpenses": _money(income.get("employmentExpenses")),
            "donations": _money(income.get("donations")),
            "employeeCpfOverride": _optional_figure(income.get("employeeCpfOverride")),
        },
        "existing": {
            "srs": _money(existing.get("srs")),
            "cpfTopUpSelf": _money(existing.get("cpfTopUpSelf")),
            "cpfTopUpFamily": _money(existing.get("cpfTopUpFamily")),
        },
        "otherReliefs": _money(raw.get("otherReliefs")),
        "levers": {
            # SPEC 6.0: a lever is enabled only when `enabled` is exactly the boolean true.
            "srs": {"enabled": lev_srs.get("enabled") is True},
            "cpfSelf": {
                "enabled": lev_self.get("enabled") is True,
                "roomToLimit": _optional_money(lev_self.get("roomToLimit")),
            },
            "cpfFamily": {
                "enabled": lev_family.get("enabled") is True,
                "maxAmount": _optional_money(lev_family.get("maxAmount")),
            },
        },
        "preferences": {
            "cashBudget": _optional_money(prefs.get("cashBudget")),
            "minSavingRate": min_rate,
            "priority": _sanitise_priority(prefs.get("priority")),
            "simulatorStep": step,
        },
    }


# ---------------------------------------------------------------------------
# Small numeric helpers (output boundary)
# ---------------------------------------------------------------------------

def _rate(mille):
    """Per-mille integer -> float fraction (115 -> 0.115)."""
    return mille / 1000


def _dollars(cents):
    """Integer cents -> float dollars (correctly rounded to the nearest double)."""
    return cents / 100


def _num(value):
    """Fraction/int -> int when whole, else float."""
    if isinstance(value, Fraction):
        return value.numerator if value.denominator == 1 else float(value)
    return value


# ---------------------------------------------------------------------------
# SPEC 6.4 - tax
# ---------------------------------------------------------------------------

def _gross_tax_cents(ci, brackets):
    """Bracket sum in integer mills, rounded half-up to cents once."""
    mills = 0
    last = len(brackets) - 1
    for k, (frm, rate) in enumerate(brackets):
        top = ci if k == last else min(ci, brackets[k + 1][0])
        portion = top - frm
        if portion > 0:
            mills += rate * portion
    return (mills + 5) // 10


def _marginal_mille(ci, brackets):
    """0 if ci = 0, else the rate of the bracket with the largest `from` < ci."""
    if ci <= 0:
        return 0
    rate = 0
    for frm, r in brackets:
        if frm < ci:
            rate = r
        else:
            break
    return rate


def _pit_rebate_cents(gross_cents, rebate):
    """0 if there is no rebate, else min(cap, round2(rate x grossTax))."""
    if not rebate:
        return 0
    return min(rebate["cap"] * 100, (rebate["rate"] * gross_cents + 500) // 1000)


def _tax_payable_cents(ci, rules):
    gross = _gross_tax_cents(ci, rules["taxBrackets"])
    return max(0, gross - _pit_rebate_cents(gross, rules["pitRebate"]))


def _chargeable_income_argument(v):
    """SPEC 7: sanitised like any numeric input (6.0), then clamped to S$140,000,000,000."""
    return min(_whole(v), _MAX_CHARGEABLE_INCOME)


def gross_tax(chargeable_income, rules):
    """Gross tax in dollars (float, 2 dp) on a chargeable income."""
    return _dollars(_gross_tax_cents(_chargeable_income_argument(chargeable_income), rules["taxBrackets"]))


def marginal_rate(chargeable_income, rules):
    """Marginal rate (float fraction) at a chargeable income."""
    return _rate(_marginal_mille(_chargeable_income_argument(chargeable_income), rules["taxBrackets"]))


def _floor_ci(min_rate, brackets):
    """`from` of the lowest bracket whose rate > 0 and rate >= r; None = infinity.

    The comparison is made on doubles (mille / 1000 >= r) on purpose: a
    minSavingRate of 0.07 arrives as the double nearest to 0.07, which is the
    same double as the 7% bracket rate, so it must compare equal.
    """
    for frm, rate in brackets:
        if rate > 0 and _rate(rate) >= min_rate:
            return frm
    return None


# ---------------------------------------------------------------------------
# SPEC 6.1 - compulsory employee CPF contribution
# ---------------------------------------------------------------------------

def _compute_cpf(s, rules):
    """Returns (CpfComputation dict, override_exceeded_max)."""
    prof = s["profile"]
    inc = s["income"]
    cpf = rules["cpf"]

    if prof["residency"] == "foreigner":
        # Section 6.1 does not apply: nothing is subject to CPF, override ignored.
        return {
            "source": "none",
            "ordinaryWagesSubject": 0,
            "additionalWageCeiling": 0,
            "additionalWagesSubject": 0,
            "employeeContribution": 0,
            "employerContribution": 0,
            "monthlyEmployeeRates": [0.0] * 12,
        }, False

    if prof["residency"] == "pr" and prof["prYear"] == 1:
        table = cpf["prYear1Rates"]
    elif prof["residency"] == "pr" and prof["prYear"] == 2:
        table = cpf["prYear2Rates"]
    else:
        table = cpf["fullRates"]

    age = prof["ageAtYearEnd"]
    birth_month = prof["birthMonth"]

    def band(month):
        completed = age - 1 if month <= birth_month else age
        for b in table:
            if b["maxAge"] is None or completed < b["maxAge"]:
                return b
        return table[-1]

    ow = inc["monthlyOrdinaryWage"]
    n = inc["monthsWorked"]
    ow_subject = min(ow, cpf["owCeilingMonthly"])

    ordinary_subject = 0
    employee_ow = 0
    employer_mills = 0          # dollars x per-mille
    employer_known = True
    monthly_rates = [0.0] * 12
    for m in range(13 - n, 13):
        b = band(m)
        ordinary_subject += ow_subject
        if ow <= cpf["employeeNilUpTo"]:
            share = 0
        elif ow <= cpf["phaseInUpTo"]:
            share = (b["phaseIn"] * (ow - cpf["employeeNilUpTo"])) // 1000
        else:
            share = (b["employee"] * ow_subject) // 1000
        employee_ow += share
        monthly_rates[m - 1] = _rate(b["employee"])
        if b["employer"] is None:
            employer_known = False
        else:
            employer_mills += b["employer"] * ow_subject

    aw_ceiling = max(0, cpf["annualWageCeiling"] - ordinary_subject)
    aw_subject = min(inc["additionalWages"], aw_ceiling)
    december = band(12)
    employee_aw = (december["employee"] * aw_subject) // 1000
    if december["employer"] is None:
        employer_known = False
    else:
        employer_mills += december["employer"] * aw_subject

    employee = employee_ow + employee_aw
    employer = (employer_mills + 500) // 1000 if employer_known else 0
    source = "auto"
    exceeded = False

    override = inc["employeeCpfOverride"]
    if override is not None:
        max_compulsory = (cpf["fullRates"][0]["employee"] * cpf["annualWageCeiling"]) // 1000
        exceeded = override > max_compulsory
        employee = min(override, max_compulsory)
        employer = 0
        source = "override"

    return {
        "source": source,
        "ordinaryWagesSubject": ordinary_subject,
        "additionalWageCeiling": aw_ceiling,
        "additionalWagesSubject": aw_subject,
        "employeeContribution": employee,
        "employerContribution": employer,
        "monthlyEmployeeRates": monthly_rates,
    }, exceeded


def compute_cpf(input, rules=None):
    """CpfComputation for a PlannerInput (sanitised here)."""
    s = sanitise_input(input)
    if rules is None:
        rules = get_rules(s["incomeYear"])
    return _compute_cpf(s, rules)[0]


# ---------------------------------------------------------------------------
# SPEC 6.5 - levers: eligibility, caps and room
# ---------------------------------------------------------------------------

# SPEC 6.5: the age (on 31 December of the income year) from which the room for a top-up to one's
# own CPF must be entered - the age at which the Retirement Account exists.
_ROOM_CONFIRMATION_AGE = 55


def _lever_rooms(s, rules):
    """Returns (levers dict incl. private `roomIfEnabled`, existing_exceeds_cap)."""
    prof = s["profile"]
    residency = prof["residency"]
    eligible = {
        "srs": prof["ageAtYearEnd"] >= rules["srs"]["minAge"],
        "cpfSelf": residency in ("citizen", "pr"),
        # SPEC 6.5: eligible only when the residency is listed in cpfTopUp.familyGiverResidency.
        "cpfFamily": residency in rules["cpfTopUp"]["familyGiverResidency"],
    }
    statutory = {
        "srs": rules["srs"]["capForeigner"] if residency == "foreigner" else rules["srs"]["capCitizenPr"],
        "cpfSelf": rules["cpfTopUp"]["selfReliefCap"],
        "cpfFamily": rules["cpfTopUp"]["familyReliefCap"],
    }
    user_limit = {
        "srs": None,
        "cpfSelf": s["levers"]["cpfSelf"]["roomToLimit"],
        "cpfFamily": s["levers"]["cpfFamily"]["maxAmount"],
    }
    out = {}
    exceeds = False
    for lever in LEVER_IDS:
        cap = statutory[lever] if eligible[lever] else 0
        existing = s["existing"][_EXISTING_FIELD[lever]]
        if cap > 0 and existing > cap:
            exceeds = True
        used = min(existing, cap)
        room_if_enabled = max(0, cap - used)
        if user_limit[lever] is not None:
            room_if_enabled = min(room_if_enabled, user_limit[lever])
        elif lever == "cpfSelf" and prof["ageAtYearEnd"] >= _ROOM_CONFIRMATION_AGE:
            # SPEC 6.5 "Room must be confirmed from age 55": from 55 the CPF Board takes cash up to
            # the Enhanced Retirement Sum while relief stops at the Full Retirement Sum, so a blank
            # roomToLimit means "not confirmed", not "unlimited" - the lever has no room at all.
            room_if_enabled = 0
        enabled = s["levers"][lever]["enabled"]
        out[lever] = {
            "statutoryCap": cap,
            "used": used,
            "room": room_if_enabled if (eligible[lever] and enabled) else 0,
            "eligible": eligible[lever],
            "enabled": enabled,
            "_roomIfEnabled": room_if_enabled,
        }
    return out, exceeds


# ---------------------------------------------------------------------------
# SPEC 6.2 - 6.4 - income, reliefs and tax for one profile
# ---------------------------------------------------------------------------

class _Profile:
    """Everything about one sanitised input that does not depend on the plan."""

    def __init__(self, raw):
        self.s = s = sanitise_input(raw)
        self.rules = rules = get_rules(s["incomeYear"])
        self.cpf, self.override_exceeded = _compute_cpf(s, rules)
        self.levers, self.existing_exceeds_cap = _lever_rooms(s, rules)

        inc = s["income"]
        # SPEC 6.2
        self.employment_income = inc["monthlyOrdinaryWage"] * inc["monthsWorked"] + inc["additionalWages"]
        self.net_employment = max(0, self.employment_income - inc["employmentExpenses"])
        self.total_income = self.net_employment + inc["otherTaxableIncome"]
        self.donation_deduction = inc["donations"] * rules["donationDeductionMultiplier"]
        self.assessable = max(Fraction(0), Fraction(self.total_income) - self.donation_deduction)

        # SPEC 6.3 - Earned Income Relief by age on 31 December, limited to earned income.
        age = s["profile"]["ageAtYearEnd"]
        eir = rules["earnedIncomeRelief"]
        if age < 55:
            amount = eir["below55"]
        elif age <= 59:
            amount = eir["age55to59"]
        else:
            amount = eir["age60plus"]
        self.earned_income_relief = min(amount, self.net_employment)

    def evaluate(self, additional):
        """SPEC 6.3/6.4.  Returns (TaxComputation dict, chargeable income, tax payable in cents)."""
        s = self.s
        rules = self.rules
        existing = s["existing"]
        lev = self.levers

        srs = min(existing["srs"] + additional["srs"], lev["srs"]["statutoryCap"])
        top_self = min(existing["cpfTopUpSelf"] + additional["cpfSelf"], lev["cpfSelf"]["statutoryCap"])
        top_family = min(existing["cpfTopUpFamily"] + additional["cpfFamily"], lev["cpfFamily"]["statutoryCap"])
        cpf = self.cpf["employeeContribution"]
        other = s["otherReliefs"]

        total_before_cap = self.earned_income_relief + cpf + srs + top_self + top_family + other
        total_allowed = min(total_before_cap, rules["personalReliefCap"])
        lost_to_cap = total_before_cap - total_allowed
        ci = math.floor(max(Fraction(0), self.assessable - total_allowed))

        gross = _gross_tax_cents(ci, rules["taxBrackets"])
        rebate = _pit_rebate_cents(gross, rules["pitRebate"])
        payable = max(0, gross - rebate)

        computation = {
            "employmentIncome": self.employment_income,
            "employmentExpenses": s["income"]["employmentExpenses"],
            "otherTaxableIncome": s["income"]["otherTaxableIncome"],
            "totalIncome": self.total_income,
            "donationDeduction": _num(self.donation_deduction),
            "assessableIncome": _num(self.assessable),
            "reliefs": {
                "earnedIncome": self.earned_income_relief,
                "cpf": cpf,
                "srs": srs,
                "cpfTopUpSelf": top_self,
                "cpfTopUpFamily": top_family,
                "other": other,
                "totalBeforeCap": total_before_cap,
                "totalAllowed": total_allowed,
                "lostToCap": lost_to_cap,
            },
            "chargeableIncome": ci,
            "grossTax": _dollars(gross),
            "pitRebate": _dollars(rebate),
            "taxPayable": _dollars(payable),
            "marginalRate": _rate(_marginal_mille(ci, rules["taxBrackets"])),
            "effectiveRate": (_dollars(payable) / self.total_income) if self.total_income > 0 else 0.0,
        }
        return computation, ci, payable


def _amounts(srs=0, cpf_self=0, cpf_family=0):
    return {"srs": srs, "cpfSelf": cpf_self, "cpfFamily": cpf_family}


def evaluate(input, additional=None):
    """TaxComputation for the profile with `additional` contributions on top of `existing`."""
    additional = _obj(additional)
    add = {lever: _money(additional.get(lever)) for lever in LEVER_IDS}
    return _Profile(input).evaluate(add)[0]


# ---------------------------------------------------------------------------
# SPEC 6.6 - 6.11 - optimiser, ladder, simulator, scenarios, monthly plan, warnings
# ---------------------------------------------------------------------------

def _allocate(total, rooms, priority):
    """Walk the priority order; give each lever min(room, remaining)."""
    out = _amounts()
    remaining = total
    for lever in priority:
        give = min(rooms[lever], remaining)
        out[lever] = give
        remaining -= give
    return out


# SPEC 6.11 - the warnings table: (code, severity), in the order of the table.  "At most one
# warning is emitted per code, in the order of the table."
WARNING_TABLE = (
    ("NO_TAX_PAYABLE", "info"),
    ("RELIEF_CAP_EXCEEDED_BASELINE", "caution"),
    ("RELIEF_CAP_LIMITS_PLAN", "caution"),
    ("BELOW_MIN_SAVING_RATE", "info"),
    ("BUDGET_LIMITS_PLAN", "info"),
    ("LEVER_LIMITS_PLAN", "info"),
    ("EXISTING_EXCEEDS_CAP", "caution"),
    ("CPF_OVERRIDE_ABOVE_MAX", "caution"),
    ("FOREIGNER_NO_CPF", "info"),
    ("TAX_RESIDENCY_CHECK", "caution"),
    ("SRS_NON_RESIDENT_WITHDRAWAL", "caution"),
    ("PR_GRADUATED_RATES", "info"),
    ("CPF_SELF_ROOM_UNCONFIRMED", "caution"),
    ("AGE_55_PLUS_TOPUP", "info"),
    ("FAMILY_TOPUP_CHECKS", "caution"),
    ("PARENTHOOD_TAX_REBATE", "caution"),
    ("SRS_UNDER_18", "caution"),
    ("DEADLINE_PASSED", "blocker"),
    ("DEADLINE_SOON", "caution"),
    ("PROJECTED_RULES", "caution"),
    ("PIT_REBATE_APPLIED", "info"),
)

# SPEC 6.11: a foreigner who worked this many months or fewer is asked to check tax residency.
_RESIDENCY_CHECK_MONTHS = 6


def plan(input):
    """Everything in one call (SPEC 6).  Mirrors PlannerResult without `rules` and `input`;
    warnings are {"code", "severity"} only, one per code, in the order of the SPEC 6.11 table."""
    p = _Profile(input)
    s = p.s
    rules = p.rules
    brackets = rules["taxBrackets"]
    prefs = s["preferences"]
    priority = prefs["priority"]
    today_year, today_month, _today_day = today = _read_date(s["today"])   # sanitised: always a real date here

    baseline, ci0, base_tax = p.evaluate(_amounts())
    rooms = {lever: p.levers[lever]["room"] for lever in LEVER_IDS}

    def tax_after_relief(x):
        """N(x): tax payable (cents) after x dollars of additional ALLOWED relief."""
        return _tax_payable_cents(max(0, ci0 - x), rules)

    def useful_room(min_rate):
        floor_ci = _floor_ci(min_rate, brackets)
        return 0 if floor_ci is None else max(0, ci0 - floor_ci)

    # --- 6.6 optimiser -----------------------------------------------------
    relief_cap_room = max(0, rules["personalReliefCap"] - baseline["reliefs"]["totalBeforeCap"])   # C
    useful = useful_room(prefs["minSavingRate"])                                                  # U
    useful_any = useful_room(0.0)                                                                  # usefulRoom(0)
    lever_room = sum(rooms.values())                                                               # L
    budget = prefs["cashBudget"]                                                                   # B (None = infinity)

    x_total = min(useful, relief_cap_room, lever_room)
    if budget is not None:
        x_total = min(x_total, budget)

    contributions = _allocate(x_total, rooms, priority)
    optimised, ci_after, after_tax = p.evaluate(contributions)
    saved_cents = base_tax - after_tax

    if base_tax == 0:
        binding = "none"
    else:
        candidates = [("usefulRoom", useful), ("reliefCap", relief_cap_room), ("leverLimits", lever_room)]
        if budget is not None:
            candidates.append(("cashBudget", budget))
        binding = candidates[0][0]
        smallest = candidates[0][1]
        for name, value in candidates[1:]:
            if value < smallest:      # strict: ties keep the earlier constraint
                binding, smallest = name, value

    unrealised_cents = tax_after_relief(x_total) - tax_after_relief(min(useful, relief_cap_room))

    plan_out = {
        "contributions": dict(contributions),
        "totalContribution": x_total,
        "taxBefore": _dollars(base_tax),
        "taxAfter": _dollars(after_tax),
        "taxSaved": _dollars(saved_cents),
        "savingRate": (_dollars(saved_cents) / x_total) if x_total > 0 else 0.0,
        "chargeableIncomeBefore": ci0,
        "chargeableIncomeAfter": ci_after,
        "marginalRateBefore": baseline["marginalRate"],
        "marginalRateAfter": optimised["marginalRate"],
        "bindingConstraint": binding,
        "unrealisedSaving": _dollars(unrealised_cents),
    }

    # --- 6.7 savings ladder ------------------------------------------------
    def tax_after_contribution(c):
        """Tax payable (cents) after contributing c: only min(c, C) of it is allowed relief."""
        return tax_after_relief(min(c, relief_cap_room))

    within_cap = min(lever_room, relief_cap_room)
    pieces = []      # [from, to, rate per mille, zeroReason]
    cuts = {0, within_cap}
    for frm, _rate_unused in brackets:
        boundary = ci0 - frm
        if 0 < boundary < within_cap:
            cuts.add(boundary)
    cuts = sorted(cuts)
    for a, b in zip(cuts, cuts[1:]):
        mille = _marginal_mille(ci0 - a, brackets)
        pieces.append([a, b, mille, None if mille > 0 else "belowTaxThreshold"])
    if lever_room > within_cap:
        pieces.append([within_cap, lever_room, 0, "reliefCap"])

    merged = []
    for piece in pieces:
        if piece[1] <= piece[0]:
            continue
        if merged and merged[-1][2] == piece[2] and merged[-1][3] == piece[3]:
            merged[-1][1] = piece[1]
        else:
            merged.append(piece)

    ladder = []
    for frm, to, mille, zero_reason in merged:
        tier = {
            "fromContribution": frm,
            "toContribution": to,
            "amount": to - frm,
            "rate": _rate(mille),
            "taxSaved": _dollars(tax_after_contribution(frm) - tax_after_contribution(to)),
            "cumulativeTaxSaved": _dollars(base_tax - tax_after_contribution(to)),
            "usedByPlan": max(0, min(to, x_total) - frm),
        }
        if zero_reason is not None:
            tier["zeroReason"] = zero_reason
        ladder.append(tier)

    # --- 6.8 simulator -----------------------------------------------------
    step = prefs["simulatorStep"]
    simulator = []
    prev_c = 0
    prev_saved = 0
    for i in range(0, -(-lever_room // step) + 1):
        c = min(i * step, lever_room)
        split = _allocate(c, rooms, priority)
        row_tax = p.evaluate(split)[2]
        row_saved = base_tax - row_tax
        if i == 0:
            step_saving = 0
            step_rate = 0.0
        else:
            step_saving = row_saved - prev_saved
            step_rate = _dollars(step_saving) / (c - prev_c)
        simulator.append({
            "contribution": c,
            "split": split,
            "taxPayable": _dollars(row_tax),
            "taxSaved": _dollars(row_saved),
            "stepSaving": _dollars(step_saving),
            "stepRate": step_rate,
            "withinPlan": c <= x_total,
        })
        prev_c, prev_saved = c, row_saved

    # --- 6.9 scenarios -----------------------------------------------------
    srs_room = p.levers["srs"]["_roomIfEnabled"]
    self_room = p.levers["cpfSelf"]["_roomIfEnabled"]
    family_room = p.levers["cpfFamily"]["room"]

    def scenario(scenario_id, amounts):
        total = sum(amounts.values())
        tax = p.evaluate(amounts)[2]
        saved = base_tax - tax
        return {
            "id": scenario_id,
            "contributions": dict(amounts),
            "totalContribution": total,
            "taxPayable": _dollars(tax),
            "taxSaved": _dollars(saved),
            "savingRate": (_dollars(saved) / total) if total > 0 else 0.0,
            "wastedContribution": total - min(total, useful_any, relief_cap_room),
        }

    scenarios = [
        scenario("none", _amounts()),
        scenario("srsOnly", _amounts(srs=srs_room)),
        scenario("cpfSelfOnly", _amounts(cpf_self=self_room)),
        scenario("srsPlusCpfSelf", _amounts(srs=srs_room, cpf_self=self_room)),
        scenario("maxAll", _amounts(srs=srs_room, cpf_self=self_room, cpf_family=family_room)),
        scenario("recommended", contributions),
    ]

    # --- 6.10 monthly plan -------------------------------------------------
    income_year = rules["incomeYear"]
    deadline = _read_date(rules["contributionDeadline"])   # 31 December of the income year
    days_to_deadline = _day_number(deadline) - _day_number(today)
    if today_year < income_year:
        months_remaining = 12
    elif today_year == income_year:
        months_remaining = 12 - today_month + 1
    else:
        months_remaining = 0

    schedule = []
    if months_remaining > 0 and x_total > 0:
        n = months_remaining
        for row in range(n):
            amounts = {}
            for lever in LEVER_IDS:
                base = contributions[lever] // n
                extra = contributions[lever] - base * n
                amounts[lever] = base + 1 if row < extra else base
            schedule.append({
                "month": "%04d-%02d" % (income_year, 12 - n + 1 + row),
                "amounts": amounts,
                "total": sum(amounts.values()),
            })

    full_year = {lever: -(-contributions[lever] // 12) for lever in LEVER_IDS}
    full_year["total"] = sum(full_year[lever] for lever in LEVER_IDS)

    monthly_plan = {
        "deadline": rules["contributionDeadline"],
        "daysToDeadline": days_to_deadline,
        "monthsRemaining": months_remaining,
        "schedule": schedule,
        "fullYearMonthly": full_year,
    }

    # --- 6.11 warnings -----------------------------------------------------
    prof = s["profile"]
    foreigner = prof["residency"] == "foreigner"
    lev_srs = p.levers["srs"]
    lev_self = p.levers["cpfSelf"]
    lev_family = p.levers["cpfFamily"]
    # "roomToLimit provided" = it is a number after 6.0 sanitising (NaN, +/-Infinity and negative
    # numbers are numbers: a limit of 0, which confirms a room of nothing).
    room_provided = s["levers"]["cpfSelf"]["roomToLimit"] is not None
    self_top_up_from_55 = (prof["ageAtYearEnd"] >= _ROOM_CONFIRMATION_AGE
                           and lev_self["enabled"] and lev_self["eligible"])

    codes = set()
    if base_tax == 0:
        codes.add("NO_TAX_PAYABLE")
    if baseline["reliefs"]["lostToCap"] > 0:
        codes.add("RELIEF_CAP_EXCEEDED_BASELINE")
    if binding == "reliefCap":
        codes.add("RELIEF_CAP_LIMITS_PLAN")
    if base_tax > 0 and useful == 0:
        codes.add("BELOW_MIN_SAVING_RATE")
    if binding == "cashBudget":
        codes.add("BUDGET_LIMITS_PLAN")
    if binding == "leverLimits":
        codes.add("LEVER_LIMITS_PLAN")
    if p.existing_exceeds_cap:
        codes.add("EXISTING_EXCEEDS_CAP")
    if p.override_exceeded:
        codes.add("CPF_OVERRIDE_ABOVE_MAX")
    if foreigner:
        codes.add("FOREIGNER_NO_CPF")
    if foreigner and s["income"]["monthsWorked"] <= _RESIDENCY_CHECK_MONTHS:
        codes.add("TAX_RESIDENCY_CHECK")
    if foreigner and lev_srs["enabled"] and lev_srs["eligible"]:
        codes.add("SRS_NON_RESIDENT_WITHDRAWAL")
    if prof["residency"] == "pr" and prof["prYear"] < 3:
        codes.add("PR_GRADUATED_RATES")
    if self_top_up_from_55 and not room_provided:
        codes.add("CPF_SELF_ROOM_UNCONFIRMED")
    if self_top_up_from_55 and room_provided:
        codes.add("AGE_55_PLUS_TOPUP")
    if lev_family["eligible"] and (contributions["cpfFamily"] > 0 or s["existing"]["cpfTopUpFamily"] > 0):
        codes.add("FAMILY_TOPUP_CHECKS")
    if prof["hasUnusedParenthoodTaxRebate"]:
        codes.add("PARENTHOOD_TAX_REBATE")
    if prof["ageAtYearEnd"] < 18:
        codes.add("SRS_UNDER_18")
    if days_to_deadline < 0:
        codes.add("DEADLINE_PASSED")
    if 0 <= days_to_deadline <= 14 and x_total > 0:
        codes.add("DEADLINE_SOON")
    if rules["status"] == "projected":
        codes.add("PROJECTED_RULES")
    if baseline["pitRebate"] > 0:
        codes.add("PIT_REBATE_APPLIED")
    warnings = [{"code": code, "severity": severity} for code, severity in WARNING_TABLE if code in codes]

    levers_out = {
        lever: {key: value for key, value in p.levers[lever].items() if not key.startswith("_")}
        for lever in LEVER_IDS
    }

    return {
        "cpf": p.cpf,
        "baseline": baseline,
        "optimised": optimised,
        "levers": levers_out,
        "reliefCapRoom": relief_cap_room,
        "plan": plan_out,
        "ladder": ladder,
        "simulator": simulator,
        "scenarios": scenarios,
        "monthlyPlan": monthly_plan,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# SPEC 7 - convenience
# ---------------------------------------------------------------------------

def default_income_year(today):
    """Today's year if supported, else the nearest supported year (SPEC 7).

    When `today` cannot be parsed (SPEC 6.0) there is no year to go by: the answer is then the
    latest supported income year whose rules are final (the latest supported year if none is).
    """
    date = _read_date(today)
    if date is None:
        final_years = [y for y in SUPPORTED_INCOME_YEARS if RULES[y]["status"] == "final"]
        return final_years[-1] if final_years else SUPPORTED_INCOME_YEARS[-1]
    year = date[0]
    if year in RULES:
        return year
    return min(SUPPORTED_INCOME_YEARS, key=lambda y: (abs(y - year), y))


def default_input(today):
    """The opening worked example (SPEC 7 / Appendix A.1)."""
    return {
        "incomeYear": default_income_year(today),
        "today": today,
        "profile": {
            "residency": "citizen",
            "prYear": 3,
            "ageAtYearEnd": 35,
            "birthMonth": 12,
            "hasUnusedParenthoodTaxRebate": False,
        },
        "income": {
            "monthlyOrdinaryWage": 10_000,
            "monthsWorked": 12,
            "additionalWages": 15_000,
            "otherTaxableIncome": 0,
            "employmentExpenses": 0,
            "donations": 0,
            "employeeCpfOverride": None,
        },
        "existing": {"srs": 0, "cpfTopUpSelf": 0, "cpfTopUpFamily": 0},
        "otherReliefs": 5_000,
        "levers": {
            "srs": {"enabled": True},
            "cpfSelf": {"enabled": True, "roomToLimit": None},
            "cpfFamily": {"enabled": False, "maxAmount": None},
        },
        "preferences": {
            "cashBudget": None,
            "minSavingRate": 0.07,
            "priority": ["srs", "cpfSelf", "cpfFamily"],
            "simulatorStep": 1000,
        },
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

WARNING_ORDERS = ("code", "table")


def run_batch(inputs, warning_order="table"):
    """plan() for each input; errors become {"error": ...} elements.

    `warning_order` "table" leaves the warnings as plan() returns them, in the order of the SPEC 6.11
    table; "code" sorts them by code (what the command line prints unless told otherwise).
    """
    if warning_order not in WARNING_ORDERS:
        raise ValueError("warning_order must be one of %s" % ", ".join(WARNING_ORDERS))
    if isinstance(inputs, dict):
        inputs = [inputs]
    results = []
    for item in inputs:
        try:
            result = plan(item)
            if warning_order == "code":
                result["warnings"] = sorted(result["warnings"], key=lambda warning: warning["code"])
            results.append(result)
        except UnsupportedIncomeYear:
            results.append({"error": "unsupported incomeYear"})
        except (ValueError, OverflowError) as exc:
            # not expected for any JSON input: SPEC 6.0 sanitising gives every field a value
            results.append({"error": str(exc)})
    return results


_USAGE = ("usage: python3 sgtax_reference.py [--warning-order=code|table] <inputs.json>   ('-' reads stdin)\n"
          "       warnings are printed sorted by code unless --warning-order=table is given, which keeps\n"
          "       the order of the SPEC 6.11 table\n")


def main(argv=None):
    argv = sys.argv if argv is None else argv
    warning_order = "code"
    paths = []
    for argument in argv[1:]:
        if argument.startswith("--warning-order="):
            warning_order = argument[len("--warning-order="):]
        elif argument.startswith("--"):
            paths = []
            break
        else:
            paths.append(argument)
    if len(paths) != 1 or warning_order not in WARNING_ORDERS:
        sys.stderr.write(_USAGE)
        return 2
    if paths[0] == "-":
        inputs = json.load(sys.stdin)
    else:
        with open(paths[0], "r", encoding="utf-8") as handle:
            inputs = json.load(handle)
    json.dump(run_batch(inputs, warning_order), sys.stdout, allow_nan=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
