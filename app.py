"""Local web interface for NutriCart services."""

from datetime import datetime, timezone
import math
import os
import secrets
import time
from functools import wraps
from urllib.parse import urlsplit

import requests
from flask import Flask, g, jsonify, render_template, request, session
from flask.sessions import SecureCookieSessionInterface

from basket_comparison import compare_kroger_basket_prices
from account_store import StoreError
from supabase_accounts import SupabaseAccounts, SupabaseError, configuration_valid
from feedback_delivery import FeedbackDeliveryError, delivery_available as feedback_available, send_feedback
from meal_planner import build_meal_plan
from nutrition_references import estimate_household
from plan_feasibility import feasibility_guidance, minimum_feasible_cost, plan_acceptance
from planning_catalog import GENERAL_CATALOG, location_from_address, planning_candidates, planning_location
from catalog_config import demo_catalog_enabled
from optimize_grocery import (
    FOOD_GROUP_EXCLUSIONS,
    NUTRITION_FOCUS_NUTRIENTS,
    default_fiber_target,
    filter_catalog,
    load_catalog,
    package_upper_bound,
    parse_avoid_list,
    score_plan,
    score_plan_breakdown,
    solve_plan,
    summarize_plan,
)
from retailer_policy import retailer_policy, planning_allowed, planning_suitability, LIMITED_MESSAGE, UNKNOWN_MESSAGE
from snap_store_locator import find_snap_retailers, geocode_address





class _NutriCartSessionInterface(SecureCookieSessionInterface):
    """Keep secure cookies in production while allowing loopback HTTP development."""

    def get_cookie_secure(self, application):
        secure = super().get_cookie_secure(application)
        hostname = (urlsplit(request.host_url).hostname or "").casefold()
        if secure and not request.is_secure and hostname in {"localhost", "127.0.0.1", "::1"}:
            return False
        return secure


_SUPABASE_URL = os.getenv("SUPABASE_URL", "")
_SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")

app = Flask(__name__)
app.config.update(
    # Supabase enables durable accounts on Vercel. Missing configuration fails closed there.
    SUPABASE_URL=_SUPABASE_URL,
    SUPABASE_ANON_KEY=_SUPABASE_ANON_KEY,
    SUPABASE_TIMEOUT_SECONDS=os.getenv("SUPABASE_TIMEOUT_SECONDS", "8"),
    ACCOUNTS_ENABLED=configuration_valid(_SUPABASE_URL, _SUPABASE_ANON_KEY),
    SECRET_KEY=os.getenv("FLASK_SECRET_KEY") or secrets.token_hex(32),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("FLASK_COOKIE_SECURE", "true" if os.getenv("VERCEL") == "1" else "").lower() in {"1", "true", "yes"},
    PASSWORD_RESET_ORIGIN=os.getenv("NUTRICART_PUBLIC_URL", ""),
    # Fail closed unless an operator explicitly enables feedback in the deployment.
    FEEDBACK_ENABLED=os.getenv("NUTRICART_FEEDBACK_ENABLED", "").lower() in {"1", "true", "yes"},
    FEEDBACK_TO=os.getenv("NUTRICART_FEEDBACK_TO", ""),
    FEEDBACK_FROM=os.getenv("NUTRICART_FEEDBACK_FROM", ""),
    RESEND_API_KEY=os.getenv("RESEND_API_KEY", ""),
)
app.session_interface = _NutriCartSessionInterface()


@app.context_processor
def inject_template_globals():
    return {
        "current_year": datetime.now(timezone.utc).year,
        "accounts_enabled": app.config["ACCOUNTS_ENABLED"],
        "account_backend": "supabase" if _using_supabase() else "local",
        "vercel_analytics_enabled": os.getenv("VERCEL") == "1"
        and (urlsplit(request.host_url).hostname or "").lower() not in {"localhost", "127.0.0.1", "::1"},
    }

DIETS = {"omnivore", "vegetarian", "vegan", "pescatarian"}
PREFERENCES = {"balanced", "budget", "nutrition", "variety"}
FIBER_MODES = {"recommended", "custom"}
PUBLIC_GROCERY_FIELDS = {
    "quantity", "product_name", "product_id", "category", "unit_price",
    "item_total", "nutrition_is_estimated", "store_name", "package_size",
    "package_weight_g",
}
KROGER_TOKEN_URL = "https://api.kroger.com/v1/connect/oauth2/token"
_LOGIN_ATTEMPTS = {}


def _using_supabase():
    return configuration_valid(app.config.get("SUPABASE_URL"), app.config.get("SUPABASE_ANON_KEY"))


def _supabase_accounts():
    return SupabaseAccounts(
        app.config.get("SUPABASE_URL"),
        app.config.get("SUPABASE_ANON_KEY"),
        app.config.get("PASSWORD_RESET_ORIGIN"),
        app.config.get("SUPABASE_TIMEOUT_SECONDS", 8),
    )


def _queue_supabase_tokens(tokens=None, clear=False):
    g.supabase_tokens = tokens
    g.clear_supabase_tokens = clear


def _current_account_user():
    if hasattr(g, "account_user"):
        return g.account_user
    user = None
    if app.config["ACCOUNTS_ENABLED"] and _using_supabase():
        access_token = request.cookies.get("nutricart_access", "")
        refresh_token = request.cookies.get("nutricart_refresh", "")
        invalid_session = False
        if access_token:
            try:
                user = _supabase_accounts().get_user(access_token)
            except SupabaseError as error:
                invalid_session = error.status in {401, 403}
            except Exception:
                user = None
        if not user and refresh_token:
            try:
                refreshed = _supabase_accounts().refresh(refresh_token)
                user = refreshed["user"]
                access_token = refreshed["tokens"]["access_token"]
                _queue_supabase_tokens(refreshed["tokens"])
            except SupabaseError as error:
                invalid_session = invalid_session or error.status in {401, 403}
            except Exception:
                user = None
        if user:
            g.account_access_token = access_token
        elif invalid_session:
            _queue_supabase_tokens(clear=True)
    session.pop("user_id", None)
    session.pop("auth_version", None)
    g.account_user = user
    return user


