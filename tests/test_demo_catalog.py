"""Independent USDA demo data, strict planning, and publication boundaries."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import app
import catalog_config
import optimize_grocery
import price_comparison
from build_demo_catalog import EXAMPLES, NUTRIENTS

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / 'data' / 'demo'


class DemoCatalogTests(unittest.TestCase):
    def setUp(self):
        self.catalog = json.loads((DEMO / 'food_catalog.json').read_text())

    def test_source_traceability_and_package_arithmetic(self):
        source = json.loads((DEMO / 'usda_source_records.json').read_text())
        by_fdc = {r['fdc_id']: r for r in source['records']}
        self.assertEqual(len(self.catalog), len(EXAMPLES))
        self.assertEqual(len(by_fdc), len(EXAMPLES))
        for row in self.catalog:
            self.assertIn(row['fdc_id'], by_fdc)
            self.assertEqual(row['nutrition_license'], 'CC0-1.0')
            for key in NUTRIENTS.values():
                if key not in by_fdc[row['fdc_id']]:
                    self.assertNotIn(key, row)
                    continue
                self.assertEqual(row[key], by_fdc[row['fdc_id']][key])
                self.assertAlmostEqual(row['package_' + key], row[key] * row['package_weight_g'] / 100, places=5)

    def test_no_retailer_identity_or_availability_in_demo_files(self):
        for name in ['food_catalog.json', 'price_records.json']:
            for row in json.loads((DEMO / name).read_text()):
                self.assertTrue(row['product_id'].startswith('demo-'))
                self.assertTrue(row['price_is_synthetic'])
                self.assertTrue(row['package_is_example'])
                for key in ['upc', 'brand', 'retailer', 'store', 'store_id', 'store_name', 'location_id']:
                    self.assertFalse(row.get(key), (name, key))
            self.assertNotRegex((DEMO / name).read_text().lower(), r'kroger|harris teeter|open food facts|citymarket')

    def test_all_diets_and_food_exclusions(self):
        forbidden = {'vegan': {'eggs','milk_2_percent','plain_yogurt','salmon','chicken_breast'},
                     'vegetarian': {'salmon','chicken_breast'}, 'pescatarian': {'chicken_breast'}, 'omnivore': set()}
        for diet, profiles in forbidden.items():
            accepted, _ = optimize_grocery.filter_catalog(self.catalog, diet, [])
            self.assertFalse(profiles & {p['food_profile'] for p in accepted})
            for profile in ['oats','broccoli','tofu','lentils','peanut_butter','soy_beverage']:
                self.assertIn(profile, {p['food_profile'] for p in accepted})
        accepted, _ = optimize_grocery.filter_catalog(self.catalog, 'vegan', [], ['nuts','gluten'])
        self.assertFalse({'peanuts','peanut_butter','pasta'} & {p['food_profile'] for p in accepted})

    def test_explicit_food_group_mapping_does_not_confuse_nuts_eggs_or_dairy(self):
        by_profile = {row['food_profile']: row for row in self.catalog}
        self.assertEqual(
            optimize_grocery.product_food_groups(by_profile['peanuts']),
            {'Protein sources', 'Nuts and seeds'},
        )
        self.assertEqual(
            optimize_grocery.product_food_groups(by_profile['eggs']),
            {'Protein sources', 'Eggs'},
        )
        self.assertEqual(
            optimize_grocery.product_food_groups(by_profile['milk_2_percent']),
            {'Dairy'},
        )
        vegan, _ = optimize_grocery.filter_catalog(self.catalog, 'vegan', [], [])
        vegan_groups = set().union(*(optimize_grocery.product_food_groups(row) for row in vegan))
        self.assertNotIn('Eggs', vegan_groups)
        self.assertNotIn('Dairy', vegan_groups)

    def test_bounded_diversity_improves_the_narrow_ten_day_case(self):
        payload = dict(people=2, days=10, calories=2000, protein=50,
                       fiber_mode='recommended', preference='balanced', foods_to_avoid=[],
                       location={'locality':'Cox Mill','region':'NC'})
        by_id = {row['product_id']: row for row in self.catalog}
        client = app.app.test_client()
        eligible_counts = {'vegan':28, 'vegetarian':31, 'pescatarian':32, 'omnivore':33}
        for diet, expected_count in eligible_counts.items():
            accepted, _ = optimize_grocery.filter_catalog(self.catalog, diet, [], [])
            self.assertEqual(len(accepted), expected_count)
            for budget in (60, 100, 200, 500):
                with self.subTest(diet=diet, budget=budget):
                    response = client.post('/api/grocery-plan', json={**payload, 'diet':diet, 'budget':budget})
                    self.assertEqual(response.status_code, 200, response.json)
                    result = response.json
                    self.assertLessEqual(result['total_cost'], budget)
                    self.assertTrue(result['acceptance']['accepted'])
                    self.assertGreaterEqual(len(result['groceries']), 13)
                    selected = [by_id[item['product_id']] for item in result['groceries']]
                    category_counts = {}
                    for item in selected:
                        category_counts[item['food_category']] = category_counts.get(item['food_category'], 0) + 1
                        self.assertNotIn(diet, item['excluded_diets'])
                    for category in ('Fruit', 'Vegetables', 'Grains'):
                        self.assertGreaterEqual(category_counts.get(category, 0), 2)
        vegetarian = client.post('/api/grocery-plan', json={**payload, 'diet':'vegetarian', 'budget':200}).json
        profiles = {by_id[item['product_id']]['food_profile'] for item in vegetarian['groceries']}
        self.assertTrue(profiles & {'eggs', 'milk_2_percent', 'plain_yogurt'})
        self.assertTrue({'tofu', 'peanuts', 'peanut_butter'} & profiles)

    def test_exclusions_and_nutrition_focus_remain_strict_with_diversity(self):
        client = app.app.test_client()
        base = dict(budget=200, people=2, days=10, diet='vegetarian', calories=2000,
                    protein=50, fiber_mode='recommended', preference='balanced', foods_to_avoid=[],
                    location={'locality':'Cox Mill','region':'NC'})
        excluded_profiles = {
            'dairy': {'milk_2_percent','plain_yogurt','cheddar_cheese'},
            'eggs': {'eggs'},
            'nuts': {'peanuts','peanut_butter'},
            'gluten': {'pasta','whole_wheat_bread'},
        }
        by_id = {row['product_id']: row for row in self.catalog}
        for exclusion, forbidden in excluded_profiles.items():
            response = client.post('/api/grocery-plan', json={**base, 'food_group_exclusions':[exclusion]})
            self.assertEqual(response.status_code, 200, response.json)
            profiles = {by_id[item['product_id']]['food_profile'] for item in response.json['groceries']}
            self.assertFalse(profiles & forbidden)
        for focus in ('high_protein','high_fiber','lower_sodium'):
            response = client.post('/api/grocery-plan', json={**base, 'nutrition_focus':focus})
            self.assertEqual(response.status_code, 200, response.json)
            self.assertTrue(response.json['acceptance']['accepted'])

    def test_alternatives_are_bounded_distinct_and_compliant(self):
        client = app.app.test_client()
        payload = dict(budget=200, people=2, days=10, diet='vegetarian', calories=2000,
                       protein=50, fiber_mode='recommended', preference='balanced', foods_to_avoid=[],
                       location={'locality':'Cox Mill','region':'NC'})
        current = client.post('/api/grocery-plan', json=payload).json
        history = []
        for _index in range(3):
            ids = [item['product_id'] for item in current['groceries']]
            response = client.post('/api/grocery-plan/alternative', json={
                **payload, 'excluded_product_ids':ids, 'previous_product_id_sets':history,
            })
            self.assertEqual(response.status_code, 200, response.json)
            alternative = response.json
            self.assertTrue(alternative['acceptance']['accepted'])
            self.assertLessEqual(alternative['total_cost'], payload['budget'])
            self.assertGreaterEqual(alternative['alternative_difference_count'], 4)
            self.assertNotEqual(ids, [item['product_id'] for item in alternative['groceries']])
            history.append(ids)
            current = alternative

    def test_vercel_forces_demo_even_if_local_requested(self):
        with patch.dict(os.environ, VERCEL='1', NUTRICART_CATALOG_MODE='local'):
            self.assertEqual(catalog_config.catalog_path('food'), DEMO / 'food_catalog.json')
            self.assertEqual(catalog_config.catalog_path('prices'), DEMO / 'price_records.json')
        with patch.dict(os.environ, VERCEL='', NUTRICART_CATALOG_MODE=''):
            self.assertEqual(catalog_config.catalog_path('food'), DEMO / 'food_catalog.json')

    def test_missing_demo_never_falls_back(self):
        with tempfile.TemporaryDirectory() as folder:
            missing = Path(folder) / 'missing.json'
            with patch.object(optimize_grocery, 'CATALOG_FILE', missing):
                with self.assertRaises(FileNotFoundError): optimize_grocery.load_catalog()
            with self.assertRaises(FileNotFoundError): price_comparison.load_normalized_prices(missing)

    def test_price_normalization_preserves_examples(self):
        prices = json.loads((DEMO / 'price_records.json').read_text())
        for food, price in zip(self.catalog, prices):
            expected = price_comparison.normalize_price_record(food)
            for key, value in expected.items(): self.assertEqual(price[key], value)

    def test_deployment_excludes_private_root_data(self):
        config = json.loads((ROOT / 'vercel.json').read_text())
        self.assertIn('data/*.json', config['functions']['app.py']['excludeFiles'])
        self.assertNotIn('data/**', config['functions']['app.py']['excludeFiles'])
        self.assertIn('data/*.json', (ROOT / '.vercelignore').read_text())

    def test_public_mode_never_calls_retailer_service(self):
        with patch('app.demo_catalog_enabled', return_value=True), patch('app._get_kroger_access_token', side_effect=AssertionError('Retailer called')):
            response = app.app.test_client().post('/api/basket-price-comparison', json={})
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json['error'], "Store-specific prices aren't available yet. Your grocery plan uses estimated prices, which may differ from actual store prices.")

    def test_original_case_lower_budgets_locations_and_alternative(self):
        with patch.object(optimize_grocery, 'CATALOG_FILE', DEMO / 'food_catalog.json'), patch.dict(app.app.config, TESTING=True, ACCOUNTS_ENABLED=False):
            client = app.app.test_client()
            by_id = {p['product_id']: p for p in self.catalog}
            for diet in ['vegan','vegetarian','pescatarian','omnivore']:
                for budget in [500.45, 25, 15, 10]:
                    for region in ['NC','AK']:
                        with self.subTest(diet=diet,budget=budget,region=region):
                            payload = dict(budget=budget,people=3,days=1,diet=diet,calories=2000,protein=50,
                                fiber_mode='recommended',preference='balanced',foods_to_avoid=[],location={'locality':'','region':region})
                            response = client.post('/api/grocery-plan', json=payload)
                            self.assertEqual(response.status_code,200,response.json)
                            result=response.json
                            self.assertTrue(result['acceptance']['accepted'])
                            self.assertTrue(all(v['passes'] for v in result['acceptance']['nutrition_checks'].values()))
                            self.assertLessEqual(result['total_cost'],budget)
                            self.assertAlmostEqual(sum(p['item_total'] for p in result['groceries']), result['total_cost'],places=2)
                            for nutrient in optimize_grocery.NUTRIENTS:
                                total=sum(by_id[p['product_id']]['package_'+nutrient]*p['quantity'] for p in result['groceries'])
                                self.assertAlmostEqual(round(total/3,2),result['nutrition_per_person_per_day'][nutrient],places=2)
                            for p in result['groceries']:
                                self.assertNotIn(diet,by_id[p['product_id']]['excluded_diets'])
                                self.assertIsNone(p['store_name'])
                            meals=client.post('/api/meal-plan',json={**payload,'groceries':result['groceries'],'targets':result['nutrition_targets']})
                            self.assertEqual(meals.status_code,200,meals.json)
                            self.assertTrue(set(meals.json['products_used']) <= {p['product_id'] for p in result['groceries']})
            payload.update(budget=25,diet='vegan',excluded_product_ids=[p['product_id'] for p in result['groceries']])
            alternative=client.post('/api/grocery-plan/alternative',json=payload)
            self.assertEqual(alternative.status_code,200,alternative.json)
            self.assertTrue(alternative.json['acceptance']['accepted'])
            payload.update(budget=10,people=20,days=31)
            rejected=client.post('/api/grocery-plan',json=payload)
            self.assertEqual(rejected.status_code,422)
            self.assertTrue(rejected.json['error'])
            self.assertNotIn('groceries',rejected.json)


def dietary_audit_scenarios():
    """A bounded, deterministic covering matrix; not a full Cartesian product."""
    diets = ("vegan", "vegetarian", "pescatarian", "omnivore")
    base = dict(calories=2000, protein=50, fiber_mode="recommended", preference="balanced",
                foods_to_avoid=[], nutrition_focus="none", location={"locality": "Cox Mill", "region": "NC"})
    cases = []
    def add(**values):
        payload = {**base, **values}
        if payload not in cases:
            cases.append(payload)
    for diet in diets:
        for budget in (30, 50, 70, 100, 150, 200):
            for people, days in ((1, 3), (2, 7), (4, 14), (6, 21)):
                add(diet=diet, budget=budget, people=people, days=days)
        for budget, people, days in ((200, 2, 14), (70, 1, 7), (150, 4, 7)):
            add(diet=diet, budget=budget, people=people, days=days)
        for focus in ("lower_fat", "high_protein", "high_fiber", "lower_sodium"):
            add(diet=diet, budget=100, people=2, days=7, nutrition_focus=focus)
        for exclusion in ("dairy", "eggs", "seafood", "nuts", "gluten"):
            add(diet=diet, budget=100, people=2, days=7, food_group_exclusions=[exclusion])
        for preference in ("budget", "nutrition", "variety"):
            add(diet=diet, budget=100, people=2, days=7, preference=preference)
        add(diet=diet, budget=10, people=20, days=31)
        add(diet=diet, budget=100, people=2, days=7, foods_to_avoid=["tofu", "peanuts"])
    add(diet="vegetarian", budget=100, people=1, days=14)
    add(diet="pescatarian", budget=100, people=2, days=7, include_fish=True)
    add(diet="pescatarian", budget=30, people=1, days=3, include_fish=True)
    add(diet="omnivore", budget=100, people=2, days=7, foods_to_avoid=["tofu", "lentils", "beans", "chickpeas", "soy"])
    add(diet="omnivore", budget=100, people=2, days=7, protein=150)
    add(diet="omnivore", budget=100.45, people=2, days=7)
    return cases


class DietaryBasketAuditTests(unittest.TestCase):
    def setUp(self):
        self.config = patch.dict(app.app.config, TESTING=True, ACCOUNTS_ENABLED=False)
        self.config.start()
        self.addCleanup(self.config.stop)
        self.client = app.app.test_client()
        self.catalog = json.loads((DEMO / "food_catalog.json").read_text())
        self.by_id = {row["product_id"]: row for row in self.catalog}
        self.usda = {row["fdc_id"]: row for row in json.loads((DEMO / "usda_source_records.json").read_text())["records"]}

    def check_response(self, payload, response):
        """Independently check arithmetic and source evidence, including failed plans."""
        import math
        from decimal import Decimal
        from plan_feasibility import minimum_feasible_cost, plan_acceptance
        data = response.json
        self.assertIn(response.status_code, (200, 422), data)
        values, _, _ = app._planning_values(payload)
        eligible, _ = optimize_grocery.filter_catalog(self.catalog, payload["diet"], values["avoid"], values["food_group_exclusions"])
        if response.status_code == 422:
            self.assertTrue(data.get("error"))
            self.assertEqual(data.get("feasibility_status"), "clearly_infeasible")
            self.assertNotIn("groceries", data)
            minimum = minimum_feasible_cost(eligible, values)
            if minimum is not None and minimum <= payload["budget"] + 0.005:
                plan = optimize_grocery.solve_plan(eligible, values)
                summary = optimize_grocery.summarize_plan(plan, values)
                score = optimize_grocery.score_plan(summary, plan["targets"], plan["groceries"])
                self.assertFalse(plan_acceptance(plan, summary, score)["accepted"], data)
            return
        items = data["groceries"]
        self.assertTrue(items)
        self.assertEqual(len(items), len({row["product_id"] for row in items}))
        self.assertEqual(data["planning_settings"]["diet"], payload["diet"])
        self.assertEqual(data["planning_settings"]["nutrition_focus"], payload["nutrition_focus"])
        self.assertEqual(data["planning_context"]["people"], payload["people"])
        self.assertEqual(data["planning_context"]["days"], payload["days"])
        self.assertEqual(data["eligible_product_count"], len(eligible))
        animal = {"chicken_breast", "salmon", "eggs", "milk_2_percent", "plain_yogurt"}
        forbidden = {"vegan": animal, "vegetarian": {"chicken_breast", "salmon"},
                     "pescatarian": {"chicken_breast"}, "omnivore": set()}[payload["diet"]]
        excluded_profiles = {"dairy": {"milk_2_percent", "plain_yogurt"}, "eggs": {"eggs"},
                             "seafood": {"salmon"}, "nuts": {"peanuts", "peanut_butter"}, "gluten": {"pasta"}}
        total = Decimal("0")
        nutrients = {name: 0.0 for name in optimize_grocery.NUTRIENTS}
        profiles = []
        for item in items:
            row = self.by_id[item["product_id"]]
            self.assertEqual(item["product_name"], row["product_name"])
            self.assertEqual(item["category"], row["food_category"])
            self.assertTrue(item["category"])
            self.assertEqual(item["package_weight_g"], row["package_weight_g"])
            self.assertTrue(row["price_is_synthetic"])
            self.assertFalse(row["local_availability_verified"])
            self.assertEqual(row["nutrition_license"], "CC0-1.0")
            self.assertIsNone(item["store_name"])
            self.assertNotIn(row["food_profile"], forbidden)
            self.assertNotIn(payload["diet"], row["excluded_diets"])
            profiles.append(row["food_profile"])
            for exclusion in payload.get("food_group_exclusions", []):
                self.assertNotIn(row["food_profile"], excluded_profiles[exclusion])
            for avoided in payload.get("foods_to_avoid", []):
                self.assertNotIn(avoided, item["product_name"].lower())
            q = item["quantity"]
            self.assertIs(type(q), int)
            self.assertGreater(q, 0)
            self.assertLessEqual(q, optimize_grocery.package_upper_bound(row, payload["people"], payload["days"]))
            price = Decimal(str(row["effective_price"]))
            self.assertEqual(Decimal(str(item["unit_price"])), price)
            self.assertEqual(Decimal(str(item["item_total"])), price * q)
            total += price * q
            source = self.usda[row["fdc_id"]]
            for nutrient in nutrients:
                nutrients[nutrient] += source.get(nutrient, 0) * row["package_weight_g"] / 100 * q
        self.assertEqual(len(profiles), len(set(profiles)))
        self.assertEqual(float(total), data["total_cost"])
        self.assertLessEqual(float(total), payload["budget"])
        self.assertAlmostEqual(payload["budget"] - float(total), data["remaining_budget"], places=2)
        person_days = payload["people"] * payload["days"]
        for nutrient, total_value in nutrients.items():
            self.assertAlmostEqual(round(total_value / person_days, 2), data["nutrition_per_person_per_day"][nutrient], places=2)
        for nutrient, floor in (("calories_kcal", 0.95), ("protein_g", 0.80), ("fiber_g", 0.85)):
            self.assertGreaterEqual(data["nutrition_per_person_per_day"][nutrient] + 0.005, data["nutrition_targets"][nutrient] * floor)
        daily, targets = data["nutrition_per_person_per_day"], data["nutrition_targets"]
        alignment = sum(max(0, 1 - abs(1 - daily[n] / target)) for n, target in targets.items()) / len(targets)
        expected_score = round(100 * (0.75 * alignment + 0.15 * min(len(items) / 10, 1) + 0.10 * min(len({p["category"] for p in items}) / 5, 1)), 1)
        self.assertTrue(math.isfinite(data["quality_score"]))
        self.assertGreaterEqual(data["quality_score"], 0)
        self.assertLessEqual(data["quality_score"], 100)
        self.assertEqual(data["quality_score"], expected_score)
        self.assertTrue(data["acceptance"]["accepted"])
        if payload.get("include_fish"):
            self.assertIn("salmon", profiles)

    def test_real_api_dietary_covering_matrix(self):
        scenarios = dietary_audit_scenarios()
        self.assertGreaterEqual(len(scenarios), 60)
        for payload in scenarios:
            with self.subTest(**payload):
                self.check_response(payload, self.client.post("/api/grocery-plan", json=payload))

    def test_equal_person_days_can_legitimately_share_a_basket_without_cache_leakage(self):
        base = dict(budget=100, calories=2000, protein=50, fiber_mode="recommended", preference="balanced", foods_to_avoid=[])
        signatures = []
        for diet, people, days in (("omnivore", 2, 7), ("vegetarian", 1, 14), ("vegan", 2, 7)):
            payload = {**base, "diet": diet, "people": people, "days": days}
            response = self.client.post("/api/grocery-plan", json=payload)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json["planning_settings"]["diet"], diet)
            signatures.append([(p["product_id"], p["quantity"]) for p in response.json["groceries"]])
        self.assertEqual(signatures[0], signatures[1])
        self.assertNotEqual(signatures[0], signatures[2])

    def test_excluding_whole_groups_does_not_force_their_purchase(self):
        payload = dict(budget=100, people=2, days=7, diet="omnivore", calories=2000, protein=50,
                       fiber_mode="recommended", preference="balanced", foods_to_avoid=[],
                       food_group_exclusions=["dairy", "eggs", "nuts", "seafood"])
        response = self.client.post("/api/grocery-plan", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertFalse({"eggs", "milk_2_percent", "plain_yogurt", "peanuts", "peanut_butter", "salmon"} &
                         {self.by_id[x["product_id"]]["food_profile"] for x in response.json["groceries"]})

    def test_invalid_planner_boundaries_return_errors_without_baskets(self):
        base = dict(budget=100, people=2, days=7, diet="omnivore", calories=2000, protein=50,
                    fiber_mode="recommended", preference="balanced", foods_to_avoid=[])
        invalid = [("people", 0), ("people", 21), ("people", 2.5), ("people", None),
                   ("days", 0), ("days", 32), ("days", 7.5), ("days", None),
                   ("budget", 0), ("budget", 9.99), ("budget", "bad"), ("budget", None),
                   ("calories", 499), ("protein", 301), ("diet", "unsupported"),
                   ("nutrition_focus", "unsupported"), ("include_fish", True)]
        for key, value in invalid:
            with self.subTest(field=key, value=value):
                response = self.client.post("/api/grocery-plan", json={**base, key: value})
                self.assertEqual(response.status_code, 400)
                self.assertTrue(response.json["error"])
                self.assertNotIn("groceries", response.json)

    def test_ambiguous_composite_foods_keep_conservative_vegan_filtering(self):
        from planning_preferences import product_is_diet_compatible
        plain = next(row for row in self.catalog if row["food_profile"] == "oats")
        self.assertTrue(product_is_diet_compatible(plain, "vegan"))
        for name in ("Cheddar flavored oatmeal packets", "Oats with milk", "Honey oatmeal bowl"):
            with self.subTest(name=name):
                self.assertFalse(product_is_diet_compatible({**plain, "product_name": name}, "vegan"))
        eggs = next(row for row in self.catalog if row["food_profile"] == "eggs")
        self.assertFalse(product_is_diet_compatible(eggs, "vegan"))
        self.assertTrue(product_is_diet_compatible(eggs, "vegetarian"))

    def test_six_sequential_alternatives_keep_diet_nutrition_and_history(self):
        """Exercise the real solve and API across each diet, not mocked baskets."""
        import math
        base = dict(budget=100, people=2, days=7, calories=2000, protein=50,
                    fiber_mode="recommended", preference="balanced", foods_to_avoid=[],
                    nutrition_focus="none", location={"locality": "Cox Mill", "region": "NC"})
        for diet in ("vegan", "vegetarian", "pescatarian", "omnivore"):
            payload = {**base, "diet": diet}
            response = self.client.post("/api/grocery-plan", json=payload)
            self.check_response(payload, response)
            self.assertEqual(response.status_code, 200)
            current = response.json
            history = []
            for index in range(6):
                with self.subTest(diet=diet, alternative=index + 1):
                    previous = {row["product_id"] for row in current["groceries"]}
                    response = self.client.post("/api/grocery-plan/alternative", json={
                        **payload, "excluded_product_ids": sorted(previous),
                        "groceries": [{"product_id": row["product_id"], "quantity": row["quantity"]}
                                      for row in current["groceries"]],
                        "previous_product_id_sets": history,
                    })
                    self.check_response(payload, response)
                    self.assertEqual(response.status_code, 200, response.json)
                    result = response.json
                    selected = {row["product_id"] for row in result["groceries"]}
                    minimum = max(2, math.ceil(len(previous) * 0.25))
                    self.assertGreaterEqual(len(previous - selected), minimum)
                    self.assertEqual(result["alternative_difference_count"], len(previous - selected))
                    self.assertGreaterEqual(result["alternative_required_changes"], minimum)
                    for prior in history:
                        self.assertGreaterEqual(len(set(prior) - selected), minimum)
                    history.append(sorted(previous))
                    current = result

    def test_no_distinct_alternative_is_reported_without_relabeling_current_basket(self):
        payload = dict(budget=100, people=2, days=7, diet="vegan", calories=2000,
                       protein=50, fiber_mode="recommended", preference="balanced",
                       foods_to_avoid=[], nutrition_focus="none")
        initial = self.client.post("/api/grocery-plan", json=payload)
        self.assertEqual(initial.status_code, 200)
        ids = {row["product_id"] for row in initial.json["groceries"]}
        # Legitimate user exclusions leave only the original, feasible food set.
        payload["foods_to_avoid"] = [row["food_profile"].replace("_", " ")
                                     for row in self.catalog if row["product_id"] not in ids]
        original = self.client.post("/api/grocery-plan", json=payload)
        self.assertEqual(original.status_code, 200)
        self.check_response(payload, original)
        self.assertEqual({row["product_id"] for row in original.json["groceries"]}, ids)
        response = self.client.post("/api/grocery-plan/alternative", json={
            **payload, "excluded_product_ids": sorted(ids),
        })
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json["error"],
                         "We couldn't find a sufficiently different alternative with these settings. "
                         "Your current plan is unchanged.")
        self.assertNotIn("groceries", response.json)
        # A failed alternative does not make the original preferences infeasible.
        restored = self.client.post("/api/grocery-plan", json=payload)
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(restored.json["groceries"], original.json["groceries"])

class AlternativePlanApiIntegrityTests(unittest.TestCase):
    """Route-level validation plus controlled real-solver candidate regressions."""

    def setUp(self):
        self.audit = DietaryBasketAuditTests()
        self.audit.setUp()
        self.addCleanup(self.audit.doCleanups)
        self.client = self.audit.client
        self.payload = dict(budget=100, people=2, days=7, diet="vegan", calories=2000,
                            protein=50, fiber_mode="recommended", preference="balanced",
                            nutrition_focus="none", foods_to_avoid=[])
        original = self.client.post("/api/grocery-plan", json=self.payload)
        self.assertEqual(original.status_code, 200)
        self.original = original.json
        self.reference = [{"product_id": row["product_id"], "quantity": row["quantity"]}
                          for row in self.original["groceries"]]
        self.ids = [row["product_id"] for row in self.reference]
        self.values, _, _ = app._planning_values(self.payload)
        self.eligible, _ = optimize_grocery.filter_catalog(self.audit.catalog, "vegan", [])

    def request(self, **changes):
        payload = {**self.payload, "excluded_product_ids": self.ids,
                   "groceries": self.reference, **changes}
        return self.client.post("/api/grocery-plan/alternative", json=payload)

    def assert_unavailable(self, response):
        self.assertEqual(response.status_code, 422, response.json)
        self.assertEqual(response.json["error"],
                         "We couldn't find a sufficiently different alternative with these settings. "
                         "Your current plan is unchanged.")
        self.assertNotIn("groceries", response.json)

    def test_missing_empty_unknown_mixed_and_duplicate_ids_are_client_errors(self):
        for ids in (None, [], ["not-a-demo-food"], [self.ids[0], "not-a-demo-food"],
                    [self.ids[0], self.ids[0]], [""], [" "], [1], "not-a-list"):
            with self.subTest(ids=ids):
                response = self.request(excluded_product_ids=ids)
                self.assertEqual(response.status_code, 400, response.json)
                self.assertTrue(response.json["error"])
                self.assertNotIn("groceries", response.json)
        missing = self.client.post("/api/grocery-plan/alternative", json=self.payload)
        self.assertEqual(missing.status_code, 400)

    def test_bad_reference_quantities_are_client_errors(self):
        import copy
        maximum = optimize_grocery.package_upper_bound(self.audit.by_id[self.ids[0]], 2, 7)
        for quantity in (0, -1, 1.5, True, "1", None, maximum + 1):
            rows = copy.deepcopy(self.reference)
            rows[0]["quantity"] = quantity
            with self.subTest(quantity=quantity):
                response = self.request(groceries=rows)
                self.assertEqual(response.status_code, 400, response.json)
                self.assertNotIn("groceries", response.json)
        rows = copy.deepcopy(self.reference)
        rows[0].pop("quantity")
        self.assertEqual(self.request(groceries=rows).status_code, 400)

    def test_reference_rows_must_match_unique_current_ids(self):
        for rows in (None, [], "not-a-list", [self.reference[0]],
                     [*self.reference, self.reference[0]],
                     [{"product_id": "not-a-demo-food", "quantity": 1}]):
            with self.subTest(rows=rows):
                self.assertEqual(self.request(groceries=rows).status_code, 400)

    def test_invalid_history_is_a_client_error(self):
        for history in ([[]], [["not-a-demo-food"]], [[self.ids[0], self.ids[0]]],
                        [[True]], [self.ids] * 7, "not-a-list"):
            with self.subTest(history=history):
                self.assertEqual(self.request(previous_product_id_sets=history).status_code, 400)

    def test_id_only_contract_remains_supported(self):
        response = self.client.post("/api/grocery-plan/alternative", json={
            **self.payload, "excluded_product_ids": self.ids,
        })
        self.audit.check_response(self.payload, response)
        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(len(set(self.ids) - {r["product_id"] for r in response.json["groceries"]}), 4)

    def test_valid_reference_and_forged_client_counts_use_actual_server_counts(self):
        response = self.request(alternative_required_changes=0, alternative_requested_changes=0,
                                alternative_difference_count=999)
        self.audit.check_response(self.payload, response)
        self.assertEqual(response.status_code, 200, response.json)
        difference = len(set(self.ids) - {r["product_id"] for r in response.json["groceries"]})
        self.assertGreaterEqual(difference, 4)
        self.assertEqual(response.json["alternative_requested_changes"], 4)
        self.assertEqual(response.json["alternative_required_changes"], 4)
        self.assertEqual(response.json["alternative_difference_count"], difference)

    def test_reference_price_and_nutrition_claims_are_ignored(self):
        rows = [{**row, "unit_price": 0, "item_total": 0, "food_profile": "forged",
                 "package_calories_kcal": 999999} for row in self.reference]
        response = self.request(groceries=rows)
        self.audit.check_response(self.payload, response)
        self.assertEqual(response.status_code, 200)

    def test_identical_real_candidate_cannot_be_certified_by_forged_counts(self):
        candidate = optimize_grocery.solve_plan(self.eligible, self.values)
        candidate.update(alternative_required_changes=999, alternative_requested_changes=999,
                         alternative_difference_count=999)
        with patch("app.solve_plan", return_value=candidate):
            self.assert_unavailable(self.request())

    def test_quantity_only_changes_do_not_count_as_substitutions(self):
        candidate = optimize_grocery.solve_plan(self.eligible, self.values)
        row = candidate["groceries"][0]
        row["quantity"] = 2 if row["quantity"] == 1 else row["quantity"] - 1
        candidate.update(alternative_required_changes=4, alternative_requested_changes=4,
                         alternative_difference_count=4)
        with patch("app.solve_plan", return_value=candidate):
            self.assert_unavailable(self.request())

    def test_insufficient_real_candidate_is_rejected_regardless_of_claims(self):
        candidate = optimize_grocery.solve_plan(self.eligible, self.values, {self.ids[0]})
        actual = len(set(self.ids) - {row["product_id"] for row in candidate["groceries"]})
        self.assertGreater(actual, 0)
        self.assertLess(actual, 4)
        candidate.update(alternative_required_changes=999, alternative_requested_changes=999,
                         alternative_difference_count=999)
        with patch("app.solve_plan", return_value=candidate):
            self.assert_unavailable(self.request())

    def test_valid_actual_candidate_overrides_forged_solver_metadata_and_prices(self):
        candidate = optimize_grocery.solve_plan(self.eligible, self.values, set(self.ids))
        candidate.update(alternative_required_changes=0, alternative_requested_changes=999,
                         alternative_difference_count=999)
        for row in candidate["groceries"]:
            row.update(unit_price=0, total_cost=0, package_calories_kcal=999999)
        with patch("app.solve_plan", return_value=candidate):
            response = self.request()
        self.audit.check_response(self.payload, response)
        self.assertEqual(response.status_code, 200, response.json)
        actual = len(set(self.ids) - {row["product_id"] for row in response.json["groceries"]})
        self.assertEqual(response.json["alternative_difference_count"], actual)
        self.assertEqual(response.json["alternative_required_changes"], 4)
        self.assertEqual(response.json["alternative_requested_changes"], 4)

    def test_actual_history_difference_is_checked_even_when_solver_claims_success(self):
        candidate = optimize_grocery.solve_plan(self.eligible, self.values, set(self.ids))
        history = [[row["product_id"] for row in candidate["groceries"]]]
        candidate.update(alternative_required_changes=4, alternative_requested_changes=4,
                         alternative_difference_count=4)
        with patch("app.solve_plan", return_value=candidate):
            self.assert_unavailable(self.request(previous_product_id_sets=history))

    def test_invalid_internal_candidate_is_unavailable_not_a_client_error(self):
        import copy
        original = optimize_grocery.solve_plan(self.eligible, self.values, set(self.ids))
        for quantity in (0, 1.5, True, 999):
            candidate = copy.deepcopy(original)
            candidate["groceries"][0]["quantity"] = quantity
            with self.subTest(quantity=quantity), patch("app.solve_plan", return_value=candidate):
                self.assert_unavailable(self.request())
        for identifier in ("not-a-demo-food", "demo-eggs"):
            candidate = copy.deepcopy(original)
            candidate["groceries"][0]["product_id"] = identifier
            with self.subTest(identifier=identifier), patch("app.solve_plan", return_value=candidate):
                self.assert_unavailable(self.request())

    def test_restricted_full_reference_keeps_original_on_no_alternative(self):
        payload = {**self.payload, "foods_to_avoid": [row["food_profile"].replace("_", " ")
                   for row in self.audit.catalog if row["product_id"] not in self.ids]}
        original = self.client.post("/api/grocery-plan", json=payload)
        self.assertEqual(original.status_code, 200)
        response = self.client.post("/api/grocery-plan/alternative", json={
            **payload, "excluded_product_ids": [r["product_id"] for r in original.json["groceries"]],
            "groceries": [{"product_id": r["product_id"], "quantity": r["quantity"]}
                          for r in original.json["groceries"]],
        })
        self.assert_unavailable(response)
        self.assertEqual(self.client.post("/api/grocery-plan", json=payload).json["groceries"],
                         original.json["groceries"])
