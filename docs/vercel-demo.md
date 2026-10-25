# Vercel Public Demo

NutriCart is a Flask application. The root `app.py` exports `app`, and Vercel runs `python -B build_vercel.py` before serving the application with Python 3.13.

## Public-Release Guarantees

- Every public-release run uses `data/demo`; missing files fail without a private-data fallback.
- The demo catalog contains generic USDA-based foods and synthetic prices.
- Guest mode never depends on account storage. Optional hosted accounts, password recovery, and cross-device saved content use Supabase when its URL and publishable/anon key are configured; missing configuration fails closed to guest mode.
- Guest grocery planning, meal planning, SNAP retailer search, and shopping-budget tools remain available.
- Example groceries are not linked to retailer inventory or observed retailer prices.

`build_vercel.py` validates the demonstration data and copies the reviewed static assets to generated `public/static`. Generated assets, virtual environments, databases, and instance files are excluded from publication. The NutriCart SVG is included through Flask templates.

## Hosting Configuration

Set a stable `FLASK_SECRET_KEY` in encrypted Vercel environment settings. Secure cookies are enabled by default when `VERCEL=1`. Environment files are not loaded by this release.

Location features use public USDA, Census Geocoder, and optional OpenStreetMap/Nominatim endpoints. Browser geolocation requires user permission and HTTPS, or loopback during local development.

The deployment manifest is recorded in `RELEASE_MANIFEST.txt`. The release was exported without private source-repository history or private catalog data.

## Supabase Accounts and Saved Plans

Accounts remain optional. To enable them, set SUPABASE_URL, SUPABASE_ANON_KEY, and NUTRICART_PUBLIC_URL in encrypted Vercel environment settings. SUPABASE_ANON_KEY is Supabase's publishable/anon key; do not configure or expose a service-role key. Missing or malformed configuration leaves the hosted app in guest mode.

Create a Supabase Free Plan project, keep email/password Auth enabled, set the Site URL to the production NutriCart URL, and add the production and loopback /reset-password URLs to Auth redirect URLs. Run supabase/schema.sql once in the Supabase SQL Editor. That script creates nutricart_saved_items, revokes anonymous access, grants only authenticated CRUD, enables RLS, and applies owner-only SELECT, INSERT, UPDATE, and DELETE policies based on auth.uid().

The Flask backend uses the publishable/anon key with each authenticated user's JWT, so Postgres RLS remains authoritative. Access and refresh tokens are stored in Secure, HTTP-only, SameSite=Lax cookies and are never returned to application JavaScript. Supabase Auth sends confirmation and password-reset email. NutriCart's legacy SMTP reset path is retired and is not imported by the Flask application.

Before production use, verify in Supabase's SQL editor or two isolated test accounts that user A cannot select, update, or delete user B's row. Also review Auth rate limits, redirect URLs, email templates, and CAPTCHA. Supabase's built-in mail service is rate-limited and best-effort; configure an approved custom SMTP provider in Supabase for production-grade delivery.

Official guidance:
- https://supabase.com/docs/guides/auth/passwords
- https://supabase.com/docs/guides/auth/sessions
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/api/securing-your-api

## Feedback Delivery

Feedback sending is disabled unless all of these conditions are satisfied:

1. `NUTRICART_FEEDBACK_ENABLED` is `1`, `true`, or `yes`.
2. `RESEND_API_KEY` is valid.
3. `NUTRICART_FEEDBACK_FROM` and `NUTRICART_FEEDBACK_TO` are valid, and the sender uses a Resend-verified domain.
4. Deployment-wide abuse protection limits `POST /api/feedback`.

The flag or provider credentials alone do not enable sending. Missing or malformed configuration fails closed. Values belong in encrypted Vercel settings, never Git or client JavaScript. SMTP settings are not used for feedback delivery.

Delivery uses Resend's HTTPS email API with a five-second timeout. The UI reports success only after the provider returns HTTP 200 with a non-empty message ID. CSRF validation, same-origin checks, bounded JSON, fixed sender and recipient addresses, a signed-session cooldown, and deployment-wide rate limiting remain required. Only the selected rating and optional comment are sent.

- Resend email API: https://resend.com/docs/api-reference/emails/send-email
- Resend domain verification: https://resend.com/docs/dashboard/domains/introduction

## Web Analytics

The main template uses Vercel's plain-HTML Web Analytics integration. It loads only when `VERCEL=1` and the request host is not loopback. Password-reset pages omit the script. NutriCart sends standard page views only; it does not emit custom events for tool tabs, locations, baskets, purchases, or feedback.

Official setup: https://vercel.com/docs/analytics/quickstart

## Verification

Run:

```powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
node tests/uat_demo_catalog.mjs
```

`tests/test_pescatarian_planning.py` covers fish-preference and provenance rules. The browser suite uses isolated browser state, deterministic store-response fixtures, public geocoding and USDA lookups, and an emulated public test location. It does not claim Safari coverage or persistence across browser reloads.

Relevant source guidance:

- USDA nutrition licensing: https://fdc.nal.usda.gov/api-guide/
- SNAP logo guidance: https://www.fns.usda.gov/snap/logo-guidance

Nutrition-data rights do not grant permission to use the USDA SNAP service mark. NutriCart displays source attribution and non-endorsement text rather than the official logo.

## Retailer identity and planning suitability

Package `retailer_policy.py` and `data/retailers/verified_identities.json` with the Flask function. The nested JSON is intentionally outside `data/*.json` exclusions. The build validates it. See `data/retailers/README.md` for evidence, matching rules, USDA category mappings and conservative/unknown-category trade-offs. This policy is not retailer inventory data. No new secrets or external business API are required.
