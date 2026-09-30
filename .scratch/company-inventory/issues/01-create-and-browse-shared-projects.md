# 01: Create and browse shared Projects

**What to build:** A User can open Documentation in a private DM, create a Project through a structured request and saved confirmation, and browse that same shared Project from another User's DM with its initial Change history.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

**Specification:** [Documentation](../spec.md), especially initial fields, Slack navigation, mutation confirmation, private state, and implementation requirements. The User approved this ticket breakdown; this is a work item, not a report of implementation or deployment.

## Acceptance criteria

- [x] Register Documentation with the `documentation` prefix and existing enablement, durable dispatch, main-menu discovery, private navigation, help, and Back/Menu behavior. Disabled Documentation is not constructed or executed and retains its saved state. Do not expose controls for undelivered capabilities.
- [x] Structured Project creation accepts the fixed name, aliases, description, repositories, documentation links, and notes fields. Only the name is required; missing information remains unknown. Stable identifiers and history metadata are maintained by the Module, not editable fields.
- [x] Creating one Project shows the exact proposed record in a separate confirmation Card. Only the initiating User can confirm within 24 hours; creating a record requires no AI or Gmail connection.
- [x] Save the Project, source-attributed initial history, and confirmation effect checkpoint atomically. Repeated clicks with different delivery IDs and restart/retry do not create duplicate Projects or history. Delivery uncertainty cannot cause creation to be blindly repeated.
- [x] Projects are shared within the configured Slack workspace. Another User can browse and read the record and its history; pending confirmations and menu controls remain private to their initiating actor/DM. Preserve signed ingress, workspace validation, and existing Modules' user isolation; add no company-membership check or permitted-user list.
- [x] Provide paginated Project browsing, exact lookup by identifier/name/alias, details with saved links, and initial history. Ask when a lookup is ambiguous; do not guess. Browsing and history invoke no AI.
- [x] Use the existing PostgreSQL and Module-owned persistence with idempotent initialization. Inventory/history remain for the inventory's lifetime. Keep ephemeral interaction cleanup separate and do not remove checkpoints still needed by pending jobs.
- [x] Record the Documentation ownership extension and target contract in the authoritative documentation, keeping delivered behavior distinct from later slices. Keep common runtime code independent of mail and avoid a preliminary runtime refactor unless an actual seam requires an additive change.

## Verification and delivery

- [x] Exercise signed ingress, durable enqueue, registry routing and dispatch with fake messaging, including two Users sharing records, forged/cross-user controls, foreign workspaces, prefix guidance, disabled availability, creation expiry, duplicate confirmations, restart and delivery failures. Verify zero AI calls.
- [x] Follow the [implementation and verification requirements](../spec.md#implementation-and-verification-requirements) and repository delivery instructions: check Node compatibility, run relevant tests and `test`, `check`, and `build`, report real PostgreSQL skips and unexercised live integrations separately, review the complete diff, and report local/committed/pushed state. This work item does not authorize production deployment or real data import.

## Comments

Approved as ticket 01 of the ten-ticket breakdown. Editing is delivered by 02; related inventories, archival, natural-language workflows, and import are separate slices.

Implemented locally on 2026-09-30. The authoritative [Documentation contract](../../../docs/documentation.md) records the delivered Project slice and distinguishes approved future work. Documentation remains opt-in. Creation, browsing, exact lookup, private navigation and initial history require no AI or Gmail; no production deployment or real spreadsheet import was performed.

Local verification: Node v25.8.1 satisfies `>=24`; 146 tests passed and 5 real PostgreSQL tests were skipped because `TEST_DATABASE_URL` was not configured. `npm run check`, `npm run build`, staged whitespace checks and 47 local documentation links passed. Documentation tests exercise signed ingress/durable dispatch, two Users sharing records, same User IDs in another workspace, forged/cross-user/DM controls, prefixes, disabled/re-enabled availability, pagination and ambiguous history lookup, 24-hour expiry without retry refresh, duplicate confirmations, restart, uncertain/rejected delivery, transaction rollback, lifetime retention and exhausted shared budget. All providers are fake; live Slack/Gmail/OpenAI and production deployment remain unexercised.

Final review: Standards — 0 documented violations and 0 remaining actionable smells; Spec — 0 remaining findings. The review's ambiguous-history destination defect was reproduced by a regression test and fixed before the full suite. See [deployment guidance](../../../docs/deployment.md#documentation-projects-release-candidate) for opt-in environment configuration, automatic tables, server update commands and live post-deploy checks. This is a locally verified release candidate, not a successful production deployment.
