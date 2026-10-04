# Public demo privacy

The release is guest-only. Account, cloud-save, and recovery endpoints return an unavailable response. No private database is included or required. Plans, meals, and shopping purchases remain in page memory and are cleared on reload. Checking collected items does not record spending; only explicit purchases affect the budget.

Settings are stored only after Remember my settings is enabled. Stored preferences do not contain baskets, purchases, addresses, or coordinates.

Device location is requested only after Use My Current Location and browser permission. Users may instead submit an address. Flask sends submitted addresses to Census Geocoder and search coordinates to USDA's SNAP retailer service. Device-location reverse lookup may send coordinates to OpenStreetMap/Nominatim for address autofill. Failure does not block coordinate search. The application does not intentionally save addresses, coordinates, or retailer results. Hosts and upstream services may retain operational logs under their own policies; this is not a promise that no infrastructure logs exist.

Planner requests use coarse locality/region context, which does not verify inventory. Prices are synthetic examples, not personal data or retailer observations. Store price comparison is unavailable.

Flask uses a signed cookie for existing session/CSRF protections, including guest account-status requests. Set a stable FLASK_SECRET_KEY through the host dashboard and use secure cookies on HTTPS. Environment files are not loaded by this release. External service privacy and retention are outside NutriCart's control. Avoid personal information during public demonstrations.
