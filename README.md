# NutriCart public CAC demonstration

Find SNAP Stores -> Build Your Basket -> Meal Plan -> Shopping Budget.

This independent release uses 33 generic food examples with actual USDA FoodData Central CC0 nutrition. Package masses and prices are synthetic examples, not retail observations. Actual store prices may differ. SNAP authorization establishes neither product availability nor item-level SNAP eligibility.

## Local startup

Use Python 3.13. Create a local virtual environment, install requirements.txt, then run:

```powershell
.\.venv\Scripts\python.exe -B app.py
```

This release always uses data/demo, locally and on Vercel. Missing files fail; no private-data fallback exists. Environment files are not loaded. Configure hosting variables through the dashboard.

## Limits

The release is guest-only. Registration, sign-in, cloud saves, and password recovery return an unavailable response; no account database is included or required. Implementation modules remain for compatibility. Plans and purchases remain in page memory and are lost on reload. Settings persist only with explicit opt-in. Store price comparison is unavailable for synthetic groceries.

Nutrition is generic planning information, not medical advice, allergy safety, guaranteed adequacy, or exact meal portions. Package quantities use the stated USDA preparation state (raw, dry, or cooked).

See DATA_SOURCES.md, PRIVACY.md, AI_USAGE.md, and docs/vercel-demo.md. The separate USDA SNAP service mark remains subject to final use review; this application is not endorsed by USDA.
