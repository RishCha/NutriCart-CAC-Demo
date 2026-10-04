# Independent Vercel CAC release

Root app.py exports Flask app. Use Python 3.13 and requirements.txt. All public-release runs select data/demo, even if a local-catalog mode is requested. Missing demo files fail without fallback. Account/cloud-save/recovery operations are unavailable locally and on Vercel. No SQLite persistence is promised. Example groceries cannot be compared against real retailers.

Vercel runs `python -B build_vercel.py`, validating demo data and copying the twelve reviewed static files to generated public/static. Do not commit generated copies, instance artifacts, or virtual environments. Root data files and private runtime files are excluded by .vercelignore and function configuration. The NutriCart SVG is included through Flask templates, not an external asset path.

Configure a stable FLASK_SECRET_KEY through the host dashboard. Secure cookies default on under VERCEL=1. SMTP and retailer credentials are unnecessary. Environment files are not loaded. Location services use public USDA/Census/optional Nominatim endpoints. Geolocation requires permission and HTTPS, or loopback for local testing.

Local verification does not prove hosted Linux CBC execution, temporary-file access, duration, or Vercel routing. Review those before sharing a future deployment. This export has no Git initialization, remote, or source history. RELEASE_MANIFEST.txt lists the exact publication files; do not copy additional development data or source Git history. The development repository's history was not rewritten.

USDA nutrition licensing: https://fdc.nal.usda.gov/api-guide/
SNAP logo review: https://www.fns.usda.gov/snap/logo-guidance
Nutrition CC0 rights do not grant logo permission. Existing service-mark/non-endorsement wording is retained; final intended-use and artwork review remains required.