@app.before_request
def guard_demo_accounts():
    if app.config["ACCOUNTS_ENABLED"]:
        return None
    account_route = request.path == "/api/account" or request.path.startswith("/api/account/")
    saved_route = request.path == "/api/saved-items" or request.path.startswith("/api/saved-items/")
    if (account_route or saved_route) and request.path not in {"/api/account/session", "/api/account/logout"}:
        return jsonify({"error": "Accounts and saved content are unavailable in this public demo. You can use all grocery planning tools without signing in."}), 503
    return None


def _csrf_token():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)
    return session["csrf_token"]


def _csrf_required(function):
    @wraps(function)
    def guarded(*args, **kwargs):
        supplied = request.headers.get("X-CSRF-Token", "")
        if not supplied or not secrets.compare_digest(supplied, session.get("csrf_token", "")):
            return jsonify({"error": "The security token is missing or expired. Refresh and try again."}), 403
        return function(*args, **kwargs)
    return guarded


@app.get("/api/feedback")
def feedback_configuration():
    response = jsonify({"enabled": feedback_available(app.config), "csrf_token": _csrf_token()})
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/feedback")
@_csrf_required
def submit_feedback():
    # Same-origin JSON only; neither URL nor recipient can be supplied by visitors.
    if request.headers.get("Origin") != request.host_url.rstrip("/"):
        return jsonify({"error": "Please submit feedback from NutriCart."}), 403
    request.max_content_length = 4096
    if not request.is_json:
        return jsonify({"error": "Feedback must be JSON."}), 415
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or set(payload) - {"rating", "comment"}:
        return jsonify({"error": "Send only a rating and optional comment."}), 400
    rating, comment = payload.get("rating"), payload.get("comment", "")
    if (not isinstance(rating, str) or rating not in {"positive", "negative"}
            or not isinstance(comment, str) or len(comment) > 1000
            or any(ord(c) < 32 and c not in "\n\r\t" for c in comment)):
        return jsonify({"error": "Choose a rating and use at most 1,000 characters."}), 400
    if not feedback_available(app.config):
        return jsonify({"error": "Feedback sending is not configured."}), 503
    now = time.time()
    if now - session.get("feedback_sent_at", 0) < 60:
        response = jsonify({"error": "Please wait a minute before sending another feedback response."})
        response.headers["Retry-After"] = "60"
        return response, 429
    try:
        send_feedback(rating, comment.strip(), app.config)
    except FeedbackDeliveryError as error:
        # Log only provider, allowlisted stage, and status/class; never provider details or input.
        if error.status is not None:
            app.logger.warning(
                "feedback_delivery_failed provider=resend stage=%s status=%s",
                error.stage,
                error.status,
            )
        else:
            app.logger.warning(
                "feedback_delivery_failed provider=resend stage=%s exception=%s",
                error.stage,
                error.exception_class,
            )
        return jsonify({"error": "We could not confirm delivery. Please try again later."}), 502
    except Exception as error:
        # Defensive boundary for unexpected sender failures, still without exception details.
        app.logger.warning(
            "feedback_delivery_failed provider=resend stage=send exception=%s",
            type(error).__name__,
        )
        return jsonify({"error": "We could not confirm delivery. Please try again later."}), 502
    session["feedback_sent_at"] = now
    return jsonify({"delivered": True})


def _login_required(function):
    @wraps(function)
    def guarded(*args, **kwargs):
        if not _current_account_user():
            return jsonify({"error": "Sign in to access saved NutriCart content."}), 401
        return function(*args, **kwargs)
    return guarded



class _PlanningValidationError(ValueError):
    def __init__(self, message: str, **details):
        super().__init__(message)
        self.details = details


class _PlanningFeasibilityError(ValueError):
    def __init__(self, message: str, **details):
        super().__init__(message)
        self.details = details


PARTIAL_PLAN_MESSAGE = (
    "We couldn't make a complete plan for this budget. We found some groceries, "
    "but they may not provide enough food for your household and planning period. "
    "Try increasing your budget or reducing the number of days."
)
NO_PLAN_MESSAGE = (
    "We couldn't find a complete plan for this budget. Try increasing your budget "
    "or reducing the number of days."
)
CATALOG_LIMIT_MESSAGE = (
    "We couldn't find a complete plan with the current food options. Try reducing "
    "the number of people or days, or adjusting excluded foods."
)


class _KrogerAuthenticationError(RuntimeError):
    """Controlled server-side Kroger authentication failure."""


