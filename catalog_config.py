"""Independent public release: demo-only, without a private-data fallback."""
from pathlib import Path
ROOT = Path(__file__).resolve().parent

def demo_catalog_enabled():
    return True

def catalog_path(kind):
    return ROOT / "data" / "demo" / {"food": "food_catalog.json", "prices": "price_records.json"}[kind]
