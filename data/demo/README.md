# Independent NutriCart demonstration data

These 33 generic food examples were assembled independently from USDA FoodData
Central SR Legacy April 2018, downloaded directly from USDA. No Kroger or Open
Food Facts records, retailer packages, prices, brands, UPCs, or store identifiers
were used to build them.

Nutrition is actual USDA per-100-gram data, not invented values. Each record has
an FDC ID, exact USDA description, URL, preparation state, and CC0 identifier.
`usda_source_records.json` preserves the selected nutrient values and the source
archive URL/SHA-256. Missing optional sugar measurements remain missing.

Citation: U.S. Department of Agriculture, Agricultural Research Service.
FoodData Central, SR Legacy April 2018. https://fdc.nal.usda.gov/
USDA states its data are public domain, published under CC0 1.0:
https://fdc.nal.usda.gov/api-guide/#bkmk-6
https://creativecommons.org/publicdomain/zero/1.0/

Package masses and dollar prices are independently authored synthetic examples.
They do not represent retail observations. Mass means edible food in the stated
USDA preparation state: dry beans/rice are dry, raw produce is raw, and roasted
chicken is cooked. These are purchase-equivalent planning quantities, not exact
meal portions or cooking instructions. Nutrition is an estimate for a generic
example, not a verified commercial label. Package nutrient totals equal the USDA
per-100-g values multiplied by example mass / 100.

The authors dedicate the independently authored example values and selection to
CC0 1.0. This dedication does not license the separate application code or USDA
SNAP logo. No Open Food Facts content is included and no ODbL claim is made.

Reproduce using `python -B build_demo_catalog.py PATH_TO_USDA_SR_ZIP`.
The builder verifies the reviewed USDA archive hash and reads no local retailer
inputs. It is a development tool, not a deployment build step.

This public release always selects this directory locally and on Vercel. Missing
files fail without fallback. Accounts/cloud saves and actual retailer price
comparison are unavailable. SNAP authorization establishes neither example-product
availability nor item-level eligibility.
