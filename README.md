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

**Find Store → Build Basket → Shopping Budget → Meal Plan**

The core workflow remains available without an account. When Supabase is configured, an optional account can keep saved grocery plans, meal plans, and shopping sessions available across devices.

## Technology

- Python and Flask
- JavaScript, HTML, and CSS
- PuLP for grocery-plan optimization
- USDA and other public location-data services
- Vercel hosting and Web Analytics
- Optional Supabase Auth and RLS-protected saved plans

## Data and Pricing Note

The public demo uses an independently assembled catalog of generic foods with nutrition data from USDA FoodData Central. Example package sizes and prices are synthetic planning inputs, not guaranteed live retailer prices. SNAP-authorized retailer information comes from USDA retailer data and does not establish product inventory or item-level SNAP eligibility.

The entered budget is a ceiling, not a spending target. Plans must meet nutrition minimums and the selected diet and exclusions; some combinations are infeasible.

NutriCart is not affiliated with or endorsed by USDA.

## Running Locally

Use Python 3.13 from the repository root:

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -B app.py
```

Open http://127.0.0.1:5000 after Flask starts. Guest planning needs no account credentials or private database. Store searches need an internet connection.

The public release always uses `data/demo`. Missing demonstration data causes startup to fail rather than falling back to private catalogs.

Optional accounts require Supabase configuration; feedback requires Resend configuration and abuse protection. See [deployment notes](docs/vercel-demo.md) for setup and [.env.example](.env.example) for variable names. Set values in the process environment or host dashboard: this release does not load `.env` files.

## Testing

Run the Python regression suite from the repository root:

```powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
```

The browser UAT also needs Node.js 22 or newer and Microsoft Edge on Windows. It uses a fresh browser profile and mocked account operations, not your existing sign-in session. Set `EDGE_PATH` if the browser executable is elsewhere. Run:

```powershell
node tests/uat_demo_catalog.mjs
```

The suite covers catalog safety, planning constraints, diet rules, workflow state, feedback protections, responsive layouts, and the connected shopping flow.

## Limitations

- A SNAP-authorized retailer is not a guarantee of inventory, prices, or item-level eligibility.
- Meal ideas use foods in the current basket; they do not provide exact portions or cooking directions.
- Guest trips remain in page memory and are lost on reload unless saved with a configured account.
- Location lookup, account email, and feedback depend on external services and their availability limits.

## AI Assistance

ChatGPT assisted with brainstorming, troubleshooting, and UX review. OpenAI Codex assisted with implementation, debugging, and testing. The student directed the project, reviewed its behavior and data claims, tested the finished application, and made the final product decisions.

Grocery baskets and meal plans use deterministic application logic. The shipped demo does not use runtime AI recipe generation. See [AI_USAGE.md](AI_USAGE.md).

## More Information

- [Data sources and licensing](DATA_SOURCES.md)
- [Privacy](PRIVACY.md)
- [Vercel deployment notes](docs/vercel-demo.md)
- [Demonstration catalog details](data/demo/README.md)
