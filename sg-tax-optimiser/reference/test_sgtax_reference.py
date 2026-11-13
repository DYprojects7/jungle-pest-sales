# -*- coding: utf-8 -*-
"""Tests for the independent Python reference implementation.

Run from the project root:

    python3 -m unittest discover -s reference -p 'test_*.py'

Every expected number in this file was worked out by hand from SPEC.md
(Appendix A, Appendix B, or the section 6 formulas) - none was copied from
the implementation's output.
"""

import collections
import copy
import json
import math
import os
import random
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import sgtax_reference as ref  # noqa: E402

TODAY = "2026-11-13"


def base_input():
    """The opening example of Appendix A.1, written out in full."""
    return {
        "incomeYear": 2026,
        "today": TODAY,
        "profile": {"residency": "citizen", "ageAtYearEnd": 35},
        "income": {"monthlyOrdinaryWage": 10000, "monthsWorked": 12, "additionalWages": 15000},
        "existing": {"srs": 0, "cpfTopUpSelf": 0, "cpfTopUpFamily": 0},
        "otherReliefs": 5000,
        "levers": {
            "srs": {"enabled": True},
            "cpfSelf": {"enabled": True},
            "cpfFamily": {"enabled": False},
        },
        "preferences": {"minSavingRate": 0.07, "priority": ["srs", "cpfSelf", "cpfFamily"]},
    }


def make(changes=None):
    """base_input() with dotted-path overrides, e.g. {'profile.ageAtYearEnd': 57}."""
    inp = base_input()
    for path, value in (changes or {}).items():
        node = inp
        parts = path.split(".")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = value
    return inp


def codes(result):
    return [w["code"] for w in result["warnings"]]


# SPEC 6.11, typed from the table a second time (the reference holds its own copy): code, severity.
SPEC_WARNING_TABLE = [
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
]
SPEC_SEVERITY = dict(SPEC_WARNING_TABLE)
SPEC_WARNING_ORDER = [code for code, _severity in SPEC_WARNING_TABLE]


def warned(codes_in_order):
    """The warnings list for these codes, with the severities of the SPEC 6.11 table."""
    return [{"code": code, "severity": SPEC_SEVERITY[code]} for code in codes_in_order]


def without_warnings(result):
    return {key: value for key, value in result.items() if key != "warnings"}


def scenario(result, scenario_id):
    return next(s for s in result["scenarios"] if s["id"] == scenario_id)


class MoneyAssertions(unittest.TestCase):
    def assertMoney(self, actual, expected, msg=None):
        """Dollar amounts must agree to the cent (no tolerance beyond float noise)."""
        self.assertEqual(round(actual * 100), round(expected * 100), msg)
        self.assertAlmostEqual(actual, expected, places=9, msg=msg)


# ---------------------------------------------------------------------------
# Appendix A.1
# ---------------------------------------------------------------------------

class AppendixA1(MoneyAssertions):
    @classmethod
    def setUpClass(cls):
        cls.r = ref.plan(base_input())

    def test_employment_income(self):
        self.assertEqual(self.r["baseline"]["employmentIncome"], 135000)
        self.assertEqual(self.r["baseline"]["totalIncome"], 135000)
        self.assertEqual(self.r["baseline"]["assessableIncome"], 135000)

    def test_ow_subject_and_employee_share(self):
        cpf = self.r["cpf"]
        self.assertEqual(cpf["source"], "auto")
        self.assertEqual(cpf["ordinaryWagesSubject"], 96000)
        self.assertEqual(cpf["monthlyEmployeeRates"], [0.2] * 12)
        # employee on OW = 1,600 x 12 = 19,200, so the AW part is the remaining 1,200
        self.assertEqual(cpf["employeeContribution"] - 1200, 19200)

    def test_aw_ceiling_and_subject(self):
        cpf = self.r["cpf"]
        self.assertEqual(cpf["additionalWageCeiling"], 6000)
        self.assertEqual(cpf["additionalWagesSubject"], 6000)

    def test_cpf_relief(self):
        self.assertEqual(self.r["cpf"]["employeeContribution"], 20400)
        self.assertEqual(self.r["baseline"]["reliefs"]["cpf"], 20400)

    def test_employer_contribution_informational(self):
        # round(17% x 96,000 + 17% x 6,000)
        self.assertEqual(self.r["cpf"]["employerContribution"], 17340)

    def test_reliefs_before_cap(self):
        reliefs = self.r["baseline"]["reliefs"]
        self.assertEqual(reliefs["earnedIncome"], 1000)
        self.assertEqual(reliefs["other"], 5000)
        self.assertEqual(reliefs["totalBeforeCap"], 26400)
        self.assertEqual(reliefs["totalAllowed"], 26400)
        self.assertEqual(reliefs["lostToCap"], 0)

    def test_chargeable_income(self):
        self.assertEqual(self.r["baseline"]["chargeableIncome"], 108600)
        self.assertEqual(self.r["plan"]["chargeableIncomeBefore"], 108600)

    def test_tax_before(self):
        self.assertMoney(self.r["baseline"]["grossTax"], 6639.00)
        self.assertMoney(self.r["baseline"]["taxPayable"], 6639.00)
        self.assertMoney(self.r["baseline"]["pitRebate"], 0)
        self.assertMoney(self.r["plan"]["taxBefore"], 6639.00)
        self.assertEqual(self.r["baseline"]["marginalRate"], 0.115)
        self.assertEqual(self.r["plan"]["marginalRateBefore"], 0.115)
        self.assertAlmostEqual(self.r["baseline"]["effectiveRate"], 6639.0 / 135000, places=12)

    def test_u_c_l_b_and_binding(self):
        # U 68,600 . C 53,600 . L 23,300 . B infinity -> X = 23,300, binding leverLimits
        self.assertEqual(self.r["reliefCapRoom"], 53600)
        self.assertEqual(sum(self.r["levers"][k]["room"] for k in ref.LEVER_IDS), 23300)
        self.assertEqual(self.r["plan"]["totalContribution"], 23300)
        self.assertEqual(self.r["plan"]["bindingConstraint"], "leverLimits")
        # U is not output directly: check it through the "no lever limit" route.
        # With the relief cap room (53,600) below U (68,600), U itself shows up when
        # the minimum rate is raised to the top bracket: U(11.5%) = 108,600 - 80,000.
        top = ref.plan(make({"preferences.minSavingRate": 0.115}))
        self.assertEqual(top["plan"]["totalContribution"], 23300)  # still lever-bound (28,600 > 23,300)

    def test_levers(self):
        lev = self.r["levers"]
        self.assertEqual(lev["srs"], {"statutoryCap": 15300, "used": 0, "room": 15300, "eligible": True, "enabled": True})
        self.assertEqual(lev["cpfSelf"], {"statutoryCap": 8000, "used": 0, "room": 8000, "eligible": True, "enabled": True})
        self.assertEqual(lev["cpfFamily"], {"statutoryCap": 8000, "used": 0, "room": 0, "eligible": True, "enabled": False})

    def test_plan_split(self):
        self.assertEqual(self.r["plan"]["contributions"], {"srs": 15300, "cpfSelf": 8000, "cpfFamily": 0})

    def test_chargeable_income_after(self):
        self.assertEqual(self.r["plan"]["chargeableIncomeAfter"], 85300)
        self.assertEqual(self.r["optimised"]["chargeableIncome"], 85300)
        self.assertEqual(self.r["optimised"]["reliefs"]["srs"], 15300)
        self.assertEqual(self.r["optimised"]["reliefs"]["cpfTopUpSelf"], 8000)

    def test_tax_after(self):
        self.assertMoney(self.r["plan"]["taxAfter"], 3959.50)
        self.assertMoney(self.r["optimised"]["taxPayable"], 3959.50)
        self.assertEqual(self.r["plan"]["marginalRateAfter"], 0.115)

    def test_tax_saved_and_rate(self):
        self.assertMoney(self.r["plan"]["taxSaved"], 2679.50)
        self.assertAlmostEqual(self.r["plan"]["savingRate"], 0.115, places=12)

    def test_unrealised_saving(self):
        self.assertMoney(self.r["plan"]["unrealisedSaving"], 2359.50)

    def test_ladder(self):
        self.assertEqual(len(self.r["ladder"]), 1)
        tier = self.r["ladder"][0]
        self.assertEqual(tier["fromContribution"], 0)
        self.assertEqual(tier["toContribution"], 23300)
        self.assertEqual(tier["amount"], 23300)
        self.assertEqual(tier["rate"], 0.115)
        self.assertMoney(tier["taxSaved"], 2679.50)
        self.assertMoney(tier["cumulativeTaxSaved"], 2679.50)
        self.assertEqual(tier["usedByPlan"], 23300)
        self.assertNotIn("zeroReason", tier)

    def test_monthly_plan(self):
        mp = self.r["monthlyPlan"]
        self.assertEqual(mp["deadline"], "2026-12-31")
        self.assertEqual(mp["daysToDeadline"], 48)  # 17 days left in November + 31
        self.assertEqual(mp["monthsRemaining"], 2)
        self.assertEqual(mp["schedule"], [
            {"month": "2026-11", "amounts": {"srs": 7650, "cpfSelf": 4000, "cpfFamily": 0}, "total": 11650},
            {"month": "2026-12", "amounts": {"srs": 7650, "cpfSelf": 4000, "cpfFamily": 0}, "total": 11650},
        ])
        # ceil(15,300 / 12) = 1,275; ceil(8,000 / 12) = 667
        self.assertEqual(mp["fullYearMonthly"], {"srs": 1275, "cpfSelf": 667, "cpfFamily": 0, "total": 1942})

    def test_simulator(self):
        sim = self.r["simulator"]
        self.assertEqual(len(sim), 25)  # i = 0 .. ceil(23,300 / 1,000) = 24
        self.assertEqual([row["contribution"] for row in sim], [i * 1000 for i in range(24)] + [23300])
        self.assertEqual(sim[0]["stepSaving"], 0)
        self.assertEqual(sim[0]["stepRate"], 0)
        self.assertMoney(sim[1]["taxSaved"], 115.00)
        self.assertMoney(sim[1]["stepSaving"], 115.00)
        self.assertAlmostEqual(sim[1]["stepRate"], 0.115, places=12)
        self.assertEqual(sim[16]["split"], {"srs": 15300, "cpfSelf": 700, "cpfFamily": 0})
        self.assertMoney(sim[24]["taxPayable"], 3959.50)
        self.assertMoney(sim[24]["stepSaving"], 34.50)  # 11.5% x the last 300
        self.assertAlmostEqual(sim[24]["stepRate"], 0.115, places=12)
        self.assertTrue(all(row["withinPlan"] for row in sim))

    def test_scenarios(self):
        self.assertEqual([s["id"] for s in self.r["scenarios"]],
                         ["none", "srsOnly", "cpfSelfOnly", "srsPlusCpfSelf", "maxAll", "recommended"])
        self.assertMoney(scenario(self.r, "none")["taxPayable"], 6639.00)
        # 93,300 -> 3,350 + 11.5% x 13,300 = 4,879.50
        self.assertMoney(scenario(self.r, "srsOnly")["taxPayable"], 4879.50)
        self.assertMoney(scenario(self.r, "srsOnly")["taxSaved"], 1759.50)
        # 100,600 -> 3,350 + 11.5% x 20,600 = 5,719.00
        self.assertMoney(scenario(self.r, "cpfSelfOnly")["taxPayable"], 5719.00)
        self.assertMoney(scenario(self.r, "cpfSelfOnly")["taxSaved"], 920.00)
        for sid in ("srsPlusCpfSelf", "maxAll", "recommended"):
            s = scenario(self.r, sid)
            self.assertEqual(s["totalContribution"], 23300)
            self.assertMoney(s["taxSaved"], 2679.50)
            self.assertEqual(s["wastedContribution"], 0)

    def test_warnings(self):
        self.assertEqual(self.r["warnings"], [{"code": "LEVER_LIMITS_PLAN", "severity": "info"}])

    def test_default_input_is_the_same_example(self):
        self.assertEqual(ref.plan(ref.default_input(TODAY)), self.r)

    def test_result_shape(self):
        self.assertEqual(list(self.r.keys()), ["cpf", "baseline", "optimised", "levers", "reliefCapRoom", "plan",
                                               "ladder", "simulator", "scenarios", "monthlyPlan", "warnings"])
        json.dumps(self.r, allow_nan=False)


# ---------------------------------------------------------------------------
# Appendix A.2
# ---------------------------------------------------------------------------

def a2b_input():
    """Appendix A.2b: the A.2 person with the CPF (self) room left blank."""
    return make({
        "profile.residency": "pr",
        "profile.prYear": 3,
        "profile.ageAtYearEnd": 57,
        "profile.birthMonth": 6,
        "income.monthlyOrdinaryWage": 14000,
        "income.additionalWages": 40000,
        "otherReliefs": 30000,
        "existing.srs": 5000,
        "levers.cpfFamily.enabled": True,
        "levers.cpfFamily.maxAmount": 8000,
        "preferences.cashBudget": 20000,
        "preferences.minSavingRate": 0,
        "preferences.priority": ["cpfSelf", "srs", "cpfFamily"],
    })


def a2_input():
    """Appendix A.2: at 57 the room must be entered (SPEC 6.5) - roomToLimit 50,000."""
    inp = a2b_input()
    inp["levers"]["cpfSelf"]["roomToLimit"] = 50000
    return inp


class AppendixA2(MoneyAssertions):
    @classmethod
    def setUpClass(cls):
        cls.r = ref.plan(a2_input())

    def test_cpf_band(self):
        self.assertEqual(self.r["cpf"]["monthlyEmployeeRates"], [0.18] * 12)

    def test_cpf_relief(self):
        cpf = self.r["cpf"]
        self.assertEqual(cpf["ordinaryWagesSubject"], 96000)
        self.assertEqual(cpf["additionalWageCeiling"], 6000)
        self.assertEqual(cpf["additionalWagesSubject"], 6000)
        self.assertEqual(cpf["employeeContribution"], 18360)  # 1,440 x 12 + 1,080
        self.assertEqual(cpf["employerContribution"], 16320)  # 16% x 102,000

    def test_employment_income(self):
        self.assertEqual(self.r["baseline"]["employmentIncome"], 208000)

    def test_reliefs_before_cap(self):
        reliefs = self.r["baseline"]["reliefs"]
        self.assertEqual(reliefs["earnedIncome"], 6000)
        self.assertEqual(reliefs["cpf"], 18360)
        self.assertEqual(reliefs["srs"], 5000)
        self.assertEqual(reliefs["other"], 30000)
        self.assertEqual(reliefs["totalBeforeCap"], 59360)

    def test_chargeable_income_and_tax(self):
        self.assertEqual(self.r["baseline"]["chargeableIncome"], 148640)
        self.assertMoney(self.r["baseline"]["taxPayable"], 12246.00)
        self.assertEqual(self.r["baseline"]["marginalRate"], 0.15)

    def test_lever_rooms(self):
        lev = self.r["levers"]
        self.assertEqual(lev["srs"]["used"], 5000)
        self.assertEqual(lev["srs"]["room"], 10300)
        self.assertEqual(lev["cpfSelf"]["room"], 8000)      # min(8,000 cap, the 50,000 entered)
        self.assertEqual(lev["cpfFamily"]["room"], 8000)
        self.assertEqual(sum(lev[k]["room"] for k in ref.LEVER_IDS), 26300)   # L

    def test_u_c_l_b_and_binding(self):
        self.assertEqual(self.r["reliefCapRoom"], 20640)
        self.assertEqual(self.r["plan"]["totalContribution"], 20000)
        self.assertEqual(self.r["plan"]["bindingConstraint"], "cashBudget")

    def test_plan_split(self):
        self.assertEqual(self.r["plan"]["contributions"], {"cpfSelf": 8000, "srs": 10300, "cpfFamily": 1700})

    def test_tax_after(self):
        self.assertEqual(self.r["plan"]["chargeableIncomeAfter"], 128640)
        self.assertMoney(self.r["plan"]["taxAfter"], 9246.00)
        self.assertMoney(self.r["plan"]["taxSaved"], 3000.00)
        self.assertAlmostEqual(self.r["plan"]["savingRate"], 0.15, places=12)

    def test_unrealised_saving(self):
        self.assertMoney(self.r["plan"]["unrealisedSaving"], 96.00)

    def test_ladder(self):
        ladder = self.r["ladder"]
        self.assertEqual(len(ladder), 2)
        first, second = ladder
        self.assertEqual((first["fromContribution"], first["toContribution"], first["amount"]), (0, 20640, 20640))
        self.assertEqual(first["rate"], 0.15)
        self.assertMoney(first["taxSaved"], 3096.00)
        self.assertMoney(first["cumulativeTaxSaved"], 3096.00)
        self.assertEqual(first["usedByPlan"], 20000)
        self.assertNotIn("zeroReason", first)
        self.assertEqual((second["fromContribution"], second["toContribution"], second["amount"]), (20640, 26300, 5660))
        self.assertEqual(second["rate"], 0)
        self.assertEqual(second["zeroReason"], "reliefCap")
        self.assertMoney(second["taxSaved"], 0)
        self.assertMoney(second["cumulativeTaxSaved"], 3096.00)
        self.assertEqual(second["usedByPlan"], 0)

    def test_scenario_max_all(self):
        s = scenario(self.r, "maxAll")
        self.assertEqual(s["contributions"], {"srs": 10300, "cpfSelf": 8000, "cpfFamily": 8000})
        self.assertEqual(s["totalContribution"], 26300)
        self.assertMoney(s["taxSaved"], 3096.00)
        self.assertEqual(s["wastedContribution"], 5660)
        self.assertAlmostEqual(s["savingRate"], 3096.0 / 26300, places=12)

    def test_other_scenarios(self):
        # 148,640 - 10,300 = 138,340 -> 7,950 + 15% x 18,340 = 10,701.00
        self.assertMoney(scenario(self.r, "srsOnly")["taxPayable"], 10701.00)
        self.assertMoney(scenario(self.r, "cpfSelfOnly")["taxSaved"], 1200.00)
        self.assertMoney(scenario(self.r, "srsPlusCpfSelf")["taxSaved"], 2745.00)
        self.assertEqual(scenario(self.r, "srsPlusCpfSelf")["wastedContribution"], 0)
        rec = scenario(self.r, "recommended")
        self.assertEqual(rec["totalContribution"], 20000)
        self.assertMoney(rec["taxSaved"], 3000.00)
        self.assertEqual(rec["wastedContribution"], 0)

    def test_monthly_schedule(self):
        self.assertEqual(self.r["monthlyPlan"]["schedule"], [
            {"month": "2026-11", "amounts": {"srs": 5150, "cpfSelf": 4000, "cpfFamily": 850}, "total": 10000},
            {"month": "2026-12", "amounts": {"srs": 5150, "cpfSelf": 4000, "cpfFamily": 850}, "total": 10000},
        ])

    def test_warnings(self):
        # "Warnings (in order)": BUDGET_LIMITS_PLAN, AGE_55_PLUS_TOPUP, FAMILY_TOPUP_CHECKS
        self.assertEqual(self.r["warnings"], [
            {"code": "BUDGET_LIMITS_PLAN", "severity": "info"},
            {"code": "AGE_55_PLUS_TOPUP", "severity": "info"},
            {"code": "FAMILY_TOPUP_CHECKS", "severity": "caution"},
        ])


# ---------------------------------------------------------------------------
# Appendix A.2b - the same person with the CPF room left blank
# ---------------------------------------------------------------------------