def _get_kroger_access_token() -> str:
    """Obtain a server-side Kroger token without logging credential data."""
    client_id = os.getenv("KROGER_CLIENT_ID")
    client_secret = os.getenv("KROGER_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise _KrogerAuthenticationError("Kroger credentials are unavailable.")
    try:
        response = requests.post(
            KROGER_TOKEN_URL,
            auth=(client_id, client_secret),
            data={"grant_type": "client_credentials", "scope": "product.compact"},
            timeout=30,
        )
        response.raise_for_status()
        access_token = response.json().get("access_token")
    except (requests.RequestException, ValueError, AttributeError) as error:
        raise _KrogerAuthenticationError("Kroger authentication failed.") from error
    if not isinstance(access_token, str) or not access_token:
        raise _KrogerAuthenticationError("Kroger authentication failed.")
    return access_token


def _price_comparison_inputs(payload: dict) -> tuple[list[dict], list[dict], str | None]:
    """Validate browser-supplied basket comparison inputs."""
    groceries = payload.get("groceries")
    if not isinstance(groceries, list) or not groceries:
        raise ValueError("Groceries must be a non-empty list.")
    validated_groceries = []
    for index, grocery in enumerate(groceries, start=1):
        if not isinstance(grocery, dict):
            raise ValueError(f"Grocery {index} must be a JSON object.")
        product_id = grocery.get("product_id")
        if not isinstance(product_id, str) or not product_id.strip():
            raise ValueError(f"Grocery {index} product_id must be a nonblank string.")
        quantity = grocery.get("quantity")
        if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity <= 0:
            raise ValueError(f"Grocery {index} quantity must be a positive integer.")
        validated_groceries.append({"product_id": product_id, "quantity": quantity})

    stores = payload.get("stores")
    if not isinstance(stores, list) or len(stores) < 2:
        raise ValueError("At least two stores are required.")
    validated_stores = []
    location_ids = set()
    for index, store in enumerate(stores, start=1):
        if not isinstance(store, dict):
            raise ValueError(f"Store {index} must be a JSON object.")
        location_id = store.get("location_id")
        store_name = store.get("store_name")
        if not isinstance(location_id, str) or not location_id.strip():
            raise ValueError(f"Store {index} location_id must be a nonblank string.")
        if not isinstance(store_name, str) or not store_name.strip():
            raise ValueError(f"Store {index} store_name must be a nonblank string.")
        if location_id in location_ids:
            raise ValueError("Store location IDs must be unique.")
        location_ids.add(location_id)
        validated_stores.append({"location_id": location_id, "store_name": store_name})

    reference = payload.get("reference_location_id")
    if reference is not None:
        if not isinstance(reference, str) or not reference.strip():
            raise ValueError("reference_location_id must be a nonblank string.")
        if reference not in location_ids:
            raise ValueError("reference_location_id must identify a supplied store.")
    return validated_groceries, validated_stores, reference


def _meal_plan_inputs(payload: dict) -> dict:
    """Validate current-plan context and re-enrich product IDs server-side."""
    groceries = payload.get("groceries")
    if not isinstance(groceries, list) or not groceries:
        raise ValueError("Groceries must be a non-empty list.")
    people = _planner_integer(payload.get("people"), "People", 1, 20)
    days = _planner_integer(payload.get("days"), "Days", 1, 31)
    diet = payload.get("diet")
    if diet not in DIETS:
        raise ValueError("Diet must be one of: omnivore, vegetarian, vegan, pescatarian.")
    exclusions = payload.get("food_group_exclusions", [])
    if not isinstance(exclusions, list) or len(set(exclusions)) != len(exclusions) or any(item not in FOOD_GROUP_EXCLUSIONS for item in exclusions):
        raise ValueError("Food group exclusions contain an unsupported value.")
    avoid = payload.get("foods_to_avoid", [])
    if not isinstance(avoid, list) or any(not isinstance(item, str) for item in avoid):
        raise ValueError("Foods to avoid must be a list of strings.")
    focus = payload.get("nutrition_focus", "none")
    if focus not in {"none", *NUTRITION_FOCUS_NUTRIENTS}:
        raise ValueError("Nutrition focus contains an unsupported value.")
    targets = payload.get("targets")
    if not isinstance(targets, dict):
        raise ValueError("Nutrition targets must be a JSON object.")
    validated_targets = {}
    for field, label, minimum, maximum in (("calories_kcal", "Calories target", 500, 5000), ("protein_g", "Protein target", 10, 300), ("fiber_g", "Fiber target", 5, 100)):
        validated_targets[field] = _planner_number(targets.get(field), label, minimum, maximum)

    catalog = load_catalog()
    by_id = {str(item.get("product_id") or item.get("catalog_id")): item for item in catalog}
    enriched, seen = [], set()
    for index, grocery in enumerate(groceries, start=1):
        if not isinstance(grocery, dict):
            raise ValueError(f"Grocery {index} must be a JSON object.")
        identifier, quantity = grocery.get("product_id"), grocery.get("quantity")
        if not isinstance(identifier, str) or not identifier.strip():
            raise ValueError(f"Grocery {index} product_id must be a nonblank string.")
        if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity <= 0:
            raise ValueError(f"Grocery {index} quantity must be a positive integer.")
        if identifier in seen:
            raise ValueError("Grocery product IDs must be unique.")
        if identifier not in by_id:
            raise ValueError(f"Grocery {index} is not in the NutriCart catalog.")
        seen.add(identifier)
        enriched.append({**by_id[identifier], "quantity": quantity})
    return {"groceries": enriched, "people": people, "days": days, "diet": diet,
            "food_group_exclusions": exclusions, "foods_to_avoid": parse_avoid_list(",".join(avoid)),
            "nutrition_focus": focus, "targets": validated_targets}


def _number(payload: dict, field: str, label: str, minimum: float, maximum: float | None = None) -> float:
    value = payload.get(field)
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a number.")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be a number.") from error
    if not math.isfinite(number) or number < minimum or (maximum is not None and number > maximum):
        if maximum is None:
            raise ValueError(f"{label} must be greater than zero.")
        raise ValueError(f"{label} must be between {minimum:g} and {maximum:g}.")
    return number


def _json_object() -> dict:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object.")
    return payload


def _planner_number(value, label: str, minimum: float, maximum: float | None = None) -> float:
    if isinstance(value, bool):
        raise _PlanningValidationError(f"{label} must be a number.")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise _PlanningValidationError(f"{label} must be a number.") from error
    if not math.isfinite(number):
        raise _PlanningValidationError(f"{label} must be a finite number.")
    if number < minimum:
        raise _PlanningValidationError(f"{label} must be at least {minimum:g}.")
    if maximum is not None and number > maximum:
        raise _PlanningValidationError(f"{label} must be at most {maximum:g}.")
    return number


def _planner_integer(value, label: str, minimum: int, maximum: int) -> int:
    number = _planner_number(value, label, minimum, maximum)
    if not number.is_integer():
        raise _PlanningValidationError(f"{label} must be a whole number.")
    return int(number)


