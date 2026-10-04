"""Canonical package-size text shared by catalog and price ingestion."""

import re
from typing import Any


_OUNCE_CODE = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s*onz\b", re.IGNORECASE)


def normalize_package_size(value: Any) -> str:
    """Normalize the retailer ONZ mass-unit code without changing amounts or other units."""
    text = str(value or "").strip()
    return _OUNCE_CODE.sub(r"\1 oz", text)
