"""Deterministic meal suggestions built only from an optimized grocery basket."""

from __future__ import annotations

import copy
import re
from collections import defaultdict
from typing import Any

from optimize_grocery import DIET_EXCLUSIONS, NUTRIENTS, nutrient_per_package, product_text
from planning_preferences import FOOD_GROUP_EXCLUSIONS, product_is_diet_compatible
from classify_catalog import optimizer_product_is_supported


PROFILE_ROLES = {
    "oats": {"breakfast"},
    "eggs": {"breakfast", "protein"},
    "milk_2_percent": {"breakfast", "dairy"}, "plain_yogurt": {"breakfast", "dairy", "snack"},
    "soy_beverage": {"breakfast", "dairy"},
    "cheddar_cheese": {"dairy"},
    "apple": {"breakfast", "fruit", "snack"},
    "banana": {"breakfast", "fruit", "snack"},
    "orange": {"breakfast", "fruit", "snack"},
    "black_beans": {"protein", "legume"}, "chickpeas": {"protein", "legume"},
    "kidney_beans": {"protein", "legume"}, "lentils": {"protein", "legume"},
    "pinto_beans": {"protein", "legume"}, "canned_tuna": {"protein", "fish"},
    "chicken_breast": {"protein"}, "peanut_butter": {"breakfast", "snack"},
    "salmon": {"protein", "fish"}, "tofu": {"protein"},
    "peanuts": {"snack"}, "sunflower_seeds": {"snack"},
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
    "white_rice": "White Rice", "potato": "Potatoes", "carrots": "Carrots",
    "broccoli": "Broccoli", "spinach": "Spinach", "onion": "Onions",
    "tomato": "Tomatoes", "cabbage": "Cabbage", "tofu": "Tofu",
    "salmon": "Salmon", "pear": "Pears", "strawberry": "Strawberries",
    "soy_beverage": "Soy Beverage", "plain_yogurt": "Yogurt",
    "peanuts": "Peanuts", "sunflower_seeds": "Sunflower Seeds",
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
    "white_rice": ("white rice", "long grain rice"), "potato": ("potato",),
    "carrots": ("carrot",), "broccoli": ("broccoli",), "spinach": ("spinach",),
    "onion": ("onion",), "tomato": ("tomato",), "cabbage": ("cabbage",),
    "tofu": ("tofu",), "salmon": ("salmon",), "pear": ("pear",),
    "strawberry": ("strawberr",), "soy_beverage": ("soy beverage",),
    "plain_yogurt": ("yogurt",),
    "peanuts": ("peanut",), "sunflower_seeds": ("sunflower",),
}

TITLE_NAMES = {
    "black_beans": "Black Bean", "brown_rice": "Brown Rice", "canned_tuna": "Tuna",
    "chickpeas": "Chickpea", "eggs": "Egg", "kidney_beans": "Kidney Bean",
    "lentils": "Lentil", "pinto_beans": "Pinto Bean", "potato": "Potato",
    "sweet_potato": "Sweet Potato", "salmon": "Salmon", "tofu": "Tofu",
    "white_rice": "White Rice", "mixed_vegetables": "Vegetable",
}

CATALOG_QUALIFIERS = re.compile(
    r"^(?:raw|dry(?: roasted)?|dried|uncooked|cooked|long[- ]grain|prepared from\b.*|includes? foods?\b.*)$",
    re.IGNORECASE,
)


def _clean_catalog_name(value: str) -> str:
    """Remove preparation/source qualifiers from a user-facing label only."""
    cleaned = value.replace("®", "").replace("™", "").strip()
    parts = [part.strip() for part in cleaned.split(",") if part.strip()]
    if not parts:
        return "Food"
    visible = [parts[0]] + [part for part in parts[1:] if not CATALOG_QUALIFIERS.match(part)]
    return ", ".join(visible)


def meal_display_name(product: dict) -> str:
    """Choose a concise label only when the actual product name supports it."""
    profile = str(product.get("food_profile") or "")
    actual = str(product.get("product_name") or "").strip()
    generic = DISPLAY_NAMES.get(profile)
    evidence = DISPLAY_EVIDENCE.get(profile, ())
    normalized_actual = actual.lower().replace("®", "").replace("™", "")
    if generic and any(term in normalized_actual for term in evidence):
        return generic
    return _clean_catalog_name(actual or str(product.get("food_name") or generic or "Food"))


def meal_title_name(product: dict) -> str:
    """Return a concise noun form suitable inside a meal title."""
    return TITLE_NAMES.get(str(product.get("food_profile") or ""), meal_display_name(product))


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
    return items[(index + offset) % len(items)]


