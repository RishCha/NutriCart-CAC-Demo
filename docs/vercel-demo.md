# Independent Vercel CAC release

Root app.py exports Flask app. Use Python 3.13 and requirements.txt. All public-release runs select data/demo, even if a local-catalog mode is requested. Missing demo files fail without fallback. Account/cloud-save/recovery operations are unavailable locally and on Vercel. No SQLite persistence is promised. Example groceries cannot be compared against real retailers.

Vercel runs `python -B build_vercel.py`, validating demo data and copying the thirteen reviewed static files to generated public/static. Do not commit generated copies, instance artifacts, or virtual environments. Root data files and private runtime files are excluded by .vercelignore and function configuration. The NutriCart SVG is included through Flask templates, not an external asset path.

Configure a stable FLASK_SECRET_KEY through the host dashboard. Secure cookies default on under VERCEL=1. SMTP and retailer credentials are unnecessary. Environment files are not loaded. Location services use public USDA/Census/optional Nominatim endpoints. Geolocation requires permission and HTTPS, or loopback for local testing.

Local verification does not prove hosted Linux CBC execution, temporary-file access, duration, or Vercel routing. Review those before sharing a future deployment. This release was independently exported without the private source repository history. RELEASE_MANIFEST.txt lists the exact publication files; do not copy additional development data or source Git history. The development repository's history was not rewritten.

USDA nutrition licensing: https://fdc.nal.usda.gov/api-guide/
SNAP logo review: https://www.fns.usda.gov/snap/logo-guidance
Nutrition CC0 rights do not grant logo permission. The SNAP screen displays source attribution and non-endorsement text, not the official SNAP logo. The existing logo file and source documentation are retained; any future display still requires an intended-use and artwork review.

Task 22 verification uses `tests/test_task22.py` alongside the existing available suite and `node tests/uat_demo_catalog.mjs` for installed Edge. The browser test uses explicit synthetic response fixtures for zero/one/multiple stores, then real public geocoding and USDA search. Device location is emulated at a public test location. It does not test Safari or promise persistence across reloads. All generated verification artifacts remain under ignored instance/.

## Optional feedback email

Public sending is disabled in source by FEEDBACK_ENABLED=False, even when SMTP is configured. No durable or deployment-wide rate limiting has been verified. Keep this gate disabled until an operator configures and verifies deployment-level abuse protection and provider quotas, then reviews a separate change to enable sending. Tests override this gate only with mocked mail transport. The feedback UI remains available; SMTP credentials alone do not enable it.

Set NUTRICART_FEEDBACK_TO to the recipient address. Also configure NUTRICART_SMTP_HOST, NUTRICART_SMTP_PORT (587 for STARTTLS or 465 for TLS), NUTRICART_SMTP_FROM, NUTRICART_SMTP_USERNAME, NUTRICART_SMTP_PASSWORD, and a stable FLASK_SECRET_KEY in the hosting dashboard. Do not put credentials in Git or client JavaScript. Feedback uses the port to require encrypted authenticated SMTP. No mail is sent when required configuration is missing or invalid.

Delivery runs synchronously within the request, with five-second socket timeouts, without a local database or background worker. Success means the SMTP server accepted the email, not guaranteed inbox placement. Failed or uncertain delivery shows an error; there is no automatic retry. Verify delivery to your chosen mailbox after configuration before announcing availability.

CSRF, same-origin checks, bounded JSON, fixed sender/recipient and a signed-session cooldown protect normal use. The cookie cooldown is not a distributed abuse limit: clearing/replaying cookies or parallel requests can bypass it. Before enabling public email, configure a Vercel WAF rate-limit rule for POST /api/feedback and provider sending quotas. Do not rely on process-local counters in serverless functions.

SMTP reference: https://docs.python.org/3/library/smtplib.html

Vercel SMTP support: https://vercel.com/kb/guide/serverless-functions-and-smtp (port 25 is blocked; feedback uses 465/587).
