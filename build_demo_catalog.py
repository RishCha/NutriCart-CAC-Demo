"""Build independent examples from the official USDA SR Legacy CSV archive.

Usage: python -B build_demo_catalog.py path/to/usda-sr.zip
No retailer catalog, credentials, network call, or runtime database is read.
Package masses and prices below are authored demo assumptions, not observations.
"""
import csv
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

from price_comparison import normalize_price_record

ARCHIVE_URL = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip"
ARCHIVE_SHA256 = "b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0"
NUTRIENTS = {"1008": "calories_kcal", "1003": "protein_g", "1004": "fat_g",
             "1005": "carbohydrates_g", "1079": "fiber_g", "1093": "sodium_mg", "2000": "sugars_g"}
# FDC ID, plain name, internal food profile, category, edible mass (g), synthetic USD price.
# These examples are independent of any actual retail package or price.
EXAMPLES = [
    (171688, "Apples, with skin", "apple", "Fruit", 300, 1.20),
    (173944, "Bananas", "banana", "Fruit", 300, 1.00),
    (169097, "Oranges", "orange", "Fruit", 300, 1.30),
    (169118, "Pears", "pear", "Fruit", 300, 1.40),
    (167762, "Strawberries", "strawberry", "Fruit", 200, 1.60),
    (170393, "Carrots, raw", "carrots", "Vegetables", 300, 0.90),
    (170379, "Broccoli, raw", "broccoli", "Vegetables", 250, 1.20),
    (168462, "Spinach, raw", "spinach", "Vegetables", 150, 1.10),
    (170026, "Potatoes, raw", "potato", "Vegetables", 400, 1.00),
    (168482, "Sweet potatoes, raw", "sweet_potato", "Vegetables", 300, 1.10),
    (170000, "Onions, raw", "onion", "Vegetables", 250, 0.80),
    (170457, "Tomatoes, raw", "tomato", "Vegetables", 250, 1.00),
    (169975, "Cabbage, raw", "cabbage", "Vegetables", 300, 0.80),
    (169705, "Oats, dry", "oats", "Grains", 250, 1.00),
    (169703, "Brown rice, dry", "brown_rice", "Grains", 250, 1.10),
    (168877, "White rice, dry", "white_rice", "Grains", 250, 0.90),
    (169736, "Pasta, dry", "pasta", "Grains", 250, 1.00),
    (172420, "Lentils, dry", "lentils", "Beans and legumes", 250, 1.00),
    (173734, "Black beans, dry", "black_beans", "Beans and legumes", 250, 1.00),
    (173744, "Kidney beans, dry", "kidney_beans", "Beans and legumes", 250, 1.00),
    (175199, "Pinto beans, dry", "pinto_beans", "Beans and legumes", 250, 1.00),
    (173756, "Chickpeas, dry", "chickpeas", "Beans and legumes", 250, 1.10),
    (172475, "Plain firm tofu", "tofu", "Protein", 250, 1.50),
    (173806, "Peanuts, dry roasted, unsalted", "peanuts", "Protein", 100, 0.80),
    (170562, "Sunflower kernels, dried", "sunflower_seeds", "Protein", 100, 0.90),
    (172470, "Peanut butter, unsalted", "peanut_butter", "Protein", 100, 0.90),
    (171413, "Olive oil", "olive_oil", "Pantry", 100, 1.50),
    (173768, "Unsweetened light soy beverage, fortified", "soy_beverage", "Dairy alternatives", 400, 1.50),
    (171287, "Whole eggs, raw", "eggs", "Protein", 200, 1.50),
    (171267, "Milk, 2 percent", "milk_2_percent", "Dairy", 400, 1.20),
    (170886, "Plain low-fat yogurt", "plain_yogurt", "Dairy", 300, 1.50),
    (175167, "Atlantic salmon, raw", "salmon", "Protein", 200, 3.00),
    (171477, "Chicken breast, roasted, meat only", "chicken_breast", "Protein", 200, 2.50),
]


