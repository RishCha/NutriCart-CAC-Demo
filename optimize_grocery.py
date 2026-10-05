import json
import math
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

import pulp

from classify_catalog import optimizer_product_is_supported
from catalog_config import catalog_path
from package_units import normalize_package_size
from planning_preferences import FOOD_GROUP_EXCLUSIONS, NUTRITION_FOCUS_NUTRIENTS, product_matches_exclusion, product_is_diet_compatible, score_plan_breakdown
from snap_store_locator import run_snap_store_lookup

# 1. CONSTANTS AND CONFIGURATION
ROOT = Path(__file__).resolve().parent
CATALOG_FILE = catalog_path("food")
OUTPUT_FILE = ROOT / "data" / "optimized_plan.json"
NUTRIENTS = {
    "calories_kcal": ("package_calories_kcal", "calories_kcal", "kcal"),
    "protein_g": ("package_protein_g", "protein_g", "g"),
    "carbohydrates_g": ("package_carbohydrates_g", "carbohydrates_g", "g"),
    "fat_g": ("package_fat_g", "fat_g", "g"),
    "fiber_g": ("package_fiber_g", "fiber_g", "g"),
    "sodium_mg": ("package_sodium_mg", "sodium_mg", "mg"),
}
LAND_ANIMAL_PROFILES = set("beef ground_beef pork pork_chops bacon ham chicken chicken_breast chicken_thighs turkey ground_turkey lamb veal sausage".split())
SEAFOOD_PROFILES = {"canned_tuna", "salmon", "shrimp", "cod", "tilapia", "sardines"}
EGG_AND_DAIRY_PROFILES = {"eggs", "milk_2_percent", "plain_yogurt", "cheddar_cheese"}
DIET_EXCLUSIONS = {
    "omnivore": set(),
    "pescatarian": LAND_ANIMAL_PROFILES,
    "vegetarian": LAND_ANIMAL_PROFILES | SEAFOOD_PROFILES,
    "vegan": LAND_ANIMAL_PROFILES | SEAFOOD_PROFILES | EGG_AND_DAIRY_PROFILES,
}
RANGES = {
    "calories_kcal": (0.95, 1.05), "protein_g": (0.80, 1.35),
    "carbohydrates_g": (0.80, 1.20), "fat_g": (0.75, 1.20),
    "fiber_g": (0.85, None), "sodium_mg": (None, 1.00),
}
DEFICIENCY_WEIGHTS = {
    "calories_kcal": 260, "protein_g": 120, "carbohydrates_g": 100,
    "fat_g": 140, "fiber_g": 150,
}
EXCESS_WEIGHTS = {
    "calories_kcal": 200, "protein_g": 90, "carbohydrates_g": 160,
    "fat_g": 120, "sodium_mg": 150,
}
CATEGORY_REQUIREMENTS = {
    "Fruit": ({"Fruit"}, 2), "Vegetables": ({"Vegetables"}, 2),
    "Grains": ({"Grains"}, 2),
    "Protein sources": ({"Protein", "Beans and legumes"}, 2),
}


# 2. INPUT AND VALIDATION HELPERS
def prompt_number(prompt: str, minimum: float, maximum: float | None, integer: bool = False) -> float | int:
    """Prompt until a required number inside the requested range is entered."""
    while True:
        raw = input(f"{prompt}: ").strip().replace("$", "").replace(",", "")
        try:
            value = int(raw) if integer else float(raw)
        except ValueError:
            print("Please enter a valid whole number." if integer else "Please enter a valid number.")
            continue
        if value >= minimum and (maximum is None or value <= maximum):
            return value
        print(f"Enter a value of at least {minimum:g}." if maximum is None else f"Enter a value from {minimum:g} to {maximum:g}.")

def prompt_choice(prompt: str, choices: dict[str, str]) -> str:
    while True:
        answer = input(f"{prompt}: ").strip().lower()
        if answer in choices:
            return choices[answer]
        print("Choose one of: " + ", ".join(choices))

def parse_avoid_list(raw: str) -> list[str]:
    normalize = lambda text: re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", text.lower())).strip()
    return [term for part in re.split(r"[,;]", raw) if (term := normalize(part))]

def suggest_calorie_correction(value: float) -> float:
    if value == 180:
        answer = prompt_choice("Did you mean 1800 calories? [y/n]", {"y": "yes", "yes": "yes", "n": "no", "no": "no"})
        if answer == "yes":
            return 1800.0
    return value

