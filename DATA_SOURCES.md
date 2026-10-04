# Public data sources

The 33 examples in data/demo/food_catalog.json were independently assembled from USDA FoodData Central SR Legacy April 2018. FDC identifiers, exact descriptions, source URLs, per-100-g values, preparation states, and the source archive SHA-256 are retained in data/demo/usda_source_records.json. The nutrition data is public domain/CC0: https://fdc.nal.usda.gov/api-guide/

Package masses and prices are independently authored synthetic examples. data/demo/price_records.json contains their calculated unit prices. Neither catalog contains retailer IDs, UPCs, brands, stores, or observed prices. No Kroger-derived or Open Food Facts records are included. See data/demo/README.md. build_demo_catalog.py is the reviewed reproducibility tool; it reads only the official USDA archive.

USDA SNAP retailer lookup supplies authorization records, separate from example groceries. Census Geocoder resolves submitted addresses. OpenStreetMap/Nominatim may resolve device coordinates for approximate address autofill. These services are not catalog sources and have their own terms and availability limits. OpenStreetMap attribution: https://www.openstreetmap.org/copyright

The USDA SNAP logo is a separate service mark, not licensed by the nutrition CC0 terms. The acknowledgement and non-endorsement statement are retained. Confirm intended noncommercial educational/outreach use and graphic requirements before publication: https://www.fns.usda.gov/snap/logo-guidance
