# AI Usage Disclosure

AI tools, including ChatGPT and Codex, were used materially as development assistants throughout NutriCart. Assistance included architecture suggestions, Python/PuLP and Flask implementation, refactoring, test creation, debugging, UI/UX iteration, privacy and limitation review, and documentation preparation.

The project is not represented as having been created without AI assistance.

## Student direction and verification

- The student selected and directed the project problem, requirements, feature priorities, supported user flows, and submission goals.
- Diet choices, validation behavior, Nutrition Focus, Plan Score presentation, location privacy, price-comparison boundaries, meal constraints, Budget behavior, and stabilization requirements were explicitly directed and reviewed by the student.
- Generated changes were inspected and exercised through automated tests.
- Manual smoke testing identified UX and integration problems, including awkward meal combinations/labels and stale cross-feature state; those findings drove corrections.
- Privacy, external-data boundaries, credential handling, and non-persistence behavior were intentionally reviewed.
- AI-generated suggestions and code were not assumed correct. Inaccurate, overbroad, awkward, or unsupported output was revised or rejected.

## Material assistance log

| Date or period | Tool | Material assistance | Review and correction |
|---|---|---|---|
| Earlier project work; exact session dates not fully preserved | ChatGPT | Python/PuLP explanations, Git guidance, planning, interface suggestions, and documentation preparation | Student selected requirements and rejected inaccurate or unnecessarily long suggestions. |
| August 4, 2026 | Codex | Rebuilt and tested the grocery optimizer; added the optional SNAP retailer locator | Student directed menus, validation, diet/fiber behavior, pagination, and location privacy. |
| August 5–8, 2026 | Codex | Prepared initial documentation and implemented the Flask SNAP interface, radius controls, loading behavior, and tests | Student reviewed interaction behavior and required explicit permission and non-persistence safeguards. |
| August 9–11, 2026 | Codex | Assisted with Grocery Planner API/UI, normalization and comparison modules, approximate location display, Shopping Budget, tests, and integration work | Automated and manual checks were used; unsupported price/inventory claims were excluded. |
| August 13, 2026 | Codex | Implemented Basket Price Comparison UI and deterministic Meal Plan/Nutrition Insights; added regression tests | Current-plan synchronization, exclusion preservation, incomplete-basket ranking, nutrition wording, and meal quality were reviewed and corrected. |
| August 14, 2026 | Codex | Performed FIRST MVP stabilization and comprehensive documentation update | Stale asynchronous state, Budget autofill, meal labels, accessibility, responsive behavior, source claims, privacy, and test baseline were verified. |

## Limits of this disclosure

Some early prompt/session metadata and exact file lists were not preserved. This disclosure describes the known material roles rather than claiming a complete prompt transcript. The student should retain any additional prompt or session evidence required by the final submission rules.

## Public release preparation

Codex assisted with USDA dataset extraction, independent synthetic package/price authoring, catalog isolation, release packaging, documentation, and automated tests. Nutrition values were read from USDA, not invented by AI. Prices and package examples are intentionally synthetic. Student direction and final publication review remain necessary. Earlier feature descriptions above describe development history; accounts/cloud saves are disabled in this public release. Historical test totals do not substitute for the release verification report.
