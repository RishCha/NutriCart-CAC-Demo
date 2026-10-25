# Reviewed retailer identities and planning categories

This small public policy is independent of the food catalog. It adds display metadata; it never changes USDA authorization, source names, or addresses. No coordinates or user search history are stored. No new business lookup API runs during searches.

## Identity review

One generic-name source record was inspected and resolved; no broad identification audit is claimed. USDA Record_ID 1235424 has raw name `2701868.0 1868`, address 8855 Christenbury Pkwy, Concord, NC 28027 and type Convenience Store (public USDA feed checked 2026-10-24).

- Official Circle K location: https://www.circlek.com/station/8855-christenbury-pkwy-concord-us
- Corroborating North Carolina ABC meeting record (January 12, 2022, page 8, Circle K Store 1868): https://www.abc.nc.gov/media/476/open

The mapping is a factual business-identity assertion only. It does not establish merchandise, prices, current opening hours, or guaranteed inventory. No source imagery, marketing copy or third-party product data is copied.

To add another identity, review an official retailer page or authoritative business record, retain its URL/date/source type, and match USDA ID plus street (including unit), city, state and ZIP. Harmless abbreviations/case and ZIP+4 are normalized. Missing/conflicting details or multiple matching entries fail unresolved. Never infer from the store number, ZIP or nearby coordinates. Valid USDA names take precedence, followed by existing normalized names. Missing names show Store name unavailable with SNAP-authorized retailer beneath.

## Planning policy

Source definitions: https://www.fns.usda.gov/snap/store-definitions (official mirror: https://fns-prod.azureedge.us/snap/store-definitions).

- Full candidates: SM/SS/LG/MG, supermarket/superstore, large/medium or unqualified Grocery Store categories.
- Limited: CS convenience, SG small grocery, CO combination/general-merchandise grocery; gas station alias. SG has staple-category coverage but limited selection, so is conservatively outside the default multi-day planning view. CO does not establish full grocery breadth.
- Specialty: BB/FV/ME/SE, specialty bakery/produce/meat/seafood, DF direct farmer and FM farmers market. These categories do not establish complete household assortment.
- Unknown: missing/unrecognized categories, internet/delivery/cooperative and restricted commissary categories where the available type alone does not establish an accessible full-assortment grocery store.

These are NutriCart planning heuristics, not USDA inventory endorsements. No chains are classified by name. The default suitable view contains only full candidates; All SNAP retailers retains every result. Counts distinguish visible, filtered and total results. Radius refreshes clear selection; filter changes preserve it without silently selecting another store.

Known limited and specialty stores remain discoverable and selectable, with a Find a Grocery Store action preserving search/preferences. They do not unlock full household generation. Unknown stores can unlock only after an explicit Use an illustrative plan acknowledgement; this avoids asserting insufficient inventory or unnecessarily excluding ambiguous stores. Even full candidates have no verified inventory.

Legacy saved baskets remain readable with current disclaimers, without rerunning optimization or changing purchases. Missing historic address/type is not invented. New or alternative generation requires a current eligible selection (unknown acknowledgement permitted). The API recomputes eligibility from supplied type rather than trusting a client classification. This is a truthful planning-context guard, not proof of a signed store identity or inventory. Generic API clients without selected-store context retain generic planning behavior.

The versioned policy is packaged under data/retailers, outside the deployment exclusion for data/*.json. It is cached in process; a missing/corrupt file fails conservatively at runtime and fails the deployment build. Broader automatic name resolution would require separately licensed/approved business data; no such integration is configured.
