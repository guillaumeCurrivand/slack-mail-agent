# 04: Manage Hosts/services and Hosting entries

**What to build:** A User can maintain shared Hosts/services and record where each Project component is hosted in each environment, then inspect and edit those entries through private Documentation interactions.

**Blocked by:** [03 — Manage Technologies and Project components](03-manage-technologies-and-project-components.md).

**Status:** ready-for-human

**Specification:** [Documentation](../spec.md), especially initial fields, relationships/identity, hosting answer presentation, and mutation/history safeguards.

## Acceptance criteria

- [x] Provide paginated Hosts/services browsing, exact lookup, details, and structured confirmed creation/editing for name, role, optional monthly cost/currency, and notes.
- [x] From a Project component, create, inspect, and edit Hosting entries containing environment, provider/service reference, account reference, URLs, access instructions, and notes. Preserve separate entries for different Components/environments rather than flattening a Project to one host.
- [x] Multiple Hosting entries/Projects can reference the same Host/service. Validate workspace, parent and catalog identifiers; clarify ambiguous references and require missing catalog records to be created as separate confirmed operations.
- [x] Project details present recorded Components/environments, with production first, saved links, and explicit unknown values. Navigating to Host/service and Hosting entry details shows stable source identifiers and history.
- [x] Optional costs have an explicit currency and remain on the shared Host/service record. Unknown cost is not zero; the same service cost is not copied to each linked Project. Account/access fields contain instructions, account references, and password-manager links rather than passwords or API keys.
- [x] Add/Edit controls and documented structured commands require no AI. All saves affect one record, require the initiating User's confirmation within 24 hours, and reuse overwrite, unrelated-field preservation, atomic actual-before/after history, and replay/restart safeguards.
- [x] Renaming records preserves hosting relationships and history. Fixed fields and system-maintained metadata retain their agreed boundaries; no infrastructure provider is contacted or changed by an inventory edit.

## Verification and delivery

- [x] Exercise the public create/browse/edit/confirm paths with fake messaging for a Project with multiple Components and staging/production entries, shared services, missing references/costs, invalid values, cross-workspace identifiers, and concurrent edits. Verify zero paid calls for structured operations.
- [x] Follow the [implementation and verification requirements](../spec.md#implementation-and-verification-requirements) and repository checks/delivery rules, including docs, full-diff review, and separate reporting of PostgreSQL skips and unexercised live integrations.

## Comments

Approved as ticket 04. This unlocks the basic natural-language Project-question slice and contributes the complete hosting model required by import and archival.

Implemented locally on 2026-09-30. The [Documentation contract](../../../docs/documentation.md#delivered-locally--ticket-04) records Host/service and Hosting entry commands, fixed Component parents, shared costs, production-first Project views, stable relationship navigation, private confirmations and atomic actual overwrite history. The [deployment guide](../../../docs/deployment.md#documentation-hostsservices-and-hosting-entries-release-candidate) records automatic schema changes and manual post-deploy checks. Tools, archival, natural language and import remain later slices.

Local verification: Node v25.8.1 satisfies the >=24 engine. Full `npm test`: 165 passed, 11 real PostgreSQL tests skipped because `TEST_DATABASE_URL` is unavailable. After final normalization/empty-environment handling and an added upgrade fixture, all 30 Documentation tests pass through signed ingress, registry/routing/dispatch and fake Slack delivery. `npm run check` and `npm run build` pass; local file links resolve. Coverage includes two Projects with multiple Components sharing a service, distinct staging/production entries, pagination/ambiguity, missing/foreign references, costs/currency (including commit-time validation), optional clearing, immutable metadata, 24-hour expiry, actor/DM/workspace binding, atomic history failure rollback for creation/editing, replay/restart, definite/uncertain delivery recovery and exhausted AI allowance. Upgrade verification retains previous catalog inventory and pending controls. Live Slack, Gmail, AI, infrastructure providers, production deployment and real import were not exercised.

Work is committed locally on main; pushing and deployment are not part of this ticket. Existing unrelated glossary edits and tickets 05–10 were preserved.

Final independent review: Standards — 0 documented violations and 0 outstanding actionable smells; Spec — 0 findings. The two optional Standards refactors were resolved by renaming the shared relationship filter to referenceId and sharing exact-lookup/page parsing. Both reviewers checked the follow-up diff; all 30 Documentation tests, typecheck and build passed afterward. Full-suite result above precedes the added upgrade test; its final focused verification is reported separately rather than counting an unrun full suite.
