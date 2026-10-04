"""Conservative helpers for normalizing existing grocery price records."""

import json
import math
import re
from pathlib import Path
from typing import Any, Callable

import requests

from package_units import normalize_package_size


MASS_FACTORS_G = {"oz": 28.3495, "lb": 453.592, "g": 1.0, "kg": 1000.0}
VOLUME_FACTORS_ML = {
    "fl oz": 29.5735, "ml": 1.0, "l": 1000.0,
    "pt": 473.176, "qt": 946.353, "gal": 3785.41,
}
COUNT_UNITS = {"ct", "count"}
LOW_WEIGHT_SOURCES = {"profile_default"}
MEDIUM_WEIGHT_SOURCES = {"explicit_liquid_size"}
ACCEPTABLE_CONFIDENCE = {"high", "medium"}
from catalog_config import catalog_path

DEFAULT_NORMALIZED_PRICES = catalog_path("prices")
KROGER_PRODUCTS_URL = "https://api.kroger.com/v1/products"

UNIT_ALIASES = {
    "ounce": "oz", "ounces": "oz", "lbs": "lb", "pound": "lb", "pounds": "lb",
    "gram": "g", "grams": "g", "kilogram": "kg", "kilograms": "kg",
    "fluid ounce": "fl oz", "fluid ounces": "fl oz", "floz": "fl oz",
    "milliliter": "ml", "milliliters": "ml", "liter": "l", "liters": "l",
    "pint": "pt", "pints": "pt", "quart": "qt", "quarts": "qt",
    "gallon": "gal", "gallons": "gal",
}

MEASUREMENT_PATTERN = re.compile(
    r"(?<![\d.])(\d+(?:\.\d+)?)\s*"
    r"(fluid\s+ounces?|fl\.?\s*oz|floz|ounces?|oz|pounds?|lbs?|kilograms?|kg|"
    r"grams?|g|milliliters?|ml|liters?|l|pints?|pt|quarts?|qt|gallons?|gal|count|ct)\b",
    re.IGNORECASE,
)
FRACTION_PATTERN = re.compile(
    r"(?<!\d)(\d+)\s*/\s*(\d+)\s*(gallons?|gal|quarts?|qt|pints?|pt|liters?|l)\b",
    re.IGNORECASE,
)


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _canonical_unit(raw_unit: str) -> str:
    unit = re.sub(r"\s+", " ", raw_unit.lower().replace(".", "")).strip()
    return UNIT_ALIASES.get(unit, unit)


def _measurement(amount: float, unit: str) -> dict:
    if unit in MASS_FACTORS_G:
        return {"amount": amount, "unit": unit, "dimension": "mass"}
    if unit in VOLUME_FACTORS_ML:
        return {"amount": amount, "unit": unit, "dimension": "volume"}
    if unit in COUNT_UNITS:
        return {"amount": amount, "unit": "count", "dimension": "count"}
    return {"amount": amount, "unit": None, "dimension": "unknown"}


def parse_package_measurement(package_size_text: Any) -> dict:
    """Parse one unambiguous package measurement without cross-dimension conversion."""
    text = normalize_package_size(package_size_text)
    if not text:
        return {"measurement": None, "ambiguous": False, "method": None}

    matches = []
    occupied = []
    for match in FRACTION_PATTERN.finditer(text):
        denominator = float(match.group(2))
        if denominator > 0:
            matches.append(_measurement(float(match.group(1)) / denominator, _canonical_unit(match.group(3))))
            occupied.append(match.span())
    for match in MEASUREMENT_PATTERN.finditer(text):
        if any(start <= match.start() < end for start, end in occupied):
            continue
        matches.append(_measurement(float(match.group(1)), _canonical_unit(match.group(2))))

    if len(matches) != 1 or matches[0]["amount"] <= 0:
        return {"measurement": None, "ambiguous": len(matches) > 1, "method": None}
    method = "explicit_fraction" if FRACTION_PATTERN.search(text) else "explicit_package_text"
    return {"measurement": matches[0], "ambiguous": False, "method": method}


def dimensions_compatible(first: str | None, second: str | None) -> bool:
    """Return True only for the same known measurement dimension."""
    return first in {"mass", "volume", "count"} and first == second


def _normalized_price(price: float, measurement: dict, package_quantity: float) -> tuple[float, str]:
    amount = measurement["amount"] * package_quantity
    dimension = measurement["dimension"]
    unit = measurement["unit"]
    if dimension == "mass":
        base_amount = amount * MASS_FACTORS_G[unit]
        return round(price / base_amount * 100, 4), "per_100g"
    if dimension == "volume":
        base_amount = amount * VOLUME_FACTORS_ML[unit]
        return round(price / base_amount * 100, 4), "per_100ml"
    return round(price / amount, 4), "per_item"