def default_fiber_target(calories: float) -> float:
    return round(14 * calories / 1000, 1)

def collect_inputs() -> dict:
    print("\n==================================================\nCREATE YOUR GROCERY PLAN\n==================================================\n")
    values = {
        "budget": prompt_number("Budget in dollars", 10, maximum=None),
        "people": prompt_number("Number of people", 1, 20, True),
        "days": prompt_number("Number of days", 1, 31, True),
    }
    print("\n--------------------------------------------------\nDIET PREFERENCE\n--------------------------------------------------\n  1. Omnivore\n     Includes meat, fish, eggs, and dairy\n\n  2. Vegetarian\n     Excludes meat and fish\n\n  3. Vegan\n     Excludes meat, fish, eggs, and dairy\n\n  4. Pescatarian\n     Includes fish but excludes other meat\n")
    values["diet"] = prompt_choice("Select a diet [1-4]", {
        "1": "omnivore", "2": "vegetarian", "3": "vegan", "4": "pescatarian",
        **{name: name for name in DIET_EXCLUSIONS},
    })
    print("\n--------------------------------------------------\nPLAN PRIORITY\n--------------------------------------------------\n  1. Balanced\n     Balance cost, nutrition, and variety\n\n  2. Budget\n     Prioritize the lowest possible cost\n\n  3. Nutrition\n     Prioritize reaching nutrition targets\n\n  4. Variety\n     Prioritize a wider selection of foods\n")
    values["preference"] = prompt_choice("Select a priority [1-4]", {
        "1": "balanced", "2": "budget", "3": "nutrition", "4": "variety",
        "balanced": "balanced", "budget": "budget", "nutrition": "nutrition", "variety": "variety",
    })
    values["avoid"] = parse_avoid_list(input("Foods to avoid (comma-separated, optional): ").strip())
    while True:
        calories = suggest_calorie_correction(prompt_number("Daily calories per person", 100, 5000))
        if calories >= 500:
            values["calories"] = calories
            break
        print("Daily calories must be at least 500; please try again.")
    values["protein"] = prompt_number("Daily protein grams per person", 10, 300)
    automatic = default_fiber_target(values["calories"])
    print(f"\n--------------------------------------------------\nDAILY FIBER GOAL\n--------------------------------------------------\nBased on your {values['calories']:g}-calorie goal, NutriCart\nrecommends {automatic:g} grams of fiber per day.\n\nFiber is included to help create a more balanced\ngrocery plan.\n\n  1. Use the recommended goal\n  2. Enter my own fiber goal\n")
    fiber_mode = prompt_choice("Choose [1-2]", {"1": "recommended", "y": "recommended", "yes": "recommended", "2": "custom", "n": "custom", "no": "custom"})
    values["fiber"] = automatic if fiber_mode == "recommended" else prompt_number("Daily fiber grams per person", 5, 100)
    values["fiber_source"] = fiber_mode
    return values

def review_and_edit_inputs(values: dict) -> str:
    fields = ["budget", "people", "days", "diet", "preference", "avoid", "calories", "protein", "fiber"]
    while True:
        print("\nINPUT REVIEW")
        for number, field in enumerate(fields, 1):
            value = ", ".join(values[field]) or "none" if field == "avoid" else values[field]
            label = f"Fiber goal: {value:g} g/day ({values['fiber_source']})" if field == "fiber" else f"{field.replace('_', ' ').title()}: {value}"
            print(f"  {number}. {label}")
        action = prompt_choice("[G]enerate, [E]dit one field, [S]tart over, [Q]uit", {
            "g": "generate", "generate": "generate", "e": "edit", "edit": "edit",
            "s": "start", "start": "start", "q": "quit", "quit": "quit",
        })
        if action != "edit":
            return action
        selected = prompt_number("Field number to edit", 1, len(fields), True)
        field = fields[selected - 1]
        if field in {"budget", "people", "days", "calories", "protein", "fiber"}:
            limits = {"budget": (10, None), "people": (1, 20), "days": (1, 31), "calories": (100, 5000), "protein": (10, 300), "fiber": (5, 100)}
            values[field] = prompt_number(field.title(), *limits[field], integer=field in {"people", "days"})
            if field == "calories":
                values[field] = suggest_calorie_correction(values[field])
                while values[field] < 500:
                    print("Daily calories must be at least 500; please try again.")
                    values[field] = suggest_calorie_correction(prompt_number("Daily calories", 100, 5000))
            elif field == "fiber":
                values["fiber_source"] = "custom"
        elif field == "avoid":
            values[field] = parse_avoid_list(input("Foods to avoid: "))
        elif field == "diet":
            values[field] = prompt_choice("Diet", {name: name for name in DIET_EXCLUSIONS})
        else:
            values[field] = prompt_choice("Preference", {
                name: name for name in ("balanced", "budget", "nutrition", "variety")
            })

