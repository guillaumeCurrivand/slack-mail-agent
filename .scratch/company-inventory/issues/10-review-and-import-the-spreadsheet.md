# 10: Review and import the spreadsheet

**What to build:** An operator can review mappings from a spreadsheet snapshot, resolve uncertain entries with the User, apply that reviewed batch once, and reconcile imported records/relationships and initial Change history through Documentation.

**Blocked by:** [04 — Manage Hosts/services and Hosting entries](04-manage-hosts-services-and-hosting-entries.md), [05 — Manage Tools and their usage](05-manage-tools-and-their-usage.md).

**Status:** ready-for-human

**Specification:** [Documentation](../spec.md), especially import/transition, observed source structure, fixed fields/relationships, and history/provenance.

## Acceptance criteria

- [x] Provide a one-time operator workflow using an explicit spreadsheet snapshot and configured workspace. Its review phase reports clear mappings and uncertain entries without applying inventory mutations; it does not add a live Google Sheets integration or ordinary-user bulk editing.
- [x] Preserve displayed names and embedded links from hyperlink formulas without evaluating arbitrary formulas or visiting their destinations. Split combined technologies/hosts/project references only when source meaning is established, and record evidence for component/environment assignments.
- [x] The mapping review preserves original text needed to resolve unmatched usage, ambiguous Project references, and potentially distinct same-named Hosts/services. Do not silently merge names, discard unmatched values, invent missing facts, or infer company-wide usage merely because a Project-name match failed.
- [x] The User's resolved mapping and exact reviewed snapshot identify the approved batch. Applying requires that review to be complete; changes to its source/mapping require a fresh review rather than reusing approval for different data.
- [x] Apply the approved Project, Component, Technology, Host/service, Hosting entry, and Tool records/relationships with stable identifiers and source-attributed initial history. Include source/batch provenance and outcome information, and preserve existing data rather than treating a repeated import as permission to overwrite it.
- [x] Batch checkpoints and effect identities prevent duplicate records, relationships, and initial history after retry or restart. Report partial/failed outcomes accurately, retain recovery information, and resume or recover without blindly replaying completed writes. Verification reconciles applied counts, records, and relationships with the approved mapping.
- [x] Imported data is accessible through the structured Documentation lists, details, and history paths. The import does not depend on AI, natural-language workflows, or archived-record mutation controls; no paid call or Gmail authorization is required.
- [x] Declare the database authoritative only after the reviewed import has successfully applied and reconciled. Explain that subsequent spreadsheet edits do not synchronize, and that recurring imports, exports, and document-content ingestion are deferred.
- [x] Document the operator transition/recovery procedure and readiness checks using the existing environment and database volume. Real source-data review/import and production rollout remain separately authorized actions; building/testing the importer does not apply the company's real data.

## Verification and delivery

- [x] Use synthetic workbook fixtures through the actual operator review/apply path and public Slack record/history reads. Cover hyperlink display/link preservation, combined values, duplicate-name services, ambiguous/unmatched usage, missing data, invalid references, changed review artifacts, batch replay, crash/partial-failure recovery, existing-record collisions, workspace scope, and reconciliation.
- [x] Follow the [implementation and verification requirements](../spec.md#implementation-and-verification-requirements) and repository delivery instructions, including real PostgreSQL import recovery tests where configured, project checks, full-diff review, and separate skipped/live-verification reporting. Any ready-to-deploy handoff must include the target branch/commit, confirmed server commands, environment/migration requirements, and post-deploy checks; it must not claim deployment success without observing it.

## Comments

Approved as ticket 10. Can proceed once the structured inventory model is complete, independently of 06–09. A real reviewed import is an operator task after implementation, not a ticket-publication side effect.

Implemented locally on 2026-09-30. [The authoritative contract](../../../docs/documentation.md#delivered-locally--ticket-10) and [operator procedure](../../../docs/documentation-import.md) describe offline JSON cell-snapshot review, explicit evidence/resolutions, exact source/mapping approval binding, all six kinds, existing identity references without overwrites, per-effect atomic initial history/checkpoints, restart recovery, saved-artifact recovery and reconciliation before authority. Preparing a complete JSON snapshot from an independently obtained workbook export remains an operator prerequisite; no binary XLSX parser or live Sheets integration is added.

Local verification: 231 tests passed, including nine importer tests using synthetic workbook fixtures through operator commands and public Documentation routing/dispatch reads. TypeScript check, build, compiled CLI help and 79 local documentation links passed. Twenty real PostgreSQL tests were skipped because `TEST_DATABASE_URL` was absent, including the two new importer concurrency/recovery tests. No live Slack, real spreadsheet review/import, AI/Gmail authorization or production deployment was performed. See [the deployment handoff](../../../docs/deployment.md#documentation-import-release-candidate) for the confirmed server commands, existing-environment/volume preservation and post-deploy checks.

The complete intended diff, including new files, received separate Standards and Spec reviews with zero implementation findings. The Spec review's read-coverage opportunity was addressed by explicitly reading both same-named Hosts and Hosting-entry details/history through public Slack commands, and the focused nine-test suite passed afterward. The preexisting uncommitted `CONTEXT.md` edits are outside this ticket's commit.
