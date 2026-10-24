import json
import unittest
from pathlib import Path
from unittest.mock import patch

import app
from account_store import AccountStore, StoreError
from supabase_accounts import SupabaseAccounts, SupabaseError, configuration_valid


USER_ID = "11111111-1111-4111-8111-111111111111"
ITEM_ID = "22222222-2222-4222-8222-222222222222"


class Response:
    def __init__(self, status=200, data=None):
        self.status_code = status
        self._data = data
        self.ok = 200 <= status < 300
        self.content = b"" if data is None else json.dumps(data).encode()

    def json(self):
        return self._data


class HTTP:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.responses.pop(0)


class SupabaseAdapterTests(unittest.TestCase):
    def client(self, *responses):
        http = HTTP(*responses)
        return SupabaseAccounts(
            "https://project.supabase.co", "publishable-test-key",
            "https://demo.example", http=http,
        ), http

    def test_configuration_fails_closed(self):
        self.assertFalse(configuration_valid("", "key"))
        self.assertFalse(configuration_valid("https://project.supabase.co", ""))
        self.assertFalse(configuration_valid("http://project.supabase.co", "key"))
        self.assertTrue(configuration_valid("https://project.supabase.co", "key"))

    def test_signup_uses_auth_and_metadata_without_service_role(self):
        client, http = self.client(Response(data={"user": {
            "id": USER_ID, "email": "shopper@example.test",
            "user_metadata": {"first_name": "Ari", "last_name": "Lee"},
        }}))
        result = client.signup("shopper@example.test", "StrongPassword1", "Ari", "Lee")
        self.assertTrue(result["confirmation_required"])
        method, url, options = http.calls[0]
        self.assertEqual((method, url), ("POST", "https://project.supabase.co/auth/v1/signup"))
        self.assertEqual(options["headers"]["apikey"], "publishable-test-key")
        self.assertNotIn("Authorization", options["headers"])
        self.assertEqual(options["json"]["data"], {"first_name": "Ari", "last_name": "Lee"})
        self.assertNotIn("service", json.dumps(options).lower())

    def test_login_and_refresh_return_provider_sessions(self):
        session = {
            "access_token": "access", "refresh_token": "refresh", "expires_in": 3600,
            "user": {"id": USER_ID, "email": "shopper@example.test", "user_metadata": {"first_name": "Ari"}},
        }
        client, http = self.client(Response(data=session), Response(data=session))
        self.assertEqual(client.login("shopper@example.test", "strong-password")["tokens"]["access_token"], "access")
        self.assertEqual(client.refresh("refresh")["user"]["id"], USER_ID)
        self.assertEqual(http.calls[0][2]["params"], {"grant_type": "password"})
        self.assertEqual(http.calls[1][2]["params"], {"grant_type": "refresh_token"})

    def test_provider_logout_failure_is_not_misreported_as_success(self):
        client, _ = self.client(Response(503, {"message": "private provider detail"}))
        with self.assertRaisesRegex(SupabaseError, "Account services could not complete"):
            client.logout("user-access-token")

    def test_password_recovery_uses_supabase_redirect(self):
        client, http = self.client(Response(data={}))
        client.request_password_reset("shopper@example.test")
        _, url, options = http.calls[0]
        self.assertTrue(url.endswith("/auth/v1/recover"))
        self.assertEqual(options["params"]["redirect_to"], "https://demo.example/reset-password")
        self.assertEqual(options["json"], {"email": "shopper@example.test"})

    def test_confirmation_resend_uses_signup_type_and_public_redirect(self):
        client, http = self.client(Response(data={}))
        client.resend_signup_confirmation("shopper@example.test")
        method, url, options = http.calls[0]
        self.assertEqual((method, url), ("POST", "https://project.supabase.co/auth/v1/resend"))
        self.assertEqual(options["params"], {"redirect_to": "https://demo.example"})
        self.assertEqual(options["json"], {"type": "signup", "email": "shopper@example.test"})
        self.assertNotIn("Authorization", options["headers"])

    def test_password_policy_keeps_ten_character_minimum_and_requires_letters_and_digits(self):
        self.assertEqual(AccountStore.validate_password("NutriCart10"), "NutriCart10")
        for password in ("Short1", "letters-only", "1234567890"):
            with self.subTest(password=password), self.assertRaises(StoreError):
                AccountStore.validate_password(password)

    def test_account_modal_resets_scroll_and_uses_opaque_sticky_header(self):
        script = Path("static/account.js").read_text(encoding="utf-8")
        styles = Path("static/styles.css").read_text(encoding="utf-8")
        page = Path("templates/index.html").read_text(encoding="utf-8")
        self.assertGreaterEqual(script.count("dialog.scrollTop = 0;"), 2)
        self.assertIn(".account-drawer-content", styles)
        self.assertIn("top: 0; margin: 0;", styles)
        self.assertIn("background: #fffdf8; backdrop-filter: none;", styles)
        self.assertIn('class="account-drawer-content"', page)
        self.assertIn("width: 100%; min-width: 0; padding: clamp(18px, 3vw, 30px);", styles)

    def test_saved_library_is_responsive_and_has_accessible_tabs(self):
        script = Path("static/account.js").read_text(encoding="utf-8")
        styles = Path("static/styles.css").read_text(encoding="utf-8")
        page = Path("templates/index.html").read_text(encoding="utf-8")
        self.assertIn('class="account-nav" aria-label="Account sections" role="tablist"', page)
        account_tabs = page.split('<nav class="account-nav"', 1)[1].split("</nav>", 1)[0]
        self.assertEqual(account_tabs.count('role="tab"'), 3)
        self.assertIn('aria-selected="true" aria-controls="saved-library"', page)
        self.assertIn('id="sign-out" class="text-button account-settings-sign-out"', page)
        self.assertNotIn('</section>\n        <button id="sign-out"', page)
        self.assertIn("container-name: saved-card; container-type: inline-size;", styles)
        self.assertIn("@container saved-card (max-width: 384px)", styles)
        self.assertIn("@container saved-card (max-width: 240px)", styles)
        self.assertIn("white-space: nowrap", styles)
        self.assertIn("flex: 0 1 auto", styles)
        self.assertNotIn('.saved-empty::before { content: "â™¡"', styles)
        self.assertNotIn('id="account-menu-app-settings"', page)
        self.assertIn('<div class="app-settings-utility">', page)
        self.assertNotIn('document.querySelector(".app-settings-utility").hidden', script)
        self.assertIn('button.setAttribute("aria-selected", String(selected))', script)
        self.assertIn('document.querySelector(".account-nav").addEventListener("keydown"', script)

    def test_saved_library_replaces_stale_content_and_ignores_old_responses(self):
        script = Path("static/account.js").read_text(encoding="utf-8")
        load = script.split('async function loadLibrary(kind = "plans"', 1)[1].split("function selectAccountSection", 1)[0]
        self.assertLess(load.index('output.replaceChildren(libraryState('), load.index("await api("))
        self.assertIn("libraryAbortController?.abort()", load)
        self.assertIn("revision !== libraryRequestRevision || kind !== currentLibraryKind", load)
        self.assertIn('output.setAttribute("aria-busy", "true")', load)
        self.assertIn('output.removeAttribute("aria-busy")', script)
        self.assertIn("libraryCache.set(kind, {items, loadedAt: Date.now()})", load)
        self.assertIn("Date.now() - cached.loadedAt < 30000", load)
        self.assertIn("libraryCache.delete(currentLibraryKind)", script)
        self.assertIn("libraryCache.clear()", script)
        self.assertIn('document.querySelector("#saved-library-title").textContent = "Your Saved Plans"', script)

    def test_pending_confirmation_message_survives_switch_to_sign_in(self):
        script = Path("static/account.js").read_text(encoding="utf-8")
        branch = script.index("if (data.confirmation_required)")
        guard = script.index("if (revision === authRevision)", branch)
        switch = script.index('setAuthMode("signin");', guard)
        message = script.index('setStatus("Check your email to confirm your account before signing in.");', switch)
        assistance = script.index("showConfirmationAssistance(payload.email);", switch)
        self.assertLess(guard, switch)
        self.assertGreater(assistance, switch)
        self.assertGreater(message, assistance)

    def test_signin_status_is_transient_and_confirmation_help_is_contextual(self):
        page = Path("templates/index.html").read_text(encoding="utf-8")
        script = Path("static/account.js").read_text(encoding="utf-8")
        self.assertIn('id="resend-confirmation-mode" class="text-button" type="button" hidden', page)
        self.assertIn('setStatus("Signed in. Your saved content is available on this device.", false, {transientAuth: true})', script)
        self.assertIn("function clearTransientAuthStatus()", script)
        self.assertIn("clearTransientAuthStatus();", script.split("function selectAccountSection", 1)[1])
        self.assertIn('document.addEventListener("nutricart:navigate", clearTransientAuthStatus)', script)
        self.assertIn('error.message === "Confirm your email before signing in."', script)
        self.assertIn("showConfirmationAssistance(payload.email)", script)

    def test_confirmation_fragments_are_cleared_and_mapped_without_provider_text(self):
        script = Path("static/account.js").read_text(encoding="utf-8")
        self.assertIn("function consumeAuthRedirectFragment()", script)
        self.assertIn('history.replaceState(null, "", window.location.pathname + window.location.search);', script)
        self.assertIn('code === "otp_expired"', script)
        self.assertIn("This confirmation link is invalid or expired. Please request a new confirmation email.", script)
        self.assertNotIn('values.get("error_description")', script)
        self.assertIn("Email confirmed. Sign in to continue.", script)

    def test_new_password_controls_expose_the_same_policy_as_the_server(self):
        page = Path("templates/index.html").read_text(encoding="utf-8")
        reset = Path("templates/reset_password.html").read_text(encoding="utf-8")
        hint = "Use at least 10 characters, including a letter and a number."
        self.assertEqual(page.count(hint), 4)
        self.assertEqual(reset.count(hint), 2)
        self.assertEqual(page.count('pattern="(?=.*[A-Za-z])(?=.*[0-9]).{10,}"'), 2)
        self.assertEqual(reset.count('pattern="(?=.*[A-Za-z])(?=.*[0-9]).{10,}"'), 1)

    def test_saved_item_uses_verified_owner_and_user_token(self):
        row = {
            "id": ITEM_ID, "kind": "grocery_plan", "name": "Week",
            "plan_data": {"summary": {"budget": 100}}, "created_at": "now", "updated_at": "now",
        }
        client, http = self.client(Response(data=[row]))
        item = client.save_item("user-access-token", USER_ID, "grocery_plan", "Week", {"summary": {"budget": 100}})
        self.assertEqual(item["id"], ITEM_ID)
        options = http.calls[0][2]
        self.assertEqual(options["headers"]["Authorization"], "Bearer user-access-token")
        self.assertEqual(options["json"]["user_id"], USER_ID)
        self.assertNotIn("user_id", item)

    def test_sensitive_saved_fields_are_rejected_before_provider_request(self):
        client, http = self.client()
        with self.assertRaisesRegex(ValueError, "Location, authentication"):
            client.save_item("user-access-token", USER_ID, "grocery_plan", "Private", {
                "context": {"location": {"locality": "Example", "latitude": 35.1},
                            "selected_store": {"name": "Example Store", "address": "Private"}},
            })
        self.assertEqual(http.calls, [])

    def test_browser_sanitizes_saved_payload_before_submission(self):
        script = Path("static/account.js").read_text(encoding="utf-8")
        self.assertIn("function sanitizedSaveData(value)", script)
        self.assertIn("data: sanitizedSaveData(pendingSave.data)", script)
        for key in ("latitude", "longitude", "address", "access_token", "password"):
            self.assertIn(f'"{key}"', script)

    def test_rls_defines_all_owner_operations(self):
        sql = Path("supabase/schema.sql").read_text(encoding="utf-8")
        self.assertIn("enable row level security", sql)
        self.assertIn("revoke all on table public.nutricart_saved_items from public", sql)
        self.assertIn("revoke all on table public.nutricart_saved_items from anon", sql)
        self.assertIn("revoke all on table public.nutricart_saved_items from authenticated", sql)
        self.assertIn("grant usage on schema public to authenticated", sql)
        self.assertIn("grant select, insert, update, delete on table public.nutricart_saved_items to authenticated", sql)
        for action in ("select", "insert", "update", "delete"):
            self.assertIn(f"for {action}", sql)
        self.assertGreaterEqual(sql.count("(select auth.uid()) = user_id"), 5)
        update_policy = sql.split('create policy "NutriCart users update own saved items"', 1)[1].split("drop policy", 1)[0]
        self.assertIn("using ((select auth.uid()) = user_id)", update_policy)
        self.assertIn("with check ((select auth.uid()) = user_id)", update_policy)
        self.assertNotRegex(sql, r"(?i)grant\s+.*\s+to\s+anon")
        self.assertNotIn("security definer", sql.lower())
        self.assertNotIn("service_role", sql)

    def test_saved_item_rest_requests_use_only_the_user_bearer_token(self):
        row = {"id": ITEM_ID, "kind": "grocery_plan", "name": "Week", "plan_data": {},
               "created_at": "now", "updated_at": "now"}
        client, http = self.client(Response(data=[]), Response(data=[]), Response(data=[row]), Response(data=[{"id": ITEM_ID}]))
        self.assertEqual(client.list_items("user-a-token"), [])
        self.assertIsNone(client.get_item("user-a-token", ITEM_ID))
        self.assertEqual(client.rename_item("user-a-token", ITEM_ID, "Renamed")["name"], "Week")
        self.assertTrue(client.delete_item("user-a-token", ITEM_ID))
        for _method, url, options in http.calls:
            self.assertIn("/rest/v1/nutricart_saved_items", url)
            self.assertEqual(options["headers"]["Authorization"], "Bearer user-a-token")
            self.assertNotIn("service", json.dumps(options).lower())

    def test_provider_errors_do_not_expose_provider_body(self):
        client, _ = self.client(Response(400, {"message": "private provider detail"}))
        with self.assertRaisesRegex(SupabaseError, "Account services could not complete"):
            client.login("shopper@example.test", "strong-password")

    def test_known_auth_error_codes_get_safe_specific_messages(self):
        for code, expected in (
            ("email_not_confirmed", "Confirm your email before signing in."),
            ("invalid_credentials", "Email or password is incorrect."),
        ):
            with self.subTest(code=code):
                client, _ = self.client(Response(400, {"code": code, "message": "private provider detail"}))
                with self.assertRaisesRegex(SupabaseError, expected.replace(".", r"\.")) as caught:
                    client.login("shopper@example.test", "strong-password")
                self.assertEqual(caught.exception.status, 401)

    def test_duplicate_email_error_code_is_retained_without_provider_message(self):
        client, _ = self.client(Response(400, {
            "code": "user_already_exists",
            "message": "private provider duplicate detail",
        }))
        with self.assertRaisesRegex(SupabaseError, "Account services could not complete") as caught:
            client.signup("shopper@example.test", "StrongPassword1", "Ari")
        self.assertEqual(caught.exception.provider_code, "user_already_exists")
        self.assertNotIn("private", str(caught.exception))