def _planning_values(payload: dict, require_exclusions: bool = False) -> tuple[dict, set[str] | None, list[set[str]]]:
    try:
        location = planning_location(payload.get("location"))
    except ValueError as error:
        raise _PlanningValidationError(str(error)) from error
    store = payload.get("selected_store")
    if store is not None and not planning_allowed(store):
        category = planning_suitability(store.get("store_type") if isinstance(store, dict) else None)["category"]
        raise _PlanningValidationError(
            UNKNOWN_MESSAGE if category == "unknown" else LIMITED_MESSAGE,
            retailer_planning_blocked=True,
        )
    budget = _planner_number(payload.get("budget"), "Budget", 10)
    people = _planner_integer(payload.get("people"), "People", 1, 20)
    days = _planner_integer(payload.get("days"), "Days", 1, 31)

    calories_value = payload.get("calories")
    if not isinstance(calories_value, bool):
        try:
            numeric_calories = float(calories_value)
        except (TypeError, ValueError):
            pass
        else:
            if math.isfinite(numeric_calories) and numeric_calories == 180:
                raise _PlanningValidationError(
                    "Daily calories must be at least 500.", suggested_calories=1800
                )
    calories = _planner_number(calories_value, "Daily calories", 500, 5000)
    protein = _planner_number(payload.get("protein"), "Daily protein", 10, 300)

    diet = payload.get("diet")
    if diet not in DIETS:
        raise _PlanningValidationError("Diet must be one of: omnivore, vegetarian, vegan, pescatarian.")
    include_fish = payload.get("include_fish", False)
    if not isinstance(include_fish, bool):
        raise _PlanningValidationError("Include fish must be true or false.")
    if include_fish and diet != "pescatarian":
        raise _PlanningValidationError("Include fish is available for Pescatarian plans.")
    preference = payload.get("preference")
    if preference not in PREFERENCES:
        raise _PlanningValidationError("Preference must be one of: balanced, budget, nutrition, variety.")
    food_group_exclusions = payload.get("food_group_exclusions", [])
    if (
        not isinstance(food_group_exclusions, list)
        or any(not isinstance(item, str) for item in food_group_exclusions)
        or any(item not in FOOD_GROUP_EXCLUSIONS for item in food_group_exclusions)
    ):
        raise _PlanningValidationError("Food group exclusions contain an unsupported value.")
    if len(set(food_group_exclusions)) != len(food_group_exclusions):
        raise _PlanningValidationError("Food group exclusions must be unique.")
    nutrition_focus = payload.get("nutrition_focus", "none")
    supported_focus = {"none", *NUTRITION_FOCUS_NUTRIENTS}
    if nutrition_focus not in supported_focus:
        raise _PlanningValidationError("Nutrition focus contains an unsupported value.")
    fiber_mode = payload.get("fiber_mode")
    if fiber_mode not in FIBER_MODES:
        raise _PlanningValidationError("Fiber mode must be recommended or custom.")

    foods = payload.get("foods_to_avoid")
    if not isinstance(foods, list) or any(not isinstance(item, str) for item in foods):
        raise _PlanningValidationError("Foods to avoid must be a list of strings.")
    avoid = parse_avoid_list(",".join(foods))
    fiber = (
        default_fiber_target(calories)
        if fiber_mode == "recommended"
        else _planner_number(payload.get("fiber_custom"), "Custom fiber", 5, 100)
    )

    excluded_ids = None
    prior_product_id_sets = []
    if require_exclusions:
        exclusions = payload.get("excluded_product_ids")
        if (not isinstance(exclusions, list) or not 1 <= len(exclusions) <= 20
                or any(not isinstance(item, str) or not item.strip() or item != item.strip() for item in exclusions)
                or len(set(exclusions)) != len(exclusions)):
            raise _PlanningValidationError("Original basket product IDs must be a non-empty list of unique IDs (at most 20).")
        excluded_ids = set(exclusions)
        prior_sets = payload.get("previous_product_id_sets", [])
        if (
            not isinstance(prior_sets, list) or len(prior_sets) > 6
            or any(not isinstance(item, list) or not 1 <= len(item) <= 20 for item in prior_sets)
            or any(not isinstance(identifier, str) or not identifier.strip() or identifier != identifier.strip()
                   for item in prior_sets for identifier in item)
            or any(len(set(item)) != len(item) for item in prior_sets)
        ):
            raise _PlanningValidationError("Previous product ID sets are invalid.")
        prior_product_id_sets = [set(item) for item in prior_sets]

    return {
        "budget": budget, "people": people, "days": days, "diet": diet,
        "preference": preference, "avoid": avoid, "calories": calories,
        "protein": protein, "fiber": fiber, "fiber_source": fiber_mode,
        "food_group_exclusions": list(food_group_exclusions),
        "nutrition_focus": nutrition_focus,
        "include_fish": include_fish,
        "location": location,
    }, excluded_ids, prior_product_id_sets


def _alternative_profiles(identifiers: set[str], by_id: dict) -> set[str]:
    """Resolve reference identities from the catalog, never from client claims."""
    if not identifiers <= by_id.keys():
        raise _PlanningValidationError("Original basket product IDs must identify foods in the current NutriCart catalog.")
    profiles = {str(by_id[identifier].get("food_profile") or by_id[identifier].get("food_name") or identifier)
                for identifier in identifiers}
    if len(profiles) != len(identifiers):
        raise _PlanningValidationError("Original basket must contain unique food selections.")
    return profiles


def _alternative_quantities(groceries, by_id: dict, values: dict) -> dict[str, int]:
    """Validate the existing product_id/quantity shape; ignore price/nutrition claims."""
    if not isinstance(groceries, list) or not 1 <= len(groceries) <= 20:
        raise ValueError("Original basket groceries must be a non-empty list (at most 20).")
    quantities = {}
    for item in groceries:
        if not isinstance(item, dict):
            raise ValueError("Original basket groceries must contain product IDs and quantities.")
        identifier, quantity = item.get("product_id"), item.get("quantity")
        if not isinstance(identifier, str) or identifier not in by_id or identifier in quantities:
            raise ValueError("Original basket groceries must contain unique, current catalog product IDs.")
        if type(quantity) is not int or not 1 <= quantity <= package_upper_bound(by_id[identifier], values["people"], values["days"]):
            raise ValueError("Original basket quantities must be positive whole numbers within the plan's package limits.")
        quantities[identifier] = quantity
    return quantities


