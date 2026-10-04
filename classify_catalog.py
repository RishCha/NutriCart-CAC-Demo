import json
import re
from collections import Counter
from pathlib import Path

from package_units import normalize_package_size


INPUT_FILE = Path("data/kroger_catalog.json")
OUTPUT_FILE = Path("data/classified_catalog.json")


CATEGORY_SEARCHES = {
    "Fruit": {
        "apple",
        "banana",
        "orange",
        "berries",
        "grapes",
    },
    "Vegetables": {
        "potato",
        "onion",
        "carrot",
        "broccoli",
        "frozen vegetables",
        "canned tomatoes",
    },
    "Beans and legumes": {
        "black beans",
        "kidney beans",
        "chickpeas",
        "lentils",
    },
    "Grains": {
        "brown rice",
        "white rice",
        "pasta",
        "oatmeal",
        "whole wheat bread",
        "tortillas",
        "cereal",
    },
    "Protein": {
        "eggs",
        "chicken breast",
        "ground turkey",
        "canned tuna",
        "peanut butter",
    },
    "Dairy": {
        "milk",
        "yogurt",
        "cheese",
    },
}


EXCLUDED_WORDS = {
    "candy",
    "cookie",
    "cookies",
    "cake",
    "cupcake",
    "ice cream",
    "soda",
    "energy drink",
    "supplement",
    "vitamin",
    "protein powder",
    "pet food",
    "dog food",
    "cat food",
    "baby food",
    "air freshener",
    "soap",
    "shampoo",
}


UNSUPPORTED_PRODUCT_PATTERNS = (
    r"\b(?:pet|dog|cat)\s+(?:food|treats?)\b", r"\b(?:canine|feline)\b",
    r"\bsports? drinks?\b", r"\bhydration drinks?\b", r"\benergy drinks?\b",
    r"\bjuice(?: drinks?)?\b", r"\bfruit[- ]flavored snacks?\b", r"\bfruit snacks?\b",
    r"\bprotein shakes?\b", r"\bsmoothies?\b", r"\b(?:protein|energy|breakfast|granola) bars?\b",
    r"\bmuffins?\b", r"\bpudd(?:ing|in')\b", r"\bpies?\b", r"\bgelato\b", r"\bdesserts?\b",
    r"\bpop stix\b",
    r"\bsunscreens?\b", r"\btanning spray\b", r"\bafter sun\b", r"\bbody lotion\b",
)

CATEGORY_FORM_PATTERNS = {
    "Grains": (r"\boatmeal\b", r"\bcereal\b", r"\brice\b", r"\bpasta\b", r"\bbread\b", r"\btortillas?\b"),
    "Dairy": (r"\byogurts?\b", r"\byoghurt\b", r"\bkefir\b", r"\bcheese\b", r"\bdairy milk\b"),
}

GRAIN_SIDE_PATTERNS = {
    "rice_side": r"\brice\s+(?:sides?|mix(?:es)?|pilaf)\b",
    "pasta_side": r"\bpasta\s+(?:sides?|mix(?:es)?)\b",
}


def grain_side_form(product_name: str) -> str | None:
    """Identify a packaged grain dish independently of its flavor or retrieval term."""
    if unsuitable_product_name(product_name):
        return None
    return next((form for form, pattern in GRAIN_SIDE_PATTERNS.items()
                 if re.search(pattern, product_name, re.IGNORECASE)), None)


def unsuitable_product_name(product_name: str) -> bool:
    """Return whether a product form is outside the optimizer food catalog."""

    normalized = product_name.lower()
    return any(re.search(pattern, normalized) for pattern in UNSUPPORTED_PRODUCT_PATTERNS)


def optimizer_product_is_supported(product: dict) -> bool:
    """Reject unsupported forms and grain sides carrying another food's nutrition."""
    name = str(product.get("product_name") or "")
    if unsuitable_product_name(name):
        return False
    if form := grain_side_form(name):
        return (product.get("food_profile") == form and product.get("food_category") == "Grains"
                and product.get("nutrition_match_type") in {"product_label", "exact_barcode"}
                and "excluded_diets" in product and "food_group_exclusions" in product)
    return True


def classify_product(product: dict) -> str | None:
    """Classify using retrieval terms without overriding explicit product form."""

    product_name = str(product.get("product_name") or "")
    if unsuitable_product_name(product_name):
        return None

    if grain_side_form(product_name):
        return "Grains"

    matched_searches = {
        search.lower()
        for search in product.get("matched_searches", [])
    }

    normalized_name = product_name.lower()
    for category, patterns in CATEGORY_FORM_PATTERNS.items():
        if (
            matched_searches.intersection(CATEGORY_SEARCHES[category])
            and any(re.search(pattern, normalized_name) for pattern in patterns)
        ):
            return category

    if any(re.search(pattern, normalized_name) for patterns in CATEGORY_FORM_PATTERNS.values() for pattern in patterns):
        return None

    for category, search_terms in CATEGORY_SEARCHES.items():
        if matched_searches.intersection(search_terms):
            return category

    return None


def should_exclude(product: dict) -> bool:
    """Remove obviously irrelevant or unsuitable products."""

    product_name = (
        product.get("product_name") or ""
    ).lower()

    price = product.get("effective_price")

    if not isinstance(price, (int, float)) or price <= 0:
        return True

    if any(word in product_name for word in EXCLUDED_WORDS):
        return True

    if unsuitable_product_name(product_name):
        return True

    if not product.get("upc"):
        return True

    return False


def main() -> None:
    if not INPUT_FILE.exists():
        raise FileNotFoundError(
            "data/kroger_catalog.json was not found."
        )

    with INPUT_FILE.open("r", encoding="utf-8") as file:
        catalog = json.load(file)

    classified_products = []
    excluded_count = 0
    unclassified_count = 0

    for product in catalog:
        if should_exclude(product):
            excluded_count += 1
            continue

        category = classify_product(product)

        if category is None:
            unclassified_count += 1
            continue

        classified_products.append(
            {
                **product,
                "food_category": category,
                "package_size": normalize_package_size(product.get("package_size")),
            }
        )

    classified_products.sort(
        key=lambda product: (
            product["food_category"],
            product.get("product_name") or "",
        )
    )

    OUTPUT_FILE.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with OUTPUT_FILE.open("w", encoding="utf-8") as file:
        json.dump(
            classified_products,
            file,
            indent=2,
        )

    category_counts = Counter(
        product["food_category"]
        for product in classified_products
    )

    print("\nCatalog classification complete")
    print("Original products:", len(catalog))
    print("Usable classified products:", len(classified_products))
    print("Excluded products:", excluded_count)
    print("Unclassified products:", unclassified_count)

    print("\nProducts by category:")

    for category, count in sorted(category_counts.items()):
        print(f"- {category}: {count}")

    print("\nSaved to data/classified_catalog.json")


if __name__ == "__main__":
    main()
