"""Conservative planning coverage; SNAP authorization is never inventory evidence."""

import re
from catalog_config import demo_catalog_enabled


# The current catalog is a single-store snapshot. No geographic inventory or
# local-price coverage is established, including elsewhere in the same state.
GENERAL_CATALOG = {
    "mode": "general",
    "local_availability_verified": False,
    "price_basis": "General planning estimates from observed prices; local prices and availability are unverified.",
}
if demo_catalog_enabled():
    GENERAL_CATALOG.update(
        price_basis="Example grocery prices for planning. Actual store prices may differ.",
        synthetic_prices=True,
        source="Independent NutriCart examples with USDA FoodData Central CC0 nutrition",
    )
PRIVATE_LABELS = re.compile(
    r"\b(?:harris\s+teeter|ht\s+traders|simple\s+truth|private\s+selection|kroger|highland\s+crest)\b",
    re.I,
)


def planning_candidates(catalog):
    """Exclude store-exclusive identities before feasibility and optimization.

    Preserve the remaining observed products, prices, units and nutrition. Do
    not turn a store-brand observation into a fabricated generic product.
    """
    return [product for product in catalog if not PRIVATE_LABELS.search(
        f"{product.get('brand') or ''} {product.get('product_name') or ''}"
    )]


def planning_location(value):
    """Keep only coarse locality/region context, never addresses or coordinates."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {"locality", "region"}:
        raise ValueError("Planning location must contain only a locality and region.")
    result = {}
    for key in ("locality", "region"):
        text = value.get(key, "")
        if not isinstance(text, str) or len(text) > 100 or any(c.isdigit() for c in text):
            raise ValueError("Planning location must contain only a locality and region.")
        result[key] = " ".join(text.split())
    if not any(result.values()):
        raise ValueError("Choose a planning location.")
    return result


_STATE_NAMES = "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|District of Columbia|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|Puerto Rico"
_STATE_CODES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR"
_REGIONS = dict(zip(_STATE_NAMES.casefold().split("|"), _STATE_CODES.split()))
_REGIONS.update({code.casefold(): code for code in _STATE_CODES.split()})


def location_from_address(address):
    """Extract only explicit locality/region text from a provider's address.

    Never infer a locality from a street, coordinates, or nearby retailer. A
    missing/unrecognized region leaves the planning location unresolved.
    """
    if not isinstance(address, str):
        return None
    parts = [part.strip() for part in address.split(",") if part.strip()]
    for index in range(len(parts) - 1, -1, -1):
        part = re.sub(r"\s*\b\d{5}(?:-\d{4})?\b", "", parts[index]).strip()
        region = _REGIONS.get(part.casefold())
        if not region:
            continue
        locality_index = index - 1
        if locality_index > 0 and re.search(r"\bcounty$", parts[locality_index], re.I):
            locality_index -= 1
        locality = parts[locality_index] if locality_index >= 1 else ""
        # Approximate addresses may contain only a road and a region.
        if re.search(r"\d|\b(?:street|road|drive|parkway|avenue|highway|lane|blvd|st|rd|dr|ave)\b", locality, re.I):
            locality = ""
        return {"locality": locality, "region": region}
    return None
