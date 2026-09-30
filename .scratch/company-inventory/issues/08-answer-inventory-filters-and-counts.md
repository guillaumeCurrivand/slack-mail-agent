# 08: Answer inventory filters and counts

**What to build:** A User can ask cross-inventory relationship questions, combine filters, and request counts, receiving complete matches or clearly paginated results grounded in the stored inventory.

**Blocked by:** [05 — Manage Tools and their usage](05-manage-tools-and-their-usage.md), [07 — Answer natural-language Project questions](07-answer-natural-language-project-questions.md).

**Status:** ready-for-human

**Specification:** [Documentation](../spec.md), especially relationship questions, combined filters/counts, current-record grounding, and pagination.

## Acceptance criteria

- [x] Support validated questions across Projects, Components, Technologies, Hosts/services, Hosting entries, and Tools, including reverse relationships and company-wide versus Project-specific Tool usage.
- [x] Demonstrate combined filters such as Projects using a specified Technology and Host/service. Respect explicit component/environment qualifiers and clarify an ambiguous requested relationship rather than silently requiring the matches to occur on the same Component.
- [x] Database results determine matches and counts, with distinct record identities preventing inflated Project counts caused by multiple Components, Hosting entries, or relationship rows. Unknown values are not invented, treated as matching facts, or silently substituted with zero.
- [x] Long results paginate with clear coverage and total-count semantics. Counts cover the intended query, not only the first page. Stable validated query context allows subsequent pages to retrieve current data without repeating paid natural-language interpretation; do not combine old-page results with new-state totals as if they were one snapshot.
- [x] Results include source record controls/identifiers and relevant saved links. Ordinary queries exclude archived records unless explicitly requested; archived references remain visibly labeled. These reads honor stored lifecycle status without requiring archive mutation controls as a dependency.
- [x] Unsupported predicates or unclear filters produce clarification/guidance. All requests remain read-only, use existing constrained interpretation and shared-budget checkpoints, and preserve actor-bound result controls/context.
- [x] Exact structured search/count paths and pagination remain available without AI; missing provider/key/budget leaves existing inventory operations usable. No document ingestion, vector retrieval, or bulk mutations are added.

## Verification and delivery

- [x] Exercise public request/action paths with fake AI/messaging against synthetic Projects with multiple Components/environments, shared hosts, shared/company-wide Tools, ambiguous filter scope, missing values, archived flags, changed records between pages, and duplicate joins. Verify counts and complete pagination independently of model wording and test cross-user controls and budget fallback.
- [x] Follow the [implementation and verification requirements](../spec.md#implementation-and-verification-requirements), update supported-question examples/help, run project checks, review the entire diff, and distinguish fake-provider coverage from live-model verification.

## Comments

Approved as ticket 08. Can proceed alongside 09 after its own blockers complete; it does not depend on natural-language mutations or the spreadsheet import.

Implemented locally on 2026-09-30. Inventory reads use validated exact relationship/field predicates and distinct target identities, with free structured search/count commands. Explicit Component/environment scope, company-wide versus Project Tool usage, Unknown values, archival labels and saved source controls are preserved. Pagination rereads current records and totals in one statement, carries an inventory fingerprint in private controls, and restarts coverage visibly after changes without repeating paid interpretation. Long escaped summaries retain all eight record identities and move full values to detail controls.

Local verification: Node v25.8.1 satisfies package engines. The final full suite passed 207 tests; 18 real PostgreSQL tests were skipped because TEST_DATABASE_URL was not set. TypeScript check/build, complete intended-diff review and local documentation-link checks passed. Signed public request/action tests use fake Slack and fake interpretation, including duplicate relationship evidence, sibling Hosts, private controls, budget fallback, restart, rejected delivery, changed inventory, archived references and long literal-markup results. No live Slack/OpenAI quality test, production deployment or real import was exercised.

Standards review: zero outstanding findings after the qualifier, source-label, delivery-retry and complete-message coverage fixes. Spec review: zero outstanding findings. This ticket remains ready-for-human for live release checks. There are no new environment requirements or schema/manual migration changes; use the [deployment handoff](../../../docs/deployment.md#documentation-inventory-queries-release-candidate) after pushing the reviewed main commit.
