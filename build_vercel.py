"""Publish only reviewed UI assets, keeping existing /static/ URLs on Vercel."""

from pathlib import Path
import shutil
import json


ROOT = Path(__file__).resolve().parent
ASSETS = (
    "account.js", "app.js", "budget_tracker.js", "cursor_effects.js", "grocery.js",
    "meal_plan.js", "password_fields.js", "price_comparison.js", "reset_password.js",
    "settings.js", "styles.css", "images/usda-snap-logo.png",
)


def build_assets(root=ROOT):
    root = Path(root)
    for name in ASSETS:
        source = root / "static" / name
        target = root / "public" / "static" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)


if __name__ == "__main__":
    # Fail the build if the independent runtime data is absent or misidentified.
    for name in ("food_catalog.json", "price_records.json"):
        records = json.loads((ROOT / "data" / "demo" / name).read_text(encoding="utf-8"))
        if not records or any(not row.get("price_is_synthetic") or not str(row.get("product_id", "")).startswith("demo-") for row in records):
            raise ValueError("Deployment requires the independent demonstration catalog.")
    build_assets()