# 3. CATALOG FILTERING AND PULP OPTIMIZATION
def load_catalog() -> list[dict]:
    with CATALOG_FILE.open(encoding="utf-8") as stream:
        catalog = json.load(stream)
    if not isinstance(catalog, list) or not catalog:
        raise ValueError("The catalog must be a non-empty JSON list.")
    return [{**product, "package_size": normalize_package_size(product.get("package_size"))}
            for product in catalog if optimizer_product_is_supported(product)]

def _number(value: Any, default: float = 0.0) -> float:
    try:
        return default if isinstance(value, bool) else float(value)
    except (TypeError, ValueError):
        return default

def product_text(product: dict) -> str:
    fields = ("product_name", "brand", "food_name", "food_profile", "food_category")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", " ".join(str(product.get(k) or "") for k in fields).lower())).strip()

def filter_catalog(
    catalog: list[dict],
    diet: str,
    avoid: list[str],
    food_group_exclusions: list[str] | None = None,
) -> tuple[list[dict], list[dict]]:
    accepted, removed = [], []
    exclusions = food_group_exclusions or []
    for product in catalog:
        profile, text = str(product.get("food_profile") or ""), product_text(product)
        reason = None
        if not optimizer_product_is_supported(product):
            reason = "unsupported product form"
        elif profile in DIET_EXCLUSIONS[diet] or not product_is_diet_compatible(product, diet):
            reason = f"excluded by {diet} diet"
        elif any(product_matches_exclusion(product, exclusion) for exclusion in exclusions):
            reason = "excluded food group"
        elif any(term in text for term in avoid):
            reason = "matched foods to avoid"
        elif _number(product.get("effective_price")) <= 0:
            reason = "invalid price"
        elif not 0 < _number(product.get("package_weight_g")) <= 10000:
            reason = "invalid package weight"
        (removed if reason else accepted).append({"product": product, "reason": reason} if reason else product)
    return accepted, removed

def nutrient_per_package(product: dict, nutrient: str) -> float:
    package_field, basis_field, _ = NUTRIENTS[nutrient]
    package_value = _number(product.get(package_field), -1)
    return package_value if package_value >= 0 else _number(product.get(basis_field)) * _number(product.get("package_weight_g")) / 100

def package_upper_bound(product: dict, people: int, days: int) -> int:
    weight, person_days = _number(product.get("package_weight_g")), people * days
    if weight < 150:
        return min(16, max(3, math.ceil(person_days / 3)))
    if weight < 500:
        return min(10, max(2, math.ceil(person_days / 5)))
    if weight < 1000:
        return min(6, max(2, math.ceil(person_days / 7)))
    return min(4, max(1, math.ceil(person_days / 10)))

