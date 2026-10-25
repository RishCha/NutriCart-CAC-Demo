"""Supabase Auth and RLS-backed saved-content adapter for NutriCart."""

from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import quote, urlsplit
from uuid import UUID

import requests

from account_store import AccountStore, StoreError


KINDS = {"grocery_plan", "meal_plan", "shopping_list"}


class SupabaseError(StoreError):
    """Safe provider error. Provider response bodies are never exposed directly."""

    def __init__(self, message, status=502, provider_code=""):
        super().__init__(message)
        self.status = status
        self.provider_code = str(provider_code or "").strip().casefold()


def configuration_valid(url, anon_key):
    value = str(url or "").strip().rstrip("/")
    parsed = urlsplit(value)
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    return bool(
        value
        and str(anon_key or "").strip()
        and not parsed.username
        and not parsed.password
        and not parsed.query
        and not parsed.fragment
        and (parsed.scheme == "https" or (local and parsed.scheme == "http"))
    )


class SupabaseAccounts:
    def __init__(self, url, anon_key, public_url="", timeout=8, http=None):
        if not configuration_valid(url, anon_key):
            raise SupabaseError("Account services are not configured.", 503)
        self.url = str(url).strip().rstrip("/")
        self.anon_key = str(anon_key).strip()
        self.public_url = str(public_url or "").strip().rstrip("/")
        self.timeout = max(1, min(float(timeout), 15))
        self.http = http or requests

    def _request(self, method, path, *, token=None, payload=None, params=None, prefer=None):
        headers = {"apikey": self.anon_key, "Accept": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if prefer:
            headers["Prefer"] = prefer
        try:
            response = self.http.request(
                method,
                self.url + path,
                headers=headers,
                json=payload,
                params=params,
                timeout=self.timeout,
            )
        except requests.RequestException as error:
            raise SupabaseError("Account services are temporarily unavailable.", 503) from error
        try:
            data = response.json() if response.content else None
        except ValueError:
            data = None
        if response.ok:
            return data, response
        if response.status_code == 429:
            raise SupabaseError("Too many account requests. Wait a moment and try again.", 429)
        code = str(data.get("error_code") or data.get("code") or "").strip().casefold() if isinstance(data, dict) else ""
        if code == "email_not_confirmed":
            raise SupabaseError("Please verify your email before signing in.", 401, code)
        if code == "invalid_credentials":
            raise SupabaseError("Incorrect email or password. Please try again.", 401, code)
        if code in {"user_already_exists", "email_exists"}:
            raise SupabaseError("Account services could not complete that request.", 400, code)
        if response.status_code in {401, 403}:
            raise SupabaseError("Incorrect email or password. Please try again.", 401, code)
        raise SupabaseError("Account services could not complete that request.", 400 if response.status_code < 500 else 503, code)

    @staticmethod
    def public_user(value):
        user = value.get("user", value) if isinstance(value, dict) else {}
        metadata = user.get("user_metadata") if isinstance(user.get("user_metadata"), dict) else {}
        return {
            "id": user.get("id"),
            "email": user.get("email", ""),
            "first_name": str(metadata.get("first_name") or "").strip(),
            "last_name": str(metadata.get("last_name") or "").strip(),
            "created_at": user.get("created_at"),
        }

    @staticmethod
    def session_tokens(value):
        if not isinstance(value, dict):
            return None
        if not value.get("access_token") or not value.get("refresh_token"):
            return None
        return {
            "access_token": value["access_token"],
            "refresh_token": value["refresh_token"],
            "expires_in": int(value.get("expires_in") or 3600),
        }

    def signup(self, email, password, first_name, last_name=""):
        email = AccountStore.normalize_email(email)
        password = AccountStore.validate_password(password)
        first_name, last_name = AccountStore.validate_profile_names(first_name, last_name)
        params = {"redirect_to": self.public_url} if self.public_url else None
        data, _ = self._request(
            "POST",
            "/auth/v1/signup",
            payload={
                "email": email,
                "password": password,
                "data": {"first_name": first_name, "last_name": last_name},
            },
            params=params,
        )
        return {
            "user": self.public_user(data or {}),
            "tokens": self.session_tokens(data),
            "confirmation_required": not bool(self.session_tokens(data)),
        }

    def login(self, email, password):
        email = AccountStore.normalize_email(email)
        if not isinstance(password, str):
            raise SupabaseError("Incorrect email or password. Please try again.", 401)
        data, _ = self._request(
            "POST",
            "/auth/v1/token",
            params={"grant_type": "password"},
            payload={"email": email, "password": password},
        )
        return {"user": self.public_user(data or {}), "tokens": self.session_tokens(data)}

    def refresh(self, refresh_token):
        if not refresh_token:
            raise SupabaseError("Sign in to access saved NutriCart content.", 401)
        data, _ = self._request(
            "POST",
            "/auth/v1/token",
            params={"grant_type": "refresh_token"},
            payload={"refresh_token": refresh_token},
        )
        tokens = self.session_tokens(data)
        if not tokens:
            raise SupabaseError("Sign in to access saved NutriCart content.", 401)
        return {"user": self.public_user(data or {}), "tokens": tokens}

    def get_user(self, access_token):
        data, _ = self._request("GET", "/auth/v1/user", token=access_token)
        return self.public_user(data or {})

    def logout(self, access_token):
        if access_token:
            self._request("POST", "/auth/v1/logout", token=access_token, payload={})

    def request_password_reset(self, email):
        email = AccountStore.normalize_email(email)
        params = {"redirect_to": self.public_url + "/reset-password"} if self.public_url else None
        self._request("POST", "/auth/v1/recover", payload={"email": email}, params=params)

    def resend_signup_confirmation(self, email):
        email = AccountStore.normalize_email(email)
        params = {"redirect_to": self.public_url} if self.public_url else None
        self._request(
            "POST",
            "/auth/v1/resend",
            payload={"type": "signup", "email": email},
            params=params,
        )

    def update_password(self, access_token, new_password):
        password = AccountStore.validate_password(new_password, "New password")
        data, _ = self._request("PUT", "/auth/v1/user", token=access_token, payload={"password": password})
        return self.public_user(data or {})

    def update_profile(self, access_token, first_name, last_name=""):
        first_name, last_name = AccountStore.validate_profile_names(first_name, last_name)
        data, _ = self._request(
            "PUT",
            "/auth/v1/user",
            token=access_token,
            payload={"data": {"first_name": first_name, "last_name": last_name}},
        )
        return self.public_user(data or {})

    def change_password(self, email, current_password, new_password):
        session = self.login(email, current_password)
        token = (session.get("tokens") or {}).get("access_token")
        user = self.update_password(token, new_password)
        return {"user": user, "tokens": session.get("tokens")}

    @staticmethod
    def item_id(value):
        try:
            return str(UUID(str(value)))
        except (ValueError, TypeError, AttributeError) as error:
            raise StoreError("Saved item ID is invalid.") from error

    @staticmethod
    def _item(row, include_data=True):
        item = {key: row.get(key) for key in ("id", "kind", "name", "created_at", "updated_at")}
        data = row.get("plan_data") if isinstance(row.get("plan_data"), dict) else {}
        if include_data:
            item["data"] = data
        else:
            item["summary"] = data.get("summary", {}) if isinstance(data, dict) else {}
        return item

    def list_items(self, access_token, kind=None):
        params = {
            "select": "id,kind,name,plan_data,created_at,updated_at",
            "order": "updated_at.desc",
        }
        if kind:
            if kind not in KINDS:
                raise StoreError("Saved item type is unsupported.")
            params["kind"] = "eq." + kind
        rows, _ = self._request("GET", "/rest/v1/nutricart_saved_items", token=access_token, params=params)
        return [self._item(row, include_data=False) for row in (rows or [])]

    def save_item(self, access_token, user_id, kind, name, data):
        if kind not in KINDS:
            raise StoreError("Saved item type is unsupported.")
        name = AccountStore.validate_name(name)
        data = AccountStore.validate_data(data)
        now = datetime.now(timezone.utc).isoformat()
        rows, _ = self._request(
            "POST",
            "/rest/v1/nutricart_saved_items",
            token=access_token,
            payload={
                "user_id": user_id,
                "kind": kind,
                "name": name,
                "plan_data": data,
                "created_at": now,
                "updated_at": now,
            },
            params={"select": "id,kind,name,plan_data,created_at,updated_at"},
            prefer="return=representation",
        )
        if not rows:
            raise SupabaseError("NutriCart could not save that item.", 503)
        return self._item(rows[0])

    def get_item(self, access_token, item_id):
        rows, _ = self._request(
            "GET",
            "/rest/v1/nutricart_saved_items",
            token=access_token,
            params={
                "id": "eq." + self.item_id(item_id),
                "select": "id,kind,name,plan_data,created_at,updated_at",
                "limit": "1",
            },
        )
        return self._item(rows[0]) if rows else None

    def rename_item(self, access_token, item_id, name):
        now = datetime.now(timezone.utc).isoformat()
        rows, _ = self._request(
            "PATCH",
            "/rest/v1/nutricart_saved_items",
            token=access_token,
            payload={"name": AccountStore.validate_name(name), "updated_at": now},
            params={
                "id": "eq." + self.item_id(item_id),
                "select": "id,kind,name,plan_data,created_at,updated_at",
            },
            prefer="return=representation",
        )
        return self._item(rows[0]) if rows else None

    def delete_item(self, access_token, item_id):
        rows, _ = self._request(
            "DELETE",
            "/rest/v1/nutricart_saved_items",
            token=access_token,
            params={
                "id": "eq." + self.item_id(item_id),
                "select": "id",
            },
            prefer="return=representation",
        )
        return bool(rows)
