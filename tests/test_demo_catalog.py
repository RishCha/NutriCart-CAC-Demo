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
            self.assertIn('example groceries', response.json['error'])

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
