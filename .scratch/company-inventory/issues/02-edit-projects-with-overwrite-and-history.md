# 02: Edit Projects with overwrite and history

**What to build:** A User can edit selected Project fields through structured requests and confirm them even after someone else edits the Project, then inspect the actual before/after Change history without losing unrelated changes.

**Blocked by:** [01 — Create and browse shared Projects](01-create-and-browse-shared-projects.md).

**Status:** ready-for-human

**Specification:** [Documentation](../spec.md), especially relationships/identity, mutation confirmation, overwrite/recovery, and history.

## Acceptance criteria

- [x] Project details offer Edit instructions identifying the record and its supported fields. Structured commands can change one or several allowed fields on one Project, including clearing optional values, without AI. Unsupported fields, invalid names, ambiguous targets, and multi-record requests are explained rather than applied.
- [x] Show the selected fields and their proposed replacements before saving. Persist those exact replacements in an actor-bound confirmation expiring after 24 hours. No save happens before confirmation, and another User cannot approve it.
- [x] Confirmation overwrites the approved fields even if they changed after the preview; do not reject a stale record version. Preserve every unrelated field, including edits made by another User after the preview.
- [x] Serialize commits across Users in the database. Save the mutation, immutable history, and effect-deduplication identity in one transaction. History records the values actually replaced at commit time, not the outdated preview values.
- [x] Demonstrate the selected policy: Alice proposes A, Bob saves B, Alice confirms A, and Alice's history shows B to A. A separate notes change by Bob remains when Alice did not approve changing notes.
- [x] Project renames retain stable identity, references, and history. Aliases participate in exact lookup, with explicit ambiguity handling. System identifiers, history actor/time, and lifecycle metadata cannot be edited as business fields.
- [x] Expose paginated shared history and record-specific history showing actor, time, changed fields, and actual before/after values. History cannot be rewritten and has no restore-earlier-values control in this slice.
- [x] Duplicate clicks, restart/retry, transaction failure, and delivery failure cannot repeat an applied edit after another later edit. Saved outcomes can be reported without repeating the mutation; failed and already-satisfied operations are described accurately.

## Verification and delivery

- [x] Test these behaviors through the public structured-request and action dispatch paths with fake messaging, including concurrent actors, expiry, invalid references, unrelated-field preservation, and replay after an intervening edit. Include real PostgreSQL cross-user concurrency/transaction tests when a disposable test database is configured; report skips separately.
- [x] Follow the [implementation and verification requirements](../spec.md#implementation-and-verification-requirements), including Node compatibility, relevant tests, `test`, `check`, and `build`, documentation updates, complete-diff review, and delivery-state reporting. No production deployment is authorized by this ticket.

## Comments

Approved as ticket 02. This establishes the confirmed-edit and history behavior reused by later record types; archival and earlier-value restoration controls are not part of this slice.

Implemented locally on 2026-09-30. The [Documentation contract](../../../docs/documentation.md#delivered-locally--ticket-02) records structured selected-field edits, actor/DM-bound confirmations, database-serialized overwrite with actual history, shared history browsing and saved replay outcomes. Other inventories, archival, natural language and import remain later slices. No production deployment or real data import was performed.

Local verification: Node v25.8.1 satisfies >=24; 154 tests passed and 7 real PostgreSQL tests were skipped because TEST_DATABASE_URL was not configured. npm run check and npm run build passed; 47 local documentation file links and whitespace checks passed. Fake-Slack signed-ingress/dispatch tests cover overwrite after another actor's edit, unrelated-field preservation, stable rename identity and aliases, ambiguity, clearing, invalid fields/references, actor/DM/workspace/operation binding, expiry, retry target stability, duplicate/restart recovery after later edits, uncertain/rejected delivery, satisfied and failed outcomes, rollback, full long-value pagination and exhausted AI budget. New real PostgreSQL tests cover a waiting cross-User edit reading the committed prior value, simultaneous duplicate confirmations and history/checkpoint rollback; those concurrency tests remain unverified locally. Live Slack/Gmail/OpenAI integrations remain unexercised.

See [deployment guidance](../../../docs/deployment.md#documentation-projects-release-candidate) for automatic schema additions, preserved environment/volume, server update commands and post-deploy checks. This is a local release candidate, not a successful production deployment.

Final review: Standards — 0 documented violations and 0 remaining actionable smells; Spec — 0 remaining findings. The exact-name/alias parser defect for brace-containing targets was reproduced through signed Slack dispatch and repaired before the final suite. The PostgreSQL dispatch fixture duplication was removed during review. Work is committed locally on main; pushing and deployment are not part of this ticket.
