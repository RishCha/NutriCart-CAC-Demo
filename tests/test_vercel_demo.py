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


ROOT = Path(__file__).resolve().parents[1]


class VercelDemoTests(unittest.TestCase):
    def setUp(self):
        self.config = patch.dict(app.app.config, TESTING=True, ACCOUNTS_ENABLED=False,
                                 SECRET_KEY="isolated-demo-test", SESSION_COOKIE_SECURE=False)
        self.config.start()
        self.addCleanup(self.config.stop)
        self.store = patch.object(app, "_accounts", side_effect=AssertionError("Demo touched SQLite"))
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

    def test_planner_uses_friendly_people_and_days_validation(self):
        script = (ROOT / "static" / "grocery.js").read_text(encoding="utf-8")
        page = self.client.get("/").text
        self.assertIn("NutriCart supports plans for 1–20 people and 1–31 days.", script)
        self.assertIn("NutriCart supports plans for 1–20 people.", script)
        self.assertIn("NutriCart supports plans for 1–31 days.", script)
        self.assertNotIn("People must be a whole number from 1 to 20.", script)
        self.assertNotIn("Days must be a whole number from 1 to 31.", script)
        self.assertIn('filename=\'grocery.js\', v=\'basket-store-38\'', (ROOT / "templates" / "index.html").read_text(encoding="utf-8"))
        self.assertIn("grocery.js?v=basket-store-38", page)

    def test_basket_summary_uses_selected_store_name_without_location_fallback(self):
        script = (ROOT / "static" / "grocery.js").read_text(encoding="utf-8")
        self.assertIn("function selectedStoreName(context)", script)
        self.assertIn("context?.selected_store?.name", script)
        render = script.split("function renderResult", 1)[1].split("function formatPlanForCopy", 1)[0]
        self.assertIn("storeLabel", render)
        self.assertIn("[storeLabel,", render)
        self.assertIn(".filter(Boolean).join", render)
        self.assertNotIn("locationLabel", render)
        self.assertNotIn("context.location?.locality", render)

    def test_unlocked_meal_plan_empty_state_is_compact_and_connected(self):
        page = self.client.get("/").text
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("Turn your grocery basket into simple meal ideas.", page)
        self.assertIn("Use the groceries already in your basket to build your meal plan.", page)
        self.assertRegex(page, r'id="meal-plan-ready"[^>]* hidden')
        self.assertIn("#meal-plan-view:has(#meal-plan-ready:not([hidden])) .meal-plan-heading", styles)
        self.assertIn("width: min(100%, 800px)", styles)
        self.assertIn("#meal-plan-ready .primary", styles)
        self.assertNotIn("min-height: 330px", styles.split("/* Compact unlocked Meal Plan action state. */", 1)[1])
        self.assertIn("styles.css?v=feedback-46", page)

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
        for identifier in ("feedback-skip", "feedback-done", "feedback-support"):
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
        self.assertIn(".feedback-actions", styles)
        self.assertIn("feedback.js?v=feedback-46", page)

    def test_page_background_gradients_do_not_repeat(self):
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        active_theme = styles.split("/* Consumer redesign:", 1)[1]
        body_rule = active_theme.split("body {", 1)[1].split("}", 1)[0]
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
        self.assertIn("invalidateCurrentPlanForLocation()", grocery)
        self.assertIn('dispatchEvent(new CustomEvent("nutricart:store-changed"', store_finder)
        self.assertIn('lockedAction.dataset.workflowTarget || "planner"', meal)

    def test_account_enabled_mode_preserves_authentication_forms(self):
        with patch.dict(app.app.config, ACCOUNTS_ENABLED=True):
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

    def test_local_storage_failure_does_not_break_guest_home(self):
        with patch.dict(app.app.config, ACCOUNTS_ENABLED=True), patch.object(app, "_accounts", side_effect=sqlite3.OperationalError("unavailable")):
            with self.client.session_transaction() as session:
                session["user_id"] = 1
            self.assertEqual(self.client.get("/").status_code, 200)
            self.assertFalse(self.client.get("/api/account/session").json["authenticated"])

    def test_production_style_import_and_runtime_catalog_without_secrets(self):
        # Construct an environment explicitly; do not import the developer's settings.
        env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP") if key in os.environ}
        env.update(VERCEL="1", PYTHON_DOTENV_DISABLED="1", FLASK_SKIP_DOTENV="1")
        code = """
import app
import account_store, password_recovery, classify_catalog, planning_catalog, planning_preferences
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

    def test_non_vercel_runtime_keeps_accounts_enabled(self):
        env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP") if key in os.environ}
        env.update(PYTHON_DOTENV_DISABLED="1", FLASK_SKIP_DOTENV="1")
        result = subprocess.run(
            [sys.executable, "-B", "-c", "import app; assert app.app.config['ACCOUNTS_ENABLED']; print('LOCAL_ACCOUNTS_OK')"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("LOCAL_ACCOUNTS_OK", result.stdout)