def _feasibility_values(payload: dict) -> dict | None:
    """Validate partial guidance inputs using the planner's existing contracts."""

    diet = payload.get("diet")
    if diet in (None, ""):
        return None
    if diet not in DIETS:
        raise _PlanningValidationError("Diet must be one of: omnivore, vegetarian, vegan, pescatarian.")
    raw = {key: payload.get(key) for key in ("budget", "people", "days")}
    normalized = {
        **payload,
        "budget": raw["budget"] if raw["budget"] not in (None, "") else 10,
        "people": raw["people"] if raw["people"] not in (None, "") else 1,
        "days": raw["days"] if raw["days"] not in (None, "") else 1,
        "preference": payload.get("preference") or "balanced",
        "foods_to_avoid": payload.get("foods_to_avoid") or [],
        "calories": payload.get("calories") if payload.get("calories") not in (None, "") else 2000,
        "protein": payload.get("protein") if payload.get("protein") not in (None, "") else 50,
        "fiber_mode": "custom" if payload.get("fiber_custom") not in (None, "") else "recommended",
    }
    values, _excluded, _history = _planning_values(normalized)
    values.update({
        "budget": None if raw["budget"] in (None, "") else values["budget"],
        "people": None if raw["people"] in (None, "") else values["people"],
        "days": None if raw["days"] in (None, "") else values["days"],
        "nutrition_basis": payload.get("nutrition_basis") if payload.get("nutrition_basis") in {"general", "manual", "household"} else "general",
    })
    return values


def _public_plan_response(values: dict, catalog: list[dict], eligible: list[dict], plan: dict) -> dict:
    summary = summarize_plan(plan, values)
    groceries = []
    for product in plan.get("groceries", []):
        public_product = {
            "quantity": product.get("quantity"),
            "product_name": product.get("product_name"),
            "product_id": product.get("product_id") or product.get("catalog_id"),
            "category": product.get("food_category"),
            "unit_price": product.get("unit_price"),
            "item_total": product.get("total_cost"),
            "nutrition_is_estimated": bool(product.get("nutrition_is_estimated", True)),
            "store_name": None,
            "package_size": product.get("package_size"),
            "package_weight_g": product.get("package_weight_g"),
        }
        groceries.append({key: public_product[key] for key in PUBLIC_GROCERY_FIELDS})
    quality = score_plan(summary, plan["targets"], plan.get("groceries", []))
    quality_explanation = score_plan_breakdown(
        summary, plan["targets"], plan.get("groceries", [])
    )
    acceptance = plan_acceptance(plan, summary, quality)
    return {
        "solver_status": plan.get("status", "Unknown"),
        "groceries": groceries,
        "total_cost": summary["total_cost"],
        "remaining_budget": round(values["budget"] - summary["total_cost"], 2),
        "nutrition_per_person_per_day": summary["nutrition_per_person_per_day"],
        "nutrition_targets": plan["targets"],
        "quality_score": quality,
        "quality_score_explanation": quality_explanation,
        "acceptance": acceptance,
        "feasibility_status": acceptance["status"],
        "planning_settings": {
            "diet": values["diet"],
            "include_fish": values.get("include_fish", False),
            "preference": values["preference"],
            "nutrition_focus": values.get("nutrition_focus", "none"),
            "food_group_exclusions": values.get("food_group_exclusions", []),
        },
        "planning_context": {
            "location": values.get("location"),
            "include_fish": values.get("include_fish", False),
            "catalog_scope": dict(GENERAL_CATALOG),
            "budget": values["budget"], "people": values["people"], "days": values["days"],
            "diet": values["diet"], "preference": values["preference"],
            "food_group_exclusions": values.get("food_group_exclusions", []),
            "foods_to_avoid": values.get("avoid", []),
            "nutrition_focus": values.get("nutrition_focus", "none"),
            "calories": values["calories"], "protein": values["protein"],
            "fiber_mode": values.get("fiber_source", "recommended"),
            "fiber_custom": values["fiber"] if values.get("fiber_source") == "custom" else None,
        },
        "estimated_nutrition_count": sum(item["nutrition_is_estimated"] for item in groceries),
        "eligible_product_count": len(eligible),
        "filtered_product_count": len(catalog) - len(eligible),
        **({
            "alternative_difference_count": plan.get("alternative_difference_count", 0),
            "alternative_requested_changes": plan.get("alternative_requested_changes", 0),
            "alternative_required_changes": plan.get("alternative_required_changes", 0),
        } if plan.get("alternative_requested_changes") else {}),
    }


