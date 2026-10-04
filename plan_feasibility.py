"""Catalog-derived feasibility guidance and post-solve acceptance checks."""

from typing import Any

import pulp

from optimize_grocery import RANGES, build_model, nutrient_per_package, package_upper_bound


CORE_NUTRIENTS = ("calories_kcal", "protein_g", "fiber_g")
MIN_ACCEPTABLE_PLAN_SCORE = 60.0


def _number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def minimum_feasible_cost(products: list[dict], values: dict) -> float | None:
    """Return the least catalog cost meeting existing core nutrition floors.

    This uses the optimizer's package, profile, category, and selection constraints,
    but replaces its soft nutrition objective with hard calorie/protein/fiber floors.
    It is a feasibility estimate, not a complete grocery-plan recommendation.
    """

    if not products:
        return None
    maximum_catalog_cost = sum(
        _number(product.get("effective_price"))
        * package_upper_bound(product, values["people"], values["days"])
        for product in products
    )
    if maximum_catalog_cost <= 0:
        return None
    probe = {**values, "budget": maximum_catalog_cost}
    model, quantities, _selected, prices, targets, _ranges = build_model(products, probe)
    indexes = range(len(products))
    for nutrient in CORE_NUTRIENTS:
        floor = targets[nutrient] * values["people"] * values["days"] * RANGES[nutrient][0]
        model += pulp.lpSum(
            nutrient_per_package(products[index], nutrient) * quantities[index]
            for index in indexes
        ) >= floor
    total_cost = pulp.lpSum(prices[index] * quantities[index] for index in indexes)
    model.setObjective(total_cost)
    status = pulp.LpStatus.get(model.solve(pulp.PULP_CBC_CMD(msg=False)), "Unknown")
    if status not in {"Optimal", "Feasible"}:
        return None
    return round(float(pulp.value(total_cost) or 0), 2)


def _maximum_supported(
    products: list[dict], values: dict, dimension: str, maximum: int, budget: float,
    minimum_cache: dict[tuple[int, int], float | None],
) -> int:
    def cost_at(candidate: int) -> float | None:
        people = candidate if dimension == "people" else values["people"]
        days = candidate if dimension == "days" else values["days"]
        key = (people, days)
        if key not in minimum_cache:
            minimum_cache[key] = minimum_feasible_cost(products, {**values, "people": people, "days": days})
        return minimum_cache[key]

    low, high, answer = 1, maximum, 0
    while low <= high:
        middle = (low + high) // 2
        cost = cost_at(middle)
        if cost is not None and cost <= budget + 0.005:
            answer, low = middle, middle + 1
        else:
            high = middle - 1
    return answer


def feasibility_guidance(products: list[dict], values: dict) -> dict:
    """Calculate only guidance supported by the currently supplied inputs."""

    budget, people, days = values.get("budget"), values.get("people"), values.get("days")
    minimum_cache: dict[tuple[int, int], float | None] = {}

    def minimum_for(current_people: int, current_days: int) -> float | None:
        key = (current_people, current_days)
        if key not in minimum_cache:
            minimum_cache[key] = minimum_feasible_cost(
                products, {**values, "people": current_people, "days": current_days}
            )
        return minimum_cache[key]

    guidance = {"budget": None, "people": None, "days": None}
    if people is not None and days is not None:
        guidance["budget"] = minimum_for(people, days)
    if budget is not None and days is not None:
        guidance["people"] = _maximum_supported(
            products, {**values, "people": people or 1, "days": days},
            "people", 20, budget, minimum_cache,
        )
    if budget is not None and people is not None:
        guidance["days"] = _maximum_supported(
            products, {**values, "people": people, "days": days or 1},
            "days", 31, budget, minimum_cache,
        )

    status, message, shortfall = "incomplete", "", None
    minimum = guidance["budget"]
    if budget is not None and people is not None and days is not None:
        if minimum is None:
            status = "clearly_infeasible"
            message = "A complete plan is not available with the current food options. Try reducing the number of people or days, or adjusting excluded foods."
        elif budget + 0.005 < minimum:
            status = "clearly_infeasible"
            shortfall = round(minimum - budget, 2)
            message = "This budget may be too low for a complete plan. Try increasing your budget or reducing the number of days."
        else:
            status = "potentially_feasible"
            message = "Potentially feasible. A complete plan is confirmed only after generation."
    return {
        "status": status, "message": message, "shortfall": shortfall,
        "guidance": guidance,
        "basis": values.get("nutrition_basis", "general"),
    }


def plan_acceptance(plan: dict, summary: dict, score: float) -> dict:
    """Apply the project-defined, non-medical final acceptance gate."""

    status = str(plan.get("status") or "Unknown")
    if status not in {"Optimal", "Feasible"}:
        return {"accepted": False, "status": "clearly_infeasible", "score_threshold": MIN_ACCEPTABLE_PLAN_SCORE, "nutrition_checks": {}}
    if not plan.get("target_ranges"):
        return {"accepted": True, "status": "feasible", "assessed": False, "score_threshold": MIN_ACCEPTABLE_PLAN_SCORE, "nutrition_checks": {}}
    daily = summary.get("nutrition_per_person_per_day", {})
    checks = {}
    for nutrient in CORE_NUTRIENTS:
        target = _number(plan.get("targets", {}).get(nutrient))
        actual = _number(daily.get(nutrient))
        minimum = target * RANGES[nutrient][0]
        checks[nutrient] = {
            "actual": round(actual, 2), "minimum": round(minimum, 2),
            "passes": actual + 0.005 >= minimum,
        }
    accepted = score + 0.005 >= MIN_ACCEPTABLE_PLAN_SCORE and all(item["passes"] for item in checks.values())
    return {
        "accepted": accepted, "status": "feasible" if accepted else "clearly_infeasible",
        "assessed": True, "score": score, "score_threshold": MIN_ACCEPTABLE_PLAN_SCORE,
        "nutrition_checks": checks,
        "disclaimer": "This is a project planning gate, not a medical nutrition standard.",
    }
