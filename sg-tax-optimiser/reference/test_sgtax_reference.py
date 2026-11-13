# -*- coding: utf-8 -*-
"""Tests for the independent Python reference implementation.

Run from the project root:

    python3 -m unittest discover -s reference -p 'test_*.py'

Every expected number in this file was worked out by hand from SPEC.md
(Appendix A, Appendix B, or the section 6 formulas) - none was copied from
the implementation's output.
"""

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

def a2_input():
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
        self.assertEqual(lev["cpfSelf"]["room"], 8000)
        self.assertEqual(lev["cpfFamily"]["room"], 8000)

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
        self.assertEqual(self.r["warnings"], [
            {"code": "AGE_55_PLUS_TOPUP", "severity": "info"},
            {"code": "BUDGET_LIMITS_PLAN", "severity": "info"},
        ])


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
        self.assertTrue(lev["cpfFamily"]["eligible"])
        self.assertEqual(lev["cpfFamily"]["statutoryCap"], 8000)
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
        self.assertEqual(codes(r), ["FOREIGNER_NO_CPF", "LEVER_LIMITS_PLAN"])
        # scenarios respect eligibility: cpfSelfOnly contributes nothing
        self.assertEqual(scenario(r, "cpfSelfOnly")["totalContribution"], 0)
        self.assertEqual(scenario(r, "srsPlusCpfSelf")["totalContribution"], 35700)
        ladder = r["ladder"]
        self.assertEqual([(t["fromContribution"], t["toContribution"], t["rate"]) for t in ladder],
                         [(0, 19000, 0.18), (19000, 35700, 0.15)])
        self.assertMoney(ladder[0]["taxSaved"], 3420.00)
        self.assertMoney(ladder[1]["taxSaved"], 2505.00)
        self.assertMoney(ladder[1]["cumulativeTaxSaved"], 5925.00)

    def test_foreigner_family_top_up_is_eligible(self):
        # SPEC 6.5: cpfFamily is "always" eligible.
        r = ref.plan(make({
            "profile.residency": "foreigner", "profile.ageAtYearEnd": 40,
            "income.monthlyOrdinaryWage": 15000, "income.additionalWages": 0, "otherReliefs": 0,
            "levers.srs.enabled": False, "levers.cpfFamily.enabled": True,
            "existing.cpfTopUpFamily": 1000,
        }))
        self.assertEqual(r["baseline"]["reliefs"]["cpfTopUpFamily"], 1000)
        self.assertEqual(r["levers"]["cpfFamily"], {"statutoryCap": 8000, "used": 1000, "room": 7000,
                                                    "eligible": True, "enabled": True})
        self.assertEqual(r["plan"]["contributions"], {"srs": 0, "cpfSelf": 0, "cpfFamily": 7000})

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
        self.assertEqual(codes(r), ["FOREIGNER_NO_CPF"])
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
        self.assertEqual(codes(r), ["EXISTING_EXCEEDS_CAP", "LEVER_LIMITS_PLAN"])
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

    def test_age_55_plus_top_up_warning(self):
        self.assertIn({"code": "AGE_55_PLUS_TOPUP", "severity": "info"},
                      ref.plan(make({"profile.ageAtYearEnd": 55}))["warnings"])
        self.assertNotIn("AGE_55_PLUS_TOPUP", codes(ref.plan(make({"profile.ageAtYearEnd": 54}))))
        self.assertNotIn("AGE_55_PLUS_TOPUP",
                         codes(ref.plan(make({"profile.ageAtYearEnd": 60, "levers.cpfSelf.enabled": False}))))
        self.assertNotIn("AGE_55_PLUS_TOPUP",
                         codes(ref.plan(make({"profile.ageAtYearEnd": 60, "profile.residency": "foreigner"}))))

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
            {"code": "DEADLINE_PASSED", "severity": "blocker"},
            {"code": "LEVER_LIMITS_PLAN", "severity": "info"},
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
        self.assertEqual(s["profile"], {"residency": "citizen", "prYear": 3, "ageAtYearEnd": 0, "birthMonth": 12})
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
        self.assertEqual(s({"income.employeeCpfOverride": -1})["income"]["employeeCpfOverride"], 0)

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
        for inp in (base_input(), a2_input(), make({"income.monthsWorked": 0, "preferences.simulatorStep": 7})):
            once = ref.sanitise_input(inp)
            self.assertEqual(ref.sanitise_input(once), once)

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
    def test_cli_round_trip(self):
        inputs = [base_input(), make({"incomeYear": 2030}), a2_input(), make({"incomeYear": 2024})]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "inputs.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(inputs, handle)
            proc = subprocess.run([sys.executable, os.path.join(HERE, "sgtax_reference.py"), path],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        out = json.loads(proc.stdout.decode("utf-8"))
        self.assertEqual(len(out), 4)
        self.assertEqual(out[1], {"error": "unsupported incomeYear"})
        self.assertEqual(out[3], {"error": "unsupported incomeYear"})
        self.assertEqual(out[0], json.loads(json.dumps(ref.plan(base_input()))))
        self.assertEqual(out[2]["plan"]["contributions"], {"cpfSelf": 8000, "srs": 10300, "cpfFamily": 1700})
        self.assertNotIn("rules", out[0])
        self.assertNotIn("input", out[0])

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
        },
        "income": {
            "monthlyOrdinaryWage": wage,
            "monthsWorked": rng.choice([12, 12, 12, 1, 5, 9]),
            "additionalWages": rng.choice([0, 0, 3000, 25000, 120000]) + rng.randrange(0, 999),
            "otherTaxableIncome": rng.choice([0, 0, 0, 12345, 400000]),
            "employmentExpenses": rng.choice([0, 0, 0, 1500]),
            "donations": rng.choice([0, 0, 101, 5000]),
            "employeeCpfOverride": rng.choice([None, None, None, 0, 12000, 30000]),
        },
        "existing": {
            "srs": rng.choice([0, 0, 5000, 15300, 40000]),
            "cpfTopUpSelf": rng.choice([0, 0, 3000, 9000]),
            "cpfTopUpFamily": rng.choice([0, 0, 8000]),
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

            # warnings are sorted and unique
            self.assertEqual(codes(r), sorted(set(codes(r))), label)


if __name__ == "__main__":
    unittest.main()