def build(archive, output=None):
    raw = Path(archive).read_bytes()
    if hashlib.sha256(raw).hexdigest() != ARCHIVE_SHA256:
        raise ValueError("USDA archive differs from the reviewed source release.")
    with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
        def rows(name):
            member = next(n for n in bundle.namelist() if n.endswith('/' + name))
            return csv.DictReader(io.TextIOWrapper(bundle.open(member), encoding="utf-8-sig"))
        ids = {str(spec[0]) for spec in EXAMPLES}
        foods = {r['fdc_id']: r for r in rows('food.csv') if r['fdc_id'] in ids}
        amounts = {identifier: {} for identifier in ids}
        for row in rows('food_nutrient.csv'):
            if row['fdc_id'] in ids and row['nutrient_id'] in NUTRIENTS:
                amounts[row['fdc_id']][NUTRIENTS[row['nutrient_id']]] = float(row['amount'])
    catalog, evidence = [], []
    for fdc, name, profile, category, mass, price in EXAMPLES:
        nutrition = amounts[str(fdc)]
        if not (set(NUTRIENTS.values()) - {"sugars_g"}).issubset(nutrition):
            raise ValueError(f"Missing USDA nutrients for {fdc}; never fill missing values with invented zeros.")
        excluded = (["vegan", "vegetarian", "pescatarian"] if profile == "chicken_breast" else
                    ["vegan", "vegetarian"] if profile == "salmon" else
                    ["vegan"] if profile in {"eggs", "milk_2_percent", "plain_yogurt"} else [])
        groups = (["eggs"] if profile == "eggs" else ["dairy"] if category == "Dairy" else
                  ["seafood"] if profile == "salmon" else ["nuts"] if profile in {"peanuts", "peanut_butter"} else
                  ["gluten"] if profile == "pasta" else [])
        description = foods[str(fdc)]['description']
        source = {"fdc_id": fdc, "usda_description": description, "nutrition_source": "USDA FoodData Central SR Legacy",
                  "nutrition_source_url": f"https://fdc.nal.usda.gov/food-details/{fdc}/nutrients",
                  "nutrition_license": "CC0-1.0", "nutrition_basis_g": 100, **nutrition}
        evidence.append(source)
        catalog.append({**source, "product_id": f"demo-{profile}", "catalog_id": f"demo-{profile}",
                        "product_name": name, "food_name": name, "food_profile": profile, "food_category": category,
                        "package_size": f"{mass} g", "package_weight_g": mass,
                        "package_weight_source": "independently_authored_demo", "effective_price": price,
                        "price_source": "Synthetic NutriCart demonstration price", "price_is_synthetic": True,
                        "package_is_example": True, "local_availability_verified": False,
                        "nutrition_match_type": "generic_food_profile", "nutrition_is_estimated": True,
                        "nutrition_preparation_state": description,
                        "excluded_diets": excluded, "food_group_exclusions": groups,
                        **{f"package_{k}": round(v * mass / 100, 6) for k, v in nutrition.items()}})
    output = Path(output) if output else Path(__file__).resolve().parent / 'data' / 'demo'
    output.mkdir(parents=True, exist_ok=True)
    prices = [{**normalize_price_record(row), "price_is_synthetic": True, "package_is_example": True} for row in catalog]
    documents = {"food_catalog.json": catalog, "price_records.json": prices,
                 "usda_source_records.json": {"archive_url": ARCHIVE_URL, "archive_sha256": ARCHIVE_SHA256,
                   "release": "SR Legacy April 2018", "license": "CC0-1.0", "records": evidence}}
    for name, document in documents.items():
        (output / name).write_text(json.dumps(document, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    return catalog


if __name__ == '__main__':
    print(f"Built {len(build(sys.argv[1]))} independent USDA-based demo foods.")
