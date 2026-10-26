"""Offline identity, source-preservation, suitability and planning-boundary tests."""
import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import app
from retailer_policy import (retailer_policy, resolve_retailer, planning_suitability,
                             planning_allowed, enrich_retailer, UNRESOLVED_NAME)

ROOT = Path(__file__).resolve().parents[1]

class RetailerPolicyTests(unittest.TestCase):
    def setUp(self):
        self.record = {"record_id": 1235424, "store_name": "2701868.0 1868",
                       "street_address": "8855 Christenbury Pkwy", "additional_address": "",
                       "city": "Concord", "state": "NC", "zip_code": "28027",
                       "store_type": "Convenience Store"}

    def test_circle_k_exact_identity_and_source_unchanged(self):
        before = copy.deepcopy(self.record)
        resolved = enrich_retailer(self.record)
        self.assertEqual(resolved["display_name"], "Circle K")
        self.assertEqual(resolved["name_resolution"]["source"], "verified_mapping")
        self.assertEqual(resolved["planning_suitability"]["category"], "limited")
        self.assertEqual(self.record, before)
        self.assertEqual(resolved["store_name"], "2701868.0 1868")

    def test_harmless_address_variants(self):
        variants = {**self.record, "record_id": "1235424.0", "street_address": "8855 CHRISTENBURY PARKWAY.", "city": "CONCORD", "zip_code": "28027-1234"}
        self.assertEqual(resolve_retailer(variants)["display_name"], "Circle K")

    def test_same_zip_nearby_or_incomplete_addresses_never_match(self):
        for field, value in (("street_address", "8820 Christenbury Pkwy"), ("city", "Charlotte"),
                             ("state", "SC"), ("zip_code", "28028"), ("record_id", 1868),
                             ("additional_address", "Suite B"), ("street_address", ""),
                             ("zip_code", ""), ("city", ""), ("record_id", None)):
            with self.subTest(field=field, value=value):
                record = {**self.record, field: value, "latitude": 35, "longitude": -80}
                self.assertEqual(resolve_retailer(record)["display_name"], UNRESOLVED_NAME)

    def test_conflicting_and_duplicate_mappings_rejected(self):
        policy = copy.deepcopy(retailer_policy())
        policy["identities"].append({**policy["identities"][0], "display_name": "Different business"})
        self.assertEqual(resolve_retailer(self.record, policy)["display_name"], UNRESOLVED_NAME)
        policy["identities"][1] = dict(policy["identities"][0])
        self.assertEqual(resolve_retailer(self.record, policy)["display_name"], UNRESOLVED_NAME)

    def test_unreviewed_mapping_rejected(self):
        for field in ("verification_date", "source_url", "source_type"):
            policy = copy.deepcopy(retailer_policy())
            policy["identities"][0].pop(field)
            self.assertEqual(resolve_retailer(self.record, policy)["display_name"], UNRESOLVED_NAME)

    def test_valid_usda_name_wins_over_stale_display_and_mapping(self):
        record = {**self.record, "store_name": "99 Ranch Market", "display_name": "SNAP retailer"}
        result = resolve_retailer(record)
        self.assertEqual(result["display_name"], "99 Ranch Market")
        self.assertEqual(result["name_resolution"]["source"], "usda")

    def test_existing_valid_normalized_name_precedes_mapping(self):
        record = {**self.record, "display_name": "Reviewed Business"}
        self.assertEqual(resolve_retailer(record)["display_name"], "Reviewed Business")

    def test_blank_numeric_and_generic_names_use_transparent_fallback(self):
        for name in (None, "", "123 456", "SNAP retailer", "SNAP-authorized retailer", UNRESOLVED_NAME):
            self.assertEqual(resolve_retailer({"store_name": name})["display_name"], UNRESOLVED_NAME)

    def test_legacy_saved_store_without_full_address_not_guessed(self):
        record = {"record_id": 1235424, "name": "SNAP retailer", "source_name": "2701868.0 1868", "city": "Concord", "region": "NC"}
        self.assertEqual(resolve_retailer(record)["display_name"], UNRESOLVED_NAME)

    def test_all_reviewed_categories_and_aliases(self):
        for key, category in retailer_policy()["categories"].items():
            for store_type in category["types"]:
                with self.subTest(store_type=store_type):
                    self.assertEqual(planning_suitability(store_type.lower())["category"], key)

    def test_full_suitability_display_label_preserves_category_and_selection_rules(self):
        for store_type in ("SM", "SS", "LG", "MG", "Supermarket", "Grocery Store"):
            result = planning_suitability(store_type)
            self.assertEqual(result, {"category": "full", "label": "Suitable for grocery planning"})
            self.assertTrue(planning_allowed({"store_type": store_type}))
        self.assertEqual(planning_suitability("CS")["category"], "limited")
        self.assertEqual(planning_suitability("BB")["category"], "specialty")

    def test_unknown_types_are_not_guessed_from_business_name(self):
        for value in (None, "", "Not listed", "Made-up", "Internet Retailer", "Military Commissary"):
            self.assertEqual(planning_suitability(value)["category"], "unknown")
        self.assertFalse(planning_allowed({"name": "Supermarket", "store_type": "Convenience Store"}))

    def test_unknown_requires_explicit_boolean_acknowledgement(self):
        self.assertFalse(planning_allowed({"store_type": ""}))
        self.assertFalse(planning_allowed({"illustrative_plan_acknowledged": "true"}))
        self.assertTrue(planning_allowed({"illustrative_plan_acknowledged": True}))

    def test_acknowledgement_never_overrides_known_limited_or_specialty(self):
        for store_type in ("CS", "SG", "CO", "BB", "ME", "SE", "FV"):
            self.assertFalse(planning_allowed({"store_type": store_type, "illustrative_plan_acknowledged": True}))

    def test_full_categories_enable_planning(self):
        for value in ("SM", "SS", "LG", "MG", "Supermarket"):
            self.assertTrue(planning_allowed({"store_type": value}))

    def test_api_rejects_noneligible_store_before_solver_for_both_generation_routes(self):
        client = app.app.test_client()
        with patch.object(app, "solve_plan", side_effect=AssertionError("Solver must not run")):
            for route in ("/api/grocery-plan", "/api/grocery-plan/alternative"):
                for store in (self.record, {"store_type": "BB"}, {"store_type": ""}, "invalid"):
                    response = client.post(route, json={"selected_store": store})
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertTrue(response.json.get("retailer_planning_blocked"))

    def test_api_does_not_trust_client_eligibility_metadata(self):
        with patch.object(app, "solve_plan", side_effect=AssertionError("Solver must not run")):
            response = app.app.test_client().post("/api/grocery-plan", json={"selected_store": {**self.record, "planning_suitability": {"category": "full"}, "illustrative_plan_acknowledged": True}})
        self.assertEqual(response.status_code, 400)

    def test_generic_api_and_full_or_acknowledged_store_keep_numeric_validation(self):
        for store in (None, {"store_type": "SM"}, {"store_type": "", "illustrative_plan_acknowledged": True}):
            response = app.app.test_client().post("/api/grocery-plan", json={"selected_store": store})
            self.assertEqual(response.status_code, 400)
            self.assertFalse(response.json.get("retailer_planning_blocked", False))
            self.assertIn("Budget", response.json["error"])

    def test_policy_packaging_manifest_and_no_sync_business_lookup(self):
        manifest = (ROOT / "RELEASE_MANIFEST.txt").read_text(encoding="utf-8").splitlines()
        for name in ("retailer_policy.py", "data/retailers/verified_identities.json", "data/retailers/README.md", "tests/test_retailer_policy.py"):
            self.assertIn(name, manifest)
            self.assertTrue((ROOT / name).is_file())
        source = (ROOT / "retailer_policy.py").read_text(encoding="utf-8")
        self.assertNotIn("urllib", source)
        self.assertNotIn("requests.", source)
        config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
        self.assertNotIn("data/**", config["functions"]["app.py"]["excludeFiles"])

    def test_policy_embedded_safely_and_filters_accessible(self):
        page = app.app.test_client().get("/").text
        self.assertIn('id="retailer-policy" type="application/json"', page)
        self.assertIn('name="retailer_filter" value="suitable" checked', page)
        self.assertIn('name="retailer_filter" value="all"', page)
        self.assertIn('id="retailer-count" role="status" aria-live="polite"', page)
        self.assertIn("Illustrative grocery selections and prices. Availability at the selected store has not been verified.", page)

    def test_store_finder_copy_distinguishes_planning_stores_from_all_snap(self):
        page = app.app.test_client().get("/").text
        self.assertIn("Find stores suitable for grocery planning, or view all SNAP retailers. Product availability may vary.", page)
        self.assertIn('value="suitable" checked> Grocery planning stores', page)
        self.assertIn('value="all"> All SNAP retailers', page)
        self.assertIn("Includes convenience and specialty stores that accept SNAP; a full grocery assortment is not verified.", page)
        self.assertNotIn("The planning view shows broader grocery categories.", page)

    def test_missing_or_invalid_policy_fails_conservatively(self):
        retailer_policy.cache_clear()
        self.addCleanup(retailer_policy.cache_clear)
        with patch("retailer_policy.Path.read_text", side_effect=OSError):
            self.assertEqual(resolve_retailer(self.record)["display_name"], UNRESOLVED_NAME)
            self.assertFalse(planning_allowed({"store_type": "Supermarket"}))

    def test_eligible_store_plans_keep_acceptance_and_nutrition_for_both_diets(self):
        client = app.app.test_client()
        base = {"budget": 100, "people": 1, "days": 3, "preference": "balanced",
                "fiber_mode": "recommended", "calories": 1800, "protein": 50,
                "nutrition_focus": "high_fiber", "foods_to_avoid": ["potato"],
                "location": {"locality": "Concord", "region": "NC"}}
        for diet in ("vegan", "vegetarian"):
            for store in ({"store_type": "Supermarket", "name": "Public Market"},
                          {"store_type": "", "name": "Public Cooperative", "illustrative_plan_acknowledged": True}):
                with self.subTest(diet=diet, store_type=store["store_type"]):
                    response = client.post("/api/grocery-plan", json={**base, "diet": diet, "selected_store": store})
                    self.assertEqual(response.status_code, 200, response.json)
                    self.assertTrue(response.json["acceptance"]["accepted"])
                    self.assertLessEqual(response.json["total_cost"], 100)
                    self.assertTrue(response.json["groceries"])

    def test_usda_category_punctuation_variants(self):
        self.assertEqual(planning_suitability("Specialty Food Store \u2013 Seafood")["category"], "specialty")
        self.assertEqual(planning_suitability("Farmers\u2019 Market")["category"], "specialty")
