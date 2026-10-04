"""Local federal nutrition planning references used by the optional estimator.

Current general guidance: Dietary Guidelines for Americans 2025-2030,
10th edition (January 2026).
https://odphp.health.gov/our-work/nutrition-physical-activity/dietary-guidelines/current-dietary-guidelines

Calories: rounded age/reference-category/activity planning bands retained from
Appendix 2, Table A2-2 of the 2020-2025 edition. That archived table was derived
from Institute of Medicine Estimated Energy Requirement (EER) equations. The
current EER method also needs height and weight, which NutriCart deliberately
does not collect; these bands therefore remain broad planning estimates and are
not represented as values newly published in the 2025-2030 edition.
https://www.dietaryguidelines.gov/sites/default/files/2020-12/Dietary_Guidelines_for_Americans_2020-2025.pdf

Protein RDAs and fiber AIs: National Academies Dietary Reference Intakes,
surfaced in the current NIH Office of Dietary Supplements DRI tables/resources.
https://ods.od.nih.gov/HealthInformation/nutrientrecommendations/

These are planning references for generally healthy people, not medical advice.
Pregnancy, lactation, infancy, and medically prescribed diets are deliberately
excluded from automatic estimation.
"""

from __future__ import annotations


ACTIVITY_INDEX = {"sedentary": 0, "moderate": 1, "active": 2}
REFERENCE_CATEGORIES = {"female", "male"}
UNSUPPORTED_STAGES = {"pregnant", "lactating", "medical"}


MALE_CALORIES = (
    (2, 2, (1000, 1000, 1000)), (3, 3, (1000, 1400, 1400)),
    (4, 5, (1200, 1400, 1600)), (6, 7, (1400, 1600, 1800)),
    (8, 8, (1400, 1600, 2000)), (9, 9, (1600, 1800, 2000)),
    (10, 10, (1600, 1800, 2200)), (11, 11, (1800, 2000, 2200)),
    (12, 12, (1800, 2200, 2400)), (13, 13, (2000, 2200, 2600)),
    (14, 14, (2000, 2400, 2800)), (15, 15, (2200, 2600, 3000)),
    (16, 18, (2400, 2800, 3200)), (19, 20, (2600, 2800, 3000)),
    (21, 25, (2400, 2800, 3000)), (26, 30, (2400, 2600, 3000)),
    (31, 35, (2400, 2600, 3000)), (36, 40, (2400, 2600, 2800)),
    (41, 45, (2200, 2600, 2800)), (46, 55, (2200, 2400, 2800)),
    (56, 60, (2200, 2400, 2600)), (61, 65, (2000, 2400, 2600)),
    (66, 75, (2000, 2200, 2600)), (76, 120, (2000, 2200, 2400)),
)

FEMALE_CALORIES = (
    (2, 2, (1000, 1000, 1000)), (3, 3, (1000, 1200, 1400)),
    (4, 4, (1200, 1400, 1400)), (5, 6, (1200, 1400, 1600)),
    (7, 7, (1200, 1600, 1800)), (8, 9, (1400, 1600, 1800)),
    (10, 10, (1400, 1800, 2000)), (11, 11, (1600, 1800, 2000)),
    (12, 13, (1600, 2000, 2200)), (14, 18, (1800, 2000, 2400)),
    (19, 25, (2000, 2200, 2400)), (26, 30, (1800, 2000, 2400)),
    (31, 50, (1800, 2000, 2200)), (51, 60, (1600, 1800, 2200)),
    (61, 120, (1600, 1800, 2000)),
)


def _calories(age: int, category: str, activity: str) -> int:
    table = MALE_CALORIES if category == "male" else FEMALE_CALORIES
    for minimum, maximum, values in table:
        if minimum <= age <= maximum:
            return values[ACTIVITY_INDEX[activity]]
    raise ValueError("Automatic estimates are available for ages 2 through 120.")


def _protein(age: int, category: str) -> int:
    if age <= 3:
        return 13
    if age <= 8:
        return 19
    if age <= 13:
        return 34
    if age <= 18:
        return 52 if category == "male" else 46
    return 56 if category == "male" else 46


def _fiber(age: int, category: str) -> int:
    if age <= 3:
        return 19
    if age <= 8:
        return 25
    if age <= 13:
        return 31 if category == "male" else 26
    if age <= 18:
        return 38 if category == "male" else 26
    if age <= 50:
        return 38 if category == "male" else 25
    return 30 if category == "male" else 21


def estimate_household(members: list[dict]) -> dict:
    if not isinstance(members, list) or not members:
        raise ValueError("Add household information before estimating targets.")
    if len(members) > 20:
        raise ValueError("Household estimates support up to 20 people.")
    individual = []
    for index, member in enumerate(members, 1):
        if not isinstance(member, dict):
            raise ValueError(f"Person {index} information is invalid.")
        age = member.get("age")
        if isinstance(age, bool) or not isinstance(age, int) or not 2 <= age <= 120:
            raise ValueError(f"Person {index}: use manual goals for infants, or enter an age from 2 to 120.")
        category = member.get("reference_category")
        activity = member.get("activity")
        stage = member.get("special_stage", "none")
        if stage in UNSUPPORTED_STAGES:
            raise ValueError(f"Person {index}: automatic estimates are not appropriate for this life stage. Enter manual goals instead.")
        if stage != "none":
            raise ValueError(f"Person {index}: select a valid life-stage option.")
        if category not in REFERENCE_CATEGORIES:
            raise ValueError(f"Person {index}: choose a reference category or enter manual goals.")
        if activity not in ACTIVITY_INDEX:
            raise ValueError(f"Person {index}: choose an activity reference or enter manual goals.")
        individual.append({
            "person": index,
            "age": age,
            "life_stage": "child" if age <= 13 else "adolescent" if age <= 18 else "older adult" if age >= 65 else "adult",
            "calories_kcal": _calories(age, category, activity),
            "protein_g": _protein(age, category),
            "fiber_g": _fiber(age, category),
        })
    totals = {
        key: sum(person[key] for person in individual)
        for key in ("calories_kcal", "protein_g", "fiber_g")
    }
    count = len(individual)
    averages = {key: round(value / count, 1) for key, value in totals.items()}
    return {"members": individual, "household_daily": totals, "per_person_daily": averages}
