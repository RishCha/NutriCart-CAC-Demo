"""Guest deployment checks without credentials, external services, or local account data."""

import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import app
from build_vercel import ASSETS, build_assets
from snap_store_locator import retailer_display_name, find_snap_retailers


ROOT = Path(__file__).resolve().parents[1]


class VercelDemoTests(unittest.TestCase):
    def setUp(self):
        self.config = patch.dict(app.app.config, TESTING=True, ACCOUNTS_ENABLED=False,
                                 SECRET_KEY="isolated-demo-test", SESSION_COOKIE_SECURE=False)
        self.config.start()
        self.addCleanup(self.config.stop)
        self.store = patch.object(app, "_supabase_accounts", side_effect=AssertionError("Guest demo contacted Supabase"))
        self.store.start()
        self.addCleanup(self.store.stop)
        self.client = app.app.test_client()

    def test_analytics_requires_vercel_and_nonlocal_host(self):
        for vercel, host, enabled in (("", "https://demo.example", False), ("1", "https://demo.example", True), ("1", "http://localhost", False), ("1", "http://127.0.0.1:5000", False), ("1", "http://[::1]:5000", False)):
            with self.subTest(vercel=vercel, host=host), patch.dict(os.environ, VERCEL=vercel):
                page = self.client.get("/", base_url=host).text
                self.assertEqual(page.count('src="/_vercel/insights/script.js"'), int(enabled))
                self.assertEqual("window.vaq" in page, enabled)
                if enabled:
                    self.assertIn('<script defer src="/_vercel/insights/script.js"></script>', page)
                    self.assertNotIn("va('event'", page)

    def test_password_reset_omits_analytics_on_vercel(self):
        with patch.dict(os.environ, VERCEL="1"):
            response = self.client.get("/reset-password?token=synthetic-test", base_url="https://demo.example")
            self.assertNotIn("/_vercel/insights/script.js", response.text)

    def test_guest_startup_and_stale_account_cookie_never_access_database(self):
        with self.client.session_transaction() as session:
            session["user_id"] = 1
            session["auth_version"] = 0
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn(b"Your all-in-one SNAP shopping companion", page.data)
        response = self.client.get("/api/account/session")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json["authenticated"])
        with self.client.session_transaction() as session:
            self.assertNotIn("user_id", session)

    def test_public_demo_renders_guest_account_message_without_auth_controls(self):
        page = self.client.get("/").text
        self.assertIn("Saved accounts aren’t available in this demo", page)
        self.assertIn("Continue as Guest", page)
        self.assertIn('data-accounts-enabled="false"', page)
        for unavailable in ('id="sign-in-form"', 'id="create-account-form"',
                            'id="forgot-password-form"', 'id="sign-in-email"',
                            'id="sign-in-password"'):
            self.assertNotIn(unavailable, page)
        for save_control in ("save-grocery-plan", "save-meal-plan", "save-shopping-list"):
            self.assertRegex(page, rf'id="{save_control}"[^>]* hidden')

    def test_settings_icon_uses_browser_independent_svg(self):
        page = self.client.get("/").text
        template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        self.assertEqual(page.count('class="settings-icon"'), 1)
        self.assertEqual(page.count('class="settings-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"'), 1)
        self.assertIn('stroke="currentColor"', page.split('id="settings-button"', 1)[1].split('</button>', 1)[0])
        self.assertIn('id="settings-button"', page)
        self.assertIn('aria-label="Settings" title="Settings"', page)
        self.assertNotIn('id="account-menu-app-settings"', page)
        self.assertNotIn("\u2699", template)
        self.assertIn(".settings-icon { display: block; flex: 0 0 20px; width: 20px; height: 20px; }", styles)
        self.assertIn('<div class="app-settings-utility">', page)
        self.assertNotIn('document.querySelector(".app-settings-utility").hidden', (ROOT / "static" / "account.js").read_text(encoding="utf-8"))
        self.assertIn("styles.css?v=store-progress-79a", page)

    def test_shared_brand_logo_is_a_transparent_shopping_cart(self):
        logo = (ROOT / "templates" / "nutricart-logo.svg").read_text(encoding="utf-8").strip()
        page = self.client.get("/").text
        reset = self.client.get("/reset-password").text
        self.assertIn('viewBox="0 0 64 64"', logo)
        self.assertIn('id="shopping-cart-symbol"', logo)
        self.assertIn('class="cart-handle"', logo)
        self.assertIn('class="cart-basket"', logo)
        self.assertIn('class="cart-slats"', logo)
        self.assertEqual(logo.count('class="cart-wheel"'), 2)
        self.assertIn('stroke="#194f38"', logo)
        self.assertNotIn('id="basket-symbol"', logo)
        self.assertNotIn('class="basket-handle"', logo)
        self.assertNotIn("leaf", logo.lower())
        self.assertNotIn("<rect", logo)
        self.assertNotRegex(logo, r'<(?:svg|g)[^>]+fill="#194f38"')
        self.assertEqual(page.count(logo), 2)
        self.assertIn(logo, reset)
        self.assertIn("templates/nutricart-logo.svg", (ROOT / "RELEASE_MANIFEST.txt").read_text(encoding="utf-8"))
    def test_planner_uses_friendly_people_and_days_validation(self):
        script = (ROOT / "static" / "grocery.js").read_text(encoding="utf-8")
        page = self.client.get("/").text
        self.assertIn("NutriCart supports plans for 1–20 people and 1–31 days.", script)
        self.assertIn("NutriCart supports plans for 1–20 people.", script)
        self.assertIn("NutriCart supports plans for 1–31 days.", script)
        self.assertNotIn("People must be a whole number from 1 to 20.", script)
        self.assertNotIn("Days must be a whole number from 1 to 31.", script)
        self.assertIn('filename=\'grocery.js\', v=\'store-progress-79a\'', (ROOT / "templates" / "index.html").read_text(encoding="utf-8"))
        self.assertIn("grocery.js?v=store-progress-79a", page)

    def test_omnivore_value_is_displayed_as_non_vegetarian_everywhere(self):
        page = self.client.get("/").text
        grocery = (ROOT / "static" / "grocery.js").read_text(encoding="utf-8")
        meal = (ROOT / "static" / "meal_plan.js").read_text(encoding="utf-8")
        account = (ROOT / "static" / "account.js").read_text(encoding="utf-8")
        cli = (ROOT / "optimize_grocery.py").read_text(encoding="utf-8")
        self.assertIn('name="diet" value="omnivore" required> Non-Vegetarian', page)
        self.assertNotIn('required> Omnivore', page)
        for source in (grocery, meal, account):
            self.assertIn('omnivore', source)
            self.assertIn('Non-Vegetarian', source)
        self.assertIn('1. Non-Vegetarian', cli)
        self.assertIn('"1": "omnivore"', cli)

    def test_successful_signout_clears_private_ui_state_and_failed_signout_does_not_navigate(self):
        account = (ROOT / "static" / "account.js").read_text(encoding="utf-8")
        store = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        grocery = (ROOT / "static" / "grocery.js").read_text(encoding="utf-8")
        meal = (ROOT / "static" / "meal_plan.js").read_text(encoding="utf-8")
        budget = (ROOT / "static" / "budget_tracker.js").read_text(encoding="utf-8")
        success = account.split('async function signOut()', 1)[1].split('document.querySelector("#sign-out")', 1)[0]
        self.assertLess(success.index('await api("/api/account/logout"'), success.index('clearSignedInState()'))
        self.assertLess(success.index('clearSignedInState()'), success.index('nutricart:account-signed-out'))
        failure = success.split('catch (error)', 1)[1].split('return;', 1)[0]
        self.assertIn('Sign out failed. Please try again.', failure)
        self.assertNotIn('nutricart:account-signed-out', failure)
        self.assertIn('document.querySelector("#saved-items").replaceChildren()', account)
        self.assertIn('currentPlan = null', account)
        self.assertIn('currentMeal = null', account)
        for source in (store, grocery, meal, budget):
            self.assertIn('addEventListener("nutricart:account-signed-out"', source)
        self.assertIn('publishLocation(null)', store)
        self.assertIn('await switchView("home")', grocery)
        self.assertIn('purchases = []', budget)
        self.assertIn('currentPlan = null', meal)

    def test_planner_required_fields_have_inline_accessible_validation(self):
        script = (ROOT / "static" / "grocery.js").read_text(encoding="utf-8")
        page = self.client.get("/").text
        for name, message in (
            ("budget", "Enter your grocery budget."),
            ("people", "Enter the number of people."),
            ("days", "Enter the number of shopping days."),
            ("diet", "Choose a dietary preference."),
        ):
            with self.subTest(name=name):
                self.assertIn(f'id="{name}-validation" class="planner-inline-error" role="alert"', page)
                self.assertIn(message, script)
        self.assertEqual(page.count('class="required-marker" aria-hidden="true">*</span>'), 4)
        self.assertGreaterEqual(page.count('aria-required="true"'), 4)
        self.assertIn("validateRequiredPlannerFields(values, true)", script)
        self.assertIn('behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"', script)
        self.assertIn("firstInvalid.control.focus({preventScroll: true})", script)
        self.assertIn("refreshRequiredPlannerField(field)", script)

    def test_basket_summary_uses_selected_store_name_without_location_fallback(self):
        script = (ROOT / "static" / "grocery.js").read_text(encoding="utf-8")
        self.assertIn("function selectedStoreName(context)", script)
        self.assertIn("context?.selected_store?.name", script)
        self.assertIn("function normalizeSelectedStore(context)", script)
        self.assertIn("window.NutriCartStore?.displayName", script)
        render = script.split("function renderResult", 1)[1].split("function formatPlanForCopy", 1)[0]
        self.assertIn("storeLabel", render)
        self.assertIn("[storeLabel,", render)
        self.assertIn(".filter(Boolean).join", render)
        self.assertNotIn("locationLabel", render)
        self.assertNotIn("context.location?.locality", render)
        page = self.client.get("/").text
        self.assertIn("Basket items are planning suggestions. Prices and product availability vary by retailer and location.", page)
        self.assertNotIn("Prices are recently observed retailer prices", page)

    def test_snap_retailer_display_names_are_readable_without_changing_source_names(self):
        self.assertEqual(retailer_display_name("2701868.0 1868"), "SNAP retailer")
        self.assertEqual(retailer_display_name("  7-Eleven   #249238A "), "7-Eleven")
        self.assertEqual(retailer_display_name("7-eleven #41347a 41347A"), "7-Eleven")
        self.assertEqual(retailer_display_name("Circle K 1490"), "Circle K")
        self.assertEqual(retailer_display_name("99 Ranch Market"), "99 Ranch Market")
        self.assertEqual(retailer_display_name("Community Foods #A-17"), "Community Foods")
        self.assertEqual(retailer_display_name("Market 12"), "Market 12")

    def test_snap_unusable_and_legacy_names_use_neutral_fallback(self):
        for raw in (None, "", "   ", 2701868, "2701868.0 1868", "123 #456",
                    "SNAP-authorized retailer", "snap retailer"):
            with self.subTest(raw=raw):
                self.assertEqual(retailer_display_name(raw), "SNAP retailer")

    def test_snap_names_preserve_business_identity_and_repeated_suffixes(self):
        for raw, expected in (
            ("QuikTrip 1021", "QuikTrip"), ("Circle K 1490 1490", "Circle K"),
            ("7-eleven #41347a 41347A", "7-Eleven"),
            ("99 Ranch Market", "99 Ranch Market"), ("Market 12", "Market 12"),
            ("24 Hour Market", "24 Hour Market"), ("7-Eleven", "7-Eleven"),
            ("Community Foods #A-17", "Community Foods"),
            ("Community Foods #A-17 Deli", "Community Foods #A-17 Deli"),
        ):
            with self.subTest(raw=raw):
                self.assertEqual(retailer_display_name(raw), expected)

    def test_snap_observed_numeric_source_survives_normalization_and_api(self):
        # Public USDA record checked during Task 79A: no usable business name.
        attributes = {"Record_ID": 1235424, "Store_Name": "2701868.0 1868",
                      "Store_Street_Address": "8855 Christenbury Pkwy", "City": "Concord",
                      "State": "NC", "Store_Type": "Convenience Store",
                      "Latitude": 35, "Longitude": -80}
        with patch("snap_store_locator.request_json", return_value={
                "features": [{"attributes": attributes}], "exceededTransferLimit": False}):
            stores = find_snap_retailers(35, -80)
        self.assertEqual(len(stores), 1)
        self.assertEqual(stores[0]["display_name"], "SNAP retailer")
        self.assertEqual(stores[0]["store_name"], attributes["Store_Name"])
        with patch.object(app, "find_snap_retailers", return_value=stores):
            response = self.client.post("/api/snap-retailers", json={"latitude": 35, "longitude": -80, "radius_miles": 5})
        self.assertEqual(response.status_code, 200)
        store = response.json["retailers"][0]
        for api_key, source_key in (("record_id", "Record_ID"), ("store_name", "Store_Name"),
                                    ("street_address", "Store_Street_Address"), ("store_type", "Store_Type")):
            self.assertEqual(store[api_key], attributes[source_key])
        self.assertEqual(store["display_name"], "SNAP retailer")
        self.assertEqual(store["distance_miles"], 0)

    def test_snap_api_keeps_duplicate_chain_locations_and_raw_source_names(self):
        stores = [
            {"record_id": "one", "store_name": "7-Eleven #100A", "display_name": "7-Eleven",
             "street_address": "1 First Street", "city": "Concord", "state": "NC", "distance_miles": 1.0},
            {"record_id": "two", "store_name": "7-Eleven #200B", "display_name": "7-Eleven",
             "street_address": "2 Second Street", "city": "Concord", "state": "NC", "distance_miles": 2.0},
        ]
        with patch.object(app, "find_snap_retailers", return_value=stores):
            response = self.client.post("/api/snap-retailers", json={"latitude": 35, "longitude": -80, "radius_miles": 5})
        self.assertEqual(response.status_code, 200)
        retailers = response.get_json()["retailers"]
        self.assertEqual(len(retailers), 2)
        self.assertEqual([item["display_name"] for item in retailers], ["7-Eleven", "7-Eleven"])
        self.assertEqual([item["store_name"] for item in retailers], ["7-Eleven #100A", "7-Eleven #200B"])
        self.assertEqual([item["record_id"] for item in retailers], ["one", "two"])
        self.assertNotEqual(retailers[0]["street_address"], retailers[1]["street_address"])

    def test_basket_actions_have_separate_save_state_and_responsive_toolbar(self):
        page = self.client.get("/").text
        account = (ROOT / "static" / "account.js").read_text(encoding="utf-8")
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        self.assertIn('id="grocery-plan-saved" class="saved-plan-indicator" hidden', page)
        self.assertIn('role="group" aria-label="Grocery basket actions"', page)
        self.assertLess(page.index('id="copy-grocery-plan"'), page.index('id="edit-plan"'))
        self.assertLess(page.index('id="edit-plan"'), page.index('id="alternative-plan"'))
        self.assertIn("function showGroceryPlanSaved(saved)", account)
        self.assertIn("button.hidden = saved || !accountsEnabled", account)
        self.assertIn("indicator.hidden = !saved", account)
        self.assertIn(".basket-action-area", styles)
        self.assertIn(".result-utilities #alternative-plan", styles)

    def test_meal_plan_generated_hierarchy_and_completion_actions(self):
        page = self.client.get("/").text
        script = (ROOT / "static" / "meal_plan.js").read_text(encoding="utf-8")
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        for text in (
            "Your Meal Plan", "Daily Meals", "Your plan is ready!",
            "You've found a store, planned groceries, organized your shopping budget, and explored meal ideas.",
            "Plan Another Grocery Trip", "Back to Grocery Basket",
        ):
            self.assertIn(text, page + script)
        self.assertIn("A ${data.rotation_days}-day meal rotation for your ${data.days_requested}-day grocery plan.", script)
        self.assertIn('document.querySelector("#edit-plan").click()', script)
        self.assertIn('navigate("planner")', script)
        self.assertIn("meal-card--${mealType", script)
        self.assertIn(".meal-product-details summary:focus-visible", styles)
        self.assertIn(".meal-completion-actions", styles)

    def test_runtime_recipe_enhancement_is_not_shipped(self):
        page = self.client.get("/").text
        script = (ROOT / "static" / "meal_plan.js").read_text(encoding="utf-8")
        manifest = (ROOT / "RELEASE_MANIFEST.txt").read_text(encoding="utf-8")
        env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertNotIn("meal-ai-note", page)
        self.assertNotIn("recipe_directions_ai_assisted", script)
        self.assertNotIn("recipe_enhancer.py", manifest)
        self.assertNotIn("test_recipe_enhancer.py", manifest)
        self.assertNotIn("NUTRICART_AI_RECIPES_ENABLED", env_example)
        self.assertNotIn("NUTRICART_RECIPE_API_", env_example)

    def test_unlocked_meal_plan_empty_state_is_compact_and_connected(self):
        page = self.client.get("/").text
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("Your groceries are ready. Let's plan some meals.", page)
        self.assertIn("Use the foods already in your basket.", page)
        self.assertRegex(page, r'id="meal-plan-ready"[^>]* hidden')
        self.assertIn("#meal-plan-view:has(#meal-plan-ready:not([hidden])) .meal-plan-heading", styles)
        self.assertIn("width: min(100%, 760px)", styles)
        self.assertIn("#meal-plan-ready .primary", styles)
        self.assertNotIn("min-height: 330px", styles.split("/* Compact unlocked Meal Plan action state. */", 1)[1])
        self.assertIn("styles.css?v=store-progress-79a", page)

    def test_feedback_modal_has_optional_two_stage_actions(self):
        page = self.client.get("/").text
        script = (ROOT / "static" / "feedback.js").read_text(encoding="utf-8")
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        for text in (
            "How was your NutriCart experience?",
            "Your feedback helps make NutriCart better.",
            "Comment (optional)",
        ):
            self.assertIn(text, page)
        self.assertNotIn("Please leave out personal and shopping details.", page)
        self.assertNotIn("id=\"feedback-note\"", page)
        for identifier in ("feedback-skip", "feedback-done", "feedback-cooldown", "feedback-cooldown-done", "feedback-support"):
            self.assertIn(f'id="{identifier}"', page)
        for text in (
            "What did you like about NutriCart?",
            "What could we improve?",
            "We value your feedback.",
            "Thank you for helping us improve NutriCart!",
            "Your feedback has been submitted.",
        ):
            self.assertIn(text, script)
        self.assertIn('skip.addEventListener("click", () => deliver(""))', script)
        self.assertIn("!comment.value.trim()", script)
        self.assertIn("function readableFailure(data)", script)
        self.assertIn("let failureMessage = genericFailure", script)
        self.assertIn("const cooldownFailure", script)
        self.assertIn('const cooldownKey = "nutricart:feedback-cooldown-until"', script)
        self.assertIn("const cooldownDuration = 60 * 1000", script)
        self.assertIn("sessionStorage.setItem(cooldownKey", script)
        self.assertIn("sessionStorage.getItem(cooldownKey)", script)
        self.assertIn("startCooldown();", script)
        self.assertIn("response.status === 429", script)
        self.assertNotIn("new Error(data.error", script)
        self.assertIn(".feedback-actions", styles)
        self.assertIn("feedback.js?v=feedback-54", page)

    def test_page_background_gradients_do_not_repeat(self):
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        body_rule = styles.rsplit("body {", 1)[1].split("}", 1)[0]
        self.assertIn("background-repeat: no-repeat", body_rule)
        self.assertIn("background-position: center top", body_rule)
        self.assertIn("background-size: 100% max(48rem, 100vh)", body_rule)
        self.assertIn("radial-gradient(circle at 90% 8%, #dcecdf", body_rule)
        self.assertIn("radial-gradient(circle at 8% 35%, #f4dfc9", body_rule)

    def test_sequential_workflow_locks_are_visible_and_event_driven(self):
        page = self.client.get("/").text
        grocery = (ROOT / "static" / "grocery.js").read_text(encoding="utf-8")
        store_finder = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        meal = (ROOT / "static" / "meal_plan.js").read_text(encoding="utf-8")
        for step in ("Step 1 of 4", "Step 2 of 4", "Step 3 of 4", "Step 4 of 4"):
            self.assertIn(step, page)
        self.assertLess(page.index('id="snap-tab"'), page.index('id="planner-tab"'))
        self.assertLess(page.index('id="planner-tab"'), page.index('id="shopping-budget-tab"'))
        self.assertLess(page.index('id="shopping-budget-tab"'), page.index('id="meal-plan-tab"'))
        self.assertIn('Step 3 of 4</p><h1 id="budget-view-title">Shopping Budget', page)
        self.assertIn('Step 4 of 4</p><h1 id="meal-plan-title">Meal Plan', page)
        self.assertIn("Continue to Shopping Budget", page)
        self.assertIn('id="budget-open-meal"', page)
        self.assertIn("Continue to Meal Plan", page)
        self.assertNotIn('id="open-meal-from-plan"', page)
        for message in (
            "Find a SNAP-authorized store first to unlock grocery planning.",
            "Create your grocery basket first to unlock meal ideas.",
            "Create your grocery basket first to start tracking your shopping.",
        ):
            self.assertIn(message, page)
        self.assertIn('id="shopping-budget-locked"', page)
        self.assertIn('class="nav-lock-indicator"', page)
        self.assertEqual(page.count('class="workflow-locked-card"'), 3)
        self.assertEqual(page.count('class="workflow-lock-badge"'), 3)
        self.assertEqual(page.count('class="workflow-lock-svg"'), 6)
        self.assertNotIn("workflow-lock-icon", page)
        self.assertNotRegex(page, r'id="(?:planner-tab|meal-plan-tab|shopping-budget-tab)"[^>]*disabled')
        self.assertIn("hasPlanningLocation() && hasPlanningStore()", grocery)
        self.assertIn('addEventListener("nutricart:store-changed", () => {', grocery)
        self.assertIn("if (hasCurrentBasket()) invalidateCurrentPlanForLocation();", grocery)
        self.assertIn('addEventListener("nutricart:plan-updated", updateWorkflowState)', grocery)
        self.assertIn("window.NutriCartPlanState", grocery)
        self.assertIn('event.detail?.view !== "meal"', meal)
        self.assertIn("window.NutriCartPlanState?.get()", meal)
        self.assertIn("revision === currentPlanRevision", meal)
        self.assertIn("invalidateCurrentPlanForLocation()", grocery)
        self.assertIn('dispatchEvent(new CustomEvent("nutricart:store-changed"', store_finder)
        self.assertIn('lockedAction.dataset.workflowTarget || "planner"', meal)

    def test_account_enabled_mode_preserves_authentication_forms(self):
        with patch.dict(app.app.config, ACCOUNTS_ENABLED=True, SUPABASE_URL="https://project.supabase.co", SUPABASE_ANON_KEY="publishable-test-key"):
            page = self.client.get("/").text
        self.assertIn('data-accounts-enabled="true"', page)
        self.assertIn('id="sign-in-form"', page)
        self.assertIn('id="create-account-form"', page)
        self.assertIn('id="forgot-password-form"', page)
        self.assertNotIn('id="demo-account-panel"', page)
        for save_control in ("save-grocery-plan", "save-meal-plan", "save-shopping-list"):
            self.assertNotRegex(page, rf'id="{save_control}"[^>]* hidden')

    def test_account_and_saved_content_endpoints_fail_honestly_before_storage(self):
        for method, endpoint in (("post", "/api/account/register"), ("post", "/api/account/login"),
                                 ("post", "/api/account/forgot-password"), ("post", "/api/account/reset-password"),
                                 ("patch", "/api/account/profile"), ("delete", "/api/account"),
                                 ("get", "/api/saved-items"), ("post", "/api/saved-items"),
                                 ("get", "/api/saved-items/1")):
            with self.subTest(endpoint=endpoint, method=method):
                response = getattr(self.client, method)(endpoint)
                self.assertEqual(response.status_code, 503)
                self.assertIn("public demo", response.json["error"])

    def test_password_meter_and_recovery_copy_are_packaged(self):
        with patch.dict(app.app.config, ACCOUNTS_ENABLED=True, SUPABASE_URL="https://project.supabase.co", SUPABASE_ANON_KEY="publishable-test-key"):
            page = self.client.get("/").text
        reset = self.client.get("/reset-password").text
        script = Path("static/password_fields.js").read_text(encoding="utf-8")
        account = Path("static/account.js").read_text(encoding="utf-8")
        self.assertIn("Use 10+ characters, including letters and numbers.", page)
        self.assertIn("Use 10+ characters, including letters and numbers.", reset)
        self.assertIn('role", "meter"', script)
        self.assertIn("PASSWORD_RECOVERY_RATE_LIMIT_MESSAGE", account)
        self.assertIn("password-meter-77a", page)
        self.assertIn("password-meter-77a", reset)

    def test_logout_and_reset_page_remain_accessible(self):
        csrf = self.client.get("/api/account/session").json["csrf_token"]
        self.assertEqual(self.client.post("/api/account/logout", headers={"X-CSRF-Token": csrf}).status_code, 200)
        self.assertEqual(self.client.get("/reset-password").status_code, 200)

    def test_guest_apis_are_not_redirected_to_login(self):
        for endpoint in ("/api/grocery-plan", "/api/meal-plan"):
            response = self.client.post(endpoint, json={})
            self.assertEqual(response.status_code, 400)
            self.assertNotIn("sign in", response.json["error"].lower())
        response = self.client.post("/api/snap-retailers", json={})
        self.assertEqual(response.status_code, 400)

    def test_real_guest_basket_and_meals_work_without_storage(self):
        payload = {"budget": 100, "people": 1, "days": 3, "diet": "pescatarian",
                   "preference": "balanced", "fiber_mode": "recommended",
                   "calories": 1800, "protein": 50, "nutrition_focus": "high_fiber",
                   "foods_to_avoid": ["potato"], "location": {"locality": "Raleigh", "region": "NC"}}
        response = self.client.post("/api/grocery-plan", json=payload)
        self.assertEqual(response.status_code, 200, response.json)
        basket = response.json
        self.assertTrue(basket["groceries"])
        response = self.client.post("/api/meal-plan", json={**payload,
            "groceries": [{"product_id": p["product_id"], "quantity": p["quantity"]} for p in basket["groceries"]],
            "targets": basket["nutrition_targets"]})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertTrue(set(response.json["products_used"]).issubset({p["product_id"] for p in basket["groceries"]}))

    def test_all_template_assets_are_in_public_build_and_still_serve_locally(self):
        references = set()
        for template in (ROOT / "templates").glob("*.html"):
            references.update(re.findall(r"filename='([^']+)'", template.read_text(encoding="utf-8")))
        self.assertLessEqual(references, set(ASSETS))  # Build may retain an unused compatibility asset.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for asset in ASSETS:
                target = root / "static" / asset
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((ROOT / "static" / asset).read_bytes())
            (root / "static" / "private.txt").write_text("must not publish")
            build_assets(root)
            for asset in ASSETS:
                self.assertEqual((root / "public" / "static" / asset).read_bytes(), (ROOT / "static" / asset).read_bytes())
                response = self.client.get("/static/" + asset)
                self.assertEqual(response.status_code, 200)
                response.close()
            self.assertFalse((root / "public" / "static" / "private.txt").exists())

    def test_supabase_failure_does_not_break_guest_home(self):
        with patch.dict(app.app.config, ACCOUNTS_ENABLED=True, SUPABASE_URL="https://project.supabase.co", SUPABASE_ANON_KEY="publishable-test-key"), patch.object(app, "_supabase_accounts", side_effect=RuntimeError("unavailable")):
            self.assertEqual(self.client.get("/").status_code, 200)
            self.assertFalse(self.client.get("/api/account/session").json["authenticated"])

    def test_production_style_import_and_runtime_catalog_without_secrets(self):
        # Construct an environment explicitly; do not import the developer's settings.
        env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP") if key in os.environ}
        env.update(VERCEL="1", PYTHON_DOTENV_DISABLED="1", FLASK_SKIP_DOTENV="1")
        code = """
import app
import account_store, password_recovery, supabase_accounts, classify_catalog, planning_catalog, planning_preferences
import plan_feasibility, meal_planner, package_units, nutrition_references
import optimize_grocery, price_comparison, basket_comparison, snap_store_locator
assert not app.app.config['ACCOUNTS_ENABLED']
assert app.app.config['SESSION_COOKIE_SECURE']
assert all(p['price_is_synthetic'] and p['product_id'].startswith('demo-') for p in optimize_grocery.load_catalog())
assert all(p['price_is_synthetic'] for p in price_comparison.load_normalized_prices())
assert app.app.test_client().get('/').status_code == 200
assert not password_recovery.delivery_available(app.app.config)
print('DEMO_STARTUP_OK')
"""
        result = subprocess.run([sys.executable, "-B", "-c", code], cwd=ROOT, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DEMO_STARTUP_OK", result.stdout)

    def test_accounts_require_supabase_in_every_runtime(self):
        env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP") if key in os.environ}
        env.update(PYTHON_DOTENV_DISABLED="1", FLASK_SKIP_DOTENV="1")
        result = subprocess.run(
            [sys.executable, "-B", "-c", "import app; assert not app.app.config['ACCOUNTS_ENABLED']; print('GUEST_MODE_OK')"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("GUEST_MODE_OK", result.stdout)


    def test_task78_workflow_progress_and_reference_copy_are_packaged(self):
        page = self.client.get("/").text
        grocery = (ROOT / "static" / "grocery.js").read_text(encoding="utf-8")
        meal = (ROOT / "static" / "meal_plan.js").read_text(encoding="utf-8")
        self.assertIn('id="workflow-progress"', page)
        self.assertIn('aria-label="NutriCart progress"', page)
        for label in ("Stores", "Groceries", "Budget", "Meals"):
            self.assertIn(f'<span class="workflow-progress-label">{label}</span>', page)
        self.assertIn("updateWorkflowProgress", grocery)
        self.assertIn('setAttribute("aria-current", "step")', grocery)
        self.assertIn("Daily reference:", meal)
        self.assertNotIn("Target:", meal)

    def test_icon_progress_keeps_noninteractive_accessible_state(self):
        page = self.client.get("/").text
        progress = page.split('id="workflow-progress"', 1)[1].split('</nav>', 1)[0]
        self.assertEqual(progress.count('class="workflow-progress-icon"'), 4)
        self.assertEqual(progress.count('class="workflow-progress-complete"'), 4)
        self.assertEqual(progress.count('aria-hidden="true"'), 4)
        self.assertNotIn('<button', progress)
        self.assertNotIn('<a ', progress)
        self.assertNotIn('workflow-progress-marker', progress)
        grocery = (ROOT / "static/grocery.js").read_text(encoding="utf-8")
        state = grocery.split('function updateWorkflowProgress()', 1)[1].split('function updateWorkflowState()', 1)[0]
        self.assertNotIn('.textContent = complete', state)
        self.assertIn('budget: shoppingComplete', state)
        self.assertIn('planner: hasCurrentBasket()', state)
        self.assertIn('snap: hasPlanningLocation() && hasPlanningStore()', state)
        self.assertIn('step.setAttribute("aria-label"', state)
