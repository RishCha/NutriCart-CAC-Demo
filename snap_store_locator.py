"""Optional lookup of nearby USDA SNAP-authorized retailers."""

import json
import math
import socket
import urllib.error
import urllib.parse
import urllib.request

from retailer_policy import UNRESOLVED_NAME, enrich_retailer, normalized_name


SNAP_QUERY_URL = (
    "https://services1.arcgis.com/RLQu0rK7h4kbsBq5/ArcGIS/rest/services/"
    "snap_retailer_location_data/FeatureServer/0/query"
)
CENSUS_GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
SNAP_OUT_FIELDS = (
    "Record_ID,Store_Name,Store_Street_Address,Additonal_Address,City,State,"
    "Zip_Code,County,Store_Type,Latitude,Longitude,Incentive_Program,Grantee_Name,ObjectId"
)
PAGE_SIZE = 100
SAFETY_CAP = 5000


class _StoreResults(list):
    """List carrying only non-location lookup status for display."""

    safety_cap_reached = False


def request_json(url: str, parameters: dict, timeout: float = 10.0) -> dict:
    """Make a GET request and return a JSON object with privacy-safe errors."""
    query_url = f"{url}?{urllib.parse.urlencode(parameters)}"
    request = urllib.request.Request(
        query_url,
        headers={"User-Agent": "NutriCart-SNAP-Retailer-Locator/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except (TimeoutError, socket.timeout) as error:
        raise RuntimeError("The location service timed out. Please try again later.") from error
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"The location service returned HTTP error {error.code}.") from error
    except urllib.error.URLError as error:
        if isinstance(error.reason, (TimeoutError, socket.timeout)):
            raise RuntimeError("The location service timed out. Please try again later.") from error
        raise RuntimeError("The location service could not be reached. Please check your connection.") from error
    except UnicodeDecodeError as error:
        raise RuntimeError("The location service returned unreadable data.") from error
    try:
        result = json.loads(body)
    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError("The location service returned invalid JSON.") from error
    if not isinstance(result, dict):
        raise RuntimeError("The location service returned an unexpected response format.")
    return result


def _coordinate(value: object, name: str, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be a number from {minimum:g} to {maximum:g}.") from error
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise ValueError(f"{name} must be from {minimum:g} to {maximum:g}.")
    return number


def geocode_address(address: str) -> tuple[float, float, str]:
    """Resolve an address using the U.S. Census single-address geocoder."""
    if not address or not address.strip():
        raise ValueError("Please enter a complete street address.")
    response = request_json(CENSUS_GEOCODER_URL, {
        "address": address.strip(), "benchmark": "Public_AR_Current", "format": "json",
    })
    matches = response.get("result", {}).get("addressMatches", [])
    if not isinstance(matches, list) or not matches:
        raise ValueError("No matching address was found. Check the address and try again.")
    match = matches[0]
    try:
        coordinates = match["coordinates"]
        longitude = _coordinate(coordinates["x"], "Longitude", -180, 180)
        latitude = _coordinate(coordinates["y"], "Latitude", -90, 90)
        matched_address = str(match["matchedAddress"]).strip()
    except (KeyError, TypeError) as error:
        raise RuntimeError("The Census Geocoder returned an incomplete address match.") from error
    if not matched_address:
        raise RuntimeError("The Census Geocoder returned an incomplete address match.")
    return latitude, longitude, matched_address


def haversine_miles(
    latitude1: float, longitude1: float, latitude2: float, longitude2: float
) -> float:
    """Return straight-line distance between two points in statute miles."""
    lat1, lon1, lat2, lon2 = map(math.radians, (latitude1, longitude1, latitude2, longitude2))
    latitude_delta = lat2 - lat1
    longitude_delta = lon2 - lon1
    a = math.sin(latitude_delta / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(longitude_delta / 2) ** 2
    return max(0.0, 2 * 3958.7613 * math.asin(math.sqrt(min(1.0, a))))


def _normalized(value: object) -> str:
    return " ".join(str(value or "").casefold().split())


def retailer_display_name(source_name: object) -> str:
    """Readable source-only label; full identity matching uses complete retailer records."""
    return normalized_name(source_name) or UNRESOLVED_NAME


def find_snap_retailers(
    latitude: float, longitude: float, radius_miles: float = 5.0
) -> list[dict]:
    """Return nearby authorized retailers, independently verified by distance."""
    latitude = _coordinate(latitude, "Latitude", -90, 90)
    longitude = _coordinate(longitude, "Longitude", -180, 180)
    try:
        radius_miles = float(radius_miles)
    except (TypeError, ValueError) as error:
        raise ValueError("Radius must be a positive number.") from error
    if not math.isfinite(radius_miles) or radius_miles <= 0:
        raise ValueError("Radius must be a positive number.")
    base_parameters = {
        "where": "1=1", "geometry": f"{longitude},{latitude}",
        "geometryType": "esriGeometryPoint", "inSR": 4326, "distance": radius_miles,
        "units": "esriSRUnit_StatuteMile", "spatialRel": "esriSpatialRelIntersects",
        "outFields": SNAP_OUT_FIELDS, "returnGeometry": "false",
        "f": "json",
    }
    stores = _StoreResults()
    seen = set()
    retrieved = 0
    while retrieved < SAFETY_CAP:
        page_size = min(PAGE_SIZE, SAFETY_CAP - retrieved)
        parameters = dict(base_parameters, resultOffset=retrieved, resultRecordCount=page_size)
        response = request_json(SNAP_QUERY_URL, parameters)
        if "error" in response:
            error = response["error"]
            message = error.get("message") if isinstance(error, dict) else None
            raise RuntimeError(f"The SNAP retailer service reported an error{': ' + message if message else '.'}")
        features = response.get("features", [])
        if not isinstance(features, list):
            raise RuntimeError("The SNAP retailer service returned an unexpected response format.")
        if not features:
            break
        retrieved += len(features)
        for feature in features:
            attributes = feature.get("attributes", {}) if isinstance(feature, dict) else {}
            try:
                store_latitude = _coordinate(attributes.get("Latitude"), "Latitude", -90, 90)
                store_longitude = _coordinate(attributes.get("Longitude"), "Longitude", -180, 180)
            except ValueError:
                continue
            distance = haversine_miles(latitude, longitude, store_latitude, store_longitude)
            if distance > radius_miles:
                continue
            record_id = attributes.get("Record_ID")
            if record_id is not None and str(record_id).strip():
                identity = ("record", _normalized(record_id))
            else:
                full_address = " ".join(str(attributes.get(key) or "") for key in (
                    "Store_Street_Address", "Additonal_Address", "City", "State", "Zip_Code"
                ))
                identity = ("fallback", _normalized(attributes.get("Store_Name")), _normalized(full_address))
            if identity in seen:
                continue
            seen.add(identity)
            source_name = attributes.get("Store_Name") or ""
            stores.append(enrich_retailer({
                "record_id": record_id, "store_name": source_name,
                "display_name": retailer_display_name(source_name),
                "street_address": attributes.get("Store_Street_Address") or "",
                "additional_address": attributes.get("Additonal_Address") or "",
                "city": attributes.get("City") or "", "state": attributes.get("State") or "",
                "zip_code": attributes.get("Zip_Code") or "", "county": attributes.get("County") or "",
                "store_type": attributes.get("Store_Type") or "Not listed", "latitude": store_latitude,
                "longitude": store_longitude, "distance_miles": distance,
                "incentive_program": attributes.get("Incentive_Program") or "",
                "grantee_name": attributes.get("Grantee_Name") or "",
            }))
        if response.get("exceededTransferLimit") is False:
            break
    if retrieved >= SAFETY_CAP:
        stores.safety_cap_reached = True
    stores.sort(key=lambda store: store["distance_miles"])
    return stores


def display_snap_retailers(stores: list[dict]) -> str:
    print("\n==================================================")
    print("NEARBY SNAP-AUTHORIZED RETAILERS")
    print("==================================================\n")
    if not stores:
        print("No SNAP-authorized retailers were found within the selected radius.")
        print("Try a larger search radius or check the location.")
        return "continue"
    if getattr(stores, "safety_cap_reached", False):
        print("The search returned a very large number of stores. Showing the nearest")
        print("available results. Use a smaller radius for a more focused search.\n")
    start = 0
    while True:
        for number, store in enumerate(stores[start:start + 10], start + 1):
            address_parts = [store.get("street_address"), store.get("additional_address"), store.get("city")]
            state_zip = " ".join(filter(None, (str(store.get("state") or ""), str(store.get("zip_code") or ""))))
            if state_zip:
                address_parts.append(state_zip)
            print(f"{number}. {store.get('display_name') or retailer_display_name(store.get('store_name'))}")
            print(f"   Store type: {store.get('store_type') or 'Not listed'}")
            print(f"   Distance: {store.get('distance_miles', 0):.1f} miles")
            print(f"   Address: {', '.join(str(part) for part in address_parts if part)}")
            print(f"   Healthy incentive: {store.get('incentive_program') or 'Not listed'}")
        start += 10
        more = start < len(stores)
        print("\n[M] Show more" if more else "")
        print("[N] Start a new store search")
        print("[C] Continue to grocery planning")
        while True:
            choice = input("Choose: ").strip().lower()
            if choice in ({"m", "n", "c"} if more else {"n", "c"}):
                break
            print("Choose " + ("M, N, or C." if more else "N or C."))
        if choice == "m":
            continue
        return "new" if choice == "n" else "continue"


def _prompt_positive_radius(prompt: str, default: float = 5.0) -> float:
    while True:
        raw = input(prompt).strip()
        if not raw:
            return default
        try:
            value = float(raw)
        except ValueError:
            print("Please enter a valid number.")
            continue
        if math.isfinite(value) and value > 0:
            return value
        print("Enter a radius greater than zero.")


def run_snap_store_lookup() -> None:
    """Run the optional, failure-isolated command-line retailer lookup."""
    while True:
        print("\n==================================================")
        print("FIND SNAP-AUTHORIZED STORES")
        print("==================================================\n")
        print("Location is used only to search for nearby SNAP-authorized")
        print("retailers. NutriCart does not save your address or coordinates.\n")
        print("  1. Enter a street address\n  2. Enter latitude and longitude\n  3. Skip store lookup\n")
        while True:
            choice = input("Choose [1-3]: ").strip()
            if choice in {"1", "2", "3"}:
                break
            print("Choose 1, 2, or 3.")
        if choice == "3":
            return
        try:
            if choice == "1":
                print("\nThe address will be sent to the U.S. Census Geocoder to obtain coordinates.")
                address = input("Complete street address: ")
                latitude, longitude, matched_address = geocode_address(address)
                address = ""
                print(f"Matched address: {matched_address}")
            else:
                while True:
                    try:
                        latitude = _coordinate(input("Latitude [-90 to 90]: ").strip(), "Latitude", -90, 90)
                        break
                    except ValueError as error:
                        print(error)
                while True:
                    try:
                        longitude = _coordinate(input("Longitude [-180 to 180]: ").strip(), "Longitude", -180, 180)
                        break
                    except ValueError as error:
                        print(error)
            radius = _prompt_positive_radius("Search radius in miles [default 5]: ")
            action = display_snap_retailers(find_snap_retailers(latitude, longitude, radius))
            if action != "new":
                return
        except (RuntimeError, ValueError) as error:
            print(f"Store lookup unavailable: {error}")
            return
