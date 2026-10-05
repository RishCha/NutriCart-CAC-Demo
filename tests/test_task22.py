"""Public demo fish preference, truthful provenance and location contracts."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import app
import optimize_grocery

ROOT = Path(__file__).resolve().parents[1]

class Task22Tests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        self.payload = dict(budget=500.45, people=3, days=1, diet="pescatarian",
            preference="balanced", foods_to_avoid=[], food_group_exclusions=[],
            calories=2000, protein=50, fiber_mode="recommended",
            location={"locality":"Concord", "region":"NC"})

    def test_requested_fish_feasible_with_nutrition_budget_and_meal_provenance(self):
        for budget in (500.45, 25, 10):
            with self.subTest(budget=budget):
                payload = dict(self.payload, budget=budget, include_fish=True)
                result = self.client.post("/api/grocery-plan", json=payload)
                self.assertEqual(result.status_code, 200, result.json)
                data = result.json
                self.assertTrue(data["acceptance"]["accepted"])
                self.assertLessEqual(data["total_cost"], budget)
                self.assertIn("demo-salmon", {p["product_id"] for p in data["groceries"]})
                self.assertTrue(data["planning_context"]["include_fish"])
                self.assertTrue(all(p["store_name"] is None for p in data["groceries"]))
                self.assertAlmostEqual(sum(p["item_total"] for p in data["groceries"]),data["total_cost"],places=2)
                for nutrient,floor in (("calories_kcal",1900),("protein_g",40),("fiber_g",23.8)):
                    self.assertGreaterEqual(data["nutrition_per_person_per_day"][nutrient]+.01,floor)
                meal = self.client.post("/api/meal-plan", json={**payload,"groceries":data["groceries"],"targets":data["nutrition_targets"]})
                self.assertEqual(meal.status_code,200,meal.json)
                self.assertTrue(set(meal.json["products_used"]) <= {p["product_id"] for p in data["groceries"]})

    def test_fish_request_conflicts_never_weaken_exclusions(self):
        for changes in ({"food_group_exclusions":["seafood"]},{"foods_to_avoid":["salmon"]},{"people":20,"days":31,"budget":10}):
            with self.subTest(changes=changes):
                response=self.client.post("/api/grocery-plan",json={**self.payload,"include_fish":True,**changes})
                self.assertEqual(response.status_code,422,response.json)
                self.assertNotIn("groceries",response.json)

    def test_invalid_or_incompatible_fish_preference(self):
        for changes in ({"include_fish":"true"},{"include_fish":True,"diet":"vegan"},{"include_fish":True,"diet":"vegetarian"}):
            with self.subTest(changes=changes):
                self.assertEqual(self.client.post("/api/grocery-plan",json={**self.payload,**changes}).status_code,400)

    def test_location_without_selected_store_still_plans(self):
        self.assertEqual(self.client.post("/api/grocery-plan",json=self.payload).status_code,200)

    def test_requested_fish_alternative_preserves_preference(self):
        payload={**self.payload,"include_fish":True}
        original=self.client.post("/api/grocery-plan",json=payload).json
        payload["excluded_product_ids"]=[p["product_id"] for p in original["groceries"]]
        result=self.client.post("/api/grocery-plan/alternative",json=payload)
        self.assertEqual(result.status_code,200,result.json)
        self.assertIn("demo-salmon",{p["product_id"] for p in result.json["groceries"]})

    def test_existing_salmon_has_traceable_usda_nutrition(self):
        foods=json.loads((ROOT/"data/demo/food_catalog.json").read_text())
        salmon=next(p for p in foods if p["product_id"]=="demo-salmon")
        self.assertEqual(salmon["fdc_id"],175167)
        self.assertEqual(salmon["nutrition_license"],"CC0-1.0")
        self.assertTrue(salmon["price_is_synthetic"])

if __name__ == "__main__":
    unittest.main()
