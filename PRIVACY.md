# Public demo privacy

The release is guest-only. Account, cloud-save, and recovery endpoints return an unavailable response. No private database is included or required. Plans, meals, and shopping purchases remain in page memory and are cleared on reload. Mark purchased records a basket estimate in the in-memory purchase ledger; edited prices replace that estimate.

Settings are stored only after Remember my settings is enabled. Stored preferences do not contain baskets, purchases, addresses, or coordinates.

Device location is requested only after Use My Current Location and browser permission. Users may instead submit an address. Flask sends submitted addresses to Census Geocoder and search coordinates to USDA's SNAP retailer service. Device-location reverse lookup may send coordinates to OpenStreetMap/Nominatim for address autofill. Failure does not block coordinate search. The application does not intentionally save addresses, coordinates, or retailer results. Hosts and upstream services may retain operational logs under their own policies; this is not a promise that no infrastructure logs exist.

Planner requests use coarse locality/region context, which does not verify inventory. Prices are synthetic examples, not personal data or retailer observations. Store price comparison is unavailable.

Flask uses a signed cookie for existing session/CSRF protections, including guest account-status requests. Set a stable FLASK_SECRET_KEY through the host dashboard and use secure cookies on HTTPS. Environment files are not loaded by this release. External service privacy and retention are outside NutriCart's control. Avoid personal information during public demonstrations.

Feedback is optional. Public submission is currently disabled pending deployment-level abuse protection. Only the chosen positive/negative rating and submitted comment are emailed to the configured NutriCart feedback recipient. No basket, purchases, location, account identifiers, or browser metadata are appended. Please omit personal and shopping information from comments. Comments are not stored in cookies, browser storage, application files, or application logs. The configured email provider and recipient may retain submitted messages under their own policies. A signed session cookie records a send timestamp for a basic cooldown.
