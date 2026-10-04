"""Deterministic meal suggestions built only from an optimized grocery basket."""

from __future__ import annotations

import copy
from collections import defaultdict
from typing import Any

from optimize_grocery import DIET_EXCLUSIONS, NUTRIENTS, nutrient_per_package, product_text
from planning_preferences import FOOD_GROUP_EXCLUSIONS, product_is_diet_compatible
from classify_catalog import optimizer_product_is_supported


PROFILE_ROLES = {
    "oats": {"breakfast"},
    "eggs": {"breakfast", "protein"},
    "milk_2_percent": {"breakfast", "dairy"},
    "cheddar_cheese": {"dairy"},
    "apple": {"breakfast", "fruit", "snack"},
    "banana": {"breakfast", "fruit", "snack"},
    "orange": {"breakfast", "fruit", "snack"},
    "black_beans": {"protein", "legume"}, "chickpeas": {"protein", "legume"},
    "kidney_beans": {"protein", "legume"}, "lentils": {"protein", "legume"},
    "pinto_beans": {"protein", "legume"}, "canned_tuna": {"protein"},
    "chicken_breast": {"protein"}, "peanut_butter": {"breakfast", "snack"},
    "brown_rice": {"grain"}, "white_rice": {"grain"}, "pasta": {"grain"},
    "whole_wheat_bread": {"breakfast", "grain"}, "potato": {"grain", "vegetable"},
    "sweet_potato": {"grain", "vegetable"},
    "broccoli": {"vegetable"}, "carrots": {"vegetable"}, "corn": {"vegetable"},
    "green_beans": {"vegetable"}, "mixed_vegetables": {"vegetable"},
    "onion": {"vegetable"}, "tomato": {"vegetable"},
}

DISPLAY_NAMES = {
    "apple": "Apple", "banana": "Bananas", "orange": "Orange",
    "black_beans": "Black Beans", "brown_rice": "Brown Rice", "canned_tuna": "Tuna",
    "chicken_breast": "Chicken", "chickpeas": "Chickpeas", "cheddar_cheese": "Cheese",
    "eggs": "Eggs", "green_beans": "Green Beans", "kidney_beans": "Kidney Beans",
    "lentils": "Lentils", "milk_2_percent": "Milk", "mixed_vegetables": "Mixed Vegetables",
    "oats": "Oatmeal", "pasta": "Pasta", "peanut_butter": "Peanut Butter", "pinto_beans": "Pinto Beans",
    "sweet_potato": "Sweet Potato", "whole_wheat_bread": "Whole Wheat Bread",
    "white_rice": "White Rice",
}
DISPLAY_EVIDENCE = {
    "apple": ("apple",), "banana": ("banana",), "orange": ("orange",),
    "black_beans": ("black bean",), "brown_rice": ("brown rice",), "canned_tuna": ("tuna",),
    "chicken_breast": ("chicken",), "chickpeas": ("chick pea", "chickpea", "garbanzo"),
    "cheddar_cheese": (" cheese",), "eggs": ("egg",), "green_beans": ("green bean",),
    "kidney_beans": ("kidney bean",), "lentils": ("lentil",), "milk_2_percent": ("milk",),
    "mixed_vegetables": ("mixed vegetable",), "oats": ("oat",), "pasta": ("pasta", "spaghetti"),
    "peanut_butter": ("peanut butter",), "pinto_beans": ("pinto bean",),
    "sweet_potato": ("sweet potato",), "whole_wheat_bread": ("whole wheat bread",),
    "white_rice": ("white rice", "long grain rice"),
}


def meal_display_name(product: dict) -> str:
    """Choose a concise label only when the actual product name supports it."""
    profile = str(product.get("food_profile") or "")
    actual = str(product.get("product_name") or "").strip()
    generic = DISPLAY_NAMES.get(profile)
    evidence = DISPLAY_EVIDENCE.get(profile, ())
    normalized_actual = actual.lower().replace("®", "").replace("™", "")
    if generic and any(term in normalized_actual for term in evidence):
        return generic
    return actual or str(product.get("food_name") or generic or "Food")


def classify_meal_role(product: dict) -> set[str]:
    """Return roles supported by the product's explicit catalog profile/category."""
    profile = str(product.get("food_profile") or "")
    roles = set(PROFILE_ROLES.get(profile, set()))
    category = product.get("food_category")
    if not roles:
        if category == "Fruit": roles.update(("fruit", "snack", "breakfast"))
        elif category == "Vegetables": roles.add("vegetable")
        elif category == "Beans and legumes": roles.update(("protein", "legume"))
        elif category == "Protein": roles.add("protein")
        elif category == "Grains": roles.add("grain")
    return roles


def _allowed(product: dict, diet: str, exclusions: list[str], avoid: list[str]) -> bool:
    profile = str(product.get("food_profile") or "")
    if (not optimizer_product_is_supported(product) or profile in DIET_EXCLUSIONS.get(diet, set())
            or not product_is_diet_compatible(product, diet)):
        return False
    if any(profile in FOOD_GROUP_EXCLUSIONS.get(exclusion, set()) or exclusion in product.get("food_group_exclusions", []) for exclusion in exclusions):
        return False
    text = product_text(product)
    return not any(term and term.lower() in text for term in avoid)


def _pick(items: list[dict], index: int, offset: int = 0) -> dict | None:
    if not items:
        return None
    weighted = [item for item in items for _ in range(max(1, min(int(item.get("quantity", 1)), 4)))]
    return weighted[(index + offset) % len(weighted)]


