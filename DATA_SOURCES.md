# Public data sources

The 33 examples in data/demo/food_catalog.json were independently assembled from USDA FoodData Central SR Legacy April 2018. FDC identifiers, exact descriptions, source URLs, per-100-g values, preparation states, and the source archive SHA-256 are retained in data/demo/usda_source_records.json. The nutrition data is public domain/CC0: https://fdc.nal.usda.gov/api-guide/

Package masses and prices are independently authored synthetic examples. data/demo/price_records.json contains their calculated unit prices. Neither catalog contains retailer IDs, UPCs, brands, stores, or observed prices. No Kroger-derived or Open Food Facts records are included. See data/demo/README.md. build_demo_catalog.py is the reviewed reproducibility tool; it reads only the official USDA archive.

USDA SNAP retailer lookup supplies authorization records, separate from example groceries. Census Geocoder resolves submitted addresses. Device coordinates are sent directly to USDA for nearby retailer search; no reverse-geocoding service is used. Device searches display "Current location" rather than an inferred address. These services are not catalog sources and have their own terms and availability limits.

The interface uses the original NutriCart logo and retains USDA data-source attribution and non-endorsement text. The unused official USDA SNAP logo (`static/images/usda-snap-logo.png`) has been removed from the current public source and deployment assets; the build also removes a stale generated copy. Historical Git versions and older deployments may still contain it. Removing the current file does not erase historical copies or establish permission for their distribution. SNAP service-mark rights are separate from the nutrition CC0 terms; review historical distribution against [USDA SNAP logo guidance](https://www.fns.usda.gov/snap/logo-guidance), or seek USDA clarification. No unrestricted redistribution permission is claimed. USDA's prescribed service-mark notice is retained here for that context:

> The SNAP logo is a service mark of the U. S. Department of Agriculture. USDA does not endorse any goods, services, or enterprises.

Reviewed supplemental retailer names and USDA-type planning heuristics are documented in data/retailers/README.md. The Circle K identity uses an official retailer location page and a corroborating government record, matched by full address and USDA ID. Source USDA records remain unchanged. Categories and example groceries do not verify individual store inventory.

## Software dependencies

Pinned Python dependencies are listed in `requirements.txt`. Their upstream licenses are [Flask: BSD-3-Clause](https://github.com/pallets/flask/blob/main/LICENSE.txt), [PuLP: MIT](https://github.com/coin-or/pulp/blob/master/LICENSE), [Requests: Apache-2.0](https://github.com/psf/requests/blob/main/LICENSE), and [python-dotenv: BSD-3-Clause](https://github.com/theskumar/python-dotenv/blob/main/LICENSE). Dependencies and the CBC solver distributed with PuLP retain their own licenses and notices. No third-party package source, solver binary, icon font, or stock photograph is vendored in this repository.

The demonstration-data CC0 dedication does not assign a license to the application source or NutriCart branding. No application-code license has been selected in this repository.