def build_model(products: list[dict], values: dict, excluded_ids: set[str] | None = None,
                minimum_changes: int = 1, prior_product_id_sets: list[set[str]] | None = None) -> tuple:
    model = pulp.LpProblem("NutriCart_Grocery_Optimization", pulp.LpMinimize)
    indexes, people, days = range(len(products)), values["people"], values["days"]
    limits = {i: package_upper_bound(products[i], people, days) for i in indexes}
    quantities = {i: pulp.LpVariable(f"quantity_{i}", 0, limits[i], cat=pulp.LpInteger) for i in indexes}
    selected = {i: pulp.LpVariable(f"selected_{i}", 0, 1, cat=pulp.LpBinary) for i in indexes}
    for i in indexes:
        model += quantities[i] <= limits[i] * selected[i]
        model += quantities[i] >= selected[i]
    prices = {i: _number(products[i].get("effective_price")) for i in indexes}
    amounts = {n: {i: nutrient_per_package(products[i], n) for i in indexes} for n in NUTRIENTS}
    total_cost = pulp.lpSum(prices[i] * quantities[i] for i in indexes)
    totals = {n: pulp.lpSum(amounts[n][i] * quantities[i] for i in indexes) for n in NUTRIENTS}
    model += total_cost <= values["budget"]
    # An explicit preference is a constraint, not a change to objective weights.
    if values.get("include_fish"):
        model += pulp.lpSum(selected[i] for i in indexes
                            if products[i].get("food_profile") in SEAFOOD_PROFILES) >= 1

    profile_groups, category_groups = defaultdict(list), defaultdict(list)
    for i, product in enumerate(products):
        profile_groups[str(product.get("food_profile") or product.get("food_name") or i)].append(i)
        category_groups[str(product.get("food_category") or "Other")].append(i)
    for group in profile_groups.values():
        model += pulp.lpSum(selected[i] for i in group) <= 1
    for group in category_groups.values():
        model += pulp.lpSum(selected[i] for i in group) <= 5
    model += pulp.lpSum(selected.values()) <= min(15, max(10, people * 2 + 7))
    if excluded_ids:
        original = [i for i, product in enumerate(products) if str(product.get("product_id") or product.get("catalog_id")) in excluded_ids]
        if original:
            original_profiles = {str(products[i].get("food_profile") or products[i].get("food_name") or i) for i in original}
            retained = [i for i, product in enumerate(products) if str(product.get("food_profile") or product.get("food_name") or i) in original_profiles]
            required = min(max(minimum_changes, 0), len(original_profiles))
            model += pulp.lpSum(selected[i] for i in retained) <= len(original_profiles) - required
            model += pulp.lpSum(selected.values()) >= len(original)
    for reference_ids in prior_product_id_sets or []:
        reference = [i for i, product in enumerate(products) if str(product.get("product_id") or product.get("catalog_id")) in reference_ids]
        if reference:
            profiles = {str(products[i].get("food_profile") or products[i].get("food_name") or i) for i in reference}
            retained = [i for i, product in enumerate(products) if str(product.get("food_profile") or product.get("food_name") or i) in profiles]
            required = min(max(minimum_changes, 0), len(profiles))
            model += pulp.lpSum(selected[i] for i in retained) <= len(profiles) - required

    targets = {
        "calories_kcal": values["calories"], "protein_g": values["protein"],
        "carbohydrates_g": values["calories"] * 0.50 / 4,
        "fat_g": values["calories"] * 0.30 / 9, "fiber_g": values["fiber"], "sodium_mg": 2300,
    }
    target_totals = {n: target * people * days for n, target in targets.items()}
    target_ranges = {n: (target_totals[n] * low if low else None, target_totals[n] * high if high else None) for n, (low, high) in RANGES.items()}
    deficiencies, excesses = {}, {}
    for nutrient, (minimum, maximum) in target_ranges.items():
        if minimum is not None:
            if nutrient in ("calories_kcal", "protein_g", "fiber_g"):
                model += totals[nutrient] >= minimum  # Same floors as final acceptance.
            deficiencies[nutrient] = pulp.LpVariable(f"{nutrient}_deficiency", lowBound=0, cat=pulp.LpContinuous)
            model += totals[nutrient] + deficiencies[nutrient] >= minimum
        if maximum is not None:
            excesses[nutrient] = pulp.LpVariable(f"{nutrient}_excess", lowBound=0, cat=pulp.LpContinuous)
            model += totals[nutrient] - excesses[nutrient] <= maximum

    requirements = dict(CATEGORY_REQUIREMENTS)
    if values["diet"] != "vegan":
        requirements["Eggs and dairy"] = ({"Eggs and dairy"}, 1)
    missing = {}
    for name, (categories, required) in requirements.items():
        group = [i for i, p in enumerate(products) if p.get("food_category") in categories]
        if group:
            missing[name] = pulp.LpVariable("missing_" + re.sub(r"\W+", "_", name.lower()), 0, required, cat=pulp.LpInteger)
            model += pulp.lpSum(selected[i] for i in group) + missing[name] >= required
    target_variety = min(12, max(10, people + 8))
    variety_shortfall = pulp.LpVariable("variety_shortfall", 0, target_variety, cat=pulp.LpInteger)
    model += pulp.lpSum(selected.values()) + variety_shortfall >= target_variety

    nutrition_scale = 1.15 if values["preference"] == "nutrition" else 1.0
    category_scale = 1.35 if values["preference"] == "variety" else 1.0
    cost_scale = 2.0 if values["preference"] == "budget" else 1.0
    objective = [nutrition_scale * DEFICIENCY_WEIGHTS[n] * v / max(target_ranges[n][0], 1) for n, v in deficiencies.items()]
    objective += [nutrition_scale * EXCESS_WEIGHTS[n] * v / max(target_ranges[n][1], 1) for n, v in excesses.items()]
    objective += [category_scale * 35 * variable for variable in missing.values()]
    objective += [category_scale * 20 * variety_shortfall, cost_scale * 3 * total_cost / max(values["budget"], 1), 0.10 * pulp.lpSum(selected.values())]
    nutrition_focus = values.get("nutrition_focus", "none")
    if nutrition_focus in NUTRITION_FOCUS_NUTRIENTS:
        nutrient, weight = NUTRITION_FOCUS_NUTRIENTS[nutrition_focus]
        objective.append(weight * totals[nutrient] / max(target_totals[nutrient], 1))
    model += pulp.lpSum(objective)
    return model, quantities, selected, prices, targets, target_ranges