def _meal(kind: str, products: list[dict | None]) -> dict | None:
    unique = []
    seen = set()
    for product in products:
        identifier = str((product or {}).get("product_id") or (product or {}).get("catalog_id") or "")
        if product and identifier and identifier not in seen:
            seen.add(identifier); unique.append(product)
    if not unique:
        return None
    names = [meal_display_name(item) for item in unique]
    if kind == "Breakfast" and unique[0].get("food_profile") == "oats":
        title = "Oatmeal" + (f" with {names[1]}" if len(names) > 1 else "")
    elif kind in {"Lunch", "Dinner"} and any("legume" in classify_meal_role(item) for item in unique):
        title = " and ".join(names) + (" Bowl" if any("grain" in classify_meal_role(item) for item in unique) else "")
    else:
        title = " + ".join(names)
    return {"meal_type": kind.lower(), "title": title, "products": [
        {"product_id": str(item.get("product_id") or item.get("catalog_id")), "product_name": item.get("product_name")}
        for item in unique
    ]}


def build_daily_meals(groceries: list[dict], day_index: int) -> list[dict]:
    """Compose one day's simple meals from classified basket products."""
    roles: dict[str, list[dict]] = defaultdict(list)
    for item in groceries:
        for role in classify_meal_role(item):
            roles[role].append(item)
    breakfast_base = _pick([x for x in roles["breakfast"] if x.get("food_profile") in {"oats", "eggs", "peanut_butter", "whole_wheat_bread"}], day_index)
    breakfast = _meal("Breakfast", [breakfast_base, _pick(roles["fruit"], day_index), _pick(roles["dairy"], day_index)])
    lunch = _meal("Lunch", [_pick(roles["protein"], day_index), _pick(roles["grain"], day_index), _pick(roles["vegetable"], day_index)])
    dinner = _meal("Dinner", [_pick(roles["protein"], day_index, 1), _pick(roles["grain"], day_index, 1), _pick(roles["vegetable"], day_index, 1)])
    snack = _meal("Snack", [_pick(roles["fruit"], day_index, 1)])
    meals = [meal for meal in (breakfast, lunch, dinner, snack) if meal]
    if not meals and groceries:
        meals = [_meal("Meal", [_pick(groceries, day_index)])]
    return [meal for meal in meals if meal]


def _daily_nutrition(groceries: list[dict], people: int, days: int) -> dict:
    divisor = max(people * days, 1)
    return {nutrient: round(sum(nutrient_per_package(item, nutrient) * int(item.get("quantity", 0)) for item in groceries) / divisor, 2) for nutrient in NUTRIENTS}


def build_nutrition_insights(daily: dict, targets: dict, nutrition_focus: str, groceries: list[dict]) -> list[dict]:
    insights = []
    for nutrient, title in (("protein_g", "Protein"), ("fiber_g", "Fiber")):
        target = float(targets.get(nutrient, 0) or 0); actual = float(daily.get(nutrient, 0) or 0)
        if target:
            if actual >= target:
                insights.append({"status": "met", "text": f"{title} meets the planning reference."})
            elif actual >= target * .85:
                insights.append({"status": "near", "text": f"{title} is slightly below the planning reference."})
            else:
                insights.append({"status": "below", "text": f"{title} is below the planning reference."})
    focus_labels = {"lower_fat": "Lower Fat", "high_protein": "High Protein", "high_fiber": "High Fiber", "lower_sodium": "Lower Sodium"}
    if nutrition_focus in focus_labels:
        insights.append({"status": "applied", "text": f"{focus_labels[nutrition_focus]} planning preference applied to the grocery plan."})
    categories = {item.get("food_category") for item in groceries if item.get("food_category")}
    if len(categories) >= 4:
        insights.append({"status": "met", "text": "Multiple food categories are represented."})
    if {"Fruit", "Vegetables"} & categories:
        insights.append({"status": "tip", "text": "Try distributing fruit and vegetables across multiple meals."})
    return insights


def build_meal_plan(groceries: list[dict], people: int, days: int, diet: str = "omnivore",
                    food_group_exclusions: list[str] | None = None, foods_to_avoid: list[str] | None = None,
                    nutrition_focus: str = "none", targets: dict[str, Any] | None = None) -> dict:
    """Build a deterministic plan without mutating or adding to the supplied basket."""
    source = copy.deepcopy(groceries)
    exclusions, avoid = list(food_group_exclusions or []), list(foods_to_avoid or [])
    eligible = [item for item in source if _allowed(item, diet, exclusions, avoid)]
    rotation_days = min(days, 7)
    daily = _daily_nutrition(eligible, people, days)
    normalized_targets = dict(targets or {})
    return {
        "days_requested": days, "rotation_days": rotation_days, "repeats": days > rotation_days,
        "days": [{"day": index + 1, "meals": build_daily_meals(eligible, index), "nutrition": daily} for index in range(rotation_days)],
        "nutrition_insights": build_nutrition_insights(daily, normalized_targets, nutrition_focus, eligible),
        "products_used": sorted({product["product_id"] for day in range(rotation_days) for meal in build_daily_meals(eligible, day) for product in meal["products"]}),
        "portion_note": "Meal suggestions are based on the planned basket and are not exact portion allocations.",
        "disclaimer": "NutriCart provides general grocery-planning information, not medical or dietary advice.",
    }