def _grocery_plan_result(payload: dict, alternative: bool = False) -> dict:
    values, excluded_ids, prior_product_id_sets = _planning_values(payload, alternative)
    catalog = load_catalog()
    eligible, _removed = filter_catalog(
        planning_candidates(catalog), values["diet"], values["avoid"], values["food_group_exclusions"]
    )
    reference = None
    if alternative:
        by_id = {str(row.get("product_id") or row.get("catalog_id")): row for row in catalog}
        original_profiles = _alternative_profiles(excluded_ids, by_id)
        prior_profiles = [_alternative_profiles(ids, by_id) for ids in prior_product_id_sets]
        # ID-only callers retain their existing contract. The browser also supplies
        # the current product_id/quantity rows, using the existing grocery schema.
        quantities = None
        if "groceries" in payload:
            try:
                quantities = _alternative_quantities(payload["groceries"], by_id, values)
            except ValueError as error:
                raise _PlanningValidationError(str(error)) from error
            if quantities.keys() != excluded_ids:
                raise _PlanningValidationError("Original basket groceries must match the supplied product IDs.")
        required = min(max(2, math.ceil(len(original_profiles) * 0.25)), len(original_profiles))
        reference = (by_id, original_profiles, prior_profiles, quantities, required)
    estimated_minimum = minimum_feasible_cost(eligible, values)
    if estimated_minimum is None:
        raise _PlanningFeasibilityError(
            CATALOG_LIMIT_MESSAGE,
            feasibility_status="clearly_infeasible",
        )
    if values["budget"] + 0.005 < estimated_minimum:
        shortfall = round(estimated_minimum - values["budget"], 2)
        raise _PlanningFeasibilityError(
            NO_PLAN_MESSAGE,
            feasibility_status="clearly_infeasible", estimated_minimum=estimated_minimum,
            shortfall=shortfall,
        )
    plan = solve_plan(eligible, values, excluded_ids, prior_product_id_sets)
    if alternative:
        by_id, original_profiles, prior_profiles, original_quantities, required = reference
        unavailable = ("We couldn't find a sufficiently different alternative with these settings. "
                       "Your current plan is unchanged.")
        try:
            candidate_quantities = _alternative_quantities(plan.get("groceries"), by_id, values)
            candidate_profiles = _alternative_profiles(set(candidate_quantities), by_id)
        except ValueError as error:
            raise _PlanningFeasibilityError(unavailable) from error
        eligible_ids = {str(row.get("product_id") or row.get("catalog_id")) for row in eligible}
        # The documented rule counts removed food profiles, not changed package
        # counts or a different identifier for the same food. Check every reference.
        difference = len(original_profiles - candidate_profiles)
        if (not candidate_quantities.keys() <= eligible_ids
                or candidate_quantities == original_quantities
                or difference < required
                or any(len(profiles - candidate_profiles) < min(required, len(profiles)) for profiles in prior_profiles)):
            raise _PlanningFeasibilityError(unavailable)
        canonical = []
        for identifier, quantity in candidate_quantities.items():
            product = by_id[identifier]
            price = float(product["effective_price"])
            canonical.append({**product, "quantity": quantity, "unit_price": round(price, 2), "total_cost": round(price * quantity, 2)})
        # Solver/client diversity metadata cannot certify an actual substitution.
        plan = {**plan, "groceries": canonical, "alternative_requested_changes": required,
                "alternative_required_changes": required, "alternative_difference_count": difference}
    response = _public_plan_response(values, catalog, eligible, plan)
    if not response["acceptance"]["accepted"]:
        app.logger.info(
            "Grocery plan rejected after optimization: status=%s, basket_lines=%d, "
            "total_cost=%.2f, score=%s, threshold=%s, nutrition_checks=%s",
            plan.get("status", "Unknown"), len(response["groceries"]),
            response["total_cost"], response["acceptance"].get("score"),
            response["acceptance"].get("score_threshold"),
            response["acceptance"].get("nutrition_checks", {}),
        )
        raise _PlanningFeasibilityError(
            PARTIAL_PLAN_MESSAGE if response["groceries"] else NO_PLAN_MESSAGE,
            feasibility_status="clearly_infeasible",
        )
    return response


def _planning_error(error: _PlanningValidationError):
    return jsonify({"error": str(error), **error.details}), 400


def _feasibility_error(error: _PlanningFeasibilityError):
    return jsonify({"error": str(error), **error.details}), 422


@app.get("/favicon.svg")
def favicon():
    # Render the shared mark from this origin so strict reset-page CSP stays intact.
    response = app.response_class(render_template("nutricart-logo.svg"), mimetype="image/svg+xml")
    response.headers["Cache-Control"] = "public, max-age=0, must-revalidate"
    return response


@app.get("/")
def index():
    return render_template(
        "index.html",
        account_user=_current_account_user(),
        accounts_enabled=app.config["ACCOUNTS_ENABLED"],
        current_year=datetime.now(timezone.utc).year,
        retailer_policy=retailer_policy(),
    )


@app.get("/api/account/session")
def account_session():
    user = _current_account_user()
    return jsonify({"authenticated": bool(user), "user": user, "csrf_token": _csrf_token()})


@app.post("/api/account/register")
@_csrf_required
def account_register():
    try:
        payload = _json_object()
        if payload.get("password") != payload.get("confirm_password"):
            raise StoreError("Passwords do not match.")
        result = _supabase_accounts().signup(payload.get("email"), payload.get("password"), payload.get("first_name"), payload.get("last_name", ""))
        if result.get("tokens"):
            _queue_supabase_tokens(result["tokens"])
        return jsonify({"user": result.get("user") if result.get("tokens") else None, "confirmation_required": result["confirmation_required"]}), 201
    except SupabaseError as error:
        if error.provider_code in {"user_already_exists", "email_exists"}:
            return jsonify({"user": None, "confirmation_required": True}), 201
        return jsonify({"error": str(error)}), error.status
    except (ValueError, StoreError) as error:
        return jsonify({"error": str(error)}), getattr(error, "status", 400)
    except Exception:
        return jsonify({"error": "The account could not be created. Please try again."}), 500


@app.post("/api/account/login")
@_csrf_required
def account_login():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Request body must be a JSON object."}), 400
    key = f"{request.remote_addr or 'unknown'}:{str(payload.get('email') or '').strip().casefold()}"
    now = time.monotonic()
    attempts = [stamp for stamp in _LOGIN_ATTEMPTS.get(key, []) if now - stamp < 300]
    if len(attempts) >= 8:
        return jsonify({"error": "Too many sign-in attempts. Wait a few minutes and try again."}), 429
    try:
        result = _supabase_accounts().login(payload.get("email"), payload.get("password"))
        if not result.get("tokens"):
            raise SupabaseError("Incorrect email or password. Please try again.", 401)
        user = result["user"]
        _queue_supabase_tokens(result["tokens"])
        if not user:
            attempts.append(now)
            _LOGIN_ATTEMPTS[key] = attempts
            return jsonify({"error": "Incorrect email or password. Please try again."}), 401
    except (StoreError, SupabaseError) as error:
        attempts.append(now)
        _LOGIN_ATTEMPTS[key] = attempts
        return jsonify({"error": str(error)}), getattr(error, "status", 401)
    _LOGIN_ATTEMPTS.pop(key, None)
    return jsonify({"user": user})


@app.post("/api/account/logout")
@_csrf_required
def account_logout():
    try:
        if _using_supabase():
            _supabase_accounts().logout(request.cookies.get("nutricart_access", ""))
    except (StoreError, SupabaseError):
        return jsonify({"error": "Sign out failed. Please try again."}), 503
    except Exception:
        return jsonify({"error": "Sign out failed. Please try again."}), 500
    _queue_supabase_tokens(clear=True)
    session.pop("user_id", None)
    session.pop("auth_version", None)
    return jsonify({"signed_out": True})