def solve_plan(products: list[dict], values: dict, excluded_ids: set[str] | None = None,
               prior_product_id_sets: list[set[str]] | None = None) -> dict:
    requested_changes = max(2, math.ceil(len(excluded_ids) * 0.25)) if excluded_ids else 0
    requested_changes = min(requested_changes, len(excluded_ids or []))
    attempts = range(requested_changes, -1, -1) if excluded_ids else (0,)
    last_result = None
    for minimum_changes in attempts:
        model, quantities, _, prices, targets, ranges = build_model(products, values, excluded_ids, minimum_changes, prior_product_id_sets)
        status = pulp.LpStatus.get(model.solve(pulp.PULP_CBC_CMD(msg=False)), "Unknown")
        groceries = []
        for i, product in enumerate(products) if status in {"Optimal", "Feasible"} else []:
            quantity = int(round(quantities[i].value() or 0))
            if quantity > 0:
                groceries.append({**product, "quantity": quantity, "unit_price": round(prices[i], 2), "total_cost": round(prices[i] * quantity, 2)})
        original_profiles = {str(item.get("food_profile") or item.get("food_name")) for item in products if str(item.get("product_id") or item.get("catalog_id")) in (excluded_ids or set())}
        selected_profiles = {str(item.get("food_profile") or item.get("food_name")) for item in groceries}
        last_result = {
            "status": status, "groceries": groceries, "targets": targets, "target_ranges": ranges,
            "alternative_requested_changes": requested_changes,
            "alternative_required_changes": minimum_changes,
            "alternative_difference_count": len(original_profiles - selected_profiles),
        }
        if status in {"Optimal", "Feasible"}: return last_result
    return last_result

def explain_no_plan(status: str, eligible: int) -> None:
    print(f"\nNo grocery plan was produced (solver status: {status}).")
    if not eligible:
        print("All catalog products were removed by diet, avoidance, price, or weight checks.")
    else:
        print("Try increasing the budget, reducing days or people, relaxing foods to avoid, or choosing another diet.")


# 4. SCORING AND RESULT DISPLAY
def summarize_plan(plan: dict, values: dict) -> dict:
    totals = {nutrient: 0.0 for nutrient in NUTRIENTS}
    for product in plan["groceries"]:
        for nutrient in NUTRIENTS:
            totals[nutrient] += nutrient_per_package(product, nutrient) * product["quantity"]
    divisor = max(values["people"] * values["days"], 1)
    return {
        "total_cost": round(sum(item["total_cost"] for item in plan["groceries"]), 2),
        "nutrition_totals": {key: round(value, 2) for key, value in totals.items()},
        "nutrition_per_person_per_day": {key: round(value / divisor, 2) for key, value in totals.items()},
    }


def score_plan(summary: dict, targets: dict, groceries: list[dict]) -> float:
    return score_plan_breakdown(summary, targets, groceries)["score"]