class FakeSupabase:
    def __init__(self):
        self.items = []
        self.recovery_emails = []
        self.confirmation_emails = []
        self.updated_password = False

    @staticmethod
    def user():
        return {"id": USER_ID, "email": "shopper@example.test", "first_name": "Ari", "last_name": "", "created_at": "now"}

    def signup(self, *args):
        return {"user": self.user(), "tokens": None, "confirmation_required": True}

    def login(self, email=None, password=None):
        if password == "wrong-password":
            raise SupabaseError("Email or password is incorrect.", 401)
        return {"user": self.user(), "tokens": {"access_token": "access", "refresh_token": "refresh", "expires_in": 3600}}

    def get_user(self, token):
        if token != "access":
            raise SupabaseError("expired", 401)
        return self.user()

    def refresh(self, token):
        return self.login()

    def logout(self, token):
        return None

    def request_password_reset(self, email):
        self.recovery_emails.append(email)

    def resend_signup_confirmation(self, email):
        self.confirmation_emails.append(email)

    def update_password(self, token, password):
        self.updated_password = True
        return self.user()

    def save_item(self, token, user_id, kind, name, data):
        item = {"id": ITEM_ID, "kind": kind, "name": name, "data": data, "created_at": "now", "updated_at": "now"}
        self.items.append(item)
        return item

    def list_items(self, token, kind=None):
        return [{k: v for k, v in item.items() if k != "data"} | {"summary": item["data"].get("summary", {})}
                for item in self.items if not kind or item["kind"] == kind]


class SupabaseRouteTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeSupabase()
        self.config = patch.dict(app.app.config, {
            "TESTING": True,
            "ACCOUNTS_ENABLED": True,
            "SUPABASE_URL": "https://project.supabase.co",
            "SUPABASE_ANON_KEY": "publishable-test-key",
            "PASSWORD_RESET_ORIGIN": "https://demo.example",
            "SESSION_COOKIE_SECURE": False,
        })
        self.config.start()
        self.provider = patch.object(app, "_supabase_accounts", return_value=self.fake)
        self.provider.start()
        self.client = app.app.test_client()
        self.csrf = self.client.get("/api/account/session").json["csrf_token"]

    def tearDown(self):
        self.provider.stop()
        self.config.stop()
        app._LOGIN_ATTEMPTS.clear()

    def post(self, path, payload):
        return self.client.post(path, json=payload, headers={"X-CSRF-Token": self.csrf})

    def sign_in(self):
        response = self.post("/api/account/login", {"email": "shopper@example.test", "password": "strong-password"})
        self.assertEqual(response.status_code, 200)
        return response

    def test_signup_requires_confirmation_without_creating_local_session(self):
        response = self.post("/api/account/register", {
            "email": "shopper@example.test", "password": "strong-password",
            "confirm_password": "strong-password", "first_name": "Ari", "last_name": "",
        })
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.json["confirmation_required"])
        self.assertIsNone(response.json["user"])

    def test_incorrect_password_is_rejected_without_session(self):
        response = self.post("/api/account/login", {"email": "shopper@example.test", "password": "wrong-password"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json["error"], "Email or password is incorrect.")
        self.assertNotIn("nutricart_access=access", "\n".join(response.headers.getlist("Set-Cookie")))

    def test_login_sets_httponly_supabase_cookies_and_logout_clears_them(self):
        response = self.sign_in()
        cookies = "\n".join(response.headers.getlist("Set-Cookie"))
        self.assertIn("nutricart_access=access", cookies)
        self.assertIn("HttpOnly", cookies)
        logout = self.client.post("/api/account/logout", headers={"X-CSRF-Token": self.csrf})
        self.assertEqual(logout.status_code, 200)
        self.assertIn("nutricart_access=;", "\n".join(logout.headers.getlist("Set-Cookie")))

    def test_logout_failure_is_safe_and_does_not_clear_the_session_cookie(self):
        self.sign_in()
        self.fake.logout = lambda _token: (_ for _ in ()).throw(
            SupabaseError("private provider logout detail", 503)
        )
        response = self.client.post("/api/account/logout", headers={"X-CSRF-Token": self.csrf})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json["error"], "Sign out failed. Please try again.")
        self.assertNotIn("nutricart_access=;", "\n".join(response.headers.getlist("Set-Cookie")))
        self.assertTrue(self.client.get("/api/account/session").json["authenticated"])

    def test_legacy_session_keys_cannot_authenticate_supabase_mode(self):
        with self.client.session_transaction() as browser_session:
            browser_session["user_id"] = 99
            browser_session["auth_version"] = 1
        response = self.client.get("/api/account/session")
        self.assertFalse(response.json["authenticated"])
        with self.client.session_transaction() as browser_session:
            self.assertNotIn("user_id", browser_session)
            self.assertNotIn("auth_version", browser_session)

    def test_refresh_cookie_restores_verified_provider_session(self):
        self.client.set_cookie("nutricart_refresh", "refresh")
        response = self.client.get("/api/account/session")
        self.assertTrue(response.json["authenticated"])
        self.assertEqual(response.json["user"]["id"], USER_ID)
        cookies = "\n".join(response.headers.getlist("Set-Cookie"))
        self.assertIn("nutricart_access=access", cookies)
        self.assertIn("HttpOnly", cookies)

    def test_forgot_password_is_generic(self):
        response = self.post("/api/account/forgot-password", {"email": "shopper@example.test"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["message"], "If an account exists for that email, password reset instructions have been sent.")

    def test_confirmation_resend_is_generic_and_does_not_create_an_account(self):
        response = self.post("/api/account/resend-confirmation", {"email": "shopper@example.test"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["message"], "If an unconfirmed account exists for that email, a new confirmation email has been sent.")
        self.assertEqual(self.fake.confirmation_emails, ["shopper@example.test"])

    def test_existing_confirmed_email_error_has_same_pending_signup_response(self):
        self.fake.signup = lambda *args: (_ for _ in ()).throw(
            SupabaseError("Account services could not complete that request.", 400, "user_already_exists")
        )
        response = self.post("/api/account/register", {
            "email": "shopper@example.test", "password": "strong-password",
            "confirm_password": "strong-password", "first_name": "Ari", "last_name": "",
        })
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json, {"confirmation_required": True, "user": None})

    def test_confirmation_resend_failure_keeps_privacy_safe_response(self):
        self.fake.resend_signup_confirmation = lambda email: (_ for _ in ()).throw(
            SupabaseError("Too many account requests. Wait a moment and try again.", 429)
        )
        response = self.post("/api/account/resend-confirmation", {"email": "shopper@example.test"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["message"], "If an unconfirmed account exists for that email, a new confirmation email has been sent.")

    def test_reset_callback_updates_supabase_password(self):
        response = self.post("/api/account/reset-password", {
            "access_token": "recovery-access-token",
            "new_password": "new-strong-password",
            "confirm_password": "new-strong-password",
        })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(self.fake.updated_password)

    def test_reset_without_recovery_token_is_rejected_safely(self):
        response = self.post("/api/account/reset-password", {
            "new_password": "new-strong-password",
            "confirm_password": "new-strong-password",
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json["error"], "This reset link is invalid or expired. Request a new link.")
        self.assertFalse(self.fake.updated_password)

    def test_cross_device_equivalent_save_and_restore(self):
        self.sign_in()
        saved = self.post("/api/saved-items", {
            "kind": "grocery_plan", "name": "Laptop plan",
            "data": {"summary": {"budget": 100}},
        })
        self.assertEqual(saved.status_code, 201)

        phone = app.app.test_client()
        phone.get("/api/account/session")
        phone.set_cookie("nutricart_access", "access")
        restored = phone.get("/api/saved-items")
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(restored.json["items"][0]["name"], "Laptop plan")

    def test_guest_planning_remains_independent_of_accounts(self):
        with patch.dict(app.app.config, ACCOUNTS_ENABLED=False, SUPABASE_URL="", SUPABASE_ANON_KEY=""):
            guest = app.app.test_client()
            self.assertFalse(guest.get("/api/account/session").json["authenticated"])
            self.assertNotEqual(guest.get("/").status_code, 503)


if __name__ == "__main__":
    unittest.main()