@app.after_request
def protect_account_responses(response):
    if request.path.startswith("/api/account/") or request.path.startswith("/api/saved-items") or request.path in {"/reset-password", "/api/feedback"}:
        response.headers["Cache-Control"] = "no-store"
    if request.path == "/reset-password":
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    if getattr(g, "clear_supabase_tokens", False):
        response.delete_cookie("nutricart_access", path="/", secure=app.config["SESSION_COOKIE_SECURE"], httponly=True, samesite="Lax")
        response.delete_cookie("nutricart_refresh", path="/", secure=app.config["SESSION_COOKIE_SECURE"], httponly=True, samesite="Lax")
    elif getattr(g, "supabase_tokens", None):
        tokens = g.supabase_tokens
        response.set_cookie("nutricart_access", tokens["access_token"], max_age=max(60, int(tokens.get("expires_in") or 3600)), secure=app.config["SESSION_COOKIE_SECURE"], httponly=True, samesite="Lax", path="/")
        response.set_cookie("nutricart_refresh", tokens["refresh_token"], max_age=60 * 60 * 24 * 365, secure=app.config["SESSION_COOKIE_SECURE"], httponly=True, samesite="Lax", path="/")
    return response


@app.get("/reset-password")
def reset_password_page():
    return render_template("reset_password.html", account_backend="supabase" if _using_supabase() else "local")


@app.post("/api/account/forgot-password")
@_csrf_required
def account_forgot_password():
    confirmation = {"message": "If an account matches that email, you'll receive a reset link. Check your inbox and spam folder."}
    try:
        payload = _json_object()
    except ValueError:
        return jsonify({"error": "Request body must be a JSON object."}), 400
    try:
        _supabase_accounts().request_password_reset(payload.get("email"))
    except SupabaseError as error:
        if error.status == 429:
            return jsonify({"error": "Too many reset requests. Please wait a minute before trying again."}), 429
        if error.status >= 500 or error.provider_code == "email_address_not_authorized":
            return jsonify({"error": "Password reset is temporarily unavailable. Please try again later."}), 503
    except StoreError:
        pass
    return jsonify(confirmation)

@app.post("/api/account/resend-confirmation")
@_csrf_required
def account_resend_confirmation():
    confirmation = {
        "message": "If an unconfirmed account exists for that email, a new confirmation email has been sent."
    }
    try:
        payload = _json_object()
    except ValueError:
        return jsonify({"error": "Request body must be a JSON object."}), 400
    try:
        _supabase_accounts().resend_signup_confirmation(payload.get("email"))
    except (StoreError, SupabaseError):
        pass
    return jsonify(confirmation)


@app.post("/api/account/reset-password")
@_csrf_required
def account_reset_password():
    try:
        payload = _json_object()
        if payload.get("new_password") != payload.get("confirm_password"):
            raise StoreError("New passwords do not match.")
        recovery_token = payload.get("access_token")
        if not isinstance(recovery_token, str) or not recovery_token:
            raise StoreError("This reset link is invalid or expired. Request a new link.")
        _supabase_accounts().update_password(recovery_token, payload.get("new_password"))
        _queue_supabase_tokens(clear=True)
        return jsonify({"message": "Password reset. Sign in with your new password."})
    except (ValueError, StoreError, SupabaseError) as error:
        return jsonify({"error": str(error)}), getattr(error, "status", 400)
    except Exception:
        return jsonify({"error": "The password could not be reset. Please try again."}), 500


@app.patch("/api/account/profile")
@_csrf_required
@_login_required
def account_profile():
    try:
        payload = _json_object()
        user = _supabase_accounts().update_profile(g.account_access_token, payload.get("first_name"), payload.get("last_name", ""))
        g.account_user = user
        return jsonify({"user": user})
    except (ValueError, StoreError, SupabaseError) as error:
        return jsonify({"error": str(error)}), getattr(error, "status", 400)


@app.post("/api/account/change-password")
@_csrf_required
@_login_required
def account_change_password():
    try:
        payload = _json_object()
        if payload.get("new_password") != payload.get("confirm_password"):
            raise StoreError("New passwords do not match.")
        result = _supabase_accounts().change_password(g.account_user["email"], payload.get("current_password"), payload.get("new_password"))
        _queue_supabase_tokens(result.get("tokens"))
        return jsonify({"changed": True})
    except (ValueError, StoreError, SupabaseError) as error:
        return jsonify({"error": str(error)}), getattr(error, "status", 400)


@app.delete("/api/account")
@_csrf_required
@_login_required
def account_delete():
    return jsonify({"error": "Account deletion is not enabled in this Supabase integration."}), 501


def _saved_store_context():
    user = _current_account_user()
    return _supabase_accounts(), g.account_access_token, user["id"]


@app.get("/api/saved-items")
@_login_required
def saved_items_list():
    try:
        store, token, _ = _saved_store_context()
        items = store.list_items(token, request.args.get("kind"))
        return jsonify({"items": items})
    except (StoreError, SupabaseError) as error:
        return jsonify({"error": str(error)}), getattr(error, "status", 400)


@app.post("/api/saved-items")
@_csrf_required
@_login_required
def saved_items_create():
    try:
        payload = _json_object()
        store, token, user_id = _saved_store_context()
        item = store.save_item(token, user_id, payload.get("kind"), payload.get("name"), payload.get("data"))
        return jsonify({"item": item}), 201
    except (ValueError, StoreError, SupabaseError) as error:
        return jsonify({"error": str(error)}), getattr(error, "status", 400)
    except Exception:
        return jsonify({"error": "NutriCart could not save that item."}), 500


@app.get("/api/saved-items/<item_id>")
@_login_required
def saved_items_get(item_id):
    try:
        store, token, _ = _saved_store_context()
        item = store.get_item(token, item_id)
        return (jsonify({"item": item}), 200) if item else (jsonify({"error": "Saved item was not found."}), 404)
    except (StoreError, SupabaseError) as error:
        return jsonify({"error": str(error)}), getattr(error, "status", 400)


@app.patch("/api/saved-items/<item_id>")
@_csrf_required
@_login_required
def saved_items_rename(item_id):
    try:
        payload = _json_object()
        store, token, _ = _saved_store_context()
        item = store.rename_item(token, item_id, payload.get("name"))
        return (jsonify({"item": item}), 200) if item else (jsonify({"error": "Saved item was not found."}), 404)
    except (ValueError, StoreError, SupabaseError) as error:
        return jsonify({"error": str(error)}), getattr(error, "status", 400)