class AppendixA2b(MoneyAssertions):
    @classmethod
    def setUpClass(cls):
        cls.r = ref.plan(a2b_input())

    def test_the_baseline_is_that_of_a2(self):
        a2 = ref.plan(a2_input())
        self.assertEqual(self.r["cpf"], a2["cpf"])
        self.assertEqual(self.r["baseline"], a2["baseline"])
        self.assertEqual(self.r["cpf"]["employeeContribution"], 18360)
        self.assertEqual(self.r["baseline"]["reliefs"]["totalBeforeCap"], 59360)
        self.assertEqual(self.r["baseline"]["chargeableIncome"], 148640)
        self.assertMoney(self.r["baseline"]["taxPayable"], 12246.00)
        self.assertEqual(self.r["reliefCapRoom"], 20640)

    def test_cpf_self_room_is_zero(self):
        lev = self.r["levers"]
        self.assertEqual(lev["cpfSelf"], {"statutoryCap": 8000, "used": 0, "room": 0, "eligible": True, "enabled": True})
        self.assertEqual(lev["srs"]["room"], 10300)
        self.assertEqual(lev["cpfFamily"]["room"], 8000)
        self.assertEqual(sum(lev[k]["room"] for k in ref.LEVER_IDS), 18300)   # L = 10,300 + 0 + 8,000

    def test_x_and_binding(self):
        # X = min(U 128,640, C 20,640, L 18,300, B 20,000) = 18,300, binding leverLimits
        self.assertEqual(self.r["plan"]["totalContribution"], 18300)
        self.assertEqual(self.r["plan"]["bindingConstraint"], "leverLimits")

    def test_plan_split(self):
        self.assertEqual(self.r["plan"]["contributions"], {"srs": 10300, "cpfSelf": 0, "cpfFamily": 8000})

    def test_tax_after(self):
        plan = self.r["plan"]
        self.assertEqual(plan["chargeableIncomeAfter"], 130340)
        self.assertMoney(plan["taxBefore"], 12246.00)
        self.assertMoney(plan["taxAfter"], 9501.00)        # 7,950 + 15% x 10,340
        self.assertMoney(plan["taxSaved"], 2745.00)
        self.assertAlmostEqual(plan["savingRate"], 0.15, places=12)
        self.assertEqual(plan["marginalRateBefore"], 0.15)
        self.assertEqual(plan["marginalRateAfter"], 0.15)
        opt = self.r["optimised"]["reliefs"]
        self.assertEqual((opt["srs"], opt["cpfTopUpSelf"], opt["cpfTopUpFamily"]), (15300, 0, 8000))
        self.assertEqual(opt["totalBeforeCap"], 59360 + 18300)

    def test_unrealised_saving(self):
        # N(X) - N(min(U, C)) = tax(130,340) - tax(148,640 - 20,640 = 128,000) = 9,501.00 - 9,150.00
        self.assertMoney(self.r["plan"]["unrealisedSaving"], 351.00)

    def test_ladder(self):
        # L = 18,300 is inside the relief-cap room (20,640) and inside the 15% bracket: one tier.
        self.assertEqual(len(self.r["ladder"]), 1)
        tier = self.r["ladder"][0]
        self.assertEqual((tier["fromContribution"], tier["toContribution"], tier["amount"]), (0, 18300, 18300))
        self.assertEqual(tier["rate"], 0.15)
        self.assertMoney(tier["taxSaved"], 2745.00)
        self.assertMoney(tier["cumulativeTaxSaved"], 2745.00)
        self.assertEqual(tier["usedByPlan"], 18300)
        self.assertNotIn("zeroReason", tier)

    def test_simulator(self):
        sim = self.r["simulator"]
        self.assertEqual([row["contribution"] for row in sim], [i * 1000 for i in range(19)] + [18300])
        # priority cpfSelf -> srs -> cpfFamily, with nothing for cpfSelf at any step
        self.assertTrue(all(row["split"]["cpfSelf"] == 0 for row in sim))
        self.assertEqual(sim[10]["split"], {"srs": 10000, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual(sim[11]["split"], {"srs": 10300, "cpfSelf": 0, "cpfFamily": 700})
        self.assertEqual(sim[19]["split"], {"srs": 10300, "cpfSelf": 0, "cpfFamily": 8000})
        self.assertMoney(sim[1]["taxSaved"], 150.00)
        self.assertMoney(sim[19]["taxSaved"], 2745.00)
        self.assertMoney(sim[19]["stepSaving"], 45.00)     # 15% x the last 300
        self.assertTrue(all(row["withinPlan"] for row in sim))

    def test_scenarios(self):
        # roomIfEnabled(cpfSelf) = 0, so "CPF only" has nothing in it and "SRS + CPF" is SRS alone.
        own = scenario(self.r, "cpfSelfOnly")
        self.assertEqual(own["contributions"], {"srs": 0, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual(own["totalContribution"], 0)
        self.assertMoney(own["taxPayable"], 12246.00)
        self.assertMoney(own["taxSaved"], 0)
        self.assertEqual(own["savingRate"], 0)
        self.assertEqual(own["wastedContribution"], 0)
        # 148,640 - 10,300 = 138,340 -> 7,950 + 15% x 18,340 = 10,701.00
        for sid in ("srsOnly", "srsPlusCpfSelf"):
            s = scenario(self.r, sid)
            self.assertEqual(s["contributions"], {"srs": 10300, "cpfSelf": 0, "cpfFamily": 0}, sid)
            self.assertMoney(s["taxPayable"], 10701.00, sid)
            self.assertMoney(s["taxSaved"], 1545.00, sid)
            self.assertEqual(s["wastedContribution"], 0, sid)
        for sid in ("maxAll", "recommended"):
            s = scenario(self.r, sid)
            self.assertEqual(s["contributions"], {"srs": 10300, "cpfSelf": 0, "cpfFamily": 8000}, sid)
            self.assertEqual(s["totalContribution"], 18300, sid)
            self.assertMoney(s["taxSaved"], 2745.00, sid)
            self.assertEqual(s["wastedContribution"], 0, sid)     # 18,300 is within U(0) and C

    def test_monthly_plan(self):
        mp = self.r["monthlyPlan"]
        self.assertEqual(mp["schedule"], [
            {"month": "2026-11", "amounts": {"srs": 5150, "cpfSelf": 0, "cpfFamily": 4000}, "total": 9150},
            {"month": "2026-12", "amounts": {"srs": 5150, "cpfSelf": 0, "cpfFamily": 4000}, "total": 9150},
        ])
        # ceil(10,300 / 12) = 859; ceil(8,000 / 12) = 667
        self.assertEqual(mp["fullYearMonthly"], {"srs": 859, "cpfSelf": 0, "cpfFamily": 667, "total": 1526})

    def test_warnings(self):
        # "Warnings (in order)": LEVER_LIMITS_PLAN, CPF_SELF_ROOM_UNCONFIRMED, FAMILY_TOPUP_CHECKS
        self.assertEqual(self.r["warnings"], [
            {"code": "LEVER_LIMITS_PLAN", "severity": "info"},
            {"code": "CPF_SELF_ROOM_UNCONFIRMED", "severity": "caution"},
            {"code": "FAMILY_TOPUP_CHECKS", "severity": "caution"},
        ])

    def test_explicit_null_is_the_same_as_missing(self):
        inp = a2b_input()
        inp["levers"]["cpfSelf"]["roomToLimit"] = None
        self.assertEqual(ref.plan(inp), self.r)


# ---------------------------------------------------------------------------
# Appendix A.3
# ---------------------------------------------------------------------------

def a3_input(min_rate):
    return make({
        "profile.ageAtYearEnd": 28,
        "income.monthlyOrdinaryWage": 3500,
        "income.additionalWages": 3500,
        "otherReliefs": 0,
        "preferences.minSavingRate": min_rate,
    })


class AppendixA3(MoneyAssertions):
    @classmethod
    def setUpClass(cls):
        cls.r7 = ref.plan(a3_input(0.07))
        cls.r0 = ref.plan(a3_input(0))

    def test_cpf_and_reliefs(self):
        for r in (self.r7, self.r0):
            self.assertEqual(r["cpf"]["employeeContribution"], 9100)  # 700 x 12 + 700
            self.assertEqual(r["baseline"]["reliefs"]["earnedIncome"], 1000)
            self.assertEqual(r["baseline"]["reliefs"]["totalBeforeCap"], 10100)

    def test_chargeable_income_and_tax(self):
        for r in (self.r7, self.r0):
            self.assertEqual(r["baseline"]["employmentIncome"], 45500)
            self.assertEqual(r["baseline"]["chargeableIncome"], 35400)
            self.assertMoney(r["baseline"]["taxPayable"], 389.00)
            self.assertEqual(r["baseline"]["marginalRate"], 0.035)

    def test_min_rate_7_percent_recommends_nothing(self):
        plan = self.r7["plan"]
        self.assertEqual(plan["totalContribution"], 0)
        self.assertEqual(plan["contributions"], {"srs": 0, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual(plan["bindingConstraint"], "usefulRoom")
        self.assertMoney(plan["taxSaved"], 0)
        self.assertEqual(plan["savingRate"], 0)
        self.assertMoney(plan["unrealisedSaving"], 0)
        self.assertEqual(self.r7["warnings"], [{"code": "BELOW_MIN_SAVING_RATE", "severity": "info"}])
        self.assertEqual(self.r7["monthlyPlan"]["schedule"], [])

    def test_min_rate_0(self):
        plan = self.r0["plan"]
        self.assertEqual(plan["totalContribution"], 15400)
        self.assertEqual(plan["contributions"], {"srs": 15300, "cpfSelf": 100, "cpfFamily": 0})
        self.assertMoney(plan["taxAfter"], 0.00)
        self.assertMoney(plan["taxSaved"], 389.00)
        self.assertAlmostEqual(plan["savingRate"], 389.0 / 15400, places=12)
        self.assertEqual(round(plan["savingRate"] * 100, 2), 2.53)
        self.assertEqual(plan["bindingConstraint"], "usefulRoom")
        self.assertEqual(plan["chargeableIncomeAfter"], 20000)
        self.assertEqual(plan["marginalRateAfter"], 0)
        self.assertEqual(self.r0["warnings"], [])

    def test_ladder_crosses_brackets_down_to_the_tax_free_band(self):
        # L = 23,300, C = 69,900.  35,400 -> 30,000 at 3.5%, -> 20,000 at 2%, then tax-free.
        for r, used in ((self.r7, [0, 0, 0]), (self.r0, [5400, 10000, 0])):
            ladder = r["ladder"]
            self.assertEqual([(t["fromContribution"], t["toContribution"]) for t in ladder],
                             [(0, 5400), (5400, 15400), (15400, 23300)])
            self.assertEqual([t["rate"] for t in ladder], [0.035, 0.02, 0])
            self.assertMoney(ladder[0]["taxSaved"], 189.00)
            self.assertMoney(ladder[1]["taxSaved"], 200.00)
            self.assertMoney(ladder[2]["taxSaved"], 0)
            self.assertMoney(ladder[0]["cumulativeTaxSaved"], 189.00)
            self.assertMoney(ladder[1]["cumulativeTaxSaved"], 389.00)
            self.assertMoney(ladder[2]["cumulativeTaxSaved"], 389.00)
            self.assertEqual(ladder[2]["zeroReason"], "belowTaxThreshold")
            self.assertEqual([t["usedByPlan"] for t in ladder], used)

    def test_max_all_wastes_the_tax_free_dollars(self):
        s = scenario(self.r0, "maxAll")
        self.assertEqual(s["totalContribution"], 23300)
        self.assertMoney(s["taxSaved"], 389.00)
        self.assertEqual(s["wastedContribution"], 7900)  # 23,300 - usefulRoom(0) 15,400


# ---------------------------------------------------------------------------
# Appendix B
# ---------------------------------------------------------------------------

class AppendixB(MoneyAssertions):
    def test_iras_rate_table(self):
        expected = {
            20000: 0, 30000: 200, 40000: 550, 80000: 3350, 120000: 7950, 160000: 13950,
            200000: 21150, 240000: 28750, 280000: 36550, 320000: 44550, 500000: 84150,
            1000000: 199150, 1200000: 247150,
        }
        for year in (2025, 2026, 2027):
            rules = ref.get_rules(year)
            for ci, tax in expected.items():
                self.assertMoney(ref.gross_tax(ci, rules), tax, "CI %d in %d" % (ci, year))

    def test_iras_sample_mr_heng(self):
        r = ref.plan(make({
            "incomeYear": 2025,
            "today": "2025-11-13",
            "profile.ageAtYearEnd": 35,
            "income.monthlyOrdinaryWage": 4000,
            "income.additionalWages": 2000,
            "income.donations": 100,
            "otherReliefs": 4000,
        }))
        base = r["baseline"]
        self.assertEqual(base["employmentIncome"], 50000)
        self.assertEqual(r["cpf"]["employeeContribution"], 10000)
        self.assertEqual(base["donationDeduction"], 250)
        self.assertEqual(base["assessableIncome"], 49750)
        self.assertEqual(base["reliefs"]["totalBeforeCap"], 15000)
        self.assertEqual(base["reliefs"]["totalAllowed"], 15000)
        self.assertEqual(base["chargeableIncome"], 34750)
        self.assertMoney(base["taxPayable"], 366.25)

    def test_iras_sample_250k_earner(self):
        r = ref.plan(make({
            "incomeYear": 2025,
            "today": "2025-11-13",
            "profile.ageAtYearEnd": 67,   # above 65 to 70 all year, EIR 8,000
            "income.monthlyOrdinaryWage": 19000,
            "income.additionalWages": 22000,
            "income.donations": 100,
            "otherReliefs": 0,
        }))
        base = r["baseline"]
        self.assertEqual(base["employmentIncome"], 250000)
        self.assertEqual(r["cpf"]["monthlyEmployeeRates"], [0.075] * 12)
        self.assertEqual(r["cpf"]["employeeContribution"], 7650)  # 555 x 12 + 7.5% x 13,200
        self.assertEqual(base["reliefs"]["earnedIncome"], 8000)
        self.assertEqual(base["reliefs"]["totalBeforeCap"], 15650)
        self.assertEqual(base["chargeableIncome"], 234100)
        self.assertMoney(base["taxPayable"], 27629.00)

    def test_cpf_board_2026_table_maxima(self):
        for age, monthly in ((40, 1600), (58, 1440), (63, 1000)):
            for wage in (8000, 8001, 12500):
                cpf = ref.compute_cpf(make({
                    "profile.ageAtYearEnd": age,
                    "income.monthlyOrdinaryWage": wage,
                    "income.additionalWages": 0,
                }))
                self.assertEqual(cpf["employeeContribution"], monthly * 12, "age %d wage %d" % (age, wage))

    def test_cpf_board_aw_ceiling_example(self):
        cpf = ref.compute_cpf(make({"income.monthlyOrdinaryWage": 9000, "income.additionalWages": 50000}))
        self.assertEqual(cpf["ordinaryWagesSubject"], 96000)
        self.assertEqual(cpf["additionalWageCeiling"], 6000)
        self.assertEqual(cpf["additionalWagesSubject"], 6000)
        self.assertEqual(cpf["employeeContribution"], 20400)

    def test_cpf_board_2025(self):
        cpf = ref.compute_cpf(make({
            "incomeYear": 2025,
            "income.monthlyOrdinaryWage": 9000,
            "income.additionalWages": 20000,
        }))
        self.assertEqual(cpf["ordinaryWagesSubject"], 88800)      # 7,400 x 12
        self.assertEqual(cpf["additionalWageCeiling"], 13200)
        self.assertEqual(cpf["additionalWagesSubject"], 13200)
        self.assertEqual(cpf["employeeContribution"], 20400)      # 1,480 x 12 + 20% x 13,200

    def test_srs_withdrawal(self):
        rules = ref.get_rules(2026)
        self.assertMoney(ref.gross_tax(20000, rules), 0)
        self.assertEqual(ref.marginal_rate(20000, rules), 0)
        # The same thing through plan(): S$20,000 of taxable income and no employment.
        r = ref.plan(make({
            "profile.ageAtYearEnd": 64,
            "income.monthlyOrdinaryWage": 0,
            "income.additionalWages": 0,
            "income.otherTaxableIncome": 20000,
            "otherReliefs": 0,
        }))
        self.assertEqual(r["baseline"]["reliefs"]["earnedIncome"], 0)  # limited to earned income
        self.assertEqual(r["baseline"]["chargeableIncome"], 20000)
        self.assertMoney(r["baseline"]["taxPayable"], 0)
        self.assertIn("NO_TAX_PAYABLE", codes(r))
        self.assertEqual(r["plan"]["bindingConstraint"], "none")


# ---------------------------------------------------------------------------
# Tax table: second, independent transcription checked with decimal arithmetic
# ---------------------------------------------------------------------------

DECIMAL_TABLE = [  # (width of band, rate %) straight from SPEC 5.1
    ("20000", "0"), ("10000", "2"), ("10000", "3.5"), ("40000", "7"), ("40000", "11.5"),
    ("40000", "15"), ("40000", "18"), ("40000", "19"), ("40000", "19.5"), ("40000", "20"),
    ("180000", "22"), ("500000", "23"), (None, "24"),
]


def decimal_tax(ci):
    remaining = Decimal(ci)
    total = Decimal(0)
    for width, pct in DECIMAL_TABLE:
        portion = remaining if width is None else min(remaining, Decimal(width))
        total += portion * Decimal(pct) / Decimal(100)
        remaining -= portion
        if remaining <= 0:
            break
    return total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def decimal_marginal(ci):
    """Rate (as a float) on the last dollar of chargeable income."""
    if ci <= 0:
        return 0.0
    lower = 0
    for width, pct in DECIMAL_TABLE:
        if width is None or ci <= lower + int(width):
            return float(Decimal(pct) / Decimal(100))
        lower += int(width)
    raise AssertionError("unreachable")


class TaxTable(MoneyAssertions):
    def test_half_up_rounding_to_cents(self):
        rules = ref.get_rules(2026)
        self.assertMoney(ref.gross_tax(30001, rules), 200.04)      # 200.035 -> 200.04
        self.assertMoney(ref.gross_tax(80001, rules), 3350.12)     # 3,350.115 -> 3,350.12
        self.assertMoney(ref.gross_tax(240001, rules), 28750.20)   # 28,750.195 -> 28,750.20
        self.assertMoney(ref.gross_tax(30003, rules), 200.11)      # 200.105 -> 200.11
        self.assertMoney(ref.gross_tax(20001, rules), 0.02)

    def test_against_decimal_arithmetic(self):
        rules = ref.get_rules(2026)
        rng = random.Random(20261113)
        samples = [0, 1, 19999, 20000, 20001]
        lower = 0
        for width, _ in DECIMAL_TABLE[:-1]:
            lower += int(width)
            samples += [lower - 1, lower, lower + 1, lower + 3]
        samples += [rng.randrange(0, 1500000) for _ in range(3000)]
        for ci in samples:
            self.assertEqual(Decimal(str(ref.gross_tax(ci, rules))).quantize(Decimal("0.01")), decimal_tax(ci), ci)
            self.assertEqual(ref.marginal_rate(ci, rules), decimal_marginal(ci), ci)

    def test_marginal_rate_at_bracket_edges(self):
        rules = ref.get_rules(2026)
        self.assertEqual(ref.marginal_rate(0, rules), 0)
        self.assertEqual(ref.marginal_rate(20000, rules), 0)
        self.assertEqual(ref.marginal_rate(20001, rules), 0.02)
        self.assertEqual(ref.marginal_rate(40000, rules), 0.035)
        self.assertEqual(ref.marginal_rate(40001, rules), 0.07)
        self.assertEqual(ref.marginal_rate(1000000, rules), 0.23)
        self.assertEqual(ref.marginal_rate(1000001, rules), 0.24)

    def test_rules_per_year(self):
        self.assertEqual(ref.SUPPORTED_INCOME_YEARS, (2025, 2026, 2027))
        self.assertEqual([ref.get_rules(y)["status"] for y in (2025, 2026, 2027)], ["final", "final", "projected"])
        self.assertEqual([ref.get_rules(y)["cpf"]["owCeilingMonthly"] for y in (2025, 2026, 2027)], [7400, 8000, 8000])
        for y in (2025, 2026, 2027):
            rules = ref.get_rules(y)
            self.assertEqual(rules["ya"], y + 1)
            self.assertIsNone(rules["pitRebate"])
            self.assertEqual(rules["personalReliefCap"], 80000)
            self.assertEqual(rules["cpf"]["annualWageCeiling"], 102000)
            self.assertEqual(rules["contributionDeadline"], "%d-12-31" % y)
            self.assertEqual(rules["srs"], {"capCitizenPr": 15300, "capForeigner": 35700, "minAge": 18})
            # SPEC 5.4: matched part of a top-up (no relief) and the payout eligibility age
            self.assertEqual(rules["cpfTopUp"]["matchedTopUps"]["retirementAnnualCap"], 2000)
            self.assertEqual(rules["cpfTopUp"]["payoutEligibilityAge"], 65)
        self.assertEqual([ref.get_rules(y)["cpfTopUp"]["matchedTopUps"]["mediSaveAnnualCap"] for y in (2025, 2026, 2027)],
                         [None, 1000, 1000])
        self.assertEqual([ref.get_rules(y)["cpfTopUp"]["fullRetirementSum"] for y in (2025, 2026, 2027)],
                         [213000, 220400, 228200])
        self.assertEqual([ref.get_rules(y)["cpfTopUp"]["enhancedRetirementSum"] for y in (2025, 2026, 2027)],
                         [426000, 440800, 456400])
        with self.assertRaises(ref.UnsupportedIncomeYear):
            ref.get_rules(2024)
        with self.assertRaises(ref.UnsupportedIncomeYear):
            ref.get_rules(2028)


# ---------------------------------------------------------------------------
# CPF edge cases (SPEC 5.3 / 6.1)
# ---------------------------------------------------------------------------

class CpfEdgeCases(MoneyAssertions):
    def cpf(self, changes):
        return ref.compute_cpf(make(changes))

    def test_age_band_switch_mid_year(self):
        # Turns 55 in June 2026: 20% for Jan-Jun, 18% from July; bonus at December's rate.
        cpf = self.cpf({
            "profile.ageAtYearEnd": 55, "profile.birthMonth": 6,
            "income.monthlyOrdinaryWage": 6000, "income.additionalWages": 10000,
        })
        self.assertEqual(cpf["monthlyEmployeeRates"], [0.2] * 6 + [0.18] * 6)
        self.assertEqual(cpf["ordinaryWagesSubject"], 72000)
        self.assertEqual(cpf["additionalWageCeiling"], 30000)
        self.assertEqual(cpf["additionalWagesSubject"], 10000)
        # 1,200 x 6 + 1,080 x 6 + 18% x 10,000
        self.assertEqual(cpf["employeeContribution"], 7200 + 6480 + 1800)
        # 17% x 6,000 x 6 + 16% x 6,000 x 6 + 16% x 10,000
        self.assertEqual(cpf["employerContribution"], 6120 + 5760 + 1600)

    def test_birthday_in_december_changes_nothing_this_year(self):
        cpf = self.cpf({"profile.ageAtYearEnd": 55, "profile.birthMonth": 12,
                        "income.monthlyOrdinaryWage": 6000, "income.additionalWages": 10000})
        self.assertEqual(cpf["monthlyEmployeeRates"], [0.2] * 12)
        self.assertEqual(cpf["employeeContribution"], 1200 * 12 + 2000)
        # default birth month is 12
        inp = make({"profile.ageAtYearEnd": 55, "income.monthlyOrdinaryWage": 6000, "income.additionalWages": 10000})
        self.assertEqual(ref.compute_cpf(inp), cpf)

    def test_birthday_in_january(self):
        # Turned 55 in January: 20% for January only, 18% from February.
        cpf = self.cpf({"profile.ageAtYearEnd": 55, "profile.birthMonth": 1,
                        "income.monthlyOrdinaryWage": 6000, "income.additionalWages": 0})
        self.assertEqual(cpf["monthlyEmployeeRates"], [0.2] + [0.18] * 11)
        self.assertEqual(cpf["employeeContribution"], 1200 + 1080 * 11)

    def test_year_after_55th_birthday_is_the_older_band_all_year(self):
        cpf = self.cpf({"profile.ageAtYearEnd": 56, "profile.birthMonth": 12,
                        "income.monthlyOrdinaryWage": 6000, "income.additionalWages": 0})
        self.assertEqual(cpf["monthlyEmployeeRates"], [0.18] * 12)

    def test_switch_at_60_in_2027(self):
        # 2027: 19% up to the month of the 60th birthday (March), 13% after.
        cpf = self.cpf({"incomeYear": 2027, "profile.ageAtYearEnd": 60, "profile.birthMonth": 3,
                        "income.monthlyOrdinaryWage": 5000, "income.additionalWages": 0})
        self.assertEqual(cpf["monthlyEmployeeRates"], [0.19] * 3 + [0.13] * 9)
        self.assertEqual(cpf["employeeContribution"], 950 * 3 + 650 * 9)
        self.assertEqual(cpf["employerContribution"], round(0.165 * 5000 * 3 + 0.13 * 5000 * 9))

    def test_switch_at_65_in_2025_with_the_2025_ceiling(self):
        cpf = self.cpf({"incomeYear": 2025, "profile.ageAtYearEnd": 65, "profile.birthMonth": 1,
                        "income.monthlyOrdinaryWage": 9000, "income.additionalWages": 0})
        self.assertEqual(cpf["monthlyEmployeeRates"], [0.115] + [0.075] * 11)
        # 11.5% x 7,400 = 851; 7.5% x 7,400 = 555
        self.assertEqual(cpf["employeeContribution"], 851 + 555 * 11)

    def test_switch_at_70(self):
        cpf = self.cpf({"profile.ageAtYearEnd": 70, "profile.birthMonth": 9,
                        "income.monthlyOrdinaryWage": 4000, "income.additionalWages": 0})
        self.assertEqual(cpf["monthlyEmployeeRates"], [0.075] * 9 + [0.05] * 3)
        self.assertEqual(cpf["employeeContribution"], 300 * 9 + 200 * 3)

    def test_employee_share_drops_the_cents(self):
        # 12.5% x 3,333 = 416.625 -> 416 a month
        cpf = self.cpf({"profile.ageAtYearEnd": 62, "income.monthlyOrdinaryWage": 3333, "income.additionalWages": 0})
        self.assertEqual(cpf["employeeContribution"], 416 * 12)
        # bonus: 12.5% x 1,001 = 125.125 -> 125
        cpf = self.cpf({"profile.ageAtYearEnd": 62, "income.monthlyOrdinaryWage": 3333, "income.additionalWages": 1001})
        self.assertEqual(cpf["employeeContribution"], 416 * 12 + 125)

    def test_low_wage_phase_in(self):
        cases = {
            400: 0,      # up to 500: nil
            500: 0,
            501: 0,      # floor(0.6 x 1) = 0
            600: 60,     # 0.6 x 100
            749: 149,    # floor(0.6 x 249 = 149.4)
            750: 150,    # 0.6 x 250, meets 20% x 750
            751: 150,    # floor(20% x 751 = 150.2)
            1000: 200,
        }
        for wage, monthly in cases.items():
            cpf = self.cpf({"income.monthlyOrdinaryWage": wage, "income.additionalWages": 0})
            self.assertEqual(cpf["employeeContribution"], monthly * 12, wage)

    def test_phase_in_factor_follows_the_age_band(self):
        # 2026, above 55 to 60: factor = 3 x 18% = 0.54 -> floor(0.54 x 100) = 54
        cpf = self.cpf({"profile.ageAtYearEnd": 58, "income.monthlyOrdinaryWage": 600, "income.additionalWages": 0})
        self.assertEqual(cpf["employeeContribution"], 54 * 12)
        # 2026, above 60 to 65: factor 0.375 -> floor(0.375 x 249 = 93.375) = 93
        cpf = self.cpf({"profile.ageAtYearEnd": 63, "income.monthlyOrdinaryWage": 749, "income.additionalWages": 0})
        self.assertEqual(cpf["employeeContribution"], 93 * 12)

    def test_low_wage_bonus_still_attracts_the_full_rate(self):
        cpf = self.cpf({"income.monthlyOrdinaryWage": 400, "income.additionalWages": 1000})
        self.assertEqual(cpf["ordinaryWagesSubject"], 4800)
        self.assertEqual(cpf["additionalWageCeiling"], 97200)
        self.assertEqual(cpf["employeeContribution"], 200)
        self.assertEqual(cpf["monthlyEmployeeRates"], [0.2] * 12)

    def test_months_worked_are_the_last_months(self):
        r = ref.plan(make({"income.monthsWorked": 6}))
        cpf = r["cpf"]
        self.assertEqual(cpf["monthlyEmployeeRates"], [0] * 6 + [0.2] * 6)
        self.assertEqual(cpf["ordinaryWagesSubject"], 48000)
        self.assertEqual(cpf["additionalWageCeiling"], 54000)
        self.assertEqual(cpf["additionalWagesSubject"], 15000)
        self.assertEqual(cpf["employeeContribution"], 1600 * 6 + 3000)
        self.assertEqual(r["baseline"]["employmentIncome"], 75000)

    def test_months_worked_with_a_band_switch(self):
        # Worked Sep-Dec; turned 60 in October 2026: 18% in Sep-Oct, 12.5% in Nov-Dec.
        cpf = self.cpf({"profile.ageAtYearEnd": 60, "profile.birthMonth": 10, "income.monthsWorked": 4,
                        "income.monthlyOrdinaryWage": 4000, "income.additionalWages": 2000})
        self.assertEqual(cpf["monthlyEmployeeRates"], [0] * 8 + [0.18, 0.18, 0.125, 0.125])
        self.assertEqual(cpf["employeeContribution"], 720 * 2 + 500 * 2 + 250)

    def test_pr_first_year(self):
        r = ref.plan(make({"profile.residency": "pr", "profile.prYear": 1,
                           "income.monthlyOrdinaryWage": 5000, "income.additionalWages": 4000}))
        self.assertEqual(r["cpf"]["monthlyEmployeeRates"], [0.05] * 12)
        self.assertEqual(r["cpf"]["employeeContribution"], 250 * 12 + 200)
        self.assertIn({"code": "PR_GRADUATED_RATES", "severity": "info"}, r["warnings"])
        # 5% at every age
        for age in (30, 57, 63, 68, 75):
            cpf = self.cpf({"profile.residency": "pr", "profile.prYear": 1, "profile.ageAtYearEnd": age,
                            "income.monthlyOrdinaryWage": 5000, "income.additionalWages": 0})
            self.assertEqual(cpf["employeeContribution"], 3000, age)
        # phase-in factor 3 x 5% = 0.15 -> floor(0.15 x 100) = 15
        cpf = self.cpf({"profile.residency": "pr", "profile.prYear": 1,
                        "income.monthlyOrdinaryWage": 600, "income.additionalWages": 0})
        self.assertEqual(cpf["employeeContribution"], 15 * 12)

    def test_pr_second_year(self):
        expected = {30: 750, 58: 625, 63: 375, 68: 250, 75: 250}  # 15% / 12.5% / 7.5% / 5% / 5% of 5,000
        for age, monthly in expected.items():
            cpf = self.cpf({"profile.residency": "pr", "profile.prYear": 2, "profile.ageAtYearEnd": age,
                            "income.monthlyOrdinaryWage": 5000, "income.additionalWages": 0})
            self.assertEqual(cpf["employeeContribution"], monthly * 12, age)

    def test_pr_third_year_is_full_rates_without_warning(self):
        r = ref.plan(make({"profile.residency": "pr", "profile.prYear": 3}))
        self.assertEqual(r["cpf"]["employeeContribution"], 20400)
        self.assertNotIn("PR_GRADUATED_RATES", codes(r))
        # prYear is ignored for citizens
        r = ref.plan(make({"profile.residency": "citizen", "profile.prYear": 1}))
        self.assertEqual(r["cpf"]["employeeContribution"], 20400)
        self.assertNotIn("PR_GRADUATED_RATES", codes(r))

    def test_override(self):
        r = ref.plan(make({"income.employeeCpfOverride": 15000}))
        self.assertEqual(r["cpf"]["source"], "override")
        self.assertEqual(r["cpf"]["employeeContribution"], 15000)
        self.assertEqual(r["cpf"]["employerContribution"], 0)
        self.assertEqual(r["cpf"]["ordinaryWagesSubject"], 96000)   # breakdown still from the auto-calculation
        self.assertEqual(r["cpf"]["additionalWagesSubject"], 6000)
        self.assertEqual(r["cpf"]["monthlyEmployeeRates"], [0.2] * 12)
        # reliefs 1,000 + 15,000 + 5,000 -> CI 114,000 -> 3,350 + 11.5% x 34,000
        self.assertEqual(r["baseline"]["chargeableIncome"], 114000)
        self.assertMoney(r["baseline"]["taxPayable"], 7260.00)
        self.assertNotIn("CPF_OVERRIDE_ABOVE_MAX", codes(r))

    def test_override_above_maximum(self):
        r = ref.plan(make({"income.employeeCpfOverride": 25000}))
        self.assertEqual(r["cpf"]["source"], "override")
        self.assertEqual(r["cpf"]["employeeContribution"], 20400)
        self.assertIn({"code": "CPF_OVERRIDE_ABOVE_MAX", "severity": "caution"}, r["warnings"])
        r = ref.plan(make({"income.employeeCpfOverride": 20400}))
        self.assertNotIn("CPF_OVERRIDE_ABOVE_MAX", codes(r))

    def test_override_zero_and_null(self):
        r = ref.plan(make({"income.employeeCpfOverride": 0}))
        self.assertEqual(r["cpf"]["source"], "override")
        self.assertEqual(r["cpf"]["employeeContribution"], 0)
        r = ref.plan(make({"income.employeeCpfOverride": None}))
        self.assertEqual(r["cpf"]["source"], "auto")
        self.assertEqual(r["cpf"]["employeeContribution"], 20400)


# ---------------------------------------------------------------------------
# Optimiser, ladder, simulator, scenarios, warnings
# ---------------------------------------------------------------------------

def relief_cap_input(other_reliefs):
    return make({
        "profile.ageAtYearEnd": 40,
        "income.monthlyOrdinaryWage": 20000,
        "income.additionalWages": 0,
        "otherReliefs": other_reliefs,
    })


def foreigner_input(monthly):
    return make({
        "profile.residency": "foreigner",
        "profile.ageAtYearEnd": 40,
        "income.monthlyOrdinaryWage": monthly,
        "income.additionalWages": 0,
        "otherReliefs": 0,
    })


class PlanEdgeCases(MoneyAssertions):
    def test_relief_cap_binds(self):
        # 240,000 income; reliefs 1,000 + 19,200 + 55,000 = 75,200 -> C = 4,800; CI 164,800.
        r = ref.plan(relief_cap_input(55000))
        self.assertEqual(r["cpf"]["employeeContribution"], 19200)
        self.assertEqual(r["baseline"]["reliefs"]["totalBeforeCap"], 75200)
        self.assertEqual(r["baseline"]["chargeableIncome"], 164800)
        self.assertMoney(r["baseline"]["taxPayable"], 14814.00)   # 13,950 + 18% x 4,800
        self.assertEqual(r["reliefCapRoom"], 4800)
        plan = r["plan"]
        self.assertEqual(plan["totalContribution"], 4800)
        self.assertEqual(plan["contributions"], {"srs": 4800, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual(plan["bindingConstraint"], "reliefCap")
        self.assertEqual(plan["chargeableIncomeAfter"], 160000)
        self.assertMoney(plan["taxAfter"], 13950.00)
        self.assertMoney(plan["taxSaved"], 864.00)
        self.assertAlmostEqual(plan["savingRate"], 0.18, places=12)
        self.assertEqual(plan["marginalRateBefore"], 0.18)
        self.assertEqual(plan["marginalRateAfter"], 0.15)   # last dollar of 160,000 is in the 15% band
        self.assertMoney(plan["unrealisedSaving"], 0)
        self.assertEqual(r["optimised"]["reliefs"]["totalBeforeCap"], 80000)
        self.assertEqual(r["optimised"]["reliefs"]["lostToCap"], 0)
        self.assertEqual(codes(r), ["RELIEF_CAP_LIMITS_PLAN"])

        ladder = r["ladder"]
        self.assertEqual([(t["fromContribution"], t["toContribution"], t["rate"]) for t in ladder],
                         [(0, 4800, 0.18), (4800, 23300, 0)])
        self.assertMoney(ladder[0]["taxSaved"], 864.00)
        self.assertEqual(ladder[0]["usedByPlan"], 4800)
        self.assertEqual(ladder[1]["zeroReason"], "reliefCap")
        self.assertMoney(ladder[1]["cumulativeTaxSaved"], 864.00)

        s = scenario(r, "maxAll")
        self.assertEqual(s["totalContribution"], 23300)
        self.assertMoney(s["taxSaved"], 864.00)
        self.assertEqual(s["wastedContribution"], 18500)

        sim = r["simulator"]
        self.assertMoney(sim[4]["taxSaved"], 720.00)
        self.assertTrue(sim[4]["withinPlan"])
        self.assertMoney(sim[5]["taxSaved"], 864.00)
        self.assertMoney(sim[5]["stepSaving"], 144.00)
        self.assertAlmostEqual(sim[5]["stepRate"], 0.144, places=12)
        self.assertFalse(sim[5]["withinPlan"])
        self.assertMoney(sim[6]["stepSaving"], 0)
        self.assertMoney(sim[-1]["taxSaved"], 864.00)

    def test_baseline_already_over_the_relief_cap(self):
        # reliefs 1,000 + 19,200 + 70,000 = 90,200 -> 10,200 lost; CI 160,000.
        r = ref.plan(relief_cap_input(70000))
        reliefs = r["baseline"]["reliefs"]
        self.assertEqual(reliefs["totalBeforeCap"], 90200)
        self.assertEqual(reliefs["totalAllowed"], 80000)
        self.assertEqual(reliefs["lostToCap"], 10200)
        self.assertEqual(r["baseline"]["chargeableIncome"], 160000)
        self.assertMoney(r["baseline"]["taxPayable"], 13950.00)
        self.assertEqual(r["reliefCapRoom"], 0)
        self.assertEqual(r["plan"]["totalContribution"], 0)
        self.assertEqual(r["plan"]["bindingConstraint"], "reliefCap")
        self.assertEqual(codes(r), ["RELIEF_CAP_EXCEEDED_BASELINE", "RELIEF_CAP_LIMITS_PLAN"])
        self.assertEqual(len(r["ladder"]), 1)
        self.assertEqual(r["ladder"][0]["zeroReason"], "reliefCap")
        self.assertEqual(r["ladder"][0]["amount"], 23300)
        self.assertEqual(scenario(r, "maxAll")["wastedContribution"], 23300)
        self.assertMoney(scenario(r, "maxAll")["taxSaved"], 0)

    def test_foreigner(self):
        # 180,000 income, no CPF; EIR 1,000 -> CI 179,000 -> 13,950 + 18% x 19,000 = 17,370.
        r = ref.plan(make({
            "profile.residency": "foreigner", "profile.ageAtYearEnd": 40,
            "income.monthlyOrdinaryWage": 15000, "income.additionalWages": 0, "otherReliefs": 0,
            "income.employeeCpfOverride": 12345,     # ignored for foreigners
            "existing.cpfTopUpSelf": 3000,           # earns no relief: lever not eligible
        }))
        self.assertEqual(r["cpf"], {
            "source": "none", "ordinaryWagesSubject": 0, "additionalWageCeiling": 0, "additionalWagesSubject": 0,
            "employeeContribution": 0, "employerContribution": 0, "monthlyEmployeeRates": [0] * 12,
        })
        self.assertEqual(r["baseline"]["reliefs"]["cpf"], 0)
        self.assertEqual(r["baseline"]["reliefs"]["cpfTopUpSelf"], 0)
        self.assertEqual(r["baseline"]["reliefs"]["totalBeforeCap"], 1000)
        self.assertEqual(r["baseline"]["chargeableIncome"], 179000)
        self.assertMoney(r["baseline"]["taxPayable"], 17370.00)
        lev = r["levers"]
        self.assertEqual(lev["srs"], {"statutoryCap": 35700, "used": 0, "room": 35700, "eligible": True, "enabled": True})
        self.assertEqual(lev["cpfSelf"], {"statutoryCap": 0, "used": 0, "room": 0, "eligible": False, "enabled": True})
        # SPEC 6.5: the family lever is for givers who are citizens or PRs only.
        self.assertEqual(lev["cpfFamily"], {"statutoryCap": 0, "used": 0, "room": 0, "eligible": False, "enabled": False})
        plan = r["plan"]
        self.assertEqual(plan["contributions"], {"srs": 35700, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual(plan["bindingConstraint"], "leverLimits")
        # CI after 143,300 -> 7,950 + 15% x 23,300 = 11,445; saved 18% x 19,000 + 15% x 16,700 = 5,925
        self.assertEqual(plan["chargeableIncomeAfter"], 143300)
        self.assertMoney(plan["taxAfter"], 11445.00)
        self.assertMoney(plan["taxSaved"], 5925.00)
        self.assertAlmostEqual(plan["savingRate"], 5925.0 / 35700, places=12)
        # min(U, C) = min(139,000, 79,000) -> CI 100,000 -> 3,350 + 11.5% x 20,000 = 5,650
        self.assertMoney(plan["unrealisedSaving"], 11445.00 - 5650.00)
        # table order; SRS is on for a foreigner of 40, who worked all 12 months
        self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN", "FOREIGNER_NO_CPF", "SRS_NON_RESIDENT_WITHDRAWAL"])
        # scenarios respect eligibility: cpfSelfOnly contributes nothing
        self.assertEqual(scenario(r, "cpfSelfOnly")["totalContribution"], 0)
        self.assertEqual(scenario(r, "srsPlusCpfSelf")["totalContribution"], 35700)
        ladder = r["ladder"]
        self.assertEqual([(t["fromContribution"], t["toContribution"], t["rate"]) for t in ladder],
                         [(0, 19000, 0.18), (19000, 35700, 0.15)])
        self.assertMoney(ladder[0]["taxSaved"], 3420.00)
        self.assertMoney(ladder[1]["taxSaved"], 2505.00)
        self.assertMoney(ladder[1]["cumulativeTaxSaved"], 5925.00)

    def test_foreigner_family_top_up_is_not_eligible(self):
        # SPEC 6.5: cpfFamily is eligible only when the residency is listed in
        # cpfTopUp.familyGiverResidency (citizens and PRs).  For a foreigner the statutory cap is 0,
        # so an existing family top-up earns no relief, raises no warning, and none is recommended.
        # 180,000 income, no CPF; EIR 1,000 -> CI 179,000 -> 13,950 + 18% x 19,000 = 17,370.
        r = ref.plan(make({
            "profile.residency": "foreigner", "profile.ageAtYearEnd": 40,
            "income.monthlyOrdinaryWage": 15000, "income.additionalWages": 0, "otherReliefs": 0,
            "levers.srs.enabled": False, "levers.cpfFamily.enabled": True,
            "existing.cpfTopUpFamily": 9000,       # even above the S$8,000 cap of a citizen: no warning
        }))
        self.assertEqual(r["baseline"]["reliefs"]["cpfTopUpFamily"], 0)
        self.assertEqual(r["baseline"]["reliefs"]["totalBeforeCap"], 1000)
        self.assertEqual(r["baseline"]["chargeableIncome"], 179000)
        self.assertMoney(r["baseline"]["taxPayable"], 17370.00)
        self.assertEqual(r["levers"]["cpfFamily"], {"statutoryCap": 0, "used": 0, "room": 0,
                                                    "eligible": False, "enabled": True})
        self.assertEqual(r["plan"]["contributions"], {"srs": 0, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual(r["plan"]["bindingConstraint"], "leverLimits")     # tax payable, L = 0
        self.assertMoney(r["plan"]["taxSaved"], 0)
        # SRS is off (no SRS caution) and the family lever is not open to a foreigner (no family caution)
        self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN", "FOREIGNER_NO_CPF"])
        self.assertEqual(scenario(r, "maxAll")["contributions"], {"srs": 35700, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual(r["ladder"], [])
        self.assertEqual(len(r["simulator"]), 1)

    def test_foreigner_family_lever_worked_example(self):
        # Foreigner, 35, S$10,000 x 12 + 15,000 bonus, no other reliefs, only the family lever on.
        # No CPF; EIR 1,000; CI 135,000 - 1,000 = 134,000; tax 7,950 + 15% x 14,000 = 10,050.00.
        inp = make({"profile.residency": "foreigner", "otherReliefs": 0,
                    "levers.srs.enabled": False, "levers.cpfSelf.enabled": False, "levers.cpfFamily.enabled": True})
        r = ref.plan(inp)
        self.assertEqual(r["baseline"]["chargeableIncome"], 134000)
        self.assertMoney(r["plan"]["taxBefore"], 10050.00)
        self.assertMoney(r["plan"]["taxAfter"], 10050.00)
        self.assertEqual(r["plan"]["totalContribution"], 0)
        self.assertEqual(r["levers"]["cpfFamily"], {"statutoryCap": 0, "used": 0, "room": 0,
                                                    "eligible": False, "enabled": True})
        # The same person with S$8,000 already given to family and the lever off: still no relief.
        inp = make({"profile.residency": "foreigner", "otherReliefs": 0, "existing.cpfTopUpFamily": 8000,
                    "levers.srs.enabled": False, "levers.cpfSelf.enabled": False})
        r = ref.plan(inp)
        self.assertEqual(r["baseline"]["reliefs"]["cpfTopUpFamily"], 0)
        self.assertEqual(r["baseline"]["chargeableIncome"], 134000)
        self.assertMoney(r["baseline"]["taxPayable"], 10050.00)

    def test_family_lever_is_open_to_citizens_and_prs(self):
        for residency in ("citizen", "pr"):
            r = ref.plan(make({"profile.residency": residency, "levers.cpfFamily.enabled": True,
                               "existing.cpfTopUpFamily": 1000}))
            self.assertEqual(r["levers"]["cpfFamily"], {"statutoryCap": 8000, "used": 1000, "room": 7000,
                                                        "eligible": True, "enabled": True}, residency)
            self.assertEqual(r["baseline"]["reliefs"]["cpfTopUpFamily"], 1000, residency)

    def test_top_bracket_only(self):
        # Foreigner on 171,000: CI 170,000.  minSavingRate 16% -> only the 18% band is worth it.
        inp = foreigner_input(14250)
        inp["preferences"]["minSavingRate"] = 0.16
        r = ref.plan(inp)
        self.assertEqual(r["baseline"]["chargeableIncome"], 170000)
        self.assertMoney(r["baseline"]["taxPayable"], 15750.00)
        self.assertEqual(r["plan"]["totalContribution"], 10000)
        self.assertEqual(r["plan"]["bindingConstraint"], "usefulRoom")
        self.assertMoney(r["plan"]["taxSaved"], 1800.00)
        self.assertMoney(r["plan"]["unrealisedSaving"], 0)
        self.assertEqual([t["usedByPlan"] for t in r["ladder"]], [10000, 0])
        self.assertEqual([(t["fromContribution"], t["toContribution"], t["rate"]) for t in r["ladder"]],
                         [(0, 10000, 0.18), (10000, 35700, 0.15)])
        self.assertMoney(r["ladder"][1]["taxSaved"], 3855.00)
        self.assertEqual(codes(r), ["FOREIGNER_NO_CPF", "SRS_NON_RESIDENT_WITHDRAWAL"])
        # exactly at the bracket rate the bracket still qualifies (rate >= r)
        inp["preferences"]["minSavingRate"] = 0.18
        self.assertEqual(ref.plan(inp)["plan"]["totalContribution"], 10000)
        inp["preferences"]["minSavingRate"] = 0.15
        self.assertEqual(ref.plan(inp)["plan"]["totalContribution"], 35700)
        # nothing saves 25 cents in the dollar at this income
        inp["preferences"]["minSavingRate"] = 0.25
        r = ref.plan(inp)
        self.assertEqual(r["plan"]["totalContribution"], 0)
        self.assertEqual(r["plan"]["bindingConstraint"], "usefulRoom")
        self.assertIn("BELOW_MIN_SAVING_RATE", codes(r))

    def test_budget_binding(self):
        r = ref.plan(make({"preferences.cashBudget": 10000}))
        plan = r["plan"]
        self.assertEqual(plan["contributions"], {"srs": 10000, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual(plan["bindingConstraint"], "cashBudget")
        # CI 98,600 -> 3,350 + 11.5% x 18,600 = 5,489.00
        self.assertMoney(plan["taxAfter"], 5489.00)
        self.assertMoney(plan["taxSaved"], 1150.00)
        self.assertMoney(plan["unrealisedSaving"], 3889.00)   # 5,489 - tax(55,000) 1,600
        self.assertEqual(codes(r), ["BUDGET_LIMITS_PLAN"])
        self.assertEqual(r["ladder"][0]["usedByPlan"], 10000)
        self.assertEqual([row["withinPlan"] for row in r["simulator"]], [True] * 11 + [False] * 14)
        # scenarios ignore the budget
        self.assertEqual(scenario(r, "maxAll")["totalContribution"], 23300)
        self.assertEqual(scenario(r, "recommended")["totalContribution"], 10000)

    def test_budget_of_zero(self):
        r = ref.plan(make({"preferences.cashBudget": 0}))
        self.assertEqual(r["plan"]["totalContribution"], 0)
        self.assertEqual(r["plan"]["bindingConstraint"], "cashBudget")
        self.assertMoney(r["plan"]["unrealisedSaving"], 6639.00 - 1600.00)
        self.assertEqual(codes(r), ["BUDGET_LIMITS_PLAN"])

    def test_budget_equal_to_lever_room_ties_to_lever_limits(self):
        r = ref.plan(make({"preferences.cashBudget": 23300}))
        self.assertEqual(r["plan"]["bindingConstraint"], "leverLimits")
        r = ref.plan(make({"preferences.cashBudget": 23299}))
        self.assertEqual(r["plan"]["bindingConstraint"], "cashBudget")
        self.assertEqual(r["plan"]["contributions"], {"srs": 15300, "cpfSelf": 7999, "cpfFamily": 0})

    def test_null_budget_means_no_limit(self):
        self.assertEqual(ref.plan(make({"preferences.cashBudget": None})), ref.plan(base_input()))

    def test_priority_orders(self):
        r = ref.plan(make({"preferences.cashBudget": 10000, "preferences.priority": ["cpfSelf", "srs", "cpfFamily"]}))
        self.assertEqual(r["plan"]["contributions"], {"srs": 2000, "cpfSelf": 8000, "cpfFamily": 0})
        r = ref.plan(make({"preferences.cashBudget": 10000, "levers.cpfFamily.enabled": True,
                           "preferences.priority": ["cpfFamily", "srs", "cpfSelf"]}))
        self.assertEqual(r["plan"]["contributions"], {"srs": 2000, "cpfSelf": 0, "cpfFamily": 8000})
        self.assertEqual(r["simulator"][9]["split"], {"srs": 1000, "cpfSelf": 0, "cpfFamily": 8000})

    def test_user_room_limits(self):
        r = ref.plan(make({"levers.cpfSelf.roomToLimit": 3000}))
        self.assertEqual(r["levers"]["cpfSelf"]["room"], 3000)
        self.assertEqual(r["plan"]["contributions"], {"srs": 15300, "cpfSelf": 3000, "cpfFamily": 0})
        self.assertEqual(scenario(r, "cpfSelfOnly")["totalContribution"], 3000)
        r = ref.plan(make({"levers.cpfFamily.enabled": True, "levers.cpfFamily.maxAmount": 2500}))
        self.assertEqual(r["levers"]["cpfFamily"]["room"], 2500)
        self.assertEqual(r["plan"]["totalContribution"], 15300 + 8000 + 2500)
        r = ref.plan(make({"levers.cpfSelf.roomToLimit": None, "levers.cpfFamily.maxAmount": None,
                           "levers.cpfFamily.enabled": True}))
        self.assertEqual(r["levers"]["cpfSelf"]["room"], 8000)
        self.assertEqual(r["levers"]["cpfFamily"]["room"], 8000)

    def test_existing_contributions_reduce_room(self):
        r = ref.plan(make({"existing.srs": 5300, "existing.cpfTopUpSelf": 8000}))
        self.assertEqual(r["levers"]["srs"], {"statutoryCap": 15300, "used": 5300, "room": 10000,
                                              "eligible": True, "enabled": True})
        self.assertEqual(r["levers"]["cpfSelf"]["room"], 0)
        self.assertEqual(r["baseline"]["reliefs"]["totalBeforeCap"], 26400 + 13300)
        self.assertEqual(r["plan"]["contributions"], {"srs": 10000, "cpfSelf": 0, "cpfFamily": 0})

    def test_existing_exceeds_cap(self):
        r = ref.plan(make({"existing.srs": 20000}))
        self.assertEqual(r["baseline"]["reliefs"]["srs"], 15300)
        self.assertEqual(r["levers"]["srs"]["used"], 15300)
        self.assertEqual(r["levers"]["srs"]["room"], 0)
        self.assertEqual(r["baseline"]["chargeableIncome"], 93300)
        self.assertMoney(r["baseline"]["taxPayable"], 4879.50)
        self.assertEqual(r["plan"]["contributions"], {"srs": 0, "cpfSelf": 8000, "cpfFamily": 0})
        self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN", "EXISTING_EXCEEDS_CAP"])
        self.assertIn({"code": "EXISTING_EXCEEDS_CAP", "severity": "caution"}, r["warnings"])
        # exactly at the cap is not "exceeds"
        self.assertNotIn("EXISTING_EXCEEDS_CAP", codes(ref.plan(make({"existing.srs": 15300}))))

    def test_under_18_cannot_use_srs(self):
        r = ref.plan(make({"profile.ageAtYearEnd": 17, "existing.srs": 500}))
        self.assertEqual(r["levers"]["srs"], {"statutoryCap": 0, "used": 0, "room": 0, "eligible": False, "enabled": True})
        self.assertEqual(r["baseline"]["reliefs"]["srs"], 0)
        self.assertEqual(r["plan"]["contributions"], {"srs": 0, "cpfSelf": 8000, "cpfFamily": 0})
        self.assertIn({"code": "SRS_UNDER_18", "severity": "caution"}, r["warnings"])
        self.assertNotIn("EXISTING_EXCEEDS_CAP", codes(r))   # the cap is zero
        self.assertEqual(scenario(r, "srsOnly")["totalContribution"], 0)
        self.assertNotIn("SRS_UNDER_18", codes(ref.plan(make({"profile.ageAtYearEnd": 18}))))

    def test_nothing_enabled(self):
        r = ref.plan(make({"levers.srs.enabled": False, "levers.cpfSelf.enabled": False}))
        self.assertEqual(r["plan"]["totalContribution"], 0)
        self.assertEqual(r["plan"]["bindingConstraint"], "leverLimits")
        self.assertMoney(r["plan"]["unrealisedSaving"], 6639.00 - 1600.00)
        self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN"])
        self.assertEqual(r["ladder"], [])
        self.assertEqual(len(r["simulator"]), 1)
        self.assertEqual(r["simulator"][0]["contribution"], 0)
        # scenarios ignore the enabled flags of SRS and CPF (self)
        self.assertEqual(scenario(r, "srsOnly")["totalContribution"], 15300)
        self.assertEqual(scenario(r, "srsPlusCpfSelf")["totalContribution"], 23300)
        self.assertEqual(scenario(r, "recommended")["totalContribution"], 0)

    def test_no_tax_payable(self):
        # 18,000 income; CPF 3,600; EIR 1,000 -> CI 13,400, no tax.
        r = ref.plan(make({"profile.ageAtYearEnd": 25, "income.monthlyOrdinaryWage": 1500,
                           "income.additionalWages": 0, "otherReliefs": 0, "preferences.minSavingRate": 0}))
        self.assertEqual(r["baseline"]["chargeableIncome"], 13400)
        self.assertMoney(r["baseline"]["taxPayable"], 0)
        self.assertEqual(r["baseline"]["marginalRate"], 0)
        self.assertEqual(r["baseline"]["effectiveRate"], 0)
        self.assertEqual(r["plan"]["totalContribution"], 0)
        self.assertEqual(r["plan"]["bindingConstraint"], "none")
        self.assertEqual(codes(r), ["NO_TAX_PAYABLE"])
        self.assertEqual(len(r["ladder"]), 1)
        self.assertEqual(r["ladder"][0]["zeroReason"], "belowTaxThreshold")
        self.assertEqual(r["ladder"][0]["toContribution"], 23300)
        self.assertEqual(scenario(r, "maxAll")["wastedContribution"], 23300)

    def test_earned_income_relief(self):
        for age, amount in ((54, 1000), (55, 6000), (59, 6000), (60, 8000), (75, 8000)):
            r = ref.plan(make({"profile.ageAtYearEnd": age}))
            self.assertEqual(r["baseline"]["reliefs"]["earnedIncome"], amount, age)
        # limited to earned income: bonus of 500 only
        r = ref.plan(make({"income.monthlyOrdinaryWage": 0, "income.additionalWages": 500, "otherReliefs": 0}))
        self.assertEqual(r["baseline"]["reliefs"]["earnedIncome"], 500)
        self.assertEqual(r["cpf"]["employeeContribution"], 100)
        # employment expenses larger than employment income
        r = ref.plan(make({"income.monthlyOrdinaryWage": 0, "income.additionalWages": 500,
                           "income.employmentExpenses": 800, "income.otherTaxableIncome": 50000, "otherReliefs": 0}))
        self.assertEqual(r["baseline"]["reliefs"]["earnedIncome"], 0)
        self.assertEqual(r["baseline"]["totalIncome"], 50000)
        self.assertEqual(r["baseline"]["employmentExpenses"], 800)
        self.assertEqual(r["baseline"]["chargeableIncome"], 49900)   # 50,000 - CPF relief 100

    def test_income_items(self):
        r = ref.plan(make({"income.otherTaxableIncome": 12000, "income.employmentExpenses": 2000,
                           "income.donations": 1000}))
        base = r["baseline"]
        self.assertEqual(base["employmentIncome"], 135000)
        self.assertEqual(base["employmentExpenses"], 2000)
        self.assertEqual(base["otherTaxableIncome"], 12000)
        self.assertEqual(base["totalIncome"], 145000)
        self.assertEqual(base["donationDeduction"], 2500)
        self.assertEqual(base["assessableIncome"], 142500)
        self.assertEqual(base["chargeableIncome"], 116100)
        self.assertMoney(base["taxPayable"], 3350 + 0.115 * 36100)
        self.assertAlmostEqual(base["effectiveRate"], (3350 + 0.115 * 36100) / 145000, places=12)

    def test_odd_donation_gives_half_dollars_and_half_up_cents(self):
        r = ref.plan(make({"income.donations": 101}))
        base = r["baseline"]
        self.assertEqual(base["donationDeduction"], 252.5)
        self.assertEqual(base["assessableIncome"], 134747.5)
        self.assertEqual(base["chargeableIncome"], 108347)            # floor(108,347.5)
        self.assertMoney(base["taxPayable"], 6609.91)                 # 3,350 + 3,259.905 -> half-up
        # every recommended dollar still reduces chargeable income by exactly one dollar
        self.assertEqual(r["plan"]["chargeableIncomeAfter"], 108347 - 23300)

    def test_donations_larger_than_income(self):
        r = ref.plan(make({"income.donations": 100000}))
        self.assertEqual(r["baseline"]["donationDeduction"], 250000)
        self.assertEqual(r["baseline"]["assessableIncome"], 0)
        self.assertEqual(r["baseline"]["chargeableIncome"], 0)
        self.assertEqual(r["plan"]["bindingConstraint"], "none")

    def test_projected_year(self):
        r = ref.plan(make({"incomeYear": 2027, "today": "2027-03-01", "profile.ageAtYearEnd": 58}))
        self.assertIn({"code": "PROJECTED_RULES", "severity": "caution"}, r["warnings"])
        self.assertEqual(r["cpf"]["monthlyEmployeeRates"], [0.19] * 12)
        self.assertEqual(r["cpf"]["employeeContribution"], 1520 * 12 + 1140)
        self.assertEqual(r["monthlyPlan"]["deadline"], "2027-12-31")
        self.assertEqual(r["monthlyPlan"]["monthsRemaining"], 10)
        self.assertNotIn("PROJECTED_RULES", codes(ref.plan(base_input())))
        self.assertNotIn("PROJECTED_RULES", codes(ref.plan(make({"incomeYear": 2025}))))

    def test_2025_uses_the_lower_ow_ceiling(self):
        r = ref.plan(make({"incomeYear": 2025, "today": "2025-06-30"}))
        # 1,480 x 12 + 20% x min(15,000, 13,200) = 20,400
        self.assertEqual(r["cpf"]["ordinaryWagesSubject"], 88800)
        self.assertEqual(r["cpf"]["employeeContribution"], 20400)
        r = ref.plan(make({"incomeYear": 2025, "today": "2025-06-30", "income.additionalWages": 0}))
        self.assertEqual(r["cpf"]["employeeContribution"], 17760)
        self.assertEqual(r["cpf"]["employerContribution"], 15096)   # 17% x 88,800

    def test_simulator_step(self):
        r = ref.plan(make({"preferences.simulatorStep": 5000}))
        self.assertEqual([row["contribution"] for row in r["simulator"]], [0, 5000, 10000, 15000, 20000, 23300])
        self.assertMoney(r["simulator"][-1]["stepSaving"], 379.50)
        self.assertAlmostEqual(r["simulator"][-1]["stepRate"], 0.115, places=12)
        r = ref.plan(make({"preferences.simulatorStep": 10}))        # minimum 100
        self.assertEqual(len(r["simulator"]), 234)
        self.assertEqual(r["simulator"][1]["contribution"], 100)
        r = ref.plan(make({"preferences.simulatorStep": 23300}))     # exact multiple: no duplicate last row
        self.assertEqual([row["contribution"] for row in r["simulator"]], [0, 23300])
        r = ref.plan(make({"preferences.simulatorStep": 11650}))
        self.assertEqual([row["contribution"] for row in r["simulator"]], [0, 11650, 23300])


# ---------------------------------------------------------------------------
# SPEC 6.5 - the room for a top-up to one's own CPF must be confirmed from age 55
# ---------------------------------------------------------------------------

class RoomFromAge55(MoneyAssertions):
    """The Appendix A.1 person (S$10,000 x 12 + S$15,000, other reliefs 5,000, SRS and CPF self on) at 54 and 55.

    Birth month 12 (the default), so at 55 the CPF rate is still 20% all year: CPF relief 20,400 at both ages.
    Age 54: Earned Income Relief 1,000 -> the A.1 figures (chargeable income 108,600, tax 6,639.00).
    Age 55: Earned Income Relief 6,000 -> reliefs 31,400, chargeable income 103,600,
            tax 3,350 + 11.5% x 23,600 = 6,064.00; U(7%) = 63,600, C = 48,600.
    """

    def at(self, age, changes=None):
        merged = {"profile.ageAtYearEnd": age}
        merged.update(changes or {})
        return ref.plan(make(merged))

    def test_age_54_without_a_room_the_limit_does_not_bind(self):
        r = self.at(54)
        self.assertEqual(r["baseline"]["chargeableIncome"], 108600)
        self.assertEqual(r["levers"]["cpfSelf"], {"statutoryCap": 8000, "used": 0, "room": 8000,
                                                  "eligible": True, "enabled": True})
        self.assertEqual(r["plan"]["contributions"], {"srs": 15300, "cpfSelf": 8000, "cpfFamily": 0})
        self.assertMoney(r["plan"]["taxSaved"], 2679.50)
        self.assertEqual(r["warnings"], warned(["LEVER_LIMITS_PLAN"]))
        self.assertEqual(scenario(r, "cpfSelfOnly")["totalContribution"], 8000)

    def test_age_55_without_a_room_nothing_goes_into_own_cpf(self):
        r = self.at(55)
        self.assertEqual(r["cpf"]["employeeContribution"], 20400)
        self.assertEqual(r["baseline"]["reliefs"]["earnedIncome"], 6000)
        self.assertEqual(r["baseline"]["reliefs"]["totalBeforeCap"], 31400)
        self.assertEqual(r["baseline"]["chargeableIncome"], 103600)
        self.assertMoney(r["baseline"]["taxPayable"], 6064.00)
        self.assertEqual(r["levers"]["cpfSelf"], {"statutoryCap": 8000, "used": 0, "room": 0,
                                                  "eligible": True, "enabled": True})
        self.assertEqual(r["levers"]["srs"]["room"], 15300)
        plan = r["plan"]
        self.assertEqual(plan["contributions"], {"srs": 15300, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual(plan["totalContribution"], 15300)             # min(U 63,600, C 48,600, L 15,300)
        self.assertEqual(plan["bindingConstraint"], "leverLimits")
        self.assertEqual(plan["chargeableIncomeAfter"], 88300)
        self.assertMoney(plan["taxAfter"], 4304.50)                    # 3,350 + 11.5% x 8,300
        self.assertMoney(plan["taxSaved"], 1759.50)
        # N(15,300) - N(min(U, C) = 48,600) = 4,304.50 - tax(55,000) = 4,304.50 - 1,600.00
        self.assertMoney(plan["unrealisedSaving"], 2704.50)
        self.assertEqual(r["warnings"], warned(["LEVER_LIMITS_PLAN", "CPF_SELF_ROOM_UNCONFIRMED"]))
        self.assertEqual(r["warnings"][1]["severity"], "caution")
        # everything that uses the room follows: ladder, simulator, scenarios, monthly plan
        self.assertEqual([(t["fromContribution"], t["toContribution"], t["rate"]) for t in r["ladder"]],
                         [(0, 15300, 0.115)])
        self.assertMoney(r["ladder"][0]["taxSaved"], 1759.50)
        self.assertEqual(len(r["simulator"]), 17)                       # 0, 1,000 ... 15,000, 15,300
        self.assertEqual(r["simulator"][-1]["split"], {"srs": 15300, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual(scenario(r, "cpfSelfOnly")["totalContribution"], 0)
        self.assertMoney(scenario(r, "cpfSelfOnly")["taxSaved"], 0)
        self.assertEqual(scenario(r, "srsPlusCpfSelf")["contributions"], {"srs": 15300, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual(scenario(r, "maxAll")["contributions"], {"srs": 15300, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual([row["amounts"]["cpfSelf"] for row in r["monthlyPlan"]["schedule"]], [0, 0])
        self.assertEqual(r["monthlyPlan"]["fullYearMonthly"], {"srs": 1275, "cpfSelf": 0, "cpfFamily": 0, "total": 1275})

    def test_age_55_with_a_room_the_room_is_used(self):
        r = self.at(55, {"levers.cpfSelf.roomToLimit": 8000})
        self.assertEqual(r["levers"]["cpfSelf"]["room"], 8000)
        self.assertEqual(r["plan"]["contributions"], {"srs": 15300, "cpfSelf": 8000, "cpfFamily": 0})
        self.assertEqual(r["plan"]["chargeableIncomeAfter"], 80300)
        self.assertMoney(r["plan"]["taxAfter"], 3384.50)               # 3,350 + 11.5% x 300
        self.assertMoney(r["plan"]["taxSaved"], 2679.50)
        self.assertEqual(r["warnings"], warned(["LEVER_LIMITS_PLAN", "AGE_55_PLUS_TOPUP"]))
        self.assertEqual(r["warnings"][1]["severity"], "info")
        self.assertEqual(scenario(r, "cpfSelfOnly")["totalContribution"], 8000)

        r = self.at(55, {"levers.cpfSelf.roomToLimit": 3000})
        self.assertEqual(r["levers"]["cpfSelf"]["room"], 3000)
        self.assertEqual(r["plan"]["contributions"], {"srs": 15300, "cpfSelf": 3000, "cpfFamily": 0})
        self.assertMoney(r["plan"]["taxAfter"], 3959.50)               # 85,300 -> 3,350 + 11.5% x 5,300
        self.assertMoney(r["plan"]["taxSaved"], 2104.50)
        self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN", "AGE_55_PLUS_TOPUP"])

    def test_any_number_confirms_the_room_and_the_cap_still_applies(self):
        # "Entering any number - including one at or above S$8,000 - confirms it."
        at_cap = self.at(55, {"levers.cpfSelf.roomToLimit": 8000})
        for room in (8001, 20000, 50000, 10**9):
            r = self.at(55, {"levers.cpfSelf.roomToLimit": room})
            self.assertEqual(r, at_cap, room)
        # cap - existing binds before the entered room: 8,000 - 6,000 = 2,000 < 5,000
        r = self.at(55, {"levers.cpfSelf.roomToLimit": 5000, "existing.cpfTopUpSelf": 6000})
        self.assertEqual(r["levers"]["cpfSelf"], {"statutoryCap": 8000, "used": 6000, "room": 2000,
                                                  "eligible": True, "enabled": True})
        self.assertEqual(r["plan"]["contributions"]["cpfSelf"], 2000)
        # ... and the entered room binds before cap - existing: 1,500 < 2,000
        r = self.at(55, {"levers.cpfSelf.roomToLimit": 1500, "existing.cpfTopUpSelf": 6000})
        self.assertEqual(r["levers"]["cpfSelf"]["room"], 1500)
        # with the room blank, what was already topped up still earns relief but nothing more is planned
        r = self.at(55, {"existing.cpfTopUpSelf": 6000})
        self.assertEqual(r["baseline"]["reliefs"]["cpfTopUpSelf"], 6000)
        self.assertEqual(r["levers"]["cpfSelf"], {"statutoryCap": 8000, "used": 6000, "room": 0,
                                                  "eligible": True, "enabled": True})
        self.assertEqual(r["plan"]["contributions"]["cpfSelf"], 0)

    def test_a_room_of_zero_is_a_confirmed_room(self):
        blank = self.at(55)
        zero = self.at(55, {"levers.cpfSelf.roomToLimit": 0})
        self.assertEqual(zero["levers"]["cpfSelf"]["room"], 0)
        self.assertEqual(without_warnings(zero), without_warnings(blank))      # the same plan to the cent
        self.assertEqual(codes(zero), ["LEVER_LIMITS_PLAN", "AGE_55_PLUS_TOPUP"])
        self.assertEqual(codes(blank), ["LEVER_LIMITS_PLAN", "CPF_SELF_ROOM_UNCONFIRMED"])

    def test_what_counts_as_provided(self):
        # SPEC 6.0: an optional limit applies only when it is a number.  Text, booleans, lists and
        # objects are "not provided": at 55 that is a room of 0 and the request for the figure.
        for junk in ("8000", "", True, False, [], [8000], {"amount": 8000}, None):
            r = self.at(55, {"levers.cpfSelf.roomToLimit": junk})
            self.assertEqual(r["levers"]["cpfSelf"]["room"], 0, repr(junk))
            self.assertEqual(r["plan"]["contributions"]["cpfSelf"], 0, repr(junk))
            self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN", "CPF_SELF_ROOM_UNCONFIRMED"], repr(junk))
        # NaN, +/-Infinity and negative numbers ARE numbers: a limit of 0, which counts as provided.
        for number in (float("nan"), float("inf"), float("-inf"), -1, -0.5, 0.9):
            r = self.at(55, {"levers.cpfSelf.roomToLimit": number})
            self.assertEqual(r["levers"]["cpfSelf"]["room"], 0, repr(number))
            self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN", "AGE_55_PLUS_TOPUP"], repr(number))
        # below 55 none of this matters: junk is "no limit"
        for junk in ("8000", True, [], None):
            r = self.at(54, {"levers.cpfSelf.roomToLimit": junk})
            self.assertEqual(r["levers"]["cpfSelf"]["room"], 8000, repr(junk))
            self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN"], repr(junk))

    def test_the_boundary_is_age_55_at_year_end(self):
        for age, room in ((18, 8000), (53, 8000), (54, 8000), (55, 0), (56, 0), (59, 0), (60, 0), (65, 0), (99, 0), (120, 0)):
            r = self.at(age)
            self.assertEqual(r["levers"]["cpfSelf"]["room"], room, age)
            self.assertEqual(r["plan"]["contributions"]["cpfSelf"], room, age)
            self.assertEqual("CPF_SELF_ROOM_UNCONFIRMED" in codes(r), age >= 55, age)
            self.assertNotIn("AGE_55_PLUS_TOPUP", codes(r), age)
            given = self.at(age, {"levers.cpfSelf.roomToLimit": 2500})
            self.assertEqual(given["levers"]["cpfSelf"]["room"], 2500, age)
            self.assertEqual(given["plan"]["contributions"]["cpfSelf"], 2500, age)
            self.assertEqual("AGE_55_PLUS_TOPUP" in codes(given), age >= 55, age)
            self.assertNotIn("CPF_SELF_ROOM_UNCONFIRMED", codes(given), age)
        # the age is the sanitised one: 54.99 is 54, 55.01 is 55
        self.assertEqual(self.at(54.99)["levers"]["cpfSelf"]["room"], 8000)
        self.assertEqual(self.at(55.01)["levers"]["cpfSelf"]["room"], 0)
        # the birth month moves the CPF rate, not the room rule (it goes by the age at year end)
        self.assertEqual(self.at(55, {"profile.birthMonth": 1})["levers"]["cpfSelf"]["room"], 0)
        self.assertEqual(self.at(54, {"profile.birthMonth": 1})["levers"]["cpfSelf"]["room"], 8000)

    def test_lever_switched_off(self):
        # Neither caution: nothing is being recommended for the person's own CPF.  The scenarios ignore
        # the enabled flag but not the room rule (SPEC 6.9: roomIfEnabled).
        r = self.at(55, {"levers.cpfSelf.enabled": False})
        self.assertEqual(r["levers"]["cpfSelf"], {"statutoryCap": 8000, "used": 0, "room": 0,
                                                  "eligible": True, "enabled": False})
        self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN"])
        self.assertEqual(scenario(r, "cpfSelfOnly")["totalContribution"], 0)
        self.assertEqual(scenario(r, "srsPlusCpfSelf")["totalContribution"], 15300)
        r = self.at(55, {"levers.cpfSelf.enabled": False, "levers.cpfSelf.roomToLimit": 4000})
        self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN"])
        self.assertEqual(r["levers"]["cpfSelf"]["room"], 0)
        self.assertEqual(scenario(r, "cpfSelfOnly")["totalContribution"], 4000)
        self.assertEqual(scenario(r, "srsPlusCpfSelf")["totalContribution"], 19300)
        r = self.at(54, {"levers.cpfSelf.enabled": False})
        self.assertEqual(scenario(r, "cpfSelfOnly")["totalContribution"], 8000)
        self.assertEqual(scenario(r, "srsPlusCpfSelf")["totalContribution"], 23300)

    def test_foreigners_have_no_cpf_lever_at_any_age(self):
        for changes in ({}, {"levers.cpfSelf.roomToLimit": 8000}):
            merged = {"profile.residency": "foreigner"}
            merged.update(changes)
            r = self.at(60, merged)
            self.assertEqual(r["levers"]["cpfSelf"], {"statutoryCap": 0, "used": 0, "room": 0,
                                                      "eligible": False, "enabled": True})
            self.assertNotIn("CPF_SELF_ROOM_UNCONFIRMED", codes(r))
            self.assertNotIn("AGE_55_PLUS_TOPUP", codes(r))

    def test_own_cpf_as_the_only_scheme(self):
        # Age 55, only CPF (self) on, room blank: nothing can be recommended.  Tax 6,064.00 stays.
        r = self.at(55, {"levers.srs.enabled": False})
        self.assertEqual(r["plan"]["totalContribution"], 0)
        self.assertEqual(r["plan"]["bindingConstraint"], "leverLimits")
        self.assertMoney(r["plan"]["taxAfter"], 6064.00)
        self.assertMoney(r["plan"]["unrealisedSaving"], 6064.00 - 1600.00)     # down to 55,000
        self.assertEqual(r["ladder"], [])
        self.assertEqual(len(r["simulator"]), 1)
        self.assertEqual(r["monthlyPlan"]["schedule"], [])
        self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN", "CPF_SELF_ROOM_UNCONFIRMED"])
        # 11 days before the deadline there is nothing to hurry for: no DEADLINE_SOON
        soon = self.at(55, {"levers.srs.enabled": False, "today": "2026-12-20"})
        self.assertEqual(codes(soon), ["LEVER_LIMITS_PLAN", "CPF_SELF_ROOM_UNCONFIRMED"])

    def test_the_two_age_55_warnings_never_come_together(self):
        for age in (54, 55, 70):
            for enabled in (True, False):
                for residency in ("citizen", "pr", "foreigner"):
                    for room in ("absent", None, 0, 1, 8000, "8000"):
                        changes = {"levers.cpfSelf.enabled": enabled, "profile.residency": residency}
                        if room != "absent":
                            changes["levers.cpfSelf.roomToLimit"] = room
                        got = codes(self.at(age, changes))
                        label = (age, enabled, residency, room)
                        applies = age >= 55 and enabled and residency != "foreigner"
                        provided = isinstance(room, int)
                        self.assertEqual("CPF_SELF_ROOM_UNCONFIRMED" in got, applies and not provided, label)
                        self.assertEqual("AGE_55_PLUS_TOPUP" in got, applies and provided, label)


# ---------------------------------------------------------------------------
# SPEC 6.11 - the cautions that cover what the tool cannot see
# ---------------------------------------------------------------------------

class CautionWarnings(MoneyAssertions):
    def test_table_and_severities(self):
        self.assertEqual(list(ref.WARNING_TABLE), SPEC_WARNING_TABLE)
        self.assertEqual(len(set(SPEC_WARNING_ORDER)), 21)

    def test_tax_residency_check(self):
        # Foreigner on S$15,000 a month for 6 months: income 90,000, chargeable income 89,000,
        # tax 3,350 + 11.5% x 9,000 = 4,385.00; U(7%) 49,000, C 79,000, L 35,700 -> X = 35,700.
        inp = foreigner_input(15000)
        inp["income"]["monthsWorked"] = 6
        r = ref.plan(inp)
        self.assertEqual(r["baseline"]["chargeableIncome"], 89000)
        self.assertMoney(r["baseline"]["taxPayable"], 4385.00)
        self.assertEqual(r["plan"]["totalContribution"], 35700)
        self.assertEqual(r["warnings"], warned(["LEVER_LIMITS_PLAN", "FOREIGNER_NO_CPF", "TAX_RESIDENCY_CHECK",
                                                "SRS_NON_RESIDENT_WITHDRAWAL"]))
        self.assertIn({"code": "TAX_RESIDENCY_CHECK", "severity": "caution"}, r["warnings"])
        # both sides of "monthsWorked <= 6" - on the sanitised figure (floored, clamped to 1...12, default 12)
        for months, expected in ((1, True), (5, True), (6, True), (6.9, True), (7, False), (7.5, False), (12, False),
                                 (0, True), (-3, True), (float("nan"), True), (13, False), (None, False), ("6", False)):
            inp = foreigner_input(15000)
            inp["income"]["monthsWorked"] = months
            self.assertEqual("TAX_RESIDENCY_CHECK" in codes(ref.plan(inp)), expected, repr(months))
        inp = foreigner_input(15000)
        del inp["income"]["monthsWorked"]
        self.assertNotIn("TAX_RESIDENCY_CHECK", codes(ref.plan(inp)))
        # only foreigners are asked
        for residency in ("citizen", "pr"):
            r = ref.plan(make({"profile.residency": residency, "income.monthsWorked": 3}))
            self.assertNotIn("TAX_RESIDENCY_CHECK", codes(r), residency)
        # it does not depend on the SRS lever
        inp = foreigner_input(15000)
        inp["income"]["monthsWorked"] = 6
        inp["levers"]["srs"]["enabled"] = False
        self.assertEqual(codes(ref.plan(inp)), ["LEVER_LIMITS_PLAN", "FOREIGNER_NO_CPF", "TAX_RESIDENCY_CHECK"])

    def test_srs_non_resident_withdrawal(self):
        r = ref.plan(foreigner_input(15000))
        self.assertIn({"code": "SRS_NON_RESIDENT_WITHDRAWAL", "severity": "caution"}, r["warnings"])
        # SRS switched off
        inp = foreigner_input(15000)
        inp["levers"]["srs"]["enabled"] = False
        self.assertNotIn("SRS_NON_RESIDENT_WITHDRAWAL", codes(ref.plan(inp)))
        # "enabled" means the boolean true
        inp["levers"]["srs"]["enabled"] = 1
        self.assertNotIn("SRS_NON_RESIDENT_WITHDRAWAL", codes(ref.plan(inp)))
        # not eligible: under 18 (and the under-18 caution comes later in the table)
        inp = foreigner_input(15000)
        inp["profile"]["ageAtYearEnd"] = 17
        self.assertEqual(codes(ref.plan(inp)), ["LEVER_LIMITS_PLAN", "FOREIGNER_NO_CPF", "SRS_UNDER_18"])
        inp["profile"]["ageAtYearEnd"] = 18
        self.assertEqual(codes(ref.plan(inp)), ["LEVER_LIMITS_PLAN", "FOREIGNER_NO_CPF", "SRS_NON_RESIDENT_WITHDRAWAL"])
        # citizens and PRs
        for residency in ("citizen", "pr"):
            self.assertNotIn("SRS_NON_RESIDENT_WITHDRAWAL", codes(ref.plan(make({"profile.residency": residency}))))
        # it is about the scheme being on, not about money going in: S$35,700 already contributed, room 0
        inp = foreigner_input(15000)
        inp["existing"]["srs"] = 35700
        r = ref.plan(inp)
        self.assertEqual(r["plan"]["totalContribution"], 0)
        self.assertIn("SRS_NON_RESIDENT_WITHDRAWAL", codes(r))

    def test_family_top_up_checks(self):
        # A.1 with the family lever on: L = 31,300 < U 68,600 and C 53,600, so 8,000 goes to family.
        r = ref.plan(make({"levers.cpfFamily.enabled": True}))
        self.assertEqual(r["plan"]["contributions"], {"srs": 15300, "cpfSelf": 8000, "cpfFamily": 8000})
        self.assertEqual(r["warnings"], warned(["LEVER_LIMITS_PLAN", "FAMILY_TOPUP_CHECKS"]))
        self.assertIn({"code": "FAMILY_TOPUP_CHECKS", "severity": "caution"}, r["warnings"])
        # on, but the budget runs out before the family's turn (priority SRS first): nothing planned
        r = ref.plan(make({"levers.cpfFamily.enabled": True, "preferences.cashBudget": 10000}))
        self.assertEqual(r["plan"]["contributions"]["cpfFamily"], 0)
        self.assertEqual(codes(r), ["BUDGET_LIMITS_PLAN"])
        # one dollar for the family is enough
        r = ref.plan(make({"levers.cpfFamily.enabled": True, "preferences.cashBudget": 23301}))
        self.assertEqual(r["plan"]["contributions"]["cpfFamily"], 1)
        self.assertEqual(codes(r), ["BUDGET_LIMITS_PLAN", "FAMILY_TOPUP_CHECKS"])
        # on, with "most I would give" 0
        r = ref.plan(make({"levers.cpfFamily.enabled": True, "levers.cpfFamily.maxAmount": 0}))
        self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN"])
        # an existing family top-up is enough, lever on or off, even S$1
        r = ref.plan(make({"existing.cpfTopUpFamily": 1}))
        self.assertEqual(r["plan"]["contributions"]["cpfFamily"], 0)
        self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN", "FAMILY_TOPUP_CHECKS"])
        r = ref.plan(make({"existing.cpfTopUpFamily": 8000, "levers.cpfFamily.enabled": True}))
        self.assertEqual(r["levers"]["cpfFamily"]["room"], 0)
        self.assertEqual(codes(r), ["LEVER_LIMITS_PLAN", "FAMILY_TOPUP_CHECKS"])
        # the existing amount is the sanitised one
        for nothing in (0, -5, 0.9, "8000", None):
            r = ref.plan(make({"existing.cpfTopUpFamily": nothing}))
            self.assertNotIn("FAMILY_TOPUP_CHECKS", codes(r), repr(nothing))
        # PRs are eligible givers; foreigners are not (their top-up earns no relief at all)
        r = ref.plan(make({"profile.residency": "pr", "existing.cpfTopUpFamily": 500}))
        self.assertIn("FAMILY_TOPUP_CHECKS", codes(r))
        r = ref.plan(make({"profile.residency": "foreigner", "existing.cpfTopUpFamily": 9000,
                           "levers.cpfFamily.enabled": True}))
        self.assertNotIn("FAMILY_TOPUP_CHECKS", codes(r))
        # nothing recommended at all (A.3 at 7%): no caution
        inp = a3_input(0.07)
        inp["levers"]["cpfFamily"]["enabled"] = True
        self.assertEqual(codes(ref.plan(inp)), ["BELOW_MIN_SAVING_RATE"])

    def test_parenthood_tax_rebate(self):
        base = ref.plan(base_input())
        r = ref.plan(make({"profile.hasUnusedParenthoodTaxRebate": True}))
        self.assertEqual(r["warnings"], warned(["LEVER_LIMITS_PLAN", "PARENTHOOD_TAX_REBATE"]))
        self.assertIn({"code": "PARENTHOOD_TAX_REBATE", "severity": "caution"}, r["warnings"])
        # the tick changes no figure (SPEC 1, 6.4): tax 6,639.00 -> 3,959.50 as in Appendix A.1
        self.assertEqual(without_warnings(r), without_warnings(base))
        self.assertMoney(r["plan"]["taxAfter"], 3959.50)
        # true only for the boolean true
        for value in (False, None, 1, 0, "true", "yes", "", [True], {"value": True}, 1.0):
            r = ref.plan(make({"profile.hasUnusedParenthoodTaxRebate": value}))
            self.assertEqual(r, base, repr(value))
        # with no tax payable both messages are due, in table order
        r = ref.plan(make({"profile.ageAtYearEnd": 25, "income.monthlyOrdinaryWage": 1500, "income.additionalWages": 0,
                           "otherReliefs": 0, "profile.hasUnusedParenthoodTaxRebate": True}))
        self.assertEqual(codes(r), ["NO_TAX_PAYABLE", "PARENTHOOD_TAX_REBATE"])

    def test_order_foreigner_with_everything_wrong(self):
        # Foreigner, 40, income year 2027 (projected), today 5 January 2028 (deadline passed), S$30,000 a
        # month for 6 months = 180,000; S$40,000 already in SRS (cap 35,700); other reliefs 90,000; PTR ticked.
        # Reliefs 1,000 + 35,700 + 90,000 = 126,700 -> 80,000 allowed, 46,700 lost; chargeable income 100,000;
        # tax 3,350 + 11.5% x 20,000 = 5,650.00.  U(7%) 60,000, C 0, L 0 -> X 0; C and L tie at 0 -> reliefCap.
        r = ref.plan(make({
            "incomeYear": 2027, "today": "2028-01-05",
            "profile.residency": "foreigner", "profile.ageAtYearEnd": 40, "profile.hasUnusedParenthoodTaxRebate": True,
            "income.monthlyOrdinaryWage": 30000, "income.monthsWorked": 6, "income.additionalWages": 0,
            "existing.srs": 40000, "otherReliefs": 90000,
        }))
        self.assertEqual(r["baseline"]["reliefs"]["lostToCap"], 46700)
        self.assertEqual(r["baseline"]["chargeableIncome"], 100000)
        self.assertMoney(r["baseline"]["taxPayable"], 5650.00)
        self.assertEqual(r["plan"]["bindingConstraint"], "reliefCap")
        self.assertEqual(r["warnings"], warned([
            "RELIEF_CAP_EXCEEDED_BASELINE", "RELIEF_CAP_LIMITS_PLAN", "EXISTING_EXCEEDS_CAP", "FOREIGNER_NO_CPF",
            "TAX_RESIDENCY_CHECK", "SRS_NON_RESIDENT_WITHDRAWAL", "PARENTHOOD_TAX_REBATE", "DEADLINE_PASSED",
            "PROJECTED_RULES",
        ]))

    def test_order_second_year_pr_of_60(self):
        # PR in the second year, 60 (birth month 12: still "above 55 to 60" all year), income year 2027,
        # today 20 December 2027 (11 days left).  A.1 pay; CPF override 30,000 (above the 20,400 maximum);
        # S$1,000 already given to family, family lever on; own CPF on with the room blank; budget 1,000; PTR.
        # Reliefs 8,000 + 20,400 + 1,000 + 5,000 = 34,400; chargeable income 100,600;
        # tax 3,350 + 11.5% x 20,600 = 5,719.00.  U 60,600, C 45,600, L 15,300 + 0 + 7,000 = 22,300, B 1,000.
        r = ref.plan(make({
            "incomeYear": 2027, "today": "2027-12-20",
            "profile.residency": "pr", "profile.prYear": 2, "profile.ageAtYearEnd": 60,
            "profile.hasUnusedParenthoodTaxRebate": True,
            "income.employeeCpfOverride": 30000,
            "existing.cpfTopUpFamily": 1000, "levers.cpfFamily.enabled": True,
            "preferences.cashBudget": 1000,
        }))
        self.assertEqual(r["cpf"]["monthlyEmployeeRates"], [0.125] * 12)
        self.assertEqual(r["baseline"]["reliefs"]["totalBeforeCap"], 34400)
        self.assertEqual(r["baseline"]["chargeableIncome"], 100600)
        self.assertMoney(r["baseline"]["taxPayable"], 5719.00)
        self.assertEqual([r["levers"][k]["room"] for k in ref.LEVER_IDS], [15300, 0, 7000])
        self.assertEqual(r["plan"]["contributions"], {"srs": 1000, "cpfSelf": 0, "cpfFamily": 0})
        self.assertEqual(r["plan"]["bindingConstraint"], "cashBudget")
        self.assertEqual(r["monthlyPlan"]["daysToDeadline"], 11)
        self.assertEqual(r["warnings"], warned([
            "BUDGET_LIMITS_PLAN", "CPF_OVERRIDE_ABOVE_MAX", "PR_GRADUATED_RATES", "CPF_SELF_ROOM_UNCONFIRMED",
            "FAMILY_TOPUP_CHECKS", "PARENTHOOD_TAX_REBATE", "DEADLINE_SOON", "PROJECTED_RULES",
        ]))
        self.assertEqual([w["severity"] for w in r["warnings"]],
                         ["info", "caution", "info", "caution", "caution", "caution", "caution", "caution"])

    def test_order_under_18(self):
        # The A.1 pay at 17 (no SRS), PTR ticked, looked at on 5 January 2027: CPF self 8,000 is all there is.
        r = ref.plan(make({"profile.ageAtYearEnd": 17, "profile.hasUnusedParenthoodTaxRebate": True,
                           "today": "2027-01-05"}))
        self.assertEqual(r["plan"]["contributions"], {"srs": 0, "cpfSelf": 8000, "cpfFamily": 0})
        self.assertEqual(r["warnings"], warned(["LEVER_LIMITS_PLAN", "PARENTHOOD_TAX_REBATE", "SRS_UNDER_18",
                                                "DEADLINE_PASSED"]))


# ---------------------------------------------------------------------------
# Monthly plan and deadline
# ---------------------------------------------------------------------------

class MonthlyPlanAndDeadline(MoneyAssertions):
    def test_deadline_passed(self):
        r = ref.plan(make({"today": "2027-01-05"}))
        mp = r["monthlyPlan"]
        self.assertEqual(mp["daysToDeadline"], -5)
        self.assertEqual(mp["monthsRemaining"], 0)
        self.assertEqual(mp["schedule"], [])
        self.assertEqual(mp["fullYearMonthly"], {"srs": 1275, "cpfSelf": 667, "cpfFamily": 0, "total": 1942})
        self.assertEqual(r["plan"]["totalContribution"], 23300)   # the tax arithmetic does not change
        self.assertEqual(r["warnings"], [
            {"code": "LEVER_LIMITS_PLAN", "severity": "info"},
            {"code": "DEADLINE_PASSED", "severity": "blocker"},
        ])

    def test_deadline_soon(self):
        r = ref.plan(make({"today": "2026-12-20"}))
        self.assertEqual(r["monthlyPlan"]["daysToDeadline"], 11)
        self.assertEqual(r["monthlyPlan"]["monthsRemaining"], 1)
        self.assertEqual(r["monthlyPlan"]["schedule"], [
            {"month": "2026-12", "amounts": {"srs": 15300, "cpfSelf": 8000, "cpfFamily": 0}, "total": 23300},
        ])
        self.assertIn({"code": "DEADLINE_SOON", "severity": "caution"}, r["warnings"])

    def test_deadline_soon_window(self):
        self.assertIn("DEADLINE_SOON", codes(ref.plan(make({"today": "2026-12-31"}))))      # 0 days
        self.assertEqual(ref.plan(make({"today": "2026-12-31"}))["monthlyPlan"]["daysToDeadline"], 0)
        self.assertIn("DEADLINE_SOON", codes(ref.plan(make({"today": "2026-12-17"}))))      # 14 days
        self.assertNotIn("DEADLINE_SOON", codes(ref.plan(make({"today": "2026-12-16"}))))   # 15 days
        self.assertNotIn("DEADLINE_PASSED", codes(ref.plan(make({"today": "2026-12-31"}))))
        self.assertIn("DEADLINE_PASSED", codes(ref.plan(make({"today": "2027-01-01"}))))
        # nothing recommended -> no "soon" caution
        inp = a3_input(0.07)
        inp["today"] = "2026-12-25"
        self.assertNotIn("DEADLINE_SOON", codes(ref.plan(inp)))

    def test_planning_before_the_income_year(self):
        r = ref.plan(make({"today": "2025-12-15"}))
        mp = r["monthlyPlan"]
        self.assertEqual(mp["daysToDeadline"], 16 + 365)
        self.assertEqual(mp["monthsRemaining"], 12)
        self.assertEqual([row["month"] for row in mp["schedule"]], ["2026-%02d" % m for m in range(1, 13)])
        self.assertEqual([row["amounts"]["srs"] for row in mp["schedule"]], [1275] * 12)
        # 8,000 = 666 x 12 + 8: the first eight instalments carry the extra dollar
        self.assertEqual([row["amounts"]["cpfSelf"] for row in mp["schedule"]], [667] * 8 + [666] * 4)
        self.assertEqual([row["total"] for row in mp["schedule"]], [1942] * 8 + [1941] * 4)

    def test_january_and_uneven_split(self):
        r = ref.plan(make({"today": "2026-01-31", "preferences.cashBudget": 10007}))
        mp = r["monthlyPlan"]
        self.assertEqual(mp["daysToDeadline"], 334)
        self.assertEqual(mp["monthsRemaining"], 12)
        self.assertEqual([row["amounts"]["srs"] for row in mp["schedule"]], [834] * 11 + [833])
        self.assertEqual(sum(row["total"] for row in mp["schedule"]), 10007)
        self.assertEqual(mp["fullYearMonthly"], {"srs": 834, "cpfSelf": 0, "cpfFamily": 0, "total": 834})
        r = ref.plan(make({"today": "2026-08-10"}))
        self.assertEqual(r["monthlyPlan"]["monthsRemaining"], 5)
        self.assertEqual([row["month"] for row in r["monthlyPlan"]["schedule"]],
                         ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"])
        self.assertEqual([row["amounts"]["srs"] for row in r["monthlyPlan"]["schedule"]], [3060] * 5)
        self.assertEqual([row["amounts"]["cpfSelf"] for row in r["monthlyPlan"]["schedule"]], [1600] * 5)

    def test_leap_year_day_count(self):
        # 2027-12-31 from 2027-02-28: 306 days (2027 is not a leap year)
        r = ref.plan(make({"incomeYear": 2027, "today": "2027-02-28"}))
        self.assertEqual(r["monthlyPlan"]["daysToDeadline"], 306)


# ---------------------------------------------------------------------------
# Sanitising (SPEC 6.0)
# ---------------------------------------------------------------------------

class Sanitising(unittest.TestCase):
    def test_money(self):
        s = ref.sanitise_input(make({
            "income.monthlyOrdinaryWage": 10000.9,
            "income.additionalWages": -5,
            "income.otherTaxableIncome": float("nan"),
            "income.employmentExpenses": float("inf"),
            "income.donations": "100",
            "otherReliefs": 4999.99,
            "existing.srs": -0.5,
            "existing.cpfTopUpSelf": 12.7,
        }))
        self.assertEqual(s["income"]["monthlyOrdinaryWage"], 10000)
        self.assertEqual(s["income"]["additionalWages"], 0)
        self.assertEqual(s["income"]["otherTaxableIncome"], 0)
        self.assertEqual(s["income"]["employmentExpenses"], 0)
        self.assertEqual(s["income"]["donations"], 0)
        self.assertEqual(s["otherReliefs"], 4999)
        self.assertEqual(s["existing"]["srs"], 0)
        self.assertEqual(s["existing"]["cpfTopUpSelf"], 12)

    def test_defaults(self):
        s = ref.sanitise_input({"incomeYear": 2026, "today": TODAY})
        self.assertEqual(s["profile"], {"residency": "citizen", "prYear": 3, "ageAtYearEnd": 0, "birthMonth": 12,
                                        "hasUnusedParenthoodTaxRebate": False})
        self.assertEqual(s["income"]["monthsWorked"], 12)
        self.assertIsNone(s["income"]["employeeCpfOverride"])
        self.assertIsNone(s["levers"]["cpfSelf"]["roomToLimit"])
        self.assertIsNone(s["levers"]["cpfFamily"]["maxAmount"])
        self.assertIsNone(s["preferences"]["cashBudget"])
        self.assertEqual(s["preferences"]["minSavingRate"], 0)
        self.assertEqual(s["preferences"]["priority"], ["srs", "cpfSelf", "cpfFamily"])
        self.assertEqual(s["preferences"]["simulatorStep"], 1000)

    def test_clamps(self):
        def s(changes):
            return ref.sanitise_input(make(changes))
        self.assertEqual(s({"income.monthsWorked": 0})["income"]["monthsWorked"], 1)
        self.assertEqual(s({"income.monthsWorked": -4})["income"]["monthsWorked"], 1)
        self.assertEqual(s({"income.monthsWorked": 13})["income"]["monthsWorked"], 12)
        self.assertEqual(s({"income.monthsWorked": 6.7})["income"]["monthsWorked"], 6)
        self.assertEqual(s({"income.monthsWorked": None})["income"]["monthsWorked"], 12)
        self.assertEqual(s({"profile.birthMonth": 0})["profile"]["birthMonth"], 1)
        self.assertEqual(s({"profile.birthMonth": 15})["profile"]["birthMonth"], 12)
        self.assertEqual(s({"profile.birthMonth": None})["profile"]["birthMonth"], 12)
        self.assertEqual(s({"profile.ageAtYearEnd": -3})["profile"]["ageAtYearEnd"], 0)
        self.assertEqual(s({"profile.ageAtYearEnd": 200})["profile"]["ageAtYearEnd"], 120)
        self.assertEqual(s({"profile.ageAtYearEnd": 35.9})["profile"]["ageAtYearEnd"], 35)
        self.assertEqual(s({"profile.prYear": 7})["profile"]["prYear"], 3)
        self.assertEqual(s({"profile.prYear": 2})["profile"]["prYear"], 2)
        self.assertEqual(s({"profile.prYear": None})["profile"]["prYear"], 3)
        self.assertEqual(s({"preferences.minSavingRate": -1})["preferences"]["minSavingRate"], 0)
        self.assertEqual(s({"preferences.minSavingRate": 3})["preferences"]["minSavingRate"], 1)
        self.assertEqual(s({"preferences.minSavingRate": float("nan")})["preferences"]["minSavingRate"], 0)
        self.assertEqual(s({"preferences.simulatorStep": 50})["preferences"]["simulatorStep"], 100)
        self.assertEqual(s({"preferences.simulatorStep": 250.7})["preferences"]["simulatorStep"], 250)
        self.assertEqual(s({"preferences.simulatorStep": None})["preferences"]["simulatorStep"], 1000)

    def test_optional_limits(self):
        def s(changes):
            return ref.sanitise_input(make(changes))
        self.assertIsNone(s({"preferences.cashBudget": None})["preferences"]["cashBudget"])
        self.assertEqual(s({"preferences.cashBudget": -5})["preferences"]["cashBudget"], 0)
        self.assertEqual(s({"preferences.cashBudget": 1234.5})["preferences"]["cashBudget"], 1234)
        self.assertEqual(s({"levers.cpfSelf.roomToLimit": 0})["levers"]["cpfSelf"]["roomToLimit"], 0)
        self.assertEqual(s({"levers.cpfFamily.maxAmount": 99.9})["levers"]["cpfFamily"]["maxAmount"], 99)
        # SPEC 6.0: the override is a figure, not a limit - negative or non-finite means "not provided".
        self.assertIsNone(s({"income.employeeCpfOverride": -1})["income"]["employeeCpfOverride"])
        self.assertIsNone(s({"income.employeeCpfOverride": float("nan")})["income"]["employeeCpfOverride"])
        self.assertIsNone(s({"income.employeeCpfOverride": float("inf")})["income"]["employeeCpfOverride"])
        self.assertIsNone(s({"income.employeeCpfOverride": "12000"})["income"]["employeeCpfOverride"])
        self.assertEqual(s({"income.employeeCpfOverride": 0})["income"]["employeeCpfOverride"], 0)
        self.assertEqual(s({"income.employeeCpfOverride": 12000.9})["income"]["employeeCpfOverride"], 12000)

    def test_priority(self):
        def p(value):
            return ref.sanitise_input(make({"preferences.priority": value}))["preferences"]["priority"]
        self.assertEqual(p(["cpfSelf", "bogus", "cpfSelf"]), ["cpfSelf", "srs", "cpfFamily"])
        self.assertEqual(p(["cpfFamily"]), ["cpfFamily", "srs", "cpfSelf"])
        self.assertEqual(p([]), ["srs", "cpfSelf", "cpfFamily"])
        self.assertEqual(p(None), ["srs", "cpfSelf", "cpfFamily"])
        self.assertEqual(p(["cpfFamily", "cpfSelf", "srs"]), ["cpfFamily", "cpfSelf", "srs"])
        self.assertEqual(p(["srs", "srs", "cpfFamily", 7, None]), ["srs", "cpfFamily", "cpfSelf"])

    def test_idempotent(self):
        for inp in (base_input(), a2_input(), make({"income.monthsWorked": 0, "preferences.simulatorStep": 7}),
                    make({"today": "garbage"}), make({"today": "2026-11-13T23:59:59+08:00"}),
                    make({"income.otherTaxableIncome": 10**12, "levers.srs.enabled": 1})):
            once = ref.sanitise_input(inp)
            self.assertEqual(ref.sanitise_input(once), once)

    def test_money_is_clamped_to_ten_billion(self):
        # SPEC 6.0: money inputs are clamped to at most S$10,000,000,000.
        def s(changes):
            return ref.sanitise_input(make(changes))
        cap = 10_000_000_000
        self.assertEqual(s({"income.monthlyOrdinaryWage": cap + 1})["income"]["monthlyOrdinaryWage"], cap)
        self.assertEqual(s({"income.additionalWages": 1e12})["income"]["additionalWages"], cap)
        self.assertEqual(s({"income.otherTaxableIncome": 9e15})["income"]["otherTaxableIncome"], cap)
        self.assertEqual(s({"income.employmentExpenses": cap})["income"]["employmentExpenses"], cap)
        self.assertEqual(s({"income.donations": cap - 1})["income"]["donations"], cap - 1)
        self.assertEqual(s({"existing.srs": 1e300})["existing"]["srs"], cap)
        self.assertEqual(s({"otherReliefs": 2**60})["otherReliefs"], cap)
        # optional limits are "sanitised like money"
        self.assertEqual(s({"preferences.cashBudget": cap + 5})["preferences"]["cashBudget"], cap)
        self.assertEqual(s({"levers.cpfSelf.roomToLimit": 1e11})["levers"]["cpfSelf"]["roomToLimit"], cap)
        self.assertEqual(s({"levers.cpfFamily.maxAmount": 1e11})["levers"]["cpfFamily"]["maxAmount"], cap)
        self.assertEqual(s({"income.employeeCpfOverride": 1e11})["income"]["employeeCpfOverride"], cap)
        # the simulator step is not a money input: it has a minimum (100) but no maximum
        self.assertEqual(s({"preferences.simulatorStep": 20_000_000_000})["preferences"]["simulatorStep"], 20_000_000_000)

    def test_clamped_money_worked_example(self):
        # Appendix A.1 profile with other taxable income of S$10,000,000,001 (clamped to 10,000,000,000):
        # total income 10,000,135,000; reliefs 26,400; chargeable income 10,000,108,600;
        # tax 199,150 + 24% x 9,999,108,600 = 2,399,985,214.00.
        r = ref.plan(make({"income.otherTaxableIncome": 10_000_000_001}))
        self.assertEqual(r["baseline"]["totalIncome"], 10_000_135_000)
        self.assertEqual(r["baseline"]["chargeableIncome"], 10_000_108_600)
        self.assertEqual(round(r["baseline"]["taxPayable"] * 100), 239_998_521_400)
        self.assertEqual(ref.plan(make({"income.otherTaxableIncome": 10_000_000_000})), r)
        self.assertEqual(ref.plan(make({"income.otherTaxableIncome": 9e15})), r)

    def test_numbers_beyond_a_double_are_not_finite(self):
        # The data contract is a JSON number (a double).  10^400 is Infinity there: "not finite -> 0".
        s = ref.sanitise_input(make({"income.additionalWages": 10**400, "preferences.cashBudget": 10**400,
                                     "profile.ageAtYearEnd": 10**400, "preferences.minSavingRate": 10**400}))
        self.assertEqual(s["income"]["additionalWages"], 0)
        self.assertEqual(s["preferences"]["cashBudget"], 0)       # a number, so a limit - of zero
        self.assertEqual(s["profile"]["ageAtYearEnd"], 0)
        self.assertEqual(s["preferences"]["minSavingRate"], 1)    # +infinity clamped to 0...1
        self.assertEqual(ref.sanitise_input(make({"preferences.minSavingRate": -10**400}))["preferences"]["minSavingRate"], 0)

    def test_not_finite_numbers_are_numbers(self):
        # SPEC 6.0: NaN and +/-Infinity are numbers, so they are sanitised to 0 (then clamped) rather than
        # replaced by the default, and as an optional limit they are a limit of 0, not "no limit".
        nan, inf = float("nan"), float("inf")
        s = ref.sanitise_input(make({"income.monthsWorked": nan, "profile.birthMonth": inf,
                                     "profile.ageAtYearEnd": nan, "preferences.simulatorStep": nan,
                                     "preferences.cashBudget": inf, "levers.cpfSelf.roomToLimit": nan}))
        self.assertEqual(s["income"]["monthsWorked"], 1)
        self.assertEqual(s["profile"]["birthMonth"], 1)
        self.assertEqual(s["profile"]["ageAtYearEnd"], 0)
        self.assertEqual(s["preferences"]["simulatorStep"], 100)
        self.assertEqual(s["preferences"]["cashBudget"], 0)
        self.assertEqual(s["levers"]["cpfSelf"]["roomToLimit"], 0)
        r = ref.plan(make({"preferences.cashBudget": inf}))
        self.assertEqual(r["plan"]["totalContribution"], 0)
        self.assertEqual(r["plan"]["bindingConstraint"], "cashBudget")

    def test_a_lever_is_enabled_only_by_the_boolean_true(self):
        # SPEC 6.0: a lever is enabled only when `enabled` is exactly true.
        for value in (1, "true", "false", "yes", [True], {"on": True}, 1.0, None):
            s = ref.sanitise_input(make({"levers.srs.enabled": value, "levers.cpfSelf.enabled": value,
                                         "levers.cpfFamily.enabled": value}))
            self.assertEqual([s["levers"][lever]["enabled"] for lever in ref.LEVER_IDS], [False] * 3, repr(value))
        s = ref.sanitise_input({"incomeYear": 2026, "today": TODAY})                 # levers missing altogether
        self.assertEqual([s["levers"][lever]["enabled"] for lever in ref.LEVER_IDS], [False] * 3)
        # Appendix A.1 with truthy non-boolean flags: nothing is switched on, tax stays 6,639.00.
        r = ref.plan(make({"levers": {"srs": {"enabled": 1}, "cpfSelf": {"enabled": "true"},
                                      "cpfFamily": {"enabled": "false"}}}))
        self.assertEqual(r["plan"]["totalContribution"], 0)
        self.assertEqual(round(r["plan"]["taxAfter"] * 100), 663_900)
        self.assertEqual([r["levers"][lever]["room"] for lever in ref.LEVER_IDS], [0, 0, 0])

    def test_parenthood_tax_rebate_flag_is_true_only_for_the_boolean_true(self):
        # SPEC 6.0: `profile.hasUnusedParenthoodTaxRebate` is true only for the boolean true, otherwise false.
        def flag(value):
            return ref.sanitise_input(make({"profile.hasUnusedParenthoodTaxRebate": value}))["profile"]["hasUnusedParenthoodTaxRebate"]
        self.assertIs(flag(True), True)
        for value in (False, None, 1, 0, 1.0, "true", "True", "yes", "", [True], [], {}, {"value": True}):
            self.assertIs(flag(value), False, repr(value))
        self.assertIs(ref.sanitise_input(base_input())["profile"]["hasUnusedParenthoodTaxRebate"], False)   # missing
        self.assertIs(ref.sanitise_input({"incomeYear": 2026})["profile"]["hasUnusedParenthoodTaxRebate"], False)
        self.assertIs(ref.sanitise_input({"incomeYear": 2026, "profile": "x"})["profile"]["hasUnusedParenthoodTaxRebate"], False)
        # reported like the other profile fields, and stable under a second pass
        once = ref.sanitise_input(make({"profile.hasUnusedParenthoodTaxRebate": True}))
        self.assertEqual(once["profile"], {"residency": "citizen", "prYear": 3, "ageAtYearEnd": 35, "birthMonth": 12,
                                           "hasUnusedParenthoodTaxRebate": True})
        self.assertEqual(ref.sanitise_input(once), once)
        self.assertIs(ref.default_input(TODAY)["profile"]["hasUnusedParenthoodTaxRebate"], False)

    def test_room_to_limit_is_null_unless_it_is_a_number(self):
        # What SPEC 6.5 and 6.11 call "provided": a number after sanitising.
        def room(value):
            return ref.sanitise_input(make({"levers.cpfSelf.roomToLimit": value}))["levers"]["cpfSelf"]["roomToLimit"]
        for value in (None, "8000", "", True, False, [], {}):
            self.assertIsNone(room(value), repr(value))
        self.assertIsNone(ref.sanitise_input(base_input())["levers"]["cpfSelf"]["roomToLimit"])
        for value, expected in ((0, 0), (1, 1), (7999.9, 7999), (50000, 50000), (-1, 0), (float("nan"), 0),
                                (float("inf"), 0), (float("-inf"), 0)):
            self.assertEqual(room(value), expected, repr(value))


# ---------------------------------------------------------------------------
# `today` (SPEC 6.0, 6.10)
# ---------------------------------------------------------------------------

class Today(unittest.TestCase):
    UNPARSEABLE = ("", "garbage", "13/11/2026", "2026/11/13", "tomorrow", None, 20261113, True, "T",
                   # impossible calendar dates
                   "2026-02-30", "2026-13-01", "2026-00-10", "2026-11-00", "2026-11-31", "2027-02-29", "2026-02-29",
                   # unpadded fields, leading whitespace, a further digit straight after the day
                   "2026-1-5", "2026-11-5", " 2026-11-13", "2026-11-135", "02026-11-13", "26-11-13",
                   # digits that are not ASCII digits
                   "\u0662\u0660\u0662\u0666-11-13")

    def test_unparseable_today_is_1_january_of_the_income_year(self):
        # Appendix A.1 planned "as at" 1 January 2026: 364 days to 31 December, 12 instalment months.
        # SRS 15,300 / 12 = 1,275 a month; CPF self 8,000 = 666 x 12 + 8 -> 667 for 8 months, then 666.
        expected = ref.plan(make({"today": "2026-01-01"}))
        self.assertEqual(expected["monthlyPlan"]["daysToDeadline"], 364)
        self.assertEqual(expected["monthlyPlan"]["monthsRemaining"], 12)
        self.assertEqual([row["amounts"]["srs"] for row in expected["monthlyPlan"]["schedule"]], [1275] * 12)
        self.assertEqual([row["amounts"]["cpfSelf"] for row in expected["monthlyPlan"]["schedule"]], [667] * 8 + [666] * 4)
        self.assertEqual([row["month"] for row in expected["monthlyPlan"]["schedule"]],
                         ["2026-%02d" % m for m in range(1, 13)])
        for value in self.UNPARSEABLE:
            self.assertEqual(ref.sanitise_input(make({"today": value}))["today"], "2026-01-01", repr(value))
            self.assertEqual(ref.plan(make({"today": value})), expected, repr(value))
        missing = base_input()
        del missing["today"]
        self.assertEqual(ref.plan(missing), expected)
        self.assertEqual(ref.run_batch([missing])[0], expected)        # no {"error": ...} any more
        # ... of the income year of the input, whichever it is
        self.assertEqual(ref.sanitise_input(make({"incomeYear": 2027, "today": "soon"}))["today"], "2027-01-01")
        self.assertEqual(ref.plan(make({"incomeYear": 2025, "today": None}))["monthlyPlan"]["daysToDeadline"], 364)

    def test_only_the_leading_date_is_read(self):
        expected = ref.plan(base_input())                              # 2026-11-13: 48 days, 2 months
        self.assertEqual(expected["monthlyPlan"]["daysToDeadline"], 48)
        for value in ("2026-11-13T23:59:59+08:00", "2026-11-13 08:00", "2026-11-13Z", "2026-11-13-05",
                      "2026-11-13T00:00:00.000Z", "2026-11-13 and then some"):
            self.assertEqual(ref.sanitise_input(make({"today": value}))["today"], "2026-11-13", value)
            self.assertEqual(ref.plan(make({"today": value})), expected, value)

    def test_leap_days(self):
        self.assertEqual(ref.sanitise_input(make({"today": "2028-02-29"}))["today"], "2028-02-29")
        self.assertEqual(ref.sanitise_input(make({"today": "2024-02-29"}))["today"], "2024-02-29")
        self.assertEqual(ref.sanitise_input(make({"today": "2000-02-29"}))["today"], "2000-02-29")
        self.assertEqual(ref.sanitise_input(make({"today": "1900-02-29"}))["today"], "2026-01-01")   # not a leap year
        self.assertEqual(ref.sanitise_input(make({"today": "2100-02-29"}))["today"], "2026-01-01")
        # 29 February 2024 to 31 December 2026: 306 days left in 2024, then 365 + 365.
        r = ref.plan(make({"today": "2024-02-29"}))
        self.assertEqual(r["monthlyPlan"]["daysToDeadline"], 306 + 365 + 365)
        self.assertEqual(r["monthlyPlan"]["monthsRemaining"], 12)

    def test_day_counts_agree_with_the_calendar(self):
        import datetime
        deadline = datetime.date(2026, 12, 31)
        day = datetime.date(2023, 1, 1)
        while day <= datetime.date(2029, 12, 31):
            r_days = ref._day_number((2026, 12, 31)) - ref._day_number((day.year, day.month, day.day))
            self.assertEqual(r_days, (deadline - day).days, day.isoformat())
            day += datetime.timedelta(days=17)
        for year, month, dom in ((1, 1, 1), (1600, 2, 29), (1900, 3, 1), (2000, 2, 29), (2400, 12, 31), (9999, 12, 31)):
            self.assertEqual(ref._day_number((year, month, dom)) - ref._day_number((1, 1, 1)),
                             datetime.date(year, month, dom).toordinal() - 1, (year, month, dom))
        # Year 0000 exists in the proleptic Gregorian calendar and is a leap year (366 days).
        self.assertEqual(ref._day_number((1, 1, 1)) - ref._day_number((0, 1, 1)), 366)
        self.assertEqual(ref.sanitise_input(make({"today": "0000-02-29"}))["today"], "0000-02-29")
        self.assertEqual(ref.plan(make({"today": "0000-01-01"}))["monthlyPlan"]["monthsRemaining"], 12)

    def test_default_income_year(self):
        self.assertEqual(ref.default_income_year("2025-03-01"), 2025)
        self.assertEqual(ref.default_income_year("2026-11-13"), 2026)
        self.assertEqual(ref.default_income_year("2027-12-31T10:00:00Z"), 2027)
        self.assertEqual(ref.default_income_year("2019-06-01"), 2025)      # nearest supported
        self.assertEqual(ref.default_income_year("2040-01-01"), 2027)
        # SPEC 7: an unparseable date gives the latest supported year whose rules are final (2026),
        # never the projected year and never the back-testing year.
        for value in ("", "garbage", None, 2026, "2025", "2027-1-5", " 2025-01-01", "2027-02-30"):
            self.assertEqual(ref.default_income_year(value), 2026, repr(value))
        self.assertEqual(ref.default_input("soon")["incomeYear"], 2026)
        self.assertEqual(ref.plan(ref.default_input("soon"))["monthlyPlan"]["daysToDeadline"], 364)


class PublicTaxFunctions(unittest.TestCase):
    def test_argument_domain(self):
        # SPEC 7: the argument is sanitised like any numeric input and clamped to S$140,000,000,000.
        rules = ref.get_rules(2026)
        # tax on 140bn: 199,150 + 24% x (140,000,000,000 - 1,000,000) = 33,599,959,150.00
        self.assertEqual(round(ref.gross_tax(140_000_000_000, rules) * 100), 3_359_995_915_000)
        self.assertEqual(ref.gross_tax(200_000_000_000, rules), ref.gross_tax(140_000_000_000, rules))
        self.assertEqual(ref.gross_tax(1e300, rules), ref.gross_tax(140_000_000_000, rules))
        # 20bn is above the S$10bn clamp of a money INPUT but inside the domain of the tax functions:
        # 199,150 + 24% x 19,999,000,000 = 4,799,959,150.00
        self.assertEqual(round(ref.gross_tax(20_000_000_000, rules) * 100), 479_995_915_000)
        for bad in (float("inf"), float("-inf"), float("nan"), -1, -0.5, None, "50000"):
            self.assertEqual(ref.gross_tax(bad, rules), 0, repr(bad))
            self.assertEqual(ref.marginal_rate(bad, rules), 0, repr(bad))
        self.assertEqual(ref.gross_tax(30000.99, rules), 200)              # floored
        self.assertEqual(ref.marginal_rate(200_000_000_000, rules), 0.24)

    def test_plan_does_not_mutate_its_input(self):
        inp = a2_input()
        snapshot = copy.deepcopy(inp)
        ref.plan(inp)
        self.assertEqual(inp, snapshot)

    def test_fractional_inputs_are_floored_before_use(self):
        dirty = make({"income.monthlyOrdinaryWage": 10000.99, "income.additionalWages": 15000.5,
                      "otherReliefs": 5000.9, "preferences.cashBudget": None})
        self.assertEqual(ref.plan(dirty), ref.plan(base_input()))

    def test_evaluate_matches_plan(self):
        inp = a2_input()
        r = ref.plan(inp)
        self.assertEqual(ref.evaluate(inp, {"srs": 0, "cpfSelf": 0, "cpfFamily": 0}), r["baseline"])
        self.assertEqual(ref.evaluate(inp), r["baseline"])
        self.assertEqual(ref.evaluate(inp, r["plan"]["contributions"]), r["optimised"])


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

class Cli(unittest.TestCase):
    def run_cli(self, inputs, *options, check=True):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "inputs.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(inputs, handle)
            return subprocess.run([sys.executable, os.path.join(HERE, "sgtax_reference.py"), *options, path],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)

    def test_cli_round_trip(self):
        inputs = [base_input(), make({"incomeYear": 2030}), a2_input(), make({"incomeYear": 2024})]
        out = json.loads(self.run_cli(inputs).stdout.decode("utf-8"))
        self.assertEqual(len(out), 4)
        self.assertEqual(out[1], {"error": "unsupported incomeYear"})
        self.assertEqual(out[3], {"error": "unsupported incomeYear"})
        self.assertEqual(out[0], json.loads(json.dumps(ref.plan(base_input()))))
        self.assertEqual(out[2]["plan"]["contributions"], {"cpfSelf": 8000, "srs": 10300, "cpfFamily": 1700})
        self.assertNotIn("rules", out[0])
        self.assertNotIn("input", out[0])

    def test_cli_warning_order(self):
        inputs = [a2_input(), a2b_input(), make({"incomeYear": 2030})]
        in_table_order = [["BUDGET_LIMITS_PLAN", "AGE_55_PLUS_TOPUP", "FAMILY_TOPUP_CHECKS"],
                          ["LEVER_LIMITS_PLAN", "CPF_SELF_ROOM_UNCONFIRMED", "FAMILY_TOPUP_CHECKS"]]
        # --warning-order=table: exactly what plan() returns, the order of the SPEC 6.11 table
        out = json.loads(self.run_cli(inputs, "--warning-order=table").stdout.decode("utf-8"))
        self.assertEqual([codes(result) for result in out[:2]], in_table_order)
        self.assertEqual(out[0], json.loads(json.dumps(ref.plan(a2_input()))))
        self.assertEqual(out[2], {"error": "unsupported incomeYear"})
        self.assertEqual(out, json.loads(json.dumps(ref.run_batch(inputs))))
        # the flag may also follow the file name
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "inputs.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(inputs, handle)
            proc = subprocess.run([sys.executable, os.path.join(HERE, "sgtax_reference.py"), path, "--warning-order=table"],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        self.assertEqual(json.loads(proc.stdout.decode("utf-8")), out)
        # default (and --warning-order=code): the same warnings sorted by code, nothing else different
        for options in ((), ("--warning-order=code",)):
            by_code = json.loads(self.run_cli(inputs, *options).stdout.decode("utf-8"))
            self.assertEqual([codes(result) for result in by_code[:2]], [sorted(order) for order in in_table_order])
            for sorted_result, table_result in zip(by_code[:2], out[:2]):
                self.assertEqual(without_warnings(sorted_result), without_warnings(table_result))
                self.assertEqual(sorted(sorted_result["warnings"], key=lambda w: w["code"]),
                                 sorted(table_result["warnings"], key=lambda w: w["code"]))
        self.assertEqual(ref.run_batch(inputs, "code"), ref.run_batch(inputs, warning_order="code"))
        self.assertEqual([codes(result) for result in ref.run_batch(inputs, "code")[:2]],
                         [sorted(order) for order in in_table_order])

    def test_cli_usage_errors(self):
        for options in (("--warning-order=alphabetical",), ("--no-such-option",), ("extra-file.json",)):
            proc = self.run_cli([base_input()], *options, check=False)
            self.assertEqual(proc.returncode, 2, options)
            self.assertIn(b"usage", proc.stderr, options)
            self.assertEqual(proc.stdout, b"", options)
        with self.assertRaises(ValueError):
            ref.run_batch([base_input()], "alphabetical")

    def test_json_null_optionals(self):
        text = json.dumps(make({"preferences.cashBudget": None, "levers.cpfSelf.roomToLimit": None,
                                "levers.cpfFamily.maxAmount": None, "income.employeeCpfOverride": None}))
        self.assertIn("null", text)
        self.assertEqual(ref.run_batch([json.loads(text)])[0], ref.plan(base_input()))

    def test_unsupported_year_raises_in_plan(self):
        for year in (2024, 2028, None, "2026", 2026.5):
            with self.assertRaises(ref.UnsupportedIncomeYear):
                ref.plan(make({"incomeYear": year}))
        self.assertEqual(ref.plan(make({"incomeYear": 2026.0})), ref.plan(base_input()))


# ---------------------------------------------------------------------------
# Invariants on random inputs (seeded) - a self-check of the oracle
# ---------------------------------------------------------------------------

def random_input(rng):
    year = rng.choice([2025, 2026, 2027])
    wage = rng.choice([0, 400, 600, 750, 2500, 5200, 7400, 8000, 9000, 15000, 30000, 90000]) + rng.randrange(0, 700)
    month = rng.randrange(1, 13)
    day = rng.randrange(1, 29)
    return {
        "incomeYear": year,
        "today": "%04d-%02d-%02d" % (year + rng.choice([-1, 0, 0, 0, 1]), month, day),
        "profile": {
            "residency": rng.choice(["citizen", "citizen", "pr", "foreigner"]),
            "prYear": rng.choice([1, 2, 3]),
            "ageAtYearEnd": rng.choice([16, 17, 18, 30, 54, 55, 56, 59, 60, 61, 64, 65, 66, 69, 70, 71, 80]),
            "birthMonth": rng.randrange(1, 13),
            "hasUnusedParenthoodTaxRebate": rng.choice([True, False, False, None, 1]),
        },
        "income": {
            "monthlyOrdinaryWage": wage,
            "monthsWorked": rng.choice([12, 12, 12, 1, 5, 6, 7, 9]),
            "additionalWages": rng.choice([0, 0, 3000, 25000, 120000]) + rng.randrange(0, 999),
            "otherTaxableIncome": rng.choice([0, 0, 0, 12345, 400000]),
            "employmentExpenses": rng.choice([0, 0, 0, 1500]),
            "donations": rng.choice([0, 0, 101, 5000]),
            "employeeCpfOverride": rng.choice([None, None, None, 0, 12000, 30000]),
        },
        "existing": {
            "srs": rng.choice([0, 0, 5000, 15300, 40000]),
            "cpfTopUpSelf": rng.choice([0, 0, 3000, 9000]),
            "cpfTopUpFamily": rng.choice([0, 0, 0, 1, 8000]),
        },
        "otherReliefs": rng.choice([0, 0, 5000, 30000, 60000, 90000]),
        "levers": {
            "srs": {"enabled": rng.random() < 0.8},
            "cpfSelf": {"enabled": rng.random() < 0.8, "roomToLimit": rng.choice([None, None, 0, 2500, 20000])},
            "cpfFamily": {"enabled": rng.random() < 0.5, "maxAmount": rng.choice([None, None, 1000, 8000])},
        },
        "preferences": {
            "cashBudget": rng.choice([None, None, 0, 1234, 10000, 50000]),
            "minSavingRate": rng.choice([0, 0, 0.02, 0.035, 0.07, 0.1, 0.115, 0.15, 0.2, 0.25]),
            "priority": rng.sample(["srs", "cpfSelf", "cpfFamily"], 3),
            "simulatorStep": rng.choice([None, 1000, 500, 2500, 100]),
        },
    }


class Invariants(MoneyAssertions):
    def test_random_inputs(self):
        rng = random.Random(8675309)
        brute_force_budget = 30
        seen = collections.Counter()
        for case in range(600):
            inp = random_input(rng)
            r = ref.plan(inp)
            json.dumps(r, allow_nan=False)
            label = "case %d: %s" % (case, json.dumps(inp))
            plan = r["plan"]
            x = plan["totalContribution"]
            rooms = {k: r["levers"][k]["room"] for k in ref.LEVER_IDS}
            lever_room = sum(rooms.values())
            cap_room = r["reliefCapRoom"]
            budget = inp["preferences"]["cashBudget"]
            min_rate = inp["preferences"]["minSavingRate"]
            ci0 = r["baseline"]["chargeableIncome"]

            # the plan respects every room, cap and budget
            self.assertEqual(sum(plan["contributions"].values()), x, label)
            for lever in ref.LEVER_IDS:
                self.assertGreaterEqual(plan["contributions"][lever], 0, label)
                self.assertLessEqual(plan["contributions"][lever], rooms[lever], label)
            self.assertLessEqual(x, lever_room, label)
            self.assertLessEqual(x, cap_room, label)
            if budget is not None:
                self.assertLessEqual(x, budget, label)

            # every relief dollar of the plan reduces chargeable income by one dollar
            self.assertEqual(plan["chargeableIncomeAfter"], ci0 - x, label)
            self.assertMoney(plan["taxSaved"], plan["taxBefore"] - plan["taxAfter"], label)
            self.assertMoney(plan["taxSaved"], float(decimal_tax(ci0) - decimal_tax(ci0 - x)), label)

            # no recommended dollar saves less than the minimum (or nothing) ...
            if x > 0:
                last_dollar_rate = decimal_marginal(ci0 - x + 1)
                self.assertGreater(last_dollar_rate, 0, label)
                self.assertGreaterEqual(last_dollar_rate, min_rate, label)
            # ... and one more dollar would break a constraint or save too little
            if x < lever_room and x < cap_room and (budget is None or x < budget):
                next_rate = decimal_marginal(ci0 - x)
                self.assertTrue(next_rate == 0 or next_rate < min_rate, label)
                self.assertEqual(plan["bindingConstraint"] in ("usefulRoom", "none"), True, label)

            # dollar-by-dollar greedy search agrees (on a subset: it is slow)
            if brute_force_budget > 0 and lever_room > 0:
                brute_force_budget -= 1
                greedy = 0
                while greedy < lever_room and greedy < cap_room and (budget is None or greedy < budget):
                    rate = decimal_marginal(ci0 - greedy)
                    if rate == 0 or rate < min_rate:
                        break
                    greedy += 1
                self.assertEqual(x, greedy, label)

            # ladder: contiguous partition of [0, L), reconciles with the plan and the simulator
            ladder = r["ladder"]
            position = 0
            running = 0
            for i, tier in enumerate(ladder):
                self.assertEqual(tier["fromContribution"], position, label)
                self.assertGreater(tier["amount"], 0, label)
                self.assertEqual(tier["toContribution"] - tier["fromContribution"], tier["amount"], label)
                position = tier["toContribution"]
                running += round(tier["taxSaved"] * 100)
                self.assertEqual(round(tier["cumulativeTaxSaved"] * 100), running, label)
                self.assertEqual("zeroReason" in tier, tier["rate"] == 0, label)
                if i > 0:
                    prev = ladder[i - 1]
                    self.assertFalse(prev["rate"] == tier["rate"] and prev.get("zeroReason") == tier.get("zeroReason"),
                                     label)
                    self.assertLessEqual(tier["rate"], prev["rate"], label)
            self.assertEqual(position, lever_room, label)
            self.assertEqual(sum(t["usedByPlan"] for t in ladder), x, label)
            if x > 0:
                # statutory rate x dollars used; the realised saving is the difference of two
                # amounts each rounded to cents once, so it can be up to one cent away.
                statutory_mills = sum(round(t["rate"] * 1000) * t["usedByPlan"] for t in ladder)
                realised_cents = round(plan["taxSaved"] * 100)
                self.assertLessEqual(abs(statutory_mills - realised_cents * 10), 10, label)

            sim = r["simulator"]
            step = inp["preferences"]["simulatorStep"] or 1000
            self.assertEqual(len(sim), math.ceil(lever_room / step) + 1, label)
            self.assertEqual(sim[-1]["contribution"], lever_room, label)
            if ladder:
                self.assertMoney(sim[-1]["taxSaved"], ladder[-1]["cumulativeTaxSaved"], label)
            for row in sim:
                self.assertEqual(sum(row["split"].values()), row["contribution"], label)
                self.assertEqual(row["withinPlan"], row["contribution"] <= x, label)
                self.assertMoney(row["taxPayable"] + row["taxSaved"], plan["taxBefore"], label)

            # scenarios
            by_id = {s["id"]: s for s in r["scenarios"]}
            self.assertEqual(by_id["recommended"]["contributions"], plan["contributions"], label)
            self.assertEqual(by_id["recommended"]["wastedContribution"], 0, label)
            self.assertMoney(by_id["none"]["taxPayable"], plan["taxBefore"], label)
            for s in r["scenarios"]:
                self.assertGreaterEqual(s["wastedContribution"], 0, label)
                self.assertLessEqual(s["wastedContribution"], s["totalContribution"], label)
                useful = s["totalContribution"] - s["wastedContribution"]
                self.assertMoney(s["taxSaved"], float(decimal_tax(ci0) - decimal_tax(ci0 - useful)), label)

            # monthly plan
            mp = r["monthlyPlan"]
            if mp["schedule"]:
                self.assertEqual(len(mp["schedule"]), mp["monthsRemaining"], label)
                self.assertEqual(mp["schedule"][-1]["month"], "%d-12" % inp["incomeYear"], label)
                for lever in ref.LEVER_IDS:
                    self.assertEqual(sum(row["amounts"][lever] for row in mp["schedule"]),
                                     plan["contributions"][lever], label)
            else:
                self.assertTrue(x == 0 or mp["monthsRemaining"] == 0, label)
            self.assertEqual(mp["daysToDeadline"] < 0, "DEADLINE_PASSED" in codes(r), label)

            # warnings: one per code, in the order of the SPEC 6.11 table, with the table's severities
            got = codes(r)
            self.assertEqual(len(set(got)), len(got), label)
            self.assertEqual(got, [code for code in SPEC_WARNING_ORDER if code in set(got)], label)
            self.assertEqual(r["warnings"], warned(got), label)

            # SPEC 6.5: from 55 the room for one's own CPF must be entered; a room entered is never exceeded
            age = inp["profile"]["ageAtYearEnd"]
            residency = inp["profile"]["residency"]
            citizen_or_pr = residency != "foreigner"
            entered = inp["levers"]["cpfSelf"]["roomToLimit"]
            self_on = inp["levers"]["cpfSelf"]["enabled"]
            cap_left = max(0, 8000 - inp["existing"]["cpfTopUpSelf"]) if citizen_or_pr else 0
            if entered is None:
                expected_room = 0 if age >= 55 else cap_left
            else:
                expected_room = min(entered, cap_left)
            seen["age>=55 blank room" if age >= 55 and entered is None else "other"] += 1
            self.assertEqual(rooms["cpfSelf"], expected_room if self_on else 0, label)
            self.assertLessEqual(plan["contributions"]["cpfSelf"], expected_room, label)
            self.assertEqual(by_id["cpfSelfOnly"]["contributions"], {"srs": 0, "cpfSelf": expected_room, "cpfFamily": 0}, label)
            self.assertEqual(by_id["srsPlusCpfSelf"]["contributions"]["cpfSelf"], expected_room, label)
            self.assertEqual(by_id["maxAll"]["contributions"]["cpfSelf"], expected_room, label)
            for row in sim:
                self.assertLessEqual(row["split"]["cpfSelf"], expected_room, label)

            # SPEC 6.11: the new cautions, each exactly when its condition holds
            conditions = {
                "TAX_RESIDENCY_CHECK": residency == "foreigner" and inp["income"]["monthsWorked"] <= 6,
                "SRS_NON_RESIDENT_WITHDRAWAL": residency == "foreigner" and inp["levers"]["srs"]["enabled"] and age >= 18,
                "CPF_SELF_ROOM_UNCONFIRMED": age >= 55 and self_on and citizen_or_pr and entered is None,
                "AGE_55_PLUS_TOPUP": age >= 55 and self_on and citizen_or_pr and entered is not None,
                "FAMILY_TOPUP_CHECKS": citizen_or_pr and (plan["contributions"]["cpfFamily"] > 0
                                                          or inp["existing"]["cpfTopUpFamily"] > 0),
                "PARENTHOOD_TAX_REBATE": inp["profile"]["hasUnusedParenthoodTaxRebate"] is True,
            }
            for code, holds in conditions.items():
                self.assertEqual(code in got, holds, "%s %s" % (code, label))
                seen[code] += 1 if holds else 0
            self.assertFalse("CPF_SELF_ROOM_UNCONFIRMED" in got and "AGE_55_PLUS_TOPUP" in got, label)

        # the random inputs do reach every new case
        for key in ("age>=55 blank room", "TAX_RESIDENCY_CHECK", "SRS_NON_RESIDENT_WITHDRAWAL", "CPF_SELF_ROOM_UNCONFIRMED",
                    "AGE_55_PLUS_TOPUP", "FAMILY_TOPUP_CHECKS", "PARENTHOOD_TAX_REBATE"):
            self.assertGreaterEqual(seen[key], 20, key)


if __name__ == "__main__":
    unittest.main()
