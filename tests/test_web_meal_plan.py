import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import app
from meal_planner import build_meal_plan, meal_display_name


ROOT = Path(__file__).resolve().parents[1]
CATALOG_ITEM = {"product_id": "0001", "product_name": "Oats", "food_name": "Oats", "food_profile": "oats",
                "food_category": "Grains", "package_weight_g": 500, "package_calories_kcal": 1000,
                "package_protein_g": 40, "package_carbohydrates_g": 180, "package_fat_g": 20,
                "package_fiber_g": 30, "package_sodium_mg": 50}


class MealPlanApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        self.payload = {"groceries": [{"product_id": "0001", "quantity": 2}], "people": 2, "days": 3,
                        "diet": "vegan", "food_group_exclusions": ["dairy"], "foods_to_avoid": [],
                        "nutrition_focus": "high_fiber",
                        "targets": {"calories_kcal": 1800, "protein_g": 65, "fiber_g": 25.2}}

    def test_endpoint_reenriches_current_products_and_does_not_optimize(self):
        with patch("app.load_catalog", return_value=[CATALOG_ITEM]), patch("app.solve_plan") as solve:
            response = self.client.post("/api/meal-plan", json=self.payload)
        self.assertEqual(response.status_code, 200); solve.assert_not_called()
        self.assertEqual(response.get_json()["products_used"], ["0001"])

    def test_endpoint_rejects_unknown_products_and_invalid_context(self):
        with patch("app.load_catalog", return_value=[CATALOG_ITEM]):
            bad = {**self.payload, "groceries": [{"product_id": "bad", "quantity": 1}]}
            self.assertEqual(self.client.post("/api/meal-plan", json=bad).status_code, 400)
            self.assertEqual(self.client.post("/api/meal-plan", json={}).status_code, 400)


class MealPlanQualityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        catalog = json.loads((ROOT / "data" / "demo" / "food_catalog.json").read_text(encoding="utf-8"))
        cls.catalog = {item["food_profile"]: item for item in catalog}

    def basket(self, *profiles):
        items = []
        for profile in profiles:
            item = copy.deepcopy(self.catalog[profile])
            item["quantity"] = 2
            items.append(item)
        return items

    def test_catalog_descriptors_are_cleaned_only_in_titles(self):
        cases = (
            ({"product_name": "Potatoes, raw", "food_profile": "potato"}, "Potatoes"),
            ({"product_name": "Lentils, dry", "food_profile": "lentils"}, "Lentils"),
            ({"product_name": "Chickpeas, dry", "food_profile": "chickpeas"}, "Chickpeas"),
            ({"product_name": "Brown rice, long-grain, cooked", "food_profile": "brown_rice"}, "Brown Rice"),
            ({"product_name": "Quinoa, cooked", "food_profile": "unknown"}, "Quinoa"),
            ({"product_name": "Peanuts, dry roasted, unsalted", "food_profile": "peanuts"}, "Peanuts"),
        )
        for product, expected in cases:
            with self.subTest(product=product["product_name"]):
                self.assertEqual(meal_display_name(product), expected)
                self.assertIn(",", product["product_name"])

    def test_vegan_week_uses_only_basket_foods_with_readable_varied_meals(self):
        basket = self.basket("oats", "banana", "lentils", "chickpeas", "brown_rice", "potato", "broccoli")
        plan = build_meal_plan(basket, people=2, days=7, diet="vegan")
        source_ids = {item["product_id"] for item in basket}
        titles = [meal["title"] for day in plan["days"] for meal in day["meals"]]
        self.assertTrue(set(plan["products_used"]) <= source_ids)
        self.assertFalse(any(term in title.lower() for title in titles for term in (", raw", ", dry", "uncooked", "long-grain", "prepared from")))
        main_titles = []
        for day in plan["days"]:
            by_type = {meal["meal_type"]: meal for meal in day["meals"]}
            if "lunch" in by_type and "dinner" in by_type:
                self.assertNotEqual(by_type["lunch"]["title"], by_type["dinner"]["title"])
                main_titles.extend((by_type["lunch"]["title"], by_type["dinner"]["title"]))
        self.assertGreaterEqual(len(set(main_titles)), 4)
        self.assertFalse(any("salmon" in title.lower() or "egg" in title.lower() for title in titles))

    def test_diets_filter_fish_and_pescatarian_uses_it_only_when_present(self):
        basket = self.basket("oats", "banana", "lentils", "brown_rice", "potato", "broccoli", "eggs", "salmon")
        salmon_id = self.catalog["salmon"]["product_id"]
        for diet in ("vegan", "vegetarian"):
            with self.subTest(diet=diet):
                plan = build_meal_plan(basket, people=1, days=7, diet=diet)
                self.assertNotIn(salmon_id, plan["products_used"])
        pescatarian = build_meal_plan(basket, people=1, days=7, diet="pescatarian")
        meals = [meal for day in pescatarian["days"] for meal in day["meals"]]
        fish_meals = [meal for meal in meals if salmon_id in {item["product_id"] for item in meal["products"]}]
        self.assertGreater(len(fish_meals), 0)
        self.assertLess(len(fish_meals), len(meals))
        self.assertTrue(all("Salmon" in meal["title"] for meal in fish_meals))
        self.assertGreater(len({meal["title"] for meal in fish_meals}), 1)

        no_fish_basket = [item for item in basket if item["food_profile"] != "salmon"]
        no_fish = build_meal_plan(no_fish_basket, people=1, days=7, diet="pescatarian")
        self.assertNotIn(salmon_id, no_fish["products_used"])
        self.assertFalse(any("salmon" in meal["title"].lower() for day in no_fish["days"] for meal in day["meals"]))


class MealPlanPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.page = app.app.test_client().get("/").get_data(as_text=True)
        cls.script = (ROOT / "static" / "meal_plan.js").read_text(encoding="utf-8")
        cls.grocery = (ROOT / "static" / "grocery.js").read_text(encoding="utf-8")
        cls.cursor = (ROOT / "static" / "cursor_effects.js").read_text(encoding="utf-8")

    def test_navigation_default_and_no_plan_state(self):
        self.assertIn('id="meal-plan-tab"', self.page); self.assertIn('id="meal-plan-view"', self.page)
        self.assertIn('id="snap-tab" class="tab"', self.page)
        self.assertIn("Create your grocery basket first to unlock meal ideas.", self.page)
        self.assertIn('lockedAction.dataset.workflowTarget || "planner"', self.script)

    def test_create_button_api_and_current_alternative_source(self):
        self.assertIn('id="create-meal-plan"', self.page); self.assertIn('fetch("/api/meal-plan"', self.script)
        self.assertIn("currentPlan.groceries.map", self.script); self.assertIn("product_id: String(item.product_id)", self.script)
        self.assertIn('addEventListener("nutricart:plan-updated"', self.script)
        self.assertIn("Your grocery plan changed. Generate a new Meal Plan", self.script)
        self.assertIn("results.hidden = true", self.script)
        self.assertIn('addEventListener("nutricart:create-meal-plan", createMealPlan)', self.script)
        self.assertIn('dispatchEvent(new Event("nutricart:create-meal-plan"))', self.grocery)

    def test_day_meal_nutrition_and_disclaimer_rendering(self):
        for text in ("Day ${day.day}", "meal.meal_type", "basketNutritionOutput"):
            self.assertIn(text, self.script)
        for kind in ("Breakfast", "Lunch", "Dinner", "Snack"):
            self.assertIn(kind.lower(), (ROOT / "meal_planner.py").read_text(encoding="utf-8"))
        self.assertNotIn("NutriCart provides general grocery-planning information, not medical or dietary advice.", self.page)
        self.assertIn('id="meal-plan-title">Meal Plan</h1>', self.page)
        self.assertNotIn("Meal Ideas from Your Basket", self.page)
        self.assertIn('id="basket-nutrition-title">Basket Nutrition</h2>', self.page)
        self.assertEqual(self.page.count("Average per person, per day"), 1)

    def test_nutrition_commentary_is_removed_from_the_ui(self):
        for text in ("Nutrition Insights", "PLANNING OBSERVATIONS", "nutrition-insights", "meal-insights",
                     "BASKET NUTRITION OVERVIEW", "Average nutrition represented by the full grocery basket"):
            self.assertNotIn(text, self.page)
        for text in ("nutrition_insights", "insight.text", "planning reference"):
            self.assertNotIn(text, self.script)

    def test_basket_nutrition_wording_units_and_stale_response_guard(self):
        self.assertIn('"Calories", "calories_kcal", "kcal"', self.script)
        self.assertIn('"Protein", "protein_g", "g"', self.script)
        self.assertIn('"Fiber", "fiber_g", "g"', self.script)
        self.assertIn('"Fat", "fat_g", "g"', self.script)
        self.assertIn('"Sodium", "sodium_mg", "mg"', self.script)
        self.assertNotIn("Nutrition from Your Grocery Plan, Per Person Per Day", self.script)
        self.assertNotIn("article.append(meals, nutritionCard", self.script)
        self.assertIn("basketNutritionOutput.append(nutritionSummary", self.script)
        self.assertIn(': ""', self.script)
        self.assertIn("let planVersion = 0", self.script)
        self.assertIn("requestedVersion !== planVersion", self.script)
        self.assertIn("new AbortController()", self.script)
        self.assertIn("activeRequest.abort()", self.script)
        self.assertIn('requestError.name !== "AbortError"', self.script)

    def test_meals_keep_provenance_in_compact_view(self):
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        self.assertNotIn("Uses from your basket:", self.script)
        self.assertIn('node("h4", "", meal.title)', self.script)
        self.assertIn('node("summary", "", "Basket foods")', self.script)
        self.assertIn('node("li", "", product.product_name)', self.script)
        self.assertNotIn('[data-meal-view="compact"] .meal-product-details { display: none; }', styles)
        self.assertNotIn('[data-meal-view="compact"] .meal-card h4 { display: none;', styles)

    def test_long_plan_rotation_is_explicit(self):
        self.assertIn("Repeat this ${data.rotation_days}-day rotation for your ${data.days_requested}-day plan.", self.script)
        self.assertNotIn("not independently generated", self.script)

    def test_connections_cursor_and_existing_views_remain(self):
        self.assertIn("Track My Shopping", self.page); self.assertIn("Compare This Basket", self.page)
        self.assertIn('navigate("budget")', self.script); self.assertIn('navigate("planner")', self.script)
        self.assertIn('data-cursor-effect="create-meal-plan"', self.page)
        for emoji in ("🍽️", "🥣", "🥗", "✨"):
            self.assertIn(emoji, self.cursor)
        for identifier in ("planner-view", "shopping-budget-view", "snap-view", "basket-comparison"):
            self.assertIn(f'id="{identifier}"', self.page)


if __name__ == "__main__":
    unittest.main()