def display_plan(plan: dict, summary: dict, values: dict) -> None:
    print("\nNUTRICART GROCERY PLAN")
    print(f"Solver status: {plan['status']}")
    for product in sorted(plan["groceries"], key=lambda p: (str(p.get("food_category")), str(p.get("product_name")))):
        identifier = product.get("product_id") or product.get("catalog_id")
        print(f"  {product['quantity']} x {product.get('product_name')} [{identifier}] - ${product['total_cost']:.2f}")
    print(f"Total grocery cost: ${summary['total_cost']:.2f}")
    print(f"Remaining budget: ${values['budget'] - summary['total_cost']:.2f}")
    print("Per-person-per-day nutrition:")
    for nutrient, (_, _, unit) in NUTRIENTS.items():
        print(f"  {nutrient}: {summary['nutrition_per_person_per_day'][nutrient]:.1f} {unit}")
    print(f"PROJECT-DEFINED QUALITY SCORE: {score_plan(summary, plan['targets'], plan['groceries']):.1f}/100")
    estimated = sum(bool(product.get("nutrition_is_estimated", True)) for product in plan["groceries"])
    if estimated:
        print(f"WARNING: {estimated} selected product(s) use estimated nutrition data.")


def display_disclaimer() -> None:
    print("Educational planning tool only; this is not medical or dietary advice.")


# 5. REVIEW, RERUN, SAVE, AND MAIN
def save_plan(plan: dict, summary: dict, values: dict, catalog_count: int, eligible_count: int) -> None:
    output = {
        "inputs": values, "daily_targets_per_person": plan["targets"], "solver_status": plan["status"],
        "summary": {"catalog_products": catalog_count, "eligible_products": eligible_count, "selected_products": len(plan["groceries"]), "total_cost": summary["total_cost"], "budget_remaining": round(values["budget"] - summary["total_cost"], 2)},
        "groceries": plan["groceries"], "nutrition_totals": summary["nutrition_totals"],
        "nutrition_per_person_per_day": summary["nutrition_per_person_per_day"],
        "nutrition_data_note": "Products marked nutrition_is_estimated=true use estimated values for a comparable food.",
    }
    with OUTPUT_FILE.open("w", encoding="utf-8") as stream:
        json.dump(output, stream, indent=2, ensure_ascii=False)
    print(f"Saved plan: {OUTPUT_FILE}")

def plan_menu(catalog: list[dict], values: dict) -> str:
    eligible, removed = filter_catalog(
        catalog, values["diet"], values["avoid"], values.get("food_group_exclusions", [])
    )
    print(f"Eligible products: {len(eligible)}; filtered out: {len(removed)}")
    previous_ids: set[str] | None = None
    plan = summary = None
    while True:
        plan = solve_plan(eligible, values, previous_ids)
        if not plan["groceries"]:
            explain_no_plan(plan["status"], len(eligible))
        else:
            summary = summarize_plan(plan, values)
            display_plan(plan, summary, values)
        while True:
            action = prompt_choice("[R]erun, [A]lternative, [V]Save, [S]tart over, [Q]uit", {
                "r": "rerun", "rerun": "rerun", "a": "alternative", "alternative": "alternative",
                "v": "save", "save": "save", "s": "start", "start": "start", "q": "quit", "quit": "quit",
            })
            if action == "save":
                if plan["groceries"] and summary:
                    save_plan(plan, summary, values, len(catalog), len(eligible))
                else:
                    print("There is no plan to save.")
                continue
            if action == "alternative" and not plan["groceries"]:
                print("Generate a plan before requesting an alternative.")
                continue
            break
        if action == "alternative":
            previous_ids = {str(p.get("product_id") or p.get("catalog_id")) for p in plan["groceries"]}
        elif action in {"start", "quit"}:
            return action
        else:
            previous_ids = None

def main() -> None:
    print("NUTRICART GROCERY OPTIMIZER")
    display_disclaimer()
    try:
        catalog = load_catalog()
        print(f"Catalog products available: {len(catalog)}")
        run_snap_store_lookup()
        while True:
            values = collect_inputs()
            action = review_and_edit_inputs(values)
            if action == "quit":
                print("Quit without saving.")
                return
            if action == "start":
                continue
            if plan_menu(catalog, values) == "quit":
                print("Goodbye.")
                return
    except KeyboardInterrupt:
        print("\nCancelled safely. No automatic save was performed.")
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Cannot start NutriCart: {error}")

if __name__ == "__main__":
    main()