def normalize_price_record(source: dict) -> dict:
    """Return one normalized record, withholding unsafe normalized prices."""
    upc_value = source.get("upc")
    upc = None if upc_value is None else str(upc_value)
    price = _number(source.get("effective_price"))
    regular_price = _number(source.get("regular_price"))
    sale_price = _number(source.get("promotional_price"))
    package_quantity = _number(source.get("package_quantity", 1))
    package_text = normalize_package_size(source.get("package_size"))
    parsed = parse_package_measurement(package_text)
    measurement = parsed["measurement"]

    confidence = "high" if measurement else "low"
    method = parsed["method"] if measurement else None
    weight_source = str(source.get("package_weight_source") or "")
    if weight_source in LOW_WEIGHT_SOURCES:
        confidence = "low"
    elif confidence == "high" and weight_source in MEDIUM_WEIGHT_SOURCES:
        confidence = "medium"

    if measurement and measurement["dimension"] == "mass":
        recorded_weight = _number(source.get("package_weight_g"))
        parsed_weight = measurement["amount"] * MASS_FACTORS_G[measurement["unit"]]
        if recorded_weight is not None and abs(recorded_weight - parsed_weight) / parsed_weight > 0.05:
            confidence = "low"

    if parsed["ambiguous"] or price is None or price <= 0 or package_quantity is None or package_quantity <= 0:
        confidence = "low"

    normalized_price = normalized_unit = None
    if measurement and confidence in {"high", "medium"} and price and package_quantity:
        normalized_price, normalized_unit = _normalized_price(price, measurement, package_quantity)

    store_name = source.get("store")
    retailer = source.get("retailer")
    if not retailer and "harris teeter" in str(store_name or "").lower():
        retailer = "Harris Teeter"

    return {
        "product_id": source.get("product_id"),
        "catalog_id": source.get("catalog_id"),
        "upc": upc,
        "product_name": source.get("product_name"),
        "brand": source.get("brand"),
        "category": source.get("food_category") or source.get("category"),
        "food_profile": source.get("food_profile"),
        "retailer": retailer,
        "store_id": source.get("store_id") or source.get("location_id"),
        "store_name": store_name,
        "price": price if price is not None and price > 0 else None,
        "regular_price": regular_price,
        "sale_price": sale_price,
        "package_size_text": package_text,
        "package_size": measurement["amount"] if measurement else None,
        "package_unit": measurement["unit"] if measurement else None,
        "measurement_dimension": measurement["dimension"] if measurement else "unknown",
        "package_quantity": package_quantity if package_quantity is not None and package_quantity > 0 else None,
        "normalized_unit_price": normalized_price,
        "normalized_unit": normalized_unit,
        "normalization_method": method,
        "normalization_confidence": confidence,
        "price_date": source.get("date_checked") or source.get("price_checked"),
        "source": source.get("price_source") or source.get("source"),
    }


def load_normalized_prices(path: str | Path = DEFAULT_NORMALIZED_PRICES) -> list[dict]:
    """Load normalized price records without changing the stored dataset."""
    with Path(path).open(encoding="utf-8") as stream:
        records = json.load(stream)
    if not isinstance(records, list) or any(not isinstance(record, dict) for record in records):
        raise ValueError("Normalized price data must be a JSON list of objects.")
    return records


def get_price_record(product_id: str, records: list[dict]) -> dict | None:
    """Find a record by product ID or UPC while preserving string identifiers."""
    identifier = str(product_id)
    return next(
        (
            record for record in records
            if str(record.get("product_id")) == identifier or str(record.get("upc")) == identifier
        ),
        None,
    )


def _product_form(record: dict) -> str:
    """Classify only obvious form conflicts; this does not establish similarity."""
    text = re.sub(r"[^a-z0-9]+", " ", str(record.get("product_name") or "").lower())
    word_groups = (
        ("powdered", {"powder", "powdered", "dehydrated"}),
        ("beverage", {"drink", "juice", "smoothie", "beverage"}),
        ("prepared", {
            "bowl", "meal", "dinner", "entree", "soup", "salad", "pizza", "skewer",
            "shells", "chips", "cookie", "cookies", "pie", "pies", "bar", "bars",
        }),
        ("cooked", {"cooked", "microwave", "ready"}),
        ("dry", {"dry", "dried", "uncooked"}),
        ("raw", {"raw"}),
    )
    words = set(text.split())
    for form, markers in word_groups:
        if words & markers:
            return form
    return "standard"


