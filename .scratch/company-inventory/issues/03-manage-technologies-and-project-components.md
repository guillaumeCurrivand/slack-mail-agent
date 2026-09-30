# 03: Manage Technologies and Project components

**What to build:** A User can maintain the Technology catalog and a Project's Components, link existing Technologies to Components, and browse those relationships through Documentation without AI.

**Blocked by:** [02 — Edit Projects with overwrite and history](02-edit-projects-with-overwrite-and-history.md).

**Status:** ready-for-human

**Specification:** [Documentation](../spec.md), especially initial fields, relationships/identity, structured operations, and confirmation/history rules.

## Acceptance criteria

- [x] Provide paginated Technology browsing, exact lookup, details, and structured creation/editing for name, category, and notes. Add/Edit controls identify the target and list the supported fields.
- [x] From a Project, browse its Components and create/edit a Component's name/type and Technology relationships. A Component has a stable identity and an explicit Project parent; frontends, backends, APIs, and other named Components are supported without inventing required business data.
- [x] A Component can reference multiple existing Technologies, and one Technology can serve multiple Components/Projects. Details navigate those relationships without duplicating catalog records.
- [x] Validate relationship identifiers and workspace at proposal and apply boundaries. Ask about ambiguous names and require a separate confirmed creation if a referenced Technology does not exist; a relationship edit cannot silently create another record.
- [x] Creation and editing affect one record per confirmation and reuse the 24-hour actor-bound approval, chosen overwrite policy, atomic actual-before/after history, effect deduplication, and failure/retry reporting.
- [x] Renaming a Project, Component, or Technology preserves stable references. Optional values can remain unknown or be cleared; required names and parent/reference identifiers remain valid. Unsupported fields and batch mutations are not applied.
- [x] Technology and Component details expose Change history and relevant navigation. Reads, creation/edit instructions, and structured operations do not use AI or Gmail.

## Verification and delivery

- [x] Exercise catalog creation/editing, Component maintenance and relationship navigation through registry/routing/dispatch with fake messaging. Cover multiple Projects sharing a Technology, ambiguous/missing references, workspace violations, actor-bound confirmations, expiry, replay, and history consistency.
- [x] Follow the [implementation and verification requirements](../spec.md#implementation-and-verification-requirements) and repository checks/delivery rules. Update delivered-capability help and contract documentation; report real PostgreSQL skips and live integrations not exercised.

## Comments

Approved as ticket 03. Hosting entries are delivered by 04. Tool maintenance in 05 does not depend on this slice.

Implemented locally on 2026-09-30. The [Documentation contract](../../../docs/documentation.md#delivered-locally--ticket-03) records Technology/Component commands, stable relationship navigation, fixed Project parents, workspace/reference validation, private confirmations and atomic actual overwrite history. The [deployment guide](../../../docs/deployment.md#documentation-technologies-and-components-release-candidate) records automatic schema changes and manual post-deploy checks. Hosting, Tools, archival, natural language and import remain later slices.

Local verification: Node v25.8.1 satisfies package.json's >=24 requirement. All 24 Documentation tests pass through signed ingress, registry/routing/dispatch and fake Slack delivery. Full `npm test`: 160 passed, 9 real PostgreSQL tests skipped because `TEST_DATABASE_URL` is unavailable. `npm run check` and `npm run build` pass; local file links resolve. Coverage includes multiple Projects sharing Technologies, pagination/ambiguity, renames, optional clearing, malformed/foreign references at apply, actor/DM/workspace binding, 24-hour expiry, satisfied edits, history failure rollback for both creation and editing, replay/restart and definite/uncertain delivery recovery with exhausted AI allowance. Live Slack, Gmail, AI, production deployment and real data import were not exercised.
