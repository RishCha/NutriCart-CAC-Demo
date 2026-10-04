"""Post-optimization comparison of the same exact basket across stores."""

import math
from typing import Any, Callable

from price_comparison import (
    compare_exact_product_prices,
    fetch_kroger_product_observation,
)


def _valid_quantity(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        quantity = float(value)
    except (TypeError, ValueError):
        return None
    return quantity if math.isfinite(quantity) and quantity > 0 else None


def compare_basket_prices(
    grocery_plan: list[dict],
    stores: list[dict],
    fetch_observation: Callable[[str, str], dict | None],
    reference_location_id: str | None = None,
) -> dict:
    """Compare unchanged UPCs and quantities across explicitly supplied stores."""
    store_results = []
    by_location = {}
    for store in stores:
        location_id = str(store.get("location_id"))
        if location_id in by_location:
            continue
        result = {
            "location_id": location_id,
            "store_name": store.get("store_name"),
            "items_requested": len(grocery_plan),
            "items_priced": 0,
            "items_missing": len(grocery_plan),
            "coverage_percent": 0.0,
            "observed_basket_total": 0.0,
            "complete": False,
            "items": [],
        }
        by_location[location_id] = result
        store_results.append(result)

    comparison_stores = [
        {"location_id": result["location_id"], "store_name": result["store_name"]}
        for result in store_results
    ]
    for grocery in grocery_plan:
        product_value = grocery.get("product_id")
        product_id = None if product_value is None else str(product_value)
        quantity = _valid_quantity(grocery.get("quantity"))
        if not product_id or quantity is None:
            reason = "missing_product_id" if not product_id else "invalid_quantity"
            for store_result in store_results:
                store_result["items"].append({
                    "product_id": product_id,
                    "quantity": grocery.get("quantity"),
                    "effective_price": None,
                    "item_total": None,
                    "status": "unavailable",
                    "reason": reason,
                })
            continue

        item_comparison = compare_exact_product_prices(
            product_id, comparison_stores, fetch_observation
        )
        observations = {
            item["location_id"]: item for item in item_comparison["observations"]
        }
        exclusions = {
            item["location_id"]: item for item in item_comparison["excluded_observations"]
        }
        for store_result in store_results:
            location_id = store_result["location_id"]
            observed = observations.get(location_id)
            if observed:
                item_total = round(observed["effective_price"] * quantity, 2)
                store_result["items"].append({
                    "product_id": product_id,
                    "quantity": quantity,
                    "regular_price": observed.get("regular_price"),
                    "promotional_price": observed.get("promotional_price"),
                    "effective_price": observed["effective_price"],
                    "item_total": item_total,
                    "status": "priced",
                })
                store_result["items_priced"] += 1
                store_result["observed_basket_total"] = round(
                    store_result["observed_basket_total"] + item_total, 2
                )
            else:
                excluded = exclusions.get(location_id, {})
                detail = {
                    "product_id": product_id,
                    "quantity": quantity,
                    "effective_price": None,
                    "item_total": None,
                    "status": "unavailable",
                    "reason": excluded.get("reason", "no_comparable_observation"),
                }
                for field in ("package_size", "expected_package_size", "error_type"):
                    if field in excluded:
                        detail[field] = excluded[field]
                store_result["items"].append(detail)

    requested = len(grocery_plan)
    for result in store_results:
        result["items_missing"] = requested - result["items_priced"]
        result["coverage_percent"] = (
            round(result["items_priced"] / requested * 100, 1) if requested else 100.0
        )
        result["complete"] = result["items_priced"] == requested

    complete = [result for result in store_results if result["complete"]]
    totals = [result["observed_basket_total"] for result in complete]
    if len(complete) < 2:
        lowest = highest = difference = None
        lowest_ids = []
        status = "insufficient_complete_store_data"
    else:
        lowest, highest = min(totals), max(totals)
        difference = round(highest - lowest, 2)
        lowest_ids = [
            result["location_id"] for result in complete
            if math.isclose(result["observed_basket_total"], lowest,
                            rel_tol=0, abs_tol=1e-9)
        ]
        status = (
            "same_at_all_complete_stores"
            if math.isclose(lowest, highest, rel_tol=0, abs_tol=1e-9)
            else "lower_basket_price_found"
        )

    reference_id = None if reference_location_id is None else str(reference_location_id)
    reference = by_location.get(reference_id) if reference_id is not None else None
    reference_total = (
        reference["observed_basket_total"] if reference and reference["complete"] else None
    )
    reference_difference = (
        round(reference_total - lowest, 2)
        if reference_total is not None and lowest is not None else None
    )
    return {
        "stores": store_results,
        "complete_stores_compared": len(complete),
        "lowest_observed_basket_total": lowest,
        "lowest_price_location_ids": lowest_ids,
        "highest_observed_basket_total": highest,
        "observed_basket_difference": difference,
        "basket_price_status": status,
        "reference_location_id": reference_id,
        "reference_store_total": reference_total,
        "difference_from_reference": reference_difference,
        "price_description": "Potential difference based on observed API prices.",
    }


def compare_kroger_basket_prices(
    grocery_plan: list[dict],
    stores: list[dict],
    access_token: str,
    reference_location_id: str | None = None,
    request_get: Callable[..., Any] | None = None,
) -> dict:
    """Compare a basket using the existing exact Kroger observation parser."""
    def fetch(upc: str, location_id: str) -> dict | None:
        kwargs = {} if request_get is None else {"request_get": request_get}
        return fetch_kroger_product_observation(
            upc, location_id, access_token, **kwargs
        )

    return compare_basket_prices(
        grocery_plan, stores, fetch, reference_location_id=reference_location_id
    )