@app.delete("/api/saved-items/<item_id>")
@_csrf_required
@_login_required
def saved_items_delete(item_id):
    try:
        store, token, _ = _saved_store_context()
        deleted = store.delete_item(token, item_id)
        return (jsonify({"deleted": True}), 200) if deleted else (jsonify({"error": "Saved item was not found."}), 404)
    except (StoreError, SupabaseError) as error:
        return jsonify({"error": str(error)}), getattr(error, "status", 400)


@app.post("/api/grocery-plan")
def grocery_plan():
    try:
        payload = _json_object()
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    try:
        return jsonify(_grocery_plan_result(payload))
    except _PlanningValidationError as error:
        return _planning_error(error)
    except _PlanningFeasibilityError as error:
        return _feasibility_error(error)
    except Exception:
        return jsonify({"error": "The grocery planner is unavailable. Please try again later."}), 500


@app.post("/api/grocery-plan/alternative")
def alternative_grocery_plan():
    try:
        payload = _json_object()
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    try:
        return jsonify(_grocery_plan_result(payload, alternative=True))
    except _PlanningValidationError as error:
        return _planning_error(error)
    except _PlanningFeasibilityError as error:
        return _feasibility_error(error)
    except Exception:
        return jsonify({"error": "The grocery planner is unavailable. Please try again later."}), 500


@app.post("/api/grocery-feasibility")
def grocery_feasibility():
    try:
        values = _feasibility_values(_json_object())
        if values is None:
            return jsonify({
                "status": "incomplete", "message": "", "shortfall": None,
                "guidance": {"budget": None, "people": None, "days": None},
                "basis": "general",
            })
        catalog = load_catalog()
        eligible, _removed = filter_catalog(
            planning_candidates(catalog), values["diet"], values["avoid"], values["food_group_exclusions"]
        )
        return jsonify(feasibility_guidance(eligible, values))
    except (ValueError, _PlanningValidationError) as error:
        return jsonify({"error": str(error)}), 400
    except Exception:
        return jsonify({"error": "Feasibility guidance is temporarily unavailable."}), 500


@app.post("/api/meal-plan")
def meal_plan():
    try:
        values = _meal_plan_inputs(_json_object())
        return jsonify(build_meal_plan(**values))
    except (ValueError, _PlanningValidationError) as error:
        return jsonify({"error": str(error)}), 400
    except Exception:
        return jsonify({"error": "The meal planner is unavailable. Please try again later."}), 500


@app.get("/api/fiber-target")
def fiber_target():
    try:
        calories_value = request.args.get("calories")
        if calories_value == "180":
            raise _PlanningValidationError(
                "Daily calories must be at least 500.", suggested_calories=1800
            )
        calories = _planner_number(calories_value, "Daily calories", 500, 5000)
        return jsonify({"calories": calories, "fiber_target": default_fiber_target(calories)})
    except _PlanningValidationError as error:
        return _planning_error(error)
    except Exception:
        return jsonify({"error": "The fiber calculator is unavailable. Please try again later."}), 500


@app.post("/api/nutrition-reference")
def nutrition_reference():
    """Return a local, non-medical household planning estimate."""
    try:
        payload = _json_object()
        people = _planner_integer(payload.get("people"), "People", 1, 20)
        members = payload.get("members")
        if not isinstance(members, list) or len(members) != people:
            raise ValueError("Household information must match the People count.")
        return jsonify(estimate_household(members))
    except (ValueError, _PlanningValidationError) as error:
        return jsonify({"error": str(error)}), 400
    except Exception:
        return jsonify({"error": "The household estimate is unavailable. Enter manual goals instead."}), 500


@app.post("/api/snap-retailers")
def snap_retailers():
    try:
        payload = _json_object()
        latitude = _number(payload, "latitude", "Latitude", -90, 90)
        longitude = _number(payload, "longitude", "Longitude", -180, 180)
        radius = _number(payload, "radius_miles", "Radius", 0)
        if radius == 0:
            raise ValueError("Radius must be greater than zero.")
        stores = find_snap_retailers(latitude, longitude, radius)
        results = [{key: store.get(key) for key in (
            "record_id", "store_name", "display_name", "store_type", "distance_miles", "street_address",
            "additional_address", "city", "state", "zip_code", "incentive_program",
            "name_resolution", "planning_suitability",
        )} for store in stores]
        return jsonify({"retailers": results, "safety_cap_reached": bool(getattr(stores, "safety_cap_reached", False))})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except RuntimeError:
        return jsonify({"error": "The SNAP retailer service is unavailable. Please try again later."}), 502


@app.post("/api/basket-price-comparison")
def basket_price_comparison():
    if demo_catalog_enabled():
        return jsonify({"error": "Store-specific prices aren't available yet. Your grocery plan uses estimated prices, which may differ from actual store prices."}), 503
    try:
        payload = _json_object()
        groceries, stores, reference = _price_comparison_inputs(payload)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    try:
        access_token = _get_kroger_access_token()
    except _KrogerAuthenticationError:
        return jsonify({"error": "Price service authentication is unavailable."}), 502
    try:
        result = compare_kroger_basket_prices(
            groceries,
            stores,
            access_token,
            reference_location_id=reference,
        )
        return jsonify(result)
    except Exception:
        return jsonify({"error": "The price comparison service is unavailable."}), 502


@app.post("/api/geocode")
def geocode():
    try:
        payload = _json_object()
        address = payload.get("address")
        if not isinstance(address, str) or not address.strip():
            raise ValueError("Please enter a street address.")
        latitude, longitude, matched_address = geocode_address(address)
        return jsonify({
            "matched_address": matched_address,
            "latitude": latitude,
            "longitude": longitude,
            "planning_location": location_from_address(matched_address),
        })
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except RuntimeError:
        return jsonify({"error": "The address service is unavailable. Please try again later."}), 502


if __name__ == "__main__":
    app.run()