def _usable_for_comparison(record: dict) -> bool:
    normalized_price = _number(record.get("normalized_unit_price"))
    return (
        normalized_price is not None
        and normalized_price > 0
        and record.get("normalization_confidence") in ACCEPTABLE_CONFIDENCE
        and record.get("measurement_dimension") in {"mass", "volume", "count"}
        and bool(record.get("normalized_unit"))
    )


def _same_verified_store(original: dict, candidate: dict) -> bool:
    retailer = original.get("retailer")
    store_id = original.get("store_id")
    return bool(
        retailer and store_id
        and retailer == candidate.get("retailer")
        and store_id == candidate.get("store_id")
    )


def find_cheaper_alternatives(
    product_id: str,
    records: list[dict],
    eligible_product_ids: set[str] | None = None,
    limit: int = 5,
) -> list[dict]:
    """Return conservative, normalized-unit cheaper options at the same store."""
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
        raise ValueError("Limit must be a non-negative whole number.")
    original = get_price_record(str(product_id), records)
    if original is None or not _usable_for_comparison(original) or limit == 0:
        return []

    original_id = str(original.get("product_id"))
    original_unit_price = float(original["normalized_unit_price"])
    eligible = None if eligible_product_ids is None else {str(identifier) for identifier in eligible_product_ids}
    alternatives = []

    for candidate in records:
        candidate_id = str(candidate.get("product_id"))
        if candidate_id == original_id:
            continue
        if eligible is not None and candidate_id not in eligible:
            continue
        if not _same_verified_store(original, candidate) or not _usable_for_comparison(candidate):
            continue
        if not original.get("food_profile") or original.get("food_profile") != candidate.get("food_profile"):
            continue
        if not original.get("category") or original.get("category") != candidate.get("category"):
            continue
        if not dimensions_compatible(
            original.get("measurement_dimension"), candidate.get("measurement_dimension")
        ):
            continue
        if original.get("normalized_unit") != candidate.get("normalized_unit"):
            continue
        if _product_form(original) != _product_form(candidate):
            continue

        candidate_unit_price = float(candidate["normalized_unit_price"])
        if candidate_unit_price >= original_unit_price:
            continue
        unit_savings = original_unit_price - candidate_unit_price
        confidence = (
            "high"
            if original.get("normalization_confidence") == candidate.get("normalization_confidence") == "high"
            else "medium"
        )
        alternatives.append({
            "original_product_id": original_id,
            "alternative_product_id": candidate_id,
            "alternative_product_name": candidate.get("product_name"),
            "brand": candidate.get("brand"),
            "retailer": candidate.get("retailer"),
            "store_id": candidate.get("store_id"),
            "original_price": original.get("price"),
            "alternative_price": candidate.get("price"),
            "original_normalized_unit_price": original_unit_price,
            "alternative_normalized_unit_price": candidate_unit_price,
            "normalized_unit": candidate.get("normalized_unit"),
            "unit_savings": round(unit_savings, 4),
            "unit_savings_percent": round(unit_savings / original_unit_price * 100, 1),
            "normalization_confidence": confidence,
            "price_date": candidate.get("price_date"),
            "recommendation_type": "Cheaper comparable option at this store",
        })

    confidence_order = {"high": 0, "medium": 1}
    alternatives.sort(key=lambda item: (
        confidence_order[item["normalization_confidence"]],
        item["alternative_normalized_unit_price"],
        str(item["alternative_product_name"] or ""),
    ))
    return alternatives[:limit]


def _positive_price(value: Any) -> float | None:
    """Return a finite positive price, excluding booleans and invalid values."""
    number = _number(value)
    return number if number is not None and number > 0 else None


def fetch_kroger_product_observation(
    upc: str,
    location_id: str,
    access_token: str,
    request_get: Callable[..., Any] = requests.get,
) -> dict | None:
    """Fetch one exact-UPC Kroger observation using an existing access token."""
    requested_upc = str(upc)
    requested_location_id = str(location_id)
    response = request_get(
        KROGER_PRODUCTS_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
        },
        params={
            "filter.productId": requested_upc,
            "filter.locationId": requested_location_id,
            "filter.limit": 10,
        },
        timeout=30,
    )
    response.raise_for_status()
    for product in response.json().get("data", []):
        returned_upc = product.get("upc") or product.get("productId")
        if returned_upc is None or str(returned_upc) != requested_upc:
            continue
        for item in product.get("items", []):
            price = item.get("price") or {}
            regular = _positive_price(price.get("regular"))
            promotional = _positive_price(price.get("promo"))
            return {
                "product_id": str(product.get("productId") or requested_upc),
                "upc": requested_upc,
                "product_name": product.get("description"),
                "package_size": item.get("size"),
                "regular_price": regular,
                "promotional_price": promotional,
                "effective_price": promotional if promotional is not None else regular,
                "location_id": requested_location_id,
            }
    return None


