"""Local, reviewed retailer identity and USDA-type planning policy; no network calls."""

from functools import lru_cache
import json
from pathlib import Path
import re

POLICY_PATH = Path(__file__).resolve().parent / "data" / "retailers" / "verified_identities.json"
UNRESOLVED_NAME = "Store name unavailable"
LIMITED_MESSAGE = "This SNAP retailer may not carry the foods needed for a complete household grocery plan. Store-specific inventory is not available."
UNKNOWN_MESSAGE = "This retailer's grocery assortment is unknown. Store-specific inventory is not available."


@lru_cache(maxsize=1)
def retailer_policy():
    # Missing/corrupt policy must not silently enable planning or invent identities.
    try:
        policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
        if policy.get("schema_version") == 1 and isinstance(policy.get("categories"), dict) and isinstance(policy.get("identities"), list):
            return policy
    except (OSError, ValueError, AttributeError):
        pass
    return {"schema_version": 1, "categories": {}, "identities": [], "address_aliases": {}}


def normalized_name(value):
    name = " ".join(str(value or "").split())
    if (not name or not any(c.isalpha() for c in name)
            or name.casefold() in {"snap retailer", "snap-authorized retailer", UNRESOLVED_NAME.casefold()}):
        return None
    identified = re.fullmatch(r"(.+?\S)\s+#\s*([A-Za-z0-9-]+)(?:\s+\2)*", name, re.I)
    numbered = re.fullmatch(r"(.+?\S)\s+(\d{3,}[A-Za-z]?)(?:\s+\2)*", name, re.I)
    match = identified or numbered
    if match and any(c.isalpha() for c in match.group(1)):
        name = match.group(1).strip()
    if name.islower() or name.isupper():
        name = name.title()
        for acronym in ("CVS", "IGA", "USA"):
            name = re.sub(rf"\b{acronym.title()}\b", acronym, name)
    return name


def _address(value, aliases):
    words = re.sub(r"[^a-z0-9 ]", " ", str(value or "").casefold()).split()
    return " ".join(aliases.get(word, word) for word in words)


def _record_id(value):
    return re.sub(r"\.0$", "", str(value or "").strip())


def resolve_retailer(store, policy=None):
    policy = retailer_policy() if policy is None else policy
    for field, source in (("store_name", "usda"), ("source_name", "usda"), ("display_name", "normalized"), ("name", "normalized")):
        name = normalized_name(store.get(field))
        if name:
            return {"display_name": name, "name_resolution": {"source": source}}
    aliases = policy.get("address_aliases", {})
    candidates = []
    for entry in policy.get("identities", []):
        # Require the ID AND complete address. Coordinates and proximity never participate.
        if not _record_id(store.get("record_id")) or _record_id(store.get("record_id")) != _record_id(entry.get("record_id")):
            continue
        if not all(store.get(key) and entry.get(key) for key in ("street_address", "city", "zip_code")):
            continue
        if not (store.get("state") or store.get("region")):
            continue
        checks = [(store.get(k), entry.get(k)) for k in ("street_address", "additional_address", "city")]
        checks.append((store.get("state") or store.get("region"), entry.get("state")))
        if any(_address(a, aliases) != _address(b, aliases) for a, b in checks):
            continue
        if not re.fullmatch(r"\d{5}(?:-\d{4})?", str(store.get("zip_code"))) or str(store["zip_code"])[:5] != str(entry.get("zip_code", ""))[:5]:
            continue
        if (normalized_name(entry.get("display_name")) and str(entry.get("source_url", "")).startswith("https://")
                and entry.get("verification_date") and entry.get("source_type")):
            candidates.append(entry)
    if len(candidates) == 1:
        entry = candidates[0]
        return {"display_name": entry["display_name"], "name_resolution": {key: entry[key] for key in ("source_url", "verification_date", "source_type")} | {"source": "verified_mapping"}}
    return {"display_name": UNRESOLVED_NAME, "name_resolution": {"source": "unresolved"}}


def planning_suitability(store_type, policy=None):
    policy = retailer_policy() if policy is None else policy
    value = " ".join(str(store_type or "").replace("\u2013", "-").replace("\u2019", "'").casefold().split())
    for key, category in policy.get("categories", {}).items():
        if value and value in {str(t).casefold() for t in category.get("types", [])}:
            return {"category": key, "label": category["label"]}
    return {"category": "unknown", "label": "Unknown assortment"}


def planning_allowed(store):
    if not isinstance(store, dict):
        return False
    category = planning_suitability(store.get("store_type"))["category"]
    return category == "full" or (category == "unknown" and store.get("illustrative_plan_acknowledged") is True)


def enrich_retailer(store):
    return {**store, **resolve_retailer(store), "planning_suitability": planning_suitability(store.get("store_type"))}
