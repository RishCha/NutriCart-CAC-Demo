# NutriCart

A SNAP-focused grocery planning app that helps users find authorized retailers, build a grocery plan around their budget, create meal ideas, and track spending while shopping.

## Live Demo

https://nutri-cart-kohl.vercel.app

## What NutriCart Does

- Finds nearby SNAP-authorized retailers.
- Builds a grocery basket from a budget, household size, number of days, and dietary preference.
- Turns the current basket into simple meal ideas.
- Tracks purchases and the remaining budget while shopping.

## Why It Exists

Planning groceries on a limited budget requires several decisions at once: where to shop, what to buy, how to use it, and how much money remains. NutriCart brings those steps into one guided workflow while keeping retailer authorization, example prices, and product availability clearly separated.

## How It Works

**Find Store → Build Basket → Meal Plan → Shopping Budget**

The core public-demo workflow is available without an account.

## Technology

- Python and Flask
- JavaScript, HTML, and CSS
- PuLP for grocery-plan optimization
- USDA and other public location-data services
- Vercel hosting and Web Analytics

## Data and Pricing Note

The public demo uses an independently assembled catalog of generic foods with nutrition data from USDA FoodData Central. Example package sizes and prices are synthetic planning inputs, not guaranteed live retailer prices. SNAP-authorized retailer information comes from USDA retailer data and does not establish product inventory or item-level SNAP eligibility.

NutriCart is not affiliated with or endorsed by USDA.

## Running Locally

Use Python 3.13 from the repository root:

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -B app.py
```

The public release always uses `data/demo`. Missing demonstration data causes startup to fail rather than falling back to private catalogs.

## Testing

Run the Python regression suite and browser UAT from the repository root:

```powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
node tests/uat_demo_catalog.mjs
```

The suite covers catalog safety, planning constraints, diet rules, workflow state, feedback protections, responsive layouts, and the connected shopping flow.

## AI Assistance

ChatGPT assisted with brainstorming, troubleshooting, and UX review. OpenAI Codex assisted with implementation, debugging, and testing. The student directed the project, reviewed its behavior and data claims, tested the finished application, and made the final product decisions. See [AI_USAGE.md](AI_USAGE.md).

## More Information

- [Data sources and licensing](DATA_SOURCES.md)
- [Privacy](PRIVACY.md)
- [Vercel deployment notes](docs/vercel-demo.md)
- [Demonstration catalog details](data/demo/README.md)