def compare_exact_product_prices(
    upc: str,
    stores: list[dict],
    fetch_observation: Callable[[str, str], dict | None],
) -> dict:
    """Compare an exact UPC/package across explicit stores without mutating input."""
    requested_upc = str(upc)
    observations: list[dict] = []
    exclusions: list[dict] = []
    accepted_sources: list[dict] = []
    seen_locations: set[str] = set()
    reference_size = None

    for store in stores:
        location_id = str(store.get("location_id"))
        store_name = store.get("store_name")
        if location_id in seen_locations:
            exclusions.append({"location_id": location_id, "store_name": store_name,
                               "reason": "duplicate_location_id"})
            continue
        seen_locations.add(location_id)
        try:
            source = fetch_observation(requested_upc, location_id)
        except Exception as error:
            exclusions.append({"location_id": location_id, "store_name": store_name,
                               "reason": "api_request_failed",
                               "error_type": type(error).__name__})
            continue
        if not source:
            exclusions.append({"location_id": location_id, "store_name": store_name,
                               "reason": "product_not_returned"})
            continue
        returned_upc = source.get("upc")
        if returned_upc is None or str(returned_upc) != requested_upc:
            exclusions.append({"location_id": location_id, "store_name": store_name,
                               "reason": "upc_mismatch",
                               "returned_upc": None if returned_upc is None else str(returned_upc)})
            continue
        returned_location = str(source.get("location_id"))
        if returned_location != location_id:
            exclusions.append({"location_id": location_id, "store_name": store_name,
                               "reason": "location_id_mismatch",
                               "returned_location_id": returned_location})
            continue
        package_size = normalize_package_size(source.get("package_size"))
        if package_size is None or not str(package_size).strip():
            exclusions.append({"location_id": location_id, "store_name": store_name,
                               "reason": "missing_package_size"})
            continue
        if not accepted_sources:
            reference_size = package_size
        elif package_size != reference_size:
            exclusions.append({"location_id": location_id, "store_name": store_name,
                               "reason": "package_size_mismatch", "package_size": package_size,
                               "expected_package_size": reference_size})
            continue
        effective = _positive_price(source.get("effective_price"))
        if effective is None:
            exclusions.append({"location_id": location_id, "store_name": store_name,
                               "reason": "invalid_effective_price"})
            continue
        accepted_sources.append(source)
        observations.append({
            "location_id": location_id,
            "store_name": store_name,
            "regular_price": _positive_price(source.get("regular_price")),
            "promotional_price": _positive_price(source.get("promotional_price")),
            "effective_price": effective,
        })

    comparable = len(observations) >= 2
    prices = [item["effective_price"] for item in observations]
    lowest = min(prices) if comparable else None
    highest = max(prices) if comparable else None
    if not comparable:
        status, lowest_locations = "insufficient_comparable_data", []
    elif math.isclose(lowest, highest, rel_tol=0, abs_tol=1e-9):
        status = "same_at_all_stores"
        lowest_locations = [item["location_id"] for item in observations]
    else:
        status = "lower_price_found"
        lowest_locations = [item["location_id"] for item in observations
                            if math.isclose(item["effective_price"], lowest,
                                            rel_tol=0, abs_tol=1e-9)]

    first = accepted_sources[0] if accepted_sources else {}
    return {
        "product_id": str(first.get("product_id") or requested_upc),
        "upc": requested_upc,
        "product_name": first.get("product_name"),
        "package_size": reference_size,
        "observations": observations,
        "excluded_observations": exclusions,
        "stores_compared": len(observations),
        "lowest_observed_price": lowest,
        "highest_observed_price": highest,
        "observed_price_difference": round(highest - lowest, 2) if comparable else None,
        "lowest_price_location_ids": lowest_locations,
        "price_status": status,
        "price_description": "Observed API price among tested stores",
    }


def compare_kroger_store_prices(
    upc: str,
    stores: list[dict],
    access_token: str,
    request_get: Callable[..., Any] = requests.get,
) -> dict:
    """Retrieve and compare exact Kroger UPC observations across stores."""
    def fetch(requested_upc: str, location_id: str) -> dict | None:
        return fetch_kroger_product_observation(
            requested_upc, location_id, access_token, request_get=request_get
        )
    return compare_exact_product_prices(upc, stores, fetch)