def _directions(products: list[dict]) -> list[str]:
    """Return short preparation steps that mention only foods in this meal."""
    steps = []
    for product in products:
        name = meal_display_name(product)
        profile = str(product.get("food_profile") or "")
        roles = classify_meal_role(product)
        if "fish" in roles or profile == "chicken_breast":
            steps.append(f"Cook {name} thoroughly until it reaches a safe internal temperature.")
        elif profile == "eggs":
            steps.append(f"Cook {name} thoroughly.")
        elif profile in {"oats", "brown_rice", "white_rice", "pasta", "black_beans", "chickpeas", "kidney_beans", "lentils", "pinto_beans"}:
            steps.append(f"Prepare {name} according to the package directions.")
        elif "vegetable" in roles or profile == "tofu":
            steps.append(f"Cook {name} until ready to eat.")
        else:
            steps.append(f"Prepare {name} as needed.")
    names = [meal_display_name(product) for product in products]
    if len(steps) < 4:
        if len(names) > 1:
            food_list = f"{names[0]} and {names[1]}" if len(names) == 2 else f"{', '.join(names[:-1])}, and {names[-1]}"
            steps.append(f"Combine {food_list}.")
        else:
            steps.append(f"Serve {names[0]}.")
    return steps[:4]


def _meal(kind: str, products: list[dict | None], variant: int = 0) -> dict | None:
    unique = []
    seen = set()
    for product in products:
        identifier = str((product or {}).get("product_id") or (product or {}).get("catalog_id") or "")
        if product and identifier and identifier not in seen:
            seen.add(identifier); unique.append(product)
    if not unique:
        return None
    names = [meal_display_name(item) for item in unique]
    profiles = [str(item.get("food_profile") or "") for item in unique]
    if kind == "Breakfast" and "oats" in profiles:
        fruit = next((meal_display_name(item) for item in unique if "fruit" in classify_meal_role(item)), "")
        if fruit and variant % 2:
            title = f"{fruit} Oatmeal Bowl"
        else:
            title = "Oatmeal" + (f" with {fruit}" if fruit else "")
    elif kind == "Breakfast" and "eggs" in profiles:
        vegetable = next((meal_display_name(item) for item in unique if "vegetable" in classify_meal_role(item)), "")
        title = "Eggs" + (f" with {vegetable}" if vegetable else "")
    elif kind == "Breakfast" and "plain_yogurt" in profiles:
        fruit = next((meal_display_name(item) for item in unique if "fruit" in classify_meal_role(item)), "")
        title = "Yogurt" + (f" with {fruit}" if fruit else "")
    elif kind == "Breakfast" and "peanut_butter" in profiles and "whole_wheat_bread" in profiles:
        title = "Peanut Butter Toast"
    elif kind in {"Lunch", "Dinner"}:
        protein = next((item for item in unique if "protein" in classify_meal_role(item)), None)
        grain = next((item for item in unique if "grain" in classify_meal_role(item) and item is not protein), None)
        vegetable = next((item for item in unique if "vegetable" in classify_meal_role(item) and item is not protein and item is not grain), None)
        companion = grain or vegetable
        protein_name = meal_title_name(protein) if protein else ""
        companion_name = meal_title_name(companion) if companion else ""
        if protein and "fish" in classify_meal_role(protein):
            if variant % 2 and grain and "rice" in str(grain.get("food_profile") or ""):
                title = f"{protein_name} {companion_name} Bowl"
            else:
                title = protein_name + (f" with {companion_name}" if companion_name else "")
        elif protein and "legume" in classify_meal_role(protein):
            if companion_name:
                patterns = (
                    f"{protein_name} & {companion_name} Bowl",
                    f"{protein_name} {companion_name} Soup",
                    f"{protein_name} & {meal_title_name(vegetable)} Skillet" if vegetable else f"{protein_name} {companion_name} Skillet",
                    f"{protein_name} & {companion_name} Plate",
                )
                title = patterns[variant % len(patterns)]
            else:
                title = f"{protein_name} Bowl"
        elif protein:
            title = protein_name + (f" & {companion_name} Bowl" if variant % 2 and companion_name else f" with {companion_name}" if companion_name else "")
        elif grain and vegetable:
            patterns = (
                f"{meal_title_name(vegetable)} & {meal_title_name(grain)} Bowl",
                f"{meal_title_name(grain)} & {meal_title_name(vegetable)} Plate",
                f"{meal_title_name(vegetable)} {meal_title_name(grain)} Skillet",
            )
            title = patterns[variant % len(patterns)]
        else:
            title = f"{meal_title_name(unique[0])} Bowl"
    elif kind == "Snack" and len(names) > 1:
        title = f"{' & '.join(names)} Snack"
    else:
        title = " & ".join(names)
    return {"meal_type": kind.lower(), "title": title, "products": [
        {"product_id": str(item.get("product_id") or item.get("catalog_id")), "product_name": item.get("product_name")}
        for item in unique
    ], "directions": _directions(unique)}


