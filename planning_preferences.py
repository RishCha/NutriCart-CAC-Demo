"""Supported planning preferences and project score explanation."""

import re


FOOD_GROUP_EXCLUSIONS = {
    "dairy": {"milk_2_percent", "plain_yogurt", "cheddar_cheese"},
    "eggs": {"eggs"},
    "seafood": {"canned_tuna", "salmon"},
    "nuts": {"peanuts", "peanut_butter"},
    "gluten": {"pasta", "whole_wheat_bread"},
}
NUTRITION_FOCUS_NUTRIENTS = {
    "lower_fat": ("fat_g", 0.12),
    "high_protein": ("protein_g", -0.12),
    "high_fiber": ("fiber_g", -0.12),
    "lower_sodium": ("sodium_mg", 0.12),
}


def product_matches_exclusion(product: dict, exclusion: str) -> bool:
    """Match approved profiles or exclusions explicitly recorded from a product label."""
    return (str(product.get("food_profile") or "") in FOOD_GROUP_EXCLUSIONS.get(exclusion, set())
            or exclusion in product.get("food_group_exclusions", []))


def product_is_diet_compatible(product: dict, diet: str) -> bool:
    """Supplement profile filters with product form and reviewed label evidence.

    Generic grain/vegetable nutrition does not verify a prepared food's ingredients.
    Keep plain staples; require the existing label-review metadata for ambiguous
    vegan products. No missing ingredient facts are inferred or added to the data.
    """
    excluded = product.get("excluded_diets", [])
    groups = product.get("food_group_exclusions", [])
    if diet in excluded or (diet == "vegan" and {"dairy", "eggs", "seafood"}.intersection(groups)):
        return False
    reviewed = (product.get("nutrition_match_type") in {"product_label", "exact_barcode"}
                and isinstance(product.get("excluded_diets"), list)
                and isinstance(product.get("food_group_exclusions"), list))
    if reviewed or diet == "omnivore":
        return True
    name = str(product.get("product_name") or "").lower()
    if re.search(r"\b(?:chicken|beef|pork|turkey|bacon|ham|lard|gelatin)\b", name):
        return False
    if diet in {"vegan", "vegetarian"} and re.search(r"\b(?:fish|tuna|salmon|shrimp|anchov(?:y|ies))\b", name):
        return False
    if diet != "vegan":
        return True
    # Plain plant butters and plain oats are not composite dairy/flavored foods.
    name = re.sub(r"\b(?:peanut|almond|cashew|sunflower|seed) butter\b", "plant spread", name)
    if product.get("food_profile") == "oats" and re.search(r"\b(?:plain|original|unflavored|rolled|steel[- ]cut)\b", name):
        name = re.sub(r"\bpackets?\b", "", name)
    prepared = re.search(
        r"\b(?:packets?|variety|flavou?red|chocolate|protein[- ]packed|crispy|breaded|battered|bowls?|meatballs?|"
        r"marinara|cavatappi|elote|sauce|sauced|skillets?|sides?|pilaf|"
        r"cheddar|cheese|milk|cream|butter|honey|whey|casein|eggs?)\b", name)
    return not prepared and product.get("food_profile") != "whole_wheat_bread"


def score_plan_breakdown(summary: dict, targets: dict, groceries: list[dict]) -> dict:
    """Return the actual components and weights used by the project score."""
    daily = summary["nutrition_per_person_per_day"]
    nutrient_scores = {}
    for nutrient, target in targets.items():
        ratio = daily[nutrient] / target if target else 0
        nutrient_scores[nutrient] = max(0, 1 - abs(1 - ratio))
    variety = min(len(groceries) / 10, 1)
    categories = len({p.get("food_category") for p in groceries})
    category_variety = min(categories / 5, 1)
    nutrient_average = sum(nutrient_scores.values()) / len(nutrient_scores)
    score = round(100 * (0.75 * nutrient_average + 0.15 * variety + 0.10 * category_variety), 1)
    return {
        "score": score,
        "components": {
            "nutrition_target_alignment": {
                "score": round(nutrient_average * 100, 1), "weight": 0.75, "weight_percent": 75,
                "nutrients": {nutrient: {
                    "actual": daily[nutrient], "target": target,
                    "alignment": round(nutrient_scores[nutrient] * 100, 1),
                } for nutrient, target in targets.items()},
            },
            "product_variety": {
                "score": round(variety * 100, 1), "weight": 0.15, "weight_percent": 15,
                "selected_products": len(groceries), "full_credit_products": 10,
            },
            "category_variety": {
                "score": round(category_variety * 100, 1), "weight": 0.10, "weight_percent": 10,
                "selected_categories": categories, "full_credit_categories": 5,
            },
        },
        "disclaimer": "This is a planning score, not a medical or nutritional grade.",
    }