def build_daily_meals(groceries: list[dict], day_index: int, diet: str = "omnivore") -> list[dict]:
    """Compose one day's simple meals from classified basket products."""
    roles: dict[str, list[dict]] = defaultdict(list)
    for item in groceries:
        for role in classify_meal_role(item):
            roles[role].append(item)
    breakfast_base = _pick([x for x in roles["breakfast"] if x.get("food_profile") in {"oats", "eggs", "plain_yogurt", "peanut_butter", "whole_wheat_bread"}], day_index)
    if (breakfast_base or {}).get("food_profile") == "eggs":
        breakfast_companions = [_pick(roles["vegetable"], day_index)]
    elif (breakfast_base or {}).get("food_profile") == "peanut_butter":
        bread = [item for item in roles["grain"] if item.get("food_profile") == "whole_wheat_bread"]
        breakfast_companions = [_pick(bread, day_index), _pick(roles["fruit"], day_index)]
    elif (breakfast_base or {}).get("food_profile") == "oats":
        breakfast_drinks = [item for item in roles["dairy"] if item.get("food_profile") in {"milk_2_percent", "soy_beverage"}]
        breakfast_companions = [_pick(roles["fruit"], day_index), _pick(breakfast_drinks, day_index)]
    else:
        breakfast_companions = [_pick(roles["fruit"], day_index)]
    breakfast = _meal("Breakfast", [breakfast_base, *breakfast_companions], day_index)

    fish = roles["fish"]
    non_fish_proteins = [item for item in roles["protein"] if item not in fish]
    lunch_pool = non_fish_proteins or ([] if diet == "pescatarian" and fish else roles["protein"])
    lunch_protein = _pick(lunch_pool, day_index)
    use_fish = diet == "pescatarian" and bool(fish) and day_index % 2 == 0
    dinner_pool = non_fish_proteins or ([] if fish else roles["protein"])
    dinner_protein = _pick(fish, day_index // 2) if use_fish else _pick(dinner_pool, day_index, 1)
    lunch_products = [lunch_protein, _pick(roles["grain"], day_index), _pick(roles["vegetable"], day_index)]
    dinner_index = day_index // 2 if use_fish else day_index
    dinner_offset = 0 if use_fish else 1
    dinner_products = [dinner_protein, _pick(roles["grain"], dinner_index, dinner_offset),
                       _pick(roles["vegetable"], dinner_index, dinner_offset)]
    template_cycle = day_index // max(len(non_fish_proteins or roles["protein"]), 1)
    lunch = _meal("Lunch", lunch_products, template_cycle)
    dinner = _meal("Dinner", dinner_products, template_cycle + 1)
    if lunch and dinner and lunch["title"] == dinner["title"]:
        search_limit = max(len(roles["protein"]), len(roles["grain"]), len(roles["vegetable"]), 1) + 3
        for offset in range(2, search_limit):
            candidate = _meal("Dinner", [dinner_protein, _pick(roles["grain"], day_index, offset),
                                         _pick(roles["vegetable"], day_index, offset)], day_index + offset)
            if candidate and candidate["title"] != lunch["title"]:
                dinner = candidate
                break
    snack_extras = [item for item in roles["snack"] if item not in roles["fruit"]]
    snack = _meal("Snack", [_pick(roles["fruit"], day_index, 1), _pick(snack_extras, day_index)], day_index)
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
    planned_days = [{"day": index + 1, "meals": build_daily_meals(eligible, index, diet), "nutrition": daily}
                    for index in range(rotation_days)]
    return {
        "days_requested": days, "rotation_days": rotation_days, "repeats": days > rotation_days,
        "days": planned_days,
        "nutrition_insights": build_nutrition_insights(daily, normalized_targets, nutrition_focus, eligible),
        "products_used": sorted({product["product_id"] for day in planned_days for meal in day["meals"] for product in meal["products"]}),
        "portion_note": "Meal suggestions are based on the planned basket and are not exact portion allocations.",
        "disclaimer": "NutriCart provides general grocery-planning information, not medical or dietary advice.",
    }
